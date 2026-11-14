# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2.0", "pyshp>=2.3"]
# ///
"""Build the study region outlines shipped in `aeros/regions/`.

Sources (downloaded by hand, never committed):

* RESOLVE Ecoregions 2017 (CC-BY 4.0), https://storage.googleapis.com/teow2016/Ecoregions2017.zip
  Gran Chaco = Dry Chaco + Humid Chaco.
* geoBoundaries gbOpen ARG ADM1 (CC BY 2.5) for Corrientes and PRY ADM0
  (CC BY 4.0) for Paraguay, simplified releases from https://www.geoboundaries.org.

Outlines are simplified to about 1 km and rounded to 4 decimals: the pipeline
only uses them to pick H3 resolution-4 cells (~22 km edge), so finer detail
changes nothing and would only bloat the package.

    uv run model/scripts/build_regions.py data/boundaries model/src/aeros/regions
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import shapefile
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

TOLERANCE_DEG = 0.01


def _ecoregions(path: Path, names: set[str]):
    reader = shapefile.Reader(str(path), encoding="latin1")
    return [
        shape(sr.shape.__geo_interface__)
        for sr in reader.iterShapeRecords()
        if sr.record["ECO_NAME"] in names
    ]


def _boundaries(path: Path, names: set[str] | None = None):
    features = json.loads(path.read_text())["features"]
    return [
        shape(f["geometry"])
        for f in features
        if names is None or f["properties"]["shapeName"] in names
    ]


def _rounded(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 4), round(coords[1], 4)]
    return [_rounded(c) for c in coords]


def _feature(region_id: str, name: str, source: str, license_: str, parts) -> dict:
    geometry = unary_union(parts).simplify(TOLERANCE_DEG, preserve_topology=True)
    geo = mapping(geometry)
    return {
        "type": "Feature",
        "properties": {"id": region_id, "name": name, "source": source, "license": license_},
        "geometry": {"type": geo["type"], "coordinates": _rounded(geo["coordinates"])},
    }


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    regions = [
        _feature(
            "gran-chaco",
            "Gran Chaco",
            "RESOLVE Ecoregions 2017: Dry Chaco + Humid Chaco",
            "CC-BY 4.0",
            _ecoregions(src / "eco" / "Ecoregions2017.shp", {"Dry Chaco", "Humid Chaco"}),
        ),
        _feature(
            "corrientes",
            "Corrientes",
            "geoBoundaries gbOpen ARG ADM1 (simplified)",
            "CC BY 2.5",
            _boundaries(src / "arg_adm1.geojson", {"Corrientes"}),
        ),
        _feature(
            "paraguay",
            "Paraguay",
            "geoBoundaries gbOpen PRY ADM0 (simplified)",
            "CC BY 4.0",
            _boundaries(src / "pry_adm0.geojson"),
        ),
    ]
    for feature in regions:
        path = out / f"{feature['properties']['id']}.geojson"
        path.write_text(json.dumps(feature, separators=(",", ":")) + "\n")
        print(path, path.stat().st_size)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
