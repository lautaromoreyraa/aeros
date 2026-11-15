"""Where the fire is: the place of a flagged cell, the map pin and the map link."""

from datetime import UTC, date, datetime

import h3
import pytest

import alert_text as t
import alerts
import early_warning as ew
import notifier as n
import subscriptions as s
import targeting

RES = 4
CELL = h3.latlng_to_cell(-27.45, -58.98, RES)
NOW = datetime(2026, 11, 14, 22, 30, tzinfo=UTC)


def entry(cell=CELL, **extra):
    return {"cell": cell, "observed": 203, "expected": 0.6, "ratio": 339.7, "p_value": 0.0, **extra}


def report(*entries):
    return {
        "window": ["2026-11-08", "2026-11-14"],
        "days_with_data": 7,
        "region": {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
        "cells": list(entries),
    }


# ---------- the place of a flagged cell ----------


def test_the_early_warning_places_each_flagged_cell_where_its_detections_are():
    # Three detections, all in the cell and all to its north-east: their mean is where the fire
    # is, a few kilometres from the cell's centre, which is what goes on the map.
    lat, lng = h3.cell_to_latlng(CELL)
    points = ((lat + 0.04, lng + 0.02), (lat + 0.06, lng + 0.04), (lat + 0.05, lng + 0.03))
    assert {h3.latlng_to_cell(*p, RES) for p in points} == {CELL}
    day = ew.Day(date(2026, 11, 8), "ok", "VIIRS_NOAA20_NRT", points * 10)
    clim = ew.Climatology(RES, frozenset(), (1,), {CELL: {1: 1.0}})
    (flagged,) = ew.build_report([day], clim, NOW)["cells"]
    assert (flagged["lat"], flagged["lng"]) == (round(lat + 0.05, 2), round(lng + 0.03, 2))
    assert flagged["observed"] == 30


def test_place_of_prefers_the_detections_and_falls_back_to_the_cell_centre():
    assert targeting.place_of(entry(lat=-27.45, lng=-58.97)) == (-27.45, -58.97)
    assert targeting.place_of(entry()) == h3.cell_to_latlng(CELL)
    assert targeting.place_of(entry(lat=None, lng=None)) == h3.cell_to_latlng(CELL)


def test_the_map_link_opens_in_any_phone():
    assert targeting.map_link(-20.8, -61.2) == "https://www.google.com/maps?q=-20.800,-61.200"


# ---------- the Telegram pin ----------


def test_the_venue_goes_to_the_chat_with_a_name_and_a_refusal_is_an_error():
    calls = []

    def post(url, body):
        calls.append((url, body))
        return {"ok": True}

    alerts.send_telegram_venue(post, "BOT:TOKEN", "987", -20.8, -61.2, "Title", "Address")
    assert calls == [
        (
            "https://api.telegram.org/botBOT:TOKEN/sendVenue",
            {
                "chat_id": "987",
                "latitude": -20.8,
                "longitude": -61.2,
                "title": "Title",
                "address": "Address",
            },
        )
    ]
    with pytest.raises(alerts.AlertError, match="refused the location"):
        alerts.send_telegram_venue(
            lambda url, body: {"ok": False, "description": "bad"}, "T", "1", 0, 0, "t", "a"
        )


def test_the_pin_says_it_is_approximate_in_the_readers_language():
    assert t.venue_text("es", "Chaco Boreal") == (
        "Zona con mucho fuego (aproximada)",
        "Chaco Boreal · dentro de unos 20 km",
    )
    assert t.venue_text("en", "Chaco Boreal")[0] == "Area with a lot of fire (approximate)"


# ---------- the message around the pin ----------


def match(*entries):
    return targeting.Match(
        targeting.Subscriber("i", "telegram", "1", frozenset([CELL])), tuple(entries)
    )


def test_with_pins_the_spanish_text_drops_the_coordinates_and_points_to_the_map():
    _, text = t.format_message(match(entry(lat=-27.45, lng=-58.97)), report(), "es", pins=True)
    assert "27,4" not in text and "58,9" not in text and "° S" not in text
    assert "Abajo le mando la ubicación aproximada en el mapa." in text
    assert "• Gran Chaco: unas 340 veces lo habitual." in text


def test_with_map_links_each_zone_gets_a_link_instead_of_coordinates():
    _, text = t.format_message(match(entry(lat=-27.45, lng=-58.97)), report(), "es", map_links=True)
    assert (
        "Ver la ubicación aproximada en el mapa: https://www.google.com/maps?q=-27.450,-58.970"
        in text
    )
    assert "° S" not in text and "Abajo le mando" not in text


def test_without_either_the_spanish_text_still_says_where():
    _, text = t.format_message(match(entry(lat=-27.45, lng=-58.97)), report(), "es")
    assert "(cerca de 27,4° S, 59,0° O)" in text or "(cerca de 27,5° S, 59,0° O)" in text


def test_english_keeps_its_coordinates_and_adds_a_link_for_e_mail():
    _, plain = t.format_message(match(entry(lat=-27.45, lng=-58.97)), report(), "en")
    assert "27.4° S, 59.0° W" in plain or "27.5° S, 59.0° W" in plain
    _, linked = t.format_message(
        match(entry(lat=-27.45, lng=-58.97)), report(), "en", map_links=True
    )
    assert "Approximate location: https://www.google.com/maps?q=-27.450,-58.970" in linked


# ---------- the notifier sends the pins after the message ----------


class Outbox:
    def __init__(self):
        self.events: list[tuple] = []

    def message(self, subscription, subject, text):
        self.events.append(("message", subscription.channel, text))

    def pins(self, subscription, places):
        self.events.append(("pins", places))


def subscribe(service, channel, address, language="es"):
    sub = service.create(
        channel, address if channel == "email" else None, [CELL], language=language
    )
    if channel == "telegram":
        return service.confirm_telegram(sub.id, address)
    return service.confirm_with_token(sub.id, sub.token)


def run(service, rep, outbox, place_senders=True, **kwargs):
    return n.notify(
        rep,
        service,
        {"telegram": outbox.message, "email": outbox.message},
        place_senders={"telegram": outbox.pins} if place_senders else None,
        now=NOW,
        **kwargs,
    )


def test_a_telegram_subscriber_gets_the_message_then_one_pin_per_zone():
    service = s.Subscriptions(s.MemoryStore())
    subscribe(service, "telegram", "11")
    box = Outbox()
    run(service, report(entry(lat=-27.45, lng=-58.97)), box, sector_of={CELL: "Chaco Seco"})
    assert [e[0] for e in box.events] == ["message", "pins"]
    assert box.events[1][1] == [(-27.45, -58.97, "Chaco Seco")]
    assert "Abajo le mando la ubicación" in box.events[0][2]


def test_one_pin_only_and_the_others_are_counted_in_the_text():
    service = s.Subscriptions(s.MemoryStore())
    sub = service.create("telegram", None, list(h3.grid_disk(CELL, 1)))
    service.confirm_telegram(sub.id, "11")
    cells = h3.grid_disk(CELL, 1)[:5]
    box = Outbox()
    run(service, report(*[entry(c) for c in cells]), box)
    (_, places) = box.events[1]
    assert len(places) == 1 and places[0][:2] == h3.cell_to_latlng(CELL)
    assert "• y 4 zonas más con mucho fuego." in box.events[0][2]
    assert box.events[0][2].count("• Gran Chaco") == 1


FAR = h3.latlng_to_cell(-20.8, -61.2, RES)  # the strongest fire of the region, in Paraguay
NEAR = h3.grid_ring(CELL, 2)[0]


def test_the_zone_shown_is_the_nearest_to_the_subscriber_not_the_strongest():
    subscriber = targeting.Subscriber("i", "telegram", "1", frozenset([CELL]))
    both = targeting.Match(subscriber, (entry(FAR, ratio=339.7), entry(NEAR, ratio=5.0)))
    first = targeting.nearest_first(both).flagged[0]
    assert first["cell"] == NEAR
    # Equally near: the stronger signal first.
    twin = targeting.Match(subscriber, (entry(NEAR, ratio=5.0), entry(CELL, ratio=9.0)))
    assert targeting.nearest_first(twin).flagged[0]["cell"] == CELL


def test_the_pin_marks_the_nearest_fire_even_when_a_neighbouring_one_is_stronger():
    service = s.Subscriptions(s.MemoryStore())
    subscribe(service, "telegram", "11")  # subscribed to CELL only
    box = Outbox()
    neighbour = h3.grid_ring(CELL, 1)[0]  # its risk zone reaches CELL, and it burns much more
    run(service, report(entry(neighbour, ratio=339.7), entry(CELL, ratio=5.0)), box)
    (_, places) = box.events[1]
    assert len(places) == 1 and places[0][:2] == h3.cell_to_latlng(CELL)


def test_e_mail_gets_links_and_never_a_pin():
    service = s.Subscriptions(s.MemoryStore())
    subscribe(service, "email", "ana@example.com")
    box = Outbox()
    run(service, report(entry(lat=-27.45, lng=-58.97)), box)
    assert [e[0] for e in box.events] == ["message"]
    assert "google.com/maps?q=-27.450,-58.970" in box.events[0][2]


def test_a_failing_pin_does_not_fail_the_alert_or_make_it_repeat(caplog):
    service = s.Subscriptions(s.MemoryStore())
    sub = subscribe(service, "telegram", "11")
    box = Outbox()

    def broken(subscription, places):
        raise RuntimeError("POST https://api.telegram.org/botSECRET:TOKEN/sendVenue failed")

    summary = n.notify(
        report(entry(lat=-27.45, lng=-58.97)),
        service,
        {"telegram": box.message},
        place_senders={"telegram": broken},
        now=NOW,
    )
    assert (summary["sent"], summary["failed"], summary["pins_failed"]) == (1, 0, 1)
    assert service.store.get(sub.id).memory is not None  # remembered: no second message
    assert "RuntimeError" in caplog.text and "SECRET" not in caplog.text
    again = run(service, report(entry(lat=-27.45, lng=-58.97)), box)
    assert again["sent"] == 0


def test_without_a_place_sender_telegram_still_says_how_far_in_words():
    service = s.Subscriptions(s.MemoryStore())
    subscribe(service, "telegram", "11")
    box = Outbox()
    run(service, report(entry(lat=-27.45, lng=-58.97)), box, place_senders=False)
    assert [e[0] for e in box.events] == ["message"]
    assert "de la zona que eligió" in box.events[0][2]
    assert "° S" not in box.events[0][2]


def test_the_real_place_sender_names_the_pin_in_the_subscribers_language():
    calls = []

    def post(url, body):
        calls.append((url.rsplit("/", 1)[1], body))
        return {"ok": True}

    service = s.Subscriptions(s.MemoryStore())
    sub = subscribe(service, "telegram", "987", language="en")
    n.telegram_place_sender(post, "BOT:TOKEN")(sub, [(-27.45, -58.97, "Chaco Seco")])
    (method, body) = calls[0]
    assert method == "sendVenue" and body["chat_id"] == "987"
    assert body["title"] == "Area with a lot of fire (approximate)"
    assert body["address"] == "Chaco Seco · within about 20 km"
