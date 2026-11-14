"""Fire weather: how dry and windy the next days are, against what is usual.

Fire needs more than ignition: dry air pulls moisture out of the fuel and wind
carries the front. The surface Hot-Dry-Windy index multiplies the two: the
vapour pressure deficit of the air at 2 m, in hPa, times the 10 m wind speed,
in m/s, taking the highest hour of each day. A deficit of 2 kPa with a 5 m/s
wind is 100.

The number alone says little, because what counts as dry and windy depends on
the place and the season. So each day is ranked against the same days of the
past years, at the same node of the grid: the share of those days that were
calmer. Open-Meteo gives both sides, the forecast for the next days and the
ERA5 reanalysis for the years behind, with no key.

The ranking compares a forecast model with a reanalysis, which differ by a
little in their own right: read a high rank as "unusually dry and windy", not
as a measured percentile. The index never enters the harmonized record.
"""

from __future__ import annotations

import bisect
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

from aeros.wind import Grid, WindError

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE = "Open-Meteo forecast and ERA5 archive APIs (CC BY 4.0)"
INDEX = (
    "Surface Hot-Dry-Windy index: vapour pressure deficit (hPa) x 10 m wind (m/s), "
    "highest hour of the day"
)
HOURLY = "vapour_pressure_deficit,wind_speed_10m"
KPA_TO_HPA = 10.0
# One request carries this many locations at most, as in `aeros.wind`.
LOCATIONS_PER_REQUEST = 100
# Rank floors of each level, highest first; below the last one the day is "normal".
LEVELS = (("extreme", 95.0), ("high", 90.0), ("elevated", 75.0))
MAX_RETRIES = 5
DEFAULT_RETRY_WAIT = 60.0

Fetch = Callable[[str], object]
Sleep = Callable[[float], None]


def hdw(vpd_kpa: float | None, wind_ms: float | None) -> float | None:
    """The index of one hour, or None when either input is missing."""
    if vpd_kpa is None or wind_ms is None:
        return None
    return vpd_kpa * KPA_TO_HPA * wind_ms


def daily_peaks(hourly: dict) -> dict[str, float]:
    """Highest hourly index of each UTC day; a day with no valid hour is left out."""
    peaks: dict[str, float] = {}
    for stamp, vpd, wind in zip(
        hourly["time"], hourly["vapour_pressure_deficit"], hourly["wind_speed_10m"], strict=True
    ):
        value = hdw(vpd, wind)
        if value is None:
            continue
        day = stamp[:10]
        peaks[day] = max(value, peaks.get(day, value))
    return peaks


def rank(sorted_samples: list[float], value: float | None) -> float | None:
    """Percent of the samples that were at or below `value`; None without either."""
    if value is None or not sorted_samples:
        return None
    return round(100.0 * bisect.bisect_right(sorted_samples, value) / len(sorted_samples), 1)


def level(percentile: float | None) -> str | None:
    if percentile is None:
        return None
    for name, floor in LEVELS:
        if percentile >= floor:
            return name
    return "normal"


def _in_year(day: date, year: int) -> date:
    try:
        return day.replace(year=year)
    except ValueError:  # 29 February in a year without one
        return day.replace(year=year, day=28)


def window_in_year(days: list[date], year: int, half_window: int) -> tuple[date, date]:
    """The same days of `year`, widened by `half_window` days on each side."""
    return (
        _in_year(days[0], year) - timedelta(days=half_window),
        _in_year(days[-1], year) + timedelta(days=half_window),
    )


def _retrying_get(sleep: Sleep) -> Fetch:
    """A GET that waits and tries again when the service says it is being asked too much."""

    def get(url: str) -> object:
        for attempt in range(MAX_RETRIES):
            try:
                with urllib.request.urlopen(url, timeout=120) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as error:
                if error.code != 429 or attempt == MAX_RETRIES - 1:
                    raise
                wait = error.headers.get("Retry-After") if error.headers else None
                sleep(float(wait) if wait and wait.isdigit() else DEFAULT_RETRY_WAIT)
        raise WindError("unreachable")

    return get


