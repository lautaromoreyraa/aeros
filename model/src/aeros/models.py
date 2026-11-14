"""Translators from MODIS observations to VIIRS-equivalent hotspot counts.

Two families compete on the same split:

* `RatioBaseline`: VIIRS = factor(month of year) x MODIS. The yardstick. If the
  learned model cannot beat it, the learned model is not used.
* `BoostedTranslator`: gradient-boosted trees with a Poisson loss, because the
  target is a non-negative count whose variance grows with its mean.

Each family has a TERRA-only variant. Before Aqua (July 2002) only Terra was
flying; a model trained with both inputs reads "Aqua saw nothing" as evidence
of no fire and under-predicts badly, so the early years use a model that never
looks at Aqua.

Uncertainty is quasi-Poisson: Var(y) = phi * mu, with the dispersion phi
estimated on held-out data. Variances add across cells and weeks, so the same
phi gives an interval for any area and any period a user selects.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from aeros.features import ALL_FEATURES, TERRA_FEATURES

Z90 = 1.6448536269514722


class RatioBaseline:
    """VIIRS = factor(month) x MODIS, plus a floor(month) for weeks MODIS saw nothing.

    The floor matters: VIIRS detects small fires in cell-weeks where MODIS is
    blank, and a pure ratio would predict exactly zero there.
    """

    def __init__(self, modis_columns: tuple[str, ...]):
        self.modis_columns = modis_columns
        self.factors: pd.Series | None = None
        self.floors: pd.Series | None = None
        self.global_factor = 1.0

    def _modis(self, frame: pd.DataFrame) -> pd.Series:
        return frame[list(self.modis_columns)].sum(axis=1)

    def fit(self, frame: pd.DataFrame, target: pd.Series) -> RatioBaseline:
        modis = self._modis(frame)
        table = pd.DataFrame({"m": frame["week"].dt.month, "x": modis, "y": target})
        seen = table[table["x"] > 0].groupby("m")[["x", "y"]].sum()
        self.global_factor = float(seen["y"].sum() / max(seen["x"].sum(), 1.0))
        self.factors = (seen["y"] / seen["x"]).reindex(range(1, 13)).fillna(self.global_factor)
        self.floors = table[table["x"] == 0].groupby("m")["y"].mean().reindex(range(1, 13))
        self.floors = self.floors.fillna(0.0)
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        assert self.factors is not None and self.floors is not None, "fit first"
        month = frame["week"].dt.month
        modis = self._modis(frame)
        pred = np.where(modis > 0, month.map(self.factors) * modis, month.map(self.floors))
        return np.asarray(pred, dtype=float)


class BoostedTranslator:
    def __init__(self, features: list[str], random_state: int = 0):
        self.features = features
        self.model = HistGradientBoostingRegressor(
            loss="poisson",
            learning_rate=0.06,
            max_iter=400,
            max_leaf_nodes=31,
            min_samples_leaf=40,
            l2_regularization=1.0,
            early_stopping=True,
            validation_fraction=0.15,
            random_state=random_state,
        )

    def fit(self, frame: pd.DataFrame, target: pd.Series) -> BoostedTranslator:
        self.model.fit(frame[self.features], target)
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return np.clip(self.model.predict(frame[self.features]), 0.0, None)


class OffsetBoostedTranslator:
    """Boosting on top of the baseline, as a multiplicative correction.

    Trees cannot extrapolate: a plain boosted model never predicts more than the
    largest counts it saw in training, so in a year with more fire than any
    training year it under-predicts. Here the baseline carries the scale (it is
    linear in MODIS) and the trees only learn the correction factor, fitted as a
    Poisson rate with the baseline as exposure (target y / e, weight e).
    """

    def __init__(self, features: list[str], modis_columns: tuple[str, ...], random_state: int = 0):
        self.baseline = RatioBaseline(modis_columns)
        self.trees = BoostedTranslator(features, random_state)

    def _exposure(self, frame: pd.DataFrame) -> np.ndarray:
        return np.maximum(self.baseline.predict(frame), 0.05)

    def fit(self, frame: pd.DataFrame, target: pd.Series) -> OffsetBoostedTranslator:
        self.baseline.fit(frame, target)
        exposure = self._exposure(frame)
        self.trees.model.fit(frame[self.trees.features], target / exposure, sample_weight=exposure)
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return self._exposure(frame) * self.trees.predict(frame)


@dataclass
class Translator:
    """A fitted pair (both-MODIS model, Terra-only model) plus its dispersion."""

    name: str
    both: object
    terra: object
    dispersion_both: float = 1.0
    dispersion_terra: float = 1.0
    systematic_both: float = 0.0
    systematic_terra: float = 0.0
    metrics: dict = field(default_factory=dict)

    def predict(self, frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Per row: mean, independent (quasi-Poisson) variance, systematic scale.

        The systematic scale sqrt(kappa) * mean is an error shared by every row
        of the same month (a whole season the translation over- or
        under-shoots). Aggregates add it linearly before squaring:
        Var(sum) = sum(phi * mu) + (sum(sqrt(kappa) * mu))^2.
        """
        use_terra = (~frame["aqua_on"]).to_numpy()
        mean = np.where(use_terra, self.terra.predict(frame), self.both.predict(frame))
        phi = np.where(use_terra, self.dispersion_terra, self.dispersion_both)
        kappa = np.where(use_terra, self.systematic_terra, self.systematic_both)
        return mean, phi * np.maximum(mean, 0.05), np.sqrt(kappa) * mean


