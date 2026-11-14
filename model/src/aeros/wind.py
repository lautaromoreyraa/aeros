"""Wind field for the interface's wind layer and for the alert's risk zone.

A regular grid over the study area, hourly for the next two days, from the
Open-Meteo forecast API: no key, many locations in one request, CC BY 4.0.
It is written as `wind.json`, the file the web draws particles from and the
alert reads to find which way a fire's smoke and spread travel.

Open-Meteo reports the wind the way weather services do: speed, and the
direction it blows FROM, clockwise from north. The interface wants the two
components of the motion itself, so a wind from the west (270 degrees) is a
positive `u`: eastward. Rows run from north to south, like an image.

This is a forecast, not a record: it never enters the harmonized series.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

API_URL = "https://api.open-meteo.com/v1/forecast"
SOURCE = "Open-Meteo forecast API (CC BY 4.0), 10 m wind"
# One request carries this many locations at most: the URL stays short and
# each call stays light for a free service.
LOCATIONS_PER_REQUEST = 100
# Open-Meteo answers null where a model has no value. A few holes are zeros in
# the layer; a field that is mostly holes is not a wind field.
MAX_MISSING_SHARE = 0.05
MAX_FORECAST_DAYS = 16

Fetch = Callable[[str], object]


class WindError(RuntimeError):
    pass


@dataclass(frozen=True)
class Grid:
    west: float
    south: float
    east: float
    north: float
    nx: int
    ny: int

    def points(self) -> list[tuple[float, float]]:
        """(latitude, longitude) of every node, row-major, north to south."""
        lats = [self.north - j * (self.north - self.south) / (self.ny - 1) for j in range(self.ny)]
        lons = [self.west + i * (self.east - self.west) / (self.nx - 1) for i in range(self.nx)]
        return [(lat, lon) for lat in lats for lon in lons]

    def describe(self) -> dict:
        return {
            "west": self.west,
            "south": self.south,
            "east": self.east,
            "north": self.north,
            "nx": self.nx,
            "ny": self.ny,
        }


def parse_area(text: str) -> tuple[float, float, float, float]:
    """`west,south,east,north` in degrees."""
    try:
        west, south, east, north = (float(v) for v in text.replace(" ", "").split(","))
    except ValueError:
        raise ValueError(f'area must be "west,south,east,north", got {text!r}') from None
    if not (west < east and south < north):
        raise ValueError(f"area must have west < east and south < north, got {text!r}")
    return west, south, east, north


def to_components(speed: float, direction_from: float) -> tuple[float, float]:
    """(u, v) of the motion, in the unit of `speed`: u eastward, v northward."""
    radians = math.radians(direction_from)
    return -speed * math.sin(radians), -speed * math.cos(radians)


def _get_json(url: str) -> object:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read())


def _request_url(points: list[tuple[float, float]], days: int) -> str:
    query = {
        "latitude": ",".join(f"{lat:.4f}" for lat, _ in points),
        "longitude": ",".join(f"{lon:.4f}" for _, lon in points),
        "hourly": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        "forecast_days": str(days),
    }
    # Commas separate the coordinates; they must not be escaped.
    return f"{API_URL}?{urllib.parse.urlencode(query, safe=',')}"


def _locations(payload: object, expected: int) -> list[dict]:
    """One entry per requested location; a single location comes back unwrapped."""
    found = payload if isinstance(payload, list) else [payload]
    if len(found) != expected or not all(isinstance(item, dict) for item in found):
        raise WindError(f"Open-Meteo returned {len(found)} locations for {expected} requested")
    return found


def build(
    area: tuple[float, float, float, float],
    nx: int,
    ny: int,
    hours: int,
    now: datetime,
    fetch: Fetch | None = None,
) -> dict:
    """The `wind.json` payload: `hours` hourly fields from the current UTC hour."""
    if nx < 2 or ny < 2 or hours < 1:
        raise ValueError("the grid needs at least 2 x 2 nodes and 1 hour")
    fetch = fetch or _get_json
    grid = Grid(*area, nx=nx, ny=ny)
    points = grid.points()
    start = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    days = math.ceil((start.hour + hours) / 24)
    if days > MAX_FORECAST_DAYS:
        raise ValueError(f"{hours} hours do not fit in {MAX_FORECAST_DAYS} forecast days")

    speeds: list[list[float | None]] = []
    directions: list[list[float | None]] = []
    first = start.strftime("%Y-%m-%dT%H:%M")
    offset: int | None = None
    for i in range(0, len(points), LOCATIONS_PER_REQUEST):
        chunk = points[i : i + LOCATIONS_PER_REQUEST]
        for location in _locations(fetch(_request_url(chunk, days)), len(chunk)):
            hourly = location["hourly"]
            times = hourly["time"]
            if first not in times:
                raise WindError(f"Open-Meteo has no field for {first}")
            # Every location shares one time axis; the first one fixes where to start.
            offset = times.index(first) if offset is None else offset
            speeds.append(hourly["wind_speed_10m"][offset : offset + hours])
            directions.append(hourly["wind_direction_10m"][offset : offset + hours])

    u: list[list[float]] = []
    v: list[list[float]] = []
    missing = 0
    for h in range(hours):
        row_u: list[float] = []
        row_v: list[float] = []
        for speed, direction in zip(speeds, directions, strict=True):
            if h >= len(speed) or speed[h] is None or direction[h] is None:
                missing += 1
                row_u.append(0.0)
                row_v.append(0.0)
                continue
            east, north = to_components(speed[h], direction[h])
            row_u.append(round(east, 2))
            row_v.append(round(north, 2))
        u.append(row_u)
        v.append(row_v)
    if missing > MAX_MISSING_SHARE * hours * len(points):
        raise WindError(f"{missing} of {hours * len(points)} wind values are missing")

    return {
        "generated_at": now.astimezone(UTC).isoformat(timespec="seconds"),
        "source": SOURCE,
        "grid": grid.describe(),
        "hours": [
            (start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:00:00Z") for h in range(hours)
        ],
        "u": u,
        "v": v,
    }
