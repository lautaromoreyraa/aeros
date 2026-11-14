"""Weekly fire activity forecast, 1 to 4 weeks ahead, on the harmonized record.

The forecast is statistical, not physical: it says how many VIIRS-equivalent
hotspots each H3 cell is likely to have in the coming weeks given what it and
its neighbors had recently and what that week of the year usually brings. It
runs on the harmonized series, so years observed by MODIS and by VIIRS feed it
in the same unit.

Two yardsticks it must beat to be worth showing:

* climatology: the mean of the same week of the year in earlier years (the
  mean, not the median: hotspot weeks are sparse, so per-cell medians are
  mostly zero and their sum badly understates what a season brings);
* persistence: last week's count repeats.

Leakage guard: the climatology used as a feature for a target week only looks
at years before the target's year, and validation keeps whole years out.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from aeros import grid, models

HORIZONS = (1, 2, 3, 4)
LAGS = (0, 1, 2, 3)
FEATURES = [
    "lag0",
    "lag1",
    "lag2",
    "lag3",
    "last4_sum",
    "neighbors_last",
    "climatology",
    "climatology_prev_year",
    "season_sin",
    "season_cos",
    "horizon",
]


def _week_of_year(weeks: pd.Series) -> pd.Series:
    return weeks.dt.isocalendar().week.clip(upper=52).astype(int)


def weekly_series(harmonized: pd.DataFrame) -> pd.DataFrame:
    """Dense cell x week table of harmonized counts (gaps before Terra dropped)."""
    table = harmonized[["cell", "week", "harmonized_n"]].dropna()
    table = table.rename(columns={"harmonized_n": "y"})
    table["woy"] = _week_of_year(table["week"])
    table["year"] = table["week"].dt.year
    return table.sort_values(["cell", "week"]).reset_index(drop=True)


def _climatology(table: pd.DataFrame) -> pd.DataFrame:
    """Mean of the same week of year over *earlier* years, per cell."""
    yearly = table.groupby(["cell", "woy", "year"])["y"].sum().reset_index()
    yearly = yearly.sort_values(["cell", "woy", "year"])
    grouped = yearly.groupby(["cell", "woy"])["y"]
    yearly["climatology"] = grouped.transform(lambda s: s.shift(1).expanding().mean())
    yearly["climatology_prev_year"] = grouped.shift(1)
    return yearly[["cell", "woy", "year", "climatology", "climatology_prev_year"]]


def build_examples(table: pd.DataFrame) -> pd.DataFrame:
    """One row per (cell, issue week, horizon) with the target `h` weeks later."""
    wide = table.pivot(index="week", columns="cell", values="y").sort_index()
    wide = wide.asfreq("7D")  # keeps missing weeks as NaN instead of collapsing them

    ring = {c: [n for n in grid.neighbors(c) if n in wide.columns] for c in wide.columns}
    # An isolated cell (no neighbor with data) gets NaN, which the trees handle.
    neighbors = pd.DataFrame(
        {c: wide[ring[c]].sum(axis=1, min_count=1) if ring[c] else np.nan for c in wide.columns},
        index=wide.index,
    )

    issue = {f"lag{k}": wide.shift(k).stack(future_stack=True) for k in LAGS}
    issue["last4_sum"] = wide.rolling(4, min_periods=4).sum().stack(future_stack=True)
    issue["neighbors_last"] = neighbors.stack(future_stack=True)
    base = pd.DataFrame(issue)
    base.index.names = ["issue_week", "cell"]
    base = base.reset_index()

    clim = _climatology(table)
    parts = []
    for h in HORIZONS:
        target = wide.shift(-h).stack(future_stack=True).rename("target")
        target.index.names = ["issue_week", "cell"]
        part = base.merge(target.reset_index(), on=["issue_week", "cell"], how="left")
        part["horizon"] = h
        part["target_week"] = part["issue_week"] + pd.Timedelta(weeks=h)
        parts.append(part)
    examples = pd.concat(parts, ignore_index=True)

    examples["woy"] = _week_of_year(examples["target_week"])
    examples["year"] = examples["target_week"].dt.year
    examples = examples.merge(clim, on=["cell", "woy", "year"], how="left")
    # Target weeks that have not happened yet (the live forecast) get the
    # climatology of every past year, which is exactly "earlier years" for
    # them. Rows with a known target never take this path, so training rows
    # cannot see their own year.
    future = examples["target"].isna()
    if future.any():
        everything = table.groupby(["cell", "woy"])["y"].mean().rename("_all")
        examples = examples.merge(everything.reset_index(), on=["cell", "woy"], how="left")
        examples.loc[future, "climatology"] = examples.loc[future, "_all"]
        examples = examples.drop(columns="_all")
    day = examples["target_week"].dt.day_of_year + 3
    examples["season_sin"] = np.sin(2 * np.pi * day / 365.25)
    examples["season_cos"] = np.cos(2 * np.pi * day / 365.25)
    return examples.dropna(subset=["lag0", "lag3", "last4_sum"])


@dataclass
class Forecaster:
    model: HistGradientBoostingRegressor
    dispersion: float = 1.0
    systematic: float = 0.0
    scores: dict = field(default_factory=dict)

    def predict(self, examples: pd.DataFrame) -> np.ndarray:
        return np.clip(self.model.predict(examples[FEATURES]), 0.0, None)


def _new_model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        loss="poisson",
        learning_rate=0.06,
        max_iter=400,
        max_leaf_nodes=31,
        min_samples_leaf=60,
        l2_regularization=1.0,
        early_stopping=True,
        validation_fraction=0.15,
        random_state=0,
    )


def _scores(frame: pd.DataFrame, pred: np.ndarray) -> dict[str, float]:
    y = frame["target"].to_numpy()
    region = frame.assign(p=pred).groupby(["target_week", "horizon"])[["target", "p"]].sum()
    return {
        "mae_cell_week": float(np.mean(np.abs(y - pred))),
        "mae_region_week": float(np.mean(np.abs(region["target"] - region["p"]))),
        "bias_total": float(pred.sum() / max(y.sum(), 1e-9) - 1.0),
    }


def evaluate(examples: pd.DataFrame, test_from_year: int) -> tuple[dict, Forecaster]:
    """Fit on years before `test_from_year`, score on that year onward.

    Returns scores for the model and both yardsticks, per horizon, plus a
    forecaster refitted on every year with known targets.
    """
    known = examples.dropna(subset=["target"])
    train = known[known["year"] < test_from_year]
    test = known[known["year"] >= test_from_year]
    if train.empty or test.empty:
        raise ValueError(f"test year {test_from_year} leaves an empty split")

    model = _new_model().fit(train[FEATURES], train["target"])
    pred = np.clip(model.predict(test[FEATURES]), 0.0, None)
    climatology = test["climatology"].fillna(test["lag0"]).to_numpy()
    persistence = test["lag0"].to_numpy()

    report: dict = {"test_from_year": test_from_year, "by_horizon": {}}
    for h in HORIZONS:
        mask = (test["horizon"] == h).to_numpy()
        part = test[mask]
        report["by_horizon"][h] = {
            "model": _scores(part, pred[mask]),
            "climatology": _scores(part, climatology[mask]),
            "persistence": _scores(part, persistence[mask]),
        }
    y = test["target"].to_numpy()
    by_month = test.assign(month=test["target_week"].dt.to_period("M").dt.to_timestamp())
    final = Forecaster(
        model=_new_model().fit(known[FEATURES], known["target"]),
        dispersion=models.dispersion(y, pred),
        systematic=models.systematic(by_month, y, pred),
    )
    final.scores = report
    return report, final


def latest(examples: pd.DataFrame, forecaster: Forecaster) -> pd.DataFrame:
    """Forecast from the most recent issue week, with 90 % intervals."""
    issue = examples["issue_week"].max()
    rows = examples[examples["issue_week"] == issue].copy()
    rows["expected"] = forecaster.predict(rows)
    variance = forecaster.dispersion * np.maximum(rows["expected"], 0.05)
    half = models.Z90 * np.sqrt(variance + forecaster.systematic * rows["expected"] ** 2)
    rows["low"] = (rows["expected"] - half).clip(lower=0.0)
    rows["high"] = rows["expected"] + half
    return rows


def to_json(rows: pd.DataFrame, forecaster: Forecaster, unit: str) -> dict:
    region = rows.groupby(["target_week", "horizon"]).agg(
        expected=("expected", "sum"), climatology=("climatology", "sum")
    )
    var = (
        rows.assign(v=forecaster.dispersion * np.maximum(rows["expected"], 0.05))
        .groupby(["target_week", "horizon"])["v"]
        .sum()
    )
    half = models.Z90 * np.sqrt(var + forecaster.systematic * region["expected"] ** 2)
    region["low"] = (region["expected"] - half).clip(lower=0.0)
    region["high"] = region["expected"] + half
    region = region.reset_index()

    cells = []
    for cell, part in rows.groupby("cell"):
        values = []
        for r in part.sort_values("horizon").itertuples():
            ratio = r.expected / r.climatology if r.climatology and r.climatology > 0 else None
            values.append(
                [
                    int(r.horizon),
                    round(float(r.expected), 3),
                    round(float(r.low), 3),
                    round(float(r.high), 3),
                    None if ratio is None else round(float(ratio), 3),
                ]
            )
        if any(v[1] > 0.05 for v in values):
            cells.append({"cell": cell, "values": values})

    return {
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"),
        "issued_week": str(rows["issue_week"].max().date()),
        "unit": unit,
        "horizons": list(HORIZONS),
        "columns": ["horizon", "expected", "low", "high", "ratio_to_climatology"],
        "region": [
            {
                "week_start": str(r.target_week.date()),
                "horizon": int(r.horizon),
                "expected": round(float(r.expected), 2),
                "low": round(float(r.low), 2),
                "high": round(float(r.high), 2),
                "climatology": round(float(r.climatology), 2),
            }
            for r in region.itertuples()
        ],
        "cells": cells,
        "validation": forecaster.scores,
    }
