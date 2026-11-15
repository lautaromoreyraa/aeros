"""Study regions: named outlines that select the H3 cells a run reports on.

A region is the set of grid cells whose center falls inside its outline, so a
region calendar is always the exact sum of the cells drawn on the map. The
outlines are built by `model/scripts/build_regions.py` from public sources
named in each file.

FIRMS country files cover whole countries, so a run first clips detections to
the union of the requested regions plus one ring of neighbor cells: the ring
keeps the neighbor features of border cells honest, and every region is then
reported from the same fitted translator.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cache
from importlib import resources

import h3
import numpy as np
import pandas as pd

from aeros import grid

REGION_IDS = ("gran-chaco", "corrientes", "paraguay")


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    source: str
    license: str
    geometry: dict

    def cells(self, resolution: int) -> frozenset[str]:
        return _cells(self.id, resolution)

    def bounds(self) -> tuple[float, float, float, float]:
        """West, south, east, north of the outline, in degrees."""
        points = np.array(list(_points(self.geometry["coordinates"])))
        return (
            float(points[:, 0].min()),
            float(points[:, 1].min()),
            float(points[:, 0].max()),
            float(points[:, 1].max()),
        )

    def describe(self) -> dict:
        return {"id": self.id, "name": self.name, "source": self.source, "license": self.license}


def _points(coords):
    if isinstance(coords[0], (int, float)):
        yield coords
        return
    for c in coords:
        yield from _points(c)


@cache
def load(region_id: str) -> Region:
    if region_id not in REGION_IDS:
        raise ValueError(f"unknown region {region_id!r}, expected one of {REGION_IDS}")
    text = resources.files(__package__).joinpath(f"{region_id}.geojson").read_text()
    feature = json.loads(text)
    p = feature["properties"]
    return Region(p["id"], p["name"], p["source"], p["license"], feature["geometry"])


@cache
def _cells(region_id: str, resolution: int) -> frozenset[str]:
    return frozenset(h3.geo_to_cells(load(region_id).geometry, resolution))


def parse(ids: str) -> list[Region]:
    """Comma-separated ids, or `all`."""
    names = REGION_IDS if ids == "all" else [i.strip() for i in ids.split(",") if i.strip()]
    return [load(i) for i in names]


def clip(detections: pd.DataFrame, regions: Iterable[Region], resolution: int) -> pd.DataFrame:
    """Detections inside the regions or one cell around them, with their `cell`."""
    regions = list(regions)
    if not regions:
        raise ValueError("clip needs at least one region")
    bounds = np.array([r.bounds() for r in regions])
    west, south = bounds[:, :2].min(axis=0)
    east, north = bounds[:, 2:].max(axis=0)
    # A cheap box test first: country files are mostly outside every region,
    # and the per-row H3 lookup is the slow part. One degree of margin covers
    # the neighbor ring (a resolution-4 cell is ~0.4 degrees across).
    box = detections["longitude"].between(west - 1, east + 1) & detections["latitude"].between(
        south - 1, north + 1
    )
    det = detections[box].copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    keep: set[str] = set()
    for cell in frozenset().union(*(r.cells(resolution) for r in regions)):
        keep.update(h3.grid_disk(cell, 1))
    return det[det["cell"].isin(keep)].reset_index(drop=True)


def in_region(frame: pd.DataFrame, region: Region, resolution: int) -> pd.Series:
    return frame["cell"].isin(region.cells(resolution))
