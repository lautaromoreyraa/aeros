"""Who hears about a fire: the people living in its risk zone.

The daily alert tells a fixed list of people that the region is burning above
its normal. Targeting tells each subscriber only about the fires that can reach
the cells they chose. The risk zone of a flagged cell is:

* the cell itself and its ring of neighbors (H3 `grid_disk` with k = 1), and
* the downwind sector: cells whose centroid lies within +-30 degrees of the
  direction the wind blows TO, up to `min(80 km, wind km/h x 12 h x 0.1)`.

The spread factor of 0.1 is a first guess to tune: a fire front rarely moves
at a tenth of the wind speed, but smoke and embers do travel with it, and the
zone is a reason to look, not a forecast of where the fire will be.

A subscriber hears about a window once, and again only if it escalates: more
flagged cells than they were told about, the highest ratio up by half, or the
fire weather (`fire_weather.json`) reaching high or extreme where it had not.
The message says where the wind is going and how unusual the air is. The
memory is one small record per subscriber, kept by whoever calls this module.

Nothing here talks to AWS: wind, report and subscribers come in as plain data,
so every rule can be tested without a network.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import h3

RING = 1
SECTOR_HALF_ANGLE = 30.0
MAX_DOWNWIND_KM = 80.0
SPREAD_HOURS = 12.0
SPREAD_FACTOR = 0.1
# A resend needs the highest ratio to grow by this factor, as the daily alert does for the region.
ESCALATION_FACTOR = 1.5
MAX_PLACES = 3
EARTH_RADIUS_KM = 6371.0088
# A wind field is trusted this close to its hours, so a stale file is never used.
MAX_HOUR_GAP = timedelta(minutes=90)


@dataclass(frozen=True)
class Wind:
    """The wind at a place, as the components of its motion in m/s."""

    u: float
    v: float

    @property
    def speed_kmh(self) -> float:
        return math.hypot(self.u, self.v) * 3.6

    @property
    def blows_to(self) -> float:
        """Compass bearing the wind moves toward, 0 = north, clockwise."""
        return math.degrees(math.atan2(self.u, self.v)) % 360


def nearest_node(grid: Mapping, lat: float, lng: float) -> int | None:
    """Index of the grid node nearest to a point, rows north to south; None if it is off the grid.

    A point is off the grid when it lies more than half a node outside it.
    """
    nx, ny = grid["nx"], grid["ny"]
    col = (lng - grid["west"]) / (grid["east"] - grid["west"]) * (nx - 1)
    row = (grid["north"] - lat) / (grid["north"] - grid["south"]) * (ny - 1)
    if not (-0.5 <= col <= nx - 0.5 and -0.5 <= row <= ny - 0.5):
        return None
    return min(ny - 1, max(0, round(row))) * nx + min(nx - 1, max(0, round(col)))


def wind_at(field: Mapping | None, lat: float, lng: float, when: datetime) -> Wind | None:
    """The wind of the nearest node and hour of a `wind.json` field, or None.

    None when there is no field, the point lies more than half a node outside
    the grid, or `when` is more than 90 minutes from every hour in the file.
    """
    if not field:
        return None
    node = nearest_node(field["grid"], lat, lng)
    if node is None:
        return None

    moment = when.astimezone(UTC)
    gaps = [abs(datetime.fromisoformat(h.replace("Z", "+00:00")) - moment) for h in field["hours"]]
    if not gaps or min(gaps) > MAX_HOUR_GAP:
        return None
    hour = gaps.index(min(gaps))
    return Wind(float(field["u"][hour][node]), float(field["v"][hour][node]))


_COMPASS = (
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
)


def offset_en(km: float, bearing_deg: float, label: str) -> str:
    """ "About 75 km north-east of Resistencia": how far, and which way, from the person."""
    where = "the area you chose" if label == "zone" else label
    if km < 5:
        return f"Very close to {where}."
    step = 5 if km < 100 else 10
    point = _COMPASS[round(bearing_deg / 45) % 8]
    return f"About {step * round(km / step)} km {point} of {where}."


def describe_wind(wind: Wind) -> str:
    """ "toward the south-east at 28 km/h": where the wind is going, which is where smoke goes."""
    point = _COMPASS[round(wind.blows_to / 45) % 8]
    return f"toward the {point} at {round(wind.speed_kmh)} km/h"


# ---------- fire weather ----------

#: Ascending severity of the levels `fire_weather.json` names.
FIRE_WEATHER_ORDER = ("normal", "elevated", "high", "extreme")
#: From this level on, the weather alone is a reason to tell people again.
FIRE_WEATHER_RESEND_FROM = "high"


def fire_weather_at(field: Mapping | None, lat: float, lng: float, day: str) -> dict | None:
    """Level and rank of the Hot-Dry-Windy index at the node nearest to a point on one day.

    `field` is a `fire_weather.json`; None when there is no field, the point is
    off its grid, the day is not one of its days, or the forecast had no value.
    """
    if not field or day not in field["days"]:
        return None
    node = nearest_node(field["grid"], lat, lng)
    if node is None:
        return None
    index = field["days"].index(day)
    percentile = field["percentile"][index][node]
    if percentile is None:
        return None
    level = "normal"
    for name, floor in sorted(field["levels"].items(), key=lambda item: -item[1]):
        if percentile >= floor:
            level = name
            break
    return {"level": level, "percentile": percentile, "hdw": field["hdw"][index][node]}


def distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial compass bearing from point 1 to point 2, 0 = north, clockwise."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    delta = math.radians(lng2 - lng1)
    y = math.sin(delta) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(delta)
    return math.degrees(math.atan2(y, x)) % 360


def downwind_reach_km(wind: Wind) -> float:
    return min(MAX_DOWNWIND_KM, wind.speed_kmh * SPREAD_HOURS * SPREAD_FACTOR)


def downwind_cells(cell: str, wind: Wind) -> set[str]:
    """Cells downwind of `cell`, inside the sector and the reach; never `cell` itself."""
    reach = downwind_reach_km(wind)
    if reach <= 0:
        return set()
    lat, lng = h3.cell_to_latlng(cell)
    edge = h3.average_hexagon_edge_length(h3.get_resolution(cell), unit="km")
    # A cell k rings away is at least k * 1.5 edges from the center: this reaches
    # every ring that can hold a centroid inside the reach.
    rings = math.ceil(reach / (1.5 * edge)) + 1
    heading = wind.blows_to
    found: set[str] = set()
    for other in h3.grid_disk(cell, rings):
        if other == cell:
            continue
        o_lat, o_lng = h3.cell_to_latlng(other)
        if distance_km(lat, lng, o_lat, o_lng) > reach:
            continue
        off = abs((bearing(lat, lng, o_lat, o_lng) - heading + 180) % 360 - 180)
        if off <= SECTOR_HALF_ANGLE:
            found.add(other)
    return found


def risk_zone(cell: str, wind: Wind | None) -> set[str]:
    """The cell, its ring, and the cells downwind; without wind, just the ring."""
    zone = set(h3.grid_disk(cell, RING))
    if wind is not None:
        zone |= downwind_cells(cell, wind)
    return zone


def alert_zones(report: Mapping, field: Mapping | None, when: datetime) -> dict[str, set[str]]:
    """Risk zone of every flagged cell of an early-warning report."""
    zones: dict[str, set[str]] = {}
    for entry in report.get("cells") or []:
        lat, lng = h3.cell_to_latlng(entry["cell"])
        zones[entry["cell"]] = risk_zone(entry["cell"], wind_at(field, lat, lng, when))
    return zones


@dataclass(frozen=True)
class Subscriber:
    id: str
    channel: str
    address: str
    cells: frozenset[str]


@dataclass(frozen=True)
class Match:
    subscriber: Subscriber
    #: The flagged cells of the report whose risk zone touches the subscriber's cells.
    flagged: tuple[Mapping, ...]

    @property
    def top_ratio(self) -> float | None:
        ratios = [c["ratio"] for c in self.flagged if c.get("ratio") is not None]
        return max(ratios) if ratios else None


def reach(
    subscribers: Iterable[Subscriber], report: Mapping, zones: Mapping[str, set[str]]
) -> list[Match]:
    """Subscribers a flagged cell can reach, each with the cells that reach them.

    A subscriber is anything with a `cells` sequence (a `Subscriber` here, or a
    stored `Subscription`), and comes back in the match as it was given.
    """
    matches = []
    for subscriber in subscribers:
        chosen = set(subscriber.cells)
        flagged = tuple(
            c for c in report.get("cells") or [] if zones.get(c["cell"], set()) & chosen
        )
        if flagged:
            matches.append(Match(subscriber, flagged))
    return matches


def reference_points(subscriber) -> tuple[list[tuple[float, float]], str]:
    """Where "near" is measured from: the town the person named, else the cells chosen on the map.

    The label is the town's name, or "zone" for the cells of the map.
    """
    place = getattr(subscriber, "place", None)
    if place:
        return [(float(place["lat"]), float(place["lng"]))], str(place["name"])
    return [h3.cell_to_latlng(c) for c in subscriber.cells], "zone"


def offset_from(subscriber, entry: Mapping) -> tuple[float, float, str]:
    """(kilometres, compass bearing, label) from the person's town or zone to a flagged cell."""
    points, label = reference_points(subscriber)
    lat, lng = place_of(entry)
    km, origin = min((distance_km(lat, lng, *p), p) for p in points)
    return km, bearing(*origin, lat, lng), label


