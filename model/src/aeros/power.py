"""Fuel dryness and fire weather per cell and week, from NASA POWER.

The forecast learns from the fire record alone: what a cell and its neighbors
burned lately and what that week of the year usually brings. It cannot tell a
dry year from a wet one until the fires show up. Two conditions do, weeks ahead:

* root zone soil wetness (`GWETROOT`, 0 = bone dry, 1 = saturated): grasses and
  shrubs dry out with the soil under them, over weeks, so a dry soil means
  dry fuel well before the first hotspot;
* a daily Hot-Dry-Windy proxy: the vapour pressure deficit at the warmest hour,
  estimated from the daily maximum temperature and the dew point, in hPa,
  times the daily maximum 10 m wind, in m/s. It is the same idea as
  `aeros.fireweather`, from daily values instead of hourly ones.

NASA POWER serves both from MERRA-2 for every day since 1981, two days behind
real time, on a 0.5 x 0.625 degree grid, with no key. Each H3 cell takes the
grid node nearest to its center.

Every value is also given as an anomaly: the difference with the mean of the
same week of the year at the same node over the 1991-2020 normal, the WMO
reference period. A wet soil in August and a wet soil in March are not the
same news; the anomaly says which one is unusual. The normal ends before most
of the fire record starts being forecast, and it only holds weather, never
fire, so no forecast target leaks into it.

The raw responses are kept in the cache folder: like the FIRMS files, they are
never deleted, and a rerun only asks for the nodes it does not have yet.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from datetime import date
from pathlib import Path

import h3
import numpy as np
import pandas as pd

URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
SOURCE = "NASA POWER daily point API (MERRA-2), https://power.larc.nasa.gov"
PARAMETERS = ("GWETROOT", "T2M_MAX", "T2MDEW", "WS10M_MAX")
FILL = -999.0
LAT_STEP = 0.5
LON_STEP = 0.625
FIRST_DAY = date(1991, 1, 1)
NORMAL_YEARS = (1991, 2020)
MAX_RETRIES = 5
RETRY_WAIT = 30.0

COLUMNS = ["soil_wet", "soil_wet_anom", "hdw_week", "hdw_anom"]

Fetch = Callable[[str], dict]
Sleep = Callable[[float], None]


class PowerError(RuntimeError):
    pass


def node_for(lat: float, lon: float) -> tuple[float, float]:
    """The POWER grid node nearest to a point."""
    return (
        round(round(lat / LAT_STEP) * LAT_STEP, 4),
        round(round(lon / LON_STEP) * LON_STEP, 4),
    )


def cell_nodes(cells: Iterable[str]) -> dict[str, tuple[float, float]]:
    return {c: node_for(*h3.cell_to_latlng(c)) for c in cells}


def saturation_vapour_pressure(t_celsius: np.ndarray) -> np.ndarray:
    """Tetens' formula, in hPa."""
    return 6.1078 * np.exp(17.27 * t_celsius / (t_celsius + 237.3))


def daily_hdw(t_max: np.ndarray, dew: np.ndarray, wind_max: np.ndarray) -> np.ndarray:
    """Vapour pressure deficit at the warmest hour (hPa) x the day's top wind (m/s).

    The dew point barely moves within a day, so the actual vapour pressure of
    the warmest hour is close to the one of the daily mean dew point. A dew
    point above the maximum (rounding, fog) gives no deficit, not a negative one.
    """
    deficit = np.clip(saturation_vapour_pressure(t_max) - saturation_vapour_pressure(dew), 0, None)
    return deficit * wind_max


def url(node: tuple[float, float], start: date, end: date) -> str:
    query = {
        "parameters": ",".join(PARAMETERS),
        "community": "AG",
        "latitude": f"{node[0]:.4f}",
        "longitude": f"{node[1]:.4f}",
        "start": start.strftime("%Y%m%d"),
        "end": end.strftime("%Y%m%d"),
        "format": "JSON",
    }
    return f"{URL}?{urllib.parse.urlencode(query, safe=',')}"


def parse(payload: dict) -> pd.DataFrame:
    """One row per day with the four parameters; fill values become NaN."""
    try:
        values = payload["properties"]["parameter"]
    except (KeyError, TypeError) as error:
        raise PowerError("POWER answered without daily parameters") from error
    missing = [p for p in PARAMETERS if p not in values]
    if missing:
        raise PowerError(f"POWER answered without {', '.join(missing)}")
    frame = pd.DataFrame({p: pd.Series(values[p], dtype=float) for p in PARAMETERS})
    frame = frame.where(frame != FILL)
    frame.index = pd.to_datetime(frame.index, format="%Y%m%d")
    frame.index.name = "day"
    return frame.sort_index()


