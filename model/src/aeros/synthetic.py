"""Synthetic FIRMS archives with a known answer.

Real data never tells us what VIIRS *would have* seen in 2005. A simulation
does: fires are drawn first, then each platform "observes" them with its own
pixel size, overpass time and view-angle penalty. The reference VIIRS platform
is simulated for the whole period, so the backcast can be scored against truth.

The physics is deliberately coarse; it only has to reproduce the mechanisms
that make the two records disagree:

* small fires are mostly missed by 1 km MODIS pixels and caught by 375 m VIIRS;
* a large fire lights several 375 m pixels but few 1 km pixels;
* some fires burn only in the morning, when only Terra passes;
* MODIS pixels grow toward the swath edge and lose small fires there.
"""

from __future__ import annotations

from dataclasses import dataclass

import h3
import numpy as np
import pandas as pd

from aeros.sensors import PLATFORMS

DEFAULT_BBOX = (-63.0, -27.0, -60.0, -24.0)  # west, south, east, north (Chaco)


@dataclass
class SyntheticArchive:
    modis: pd.DataFrame
    viirs: pd.DataFrame
    # Suomi NPP detections as if it had flown the whole period: the answer the
    # backcast is scored against, in either unit.
    truth_rows: pd.DataFrame


def _cells(bbox: tuple[float, float, float, float], resolution: int) -> list[str]:
    w, s, e, n = bbox
    poly = h3.LatLngPoly([(s, w), (s, e), (n, e), (n, w)])
    return sorted(h3.polygon_to_cells(poly, resolution))


def generate(
    start: str = "2000-11-06",
    end: str = "2027-03-29",
    bbox: tuple[float, float, float, float] = DEFAULT_BBOX,
    resolution: int = 4,
    trend_per_year: float = 0.03,
    seed: int = 7,
    noaa20_gap: tuple[str, str] | None = None,
) -> SyntheticArchive:
    rng = np.random.default_rng(seed)
    cells = _cells(bbox, resolution)
    weeks = pd.date_range(start, end, freq="W-MON")
    n_cells, _n_weeks = len(cells), len(weeks)

    grass = rng.beta(2, 2, n_cells)  # share of grassland/cropland vs forest
    base = rng.gamma(2.0, 0.35, n_cells)
    day_of_year = (weeks.day_of_year.to_numpy() + 3) / 365.25
    # Dry-season peak in August-September, as in the Chaco.
    season = np.exp(2.2 * np.cos(2 * np.pi * (day_of_year - 0.66))) / np.exp(2.2)
    years = (weeks - weeks[0]).days.to_numpy() / 365.25
    year_index = weeks.year.to_numpy() - weeks.year.min()
    interannual = rng.lognormal(0.0, 0.35, year_index.max() + 1)[year_index]
    trend = (1 + trend_per_year) ** years
    lam = base[:, None] * (season * trend * interannual)[None, :] * 3.0

    n_fires = rng.poisson(lam)
    cell_idx, week_idx = np.nonzero(n_fires)
    reps = n_fires[cell_idx, week_idx]
    cell_idx, week_idx = np.repeat(cell_idx, reps), np.repeat(week_idx, reps)
    total = len(cell_idx)

    small = rng.random(total) < (0.45 + 0.45 * grass[cell_idx])
    morning_only = small & (rng.random(total) < 0.35)
    day_offset = rng.integers(0, 7, total)

    fires = pd.DataFrame(
        {
            "cell": np.asarray(cells, dtype=object)[cell_idx],
            "week": weeks[week_idx],
            "date": weeks[week_idx] + pd.to_timedelta(day_offset, unit="D"),
            "small": small,
            "morning_only": morning_only,
        }
    )

    modis_rows, viirs_rows, truth_rows = [], [], []
    viirs_detection = {  # platform: (p small fire, extra pixels for large fires)
        "SNPP": (0.55, 3.0),
        "NOAA20": (0.6, 3.3),  # same instrument, slightly different calibration
    }
    for name in ("TERRA", "AQUA", "SNPP", "NOAA20"):
        platform = PLATFORMS[name]
        morning = name == "TERRA"
        active = np.where(fires["morning_only"], morning, True)
        if name in viirs_detection:
            p_small, extra = viirs_detection[name]
            scan = rng.uniform(0.32, 0.8, total)
            p = np.where(small, p_small, 0.95) * active
            pixels = np.where(small, 1, 1 + rng.poisson(extra, total))
        else:
            scan = rng.uniform(1.0, 4.8, total)
            edge_penalty = 1.0 / scan**0.8
            p = np.where(small, 0.32 * edge_penalty, 0.85) * active
            pixels = np.where(small, 1, 1 + rng.poisson(0.6, total))
        detected = rng.random(total) < p
        counts = np.where(detected, pixels, 0)
        if name == "SNPP":
            truth_rows.append(_rows(fires, counts, scan, name, small, rng))

        on = fires["date"] >= pd.Timestamp(platform.first_day)
        if platform.last_day is not None:
            on &= fires["date"] <= pd.Timestamp(platform.last_day)
        if name == "NOAA20" and noaa20_gap is not None:
            on &= ~fires["date"].between(pd.Timestamp(noaa20_gap[0]), pd.Timestamp(noaa20_gap[1]))
        counts = np.where(on, counts, 0)

        rows = _rows(fires, counts, scan, name, small, rng)
        (viirs_rows if name in viirs_detection else modis_rows).append(rows)

    return SyntheticArchive(
        modis=pd.concat(modis_rows, ignore_index=True),
        viirs=pd.concat(viirs_rows, ignore_index=True),
        truth_rows=pd.concat(truth_rows, ignore_index=True),
    )


def _rows(fires, counts, scan, platform, small, rng) -> pd.DataFrame:
    idx = np.repeat(np.arange(len(fires)), counts)
    if len(idx) == 0:
        return pd.DataFrame()
    centers = np.array([h3.cell_to_latlng(c) for c in fires["cell"].to_numpy()[idx]])
    lat = centers[:, 0] + rng.normal(0, 0.03, len(idx))
    lon = centers[:, 1] + rng.normal(0, 0.03, len(idx))
    local = PLATFORMS[platform].nominal_day_overpass + rng.normal(0, 0.4, len(idx))
    utc_hours = (local - lon / 15.0) % 24
    hh = np.floor(utc_hours).astype(int)
    mm = np.floor((utc_hours - hh) * 60).astype(int)
    frp = np.where(small[idx], rng.lognormal(1.8, 0.6, len(idx)), rng.lognormal(3.8, 0.8, len(idx)))
    satellite = {"TERRA": "Terra", "AQUA": "Aqua", "SNPP": "N", "NOAA20": "N20"}[platform]
    return pd.DataFrame(
        {
            "latitude": lat.round(5),
            "longitude": lon.round(5),
            "acq_date": fires["date"].to_numpy()[idx].astype("datetime64[D]").astype(str),
            "acq_time": [f"{h:02d}{m:02d}" for h, m in zip(hh, mm, strict=True)],
            "satellite": satellite,
            "scan": scan[idx].round(2),
            "track": (scan[idx] * 0.6).round(2),
            "frp": frp.round(2),
            "daynight": "D",
            "type": 0,
            "confidence": "70" if platform in ("TERRA", "AQUA") else "n",
        }
    )
