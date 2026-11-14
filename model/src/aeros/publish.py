"""Package model runs as the static files the web app serves.

A run folder (from `aeros run --regions`) holds one sub-folder per study
region with JSON artifacts and large Parquet tables. The web only needs the
JSON, so this copies those into one tree, per region and unit:

    <out>/regions.json                    index: regions, units, default region
    <out>/<region>/<unit>/<artifact>.json the region's outputs in that unit
    <out>/<region>/sectors.json           dashboard sectors, when the run has them
    <out>/<unit>/<artifact>.json          the default region again, at the path
                                          the web read before regions existed
    <out>/forecast.json                   the default region's forecast in hotspots
                                          (or its first unit), where the web reads it

Only processed views are published, never raw FIRMS rows (hackathon data
rule), and Parquet tables stay out of the bundle: the API serves them.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Mapping
from pathlib import Path

ARTIFACTS = (
    "calendar_region.json",
    "cells_monthly.json",
    "critical_period.json",
    "forecast.json",
    "meta.json",
    "morning.json",
    "validation.json",
)
REQUIRED = ("calendar_region.json", "cells_monthly.json")
DEFAULT_REGION = "gran-chaco"


def bundle(runs: Mapping[str, Path], out: Path, default_region: str = DEFAULT_REGION) -> dict:
    """Copy every run (unit -> run folder) into the static tree under `out`.

    Returns the index written to `out/regions.json`. A region missing a
    required artifact in some unit fails loudly instead of shipping a half
    calendar.
    """
    if not runs:
        raise ValueError("bundle needs at least one run")
    regions: dict[str, dict] = {}
    for unit, run in runs.items():
        described = {r["id"]: r for r in json.loads((run / "regions.json").read_text())}
        for region_id, info in described.items():
            src = run / region_id
            missing = [name for name in REQUIRED if not (src / name).exists()]
            if missing:
                raise FileNotFoundError(f"{src}: missing {missing}")
            dst = out / region_id / unit
            dst.mkdir(parents=True, exist_ok=True)
            copied = [name for name in ARTIFACTS if (src / name).exists()]
            for name in copied:
                shutil.copyfile(src / name, dst / name)
            entry = regions.setdefault(region_id, {**info, "units": [], "sectors": False})
            entry["units"].append(unit)
            if (src / "sectors.json").exists():
                shutil.copyfile(src / "sectors.json", out / region_id / "sectors.json")
                entry["sectors"] = True

    if default_region not in regions:
        raise ValueError(f"default region {default_region!r} is not in the runs")
    # The app read `<out>/<unit>/` before there were regions; keep that path
    # serving the default region until the region selector ships.
    for unit in regions[default_region]["units"]:
        legacy = out / unit
        legacy.mkdir(parents=True, exist_ok=True)
        for name in ARTIFACTS:
            src = out / default_region / unit / name
            if src.exists():
                shutil.copyfile(src, legacy / name)

    # The web reads the forecast from the root; hotspots is the unit its
    # alerts and the brief speak in.
    units = regions[default_region]["units"]
    unit = "hotspots" if "hotspots" in units else units[0]
    forecast = out / default_region / unit / "forecast.json"
    if forecast.exists():
        shutil.copyfile(forecast, out / "forecast.json")

    index = {
        "default_region": default_region,
        "units": sorted(runs),
        "regions": [regions[k] for k in sorted(regions)],
    }
    (out / "regions.json").write_text(json.dumps(index, indent=1))
    return index