def nearest_first(match: Match) -> Match:
    """The same match with its zones ordered by how close they burn to the subscriber's cells.

    The first zone is the one a person wants to see on a map: the fire closest to where they
    live, not the biggest one in the region. Ties go to the stronger signal.
    """

    def key(entry: Mapping) -> tuple[float, float]:
        return round(offset_from(match.subscriber, entry)[0], 1), -(entry.get("ratio") or 0.0)

    return Match(match.subscriber, tuple(sorted(match.flagged, key=key)))


def window_id(report: Mapping) -> str:
    start, end = (report.get("window") or ["?", "?"])[:2]
    return f"{start}/{end}"


def fire_weather_for(match: Match, field: Mapping | None, when: datetime) -> dict | None:
    """The worst fire weather of the day at the flagged cells that reach the subscriber."""
    day = when.astimezone(UTC).date().isoformat()
    worst = None
    for entry in match.flagged:
        lat, lng = h3.cell_to_latlng(entry["cell"])
        here = fire_weather_at(field, lat, lng, day)
        if here and (worst is None or here["percentile"] > worst["percentile"]):
            worst = here
    return worst


def _severity(level: str | None) -> int:
    return FIRE_WEATHER_ORDER.index(level) if level in FIRE_WEATHER_ORDER else -1


