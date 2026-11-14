import json
import urllib.error
from datetime import UTC, date, datetime
from urllib.parse import parse_qs, urlparse

import pytest

from aeros import cli, fireweather, wind

AREA = (-69.0, -35.0, -53.0, -16.0)
NOW = datetime(2026, 11, 14, 21, 37, tzinfo=UTC)


def test_the_index_is_the_deficit_in_hpa_times_the_wind():
    assert fireweather.hdw(2.0, 5.0) == pytest.approx(100.0)
    assert fireweather.hdw(None, 5.0) is None
    assert fireweather.hdw(2.0, None) is None


def test_a_day_keeps_its_highest_hour_and_skips_hours_without_data():
    hourly = {
        "time": ["2026-11-14T10:00", "2026-11-14T15:00", "2026-11-14T18:00", "2026-11-15T15:00"],
        "vapour_pressure_deficit": [1.0, 3.0, None, None],
        "wind_speed_10m": [2.0, 4.0, 9.0, 5.0],
    }
    assert fireweather.daily_peaks(hourly) == {"2026-11-14": pytest.approx(120.0)}


def test_the_rank_is_the_share_of_calmer_days_and_the_level_follows_it():
    samples = [float(v) for v in range(1, 101)]  # 1 .. 100
    assert fireweather.rank(samples, 95) == 95.0
    assert fireweather.rank(samples, 0) == 0.0
    assert fireweather.rank(samples, 500) == 100.0
    assert fireweather.rank([], 5) is None and fireweather.rank(samples, None) is None
    assert [fireweather.level(p) for p in (None, 10, 74.9, 75, 89.9, 90, 94.9, 95, 100)] == [
        None, "normal", "normal", "elevated", "elevated", "high", "high", "extreme", "extreme"
    ]  # fmt: skip


def test_the_climatology_window_is_the_same_days_of_each_past_year():
    days = [date(2026, 11, 14), date(2026, 11, 17)]
    assert fireweather.window_in_year(days, 2024, 15) == (date(2024, 10, 30), date(2024, 12, 2))
    # 29 February has no counterpart in a common year.
    assert fireweather.window_in_year([date(2024, 2, 29)], 2025, 0) == (
        date(2025, 2, 28),
        date(2025, 2, 28),
    )


def fake_open_meteo(forecast_vpd, forecast_wind, history_vpd, history_wind):
    """Forecast and archive answers whose values depend on the latitude of each node."""
    calls: list[str] = []

    def fetch(url: str):
        calls.append(url)
        query = parse_qs(urlparse(url).query)
        lats = [float(v) for v in query["latitude"][0].split(",")]
        if "forecast" in url:
            first, count = date(2026, 11, 14), int(query["forecast_days"][0])
            vpd, speed = forecast_vpd, forecast_wind
        else:
            first = date.fromisoformat(query["start_date"][0])
            count = (date.fromisoformat(query["end_date"][0]) - first).days + 1
            vpd, speed = history_vpd, history_wind
        times = [
            f"{date.fromordinal(first.toordinal() + d).isoformat()}T{h:02d}:00"
            for d in range(count)
            for h in range(24)
        ]
        return [
            {
                "hourly": {
                    "time": times,
                    "vapour_pressure_deficit": [vpd(lat)] * len(times),
                    "wind_speed_10m": [speed(lat)] * len(times),
                }
            }
            for lat in lats
        ]

    fetch.calls = calls  # type: ignore[attr-defined]
    return fetch


def north_is_dry_and_windy():
    # North of 25.5 S: a deficit of 3 kPa and 10 m/s (index 300); south: 1 kPa and 2 m/s (20).
    # The past was always in between (index 100), so the north is far above it and the south below.
    return fake_open_meteo(
        forecast_vpd=lambda lat: 3.0 if lat > -25.5 else 1.0,
        forecast_wind=lambda lat: 10.0 if lat > -25.5 else 2.0,
        history_vpd=lambda lat: 2.0,
        history_wind=lambda lat: 5.0,
    )


def test_the_payload_ranks_each_day_and_node_against_the_past_years():
    fetch = north_is_dry_and_windy()
    field = fireweather.build(AREA, 4, 4, 2, NOW, years=3, fetch=fetch)

    assert field["days"] == ["2026-11-14", "2026-11-15"]
    assert field["grid"] == {
        "west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 4, "ny": 4,
    }  # fmt: skip
    assert field["climatology"]["years"] == [2023, 2025]
    # 3 years of a 2-day target widened by 15 days on each side: 32 days each.
    assert field["climatology"]["samples_per_node"] == 3 * 32
    first_row, last_row = range(0, 4), range(12, 16)
    assert all(
        field["hdw"][0][i] == 300.0 and field["percentile"][0][i] == 100.0 for i in first_row
    )
    assert all(field["hdw"][0][i] == 20.0 and field["percentile"][0][i] == 0.0 for i in last_row)
    assert field["levels"] == {"extreme": 95.0, "high": 90.0, "elevated": 75.0}


