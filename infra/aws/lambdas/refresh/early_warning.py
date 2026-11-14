"""Early warning: is the last week burning more than usual, region-wide and per cell?

Observed: VIIRS NRT vegetation hotspots of the last complete days. One satellite
per day, NOAA-20 first and NOAA-21 when NOAA-20 has nothing: the harmonized
series counts what one VIIRS sees, and adding both would roughly double it.
Suomi NPP is not used (its data stopped on 2026-11-02).

A day where no VIIRS source returned a single detection for the whole region
is a `gap` (outage or delayed processing), never a zero: it is left out of both
the observed and the expected counts, so a gap cannot look like a quiet week.

NRT files carry no `type` column, so static sources are removed by cell: every
cell where the archive ever had a non-vegetation detection (type 1, 2 or 3:
volcano, static industrial source, offshore) is masked on both sides.

Expected: from the harmonized panel, the same calendar days in every past year.
A cell-week count spreads evenly over its seven days, each data day takes 1/7
of its week, and the expected value is the median over past years, so one
extreme season does not raise the bar for every later one.

Flag: one-sided Poisson test, P(X >= observed | expected) < 0.01. A median of
zero is common for cells that burn every few years, and a Poisson rate of zero
would flag a single detection; the test uses at least EXPECTED_FLOOR instead.
"""

from __future__ import annotations

import csv
import io
import math
import os
import statistics
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

VIIRS_PREFERENCE = ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")
SATELLITE_NAME = {"VIIRS_NOAA20_NRT": "NOAA-20", "VIIRS_NOAA21_NRT": "NOAA-21"}
ALPHA = 0.01
EXPECTED_FLOOR = 0.5
WINDOW_DAYS = 7


@dataclass(frozen=True)
class Day:
    day: date
    status: str  # "ok" | "gap"
    source: str | None = None
    points: tuple[tuple[float, float], ...] = field(default=())


@dataclass(frozen=True)
class Climatology:
    resolution: int
    static_cells: frozenset[str]
    # Past years by offset (1 = last year): VIIRS-equivalent hotspots per cell
    # over the same calendar days as the observed data days.
    years: tuple[int, ...]
    by_cell: Mapping[str, Mapping[int, float]]


def window(today: date, days: int = WINDOW_DAYS) -> list[date]:
    """The last `days` complete UTC days; today is still filling up."""
    return [today - timedelta(days=n) for n in range(days, 0, -1)]


def pick_days(
    downloads: Mapping[tuple[str, date], bytes | None], days: Iterable[date]
) -> list[Day]:
    out = []
    for day in days:
        chosen = None
        for source in VIIRS_PREFERENCE:
            points = _points(downloads.get((source, day)))
            if points:
                chosen = Day(day, "ok", source, points)
                break
        out.append(chosen or Day(day, "gap"))
    return out


def _points(body: bytes | None) -> tuple[tuple[float, float], ...]:
    if not body:
        return ()
    reader = csv.DictReader(io.StringIO(body.decode("utf-8-sig")))
    return tuple((float(r["latitude"]), float(r["longitude"])) for r in reader)


def poisson_sf(k: int, lam: float) -> float:
    """P(X >= k) for X ~ Poisson(lam), summing whichever tail is shorter."""
    if k <= 0:
        return 1.0
    if lam <= 0:
        return 0.0
    log_pmf = -lam + k * math.log(lam) - math.lgamma(k + 1)
    if k > lam:
        # Upper tail: terms shrink from k on, so it converges fast and stays
        # accurate for the tiny p-values that matter here.
        total, term, i = 0.0, math.exp(log_pmf), k
        while term > 0.0 and term > total * 1e-17:
            total += term
            i += 1
            term *= lam / i
        return min(total, 1.0)
    lower, term = 0.0, math.exp(-lam)
    for i in range(k):
        lower += term
        term *= lam / (i + 1)
    return max(1.0 - lower, 0.0)


def build_report(days: list[Day], clim: Climatology | None, generated_at: datetime) -> dict:
    data_days = [d for d in days if d.status == "ok"]
    report = {
        "generated_at": generated_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": [days[0].day.isoformat(), days[-1].day.isoformat()],
        "days_with_data": [d.day.isoformat() for d in data_days],
        "gap_days": [d.day.isoformat() for d in days if d.status == "gap"],
        "days": [
            {
                "date": d.day.isoformat(),
                "status": d.status,
                "satellite": SATELLITE_NAME.get(d.source or ""),
                "detections": len(d.points) if d.status == "ok" else None,
            }
            for d in days
        ],
        "method": {
            "unit": "VIIRS-equivalent hotspots",
            "expected": "median over past years of the same calendar days",
            "test": "one-sided Poisson, P(X >= observed | expected)",
            "alpha": ALPHA,
            "expected_floor": EXPECTED_FLOOR,
            "past_years": list(clim.years) if clim else [],
        },
        "region": None,
        "cells": [],
    }
    if not data_days or clim is None or not clim.years:
        return report

    import h3

    observed = Counter(
        h3.latlng_to_cell(lat, lon, clim.resolution) for d in data_days for lat, lon in d.points
    )
    for cell in clim.static_cells:
        observed.pop(cell, None)

    region_by_year = [
        math.fsum(per_year.get(year, 0.0) for per_year in clim.by_cell.values())
        for year in clim.years
    ]
    report["region"] = _score(sum(observed.values()), statistics.median(region_by_year))

    flagged = []
    for cell, count in observed.items():
        history = clim.by_cell.get(cell, {})
        scored = _score(count, statistics.median(history.get(y, 0.0) for y in clim.years))
        if scored["p_value"] < ALPHA and count > scored["expected"]:
            flagged.append({"cell": cell, **scored})
    report["cells"] = sorted(flagged, key=lambda c: (c["p_value"], -c["observed"], c["cell"]))
    return report


