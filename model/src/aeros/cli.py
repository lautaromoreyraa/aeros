"""Command line entry point: `aeros demo`, `aeros fetch` and `aeros run`."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from aeros import archive, firms, grid, pipeline, synthetic


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aeros")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="run the pipeline on a synthetic archive with known truth")
    demo.add_argument("--out", type=Path, default=Path("data/demo"))
    demo.add_argument("--seed", type=int, default=7)
    demo.add_argument("--unit", choices=["hotspots", "cell_days"], default="hotspots")

    run = sub.add_parser("run", help="run the pipeline on FIRMS CSV files")
    run.add_argument("files", nargs="+", type=Path)
    run.add_argument("--out", type=Path, default=Path("data/processed"))
    run.add_argument("--resolution", type=int, default=4)
    run.add_argument(
        "--reference", default="SNPP,NOAA20", help="VIIRS platform chain, in priority order"
    )
    run.add_argument("--unit", choices=["hotspots", "cell_days"], default="hotspots")
    run.add_argument("--split-year", type=int, default=2019)

    fetch = sub.add_parser("fetch", help="download FIRMS yearly country summaries")
    fetch.add_argument("--out", type=Path, default=Path("data/raw/firms"))
    fetch.add_argument("--countries", default=",".join(archive.GRAN_CHACO_COUNTRIES))
    fetch.add_argument("--last-year", type=int, default=date.today().year - 1)

    args = parser.parse_args(argv)
    if args.command == "demo":
        return _demo(args.out, args.seed, args.unit)
    if args.command == "fetch":
        files = archive.plan(args.countries.split(","), args.last_year)
        print(json.dumps(archive.download(files, args.out), indent=2))
        return 0
    detections = firms.load_many(args.files)
    result = pipeline.run(
        detections,
        args.out,
        resolution=args.resolution,
        reference=tuple(args.reference.split(",")),
        unit=args.unit,
        split_year=args.split_year,
    )
    print(json.dumps(result.report.as_dict(), indent=2))
    return 0


def _demo(out: Path, seed: int, unit: str) -> int:
    archive = synthetic.generate(seed=seed, noaa20_gap=("2026-12-07", "2026-12-20"))
    detections = pd.concat(
        [
            firms.normalize(archive.modis, "MODIS", "synthetic_modis.csv"),
            firms.normalize(archive.viirs, "VIIRS", "synthetic_viirs.csv"),
        ],
        ignore_index=True,
    )
    result = pipeline.run(detections, out, unit=unit)
    truth_rows = firms.normalize(archive.truth_rows, "VIIRS", "synthetic_truth.csv")
    truth = truth_counts(truth_rows, result.resolution, unit)
    backcast = {
        source: backcast_check(result.harmonized, truth, source)
        for source in ("modeled", "bridged")
    }
    (out / "backcast.json").write_text(json.dumps(backcast, indent=2))
    print(json.dumps({"validation": result.report.as_dict(), "backcast": backcast}, indent=2))
    return 0


def truth_counts(rows: pd.DataFrame, resolution: int, unit: str) -> pd.DataFrame:
    """Simulated Suomi NPP truth per cell-week, in the run's unit."""
    rows = rows.assign(
        cell=grid.cells_for(rows["latitude"], rows["longitude"], resolution),
        week=grid.week_start(rows["acq_datetime"]),
        day=rows["acq_datetime"].dt.floor("D"),
    )
    g = rows.groupby(["cell", "week"])
    counts = g.size() if unit == "hotspots" else g["day"].nunique()
    return counts.rename("viirs_truth_n").reset_index()


def backcast_check(harmonized: pd.DataFrame, truth: pd.DataFrame, source: str) -> dict:
    """Score reconstructed weeks of one kind (modeled or bridged) against truth, per year."""
    merged = harmonized.merge(truth, on=["cell", "week"], how="left").fillna({"viirs_truth_n": 0})
    picked = merged[merged["harmonized_source"].str.startswith(source)]
    picked = picked.dropna(subset=["harmonized_n"])
    if picked.empty:
        return {}
    yearly = picked.groupby("year")[["harmonized_n", "viirs_truth_n", "stacked_n"]].sum()
    by_year = picked.groupby("year")
    variance = by_year["harmonized_var"].sum() + by_year["harmonized_shared_sd"].sum() ** 2
    yearly["low"] = yearly["harmonized_n"] - 1.6448536 * np.sqrt(variance)
    yearly["high"] = 2 * yearly["harmonized_n"] - yearly["low"]
    rel = (yearly["harmonized_n"] - yearly["viirs_truth_n"]) / yearly["viirs_truth_n"]
    raw_rel = (yearly["stacked_n"] - yearly["viirs_truth_n"]) / yearly["viirs_truth_n"]
    covered = (yearly["viirs_truth_n"] >= yearly["low"]) & (
        yearly["viirs_truth_n"] <= yearly["high"]
    )
    return {
        "years": [int(y) for y in yearly.index],
        "mean_abs_rel_error_harmonized": float(rel.abs().mean()),
        "mean_abs_rel_error_raw_stacked": float(raw_rel.abs().mean()),
        "interval90_coverage": float(covered.mean()),
        "by_year": {
            int(y): {
                "harmonized": round(float(r.harmonized_n), 1),
                "truth": int(r.viirs_truth_n),
                "raw_stacked": int(r.stacked_n),
            }
            for y, r in yearly.iterrows()
        },
    }


if __name__ == "__main__":
    sys.exit(main())
