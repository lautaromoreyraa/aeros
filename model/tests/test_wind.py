import json
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

import pytest

from aeros import cli, wind

AREA = (-69.0, -35.0, -53.0, -16.0)
NOW = datetime(2026, 11, 14, 21, 37, tzinfo=UTC)


def _queries(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query)


def fake_open_meteo(speed=10.0, direction=lambda lat, lon: 270.0, holes=0):
    """A stand-in for the API: one entry per requested location, three days from 00:00 UTC."""
    calls: list[str] = []

    def fetch(url: str):
        calls.append(url)
        query = _queries(url)
        lats = [float(v) for v in query["latitude"][0].split(",")]
        lons = [float(v) for v in query["longitude"][0].split(",")]
        times = [f"2026-11-{14 + d:02d}T{h:02d}:00" for d in range(3) for h in range(24)]
        entries = []
        for lat, lon in zip(lats, lons, strict=True):
            speeds: list = [speed] * len(times)
            for i in range(holes):
                speeds[30 + i] = None
            entries.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "hourly": {
                        "time": times,
                        "wind_speed_10m": speeds,
                        "wind_direction_10m": [direction(lat, lon)] * len(times),
                    },
                }
            )
        return entries if len(entries) > 1 else entries[0]

    fetch.calls = calls  # type: ignore[attr-defined]
    return fetch


def test_a_wind_from_the_west_blows_east_and_from_the_north_blows_south():
    u, v = wind.to_components(10.0, 270.0)
    assert u == pytest.approx(10.0) and v == pytest.approx(0.0, abs=1e-9)
    u, v = wind.to_components(10.0, 0.0)
    assert u == pytest.approx(0.0, abs=1e-9) and v == pytest.approx(-10.0)
    u, v = wind.to_components(10.0, 180.0)
    assert v == pytest.approx(10.0)
    u, v = wind.to_components(10.0, 90.0)
    assert u == pytest.approx(-10.0)


def test_the_grid_runs_north_to_south_and_west_to_east():
    points = wind.Grid(*AREA, nx=3, ny=2).points()
    assert points[0] == (-16.0, -69.0)  # north-west corner first
    assert points[2] == (-16.0, -53.0)  # end of the first row
    assert points[3] == (-35.0, -69.0)  # second row starts at the south-west
    assert len(points) == 6


def test_the_payload_follows_the_contract_the_interface_reads():
    field = wind.build(AREA, 12, 12, 48, NOW, fake_open_meteo())
    assert set(field) == {"generated_at", "source", "grid", "hours", "u", "v"}
    assert field["grid"] == {
        "west": -69.0,
        "south": -35.0,
        "east": -53.0,
        "north": -16.0,
        "nx": 12,
        "ny": 12,
    }
    assert len(field["hours"]) == len(field["u"]) == len(field["v"]) == 48
    assert all(len(row) == 144 for row in field["u"] + field["v"])
    assert field["generated_at"] == "2026-11-14T21:37:00+00:00"


def test_the_hours_start_at_the_current_utc_hour_and_end_in_z():
    field = wind.build(AREA, 3, 3, 48, NOW, fake_open_meteo())
    assert field["hours"][0] == "2026-11-14T21:00:00Z"
    assert field["hours"][1] == "2026-11-14T22:00:00Z"
    assert field["hours"][-1] == "2026-11-16T20:00:00Z"


def test_rows_stay_in_order_so_the_north_is_the_first_row():
    # Wind from the west in the northern half, from the north in the southern half.
    field = wind.build(
        AREA,
        4,
        4,
        1,
        NOW,
        fake_open_meteo(direction=lambda lat, lon: 270.0 if lat > -25.5 else 0.0),
    )
    first_row = range(0, 4)
    last_row = range(12, 16)
    assert all(field["u"][0][i] == pytest.approx(10.0) for i in first_row)
    assert all(field["v"][0][i] == pytest.approx(-10.0) for i in last_row)
    assert all(abs(field["u"][0][i]) < 1e-6 for i in last_row)


def test_it_asks_for_metres_per_second_in_utc_with_enough_days():
    fetch = fake_open_meteo()
    wind.build(AREA, 3, 3, 48, NOW, fetch)
    query = _queries(fetch.calls[0])
    assert query["wind_speed_unit"] == ["ms"]
    assert query["timezone"] == ["UTC"]
    assert query["hourly"] == ["wind_speed_10m,wind_direction_10m"]
    # From hour 21, 48 more hours reach the third day: three forecast days.
    assert query["forecast_days"] == ["3"]


def test_many_locations_are_split_into_several_requests():
    fetch = fake_open_meteo()
    field = wind.build(AREA, 12, 12, 2, NOW, fetch)
    assert len(fetch.calls) == 2  # 144 nodes in groups of 100
    assert len(field["u"][0]) == 144


def test_a_single_location_answer_is_not_a_list(monkeypatch):
    monkeypatch.setattr(wind, "LOCATIONS_PER_REQUEST", 1)
    field = wind.build(AREA, 2, 2, 1, NOW, fake_open_meteo())
    assert len(field["u"][0]) == 4


def test_a_few_holes_become_zero_wind_but_a_mostly_empty_field_is_refused():
    few = wind.build(AREA, 3, 3, 48, NOW, fake_open_meteo(holes=1))
    hole = few["hours"].index("2026-11-15T06:00:00Z")  # index 30 from 00:00 of the 14th
    assert few["u"][hole] == [0.0] * 9
    with pytest.raises(wind.WindError, match="missing"):
        wind.build(AREA, 3, 3, 48, NOW, fake_open_meteo(holes=20))


def test_a_different_number_of_locations_than_requested_is_an_error():
    with pytest.raises(wind.WindError, match="locations"):
        wind.build(AREA, 3, 3, 1, NOW, lambda url: [])


def test_the_area_and_the_grid_are_validated():
    assert wind.parse_area("-69,-35,-53,-16") == AREA
    for bad in ("-69,-35,-53", "a,b,c,d", "-53,-35,-69,-16", "-69,-16,-53,-35"):
        with pytest.raises(ValueError):
            wind.parse_area(bad)
    with pytest.raises(ValueError):
        wind.build(AREA, 1, 5, 4, NOW, fake_open_meteo())


def test_the_command_writes_wind_json(tmp_path, monkeypatch):
    monkeypatch.setattr(wind, "_get_json", fake_open_meteo())
    target = tmp_path / "out" / "wind.json"
    assert cli.main(["wind", "--out", str(target), "--nx", "4", "--ny", "4", "--hours", "6"]) == 0
    written = json.loads(target.read_text())
    assert len(written["hours"]) == 6 and len(written["u"][0]) == 16