def make_baseline() -> tuple[RatioBaseline, RatioBaseline]:
    return RatioBaseline(("terra_n", "aqua_n")), RatioBaseline(("terra_n",))


def make_boosted(random_state: int = 0) -> tuple[BoostedTranslator, BoostedTranslator]:
    return BoostedTranslator(ALL_FEATURES, random_state), BoostedTranslator(
        TERRA_FEATURES, random_state
    )


def make_offset_boosted(random_state: int = 0):
    return (
        OffsetBoostedTranslator(ALL_FEATURES, ("terra_n", "aqua_n"), random_state),
        OffsetBoostedTranslator(TERRA_FEATURES, ("terra_n",), random_state),
    )


FAMILIES = {
    "baseline": make_baseline,
    "boosted": make_boosted,
    "boosted_offset": make_offset_boosted,
}


def dispersion(y: np.ndarray, mu: np.ndarray) -> float:
    """Pearson estimate of phi; never below 1 (Poisson is the floor).

    Predictions are floored at 0.05 so a near-zero prediction on a week with
    fire does not blow the estimate up by orders of magnitude.
    """
    mu = np.maximum(mu, 0.05)
    return float(max(1.0, np.mean((y - mu) ** 2 / mu)))


def systematic(frame: pd.DataFrame, y: np.ndarray, mu: np.ndarray, min_mean: float = 20.0) -> float:
    """kappa: squared relative error of monthly regional totals beyond Poisson noise.

    Cell-week errors are not independent: a season the translation misjudges is
    misjudged everywhere at once. Ignoring that makes intervals for large areas
    far too narrow.
    """
    monthly = pd.DataFrame({"month": frame["month"].to_numpy(), "y": y, "mu": mu})
    monthly = monthly.groupby("month")[["y", "mu"]].sum()
    monthly = monthly[monthly["mu"] >= min_mean]
    if monthly.empty:
        return 0.0
    rel2 = ((monthly["y"] - monthly["mu"]) / monthly["mu"]) ** 2
    return float(max(0.0, np.mean(rel2 - 1.0 / monthly["mu"])))


def interval90(mean: float, variance: float) -> tuple[float, float]:
    half = Z90 * float(np.sqrt(max(variance, 0.0)))
    return max(0.0, mean - half), mean + half
