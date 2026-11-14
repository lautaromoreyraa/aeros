"""Command line entry point: `aeros demo`, `aeros fetch`, `aeros fetch-recent`,
`aeros build-db` and `aeros run`."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from aeros import archive, database, firms, grid, pipeline, regions, synthetic


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aeros")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="run the pipeline on a synthetic archive with known truth")
    demo.add_argument("--out", type=Path, default=Path("data/demo"))
    demo.add_argument("--seed", type=int, default=7)
    demo.add_argument("--unit", choices=["hotspots", "cell_days"], default="hotspots")

    run = sub.add_parser("run", help="run the pipeline on FIRMS CSV files or the database")
    run.add_argument("files", nargs="*", type=Path)
    run.add_argument("--db", type=Path, help="read detections from `aeros build-db` output")
    run.add_argument("--out", type=Path, default=Path("data/processed"))
    run.add_argument("--resolution", type=int, default=4)
    run.add_argument(
        "--reference", default="SNPP,NOAA20", help="VIIRS platform chain, in priority order"
    )
    run.add_argument("--unit", choices=["hotspots", "cell_days"], default="hotspots")
    run.add_argument("--split-year", type=int, default=2019)
    run.add_argument(
        "--regions",
        default="",
        help=f"study regions to report, comma-separated or 'all' ({', '.join(regions.REGION_IDS)});"
        " empty reports every detection as one region",
    )

    db = sub.add_parser(
        "build-db",
        help="build the ordered detection database (Parquet by platform and year) for the study"
        " regions from every FIRMS download",
    )
    db.add_argument("raw", nargs="+", type=Path, help="folders with FIRMS CSV files")
    db.add_argument("--out", type=Path, default=Path("data/db"))
    db.add_argument("--regions", default="all")
    db.add_argument("--resolution", type=int, default=4)
    db.add_argument(
        "--compare",
        nargs="*",
        type=Path,
        default=[],
        help="independent FIRMS downloads to check the database against, day by day",
    )

    fetch = sub.add_parser("fetch", help="download FIRMS yearly country summaries")
    fetch.add_argument("--out", type=Path, default=Path("data/raw/firms"))
    fetch.add_argument("--countries", default=",".join(archive.GRAN_CHACO_COUNTRIES))
    fetch.add_argument("--last-year", type=int, default=date.today().year - 1)
    fetch.add_argument("--workers", type=int, default=4, help="files downloaded at once")

    recent = sub.add_parser(
        "fetch-recent",
        help="download the months after the last yearly archive through the FIRMS area API;"
        " reads the MAP_KEY from the FIRMS_MAP_KEY environment variable",
    )
    recent.add_argument("--out", type=Path, default=Path("data/raw/firms-recent"))
    recent.add_argument("--area", default=archive.STUDY_AREA, help="west,south,east,north")
    recent.add_argument("--start", type=date.fromisoformat, default=date(date.today().year, 1, 1))
    recent.add_argument("--end", type=date.fromisoformat, default=date.today())

    args = parser.parse_args(argv)
    if args.command == "demo":
        return _demo(args.out, args.seed, args.unit)
    if args.command == "fetch":
        files = archive.plan(args.countries.split(","), args.last_year)
        print(json.dumps(archive.download(files, args.out, workers=args.workers), indent=2))
        return 0
    if args.command == "fetch-recent":
        map_key = os.environ.get("FIRMS_MAP_KEY")
        if not map_key:
            parser.error("set FIRMS_MAP_KEY to a FIRMS MAP_KEY")
        requests = archive.recent_plan(
            archive.availability(map_key), args.area, args.start, args.end
        )
        report = archive.download_recent(requests, args.out, map_key, date.today())
        print(json.dumps(report, indent=2))
        return 0
    study = regions.parse(args.regions) if args.regions else []
    if args.command == "build-db":
        report = database.build(args.raw, args.out, study, args.resolution)
        checks = database.compare(args.out, args.compare, study)
        (args.out / "comparison.json").write_text(json.dumps(checks, indent=1))
        print(json.dumps({**report, "comparison": checks}, indent=2))
        return 0
    if args.db:
        detections = database.load(args.db)
    elif args.files:
        # Clipping file by file keeps whole-country archives from filling memory.
        keep = (lambda d: regions.clip(d, study, args.resolution)) if study else None
        detections = firms.load_many(args.files, keep=keep)
    else:
        parser.error("run needs FIRMS files or --db")
    result = pipeline.run(
        detections,
        args.out,
        resolution=args.resolution,
        reference=tuple(args.reference.split(",")),
        unit=args.unit,
        split_year=args.split_year,
        study_regions=study,
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