def should_send(
    memory: Mapping | None,
    match: Match,
    report: Mapping,
    *,
    weather_level: str | None = None,
) -> bool:
    """One message per subscriber per window, resent only if it escalates.

    Escalating means more flagged cells than they were told about, the top
    ratio up by half, or the fire weather reaching a level it had not (high or
    extreme): a fire that was already known is worse when the air turns dry and
    windy, but a calmer sky never triggers a message.
    """
    if not memory or memory.get("window") != window_id(report):
        return True
    if {c["cell"] for c in match.flagged} - set(memory.get("cells") or []):
        return True
    before, now = memory.get("ratio"), match.top_ratio
    if before and now is not None and now >= before * ESCALATION_FACTOR:
        return True
    told = _severity(memory.get("weather"))
    return _severity(weather_level) >= _severity(FIRE_WEATHER_RESEND_FROM) and (
        _severity(weather_level) > told
    )


def next_memory(
    memory: Mapping | None,
    match: Match,
    report: Mapping,
    *,
    weather_level: str | None = None,
) -> dict:
    """What the subscriber now knows; shrinking is silent, so it only ever grows."""
    same = memory if memory and memory.get("window") == window_id(report) else {}
    ratios = [r for r in (match.top_ratio, same.get("ratio")) if r is not None]
    levels = [lv for lv in (weather_level, same.get("weather")) if _severity(lv) >= 0]
    return {
        "window": window_id(report),
        "cells": sorted({c["cell"] for c in match.flagged} | set(same.get("cells") or [])),
        "ratio": max(ratios) if ratios else None,
        "weather": max(levels, key=_severity) if levels else None,
    }


