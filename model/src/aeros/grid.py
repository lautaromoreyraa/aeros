"""Spatial and temporal binning.

Space: H3 hexagons. Resolution 4 (~1,770 km², ~22 km edge) is larger than the
biggest MODIS footprint at the swath edge (~4.8 km x 2 km), so pixel size does
not dominate a cell count, and it matches the hexagon layer drawn by the web map.

Time: ISO weeks. A week belongs to the calendar month that contains its
Thursday, the same rule ISO 8601 uses to assign weeks to years.
"""

from __future__ import annotations

from collections.abc import Iterable

import h3
import numpy as np
import pandas as pd

DEFAULT_RESOLUTION = 4


def cells_for(
    latitudes: Iterable[float], longitudes: Iterable[float], resolution: int
) -> np.ndarray:
    return np.array(
        [
            h3.latlng_to_cell(lat, lon, resolution)
            for lat, lon in zip(latitudes, longitudes, strict=True)
        ],
        dtype=object,
    )


def week_start(timestamps: pd.Series) -> pd.Series:
    """Monday 00:00 UTC of the ISO week, as a timezone-naive date."""
    days = timestamps.dt.tz_convert("UTC").dt.tz_localize(None).dt.normalize()
    return days - pd.to_timedelta(days.dt.day_of_week, unit="D")


def week_month(week_starts: pd.Series) -> pd.Series:
    """Calendar month (first day) that owns the week: the month of its Thursday."""
    thursday = week_starts + pd.Timedelta(days=3)
    return thursday.dt.to_period("M").dt.to_timestamp()


def neighbors(cell: str) -> list[str]:
    return [c for c in h3.grid_disk(cell, 1) if c != cell]


def region_of(cell: str, resolution: int = 1) -> str:
    """Coarse parent cell, used to hold out whole regions during validation."""
    return h3.cell_to_parent(cell, resolution)


def cells_in_polygon(lonlat_ring: list[tuple[float, float]], resolution: int) -> set[str]:
    """H3 cells whose centers fall inside a polygon given as (lon, lat) pairs."""
    polygon = h3.LatLngPoly([(lat, lon) for lon, lat in lonlat_ring])
    return set(h3.polygon_to_cells(polygon, resolution))


def cells_in_bbox(
    west: float, south: float, east: float, north: float, resolution: int
) -> set[str]:
    ring = [(west, south), (east, south), (east, north), (west, north), (west, south)]
    return cells_in_polygon(ring, resolution)