def _retrying_get(sleep: Sleep) -> Fetch:
    def get(address: str) -> dict:
        for attempt in range(MAX_RETRIES):
            try:
                with urllib.request.urlopen(address, timeout=180) as response:
                    return json.loads(response.read())
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
                code = getattr(error, "code", None)
                if (code is not None and code not in (429, 500, 502, 503, 504)) or (
                    attempt == MAX_RETRIES - 1
                ):
                    raise
                sleep(RETRY_WAIT * (attempt + 1))
        raise PowerError("unreachable")

    return get


def _cache_path(cache: Path, node: tuple[float, float], end: date) -> Path:
    return cache / f"{node[0]:+08.3f}_{node[1]:+09.4f}_{FIRST_DAY:%Y%m%d}_{end:%Y%m%d}.json.gz"


def fetch_nodes(
    nodes: Iterable[tuple[float, float]],
    end: date,
    cache: Path,
    fetch: Fetch | None = None,
    sleep: Sleep = time.sleep,
    pause: float = 0.5,
    log: Callable[[str], None] = lambda _: None,
) -> dict[tuple[float, float], pd.DataFrame]:
    """Daily series of every node from 1991 to `end`, read from the cache when there."""
    fetch = fetch or _retrying_get(sleep)
    cache.mkdir(parents=True, exist_ok=True)
    out: dict[tuple[float, float], pd.DataFrame] = {}
    todo = sorted(set(nodes))
    for i, node in enumerate(todo, 1):
        path = _cache_path(cache, node, end)
        if path.exists():
            payload = json.loads(gzip.decompress(path.read_bytes()))
        else:
            payload = fetch(url(node, FIRST_DAY, end))
            path.write_bytes(gzip.compress(json.dumps(payload, separators=(",", ":")).encode()))
            if pause:
                sleep(pause)
        out[node] = parse(payload)
        log(f"{i}/{len(todo)} {node}")
    return out


def weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Weekly means (ISO weeks, Monday start) of soil wetness and the daily HDW proxy."""
    hdw = daily_hdw(
        daily["T2M_MAX"].to_numpy(), daily["T2MDEW"].to_numpy(), daily["WS10M_MAX"].to_numpy()
    )
    frame = pd.DataFrame({"soil_wet": daily["GWETROOT"].to_numpy(), "hdw_week": hdw})
    days = pd.Series(daily.index)
    frame["week"] = (days - pd.to_timedelta(days.dt.day_of_week, unit="D")).to_numpy()
    # A week with only some days (the current one) keeps the mean of what is known.
    return frame.groupby("week")[["soil_wet", "hdw_week"]].mean().dropna(how="all")


def with_anomalies(weeks: pd.DataFrame) -> pd.DataFrame:
    """Adds the difference with the 1991-2020 mean of the same week of the year."""
    out = weeks.copy()
    woy = pd.Series(out.index).dt.isocalendar().week.clip(upper=52).to_numpy()
    years = out.index.year
    normal_rows = (years >= NORMAL_YEARS[0]) & (years <= NORMAL_YEARS[1])
    for column in ("soil_wet", "hdw_week"):
        normal = out.loc[normal_rows, column].groupby(woy[normal_rows]).mean()
        name = "soil_wet_anom" if column == "soil_wet" else "hdw_anom"
        out[name] = out[column].to_numpy() - normal.reindex(woy).to_numpy()
    return out


def conditions(
    cells: Iterable[str], series: dict[tuple[float, float], pd.DataFrame]
) -> pd.DataFrame:
    """The (cell, week) table the forecast reads: `COLUMNS` for every cell and week."""
    mapping = cell_nodes(cells)
    per_node = {node: with_anomalies(weekly(series[node])) for node in set(mapping.values())}
    parts = []
    for cell, node in mapping.items():
        part = per_node[node].reset_index()
        part.insert(0, "cell", cell)
        parts.append(part)
    table = pd.concat(parts, ignore_index=True)
    return table[["cell", "week", *COLUMNS]]


def build(
    cells: Iterable[str],
    end: date,
    cache: Path,
    fetch: Fetch | None = None,
    sleep: Sleep = time.sleep,
    pause: float = 0.5,
    log: Callable[[str], None] = lambda _: None,
) -> pd.DataFrame:
    cells = sorted(set(cells))
    nodes = set(cell_nodes(cells).values())
    series = fetch_nodes(nodes, end, cache, fetch=fetch, sleep=sleep, pause=pause, log=log)
    return conditions(cells, series)
