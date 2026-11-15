"""Fire alert notifications by e-mail (Amazon SES) and Telegram.

An early warning report is an alert when the whole region burns at least twice
its usual rate with p < 0.01, or when any cell is flagged. People hear about an
alert once, when it starts, and again only when it grows: the region crosses
the threshold, its ratio climbs by a quarter or more, or a cell that was not in
the last notification gets flagged. A day without an alert closes the episode,
so the next one is new again. That memory is a small JSON object in the data
bucket, written only after at least one channel delivered: if every channel
failed, tomorrow's run tries again.

E-mail goes through Resend when its API key parameter exists and through Amazon
SES otherwise (see `email_sender_from_parameters`).

Both channels are optional and independent. Each one is configured by Parameter
Store parameters created by hand; when they are missing the channel is skipped
and logged, and one channel failing never stops the other. Secrets (the bot
token, the Resend key) are read on every run and never logged: the token is part
of the Telegram URL, so that URL is not logged either.
"""

from __future__ import annotations

import json
import logging
import math
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field

logger = logging.getLogger()

REGION_MIN_RATIO = 2.0
REGION_ALPHA = 0.01
# A repeated alert is sent again only when the region ratio grows this much.
REGION_GROWTH = 1.25
TOP_CELLS = 5
TELEGRAM_API = "https://api.telegram.org"
RESEND_API = "https://api.resend.com/emails"

# Parameter names, never values. The defaults match the deployed stack.
EMAIL_FROM_PARAMETER = "/aeros/alerts/email-from"
EMAIL_TO_PARAMETER = "/aeros/alerts/email-to"
TELEGRAM_TOKEN_PARAMETER = "/aeros/alerts/telegram-token"
TELEGRAM_CHAT_PARAMETER = "/aeros/alerts/telegram-chat-id"
RESEND_KEY_PARAMETER = "/aeros/alerts/resend-api-key"


class AlertError(RuntimeError):
    pass


@dataclass(frozen=True)
class AlertSettings:
    state_key: str
    web_url: str
    region_name: str
    area: str
    email_from_parameter: str = EMAIL_FROM_PARAMETER
    email_to_parameter: str = EMAIL_TO_PARAMETER
    telegram_token_parameter: str = TELEGRAM_TOKEN_PARAMETER
    telegram_chat_parameter: str = TELEGRAM_CHAT_PARAMETER
    resend_key_parameter: str = RESEND_KEY_PARAMETER

    @classmethod
    def from_environment(cls) -> AlertSettings | None:
        state_key = os.environ.get("ALERT_STATE_KEY")
        if not state_key:
            return None
        env = os.environ
        return cls(
            state_key=state_key,
            web_url=env.get("ALERT_WEB_URL", ""),
            region_name=env.get("ALERT_REGION_NAME", "the monitored region"),
            area=env.get("FIRMS_AREA", ""),
            email_from_parameter=env.get("ALERT_EMAIL_FROM_PARAMETER", EMAIL_FROM_PARAMETER),
            email_to_parameter=env.get("ALERT_EMAIL_TO_PARAMETER", EMAIL_TO_PARAMETER),
            telegram_token_parameter=env.get(
                "ALERT_TELEGRAM_TOKEN_PARAMETER", TELEGRAM_TOKEN_PARAMETER
            ),
            telegram_chat_parameter=env.get(
                "ALERT_TELEGRAM_CHAT_PARAMETER", TELEGRAM_CHAT_PARAMETER
            ),
            resend_key_parameter=env.get("ALERT_RESEND_KEY_PARAMETER", RESEND_KEY_PARAMETER),
        )


@dataclass(frozen=True)
class Alert:
    region_alert: bool
    region_ratio: float | None
    cells: tuple[str, ...] = field(default_factory=tuple)


# (url, json body) -> parsed JSON answer
Post = Callable[[str, dict], dict]


def assess(report: dict) -> Alert | None:
    region = report.get("region") or {}
    ratio = region.get("ratio")
    p_value = region.get("p_value")
    region_alert = (
        ratio is not None
        and p_value is not None
        and ratio >= REGION_MIN_RATIO
        and p_value < REGION_ALPHA
    )
    cells = tuple(c["cell"] for c in report.get("cells") or [])
    if not region_alert and not cells:
        return None
    return Alert(region_alert=region_alert, region_ratio=ratio, cells=cells)


def decide(alert: Alert | None, state: dict | None) -> str:
    """'none', 'new', 'grown' or 'repeat'."""
    if alert is None:
        return "none"
    if not state or not state.get("active"):
        return "new"
    if alert.region_alert and not state.get("region_alert"):
        return "grown"
    previous_ratio = state.get("region_ratio")
    if (
        alert.region_alert
        and alert.region_ratio is not None
        and previous_ratio
        and alert.region_ratio >= previous_ratio * REGION_GROWTH
    ):
        return "grown"
    if set(alert.cells) - set(state.get("cells") or []):
        return "grown"
    return "repeat"


