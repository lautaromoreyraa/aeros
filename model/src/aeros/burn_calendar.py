"""Burning activity calendar for an area of interest.

Month x year grid of harmonized hotspots, with a 90 % interval and the anomaly
against the median of the same calendar month over all other years. The median
(not the mean) is the reference because a single extreme season would otherwise
drag "normal" toward itself.
"""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pandas as pd

from aeros.harmonize import unattached
from aeros.models import Z90


def monthly(
    harmonized: pd.DataFrame,
    cells: Iterable[str] | None = None,
    start: str | pd.Timestamp | None = None,
    end: str | pd.Timestamp | None = None,
) -> pd.DataFrame:
    frame = harmonized
    if cells is not None:
        frame = frame[frame["cell"].isin(set(cells))]
    frame = frame.assign(unattached_n=unattached(frame))
    grouped = frame.groupby("month")
    out = pd.DataFrame(
        {
            "harmonized": grouped["harmonized_n"].sum(min_count=1),
            "variance": grouped["harmonized_var"].sum(min_count=1)
            + grouped["harmonized_shared_sd"].sum(min_count=1) ** 2,
            "stacked_raw": grouped["stacked_n"].sum(),
            "unattached": grouped["unattached_n"].sum(),
            "source": grouped["harmonized_source"].agg(_dominant),
        }
    )
    half = Z90 * np.sqrt(out["variance"].fillna(0.0))
    out["low"] = (out["harmonized"] - half).clip(lower=0.0)
    out["high"] = out["harmonized"] + half
    out = out.reset_index()
    out["year"] = out["month"].dt.year
    out["month_of_year"] = out["month"].dt.month
    out["median_same_month"] = _leave_one_out_median(out)
    out["anomaly"] = out["harmonized"] - out["median_same_month"]
    out["anomaly_ratio"] = out["harmonized"] / out["median_same_month"].where(
        out["median_same_month"] > 0
    )
    if start is not None:
        out = out[out["month"] >= pd.Timestamp(start).to_period("M").to_timestamp()]
    if end is not None:
        out = out[out["month"] <= pd.Timestamp(end).to_period("M").to_timestamp()]
    return out.reset_index(drop=True)


def _dominant(sources: pd.Series) -> str:
    return sources.mode().iat[0] if not sources.empty else ""


def _leave_one_out_median(table: pd.DataFrame) -> pd.Series:
    """Median of the same calendar month in every *other* year."""
    result = pd.Series(np.nan, index=table.index)
    for _, group in table.groupby("month_of_year"):
        values = group["harmonized"].to_numpy()
        for i, idx in enumerate(group.index):
            others = np.delete(values, i)
            others = others[~np.isnan(others)]
            result[idx] = np.median(others) if len(others) else np.nan
    return result


def grid_matrix(table: pd.DataFrame, column: str = "harmonized") -> pd.DataFrame:
    """Rows = years, columns = 1..12, for the calendar heat map."""
    return table.pivot(index="year", columns="month_of_year", values=column).reindex(
        columns=range(1, 13)
    )
