"""A possible fire seen by GOES-19, told to the subscribers within 50 km of it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import h3
import pytest

import alert_text
import fire_alerts as fa
import subscriptions as s

NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
AREA = (-69.0, -35.0, -53.0, -16.0)
RESISTENCIA = {
    "name": "Resistencia",
    "region": "Chaco",
    "country": "Argentina",
    "lat": -27.45,
    "lng": -58.98,
}
SCANS = ["2026-11-14T17:50:00Z", "2026-11-14T17:40:00Z", "2026-11-14T17:30:00Z"]


def fire(lat, lng, persistent=True, last_seen="2026-11-14T17:45:00Z"):
    return {
        "cell": h3.latlng_to_cell(lat, lng, 4),
        "lat": lat,
        "lng": lng,
        "confident_scans": 2,
        "last_seen": last_seen,
        "persistent": persistent,
    }


def report(*cells):
    return {"scans": SCANS, "cells": list(cells)}


class Outbox:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.pins: list[tuple[float, float, str, str]] = []

    def send(self, subscription, subject, text):
        self.sent.append((subject, text))

    def pin(self, subscription, lat, lng, title, address):
        self.pins.append((lat, lng, title, address))


@pytest.fixture
def service():
    return s.Subscriptions(s.MemoryStore(), area=AREA)


def notify(service, rep, out, now=NOW):
    return fa.notify(
        rep, service, {"telegram": out.send}, pin_senders={"telegram": out.pin}, now=now
    )


def test_a_fire_within_50_km_of_the_town_is_told_with_its_distance_and_one_pin(service):
    service.subscribe_place(42, RESISTENCIA, "es")
    out = Outbox()
    # About 30 km north and about 45 km east of Resistencia.
    summary = notify(service, report(fire(-27.18, -58.98), fire(-27.45, -58.53)), out)
    assert summary["sent"] == 1
    ((subject, text),) = out.sent
    assert subject == "Posible incendio a unos 30 km al norte de Resistencia"
    assert "El satélite GOES-19 detecta fuego activo a unos 30 km al norte" in text
    assert "en 2 de sus últimas 3 pasadas" in text and "hace unos 15 minutos" in text
    assert "• También: a unos 45 km al este de Resistencia." in text
    assert "puede tratarse de una quema controlada" in text
    assert out.pins == [
        (
            -27.18,
            -58.98,
            "Posible incendio (ubicación aproximada)",
            "A unos 30 km al norte de Resistencia",
        )
    ]


def test_a_fire_farther_than_50_km_or_one_that_did_not_persist_is_not_told(service):
    service.subscribe_place(42, RESISTENCIA)
    out = Outbox()
    # About 65 km north: the neighbouring panel of the map, but past the 50 km.
    summary = notify(service, report(fire(-26.87, -58.98), fire(-27.3, -58.98, False)), out)
    assert summary["near"] == 0 and out.sent == []


def test_cells_chosen_on_the_map_hear_about_fires_in_those_cells(service):
    cell = h3.latlng_to_cell(-25.0, -61.0, 4)
    sub = service.create("telegram", None, [cell], language="en")
    service.confirm_telegram(sub.id, 7)
    out = Outbox()
    lat, lng = h3.cell_to_latlng(cell)
    notify(service, report(fire(lat, lng), fire(-30.0, -60.0)), out)
    ((subject, text),) = out.sent
    assert "Possible fire near you" in text and "the area you chose" in text
    assert "Also" not in text  # the far fire is not theirs


def test_one_message_every_12_hours_at_most(service):
    service.subscribe_place(42, RESISTENCIA)
    out = Outbox()
    notify(service, report(fire(-27.18, -58.98)), out)
    later = notify(service, report(fire(-27.45, -58.53)), out, now=NOW + timedelta(hours=3))
    assert later["quiet"] == 1 and len(out.sent) == 1
    notify(service, report(fire(-27.45, -58.53)), out, now=NOW + timedelta(hours=12, minutes=10))
    assert len(out.sent) == 2


def test_a_failed_send_is_not_remembered_so_the_next_run_tries_again(service):
    service.subscribe_place(42, RESISTENCIA)

    def broken(subscription, subject, text):
        raise RuntimeError("POST https://api.telegram.org/bot1:SECRET/sendMessage")

    summary = fa.notify(report(fire(-27.18, -58.98)), service, {"telegram": broken}, now=NOW)
    assert summary["failed"] == 1
    out = Outbox()
    assert notify(service, report(fire(-27.18, -58.98)), out)["sent"] == 1


def test_a_channel_without_a_sender_is_counted(service):
    service.subscribe_place(42, RESISTENCIA)
    summary = fa.notify(report(fire(-27.18, -58.98)), service, {}, now=NOW)
    assert summary["no_channel"] == 1


def test_the_english_message_and_the_time_since_the_last_scan():
    offset = (30.0, 0.0, "Resistencia")
    subject, text = alert_text.fire_message(
        [(fire(-27.18, -58.98, last_seen="2026-11-14T17:58:00Z"), offset)],
        "en",
        scans=3,
        now=NOW,
        map_links=True,
        unsubscribe="https://aeros.example/stop",
    )
    assert subject == "Possible fire about 30 km north of Resistencia"
    assert "Last seen a few minutes ago." in text
    assert "https://www.google.com/maps?q=-27.180,-58.980" in text
    assert "To stop these alerts: https://aeros.example/stop" in text
