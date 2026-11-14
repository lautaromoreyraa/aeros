from datetime import UTC, datetime

import h3
import pytest

import alerts
import notifier as n
import subscriptions as s

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]
FAR = h3.grid_ring(ORIGIN, 8)[0]
NOW = datetime(2026, 11, 14, 22, 30, tzinfo=UTC)


def report(*cells, window=("2026-11-08", "2026-11-14"), region=None):
    return {
        "window": list(window),
        "days_with_data": 7,
        "region": region or {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
        "cells": [
            {"cell": c, "observed": 30, "expected": 9.0, "ratio": r, "p_value": 0.001}
            for c, r in cells
        ],
    }


def wind_field(u=0.0):
    grid = {"west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 3, "ny": 3}
    return {
        "grid": grid,
        "hours": ["2026-11-14T22:00:00Z", "2026-11-14T23:00:00Z"],
        "u": [[u] * 9, [u] * 9],
        "v": [[0.0] * 9, [0.0] * 9],
    }


def weather_field(percentile):
    grid = {"west": -69.0, "south": -35.0, "east": -53.0, "north": -16.0, "nx": 3, "ny": 3}
    return {
        "grid": grid,
        "days": ["2026-11-14"],
        "hdw": [[200.0] * 9],
        "percentile": [[percentile] * 9],
        "levels": {"extreme": 95.0, "high": 90.0, "elevated": 75.0},
    }


class Outbox:
    def __init__(self, fail=False):
        self.sent: list[tuple[str, str, str, str]] = []
        self.fail = fail

    def __call__(self, subscription, subject, text):
        if self.fail:
            raise RuntimeError("POST https://api.telegram.org/bot123456:TOKEN/sendMessage failed")
        self.sent.append((subscription.channel, str(subscription.address), subject, text))


@pytest.fixture
def service():
    return s.Subscriptions(s.MemoryStore())


def subscribe(service, channel, cells, address=None):
    sub = service.create(channel, address, cells)
    if channel == "telegram":
        return service.confirm_telegram(sub.id, address or "42")
    return service.confirm_with_token(sub.id, sub.token)


def run(service, rep, outbox, **kwargs):
    senders = {"telegram": outbox, "email": outbox}
    return n.notify(rep, service, senders, now=NOW, **kwargs)


# ---------- who is told ----------


def test_only_the_subscribers_a_flagged_cell_can_reach_are_told(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    subscribe(service, "email", [NEIGHBOR], "ana@example.com")
    subscribe(service, "telegram", [FAR], "22")
    outbox = Outbox()
    summary = run(service, report((ORIGIN, 3.3)), outbox)
    assert summary == {
        "alert": True, "subscribers": 3, "reached": 2, "sent": 2,
        "unchanged": 0, "failed": 0, "no_channel": 0,
    }  # fmt: skip
    assert sorted(addr for _, addr, _, _ in outbox.sent) == ["11", "ana@example.com"]


def test_a_pending_subscription_hears_nothing(service):
    service.create("telegram", None, [ORIGIN])
    outbox = Outbox()
    assert run(service, report((ORIGIN, 3.3)), outbox)["subscribers"] == 0
    assert outbox.sent == []


def test_no_alert_or_an_alert_without_flagged_cells_sends_nothing(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    outbox = Outbox()
    assert run(service, report(), outbox)["alert"] is False
    region_only = report(
        region={"observed": 400, "expected": 100.0, "ratio": 4.0, "p_value": 0.0001}
    )
    assert run(service, region_only, outbox)["alert"] is False
    assert outbox.sent == []


def test_a_channel_nobody_can_send_on_is_counted_not_sent(service):
    subscribe(service, "email", [ORIGIN], "ana@example.com")
    summary = n.notify(report((ORIGIN, 3.3)), service, {}, now=NOW)
    assert (summary["reached"], summary["no_channel"], summary["sent"]) == (1, 1, 0)


# ---------- what they read ----------


def test_telegram_ends_with_the_stop_command_and_email_with_its_link(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    mail = subscribe(service, "email", [ORIGIN], "ana@example.com")
    outbox = Outbox()
    run(
        service,
        report((ORIGIN, 3.3)),
        outbox,
        web_url="https://aeros.example",
        unsubscribe_url=lambda sub: f"https://aeros.example/stop/{sub.id}/{sub.token}",
    )
    by_channel = {channel: (subject, text) for channel, _, subject, text in outbox.sent}
    assert "Stop these alerts: send /stop in this chat" in by_channel["telegram"][1]
    assert (
        f"Stop these alerts: https://aeros.example/stop/{mail.id}/{mail.token}"
        in by_channel["email"][1]
    )
    assert by_channel["email"][0].startswith("Early warning: 1 area near you well above normal")


def test_the_region_is_named_only_when_the_whole_region_is_alerting(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    outbox = Outbox()
    loud = {"observed": 400, "expected": 100.0, "ratio": 4.0, "p_value": 0.0001}
    run(service, report((ORIGIN, 3.3), region=loud), outbox)
    assert "the region is burning at 4.0× the usual" in outbox.sent[0][2]


def test_the_wind_and_the_fire_weather_of_the_moment_are_in_the_message(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    outbox = Outbox()
    run(
        service,
        report((ORIGIN, 3.3)),
        outbox,
        wind_field=wind_field(10.0),
        fire_weather=weather_field(93.0),
    )
    text = outbox.sent[0][3]
    assert "Wind near the fire: toward the east at 36 km/h." in text
    assert "Fire weather today: high, drier and windier than 93 %" in text


# ---------- when they are told again ----------


def test_the_same_alert_is_not_repeated_and_a_new_cell_is_(service):
    sub = subscribe(service, "telegram", [ORIGIN, NEIGHBOR], "11")
    outbox = Outbox()
    run(service, report((ORIGIN, 3.3)), outbox)
    assert len(outbox.sent) == 1 and service.store.get(sub.id).memory["cells"] == [ORIGIN]

    again = run(service, report((ORIGIN, 3.3)), outbox)
    assert (again["sent"], again["unchanged"]) == (0, 1) and len(outbox.sent) == 1

    worse = run(service, report((ORIGIN, 3.3), (NEIGHBOR, 2.0)), outbox)
    assert worse["sent"] == 1 and len(outbox.sent) == 2


def test_the_weather_alone_brings_a_second_message_only_when_it_turns_high(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    outbox = Outbox()
    rep = report((ORIGIN, 3.3))
    run(service, rep, outbox, fire_weather=weather_field(40.0))
    assert run(service, rep, outbox, fire_weather=weather_field(80.0))["sent"] == 0
    assert run(service, rep, outbox, fire_weather=weather_field(92.0))["sent"] == 1
    assert run(service, rep, outbox, fire_weather=weather_field(92.0))["sent"] == 0
    assert run(service, rep, outbox, fire_weather=weather_field(99.0))["sent"] == 1


def test_a_new_window_tells_them_again(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    outbox = Outbox()
    run(service, report((ORIGIN, 3.3)), outbox)
    next_week = report((ORIGIN, 3.3), window=("2026-11-15", "2026-11-21"))
    assert run(service, next_week, outbox)["sent"] == 1


# ---------- when sending fails ----------


def test_a_failed_send_is_not_remembered_so_the_next_run_tries_again(service, caplog):
    sub = subscribe(service, "telegram", [ORIGIN], "11")
    with caplog.at_level("ERROR"):
        summary = run(service, report((ORIGIN, 3.3)), Outbox(fail=True))
    assert (summary["failed"], summary["sent"]) == (1, 0)
    assert service.store.get(sub.id).memory is None
    assert "RuntimeError" in caplog.text and "123456" not in caplog.text

    retry = Outbox()
    assert run(service, report((ORIGIN, 3.3)), retry)["sent"] == 1 and len(retry.sent) == 1


def test_one_failure_does_not_stop_the_other_subscribers(service):
    subscribe(service, "telegram", [ORIGIN], "11")
    subscribe(service, "email", [ORIGIN], "ana@example.com")

    def only_telegram(subscription, subject, text):
        if subscription.channel == "email":
            raise RuntimeError("SES down")

    summary = n.notify(
        report((ORIGIN, 3.3)), service, {"telegram": only_telegram, "email": only_telegram}, now=NOW
    )
    assert (summary["sent"], summary["failed"]) == (1, 1)


# ---------- the real senders ----------


def test_the_telegram_sender_writes_to_the_chat_of_the_subscription():
    calls = []

    def post(url, body):
        calls.append((url, body))
        return {"ok": True}

    sub = s.Subscription("i", "telegram", "987", (ORIGIN,), None, "confirmed", "t", "now", None)
    n.telegram_sender(post, "BOT:TOKEN")(sub, "subject", "the text")
    assert calls == [
        ("https://api.telegram.org/botBOT:TOKEN/sendMessage",
         {"chat_id": "987", "text": "the text", "disable_web_page_preview": True}),
    ]  # fmt: skip
    with pytest.raises(alerts.AlertError):
        n.telegram_sender(lambda url, body: {"ok": False, "description": "blocked"}, "BOT:TOKEN")(
            sub, "s", "t"
        )


def test_the_email_sender_sends_one_message_to_the_address():
    class Ses:
        def __init__(self):
            self.calls = []

        def send_email(self, **kwargs):
            self.calls.append(kwargs)

    ses = Ses()
    sub = s.Subscription(
        "i", "email", "ana@example.com", (ORIGIN,), None, "confirmed", "t", "now", None
    )
    n.email_sender(ses, "alerts@aeros.example")(sub, "the subject", "the text")
    (call,) = ses.calls
    assert call["FromEmailAddress"] == "alerts@aeros.example"
    assert call["Destination"] == {"ToAddresses": ["ana@example.com"]}
    assert call["Content"]["Simple"]["Subject"]["Data"] == "the subject"
