"""Dashboard sectors: the Gran Chaco split by country and ecoregion.

Each sector is a RESOLVE ecoregion (Dry or Humid Chaco) intersected with a
country, so it has one government responsible for it and one fire regime. The
outlines are built by `model/scripts/build_regions.py` and, like the study
regions, a sector is the set of H3 cells whose center falls inside its outline.

Sectors are cut from the Gran Chaco region's own cells: a cell belongs to at
most one sector, and the sectors' calendars add up to the region calendar
except for the cells whose center falls just outside every simplified sector
outline (a thin seam along borders and Brazil's sliver of the Chaco).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cache
from importlib import resources

import h3

SECTOR_IDS = ("bolivian-chaco", "chaco-boreal", "dry-chaco", "humid-chaco")
PARENT_REGION = "gran-chaco"


@dataclass(frozen=True)
class Sector:
    id: str
    name: str
    place: str
    source: str
    license: str
    geometry: dict


@cache
def load(sector_id: str) -> Sector:
    if sector_id not in SECTOR_IDS:
        raise ValueError(f"unknown sector {sector_id!r}, expected one of {SECTOR_IDS}")
    feature = json.loads(resources.files(__package__).joinpath(f"{sector_id}.geojson").read_text())
    p = feature["properties"]
    return Sector(p["id"], p["name"], p["place"], p["source"], p["license"], feature["geometry"])


@cache
def _cells(sector_id: str, resolution: int) -> frozenset[str]:
    return frozenset(h3.geo_to_cells(load(sector_id).geometry, resolution))


def assign(region_cells: Iterable[str], resolution: int) -> dict[str, list[str]]:
    """Sector id -> sorted region cells inside it; every cell lands in at most one.

    Simplified outlines can touch along a border, so a cell claimed by two
    sectors goes to the first in `SECTOR_IDS` and is never counted twice.
    """
    remaining = set(region_cells)
    out: dict[str, list[str]] = {}
    for sector_id in SECTOR_IDS:
        mine = remaining & _cells(sector_id, resolution)
        remaining -= mine
        out[sector_id] = sorted(mine)
    return out


def payload(region_cells: Iterable[str], resolution: int) -> list[dict]:
    """The `sectors.json` contract the web reads: id, name, place, cells, provenance."""
    cells = assign(region_cells, resolution)
    result = []
    for sector_id in SECTOR_IDS:
        if not cells[sector_id]:
            continue
        s = load(sector_id)
        result.append(
            {
                "id": s.id,
                "name": s.name,
                "place": s.place,
                "cells": cells[sector_id],
                "source": s.source,
                "license": s.license,
            }
        )
    return result