def next_state(alert: Alert, state: dict | None, report: dict) -> dict:
    """The episode remembers everything already told, so shrinking is silent."""
    previous = state if state and state.get("active") else {}
    ratios = [r for r in (alert.region_ratio, previous.get("region_ratio")) if r is not None]
    return {
        "active": True,
        "region_alert": alert.region_alert or bool(previous.get("region_alert")),
        "region_ratio": max(ratios) if ratios else None,
        "cells": sorted(set(alert.cells) | set(previous.get("cells") or [])),
        "notified_for": report.get("generated_at"),
    }


def centroid(cell: str) -> tuple[float, float]:
    import h3

    lat, lon = h3.cell_to_latlng(cell)
    return round(lat, 3), round(lon, 3)


def _number(value: float | None, digits: int = 1) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:.{digits}f}"


def format_message(report: dict, kind: str, settings: AlertSettings) -> tuple[str, str]:
    region = report.get("region") or {}
    start, end = (report.get("window") or ["?", "?"])[:2]
    cells = report.get("cells") or []
    headline = "Fire alert" if kind == "new" else "Fire alert growing"
    subject = f"aeros: {headline.lower()} in {settings.region_name} ({start} to {end})"
    lines = [
        f"{headline}: {settings.region_name}",
        f"Area (W,S,E,N): {settings.area}" if settings.area else None,
        f"Window: {start} to {end}",
        f"Observed {region.get('observed', 'n/a')} VIIRS hotspots vs "
        f"{_number(region.get('expected'))} expected "
        f"(ratio {_number(region.get('ratio'), 2)}, p = {region.get('p_value', 'n/a')})",
        f"Flagged cells: {len(cells)}",
    ]
    if cells:
        lines.append(f"Top {min(TOP_CELLS, len(cells))}:")
        for c in cells[:TOP_CELLS]:
            lat, lon = centroid(c["cell"])
            lines.append(
                f"- {lat:.3f}, {lon:.3f}: {c['observed']} vs {_number(c['expected'])} "
                f"(ratio {_number(c.get('ratio'), 1)}, p = {c['p_value']})"
            )
    if settings.web_url:
        lines.append(f"Map: {settings.web_url}")
    return subject, "\n".join(line for line in lines if line is not None)


def read_optional_parameter(ssm, name: str) -> str | None:
    """None when the parameter does not exist: the channel is simply off."""
    try:
        value = ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code == "ParameterNotFound":
            return None
        raise AlertError(f"cannot read parameter {name}: {code or type(exc).__name__}") from None
    return value.strip() or None


def send_email(ses, sender: str, recipients: list[str], subject: str, text: str) -> int:
    """One message per recipient, so addresses never see each other.

    Amazon SES starts every account in sandbox mode: until production access
    is requested, the sender and every recipient must be verified identities
    in SES, and sending is capped at 200 messages a day. Unverified recipients
    fail here and are logged; the others still get their message.
    """
    sent = 0
    for recipient in recipients:
        try:
            ses.send_email(
                FromEmailAddress=sender,
                Destination={"ToAddresses": [recipient]},
                Content={
                    "Simple": {
                        "Subject": {"Data": subject, "Charset": "UTF-8"},
                        "Body": {"Text": {"Data": text, "Charset": "UTF-8"}},
                    }
                },
            )
            sent += 1
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            logger.error("SES did not send to one recipient: %s", code or type(exc).__name__)
    if not sent:
        raise AlertError("SES sent no message")
    return sent


def send_telegram(post: Post, token: str, chat_id: str, text: str) -> None:
    # Plain text on purpose: no parse_mode means nothing in the text needs escaping.
    answer = post(
        f"{TELEGRAM_API}/bot{token}/sendMessage",
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
    )
    if not answer.get("ok"):
        raise AlertError(f"Telegram refused the message: {answer.get('description', '?')}")


def send_telegram_venue(
    post: Post, token: str, chat_id: str, lat: float, lng: float, title: str, address: str
) -> None:
    """A pin on a map with a name, which Telegram opens in the phone's map app."""
    answer = post(
        f"{TELEGRAM_API}/bot{token}/sendVenue",
        {
            "chat_id": chat_id,
            "latitude": lat,
            "longitude": lng,
            "title": title,
            "address": address,
        },
    )
    if not answer.get("ok"):
        raise AlertError(f"Telegram refused the location: {answer.get('description', '?')}")


