"""Cell x week panel: what MODIS saw (inputs) and what VIIRS saw (target).

Two units are supported. `hotspots` counts detection rows. `cell_days` counts
the distinct days a cell had at least one detection: a large fire lights
several 375 m VIIRS pixels but few 1 km MODIS pixels, so row counts mix "more
fire" with "smaller pixels"; presence per day removes most of that.

Location and year are deliberately NOT features. With them, a tree model learns
"how much fire this cell usually has" during the training years and flattens the
trend in the years it must reconstruct. Every input describes what MODIS
observed, how it observed it, and when in the season.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from aeros import grid
from aeros.sensors import PLATFORMS

MODIS_ALL = ("TERRA", "AQUA")
MODIS_TERRA = ("TERRA",)

TERRA_FEATURES = [
    "terra_n",
    "terra_day_n",
    "terra_night_n",
    "terra_frp_mean",
    "terra_frp_max",
    "terra_scan_mean",
    "terra_neighbors_n",
    "season_sin",
    "season_cos",
]
ALL_FEATURES = TERRA_FEATURES + [
    "aqua_n",
    "aqua_day_n",
    "aqua_night_n",
    "aqua_frp_mean",
    "aqua_frp_max",
    "aqua_scan_mean",
    "aqua_neighbors_n",
]


UNITS = ("hotspots", "cell_days")
DEFAULT_REFERENCE = ("SNPP", "NOAA20", "NOAA21")


@dataclass(frozen=True)
class Panel:
    frame: pd.DataFrame
    resolution: int
    reference: tuple[str, ...]
    unit: str


def _count(group, unit: str) -> pd.Series:
    return group.size() if unit == "hotspots" else group["day"].nunique()


def _platform_block(det: pd.DataFrame, platform: str, unit: str) -> pd.DataFrame:
    sub = det[det["platform"] == platform]
    prefix = platform.lower()
    if sub.empty:
        return pd.DataFrame(columns=["cell", "week"])
    keys = ["cell", "week"]
    g = sub.groupby(keys)
    block = pd.DataFrame(
        {
            f"{prefix}_n": _count(g, unit),
            f"{prefix}_day_n": _count(sub[sub["daynight"] == "D"].groupby(keys), unit),
            f"{prefix}_night_n": _count(sub[sub["daynight"] == "N"].groupby(keys), unit),
            f"{prefix}_frp_mean": g["frp"].mean(),
            f"{prefix}_frp_max": g["frp"].max(),
            f"{prefix}_scan_mean": g["scan"].mean(),
        }
    )
    return block.reset_index()


def _neighbor_counts(frame: pd.DataFrame, column: str) -> pd.Series:
    """Sum of `column` over the six adjacent cells in the same week."""
    lookup = frame.set_index(["cell", "week"])[column]
    lookup = lookup[lookup > 0]
    if lookup.empty:
        return pd.Series(0.0, index=frame.index)
    active = lookup.to_dict()
    ring = {c: grid.neighbors(c) for c in frame["cell"].unique()}
    values = [
        sum(active.get((n, w), 0) for n in ring[c])
        for c, w in zip(frame["cell"], frame["week"], strict=True)
    ]
    return pd.Series(values, index=frame.index, dtype=float)


def build_panel(
    detections: pd.DataFrame,
    resolution: int = grid.DEFAULT_RESOLUTION,
    reference: tuple[str, ...] = DEFAULT_REFERENCE,
    unit: str = "hotspots",
    vegetation_only: bool = True,
) -> Panel:
    """One row per (cell, week) for every cell that ever had a detection.

    Weeks with zero detections are kept: VIIRS often sees fire where MODIS saw
    nothing, and those rows are exactly what the model has to learn.

    `reference` is a chain of VIIRS platforms in priority order. The first one
    defines the unit; later ones fill the weeks it is not operating, bridged to
    it on their overlap (see `aeros.reference`). Suomi NPP stopped delivering on
    2026-11-02, so without NOAA-20 in the chain every week after that would
    fall back to MODIS-based estimates while MODIS itself is shutting down.
    NOAA-21 comes last: it only speaks for the weeks where the platforms before
    it were silent region-wide, so it backs NOAA-20 up during its outages.
    """
    from aeros import reference as ref_chain

    if unit not in UNITS:
        raise ValueError(f"unit must be one of {UNITS}")
    det = detections
    if vegetation_only:
        det = det[det["is_vegetation"]]
    det = det.copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    det["week"] = grid.week_start(det["acq_datetime"])
    det["day"] = det["acq_datetime"].dt.tz_convert("UTC").dt.floor("D")

    cells = np.sort(det["cell"].unique())
    weeks = pd.date_range(det["week"].min(), det["week"].max(), freq="7D")
    frame = pd.MultiIndex.from_product([cells, weeks], names=["cell", "week"]).to_frame(index=False)

    for platform in MODIS_ALL:
        frame = frame.merge(_platform_block(det, platform, unit), on=["cell", "week"], how="left")
    for platform in reference:
        counts = _count(det[det["platform"] == platform].groupby(["cell", "week"]), unit)
        counts = counts.rename(f"{platform.lower()}_ref_n").reset_index()
        frame = frame.merge(counts, on=["cell", "week"], how="left")
    # What a user gets by stacking every FIRMS file and counting: the "raw"
    # series whose jumps follow the satellite fleet, not the fire.
    stacked = _count(det.groupby(["cell", "week"]), unit)
    frame = frame.merge(stacked.rename("stacked_n").reset_index(), on=["cell", "week"], how="left")

    # A platform with no detection at all still needs its columns (as zeros).
    for column in ALL_FEATURES:
        if column not in frame and not column.startswith("season"):
            frame[column] = 0.0
    count_cols = [c for c in frame if c.endswith("_n")]
    frame[count_cols] = frame[count_cols].fillna(0).astype(float)
    for platform in MODIS_ALL:
        p = platform.lower()
        frame[f"{p}_neighbors_n"] = _neighbor_counts(frame, f"{p}_n")

    day_of_year = frame["week"].dt.day_of_year + 3
    frame["season_sin"] = np.sin(2 * np.pi * day_of_year / 365.25)
    frame["season_cos"] = np.cos(2 * np.pi * day_of_year / 365.25)
    frame["month"] = grid.week_month(frame["week"])
    frame["year"] = frame["week"].dt.year

    frame["terra_on"] = operating(frame, "TERRA")
    frame["aqua_on"] = operating(frame, "AQUA")
    frame = ref_chain.chain(frame, reference)
    return Panel(frame=frame, resolution=resolution, reference=reference, unit=unit)


def operating(frame: pd.DataFrame, name: str) -> pd.Series:
    """Weeks fully inside a platform's mission window."""
    p = PLATFORMS[name]
    on = frame["week"] >= pd.Timestamp(p.first_day)
    if p.last_day is not None:
        on &= frame["week"] + pd.Timedelta(days=6) <= pd.Timestamp(p.last_day)
    return on
