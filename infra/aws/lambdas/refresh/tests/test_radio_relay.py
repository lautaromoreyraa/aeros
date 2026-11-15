"""The field gateway repeats the short fire text onto a radio. No radio is opened."""

from __future__ import annotations

import importlib.util
import json
from datetime import UTC, datetime, timedelta

import h3
import pytest

import alert_text
import radio_relay

NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


def fire(lat, lng, persistent=True):
    return {
        "cell": h3.latlng_to_cell(lat, lng, 4),
        "lat": lat,
        "lng": lng,
        "persistent": persistent,
    }


def report(*cells, stale=False):
    return {"scans": ["2026-11-14T17:50:00Z"], "cells": list(cells), "stale": stale}


RESISTENCIA = radio_relay.Post("Resistencia", -27.45, -58.98, "es")
FAR = radio_relay.Post("Ushuaia", -54.8, -68.3, "es")


class Mesh:
    def __init__(self, broken=False):
        self.texts: list[str] = []
        self.broken = broken

    def send(self, text: str) -> None:
        if self.broken:
            raise RuntimeError("serial port closed")
        self.texts.append(text)


def test_a_persistent_fire_within_50_km_is_the_same_short_text_as_an_sms():
    mesh = Mesh()
    memory: dict = {}
    summary = radio_relay.relay(
        report(fire(-27.18, -58.98)), [RESISTENCIA], mesh.send, memory, now=NOW
    )
    assert summary["sent"] == 1 and summary["skipped"] is None
    assert mesh.texts == [alert_text.fire_sms("es", "Resistencia")]
    assert "http" not in mesh.texts[0]
    assert memory["Resistencia"]["fire_told_at"] == "2026-11-14T18:00:00+00:00"


def test_a_far_fire_a_flicker_and_a_stale_report_send_nothing():
    mesh = Mesh()
    memory: dict = {}
    far = radio_relay.relay(
        report(fire(-26.87, -58.98), fire(-27.3, -58.98, persistent=False)),
        [RESISTENCIA],
        mesh.send,
        memory,
        now=NOW,
    )
    stale = radio_relay.relay(
        report(fire(-27.18, -58.98), stale=True), [RESISTENCIA], mesh.send, memory, now=NOW
    )
    assert far["near"] == 0 and stale["skipped"] == "stale"
    assert mesh.texts == [] and memory == {}


def test_only_the_post_near_the_fire_is_told_and_not_again_for_12_hours():
    mesh = Mesh()
    memory: dict = {}
    radio_relay.relay(report(fire(-27.18, -58.98)), [RESISTENCIA, FAR], mesh.send, memory, now=NOW)
    quiet = radio_relay.relay(
        report(fire(-27.18, -58.98)),
        [RESISTENCIA, FAR],
        mesh.send,
        memory,
        now=NOW + timedelta(hours=3),
    )
    assert mesh.texts == [alert_text.fire_sms("es", "Resistencia")]
    assert quiet["quiet"] == 1 and quiet["sent"] == 0
    radio_relay.relay(
        report(fire(-27.18, -58.98)),
        [RESISTENCIA],
        mesh.send,
        memory,
        now=NOW + timedelta(hours=12, minutes=10),
    )
    assert len(mesh.texts) == 2


def test_a_failed_send_is_not_remembered_so_the_next_run_tries_again():
    memory: dict = {}
    failed = radio_relay.relay(
        report(fire(-27.18, -58.98)), [RESISTENCIA], Mesh(broken=True).send, memory, now=NOW
    )
    assert failed["failed"] == 1 and memory == {}
    mesh = Mesh()
    assert radio_relay.relay(
        report(fire(-27.18, -58.98)), [RESISTENCIA], mesh.send, memory, now=NOW
    )["sent"] == 1


def test_an_english_post_gets_the_english_text():
    mesh = Mesh()
    post = radio_relay.Post("Resistencia", -27.45, -58.98, "en")
    radio_relay.relay(report(fire(-27.18, -58.98)), [post], mesh.send, {}, now=NOW)
    assert mesh.texts == [alert_text.fire_sms("en", "Resistencia")]


def test_posts_need_a_short_unique_name_and_a_real_position():
    with pytest.raises(ValueError, match="at least one"):
        radio_relay.load_posts({"posts": []})
    with pytest.raises(ValueError, match="twice"):
        radio_relay.load_posts(
            {"posts": [{"name": "A", "lat": 1, "lng": 2}, {"name": "A", "lat": 3, "lng": 4}]}
        )
    with pytest.raises(ValueError, match="out of range"):
        radio_relay.load_posts({"posts": [{"name": "A", "lat": 91, "lng": 0}]})
    with pytest.raises(ValueError, match="language"):
        radio_relay.load_posts({"posts": [{"name": "A", "lat": 1, "lng": 2, "language": "pt"}]})


def test_a_url_report_uses_the_injected_fetch_and_never_the_network():
    body = json.dumps(report(fire(-27.18, -58.98))).encode()
    seen: list[str] = []

    def fetch(url: str) -> bytes:
        seen.append(url)
        return body

    loaded = radio_relay.read_report("https://aeros.example/goes_latest.json", fetch=fetch)
    assert seen == ["https://aeros.example/goes_latest.json"]
    assert loaded["cells"][0]["persistent"] is True
    with pytest.raises(ValueError, match="not JSON"):
        radio_relay.read_report("https://aeros.example/nope", fetch=lambda url: b"nope")


def test_print_remembers_the_post_and_a_second_run_stays_quiet(tmp_path, capsys):
    report_path = tmp_path / "goes_latest.json"
    posts_path = tmp_path / "posts.json"
    memory_path = tmp_path / "told.json"
    report_path.write_text(json.dumps(report(fire(-27.18, -58.98))), encoding="utf-8")
    posts_path.write_text(
        json.dumps({"posts": [{"name": "Resistencia", "lat": -27.45, "lng": -58.98}]}),
        encoding="utf-8",
    )
    args = [
        "--report",
        str(report_path),
        "--posts",
        str(posts_path),
        "--memory",
        str(memory_path),
        "--print",
        "--now",
        "2026-11-14T18:00:00+00:00",
    ]
    assert radio_relay.main(args) == 0
    assert "Resistencia" in capsys.readouterr().out
    assert "fire_told_at" in memory_path.read_text(encoding="utf-8")
    assert radio_relay.main(args) == 0
    assert capsys.readouterr().out == ""


def test_a_missing_radio_library_is_a_clear_error_and_does_not_open_a_port():
    if importlib.util.find_spec("meshtastic") is not None:
        pytest.skip("meshtastic is installed; this check is for a gateway without it")
    with pytest.raises(radio_relay.RadioError, match="meshtastic"):
        radio_relay.open_radio("/dev/ttyUSB0")
