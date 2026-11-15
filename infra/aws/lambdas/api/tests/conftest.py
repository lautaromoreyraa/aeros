"""Tiny Parquet files with the schema the model writes, built with DuckDB.

Cells A and B are neighbours inside the test area; C is far away and must never
show up. Values are picked so the expected calendar can be worked out by hand
(see test_calendar.py).
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import h3
import pytest

from aeros_api.store import Store

RESOLUTION = 4
CELL_A = h3.latlng_to_cell(-27.45, -58.98, RESOLUTION)
CELL_B = sorted(c for c in h3.grid_disk(CELL_A, 1) if c != CELL_A)[0]
CELL_C = h3.latlng_to_cell(-38.0, -63.0, RESOLUTION)

# (cell, week, month, harmonized_n, var, shared_sd, stacked_n, terra_n, aqua_n, source)
PANEL = [
    # 2000-01: before Terra's fire product, no information at all.
    (CELL_A, "2000-01-03", "2000-01-01", None, None, None, 0, 0, 0, "modeled_terra"),
    (CELL_B, "2000-01-03", "2000-01-01", None, None, None, 0, 0, 0, "modeled_terra"),
    # 2001-01: modeled; B has fire MODIS never saw (unattached).
    (CELL_A, "2001-01-01", "2001-01-01", 2.0, 1.0, 0.5, 1, 1, 0, "modeled_terra"),
    (CELL_B, "2001-01-01", "2001-01-01", 3.0, 3.0, 0.5, 0, 0, 0, "modeled_terra"),
    # 2001-02: one modeled, one observed week: a tie in the dominant source.
    (CELL_A, "2001-02-05", "2001-02-01", 1.0, 0.25, 0.0, 1, 1, 0, "modeled_terra"),
    (CELL_B, "2001-02-05", "2001-02-01", 2.0, 0.0, 0.0, 2, 0, 0, "observed"),
    # 2002-01 and 2003-01: VIIRS era, observed counts.
    (CELL_A, "2002-01-07", "2002-01-01", 10.0, 0.0, 0.0, 4, 2, 1, "observed"),
    (CELL_B, "2002-01-07", "2002-01-01", 0.0, 0.0, 0.0, 0, 0, 0, "observed"),
    (CELL_A, "2003-01-06", "2003-01-01", 4.0, 0.0, 0.0, 5, 2, 2, "observed"),
    (CELL_B, "2003-01-06", "2003-01-01", 2.0, 0.0, 0.0, 2, 1, 0, "observed"),
    # Outside the area: would wreck every number if it leaked in.
    (CELL_C, "2001-01-01", "2001-01-01", 100.0, 50.0, 5.0, 90, 80, 0, "modeled_terra"),
]

# (acq_datetime UTC, lat, lon, cell, platform, instrument, source, weight, is_vegetation)
HOTSPOTS = [
    ("2001-01-02 14:30:00", -27.451, -58.981, CELL_A, "TERRA", "MODIS", "modeled_terra", 2.0, True),
    ("2002-01-08 04:10:00", -27.452, -58.982, CELL_A, "SNPP", "VIIRS", "observed", 1.0, True),
    ("2002-01-08 04:10:00", -27.453, -58.983, CELL_A, "AQUA", "MODIS", "observed", 0.0, True),
    ("2003-01-31 23:59:00", -27.454, -58.984, CELL_B, "SNPP", "VIIRS", "observed", 1.0, False),
    ("2003-02-01 00:00:00", -27.455, -58.985, CELL_B, "SNPP", "VIIRS", "observed", 1.0, True),
    ("2002-01-08 04:10:00", -38.0, -63.0, CELL_C, "SNPP", "VIIRS", "observed", 1.0, True),
]


def _write_panel(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    con.execute(
        """
        CREATE TABLE panel (
            cell VARCHAR, week TIMESTAMP_NS, month TIMESTAMP_NS,
            harmonized_n DOUBLE, harmonized_var DOUBLE, harmonized_shared_sd DOUBLE,
            stacked_n DOUBLE, terra_n DOUBLE, aqua_n DOUBLE, harmonized_source VARCHAR,
            viirs_n DOUBLE, modeled_n DOUBLE, terra_on BOOLEAN, aqua_on BOOLEAN,
            reference_on BOOLEAN, year BIGINT
        )
        """
    )
    for cell, week, month, h, var, sd, stacked, terra, aqua, source in PANEL:
        con.execute(
            "INSERT INTO panel VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, true, true, ?, ?)",
            [
                cell,
                week,
                month,
                h,
                var,
                sd,
                stacked,
                terra,
                aqua,
                source,
                source == "observed",
                int(week[:4]),
            ],
        )
    con.execute(f"COPY panel TO '{path.as_posix()}' (FORMAT parquet)")


def _write_hotspots(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    con.execute(
        """
        CREATE TABLE hotspots (
            instrument VARCHAR, platform VARCHAR, latitude DOUBLE, longitude DOUBLE,
            acq_datetime TIMESTAMPTZ, solar_hour DOUBLE, daynight VARCHAR, frp DOUBLE,
            scan DOUBLE, track DOUBLE, confidence VARCHAR, type BIGINT,
            is_vegetation BOOLEAN, source_file VARCHAR, source_row BIGINT,
            cell VARCHAR, week TIMESTAMP_NS, harmonized_source VARCHAR,
            harmonized_weight DOUBLE
        )
        """
    )
    for i, (when, lat, lon, cell, platform, instrument, source, weight, veg) in enumerate(
        HOTSPOTS, start=1
    ):
        con.execute(
            "INSERT INTO hotspots VALUES (?, ?, ?, ?, ?::TIMESTAMPTZ, 12.0, 'D', 15.5, 1.0, "
            "1.0, 'n', ?, ?, 'fixture.csv', ?, ?, ?::TIMESTAMP, ?, ?)",
            [
                instrument,
                platform,
                lat,
                lon,
                when + "+00",
                0 if veg else 2,
                veg,
                i,
                cell,
                when[:10],
                source,
                weight,
            ],
        )
    con.execute(f"COPY hotspots TO '{path.as_posix()}' (FORMAT parquet)")


@pytest.fixture(scope="session")
def parquet_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("harmonized")
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    _write_panel(con, out / "harmonized_cells.parquet")
    _write_hotspots(con, out / "hotspots_harmonized.parquet")
    con.close()
    return out


@pytest.fixture
def store(parquet_dir: Path) -> Store:
    con = duckdb.connect(config={"timezone": "UTC"})
    return Store(
        (parquet_dir / "harmonized_cells.parquet").as_posix(),
        (parquet_dir / "hotspots_harmonized.parquet").as_posix(),
        con,
    )


def area_around(*cells: str, pad: float = 0.05) -> dict:
    """Small polygon around the centers of `cells` (GeoJSON order: lon, lat)."""
    centers = [h3.cell_to_latlng(c) for c in cells]
    lats = [lat for lat, _ in centers]
    lons = [lon for _, lon in centers]
    west, east = min(lons) - pad, max(lons) + pad
    south, north = min(lats) - pad, max(lats) + pad
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    return {"type": "Polygon", "coordinates": [ring]}


def event(path: str, body: dict | str | None, method: str = "POST") -> dict:
    return {
        "version": "2.0",
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": body if body is None or isinstance(body, str) else json.dumps(body),
        "isBase64Encoded": False,
    }