def _url(base: str, points: list[tuple[float, float]], **extra: str) -> str:
    query = {
        "latitude": ",".join(f"{lat:.4f}" for lat, _ in points),
        "longitude": ",".join(f"{lon:.4f}" for _, lon in points),
        "hourly": HOURLY,
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        **extra,
    }
    return f"{base}?{urllib.parse.urlencode(query, safe=',')}"


def _locations(payload: object, expected: int) -> list[dict]:
    found = payload if isinstance(payload, list) else [payload]
    if len(found) != expected or not all(
        isinstance(item, dict) and "hourly" in item for item in found
    ):
        raise WindError(f"Open-Meteo returned {len(found)} locations for {expected} requested")
    return found


def _peaks_per_node(
    base: str, points: list[tuple[float, float]], fetch: Fetch, **extra: str
) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    for i in range(0, len(points), LOCATIONS_PER_REQUEST):
        chunk = points[i : i + LOCATIONS_PER_REQUEST]
        out += [
            daily_peaks(loc["hourly"])
            for loc in _locations(fetch(_url(base, chunk, **extra)), len(chunk))
        ]
    return out


def build(
    area: tuple[float, float, float, float],
    nx: int,
    ny: int,
    days: int,
    now: datetime,
    years: int = 10,
    half_window: int = 15,
    fetch: Fetch | None = None,
    sleep: Sleep = time.sleep,
    pause: float = 0.0,
) -> dict:
    """The `fire_weather.json` payload: the index of the next `days` days and its rank per node."""
    if nx < 2 or ny < 2 or days < 1 or years < 1:
        raise ValueError("the grid needs at least 2 x 2 nodes, 1 day and 1 year of climatology")
    fetch = fetch or _retrying_get(sleep)
    grid = Grid(*area, nx=nx, ny=ny)
    points = grid.points()
    today = now.astimezone(UTC).date()
    target = [today + timedelta(days=d) for d in range(days)]
    labels = [d.isoformat() for d in target]

    forecast = _peaks_per_node(FORECAST_URL, points, fetch, forecast_days=str(days))

    samples: list[list[float]] = [[] for _ in points]
    last_year = today.year - 1
    first_year = last_year - years + 1
    for year in range(first_year, last_year + 1):
        start, end = window_in_year(target, year, half_window)
        history = _peaks_per_node(
            ARCHIVE_URL, points, fetch, start_date=start.isoformat(), end_date=end.isoformat()
        )
        for node, peaks in enumerate(history):
            samples[node] += peaks.values()
        if pause:
            sleep(pause)
    for node in samples:
        node.sort()

    peak_rows: list[list[float | None]] = []
    rank_rows: list[list[float | None]] = []
    for label in labels:
        values = [forecast[node].get(label) for node in range(len(points))]
        peak_rows.append([None if v is None else round(v, 1) for v in values])
        rank_rows.append([rank(samples[node], v) for node, v in enumerate(values)])

    return {
        "generated_at": now.astimezone(UTC).isoformat(timespec="seconds"),
        "source": SOURCE,
        "index": INDEX,
        "grid": grid.describe(),
        "days": labels,
        "hdw": peak_rows,
        "percentile": rank_rows,
        "levels": {name: floor for name, floor in LEVELS},
        "climatology": {
            "years": [first_year, last_year],
            "half_window_days": half_window,
            "samples_per_node": len(samples[0]),
        },
    }


def summarize(field: dict) -> list[dict]:
    """One line per day: the highest rank, its level and how many nodes are extreme."""
    lines = []
    for label, row in zip(field["days"], field["percentile"], strict=True):
        ranks = [r for r in row if r is not None]
        top = max(ranks) if ranks else None
        lines.append(
            {
                "day": label,
                "top_percentile": top,
                "level": level(top),
                "extreme_nodes": sum(1 for r in ranks if r >= field["levels"]["extreme"]),
                "nodes": len(row),
            }
        )
    return lines
