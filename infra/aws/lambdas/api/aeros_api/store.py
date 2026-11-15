"""DuckDB over the Parquet files the pipeline writes.

`harmonized_cells.parquet` (one row per cell-week, from
`aeros.harmonize.harmonize_panel`) feeds the calendar; columns used:
cell, month, harmonized_n, harmonized_var, harmonized_shared_sd, stacked_n,
terra_n, aqua_n, harmonized_source.

`hotspots_harmonized.parquet` (one row per FIRMS detection, from
`aeros.harmonize.hotspot_weights`) feeds the CSV.

Only the named columns are read and the area's cells are joined in, so DuckDB
fetches the matching row groups instead of the whole object.
"""

from __future__ import annotations

import os
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

import duckdb
import h3


@dataclass(frozen=True)
class MonthSourceRow:
    """Sums for one (month, harmonized_source) pair inside the area."""

    month: str  # YYYY-MM
    source: str
    weeks: int
    harmonized: float | None
    variance: float | None
    shared_sd: float | None
    stacked_raw: float
    unattached: float


HOTSPOT_COLUMNS = (
    "acq_datetime",
    "latitude",
    "longitude",
    "instrument",
    "platform",
    "daynight",
    "frp",
    "confidence",
    "type",
    "is_vegetation",
    "cell",
    "harmonized_source",
    "harmonized_weight",
)


class Store:
    def __init__(self, cells_uri: str, hotspots_uri: str, connection: duckdb.DuckDBPyConnection):
        self.cells_uri = cells_uri
        self.hotspots_uri = hotspots_uri
        self.con = connection
        self._resolution: int | None = None

    @classmethod
    def from_environment(cls) -> Store:
        bucket = os.environ["DATA_BUCKET"]
        con = duckdb.connect(config=_lambda_config())
        _configure_s3(con)
        return cls(
            f"s3://{bucket}/{os.environ['CELLS_KEY']}",
            f"s3://{bucket}/{os.environ['HOTSPOTS_KEY']}",
            con,
        )

    def resolution(self) -> int:
        """H3 resolution of the panel, read once from the data itself."""
        if self._resolution is None:
            row = self.con.execute(
                "SELECT cell FROM read_parquet(?) LIMIT 1", [self.cells_uri]
            ).fetchone()
            if row is None:
                raise LookupError("harmonized_cells.parquet is empty")
            self._resolution = h3.get_resolution(row[0])
        return self._resolution

    def _area(self, cells: Sequence[str]) -> None:
        self.con.execute("CREATE OR REPLACE TEMP TABLE area (cell VARCHAR PRIMARY KEY)")
        self.con.executemany("INSERT INTO area VALUES (?)", [[c] for c in cells])

    def monthly_by_source(self, cells: Sequence[str]) -> list[MonthSourceRow]:
        """Every month on record for the area; the caller trims to the range.

        All years are needed anyway: the anomaly compares each month with the
        same calendar month of every other year.
        """
        self._area(cells)
        rows = self.con.execute(
            """
            SELECT strftime(p.month, '%Y-%m') AS month,
                   p.harmonized_source,
                   count(*),
                   sum(p.harmonized_n),
                   sum(p.harmonized_var),
                   sum(p.harmonized_shared_sd),
                   coalesce(sum(p.stacked_n), 0),
                   -- Same rule as aeros.harmonize.unattached: modeled fire in
                   -- cell-weeks where MODIS saw nothing to carry it.
                   coalesce(sum(CASE
                       WHEN p.terra_n + p.aqua_n = 0 AND p.harmonized_source <> 'observed'
                       THEN coalesce(p.harmonized_n, 0) ELSE 0 END), 0)
            FROM read_parquet(?) AS p
            JOIN area USING (cell)
            GROUP BY ALL
            ORDER BY 1, 2
            """,
            [self.cells_uri],
        ).fetchall()
        return [
            MonthSourceRow(
                month=r[0],
                source=r[1],
                weeks=int(r[2]),
                harmonized=_float(r[3]),
                variance=_float(r[4]),
                shared_sd=_float(r[5]),
                stacked_raw=float(r[6]),
                unattached=float(r[7]),
            )
            for r in rows
        ]

    def hotspots(self, cells: Sequence[str], start: date, end: date, limit: int) -> Iterator[tuple]:
        """Detections in the area between start and end (inclusive), by time."""
        self._area(cells)
        columns = ", ".join(
            "strftime(timezone('UTC', p.acq_datetime), '%Y-%m-%dT%H:%M:%SZ')"
            if c == "acq_datetime"
            else f"p.{c}"
            for c in HOTSPOT_COLUMNS
        )
        cursor = self.con.execute(
            f"""
            SELECT {columns}
            FROM read_parquet(?) AS p
            JOIN area USING (cell)
            WHERE p.acq_datetime >= ?::TIMESTAMPTZ AND p.acq_datetime < ?::TIMESTAMPTZ
            ORDER BY p.acq_datetime, p.latitude, p.longitude
            LIMIT ?
            """,
            [
                self.hotspots_uri,
                f"{start.isoformat()} 00:00:00+00",
                f"{(end + timedelta(days=1)).isoformat()} 00:00:00+00",
                limit,
            ],
        )
        while batch := cursor.fetchmany(2048):
            yield from batch


def _float(value) -> float | None:
    return None if value is None else float(value)


def _lambda_config() -> dict:
    # Lambda only lets us write to /tmp. DuckDB gets 60 % of the function's
    # memory so a large scan spills to disk instead of killing the runtime.
    memory_mb = int(os.environ.get("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "512"))
    return {
        "home_directory": "/tmp",
        "temp_directory": "/tmp/duckdb",
        "memory_limit": f"{int(memory_mb * 0.6)}MB",
        "autoinstall_known_extensions": False,
        "timezone": "UTC",
    }


def _configure_s3(con: duckdb.DuckDBPyConnection) -> None:
    """Load httpfs from the layer and hand DuckDB the execution role's credentials."""
    extension = os.environ.get("DUCKDB_HTTPFS", "/opt/duckdb/httpfs.duckdb_extension")
    con.execute(f"LOAD {_quote(extension)}")
    fields = {
        "KEY_ID": os.environ["AWS_ACCESS_KEY_ID"],
        "SECRET": os.environ["AWS_SECRET_ACCESS_KEY"],
        "REGION": os.environ["AWS_REGION"],
    }
    token = os.environ.get("AWS_SESSION_TOKEN")
    if token:
        fields["SESSION_TOKEN"] = token
    # CREATE SECRET takes no bound parameters; values are quoted by hand.
    options = ", ".join(f"{k} {_quote(v)}" for k, v in fields.items())
    con.execute(f"CREATE OR REPLACE SECRET aeros_s3 (TYPE s3, {options})")


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
