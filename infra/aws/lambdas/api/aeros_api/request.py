"""Parse and validate the JSON body shared by both routes.

Body::

    {
      "area":  GeoJSON Polygon, MultiPolygon, or a Feature wrapping one,
      "start": "YYYY-MM" or "YYYY-MM-DD",
      "end":   "YYYY-MM" or "YYYY-MM-DD"   (inclusive)
    }

A month-only `end` means the last day of that month, so "2003-01".."2024-12"
reads as the user meant it.
"""

from __future__ import annotations

import calendar
import json
import re
from dataclasses import dataclass
from datetime import date

MAX_BODY_BYTES = 256 * 1024
MAX_VERTICES = 10_000
_DATE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$")


class BadRequest(ValueError):
    """The client sent something we will not run; the message goes back as is."""


@dataclass(frozen=True)
class AreaQuery:
    geometry: dict
    start: date
    end: date


def parse(body: str | bytes | None) -> AreaQuery:
    if not body:
        raise BadRequest("request body is required")
    if len(body) > MAX_BODY_BYTES:
        raise BadRequest(f"request body exceeds {MAX_BODY_BYTES} bytes")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise BadRequest("request body is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise BadRequest("request body must be a JSON object")

    geometry = _geometry(payload.get("area"))
    start = _date(payload.get("start"), "start", end_of_month=False)
    end = _date(payload.get("end"), "end", end_of_month=True)
    if start > end:
        raise BadRequest("start must not be after end")
    return AreaQuery(geometry=geometry, start=start, end=end)


def _geometry(area: object) -> dict:
    if not isinstance(area, dict):
        raise BadRequest("area must be a GeoJSON Polygon, MultiPolygon or Feature")
    if area.get("type") == "Feature":
        area = area.get("geometry")
        if not isinstance(area, dict):
            raise BadRequest("area Feature has no geometry")
    kind = area.get("type")
    coordinates = area.get("coordinates")
    if kind == "Polygon":
        polygons = [coordinates]
    elif kind == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise BadRequest("MultiPolygon needs at least one polygon")
        polygons = coordinates
    else:
        raise BadRequest("area must be a GeoJSON Polygon or MultiPolygon")

    clean = [_polygon(p) for p in polygons]
    if sum(len(ring) for polygon in clean for ring in polygon) > MAX_VERTICES:
        raise BadRequest(f"area has more than {MAX_VERTICES} vertices")
    # Rebuilt from validated numbers only: nothing else from the client
    # reaches the geometry library.
    if kind == "Polygon":
        return {"type": "Polygon", "coordinates": clean[0]}
    return {"type": "MultiPolygon", "coordinates": clean}


def _polygon(rings: object) -> list[list[list[float]]]:
    if not isinstance(rings, list) or not rings:
        raise BadRequest("a polygon needs at least one ring")
    return [_ring(r) for r in rings]


def _ring(ring: object) -> list[list[float]]:
    if not isinstance(ring, list) or len(ring) < 4:
        raise BadRequest("a polygon ring needs at least four positions")
    out = []
    for position in ring:
        if (
            not isinstance(position, list | tuple)
            or len(position) < 2
            or not all(_is_number(v) for v in position[:2])
        ):
            raise BadRequest("positions must be [longitude, latitude] numbers")
        lon, lat = float(position[0]), float(position[1])
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            raise BadRequest("position outside longitude/latitude bounds")
        out.append([lon, lat])
    if out[0] != out[-1]:
        raise BadRequest("a polygon ring must be closed (first position equals last)")
    return out


def _is_number(value: object) -> bool:
    # bool is an int subclass; true/false are not coordinates.
    return isinstance(value, int | float) and not isinstance(value, bool) and value == value


def _date(value: object, name: str, end_of_month: bool) -> date:
    if not isinstance(value, str):
        raise BadRequest(f"{name} must be a string in YYYY-MM or YYYY-MM-DD form")
    match = _DATE.match(value)
    if not match:
        raise BadRequest(f"{name} must be in YYYY-MM or YYYY-MM-DD form")
    year, month = int(match[1]), int(match[2])
    try:
        if match[3] is not None:
            return date(year, month, int(match[3]))
        day = calendar.monthrange(year, month)[1] if end_of_month else 1
        return date(year, month, day)
    except ValueError as exc:
        raise BadRequest(f"{name} is not a valid date") from exc
