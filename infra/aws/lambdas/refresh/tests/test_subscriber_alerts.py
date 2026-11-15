from __future__ import annotations

import json
from datetime import UTC, datetime

import h3
import pytest

import subscriber_alerts as sa
import subscriptions as s

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
AREA = (-69.0, -35.0, -53.0, -16.0)
NOW = datetime(2026, 11, 14, 6, 0, tzinfo=UTC)
TOKEN = "123456:BOT-TOKEN"


class AwsError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self, files=None):
        self.files = files or {}
        self.objects: dict[str, dict] = {}

    def get_object(self, Bucket, Key):  # noqa: N803 (boto3 signature)
        if Key not in self.files:
            raise AwsError("NoSuchKey")
        return {
            "Body": type("Body", (), {"read": lambda _: json.dumps(self.files[Key]).encode()})()
        }

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs


class FakeSsm:
    def __init__(self, values):
        self.values = values

    def get_parameter(self, Name, WithDecryption):  # noqa: N803 (boto3 signature)
        if Name not in self.values:
            raise AwsError("ParameterNotFound")
        return {"Parameter": {"Value": self.values[Name]}}


class FakeSes:
    def __init__(self):
        self.calls = []

    def send_email(self, **kwargs):
        self.calls.append(kwargs)


def settings(**overrides):
    base = dict(bucket="data", web_url="https://aeros.example", area=AREA)
    base.update(overrides)
    return sa.SubscriberSettings(**base)


def report(cell=ORIGIN, persistent=True):
    """A `goes_latest.json` with one cell that GOES-19 saw burning in 2 of its 3 scans."""
    lat, lng = h3.cell_to_latlng(cell)
    return {
        "scans": ["2026-11-14T05:50:00Z", "2026-11-14T05:40:00Z", "2026-11-14T05:30:00Z"],
        "cells": [
            {
                "cell": cell,
                "lat": round(lat, 3),
                "lng": round(lng, 3),
                "confident_scans": 2,
                "last_seen": "2026-11-14T05:50:00Z",
                "persistent": persistent,
            }
        ],
    }


@pytest.fixture
def store():
    store = s.MemoryStore()
    service = s.Subscriptions(store, area=AREA)
    chat = service.create("telegram", None, [ORIGIN], language="en")
    service.confirm_telegram(chat.id, 4242)
    mail = service.create("email", "ana@example.com", [ORIGIN], language="en")
    service.confirm_with_token(mail.id, mail.token)
    return store


def posts():
    calls = []

    def post(url, body):
        calls.append((url, body))
        return {"ok": True}

    return post, calls


def parameters(**missing):
    values = {
        sa.alerts.TELEGRAM_TOKEN_PARAMETER: TOKEN,
        sa.alerts.EMAIL_FROM_PARAMETER: "alerts@aeros.example",
    }
    return FakeSsm({k: v for k, v in values.items() if k not in missing.values()})


def run(store, rep=None, **overrides):
    post, calls = posts()
    ses = FakeSes()
    args = dict(store=store, s3=FakeS3(), ssm=parameters(), ses=ses, post=post, now=NOW)
    args.update(overrides)
    summary = sa.run(rep or report(), args.pop("settings", settings()), **args)
    return summary, calls, ses


def test_every_subscriber_near_the_fire_is_told_on_the_channel_they_chose(store):
    summary, calls, ses = run(store)
    assert (summary["sent"], summary["failed"], summary["no_channel"]) == (2, 0, 0)
    # The Telegram message and, right after it, the pin of the fire.
    assert [url.rsplit("/", 1)[1] for url, _ in calls] == ["sendMessage", "sendVenue"]
    (url, body) = calls[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendMessage" and body["chat_id"] == "4242"
    assert "Possible fire near you" in body["text"] and "send /stop in this chat" in body["text"]
    assert calls[1][1]["title"] == "Possible fire (approximate)"
    (mail,) = ses.calls
    assert mail["Destination"] == {"ToAddresses": ["ana@example.com"]}
    text = mail["Content"]["Simple"]["Body"]["Text"]["Data"]
    assert "https://www.google.com/maps?q=" in text
    assert (
        "https://aeros.example/api/alerts/subscriptions/" in text and "/unsubscribe?token=" in text
    )


def test_a_fire_that_did_not_persist_or_burns_elsewhere_tells_nobody(store):
    summary, calls, _ = run(store, report(persistent=False))
    assert summary["sent"] == 0 and calls == []
    far = h3.latlng_to_cell(-30.0, -60.0, 4)
    summary, calls, _ = run(store, report(far))
    assert summary["near"] == 0 and calls == []


def test_a_channel_without_its_parameter_is_counted_not_sent(store):
    summary, calls, _ = run(store, ssm=parameters(telegram=sa.alerts.TELEGRAM_TOKEN_PARAMETER))
    assert (summary["sent"], summary["no_channel"]) == (1, 1) and calls == []


def test_the_wind_file_is_used_when_it_exists_and_a_broken_one_never_stops_the_alert(store):
    grid = {"west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 3, "ny": 3}
    wind = {
        "grid": grid,
        "hours": ["2026-11-14T06:00:00Z", "2026-11-14T07:00:00Z"],
        "u": [[10.0] * 9, [10.0] * 9],
        "v": [[0.0] * 9, [0.0] * 9],
    }
    with_wind = settings(wind_key="derived/wind.json")
    _, calls, _ = run(store, settings=with_wind, s3=FakeS3({"derived/wind.json": wind}))
    assert "The wind blows toward the east" in calls[0][1]["text"]

    class Exploding(FakeS3):
        def get_object(self, Bucket, Key):  # noqa: N803
            raise AwsError("InternalError")

    fresh = s.MemoryStore()
    service = s.Subscriptions(fresh, area=AREA)
    chat = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(chat.id, 1)
    summary, _, _ = run(fresh, settings=with_wind, s3=Exploding())
    assert summary["sent"] == 1


def test_pending_sign_ups_past_their_day_are_purged_on_every_run(store):
    service = s.Subscriptions(store, now=lambda: datetime(2026, 11, 1, tzinfo=UTC), area=AREA)
    stale = service.create("telegram", None, [ORIGIN])
    run(store)
    assert store.get(stale.id) is None


def test_the_settings_come_from_the_environment_or_are_off(monkeypatch):
    monkeypatch.delenv("SUBSCRIPTIONS_TABLE", raising=False)
    assert sa.SubscriberSettings.from_environment() is None
    monkeypatch.setenv("SUBSCRIPTIONS_TABLE", "t")
    monkeypatch.setenv("DATA_BUCKET", "data")
    monkeypatch.setenv("FIRMS_AREA", "-69,-35,-53,-16")
    monkeypatch.setenv("WIND_KEY", "derived/wind.json")
    found = sa.SubscriberSettings.from_environment()
    assert found.area == AREA and found.wind_key == "derived/wind.json"
