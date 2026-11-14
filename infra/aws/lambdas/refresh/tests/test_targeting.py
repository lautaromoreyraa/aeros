from datetime import UTC, datetime

import h3
import pytest

import targeting as t

NOW = datetime(2026, 11, 14, 21, 30, tzinfo=UTC)
ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
LAT0, LNG0 = h3.cell_to_latlng(ORIGIN)


def wind_field(u=0.0, v=0.0, hours=("2026-11-14T21:00:00Z", "2026-11-14T22:00:00Z"), nodes=None):
    grid = {"west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 3, "ny": 3}
    columns = nodes or [u] * 9
    return {
        "grid": grid,
        "hours": list(hours),
        "u": [list(columns) for _ in hours],
        "v": [[v] * 9 for _ in hours],
    }


# ---------- wind ----------


def test_the_wind_blows_toward_where_its_components_point():
    assert t.Wind(10, 0).blows_to == pytest.approx(90)  # eastward
    assert t.Wind(0, 10).blows_to == pytest.approx(0)  # northward
    assert t.Wind(0, -10).blows_to == pytest.approx(180)
    assert t.Wind(-10, 0).blows_to == pytest.approx(270)
    assert t.Wind(10, 0).speed_kmh == pytest.approx(36)


def test_distance_and_bearing_match_the_map():
    assert t.distance_km(-25, -61, -25, -60) == pytest.approx(100.9, abs=0.5)
    # The shortest route east along a parallel bows toward the pole: 90.2 degrees at 25 S.
    assert t.bearing(-25, -61, -25, -60) == pytest.approx(90, abs=0.5)
    assert t.bearing(-25, -61, -24, -61) == pytest.approx(0, abs=0.1)
    assert t.bearing(-25, -61, -26, -61) == pytest.approx(180, abs=0.1)


def test_the_nearest_node_of_the_grid_is_used():
    nodes = [float(i) for i in range(9)]  # row-major, north-west first
    field = wind_field(nodes=nodes)
    assert t.wind_at(field, -16, -69, NOW).u == 0.0  # north-west corner
    assert t.wind_at(field, -35, -53, NOW).u == 8.0  # south-east corner
    assert t.wind_at(field, -25.5, -61, NOW).u == 4.0  # the middle


def test_a_point_far_outside_the_grid_has_no_wind_but_one_just_outside_does():
    field = wind_field(u=5.0)
    assert t.wind_at(field, -5, -61, NOW) is None
    assert t.wind_at(field, -15, -61, NOW) == t.Wind(5.0, 0.0)  # within half a node of the edge


def test_the_nearest_hour_is_used_and_a_stale_file_is_not():
    field = wind_field()
    field["u"] = [[1.0] * 9, [2.0] * 9]
    assert t.wind_at(field, -25, -61, datetime(2026, 11, 14, 21, 20, tzinfo=UTC)).u == 1.0
    assert t.wind_at(field, -25, -61, datetime(2026, 11, 14, 21, 50, tzinfo=UTC)).u == 2.0
    assert t.wind_at(field, -25, -61, datetime(2026, 11, 15, 6, 0, tzinfo=UTC)) is None
    assert t.wind_at(None, -25, -61, NOW) is None


# ---------- risk zone ----------


def test_without_wind_the_zone_is_the_cell_and_its_ring():
    ring = set(h3.grid_disk(ORIGIN, 1))
    assert t.risk_zone(ORIGIN, None) == ring and len(ring) == 7
    assert t.risk_zone(ORIGIN, t.Wind(0, 0)) == ring


def test_a_strong_wind_adds_only_cells_downwind_within_the_reach():
    wind = t.Wind(25, 0)  # 90 km/h toward the east: reach is capped at 80 km
    zone = t.risk_zone(ORIGIN, wind)
    extra = zone - set(h3.grid_disk(ORIGIN, 1))
    assert extra, "a strong wind must reach beyond the first ring"
    for cell in extra:
        lat, lng = h3.cell_to_latlng(cell)
        assert t.distance_km(LAT0, LNG0, lat, lng) <= t.MAX_DOWNWIND_KM
        assert abs(t.bearing(LAT0, LNG0, lat, lng) - 90) <= t.SECTOR_HALF_ANGLE
        assert lng > LNG0


def test_the_reach_is_capped_and_scales_with_the_wind():
    assert t.risk_zone(ORIGIN, t.Wind(60, 0)) == t.risk_zone(ORIGIN, t.Wind(25, 0))
    assert t.downwind_reach_km(t.Wind(5, 0)) == pytest.approx(18 * 12 * 0.1)
    assert t.downwind_reach_km(t.Wind(60, 0)) == t.MAX_DOWNWIND_KM


def test_the_zone_follows_the_direction_the_wind_blows_to():
    east = t.risk_zone(ORIGIN, t.Wind(25, 0)) - set(h3.grid_disk(ORIGIN, 1))
    west = t.risk_zone(ORIGIN, t.Wind(-25, 0)) - set(h3.grid_disk(ORIGIN, 1))
    assert all(h3.cell_to_latlng(c)[1] > LNG0 for c in east)
    assert all(h3.cell_to_latlng(c)[1] < LNG0 for c in west)
    assert not east & west


# ---------- who is reached ----------


def _report(*cells, window=("2026-11-08", "2026-11-14"), days_with_data=7):
    return {
        "window": list(window),
        "days_with_data": days_with_data,
        "cells": [
            {"cell": c, "observed": 30, "expected": 9.0, "ratio": r, "p_value": 0.001}
            for c, r in cells
        ],
    }


def test_a_subscriber_is_reached_downwind_but_not_upwind_or_far_away():
    east_wind = t.Wind(25, 0)
    downwind = max(t.downwind_cells(ORIGIN, east_wind), key=lambda c: h3.cell_to_latlng(c)[1])
    assert downwind not in h3.grid_disk(ORIGIN, 1)
    far = h3.grid_ring(ORIGIN, 6)[0]
    here = t.Subscriber("a", "telegram", "1", frozenset({ORIGIN}))
    down = t.Subscriber("b", "email", "b@example.com", frozenset({downwind}))
    away = t.Subscriber("c", "email", "c@example.com", frozenset({far}))
    nobody = t.Subscriber("d", "email", "d@example.com", frozenset())
    report = _report((ORIGIN, 3.0))

    zones = {ORIGIN: t.risk_zone(ORIGIN, east_wind)}
    matched = {m.subscriber.id for m in t.reach([here, down, away, nobody], report, zones)}
    assert matched == {"a", "b"}

    zones = {ORIGIN: t.risk_zone(ORIGIN, t.Wind(-25, 0))}
    matched = {m.subscriber.id for m in t.reach([here, down, away], report, zones)}
    assert matched == {"a"}  # the wind now blows away from the second subscriber


def test_alert_zones_reads_the_wind_at_each_flagged_cell():
    zones = t.alert_zones(_report((ORIGIN, 3.0)), wind_field(u=25.0), NOW)
    assert zones[ORIGIN] == t.risk_zone(ORIGIN, t.Wind(25.0, 0.0))
    # Without a wind file the zone is still the ring, so the alert still goes out.
    assert t.alert_zones(_report((ORIGIN, 3.0)), None, NOW)[ORIGIN] == set(h3.grid_disk(ORIGIN, 1))


def test_a_match_keeps_only_the_cells_that_reach_the_subscriber():
    other = h3.grid_ring(ORIGIN, 8)[0]
    report = _report((ORIGIN, 3.0), (other, 5.0))
    zones = {ORIGIN: t.risk_zone(ORIGIN, None), other: t.risk_zone(other, None)}
    (match,) = t.reach(
        [t.Subscriber("a", "email", "a@example.com", frozenset({ORIGIN}))], report, zones
    )
    assert [c["cell"] for c in match.flagged] == [ORIGIN]
    assert match.top_ratio == 3.0


# ---------- when to resend ----------


def _match(*cells):
    sub = t.Subscriber("a", "telegram", "1", frozenset({ORIGIN}))
    entries = tuple(
        {"cell": c, "observed": 30, "expected": 9.0, "ratio": r, "p_value": 0.001} for c, r in cells
    )
    return t.Match(sub, entries)


def test_the_first_message_of_a_window_is_sent_and_the_same_one_is_not_repeated():
    other = h3.grid_ring(ORIGIN, 1)[0]
    report = _report((ORIGIN, 2.0))
    match = _match((ORIGIN, 2.0))
    assert t.should_send(None, match, report)
    memory = t.next_memory(None, match, report)
    assert not t.should_send(memory, match, report)
    # A new cell flagged, or the ratio up by half, escalates; a smaller rise does not.
    assert t.should_send(memory, _match((ORIGIN, 2.0), (other, 2.0)), report)
    assert t.should_send(memory, _match((ORIGIN, 3.0)), report)
    assert not t.should_send(memory, _match((ORIGIN, 2.9)), report)


def test_a_new_window_is_a_new_message_even_for_the_same_cells():
    match = _match((ORIGIN, 2.0))
    memory = t.next_memory(None, match, _report((ORIGIN, 2.0)))
    later = _report((ORIGIN, 2.0), window=("2026-11-15", "2026-11-21"))
    assert t.should_send(memory, match, later)


def test_the_memory_only_grows_so_a_shrinking_alert_stays_silent():
    other = h3.grid_ring(ORIGIN, 1)[0]
    report = _report((ORIGIN, 4.0), (other, 2.0))
    memory = t.next_memory(None, _match((ORIGIN, 4.0), (other, 2.0)), report)
    smaller = _match((ORIGIN, 2.5))
    assert not t.should_send(memory, smaller, report)
    grown = t.next_memory(memory, smaller, report)
    assert grown["cells"] == sorted({ORIGIN, other}) and grown["ratio"] == 4.0


def test_a_missing_ratio_never_triggers_a_resend_by_itself():
    report = _report((ORIGIN, None))
    memory = t.next_memory(None, _match((ORIGIN, None)), report)
    assert memory["ratio"] is None
    assert not t.should_send(memory, _match((ORIGIN, None)), report)


# ---------- the message ----------


def test_the_subject_names_the_region_only_when_the_whole_region_is_alerting():
    one = _match((ORIGIN, 3.3))
    assert t.format_message(one, _report((ORIGIN, 3.3)))[0] == (
        "Early warning: 1 area near you well above normal"
    )
    other = h3.grid_ring(ORIGIN, 1)[0]
    two = _match((ORIGIN, 3.3), (other, 2.0))
    subject, _ = t.format_message(two, _report((ORIGIN, 3.3), (other, 2.0)), region_ratio=1.36)
    assert subject == (
        "Early warning: the region is burning at 1.4× the usual "
        "and 2 areas near you well above normal"
    )


def test_the_body_carries_the_window_the_places_and_how_complete_the_data_was():
    match = _match((ORIGIN, 3.3))
    report = _report((ORIGIN, 3.3), days_with_data=[f"2026-11-{d:02d}" for d in range(8, 14)])
    _, text = t.format_message(
        match,
        report,
        sector_of={ORIGIN: "Dry Chaco"},
        web_url="https://aeros.example",
        unsubscribe="https://aeros.example/stop",
    )
    lines = text.splitlines()
    assert "Window: Nov 8 – Nov 14" in lines
    place = next(line for line in lines if line.startswith("- "))
    assert place.startswith("- Dry Chaco, 2")  # sector name, then the cell's latitude
    assert "3.3× the usual (30 hotspots, 9.0 expected)" in place
    assert "Based on 6 of 7 days with satellite data; 1 day is missing, not quiet." in lines
    assert lines[-2:] == [
        "Map: https://aeros.example",
        "Stop these alerts: https://aeros.example/stop",
    ]


def test_only_three_places_are_listed_and_the_rest_are_counted():
    cells = h3.grid_disk(ORIGIN, 1)[:5]
    match = _match(*[(c, 2.0) for c in cells])
    _, text = t.format_message(match, _report(*[(c, 2.0) for c in cells]))
    assert sum(line.startswith("- ") for line in text.splitlines()) == t.MAX_PLACES
    assert "+ 2 more" in text.splitlines()


def test_numbers_read_like_the_interface_does():
    entry = {"cell": ORIGIN, "observed": 2679, "expected": 1976.0, "ratio": 13.6, "p_value": 0.001}
    match = t.Match(t.Subscriber("a", "email", "a@example.com", frozenset({ORIGIN})), (entry,))
    _, text = t.format_message(match, _report((ORIGIN, 13.6), days_with_data=7))
    assert "14× the usual (2,679 hotspots, 1,976 expected)" in text
    assert "Based on 7 of 7 days with satellite data." in text.splitlines()
    assert "Gran Chaco," in text  # the default when a cell has no sector
    assert "Map:" not in text and "Stop these alerts" not in text
