import io
import json
import urllib.error

import h3
import pytest

import alerts
import notifier
import subscriber_alerts as sa
import subscriptions as s

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
KEY = "re_SECRET_KEY_123"


class AwsError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


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


class Resend:
    """A stand-in for the Resend endpoint: remembers what it was sent."""

    def __init__(self, fail_for=()):
        self.calls: list[dict] = []
        self.fail_for = fail_for

    def __call__(self, url, body):
        assert url == alerts.RESEND_API
        if body["to"][0] in self.fail_for:
            raise alerts.AlertError("Resend answered HTTP 422")
        self.calls.append(body)
        return {"id": f"msg-{len(self.calls)}"}


def parameters(resend=True, sender=True):
    values = {}
    if sender:
        values[alerts.EMAIL_FROM_PARAMETER] = "aeros <alerts@aeros.example>"
    if resend:
        values[alerts.RESEND_KEY_PARAMETER] = KEY
    return FakeSsm(values)


def build(ssm, ses=None, post=None):
    return alerts.email_sender_from_parameters(
        ssm,
        from_parameter=alerts.EMAIL_FROM_PARAMETER,
        resend_key_parameter=alerts.RESEND_KEY_PARAMETER,
        ses=ses or FakeSes(),
        make_resend_post=lambda key: post or Resend(),
    )


def test_one_message_per_recipient_goes_through_resend():
    post = Resend()
    sent = alerts.send_resend(
        post, "alerts@aeros.example", ["a@x.com", "b@x.com"], "Subject", "Text"
    )
    assert sent == 2
    assert [c["to"] for c in post.calls] == [["a@x.com"], ["b@x.com"]]
    assert post.calls[0] == {
        "from": "alerts@aeros.example",
        "to": ["a@x.com"],
        "subject": "Subject",
        "text": "Text",
    }


def test_one_failing_recipient_does_not_stop_the_others_and_none_sent_raises(caplog):
    post = Resend(fail_for=("a@x.com",))
    with caplog.at_level("ERROR"):
        assert alerts.send_resend(post, "s@x.com", ["a@x.com", "b@x.com"], "s", "t") == 1
    assert "AlertError" in caplog.text and "a@x.com" not in caplog.text
    with pytest.raises(alerts.AlertError):
        alerts.send_resend(Resend(fail_for=("a@x.com",)), "s@x.com", ["a@x.com"], "s", "t")


def test_an_answer_without_an_id_is_not_a_sent_message():
    with pytest.raises(alerts.AlertError):
        alerts.send_resend(lambda url, body: {}, "s@x.com", ["a@x.com"], "s", "t")


def test_resend_is_used_when_its_key_exists_and_ses_stays_untouched():
    post, ses = Resend(), FakeSes()
    send = build(parameters(), ses=ses, post=post)
    assert send(["a@x.com"], "subject", "text") == 1
    assert len(post.calls) == 1 and ses.calls == []


def test_ses_is_the_fallback_without_a_key():
    post, ses = Resend(), FakeSes()
    send = build(parameters(resend=False), ses=ses, post=post)
    send(["a@x.com"], "subject", "text")
    assert post.calls == [] and len(ses.calls) == 1


def test_without_a_sender_there_is_no_e_mail_channel_at_all():
    assert build(parameters(sender=False)) is None
    assert build(parameters(resend=False, sender=False)) is None


def test_the_resend_post_signs_the_request_and_never_leaks_the_key(monkeypatch):
    seen = {}

    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(request, timeout):
        seen["auth"] = request.get_header("Authorization")
        seen["agent"] = request.get_header("User-agent")
        return Response(json.dumps({"id": "abc"}).encode())

    monkeypatch.setattr(alerts.urllib.request, "urlopen", fake_urlopen)
    assert alerts.resend_post(KEY)(alerts.RESEND_API, {"to": ["a@x.com"]}) == {"id": "abc"}
    assert seen == {"auth": f"Bearer {KEY}", "agent": "aeros-alerts"}

    def refuse(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url, 401, "no", {}, io.BytesIO(b'{"message": "API key is invalid"}')
        )

    monkeypatch.setattr(alerts.urllib.request, "urlopen", refuse)
    with pytest.raises(alerts.AlertError) as info:
        alerts.resend_post(KEY)(alerts.RESEND_API, {})
    assert "Resend answered HTTP 401 API key is invalid" in str(info.value)
    assert KEY not in str(info.value)


def test_the_daily_list_uses_the_same_choice_of_provider():
    post = Resend()
    settings = alerts.AlertSettings(state_key="k", web_url="", region_name="R", area="")
    ssm = FakeSsm(
        {
            alerts.EMAIL_FROM_PARAMETER: "alerts@aeros.example",
            alerts.EMAIL_TO_PARAMETER: "a@x.com, b@x.com",
            alerts.RESEND_KEY_PARAMETER: KEY,
        }
    )
    original = alerts.resend_post
    alerts.resend_post = lambda key: post
    try:
        channels = alerts.deliver("subject", "text", settings, ssm=ssm, ses=FakeSes())
    finally:
        alerts.resend_post = original
    assert channels["email"] == "sent to 2 of 2" and len(post.calls) == 2


def test_the_daily_list_skips_e_mail_without_recipients_or_sender():
    settings = alerts.AlertSettings(state_key="k", web_url="", region_name="R", area="")
    assert alerts.deliver("s", "t", settings, ssm=parameters())["email"] == "skipped"
    ssm = FakeSsm({alerts.EMAIL_TO_PARAMETER: "a@x.com"})
    assert alerts.deliver("s", "t", settings, ssm=ssm)["email"] == "skipped"


def test_a_subscriber_gets_the_alert_by_resend_through_the_notifier():
    post = Resend()
    store = s.MemoryStore()
    service = s.Subscriptions(store)
    sub = service.create("email", "ana@example.com", [ORIGIN], language="en")
    service.confirm_with_token(sub.id, sub.token)
    send = build(parameters(), post=post)
    report = {
        "window": ["2026-11-08", "2026-11-14"],
        "days_with_data": 7,
        "region": {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
        "cells": [
            {"cell": ORIGIN, "observed": 30, "expected": 9.0, "ratio": 3.3, "p_value": 0.001}
        ],
    }
    summary = notifier.notify(report, service, {"email": notifier.mail_sender(send)})
    assert summary["sent"] == 1
    (call,) = post.calls
    assert call["to"] == ["ana@example.com"] and call["subject"].startswith("Early warning")


def test_the_subscriber_run_picks_resend_from_the_parameters():
    post = Resend()
    store = s.MemoryStore()
    service = s.Subscriptions(store)
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(sub.id, sub.token)
    settings = sa.SubscriberSettings(
        bucket="b", web_url="https://aeros.example", area=(-69, -35, -53, -16)
    )
    original = alerts.resend_post
    alerts.resend_post = lambda key: post
    try:
        lat, lng = h3.cell_to_latlng(ORIGIN)
        report = {
            "scans": ["2026-11-14T05:50:00Z", "2026-11-14T05:40:00Z", "2026-11-14T05:30:00Z"],
            "cells": [{"cell": ORIGIN, "lat": lat, "lng": lng, "persistent": True}],
        }
        sa.run(report, settings, store=store, s3=object(), ssm=parameters(), ses=FakeSes())
    finally:
        alerts.resend_post = original
    assert len(post.calls) == 1
    assert "/unsubscribe?token=" in post.calls[0]["text"]
