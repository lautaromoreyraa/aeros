from datetime import UTC, datetime, timedelta

import pytest

import alerts_api as a
import fire_check as f
import subscriptions as s
import telegram_bot as t

NOW = datetime(2026, 11, 15, 18, 0, tzinfo=UTC)
HERE = (-25.0, -61.0)
AREA = (-69.0, -35.0, -53.0, -16.0)
CSV_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_ti5,frp,daynight\n"
)


def goes(cells, generated=NOW - timedelta(minutes=8)):
    return {
        "generated_at": generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scans": ["2026-11-15T17:50:00Z"],
        "cells": cells,
    }


def goes_cell(lat, lng, confident=1, persistent=False):
    return {
        "cell": "x",
        "lat": lat,
        "lng": lng,
        "confident_pixels": confident,
        "persistent": persistent,
        "last_seen": "2026-11-15T17:50:00Z",
    }


def nrt_row(lat, lon, day="2026-11-15", time="0530", satellite="N21", confidence="n"):
    return (
        f"{lat},{lon},330.1,0.4,0.4,{day},{time},{satellite},VIIRS,{confidence},2.0NRT,290,5.1,N\n"
    )


def test_points_from_untrusted_text():
    assert f.parse_point(" -25.123456 ", "-61") == (-25.123, -61.0)
    for bad in [("", "1"), ("nan", "1"), ("91", "0"), ("0", "-181"), ("1e400", "0")]:
        with pytest.raises(f.InvalidPoint):
            f.parse_point(*bad)


def test_distance_is_great_circle():
    assert f.distance_km(-25.0, -61.0, -25.0, -61.0) == 0
    assert f.distance_km(-25.0, -61.0, -26.0, -61.0) == pytest.approx(111.2, abs=0.2)


def test_confident_goes_pixel_nearby_is_seen_now():
    result = f.check(*HERE, NOW, goes([goes_cell(-25.05, -61.02)]), [], 3)
    assert result["verdict"] == "seen_now"
    assert result["goes"]["nearest"]["distance_km"] < 7
    assert {"country": "Argentina", "number": "100"} in result["emergency"]


def test_an_old_goes_layer_cannot_say_now():
    stale = goes([goes_cell(-25.05, -61.02)], generated=NOW - timedelta(hours=3))
    assert f.check(*HERE, NOW, stale, [], 3)["verdict"] == "seen_recently"


def test_far_pixels_and_old_detections_do_not_count():
    far = goes([goes_cell(-26.0, -61.0)])
    old = f.parse_nrt((CSV_HEADER + nrt_row(-25.01, -61.01, day="2026-11-12")).encode())
    result = f.check(*HERE, NOW, far, old, 3)
    assert result["verdict"] == "not_seen"
    assert result["goes"]["nearest"] is None and result["polar"]["detections"] == 0


def test_a_polar_pass_since_yesterday_is_seen_recently():
    body = (CSV_HEADER + nrt_row(-25.01, -61.01) + nrt_row(-25.02, -61.0, satellite="N20")).encode()
    result = f.check(*HERE, NOW, None, f.parse_nrt(body), 1)
    assert result["verdict"] == "seen_recently"
    assert result["polar"]["detections"] == 2
    assert result["polar"]["nearest"]["satellite"] == "NOAA-21"
    assert result["goes"]["available"] is False


def test_low_confidence_is_kept_but_marked():
    body = (CSV_HEADER + nrt_row(-25.0, -61.0, confidence="l")).encode()
    (only,) = f.parse_nrt(body)
    assert only.confident is False


def test_bad_rows_are_skipped():
    body = (CSV_HEADER + "x,y,,,,2026-11-15,0530,N21,VIIRS,n,,,,\n" + nrt_row(-25, -61)).encode()
    assert len(f.parse_nrt(body)) == 1


def test_load_reads_goes_and_three_days_of_nrt_files_and_skips_missing_ones():
    asked = []
    files = {
        "derived/goes_latest.json": b'{"generated_at": "2026-11-15T17:52:00Z", "cells": []}',
        "raw/firms/nrt/2026-11-15/fire_nrt_j2v-c2_2026-11-15.csv": (
            CSV_HEADER + nrt_row(-25, -61)
        ).encode(),
    }

    def get(key):
        asked.append(key)
        return files.get(key)

    layer, detections, files = f.load(get, "derived/goes_latest.json", "raw/firms/", NOW)
    assert layer["cells"] == [] and len(detections) == 1 and files == 1
    assert len(asked) == 1 + 3 * len(f.NRT_FILES)
    assert "raw/firms/nrt/2026-11-13/fire_nrt_m-c61_2026-11-13.csv" in asked


@pytest.mark.parametrize("language", ["es", "en"])
def test_every_message_starts_with_the_fire_brigade(language):
    for result in [
        f.check(*HERE, NOW, goes([goes_cell(-25.05, -61.02)]), [], 3),
        f.check(*HERE, NOW, None, f.parse_nrt((CSV_HEADER + nrt_row(-25, -61)).encode()), 1),
        f.check(*HERE, NOW, goes([]), [], 3),
        f.check(*HERE, NOW, None, [], 0),
        f.outside_answer(40.0, -3.0, NOW),
    ]:
        text = f.message(result, language, NOW)
        assert text.startswith("🚒") and "100" in text and "132" in text and "119" in text