def _day(text: str) -> str:
    try:
        parsed = datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return text
    return f"{parsed.strftime('%b')} {parsed.day}"


def _count(value: float) -> str:
    return f"{round(value):,}"


def _ratio(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "—"
    return f"{value:.0f}×" if value >= 10 else f"{value:.1f}×"


def place_of(entry: Mapping) -> tuple[float, float]:
    """Where a flagged cell burns: the mean of its detections, or the cell's centre without it."""
    if entry.get("lat") is not None and entry.get("lng") is not None:
        return float(entry["lat"]), float(entry["lng"])
    return h3.cell_to_latlng(entry["cell"])


def map_link(lat: float, lng: float) -> str:
    """A link every phone opens in its map app."""
    return f"https://www.google.com/maps?q={lat:.3f},{lng:.3f}"


def _place(lat: float, lng: float) -> str:
    return f"{abs(lat):.1f}° {'S' if lat < 0 else 'N'}, {abs(lng):.1f}° {'W' if lng < 0 else 'E'}"


def coverage_line(report: Mapping) -> str:
    """How complete the window was; a missing day is never a quiet day."""
    start, end = (report.get("window") or ["?", "?"])[:2]
    try:
        days = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days + 1
    except ValueError:
        return ""
    with_data = report.get("days_with_data")
    data_days = min(with_data if isinstance(with_data, int) else len(with_data or []), days)
    gaps = days - data_days
    line = f"Based on {data_days} of {days} days with satellite data"
    if gaps > 0:
        return f"{line}; {gaps} {'day is' if gaps == 1 else 'days are'} missing, not quiet."
    return f"{line}."


def format_message(
    match: Match,
    report: Mapping,
    *,
    region_ratio: float | None = None,
    sector_of: Mapping[str, str] | None = None,
    web_url: str = "",
    unsubscribe: str = "",
    wind: Wind | None = None,
    fire_weather: Mapping | None = None,
    map_links: bool = False,
    max_places: int = MAX_PLACES,
    distances: Mapping[str, tuple[float, float, str]] | None = None,
) -> tuple[str, str]:
    """(subject, text) with the fields of the interface's alert message, for one subscriber.

    `wind` and `fire_weather` add one line each when they say something: the
    direction the wind is going, and the weather when it is more than normal.
    """
    start, end = (report.get("window") or ["?", "?"])[:2]
    sector_of = sector_of or {}
    areas = len(match.flagged)
    parts = []
    if region_ratio is not None:
        parts.append(f"the region is burning at {_ratio(region_ratio)} the usual")
    parts.append(f"{areas} {'area' if areas == 1 else 'areas'} near you well above normal")
    subject = f"Early warning: {' and '.join(parts)}"

    lines = [subject, f"Window: {_day(start)} – {_day(end)}"]
    for entry in match.flagged[:max_places]:
        lat, lng = place_of(entry)
        expected = entry["expected"]
        shown = f"{expected:.1f}" if expected < 10 else _count(expected)
        name = sector_of.get(entry["cell"], "Gran Chaco")
        lines.append(
            f"- {name}, {_place(lat, lng)}: {_ratio(entry.get('ratio'))} the usual "
            f"({_count(entry['observed'])} hotspots, {shown} expected)"
        )
        if distances and entry["cell"] in distances:
            lines.append(f"  {offset_en(*distances[entry['cell']])}")
        if map_links:
            lines.append(f"  Approximate location: {map_link(lat, lng)}")
    if areas > max_places:
        lines.append(f"+ {areas - max_places} more")
    if wind is not None and wind.speed_kmh >= 1:
        lines.append(f"Wind near the fire: {describe_wind(wind)}.")
    if fire_weather and _severity(fire_weather["level"]) > 0:
        lines.append(
            f"Fire weather today: {fire_weather['level']}, drier and windier than "
            f"{fire_weather['percentile']:.0f} % of the same days in the past ten years."
        )
    if coverage := coverage_line(report):
        lines.append(coverage)
    if web_url:
        lines.append(f"Map: {web_url}")
    if unsubscribe:
        lines.append(f"Stop these alerts: {unsubscribe}")
    return subject, "\n".join(lines)
