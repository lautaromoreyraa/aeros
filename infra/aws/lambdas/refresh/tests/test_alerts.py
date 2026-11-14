"""Alert notifications with SES, Telegram, SSM and S3 replaced by fakes."""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime

import h3
import pytest

import alerts
import refresh
from alerts import AlertSettings

BUCKET = "data-bucket"
STATE_KEY = "state/alerts.json"
TOKEN = "123456:SECRET-bot-token"
CELLS = [h3.latlng_to_cell(-27.0 - i, -60.0, 4) for i in range(7)]
CONFIGURED = {
    alerts.EMAIL_FROM_PARAMETER: "alerts@example.org",
    alerts.EMAIL_TO_PARAMETER: "a@example.org, b@example.org",
    alerts.TELEGRAM_TOKEN_PARAMETER: TOKEN,
    alerts.TELEGRAM_CHAT_PARAMETER: "-1001234",
}
SETTINGS = AlertSettings(
    state_key=STATE_KEY,
    web_url="https://aeros.example.org",
    region_name="Test region",
    area="-74,-56,-53,-21",
)


class ClientError(Exception):
    """Shaped like botocore's: the code lives in .response."""

    def __init__(self, code: str):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self, state: dict | None = None):
        self.objects: dict[str, bytes] = {}
        if state is not None:
            self.objects[STATE_KEY] = json.dumps(state).encode()

    def get_object(self, Bucket: str, Key: str):  # noqa: N803 (boto3 signature)
        if Key not in self.objects:
            raise ClientError("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, **kwargs):
        body = kwargs["Body"]
        self.objects[kwargs["Key"]] = body if isinstance(body, bytes) else body.encode()

    def state(self) -> dict | None:
        raw = self.objects.get(STATE_KEY)
        return json.loads(raw) if raw else None


class FakeSsm:
    def __init__(self, values: dict[str, str]):
        self.values = values

    def get_parameter(self, Name: str, WithDecryption: bool):  # noqa: N803
        if Name not in self.values:
            raise ClientError("ParameterNotFound")
        return {"Parameter": {"Name": Name, "Value": self.values[Name]}}


class FakeSes:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.sent: list[dict] = []

    def send_email(self, **kwargs):
        if self.fail:
            raise ClientError("MessageRejected")
        self.sent.append(kwargs)
        return {"MessageId": str(len(self.sent))}


class FakeTelegram:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.posts: list[tuple[str, dict]] = []

    def __call__(self, url: str, body: dict) -> dict:
        if self.fail:
            raise alerts.AlertError(f"Telegram unreachable at {url}")
        self.posts.append((url, body))
        return {"ok": True, "result": {"message_id": 1}}


def report(ratio=2.5, p=0.001, cells=3) -> dict:
    return {
        "generated_at": "2026-11-14T06:00:00Z",
        "window": ["2026-11-07", "2026-11-13"],
        "days_with_data": ["2026-11-07"],
        "region": {"observed": 250, "expected": 100.0, "ratio": ratio, "p_value": p},
        "cells": [
            {"cell": c, "observed": 30 - i, "expected": 4.0, "ratio": 7.5, "p_value": 1e-6}
            for i, c in enumerate(CELLS[:cells])
        ],
    }


def notify(rep, state=None, params=CONFIGURED, ses=None, telegram=None):
    s3, ses, telegram = FakeS3(state), ses or FakeSes(), telegram or FakeTelegram()
    summary = alerts.notify(
        rep, SETTINGS, bucket=BUCKET, s3=s3, ssm=FakeSsm(params), ses=ses, post=telegram
    )
    return summary, s3, ses, telegram


def test_new_alert_goes_to_every_recipient_and_the_telegram_chat():
    summary, s3, ses, telegram = notify(report())
    assert summary == {
        "decision": "new",
        "channels": {"email": "sent to 2 of 2", "telegram": "sent"},
    }
    assert [m["Destination"]["ToAddresses"] for m in ses.sent] == [
        ["a@example.org"],
        ["b@example.org"],
    ]
    assert ses.sent[0]["FromEmailAddress"] == "alerts@example.org"
    url, body = telegram.posts[0]
    assert url == f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    assert body["chat_id"] == "-1001234"
    assert s3.state() == {
        "active": True,
        "region_alert": True,
        "region_ratio": 2.5,
        "cells": sorted(CELLS[:3]),
        "notified_for": "2026-11-14T06:00:00Z",
    }


def test_message_carries_region_window_counts_and_top_five_centroids():
    rep = report(cells=7)
    subject, text = alerts.format_message(rep, "new", SETTINGS)
    assert "Test region" in subject and "2026-11-07" in subject
    assert "Window: 2026-11-07 to 2026-11-13" in text
    assert "Observed 250 VIIRS hotspots vs 100.0 expected (ratio 2.50, p = 0.001)" in text
    assert "Flagged cells: 7" in text and "Top 5:" in text
    centroid_lines = [line for line in text.splitlines() if line.startswith("- ")]
    assert len(centroid_lines) == 5
    lat, lon = h3.cell_to_latlng(CELLS[0])
    assert centroid_lines[0].startswith(f"- {lat:.3f}, {lon:.3f}: 30 vs 4.0")
    assert text.splitlines()[-1] == "Map: https://aeros.example.org"


def test_repeated_alert_is_not_sent_again():
    _, s3, _, _ = notify(report())
    state = s3.state()
    summary, s3, ses, telegram = notify(report(), state=state)
    assert summary == {"decision": "repeat"}
    assert ses.sent == [] and telegram.posts == []
    assert s3.state() == state


def test_a_shrinking_alert_stays_quiet():
    _, s3, _, _ = notify(report(ratio=3.0, cells=3))
    summary, *_ = notify(report(ratio=2.1, cells=1), state=s3.state())
    assert summary["decision"] == "repeat"


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ({"ratio": 1.2, "p": 0.3, "cells": 2}, {"ratio": 2.5, "p": 0.001, "cells": 2}),
        ({"ratio": 2.2, "p": 0.001, "cells": 2}, {"ratio": 2.8, "p": 0.001, "cells": 2}),
        ({"ratio": 2.5, "p": 0.001, "cells": 2}, {"ratio": 2.5, "p": 0.001, "cells": 4}),
    ],
    ids=["region-crosses-threshold", "region-ratio-grows", "new-cells"],
)
def test_grown_alert_is_sent_and_remembered(before, after):
    _, s3, _, _ = notify(report(**before))
    summary, s3, ses, telegram = notify(report(**after), state=s3.state())
    assert summary["decision"] == "grown"
    assert len(ses.sent) == 2 and len(telegram.posts) == 1
    assert "Fire alert growing" in telegram.posts[0][1]["text"]
    assert s3.state()["cells"] == sorted(CELLS[: max(before["cells"], after["cells"])])