def test_spanish_messages_say_what_was_seen():
    seen = f.message(f.check(*HERE, NOW, goes([goes_cell(-25.05, -61.02)]), [], 3), "es", NOW)
    assert "GOES-19 ve calor" in seen and "hace 10 min" in seen
    nothing = f.message(f.check(*HERE, NOW, goes([]), [], 3), "es", NOW)
    assert "no quiere decir que no haya" in nothing
    polar = f.message(
        f.check(*HERE, NOW, None, f.parse_nrt((CSV_HEADER + nrt_row(-25, -61)).encode()), 1),
        "es",
        NOW,
    )
    assert "NOAA-21 vio fuego" in polar and "hace 12 h" in polar


# ---------- the API ----------


def api_event(query):
    return {
        "requestContext": {"http": {"method": "GET"}},
        "rawPath": "/api/alerts/fire-check",
        "queryStringParameters": query,
    }


def deps(check=None):
    return a.Dependencies(s.Subscriptions(s.MemoryStore(), area=AREA), check_fire=check)


def test_api_checks_a_point_without_echoing_bad_input():
    seen = []

    def check(lat, lon):
        seen.append((lat, lon))
        return {"verdict": "not_seen"}

    ok = a.api_handler(api_event({"lat": "-25", "lon": "-61"}), deps=deps(check))
    assert ok["statusCode"] == 200 and seen == [(-25.0, -61.0)]
    bad = a.api_handler(api_event({"lat": "<script>", "lon": "-61"}), deps=deps(check))
    assert bad["statusCode"] == 400 and "<script>" not in bad["body"]


def test_api_without_satellite_data_says_so():
    response = a.api_handler(api_event({"lat": "-25", "lon": "-61"}), deps=deps())
    assert response["statusCode"] == 503


def test_api_failure_reading_data_is_a_502():
    def broken(lat, lon):
        raise RuntimeError("S3 down")

    response = a.api_handler(api_event({"lat": "-25", "lon": "-61"}), deps=deps(broken))
    assert response["statusCode"] == 502 and "S3" not in response["body"]


# ---------- the bot ----------


class Chat:
    def __init__(self):
        self.said = []

    def __call__(self, chat_id, text, markup=None):
        self.said.append((chat_id, text, markup))


def location_update(lat=-25.0, lon=-61.0, chat_type="private"):
    return {
        "message": {
            "chat": {"id": 7, "type": chat_type},
            "from": {"language_code": "es-AR"},
            "location": {"latitude": lat, "longitude": lon},
        }
    }


def test_report_command_offers_the_location_button():
    chat = Chat()
    update = {"message": {"chat": {"id": 7, "type": "private"}, "text": "/reportar"}}
    assert t.handle(update, s.Subscriptions(s.MemoryStore(), area=AREA), chat) == "report_how"
    _, text, markup = chat.said[0]
    assert "100" in text
    assert markup["keyboard"][0][0]["request_location"] is True


def test_a_shared_location_is_checked_and_answered():
    chat = Chat()
    calls = []

    def check(lat, lon):
        calls.append((lat, lon))
        return f.check(lat, lon, NOW, goes([goes_cell(-25.05, -61.02)]), [], 3)

    outcome = t.handle(
        location_update(),
        s.Subscriptions(s.MemoryStore(), area=AREA),
        chat,
        check_fire=check,
        now=lambda: NOW,
    )
    assert outcome == "seen_now" and calls == [(-25.0, -61.0)]
    _, text, markup = chat.said[0]
    assert text.startswith("🚒") and "GOES-19" in text
    assert markup == {"remove_keyboard": True}


def test_a_location_without_the_checker_still_gives_the_brigade():
    chat = Chat()
    assert (
        t.handle(location_update(), s.Subscriptions(s.MemoryStore(), area=AREA), chat)
        == "unavailable"
    )
    assert "100" in chat.said[0][1]


def test_locations_in_groups_or_out_of_range_are_ignored():
    chat = Chat()
    service = s.Subscriptions(s.MemoryStore(), area=AREA)
    assert t.handle(location_update(chat_type="group"), service, chat) == "ignored"
    assert t.handle(location_update(lat=200.0), service, chat) == "ignored"
    assert chat.said == []


def test_without_fresh_data_nothing_seen_is_unknown_not_no_fire():
    stale = goes([], generated=NOW - timedelta(hours=3))
    for layer, files in [(None, 3), (stale, 3), (goes([]), 0), (None, 0)]:
        result = f.check(*HERE, NOW, layer, [], files)
        assert result["verdict"] == "unknown"
        for language in ("es", "en"):
            text = f.message(result, language, NOW)
            assert text.startswith("🚒")
            assert "no quiere decir" not in text and "does not mean" not in text
    assert "No pude revisar" in f.message(f.check(*HERE, NOW, None, [], 0), "es", NOW)


def test_what_was_seen_still_counts_when_the_other_source_is_missing():
    body = (CSV_HEADER + nrt_row(-25.01, -61.01)).encode()
    assert f.check(*HERE, NOW, None, f.parse_nrt(body), 1)["verdict"] == "seen_recently"
    seen = f.check(*HERE, NOW, goes([goes_cell(-25.05, -61.02)]), [], 0)
    assert seen["verdict"] == "seen_now"
