"""End-to-end run: detections -> panel -> validated translator -> outputs.

Outputs (all in `out_dir`):

* `harmonized_cells.parquet`  cell x week panel with harmonized counts (API input)
* `hotspots_harmonized.parquet` every detection with its harmonized weight
* `calendar_region.json`      month x year calendar for the whole region
* `cells_monthly.json`        per-cell monthly series for the map layer
* `validation.json`           out-of-sample scores, dispersion and the winner
* `morning.json`              Terra-only share and Terra overpass drift
* `critical_period.json`      shortest run of months holding 80 % of activity
* `forecast.json`             1-4 week activity forecast with its validation; with
                              `conditions` (fuel and weather, `aeros.power`), it
                              also compares the feature sets and keeps the best
* `meta.json`                 unit, reference chain, grid resolution, chosen model

With study regions, the translator is fitted once on all of them and every
region gets the files above in `out_dir/<region id>/`, listed in
`out_dir/regions.json`. The two Parquet tables are also written to `out_dir`
for the union of the regions: the API input. The Gran Chaco folder also gets
`sectors.json`: its dashboard sectors (country x ecoregion) as sets of cells.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from aeros import (
    burn_calendar,
    features,
    forecast,
    harmonize,
    morning,
    power,
    regions,
    sectors,
    validation,
)


@dataclass
class Result:
    panel: pd.DataFrame
    harmonized: pd.DataFrame
    report: validation.Report
    translator_name: str
    resolution: int
    unit: str


def run(
    detections: pd.DataFrame,
    out_dir: Path,
    resolution: int = 4,
    reference: tuple[str, ...] = features.DEFAULT_REFERENCE,
    unit: str = "hotspots",
    split_year: int = 2019,
    study_regions: Sequence[regions.Region] = (),
    conditions: pd.DataFrame | None = None,
) -> Result:
    out_dir.mkdir(parents=True, exist_ok=True)
    if study_regions:
        detections = regions.clip(detections, study_regions, resolution)
    panel = features.build_panel(detections, resolution=resolution, reference=reference, unit=unit)
    report, fitted = validation.evaluate(panel.frame, split_year=split_year)
    translator = fitted[report.winner]
    harmonized = harmonize.harmonize_panel(panel.frame, translator)

    meta = {"unit": unit, "reference_chain": list(reference), "resolution": resolution}
    if not study_regions:
        _write_outputs(detections, harmonized, report, out_dir, meta, conditions)
    for region in study_regions:
        _write_outputs(
            detections[regions.in_region(detections, region, resolution)],
            harmonized[regions.in_region(harmonized, region, resolution)],
            report,
            out_dir / region.id,
            {**meta, "region": region.describe()},
            conditions,
        )
        if region.id == sectors.PARENT_REGION:
            _write_json(
                out_dir / region.id / "sectors.json",
                sectors.payload(region.cells(resolution), resolution),
            )
    if study_regions:
        # The API answers any drawn area, so it reads one table for the union of
        # the regions (without the neighbor ring) rather than one per region.
        union = harmonized["cell"].isin(
            frozenset().union(*(r.cells(resolution) for r in study_regions))
        )
        harmonized[union].to_parquet(out_dir / "harmonized_cells.parquet", index=False)
        harmonize.hotspot_weights(detections, harmonized[union], resolution).to_parquet(
            out_dir / "hotspots_harmonized.parquet", index=False
        )
        _write_json(out_dir / "regions.json", [r.describe() for r in study_regions])
    return Result(panel.frame, harmonized, report, report.winner, resolution, unit)


@dataclass
class ForecastChoice:
    examples: pd.DataFrame
    forecaster: forecast.Forecaster
    chosen: str
    comparison: dict

    def to_json(self, unit: str) -> dict:
        payload = forecast.to_json(
            forecast.latest(self.examples, self.forecaster), self.forecaster, unit
        )
        payload["features"] = {"chosen": self.chosen, "comparison": self.comparison}
        if self.chosen != "history":
            payload["features"]["source"] = power.SOURCE
        return payload


FEATURE_SETS = {
    "history": forecast.FEATURES,
    "history+soil": forecast.FEATURES + forecast.SOIL,
    "history+weather": forecast.FEATURES + forecast.WEATHER,
    "history+soil+weather": forecast.FEATURES + forecast.CONDITIONS,
}


def _mean_score(report: dict, key: str) -> float:
    return float(np.mean([h["model"][key] for h in report["by_horizon"].values()]))


# The set the forecast uses when the conditions are there. Chosen on four
# held-out windows of the Gran Chaco (2018-19, 2020-21, 2022-23, 2024-26), not
# on one: the fire weather lowered the error per cell and week in three of them,
# most in the 2020 drought (-2.7 %), and was even in the fourth. The soil
# wetness raised it in three of the four, so it stays out of the model.
CHOSEN_WITH_CONDITIONS = "history+weather"


def fit_forecast(
    harmonized: pd.DataFrame,
    conditions: pd.DataFrame | None = None,
    compare_all: bool = False,
) -> ForecastChoice:
    """Fits the forecast and scores it against the fire history alone.

    Without `conditions` only the fire history is used. With them, the
    forecast uses `CHOSEN_WITH_CONDITIONS`, and the history alone is fitted
    too so `forecast.json` shows what the conditions changed; `compare_all`
    adds the other sets. The score is the mean absolute error per cell and
    week over the four horizons, on the last three years, which no set trains
    on. The choice is fixed rather than taken from that one window, because a
    pick on a single window chases its noise.
    """
    examples = forecast.build_examples(forecast.weekly_series(harmonized), conditions)
    years = sorted(examples["year"].unique())
    test_from = int(years[-3] if len(years) > 4 else years[-1])
    if conditions is None:
        chosen, names = "history", ["history"]
    else:
        chosen = CHOSEN_WITH_CONDITIONS
        names = list(FEATURE_SETS) if compare_all else ["history", chosen]
    fitted = {name: forecast.evaluate(examples, test_from, FEATURE_SETS[name]) for name in names}
    comparison = {
        name: {
            "mae_cell_week": round(_mean_score(report, "mae_cell_week"), 4),
            "mae_region_week": round(_mean_score(report, "mae_region_week"), 2),
            "by_horizon_mae_cell_week": {
                h: round(r["model"]["mae_cell_week"], 4) for h, r in report["by_horizon"].items()
            },
        }
        for name, (report, _) in fitted.items()
    }
    return ForecastChoice(examples, fitted[chosen][1], chosen, comparison)


def _write_outputs(
    detections: pd.DataFrame,
    harmonized: pd.DataFrame,
    report: validation.Report,
    out_dir: Path,
    meta: dict,
    conditions: pd.DataFrame | None = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    resolution, unit = meta["resolution"], meta["unit"]
    harmonized.to_parquet(out_dir / "harmonized_cells.parquet", index=False)
    weights = harmonize.hotspot_weights(detections, harmonized, resolution)
    weights.to_parquet(out_dir / "hotspots_harmonized.parquet", index=False)

    region = burn_calendar.monthly(harmonized)
    _write_json(out_dir / "calendar_region.json", _calendar_records(region))
    _write_json(out_dir / "cells_monthly.json", _cells_monthly(harmonized, resolution))
    _write_json(out_dir / "critical_period.json", burn_calendar.critical_period(region))
    _write_json(out_dir / "forecast.json", fit_forecast(harmonized, conditions).to_json(unit))
    _write_json(out_dir / "validation.json", report.as_dict())
    _write_json(
        out_dir / "morning.json",
        morning.terra_only_share(detections, resolution).to_dict(orient="records"),
    )
    _write_json(
        out_dir / "meta.json",
        {
            **meta,
            "model": report.winner,
            "first_month": str(harmonized["month"].min().date()),
            "last_month": str(harmonized["month"].max().date()),
        },
    )


def _calendar_records(table: pd.DataFrame) -> list[dict]:
    cols = [
        "year",
        "month_of_year",
        "harmonized",
        "low",
        "high",
        "stacked_raw",
        "unattached",
        "median_same_month",
        "anomaly",
        "anomaly_ratio",
        "source",
    ]
    return table[cols].replace({np.nan: None}).to_dict(orient="records")


def _cells_monthly(harmonized: pd.DataFrame, resolution: int) -> dict:
    g = harmonized.groupby(["cell", "month"]).agg(
        harmonized=("harmonized_n", "sum"),
        variance=("harmonized_var", "sum"),
        shared_sd=("harmonized_shared_sd", "sum"),
        stacked=("stacked_n", "sum"),
    )
    g["variance"] = g["variance"] + g["shared_sd"] ** 2
    g = g.reset_index()
    months = sorted(g["month"].unique())
    index = {m: i for i, m in enumerate(months)}
    cells = []
    for cell, rows in g.groupby("cell"):
        active = rows[(rows["harmonized"] > 0) | (rows["stacked"] > 0)]
        cells.append(
            {
                "cell": cell,
                "values": [
                    [index[m], round(float(h), 3), round(float(v), 3), int(s)]
                    for m, h, v, s in zip(
                        active["month"],
                        active["harmonized"],
                        active["variance"],
                        active["stacked"],
                        strict=True,
                    )
                ],
            }
        )
    return {
        "resolution": resolution,
        "months": [pd.Timestamp(m).strftime("%Y-%m") for m in months],
        "columns": ["month_index", "harmonized", "variance", "stacked_raw"],
        "cells": cells,
    }


def _write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=None, separators=(",", ":"), default=str))