def test_quiet_day_closes_the_episode_so_the_next_alert_is_new():
    _, s3, _, _ = notify(report())
    summary, s3, *_ = notify(report(ratio=1.0, p=0.5, cells=0), state=s3.state())
    assert summary == {"decision": "none"}
    assert s3.state() == {"active": False}
    summary, *_ = notify(report(), state=s3.state())
    assert summary["decision"] == "new"


def test_region_needs_both_ratio_and_significance():
    assert alerts.assess(report(ratio=2.5, p=0.02, cells=0)) is None
    assert alerts.assess(report(ratio=1.9, p=0.0001, cells=0)) is None
    assert alerts.assess(report(ratio=1.0, p=0.5, cells=1)).region_alert is False


def test_missing_channel_config_skips_that_channel_only(caplog):
    only_telegram = {k: v for k, v in CONFIGURED.items() if k.startswith("/aeros/alerts/telegram")}
    summary, s3, ses, telegram = notify(report(), params=only_telegram)
    assert summary["channels"] == {"email": "skipped", "telegram": "sent"}
    assert ses.sent == [] and len(telegram.posts) == 1
    assert "e-mail channel not configured" in caplog.text
    assert s3.state()["active"] is True


def test_nothing_configured_sends_nothing_and_keeps_no_state():
    summary, s3, ses, telegram = notify(report(), params={})
    assert summary["channels"] == {"email": "skipped", "telegram": "skipped"}
    # Nobody was told, so the alert is still new once a channel is set up.
    assert s3.state() is None


