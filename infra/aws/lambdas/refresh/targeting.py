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
flagged cells than they were told about, or the highest ratio up by half. The
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


def wind_at(field: Mapping | None, lat: float, lng: float, when: datetime) -> Wind | None:
    """The wind of the nearest node and hour of a `wind.json` field, or None.

    None when there is no field, the point lies more than half a node outside
    the grid, or `when` is more than 90 minutes from every hour in the file.
    """
    if not field:
        return None
    grid = field["grid"]
    nx, ny = grid["nx"], grid["ny"]
    col = (lng - grid["west"]) / (grid["east"] - grid["west"]) * (nx - 1)
    row = (grid["north"] - lat) / (grid["north"] - grid["south"]) * (ny - 1)
    if not (-0.5 <= col <= nx - 0.5 and -0.5 <= row <= ny - 0.5):
        return None
    node = min(ny - 1, max(0, round(row))) * nx + min(nx - 1, max(0, round(col)))

    moment = when.astimezone(UTC)
    gaps = [abs(datetime.fromisoformat(h.replace("Z", "+00:00")) - moment) for h in field["hours"]]
    if not gaps or min(gaps) > MAX_HOUR_GAP:
        return None
    hour = gaps.index(min(gaps))
    return Wind(float(field["u"][hour][node]), float(field["v"][hour][node]))


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
    """Subscribers a flagged cell can reach, each with the cells that reach them."""
    matches = []
    for subscriber in subscribers:
        flagged = tuple(
            c for c in report.get("cells") or [] if zones.get(c["cell"], set()) & subscriber.cells
        )
        if flagged:
            matches.append(Match(subscriber, flagged))
    return matches


def window_id(report: Mapping) -> str:
    start, end = (report.get("window") or ["?", "?"])[:2]
    return f"{start}/{end}"


def should_send(memory: Mapping | None, match: Match, report: Mapping) -> bool:
    """One message per subscriber per window, resent only if it escalates."""
    if not memory or memory.get("window") != window_id(report):
        return True
    if {c["cell"] for c in match.flagged} - set(memory.get("cells") or []):
        return True
    before, now = memory.get("ratio"), match.top_ratio
    return bool(before and now is not None and now >= before * ESCALATION_FACTOR)


def next_memory(memory: Mapping | None, match: Match, report: Mapping) -> dict:
    """What the subscriber now knows; shrinking is silent, so it only ever grows."""
    same = memory if memory and memory.get("window") == window_id(report) else {}
    ratios = [r for r in (match.top_ratio, same.get("ratio")) if r is not None]
    return {
        "window": window_id(report),
        "cells": sorted({c["cell"] for c in match.flagged} | set(same.get("cells") or [])),
        "ratio": max(ratios) if ratios else None,
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
) -> tuple[str, str]:
    """(subject, text) with the fields of the interface's alert message, for one subscriber."""
    start, end = (report.get("window") or ["?", "?"])[:2]
    sector_of = sector_of or {}
    areas = len(match.flagged)
    parts = []
    if region_ratio is not None:
        parts.append(f"the region is burning at {_ratio(region_ratio)} the usual")
    parts.append(f"{areas} {'area' if areas == 1 else 'areas'} near you well above normal")
    subject = f"Early warning: {' and '.join(parts)}"

    lines = [subject, f"Window: {_day(start)} – {_day(end)}"]
    for entry in match.flagged[:MAX_PLACES]:
        lat, lng = h3.cell_to_latlng(entry["cell"])
        expected = entry["expected"]
        shown = f"{expected:.1f}" if expected < 10 else _count(expected)
        name = sector_of.get(entry["cell"], "Gran Chaco")
        lines.append(
            f"- {name}, {_place(lat, lng)}: {_ratio(entry.get('ratio'))} the usual "
            f"({_count(entry['observed'])} hotspots, {shown} expected)"
        )
    if areas > MAX_PLACES:
        lines.append(f"+ {areas - MAX_PLACES} more")
    if coverage := coverage_line(report):
        lines.append(coverage)
    if web_url:
        lines.append(f"Map: {web_url}")
    if unsubscribe:
        lines.append(f"Stop these alerts: {unsubscribe}")
    return subject, "\n".join(lines)