def _score(observed: int, expected: float) -> dict:
    p = poisson_sf(observed, max(expected, EXPECTED_FLOOR))
    return {
        "observed": observed,
        "expected": round(expected, 3),
        "ratio": round(observed / expected, 3) if expected > 0 else None,
        "p_value": float(f"{p:.4g}"),
    }


def _same_day(day: date, years_back: int) -> date:
    try:
        return day.replace(year=day.year - years_back)
    except ValueError:  # 29 February in a non-leap year
        return day.replace(year=day.year - years_back, day=28)


def load_climatology(con, cells_uri: str, hotspots_uri: str, data_days: list[date]) -> Climatology:
    """Read the harmonized panel and the archive mask with DuckDB."""
    first = con.execute("SELECT cell FROM read_parquet(?) LIMIT 1", [cells_uri]).fetchone()
    if first is None:
        raise LookupError("harmonized_cells.parquet is empty")
    import h3

    resolution = h3.get_resolution(first[0])
    static = frozenset(
        r[0]
        for r in con.execute(
            "SELECT DISTINCT cell FROM read_parquet(?) WHERE type <> 0", [hotspots_uri]
        ).fetchall()
    )
    if not data_days:
        return Climatology(resolution, static, (), {})

    oldest = con.execute(
        "SELECT min(week) FROM read_parquet(?) WHERE harmonized_n IS NOT NULL", [cells_uri]
    ).fetchone()[0]
    newest_back = max(d.year for d in data_days) - oldest.year if oldest else 0
    rows = []
    for back in range(1, newest_back + 1):
        for d in data_days:
            shifted = _same_day(d, back)
            rows.append((back, shifted - timedelta(days=shifted.weekday())))
    con.execute("CREATE OR REPLACE TEMP TABLE clim_days (back INTEGER, week TIMESTAMP)")
    con.executemany("INSERT INTO clim_days VALUES (?, ?)", rows)

    # A past year counts only if every data day falls in a week the panel
    # covers with a value; partial years would drag the median down.
    years = tuple(
        r[0]
        for r in con.execute(
            """
            SELECT d.back
            FROM clim_days d
            JOIN (SELECT DISTINCT week::TIMESTAMP AS week FROM read_parquet(?)
                  WHERE harmonized_n IS NOT NULL) w USING (week)
            GROUP BY d.back
            HAVING count(*) = ?
            ORDER BY d.back
            """,
            [cells_uri, len(data_days)],
        ).fetchall()
    )
    by_cell: dict[str, dict[int, float]] = {}
    if years:
        for cell, back, value in con.execute(
            """
            SELECT p.cell, d.back, sum(p.harmonized_n) / 7.0
            FROM read_parquet(?) AS p
            JOIN clim_days d ON p.week::TIMESTAMP = d.week
            WHERE d.back IN (SELECT unnest(?::INTEGER[]))
            GROUP BY ALL
            HAVING sum(p.harmonized_n) > 0
            """,
            [cells_uri, list(years)],
        ).fetchall():
            if cell not in static:
                by_cell.setdefault(cell, {})[int(back)] = float(value)
    return Climatology(resolution, static, years, by_cell)


def open_connection():
    """DuckDB on Lambda: /tmp only, httpfs from the layer, the role's credentials."""
    import duckdb

    memory_mb = int(os.environ.get("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "512"))
    con = duckdb.connect(
        config={
            "home_directory": "/tmp",
            "temp_directory": "/tmp/duckdb",
            "memory_limit": f"{int(memory_mb * 0.6)}MB",
            "autoinstall_known_extensions": False,
            "timezone": "UTC",
        }
    )
    extension = os.environ.get("DUCKDB_HTTPFS", "/opt/duckdb/httpfs.duckdb_extension")
    con.execute(f"LOAD {_quote(extension)}")
    fields = {
        "KEY_ID": os.environ["AWS_ACCESS_KEY_ID"],
        "SECRET": os.environ["AWS_SECRET_ACCESS_KEY"],
        "REGION": os.environ["AWS_REGION"],
    }
    if os.environ.get("AWS_SESSION_TOKEN"):
        fields["SESSION_TOKEN"] = os.environ["AWS_SESSION_TOKEN"]
    options = ", ".join(f"{k} {_quote(v)}" for k, v in fields.items())
    con.execute(f"CREATE OR REPLACE SECRET aeros_s3 (TYPE s3, {options})")
    return con


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
