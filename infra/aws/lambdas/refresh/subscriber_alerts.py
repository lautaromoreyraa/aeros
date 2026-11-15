"""Runs the subscriber fire alert inside a Lambda: loads what it needs and sends.

`fire_alerts.notify` takes plain values; this is the AWS side of it, called by
`goes_watch` when GOES-19 sees a fire that persists. It reads the optional wind
file from the data bucket (a missing one only means the message has no wind
line), builds a sender for each channel that is configured, and hands
everything to `fire_alerts`.

The e-mail sender and the Telegram token are the ones the fixed-list alert
already uses (Parameter Store, read on every run). A channel whose parameter is
missing has no sender, and its subscribers are counted as `no_channel`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime

import alerts
import fire_alerts
import notifier
from alerts_api import unsubscribe_url
from subscriptions import Store, Subscriptions

logger = logging.getLogger()


@dataclass(frozen=True)
class SubscriberSettings:
    bucket: str
    web_url: str
    area: tuple[float, float, float, float]
    wind_key: str | None = None
    email_from_parameter: str = alerts.EMAIL_FROM_PARAMETER
    resend_key_parameter: str = alerts.RESEND_KEY_PARAMETER
    telegram_token_parameter: str = alerts.TELEGRAM_TOKEN_PARAMETER

    @classmethod
    def from_environment(cls) -> SubscriberSettings | None:
        """None when the table is not configured: subscriber alerts are simply off."""
        if not os.environ.get("SUBSCRIPTIONS_TABLE"):
            return None
        env = os.environ
        return cls(
            bucket=env["DATA_BUCKET"],
            web_url=env.get("ALERT_WEB_URL", ""),
            area=tuple(float(v) for v in env["FIRMS_AREA"].split(",")),  # type: ignore[arg-type]
            wind_key=env.get("WIND_KEY") or None,
            email_from_parameter=env.get("ALERT_EMAIL_FROM_PARAMETER", alerts.EMAIL_FROM_PARAMETER),
            resend_key_parameter=env.get("ALERT_RESEND_KEY_PARAMETER", alerts.RESEND_KEY_PARAMETER),
            telegram_token_parameter=env.get(
                "ALERT_TELEGRAM_TOKEN_PARAMETER", alerts.TELEGRAM_TOKEN_PARAMETER
            ),
        )


def _optional_file(s3, bucket: str, key: str | None, what: str) -> dict | None:
    """The wind file is a bonus: whatever goes wrong, the alert still goes."""
    if not key:
        return None
    try:
        return alerts.load_state(s3, bucket, key)
    except Exception as exc:
        logger.warning("%s unavailable, alerting without it: %s", what, type(exc).__name__)
        return None


def run(
    report: dict,
    settings: SubscriberSettings,
    *,
    store: Store,
    s3,
    ssm,
    ses=None,
    post: alerts.Post | None = None,
    now: datetime | None = None,
) -> dict:
    """Tells each subscriber about the possible fires near them in a GOES-19 report."""
    clock = {"now": lambda: now} if now else {}  # the default clock is the real one
    subscriptions = Subscriptions(store, area=settings.area, **clock)
    # Pending sign-ups past their day go now, whatever the store does by itself.
    subscriptions.purge_expired()

    senders: dict[str, fire_alerts.Sender] = {}
    pin_senders: dict[str, fire_alerts.PinSender] = {}
    token = alerts.read_optional_parameter(ssm, settings.telegram_token_parameter)
    if token:
        http = post or alerts._http_post
        senders["telegram"] = notifier.telegram_sender(http, token)

        def pin(subscription, lat: float, lng: float, title: str, address: str) -> None:
            alerts.send_telegram_venue(
                http, token, str(subscription.address), lat, lng, title, address
            )

        pin_senders["telegram"] = pin
    send = alerts.email_sender_from_parameters(
        ssm,
        from_parameter=settings.email_from_parameter,
        resend_key_parameter=settings.resend_key_parameter,
        ses=ses,
    )
    if send:
        senders["email"] = notifier.mail_sender(send)

    return fire_alerts.notify(
        report,
        subscriptions,
        senders,
        pin_senders=pin_senders,
        wind_field=_optional_file(s3, settings.bucket, settings.wind_key, "wind"),
        web_url=settings.web_url,
        unsubscribe_url=lambda subscription: unsubscribe_url(settings.web_url, subscription),
        now=now,
    )