def test_it_asks_the_forecast_for_the_days_and_the_archive_for_each_past_year():
    fetch = north_is_dry_and_windy()
    fireweather.build(AREA, 3, 3, 4, NOW, years=2, fetch=fetch)

    forecast = [u for u in fetch.calls if "forecast" in u]
    archive = [u for u in fetch.calls if "archive" in u]
    assert len(forecast) == 1 and len(archive) == 2
    query = parse_qs(urlparse(forecast[0]).query)
    assert query["forecast_days"] == ["4"] and query["timezone"] == ["UTC"]
    assert query["hourly"] == ["vapour_pressure_deficit,wind_speed_10m"]
    assert query["wind_speed_unit"] == ["ms"]
    starts = [parse_qs(urlparse(u).query)["start_date"][0] for u in archive]
    ends = [parse_qs(urlparse(u).query)["end_date"][0] for u in archive]
    assert starts == ["2024-10-30", "2025-10-30"] and ends == ["2024-12-02", "2025-12-02"]


def test_it_pauses_between_history_requests_only_when_asked():
    sleeps: list[float] = []
    fireweather.build(
        AREA, 3, 3, 1, NOW, years=3, fetch=north_is_dry_and_windy(), sleep=sleeps.append, pause=20
    )
    assert sleeps == [20, 20, 20]
    sleeps.clear()
    fireweather.build(
        AREA, 3, 3, 1, NOW, years=3, fetch=north_is_dry_and_windy(), sleep=sleeps.append
    )
    assert sleeps == []


def test_a_day_the_forecast_does_not_cover_has_no_rank():
    # The model answers for only one of the two days asked: the other is null, not zero.
    def short_forecast(url: str):
        answers = north_is_dry_and_windy()(url)
        if "forecast" in url:
            for loc in answers:
                for key in loc["hourly"]:
                    loc["hourly"][key] = loc["hourly"][key][:24]
        return answers

    field = fireweather.build(AREA, 2, 2, 2, NOW, years=1, fetch=short_forecast)
    assert field["hdw"][1] == [None] * 4 and field["percentile"][1] == [None] * 4
    assert None not in field["percentile"][0]


def test_a_summary_line_per_day_says_how_extreme_it_is():
    field = fireweather.build(AREA, 4, 4, 1, NOW, years=2, fetch=north_is_dry_and_windy())
    (line,) = fireweather.summarize(field)
    assert line == {
        "day": "2026-11-14", "top_percentile": 100.0, "level": "extreme",
        "extreme_nodes": 8, "nodes": 16,
    }  # fmt: skip


def test_a_wrong_number_of_locations_is_an_error_and_bad_inputs_are_refused():
    with pytest.raises(wind.WindError, match="locations"):
        fireweather.build(AREA, 3, 3, 1, NOW, years=1, fetch=lambda url: [])
    for bad in ({"nx": 1}, {"days": 0}, {"years": 0}):
        args = {"nx": 3, "days": 1, "years": 1} | bad
        with pytest.raises(ValueError):
            fireweather.build(AREA, args["nx"], 3, args["days"], NOW, years=args["years"])


def test_a_request_the_service_refuses_for_being_too_frequent_waits_and_retries(monkeypatch):
    attempts: list[int] = []

    class Response:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(self.body).encode()

    def urlopen(url, timeout):
        attempts.append(1)
        if len(attempts) < 3:
            raise urllib.error.HTTPError(url, 429, "Too Many Requests", {"Retry-After": "7"}, None)
        return Response({"ok": True})

    monkeypatch.setattr(fireweather.urllib.request, "urlopen", urlopen)
    sleeps: list[float] = []
    assert fireweather._retrying_get(sleeps.append)("https://example.test") == {"ok": True}
    assert len(attempts) == 3 and sleeps == [7.0, 7.0]


def test_any_other_error_is_not_retried(monkeypatch):
    def urlopen(url, timeout):
        raise urllib.error.HTTPError(url, 500, "Server Error", {}, None)

    monkeypatch.setattr(fireweather.urllib.request, "urlopen", urlopen)
    with pytest.raises(urllib.error.HTTPError):
        fireweather._retrying_get(lambda s: None)("https://example.test")


def test_the_command_writes_fire_weather_json(tmp_path, monkeypatch):
    monkeypatch.setattr(fireweather, "_retrying_get", lambda sleep: north_is_dry_and_windy())
    target = tmp_path / "out" / "fire_weather.json"
    args = ["fire-weather", "--out", str(target), "--nx", "3", "--ny", "3"]
    assert cli.main([*args, "--days", "2", "--years", "2", "--pause", "0"]) == 0
    written = json.loads(target.read_text())
    assert len(written["days"]) == 2 and len(written["hdw"][0]) == 9
