from __future__ import annotations

import json
from datetime import UTC, date, datetime

import h3
import pytest

import refresh
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


def report(window=("2026-11-08", "2026-11-14")):
    return {
        "window": list(window),
        "days_with_data": [d for d in window],
        "region": {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
        "cells": [
            {"cell": ORIGIN, "observed": 30, "expected": 9.0, "ratio": 3.3, "p_value": 0.001}
        ],
    }


@pytest.fixture
def store():
    store = s.MemoryStore()
    service = s.Subscriptions(store, area=AREA)
    chat = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(chat.id, 4242)
    mail = service.create("email", "ana@example.com", [ORIGIN])
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


def test_every_confirmed_subscriber_is_told_on_the_channel_they_chose(store):
    post, calls = posts()
    ses = FakeSes()
    summary = sa.run(
        report(), settings(), store=store, s3=FakeS3(), ssm=parameters(), ses=ses, post=post
    )
    assert (summary["sent"], summary["failed"], summary["no_channel"]) == (2, 0, 0)
    (url, body) = calls[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendMessage" and body["chat_id"] == "4242"
    assert "send /stop in this chat" in body["text"]
    (mail,) = ses.calls
    assert mail["Destination"] == {"ToAddresses": ["ana@example.com"]}
    text = mail["Content"]["Simple"]["Body"]["Text"]["Data"]
    assert (
        "https://aeros.example/api/alerts/subscriptions/" in text and "/unsubscribe?token=" in text
    )


def test_a_channel_without_its_parameter_is_counted_not_sent(store):
    post, calls = posts()
    summary = sa.run(
        report(),
        settings(),
        store=store,
        s3=FakeS3(),
        ssm=parameters(telegram=sa.alerts.TELEGRAM_TOKEN_PARAMETER),
        ses=FakeSes(),
        post=post,
    )
    assert (summary["sent"], summary["no_channel"]) == (1, 1) and calls == []


def test_the_wind_and_fire_weather_files_are_used_when_they_exist_and_skipped_when_not(store):
    post, calls = posts()
    grid = {"west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 3, "ny": 3}
    wind = {
        "grid": grid,
        "hours": ["2026-11-14T06:00:00Z", "2026-11-14T07:00:00Z"],
        "u": [[10.0] * 9, [10.0] * 9],
        "v": [[0.0] * 9, [0.0] * 9],
    }
    sa.run(
        report(),
        settings(wind_key="derived/wind.json", fire_weather_key="derived/fire_weather.json"),
        store=store,
        s3=FakeS3({"derived/wind.json": wind}),
        ssm=parameters(),
        ses=FakeSes(),
        post=post,
        now=NOW,
    )
    assert "Wind near the fire: toward the east" in calls[0][1]["text"]
    assert "Fire weather" not in calls[0][1]["text"]  # that file does not exist: no line, no error


def test_a_broken_optional_file_never_stops_the_alert(store):
    class Exploding(FakeS3):
        def get_object(self, Bucket, Key):  # noqa: N803
            raise AwsError("InternalError")

    post, _ = posts()
    summary = sa.run(
        report(),
        settings(wind_key="derived/wind.json"),
        store=store,
        s3=Exploding(),
        ssm=parameters(),
        ses=FakeSes(),
        post=post,
    )
    assert summary["sent"] == 2


def test_pending_sign_ups_past_their_day_are_purged_on_every_run(store):
    service = s.Subscriptions(store, now=lambda: datetime(2026, 11, 1, tzinfo=UTC), area=AREA)
    stale = service.create("telegram", None, [ORIGIN])
    sa.run(
        report(), settings(), store=store, s3=FakeS3(), ssm=parameters(),
        ses=FakeSes(), post=posts()[0], now=NOW,
    )  # fmt: skip
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
    assert found.fire_weather_key is None


# ---------- inside the daily run ----------


def daily(store, **overrides):
    post, calls = posts()
    ssm = parameters()
    base = dict(
        bucket="data",
        prefix="raw/firms/",
        map_key_parameter="/aeros/firms/map-key",
        area="-69,-35,-53,-16",
        sources=("VIIRS_NOAA20_NRT",),
        days_back=7,
        early_warning_key="derived/early_warning.json",
        subscriber_settings=settings(),
    )
    base.update(overrides)
    ssm.values["/aeros/firms/map-key"] = "abcdef0123456789abcdef0123456789"
    s3 = FakeS3()
    summary = refresh.handler(
        {},
        None,
        settings=refresh.Settings(**base),
        s3=s3,
        ssm=ssm,
        fetch=lambda url: b"latitude,longitude,bright_ti4\n",
        now=NOW,
        early_warning=lambda downloads, days, now: report(),
        ses=FakeSes(),
        post=post,
        subscriptions_store=store,
    )
    return summary, calls


def test_the_daily_run_tells_the_subscribers_after_publishing_the_report(store):
    summary, calls = daily(store)
    assert summary["subscribers"]["sent"] == 2 and len(calls) == 1


def test_a_second_run_with_the_same_report_tells_nobody_again(store):
    daily(store)
    summary, calls = daily(store)
    assert summary["subscribers"]["sent"] == 0 and summary["subscribers"]["unchanged"] == 2


def test_without_subscriber_settings_the_run_does_not_touch_subscribers(store):
    summary, calls = daily(store, subscriber_settings=None)
    assert "subscribers" not in summary and calls == []


def test_a_subscriber_failure_never_fails_the_run(store):
    class Broken:
        def all(self):
            raise RuntimeError("dynamo down")

    summary, _ = daily(Broken())
    assert summary["subscribers"] == "failed" and summary["early_warning"]["flagged_cells"] == 1
    assert date(2026, 11, 14) == NOW.date()
