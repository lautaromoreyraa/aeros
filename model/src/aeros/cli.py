"""Command line entry point: `aeros demo`, `aeros fetch`, `aeros fetch-recent`,
`aeros build-db`, `aeros run` and `aeros wind`."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

from aeros import (
    archive,
    database,
    firms,
    goes,
    grid,
    pipeline,
    publish,
    regions,
    sectors,
    synthetic,
    wind,
)


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
        "--reference", default="SNPP,NOAA20,NOAA21", help="VIIRS platform chain, in priority order"
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

    sec = sub.add_parser(
        "sectors",
        help="write the Gran Chaco dashboard sectors (country x ecoregion) as sets of H3 cells",
    )
    sec.add_argument("--out", type=Path, required=True, help="sectors.json to write")
    sec.add_argument("--resolution", type=int, default=4)

    pub = sub.add_parser(
        "publish",
        help="copy the JSON outputs of model runs into the static tree the web serves",
    )
    pub.add_argument(
        "--run",
        action="append",
        required=True,
        metavar="UNIT=FOLDER",
        help="a run folder and its unit, e.g. hotspots=data/run; repeat for each unit",
    )
    pub.add_argument("--out", type=Path, default=Path("../web/public/data"))
    pub.add_argument("--default-region", default=publish.DEFAULT_REGION)

    fast = sub.add_parser(
        "goes-latest",
        help="fire pixels of the latest GOES-19 full-disk scans inside the study area",
    )
    fast.add_argument("--out", type=Path, default=Path("data/processed/goes_latest.json"))
    fast.add_argument(
        "--raw", type=Path, default=Path("data/raw/goes"), help="where scans are kept"
    )
    fast.add_argument("--scans", type=int, default=3, help="how many recent 10-minute scans")
    fast.add_argument("--area", default=archive.STUDY_AREA, help="west,south,east,north")
    fast.add_argument("--resolution", type=int, default=4)

    wnd = sub.add_parser(
        "wind",
        help="hourly 10 m wind over the study area for the next two days, as wind.json",
    )
    wnd.add_argument("--out", type=Path, default=Path("data/processed/wind.json"))
    wnd.add_argument("--area", default=archive.STUDY_AREA, help="west,south,east,north")
    wnd.add_argument("--nx", type=int, default=12, help="grid nodes west to east")
    wnd.add_argument("--ny", type=int, default=12, help="grid nodes north to south")
    wnd.add_argument("--hours", type=int, default=48, help="hourly steps from the current hour")

    check = sub.add_parser(
        "verify-archive",
        help="check every yearly country file on disk against the size FIRMS serves;"
        " exits 1 when any file is short or longer",
    )
    check.add_argument("folders", nargs="+", type=Path)

    recent = sub.add_parser(
        "fetch-recent",
        help="download the months after the last yearly archive through the FIRMS area API;"
        " reads the MAP_KEY from the FIRMS_MAP_KEY environment variable",
    )
    recent.add_argument("--out", type=Path, default=Path("data/raw/firms-recent"))
    recent.add_argument("--area", default=archive.STUDY_AREA, help="west,south,east,north")
    recent.add_argument("--start", type=date.fromisoformat, default=date(date.today().year, 1, 1))
    recent.add_argument("--end", type=date.fromisoformat, default=date.today())
    recent.add_argument(
        "--platforms",
        help="comma-separated subset of MODIS,SNPP,NOAA20,NOAA21 (default: all)",
    )

    args = parser.parse_args(argv)
    if args.command == "demo":
        return _demo(args.out, args.seed, args.unit)
    if args.command == "fetch":
        files = archive.plan(args.countries.split(","), args.last_year)
        print(json.dumps(archive.download(files, args.out, workers=args.workers), indent=2))
        return 0
    if args.command == "sectors":
        parent = regions.load(sectors.PARENT_REGION)
        payload = sectors.payload(parent.cells(args.resolution), args.resolution)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, separators=(",", ":")))
        print(json.dumps({s["id"]: len(s["cells"]) for s in payload}))
        return 0
    if args.command == "publish":
        runs = {}
        for item in args.run:
            unit, _, folder = item.partition("=")
            if unit not in ("hotspots", "cell_days") or not folder:
                parser.error(f"--run expects hotspots=FOLDER or cell_days=FOLDER, got {item!r}")
            runs[unit] = Path(folder)
        index = publish.bundle(runs, args.out, args.default_region)
        print(json.dumps(index, indent=2))
        return 0
    if args.command == "goes-latest":
        now = datetime.now(UTC)
        area = tuple(float(v) for v in args.area.split(","))
        frames = [
            goes.decode(goes.download(scan, args.raw), area)
            for scan in goes.latest_scans(now, args.scans)
        ]
        frame = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        summary = goes.summarize(frame, args.resolution, args.area, now)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=1))
        print(json.dumps({k: summary[k] for k in ("scans", "pixels", "confident_pixels")}))
        return 0
    if args.command == "wind":
        field = wind.build(
            wind.parse_area(args.area), args.nx, args.ny, args.hours, datetime.now(UTC)
        )
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(field, separators=(",", ":")))
        print(
            json.dumps(
                {"hours": len(field["hours"]), "first": field["hours"][0], "grid": field["grid"]}
            )
        )
        return 0
    if args.command == "verify-archive":
        report = archive.verify(args.folders)
        summary = {k: len(v) for k, v in report.items()}
        print(
            json.dumps(
                {
                    "summary": summary,
                    "short": report["short"],
                    "longer": report["longer"],
                    "unknown": report["unknown"],
                },
                indent=2,
            )
        )
        return 1 if report["short"] or report["longer"] else 0
    if args.command == "fetch-recent":
        map_key = os.environ.get("FIRMS_MAP_KEY")
        if not map_key:
            parser.error("set FIRMS_MAP_KEY to a FIRMS MAP_KEY")
        platforms = tuple(args.platforms.split(",")) if args.platforms else None
        requests = archive.recent_plan(
            archive.availability(map_key), args.area, args.start, args.end, platforms
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
