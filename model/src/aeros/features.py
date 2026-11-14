"""Cell x week panel: what MODIS saw (inputs) and what VIIRS saw (target).

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


@dataclass(frozen=True)
class Panel:
    frame: pd.DataFrame
    resolution: int
    reference: tuple[str, ...]


def _platform_block(det: pd.DataFrame, platform: str) -> pd.DataFrame:
    sub = det[det["platform"] == platform]
    prefix = platform.lower()
    if sub.empty:
        return pd.DataFrame(columns=["cell", "week"])
    g = sub.groupby(["cell", "week"])
    block = pd.DataFrame(
        {
            f"{prefix}_n": g.size(),
            f"{prefix}_day_n": g["daynight"].apply(lambda s: int((s == "D").sum())),
            f"{prefix}_night_n": g["daynight"].apply(lambda s: int((s == "N").sum())),
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
    reference: tuple[str, ...] = ("SNPP",),
    vegetation_only: bool = True,
) -> Panel:
    """One row per (cell, week) for every cell that ever had a detection.

    Weeks with zero detections are kept: VIIRS often sees fire where MODIS saw
    nothing, and those rows are exactly what the model has to learn.
    """
    det = detections
    if vegetation_only:
        det = det[det["is_vegetation"]]
    det = det.copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    det["week"] = grid.week_start(det["acq_datetime"])

    cells = np.sort(det["cell"].unique())
    weeks = pd.date_range(det["week"].min(), det["week"].max(), freq="7D")
    frame = pd.MultiIndex.from_product([cells, weeks], names=["cell", "week"]).to_frame(index=False)

    for platform in MODIS_ALL:
        frame = frame.merge(_platform_block(det, platform), on=["cell", "week"], how="left")

    ref = det[det["platform"].isin(reference)].groupby(["cell", "week"]).size()
    frame = frame.merge(ref.rename("viirs_n").reset_index(), on=["cell", "week"], how="left")
    # What a user gets by stacking every FIRMS file and counting rows: the
    # "raw" series whose jumps follow the satellite fleet, not the fire.
    stacked = det.groupby(["cell", "week"]).size()
    frame = frame.merge(stacked.rename("stacked_n").reset_index(), on=["cell", "week"], how="left")

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

    frame = _mark_coverage(frame, reference)
    return Panel(frame=frame, resolution=resolution, reference=reference)


def _mark_coverage(frame: pd.DataFrame, reference: tuple[str, ...]) -> pd.DataFrame:
    """Which instruments were operating each week, from the mission windows."""
    week_end = frame["week"] + pd.Timedelta(days=6)

    def operating(name: str) -> pd.Series:
        p = PLATFORMS[name]
        start = pd.Timestamp(p.first_day)
        on = frame["week"] >= start
        if p.last_day is not None:
            on &= week_end <= pd.Timestamp(p.last_day)
        return on

    frame["terra_on"] = operating("TERRA")
    frame["aqua_on"] = operating("AQUA")
    frame["reference_on"] = np.logical_and.reduce([operating(r) for r in reference])
    return frame