def _http_post(
    url: str, body: dict, headers: dict[str, str] | None = None, service: str = "Telegram"
) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        # A User-Agent is required: Resend's edge refuses requests without one.
        headers={
            "Content-Type": "application/json",
            "User-Agent": "aeros-alerts",
            **(headers or {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        # The error body names the problem without echoing the token or the key.
        try:
            error = json.loads(exc.read())
            detail = error.get("description") or error.get("message") or ""
        except Exception:
            detail = ""
        raise AlertError(f"{service} answered HTTP {exc.code} {detail}".strip()) from None
    except (urllib.error.URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise AlertError(f"{service} unreachable: {type(reason).__name__}") from None


def resend_post(api_key: str) -> Post:
    """A `Post` that signs its requests with the Resend API key."""

    def post(url: str, body: dict) -> dict:
        return _http_post(url, body, {"Authorization": f"Bearer {api_key}"}, "Resend")

    return post


def send_resend(post: Post, sender: str, recipients: list[str], subject: str, text: str) -> int:
    """One message per recipient through Resend, like `send_email` does through SES."""
    sent = 0
    for recipient in recipients:
        try:
            answer = post(
                RESEND_API,
                {"from": sender, "to": [recipient], "subject": subject, "text": text},
            )
            if not answer.get("id"):
                raise AlertError("Resend gave no message id")
            sent += 1
        except Exception as exc:
            logger.error("Resend did not send to one recipient: %s", type(exc).__name__)
    if not sent:
        raise AlertError("Resend sent no message")
    return sent


#: Sends one message to a list of recipients; returns how many went out, raises if none did.
MailSender = Callable[[list[str], str, str], int]


def email_sender_from_parameters(
    ssm,
    *,
    from_parameter: str,
    resend_key_parameter: str,
    ses=None,
    make_resend_post: Callable[[str], Post] | None = None,
) -> MailSender | None:
    """Resend when its key parameter exists, SES otherwise; None without a sender address."""
    sender = read_optional_parameter(ssm, from_parameter)
    if not sender:
        return None
    key = read_optional_parameter(ssm, resend_key_parameter)
    if key:
        post = (make_resend_post or resend_post)(key)
        return lambda to, subject, text: send_resend(post, sender, to, subject, text)
    if ses is None:
        import boto3

        ses = boto3.client("sesv2")
    return lambda to, subject, text: send_email(ses, sender, to, subject, text)


def load_state(s3, bucket: str, key: str) -> dict | None:
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            return None
        raise
    return json.loads(body)


def save_state(s3, bucket: str, key: str, state: dict) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(state, separators=(",", ":")).encode(),
        ContentType="application/json",
    )


def deliver(
    subject: str, text: str, settings: AlertSettings, *, ssm, ses=None, post: Post | None = None
) -> dict[str, str]:
    """Send one message through every configured channel; one failing never stops the other."""
    channels: dict[str, str] = {}

    try:
        to = read_optional_parameter(ssm, settings.email_to_parameter)
        recipients = [r.strip() for r in (to or "").split(",") if r.strip()]
        send = (
            email_sender_from_parameters(
                ssm,
                from_parameter=settings.email_from_parameter,
                resend_key_parameter=settings.resend_key_parameter,
                ses=ses,
            )
            if recipients
            else None
        )
        if not send:
            logger.info("e-mail channel not configured; skipping")
            channels["email"] = "skipped"
        else:
            sent = send(recipients, subject, text)
            channels["email"] = f"sent to {sent} of {len(recipients)}"
    except Exception as exc:
        logger.error("e-mail alert failed: %s", exc)
        channels["email"] = "failed"

    token = None
    try:
        token = read_optional_parameter(ssm, settings.telegram_token_parameter)
        chat_id = read_optional_parameter(ssm, settings.telegram_chat_parameter)
        if not token or not chat_id:
            logger.info("Telegram channel not configured; skipping")
            channels["telegram"] = "skipped"
        else:
            send_telegram(post or _http_post, token, chat_id, text)
            channels["telegram"] = "sent"
    except Exception as exc:
        # Belt and braces: whatever raised, the token never reaches the log.
        message = str(exc).replace(token, "***") if token else str(exc)
        logger.error("Telegram alert failed: %s", message)
        channels["telegram"] = "failed"
    return channels


def notify(
    report: dict,
    settings: AlertSettings,
    *,
    bucket: str,
    s3,
    ssm,
    ses=None,
    post: Post | None = None,
) -> dict:
    """Decide, send through every configured channel and remember what was told."""
    state = load_state(s3, bucket, settings.state_key)
    alert = assess(report)
    kind = decide(alert, state)
    summary: dict = {"decision": kind}
    if kind == "none":
        if state and state.get("active"):
            save_state(s3, bucket, settings.state_key, {"active": False})
        return summary
    if kind == "repeat":
        logger.info("alert unchanged since the last notification; not sending")
        return summary

    subject, text = format_message(report, kind, settings)
    channels = deliver(subject, text, settings, ssm=ssm, ses=ses, post=post)

    summary["channels"] = channels
    if any(v.startswith("sent") for v in channels.values()):
        save_state(s3, bucket, settings.state_key, next_state(alert, state, report))
    return summary
