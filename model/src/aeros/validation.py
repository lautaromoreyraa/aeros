"""Out-of-sample evaluation of the translators.

Two splits, both on the MODIS/VIIRS overlap:

* temporal: train on early years, score on later years the models never saw.
  Random row splits would leak: adjacent weeks of the same fire land on both
  sides and the score measures memory, not translation.
* spatial: whole coarse H3 regions are held out in turn, to check the
  translation transfers to land it was not fitted on.

Scores are reported at three aggregation levels because the winner changes
with the level: per cell-week, per cell-year and per region-year total.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from aeros import grid, models


def overlap(frame: pd.DataFrame) -> pd.DataFrame:
    return frame[frame["reference_on"] & frame["terra_on"] & frame["aqua_on"]]


def scores(frame: pd.DataFrame, y: np.ndarray, pred: np.ndarray) -> dict[str, float]:
    df = frame[["cell", "year"]].assign(y=y, p=pred)
    cell_year = df.groupby(["cell", "year"])[["y", "p"]].sum()
    totals = df.groupby("year")[["y", "p"]].sum()
    rel = (totals["p"] - totals["y"]) / totals["y"].where(totals["y"] > 0)
    corr = np.corrcoef(cell_year["y"], cell_year["p"])[0, 1] if len(cell_year) > 1 else np.nan
    return {
        "mae_cell_week": float(np.mean(np.abs(y - pred))),
        "mae_cell_year": float(np.mean(np.abs(cell_year["y"] - cell_year["p"]))),
        "pearson_cell_year": float(corr),
        "bias_total": float(totals["p"].sum() / max(totals["y"].sum(), 1e-9) - 1.0),
        "max_abs_rel_error_year_total": float(np.nanmax(np.abs(rel))) if len(rel) else np.nan,
    }


@dataclass
class Report:
    temporal: dict[str, dict[str, float]]
    spatial: dict[str, dict[str, float]]
    dispersion: dict[str, float]
    split_year: int
    winner: str

    def as_dict(self) -> dict:
        return {
            "split_year": self.split_year,
            "winner": self.winner,
            "temporal": self.temporal,
            "spatial": self.spatial,
            "dispersion": self.dispersion,
        }


def _fit_pair(kind: str, train: pd.DataFrame):
    both, terra = models.FAMILIES[kind]()
    both.fit(train, train["viirs_n"])
    terra.fit(train, train["viirs_n"])
    return both, terra


def evaluate(frame: pd.DataFrame, split_year: int) -> tuple[Report, dict[str, models.Translator]]:
    data = overlap(frame)
    train = data[data["year"] <= split_year]
    test = data[data["year"] > split_year]
    if train.empty or test.empty:
        raise ValueError(f"split year {split_year} leaves an empty train or test set")
    y = test["viirs_n"].to_numpy()

    temporal: dict[str, dict[str, float]] = {}
    dispersion: dict[str, float] = {}
    for kind in models.FAMILIES:
        both, terra = _fit_pair(kind, train)
        p_both, p_terra = both.predict(test), terra.predict(test)
        temporal[kind] = scores(test, y, p_both)
        temporal[f"{kind}_terra_only"] = scores(test, y, p_terra)
        dispersion[kind] = models.dispersion(y, p_both)
        dispersion[f"{kind}_terra_only"] = models.dispersion(y, p_terra)
        dispersion[f"{kind}_systematic"] = models.systematic(test, y, p_both)
        dispersion[f"{kind}_terra_only_systematic"] = models.systematic(test, y, p_terra)

    spatial = _spatial(data)

    # A learned model is used only if it beats the yardstick at the level the
    # calendar is read at (cell-year); otherwise the ratio rule stays.
    winner = min(models.FAMILIES, key=lambda k: temporal[k]["mae_cell_year"])

    fitted: dict[str, models.Translator] = {}
    for kind in models.FAMILIES:
        both, terra = _fit_pair(kind, data)
        fitted[kind] = models.Translator(
            name=kind,
            both=both,
            terra=terra,
            dispersion_both=dispersion[kind],
            dispersion_terra=dispersion[f"{kind}_terra_only"],
            systematic_both=dispersion[f"{kind}_systematic"],
            systematic_terra=dispersion[f"{kind}_terra_only_systematic"],
            metrics=temporal[kind],
        )
    report = Report(temporal, spatial, dispersion, split_year, winner)
    return report, fitted


def _spatial(data: pd.DataFrame, region_resolution: int = 2, folds: int = 4) -> dict:
    regions = data["cell"].map(lambda c: grid.region_of(c, region_resolution))
    unique = np.sort(regions.unique())
    if len(unique) < 2:
        return {}
    rng = np.random.default_rng(0)
    assignment = dict(
        zip(unique, rng.permutation(len(unique)) % min(folds, len(unique)), strict=True)
    )
    fold = regions.map(assignment).to_numpy()

    out: dict[str, list[dict[str, float]]] = {kind: [] for kind in models.FAMILIES}
    for k in np.unique(fold):
        train, test = data[fold != k], data[fold == k]
        for kind in out:
            both, _ = _fit_pair(kind, train)
            out[kind].append(scores(test, test["viirs_n"].to_numpy(), both.predict(test)))
    return {
        kind: {m: float(np.nanmean([r[m] for r in runs])) for m in runs[0]}
        for kind, runs in out.items()
    }
