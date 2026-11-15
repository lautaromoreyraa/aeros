"""One ordered detection database for the study area, built from every FIRMS download.

FIRMS reaches us through three doors that overlap and disagree in small ways:
yearly country summaries (standard processing, whole countries, closed years),
area API chunks (the current year, standard processing then near-real-time)
and manual "download area" requests. `build` reads all of them once, keeps the
study box, removes duplicates and writes:

    detections/platform=<P>/year=<Y>/part-0.parquet  one row per detection
    cell_days/year=<Y>/part-0.parquet                one row per cell, UTC day, platform
    inventory.json                                   every source file and what it gave
    coverage.json                                    per platform: covered and missing days

Detections are sorted by acquisition time inside each platform and year, in
row groups of about a month, so a date range reads only the groups it needs
and a model sees each sensor in the order it flew. Every row keeps the fields
a learner can use (both brightness temperatures, FRP, scan and track, which
grow toward the swath edge, local solar hour) plus where it came from
(processing level, file, row).

`cell_days` is the compact table ML features start from: per H3 cell, day and
platform, the detection count, day/night split and FRP, vegetation fires only.
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

from aeros import firms, grid, regions
from aeros.sensors import PLATFORMS, SATELLITE_CODES, instrument_from_filename

# FIRMS product of a file -> the platforms it carries.
PRODUCT_PLATFORMS = {
    "modis": ("TERRA", "AQUA"),
    "m-c61": ("TERRA", "AQUA"),
    "viirs-snpp": ("SNPP",),
    "sv-c2": ("SNPP",),
    "viirs-jpss1": ("NOAA20",),
    "j1v-c2": ("NOAA20",),
    "viirs-jpss2": ("NOAA21",),
    "j2v-c2": ("NOAA21",),
}
_COUNTRY = re.compile(r"^(modis|viirs-snpp|viirs-jpss1|viirs-jpss2)_(\d{4})_([A-Za-z_]+)\.csv$")
_API = re.compile(r"^fire_(archive|nrt)_([a-z0-9-]+)_(\d{4}-\d{2}-\d{2})\.csv$")
_AREA_REQUEST = re.compile(r"^fire_(archive|nrt)_([a-z0-9-]+)_\d+\.csv$", re.IGNORECASE)

# MODIS confidence is 0-100; FIRMS documents < 30 as low and >= 80 as high.
_VIIRS_CONFIDENCE = {"l": "low", "n": "nominal", "h": "high"}
LEVEL_PRIORITY = {"SP": 0, "NRT": 1}
# Days per area API request (the API maximum, see `aeros.archive`).
MAX_API_DAYS = 5
ROW_GROUP = 200_000


@dataclass
class SourceFile:
    """What one downloaded file is and what it contributed."""

    path: str
    kind: str  # country | area_api | area_request
    product: str
    platforms: tuple[str, ...]
    level: str  # SP | NRT
    country: str | None = None
    year: int | None = None
    first_day: str | None = None
    last_day: str | None = None
    rows: int = 0
    bad_rows: int = 0
    rows_in_box: int = 0
    columns: list[str] = field(default_factory=list)


def describe(path: Path) -> SourceFile | None:
    """Classify a FIRMS file by its name, or None if it is not a fire file we use."""
    name = path.name
    if m := _COUNTRY.match(name):
        product, year, country = m.groups()
        return SourceFile(
            str(path), "country", product, PRODUCT_PLATFORMS[product], "SP", country, int(year)
        )
    lower = name.lower()
    if m := _API.match(lower):
        level, product, _ = m.groups()
        if product in PRODUCT_PLATFORMS:
            return SourceFile(
                str(path),
                "area_api",
                product,
                PRODUCT_PLATFORMS[product],
                "SP" if level == "archive" else "NRT",
            )
    if m := _AREA_REQUEST.match(lower):
        level, product = m.groups()
        if product in PRODUCT_PLATFORMS:
            return SourceFile(
                str(path),
                "area_request",
                product,
                PRODUCT_PLATFORMS[product],
                "SP" if level == "archive" else "NRT",
            )
    return None


def study_box(study: Iterable[regions.Region], margin: float = 1.0) -> tuple[float, ...]:
    """West, south, east, north of the regions plus `margin` degrees."""
    bounds = np.array([r.bounds() for r in study])
    return (
        float(bounds[:, 0].min() - margin),
        float(bounds[:, 1].min() - margin),
        float(bounds[:, 2].max() + margin),
        float(bounds[:, 3].max() + margin),
    )


def read_source(source: SourceFile, box: tuple[float, ...]) -> pd.DataFrame:
    """Normalized detections of one file inside `box`, with the extra ML fields."""
    path = Path(source.path)
    raw = pd.read_csv(path, dtype={"acq_time": str, "confidence": str, "version": str})
    source.rows = len(raw)
    source.columns = list(raw.columns)
    required = ["latitude", "longitude", "acq_date", "acq_time", "satellite"]
    good = raw[required].notna().all(axis=1)
    source.bad_rows = int((~good).sum())
    raw = raw[good]
    if not raw.empty:
        source.first_day, source.last_day = str(raw["acq_date"].min()), str(raw["acq_date"].max())
    raw = raw[_in_box(raw, box)]
    file_rows = raw.index.to_numpy() + 1
    raw = raw.reset_index(drop=True)
    source.rows_in_box = len(raw)

    det = firms.normalize(raw, instrument_from_filename(path), source_file=path.name)
    # The loader numbers rows after filtering; keep the file's own row number.
    det["source_row"] = file_rows
    mir = "brightness" if "brightness" in raw else "bright_ti4"
    tir = "bright_t31" if "bright_t31" in raw else "bright_ti5"
    det["bt_mir"] = raw.get(mir, pd.Series(np.nan, index=raw.index)).astype("float32").values
    det["bt_tir"] = raw.get(tir, pd.Series(np.nan, index=raw.index)).astype("float32").values
    det["version"] = raw.get("version", pd.Series("", index=raw.index)).astype(str).values
    # NRT files carry no `type`: the loader then treats every row as vegetation,
    # so the database says when that is an assumption.
    det["type_known"] = "type" in raw
    det["processing_level"] = source.level
    det["confidence_class"] = confidence_class(det["confidence"], det["instrument"])
    return det


def _in_box(raw: pd.DataFrame, box: tuple[float, ...]) -> pd.Series:
    west, south, east, north = box
    return raw["longitude"].between(west, east) & raw["latitude"].between(south, north)


def confidence_class(confidence: pd.Series, instrument: pd.Series) -> pd.Series:
    """One low / nominal / high scale for MODIS (0-100) and VIIRS (l/n/h)."""
    viirs = confidence.str.lower().map(_VIIRS_CONFIDENCE)
    numeric = pd.to_numeric(confidence, errors="coerce")
    modis = pd.Series(
        np.select([numeric < 30, numeric >= 80], ["low", "high"], "nominal"), index=confidence.index
    ).where(numeric.notna())
    return viirs.where(instrument == "VIIRS", modis)


def deduplicate(det: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """One row per platform, time and pixel; standard processing wins over NRT."""
    key = det.assign(
        _lat=det["latitude"].round(4),
        _lon=det["longitude"].round(4),
        _level=det["processing_level"].map(LEVEL_PRIORITY),
    ).sort_values("_level", kind="stable")
    dup = key.duplicated(["platform", "acq_datetime", "_lat", "_lon"], keep="first")
    return det.loc[key.index[~dup]], int(dup.sum())


def _prepare(det: pd.DataFrame, study: list[regions.Region], resolution: int) -> pd.DataFrame:
    det = det.copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    for region in study:
        det[f"in_{region.id.replace('-', '_')}"] = regions.in_region(det, region, resolution)
    det["day"] = det["acq_datetime"].dt.tz_convert("UTC").dt.tz_localize(None).dt.normalize()
    det["year"] = det["acq_datetime"].dt.year.astype("int16")
    for column in ("solar_hour", "frp", "scan", "track"):
        det[column] = det[column].astype("float32")
    det["type"] = det["type"].astype("int8")
    return det.sort_values(["acq_datetime", "cell"], kind="stable").reset_index(drop=True)


def cell_days(det: pd.DataFrame) -> pd.DataFrame:
    """Per cell, UTC day and platform: what each sensor saw, vegetation fires only."""
    veg = det[det["is_vegetation"]]
    keys = ["cell", "day", "platform"]
    g = veg.groupby(keys, observed=True)
    table = pd.DataFrame(
        {
            "n": g.size(),
            "n_day": veg[veg["daynight"] == "D"].groupby(keys, observed=True).size(),
            "n_night": veg[veg["daynight"] == "N"].groupby(keys, observed=True).size(),
            "frp_sum": g["frp"].sum(),
            "frp_max": g["frp"].max(),
            "scan_mean": g["scan"].mean(),
            "solar_hour_mean": g["solar_hour"].mean(),
        }
    ).reset_index()
    counts = ["n", "n_day", "n_night"]
    table[counts] = table[counts].fillna(0).astype("int32")
    table["year"] = table["day"].dt.year.astype("int16")
    return table.sort_values(["day", "cell", "platform"]).reset_index(drop=True)


def _write(table: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.Table.from_pandas(table, preserve_index=False),
        path,
        row_group_size=ROW_GROUP,
        compression="zstd",
    )


def coverage(
    sources: list[SourceFile],
    active_days: dict[str, set[date]],
    today: date,
    study_countries: Iterable[str],
) -> dict:
    """Per platform: days a file covers, days with no file, and silent runs.

    A country file covers its whole year for the study box only when the files
    of every study country exist for that product and year; an area file
    covers the days it reports. A covered run of three or more days with no
    detection while the season is active elsewhere is listed as `silent`: it
    is usually an outage, not a fireless week.
    """
    countries = set(study_countries)
    covered: dict[str, dict[date, str]] = {p: {} for p in PLATFORMS}
    by_year: dict[tuple[str, int], set[str]] = {}
    for s in sources:
        if s.kind == "country":
            by_year.setdefault((s.product, s.year), set()).add(s.country)
    for (product, year), have in by_year.items():
        if countries <= have:
            for platform in PRODUCT_PLATFORMS[product]:
                for d in pd.date_range(f"{year}-01-01", f"{year}-12-31").date:
                    covered[platform].setdefault(d, "SP")
    for s, first, last in _api_spans(sources, today):
        for platform in s.platforms:
            for d in pd.date_range(first, last).date:
                if covered[platform].get(d) != "SP":
                    covered[platform][d] = s.level

    report = {}
    any_active = set().union(*active_days.values()) if active_days else set()
    for name, p in PLATFORMS.items():
        end = min(p.last_day or today, today)
        expected = pd.date_range(p.first_day, end).date
        days = covered[name]
        missing = [d for d in expected if d not in days]
        seen = active_days.get(name, set())
        silent = _runs(
            [d for d in expected if d in days and d not in seen and d in any_active], min_len=3
        )
        report[name] = {
            "mission": [str(p.first_day), str(end)],
            "expected_days": len(expected),
            "covered_days": sum(1 for d in expected if d in days),
            "nrt_days": sum(1 for d in expected if days.get(d) == "NRT"),
            "missing": _runs(missing),
            "silent": silent,
        }
    return report


def _api_spans(sources: list[SourceFile], today: date):
    """(file, first day, last day) each area API chunk was requested for.

    The name holds the first day; a chunk runs until the next chunk of the same
    source starts, at most `MAX_API_DAYS` and never past today, so a chunk with
    no fire still counts as covered.
    """
    by_prefix: dict[str, list[tuple[date, SourceFile]]] = {}
    for s in sources:
        if s.kind == "area_api":
            start = date.fromisoformat(Path(s.path).stem.rsplit("_", 1)[1])
            by_prefix.setdefault(f"{s.level}-{s.product}", []).append((start, s))
    for chunks in by_prefix.values():
        chunks.sort(key=lambda c: c[0])
        for i, (start, s) in enumerate(chunks):
            last = start + timedelta(days=MAX_API_DAYS - 1)
            if i + 1 < len(chunks):
                last = min(last, chunks[i + 1][0] - timedelta(days=1))
            yield s, start, min(last, today)


def _runs(days: list[date], min_len: int = 1) -> list[list[str]]:
    """Consecutive days as [first, last] pairs."""
    out: list[list[date]] = []
    for d in sorted(days):
        if out and d - out[-1][1] == timedelta(days=1):
            out[-1][1] = d
        else:
            out.append([d, d])
    return [[str(a), str(b)] for a, b in out if (b - a).days + 1 >= min_len]


def build(
    raw_dirs: Iterable[Path],
    out: Path,
    study: list[regions.Region],
    resolution: int = grid.DEFAULT_RESOLUTION,
    today: date | None = None,
    study_countries: Iterable[str] = ("Argentina", "Paraguay", "Bolivia"),
) -> dict:
    """Read every FIRMS file under `raw_dirs` and write the database to `out`.

    Only country files and area API chunks are stored: they tile the record
    without overlapping. Manual area requests repeat what those already hold
    and are used by `compare` to check them. Tables from an earlier build are
    replaced, never merged.
    """
    today = today or date.today()
    box = study_box(study)
    sources = [
        s
        for d in raw_dirs
        for p in sorted(Path(d).rglob("*.csv"))
        if (s := describe(p)) is not None and s.kind != "area_request"
    ]
    for table in ("detections", "cell_days"):
        if (out / table).exists():
            shutil.rmtree(out / table)
    # One product-year at a time keeps memory to a single year of one sensor.
    groups: dict[tuple[str, int], list[SourceFile]] = {}
    for s in sources:
        year = s.year or int(Path(s.path).stem.rsplit("_", 1)[1][:4])
        groups.setdefault((PRODUCT_PLATFORMS[s.product][0], year), []).append(s)

    active: dict[str, set[date]] = {}
    totals = {"detections": 0, "duplicates": 0}
    for _, members in sorted(groups.items()):
        frames = [read_source(s, box) for s in members]
        frames = [f for f in frames if not f.empty]
        if not frames:
            continue
        det, dups = deduplicate(pd.concat(frames, ignore_index=True))
        det = _prepare(det, study, resolution)
        totals["duplicates"] += dups
        for platform, part in det.groupby("platform"):
            for y, rows in part.groupby("year"):
                path = out / "detections" / f"platform={platform}" / f"year={y}" / "part-0.parquet"
                if path.exists():
                    rows = pd.concat([pd.read_parquet(path), rows], ignore_index=True)
                    rows, more = deduplicate(rows)
                    totals["duplicates"] += more
                    rows = rows.sort_values(["acq_datetime", "cell"], kind="stable")
                _write(rows.drop(columns=["platform", "year"]), path)
            active.setdefault(platform, set()).update(part["day"].dt.date)
        totals["detections"] += len(det)

    _rebuild_cell_days(out)
    report = {
        "box": box,
        "resolution": resolution,
        "regions": [r.describe() for r in study],
        **totals,
        "files": len(sources),
    }
    (out / "inventory.json").write_text(
        json.dumps({**report, "sources": [asdict(s) for s in sources]}, indent=1, default=str)
    )
    (out / "coverage.json").write_text(
        json.dumps(coverage(sources, active, today, study_countries), indent=1)
    )
    return report


def compare(db: Path, reference: Iterable[Path], study: list[regions.Region]) -> list[dict]:
    """Day-by-day detection counts of the database against independent downloads.

    Each reference file (e.g. a FIRMS "download area" request) is cut to the
    study box and to the days both sides cover, then counted per platform, day
    and processing level. Equal counts mean the two doors served the same
    record; differences point at a missing or truncated chunk.
    """
    box = study_box(study)
    results = []
    for path in reference:
        source = describe(path)
        if source is None:
            continue
        counts = []
        columns = ["latitude", "longitude", "acq_date", "satellite"]
        for chunk in pd.read_csv(path, usecols=columns, chunksize=1_000_000):
            chunk = chunk[_in_box(chunk, box)]
            platform = chunk["satellite"].astype(str).map(SATELLITE_CODES).rename("platform")
            day = pd.to_datetime(chunk["acq_date"]).rename("day")
            counts.append(chunk.groupby([platform, day]).size())
        if not counts:
            continue
        ref = pd.concat(counts).groupby(level=[0, 1]).sum()
        days = ref.index.get_level_values("day")
        stored = load(
            db,
            start=days.min().date(),
            end=days.max().date(),
            platforms=source.platforms,
            with_cells=True,
        )
        stored = stored[stored["processing_level"] == source.level]
        stored_days = stored.groupby(["platform", "day"]).size()
        for platform in source.platforms:
            if platform not in ref.index.get_level_values("platform"):
                continue
            theirs = ref.xs(platform, level="platform")
            span_days = stored.loc[stored["platform"] == platform, "day"]
            if span_days.empty:
                span = theirs.index[:0]
            else:
                span = theirs.index[
                    (theirs.index >= span_days.min()) & (theirs.index <= span_days.max())
                ]
            ours = (
                stored_days.xs(platform, level="platform")
                if platform in stored_days.index.get_level_values("platform")
                else pd.Series(dtype=int)
            ).reindex(span, fill_value=0)
            diff = (ours - theirs.loc[span]).astype(int)
            worst = diff.abs().sort_values(ascending=False).head(5)
            results.append(
                {
                    "reference": path.name,
                    "platform": platform,
                    "level": source.level,
                    "days": len(span),
                    "first_day": str(span.min().date()) if len(span) else None,
                    "last_day": str(span.max().date()) if len(span) else None,
                    "database": int(ours.sum()),
                    "reference_count": int(theirs.loc[span].sum()),
                    "days_equal": int((diff == 0).sum()),
                    "worst_days": {str(d.date()): int(diff[d]) for d in worst.index if diff[d]},
                }
            )
    return results


def _rebuild_cell_days(out: Path) -> None:
    detections = out / "detections"
    years = sorted({int(p.name.split("=")[1]) for p in detections.glob("platform=*/year=*")})
    for year in years:
        det = load(out, start=date(year, 1, 1), end=date(year, 12, 31), with_cells=True)
        _write(
            cell_days(det).drop(columns=["year"]),
            out / "cell_days" / f"year={year}" / "part-0.parquet",
        )


def load(
    db: Path,
    start: date | None = None,
    end: date | None = None,
    platforms: Iterable[str] | None = None,
    with_cells: bool = False,
) -> pd.DataFrame:
    """Detections from the database in the loader's schema (`aeros.firms.COLUMNS`).

    `with_cells` adds the H3 cell, the UTC day and the region flags.
    """
    dataset = ds.dataset(db / "detections", format="parquet", partitioning="hive")
    flt = None
    if platforms is not None:
        flt = ds.field("platform").isin(list(platforms))
    if start is not None:
        f = ds.field("year") >= start.year
        flt = f if flt is None else flt & f
    if end is not None:
        f = ds.field("year") <= end.year
        flt = f if flt is None else flt & f
    det = dataset.to_table(filter=flt).to_pandas()
    det["platform"] = det["platform"].astype(str)
    if start is not None:
        det = det[det["acq_datetime"] >= pd.Timestamp(start, tz="UTC")]
    if end is not None:
        det = det[det["acq_datetime"] < pd.Timestamp(end + timedelta(days=1), tz="UTC")]
    det = det.sort_values(["acq_datetime", "platform"], kind="stable").reset_index(drop=True)
    if with_cells:
        return det
    return det[firms.COLUMNS]