def test_email_failing_does_not_stop_telegram():
    summary, s3, _, telegram = notify(report(), ses=FakeSes(fail=True))
    assert summary["channels"] == {"email": "failed", "telegram": "sent"}
    assert len(telegram.posts) == 1
    assert s3.state()["active"] is True


def test_telegram_failing_does_not_stop_email_and_never_logs_the_token(caplog):
    summary, s3, ses, _ = notify(report(), telegram=FakeTelegram(fail=True))
    assert summary["channels"] == {"email": "sent to 2 of 2", "telegram": "failed"}
    assert len(ses.sent) == 2
    assert "Telegram alert failed" in caplog.text
    assert TOKEN not in caplog.text


def test_every_channel_failing_keeps_the_alert_for_tomorrow():
    summary, s3, *_ = notify(report(), ses=FakeSes(fail=True), telegram=FakeTelegram(fail=True))
    assert summary["channels"] == {"email": "failed", "telegram": "failed"}
    assert s3.state() is None


def test_refresh_handler_notifies_after_publishing_the_early_warning():
    s3, ses, telegram = FakeS3(), FakeSes(), FakeTelegram()
    ssm = FakeSsm({"/aeros/firms/map-key": "abcdef0123456789abcdef0123456789", **CONFIGURED})
    header = b"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,frp\n"
    summary = refresh.handler(
        settings=refresh.Settings(
            bucket=BUCKET,
            prefix="raw/firms/",
            map_key_parameter="/aeros/firms/map-key",
            area="-74,-56,-53,-21",
            sources=("VIIRS_NOAA20_NRT",),
            days_back=7,
            early_warning_key="derived/early_warning.json",
            alert_settings=SETTINGS,
        ),
        s3=s3,
        ssm=ssm,
        fetch=lambda url: header,
        now=datetime(2026, 11, 14, 6, 0, tzinfo=UTC),
        early_warning=lambda downloads, days, now: report(),
        ses=ses,
        post=telegram,
    )
    assert summary["alerts"]["decision"] == "new"
    assert "derived/early_warning.json" in s3.objects
    assert len(ses.sent) == 2 and len(telegram.posts) == 1


def test_a_broken_alert_path_does_not_fail_the_refresh():
    class BrokenS3(FakeS3):
        def get_object(self, Bucket, Key):  # noqa: N803
            raise ClientError("AccessDenied")

    summary = refresh.handler(
        settings=refresh.Settings(
            bucket=BUCKET,
            prefix="raw/firms/",
            map_key_parameter="/aeros/firms/map-key",
            area="-74,-56,-53,-21",
            sources=("VIIRS_NOAA20_NRT",),
            days_back=7,
            early_warning_key="derived/early_warning.json",
            alert_settings=SETTINGS,
        ),
        s3=BrokenS3(),
        ssm=FakeSsm({"/aeros/firms/map-key": "abcdef0123456789abcdef0123456789"}),
        fetch=lambda url: b"latitude,longitude,frp\n",
        now=datetime(2026, 11, 14, 6, 0, tzinfo=UTC),
        early_warning=lambda downloads, days, now: report(),
    )
    assert summary["alerts"] == "failed"
    assert summary["early_warning"]["flagged_cells"] == 3
