"""End-to-end run: detections -> panel -> validated translator -> outputs.

Outputs (all in `out_dir`):

* `harmonized_cells.parquet`  cell x week panel with harmonized counts (API input)
* `hotspots_harmonized.parquet` every detection with its harmonized weight
* `calendar_region.json`      month x year calendar for the whole region
* `cells_monthly.json`        per-cell monthly series for the map layer
* `validation.json`           out-of-sample scores, dispersion and the winner
* `morning.json`              Terra-only share and Terra overpass drift
* `critical_period.json`      shortest run of months holding 80 % of activity
* `forecast.json`             1-4 week activity forecast with its validation
* `meta.json`                 unit, reference chain, grid resolution, chosen model
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from aeros import burn_calendar, features, forecast, harmonize, morning, validation


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
) -> Result:
    out_dir.mkdir(parents=True, exist_ok=True)
    panel = features.build_panel(detections, resolution=resolution, reference=reference, unit=unit)
    report, fitted = validation.evaluate(panel.frame, split_year=split_year)
    translator = fitted[report.winner]
    harmonized = harmonize.harmonize_panel(panel.frame, translator)

    harmonized.to_parquet(out_dir / "harmonized_cells.parquet", index=False)
    weights = harmonize.hotspot_weights(detections, harmonized, resolution)
    weights.to_parquet(out_dir / "hotspots_harmonized.parquet", index=False)

    region = burn_calendar.monthly(harmonized)
    _write_json(out_dir / "calendar_region.json", _calendar_records(region))
    _write_json(out_dir / "cells_monthly.json", _cells_monthly(harmonized, resolution))
    _write_json(out_dir / "critical_period.json", burn_calendar.critical_period(region))
    examples = forecast.build_examples(forecast.weekly_series(harmonized))
    years = sorted(examples["year"].unique())
    test_from = years[-3] if len(years) > 4 else years[-1]
    _, forecaster = forecast.evaluate(examples, test_from_year=int(test_from))
    _write_json(
        out_dir / "forecast.json",
        forecast.to_json(forecast.latest(examples, forecaster), forecaster, unit),
    )
    _write_json(out_dir / "validation.json", report.as_dict())
    _write_json(
        out_dir / "morning.json",
        morning.terra_only_share(detections, resolution).to_dict(orient="records"),
    )
    _write_json(
        out_dir / "meta.json",
        {
            "unit": unit,
            "reference_chain": list(reference),
            "resolution": resolution,
            "model": report.winner,
            "first_month": str(harmonized["month"].min().date()),
            "last_month": str(harmonized["month"].max().date()),
        },
    )
    return Result(panel.frame, harmonized, report, report.winner, resolution, unit)


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
