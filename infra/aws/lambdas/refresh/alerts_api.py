"""HTTP entry points of the alert subscriptions: the API and the Telegram webhook.

Two Lambda handlers share this module because they share the rules:

* `api_handler` sits behind CloudFront (origin access control) under `/api/alerts/`:

    POST   /api/alerts/subscriptions                    {channel, address?, cells, zone_id?}
    GET    /api/alerts/places?q=<name>&language=<es|en>       towns called like that
    GET    /api/alerts/subscriptions/{id}/confirm?token=      e-mail link
    GET    /api/alerts/subscriptions/{id}/unsubscribe?token=  e-mail link, one click
    DELETE /api/alerts/subscriptions/{id}?token=

  A sign-up names a town (`place`: {name, lat, lng}, as the places search returns it) or lists
  cells; with a town the cells around it are derived on the server.

  CloudFront signs requests to the function URL, and for a POST or DELETE with
  a body it needs the browser to send `x-amz-content-sha256` (the SHA-256 of
  the body) itself; the web client does, as it does for the calendar.

* `webhook_handler` is Telegram's webhook, on its own public function URL.
  CloudFront cannot front it (Telegram cannot sign requests), so the secret
  Telegram sends in a header on every call is the only door, and without a
  configured secret everything is refused.

Answers never echo what the client sent and never tell an unknown id from a
wrong token. Nothing here reads the Telegram token or the e-mail sender
before a request needs it.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import quote

import alerts
import places
import telegram_bot
from alert_text import pick_language
from subscriptions import (
    Cooldown,
    InvalidSubscription,
    NotFound,
    Subscription,
    Subscriptions,
)

logger = logging.getLogger()

PREFIX = "/api/alerts/subscriptions"
PLACES = "/api/alerts/places"
#: What ids look like; anything else is a 404 before it reaches the table.
_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MAX_BODY_BYTES = 8 * 1024
#: Pending sign-ups across everyone: a floor against somebody filling the table
#: or using the confirmation e-mail to write to strangers.
MAX_PENDING = 200

Reply = Callable[..., None]  # (chat_id, text, reply_markup=None)
Find = Callable[[str, str], list[dict]]  # (query, language) -> towns
Answer = Callable[[str], None]
SendMail = Callable[[str, str, str], None]  # address, subject, text


@dataclass
class Dependencies:
    subscriptions: Subscriptions
    web_url: str = ""
    #: Without it the Telegram sign-up returns no deep link (the bot is not set up yet).
    bot_username: str | None = None
    send_mail: SendMail | None = None
    reply: Reply | None = None
    #: Looks a town up by name; without it the bot cannot sign anyone up by town.
    find: Find | None = None
    #: Answers a button press on Telegram.
    answer: Answer | None = None
    webhook_secret: str | None = None


def unsubscribe_url(web_url: str, subscription: Subscription) -> str:
    """The one-click link at the end of every e-mail alert."""
    return (
        f"{web_url.rstrip('/')}{PREFIX}/{quote(subscription.id)}/unsubscribe"
        f"?token={quote(subscription.token)}"
    )


# ---------- responses ----------


def _json(status: int, payload: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(payload),
    }


def _page(status: int, title: str, message: str) -> dict:
    """A tiny fixed page for the links in e-mails; nothing from the request is echoed."""
    body = (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        f"<title>{title}</title>"
        '<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">'
        f"<h1>{title}</h1><p>{message}</p>"
    )
    return {
        "statusCode": status,
        "headers": {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
            "referrer-policy": "no-referrer",
        },
        "body": body,
    }


def _body(event: Mapping) -> bytes:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(raw)
    return raw.encode()


# ---------- the subscriptions API ----------


def api_handler(event: Mapping, context=None, *, deps: Dependencies | None = None) -> dict:
    deps = deps or _api_dependencies()
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = (event.get("rawPath") or "").rstrip("/")
    query = event.get("queryStringParameters") or {}

    if path == PREFIX and method == "POST":
        return _create(event, deps)
    if path == PLACES and method == "GET":
        return _places(query, deps)
    if path.startswith(PREFIX + "/"):
        parts = path[len(PREFIX) + 1 :].split("/")
        subscription_id, action = parts[0], parts[1] if len(parts) == 2 else ""
        token = str(query.get("token", ""))
        if not _ID.match(subscription_id):
            return _json(404, {"error": "not found"})
        if len(parts) == 2 and method == "GET" and action == "confirm":
            return _confirm(deps, subscription_id, token)
        if len(parts) == 2 and method == "GET" and action == "unsubscribe":
            return _unsubscribe(deps, subscription_id, token, html=True)
        if len(parts) == 1 and method == "DELETE":
            return _unsubscribe(deps, subscription_id, token, html=False)
    return _json(404, {"error": "not found"})


def _places(query: Mapping, deps: Dependencies) -> dict:
    """Towns called like `q`, for the site's search box: only the name typed is looked up."""
    if deps.find is None:
        return _json(503, {"error": "town search is not available yet"})
    language = pick_language(query.get("language"))
    try:
        found = deps.find(str(query.get("q", "")), language)
    except places.PlacesError as exc:
        logger.error("%s", exc)
        return _json(502, {"error": "could not look the town up; try again in a moment"})
    return _json(200, {"places": found})


def _create(event: Mapping, deps: Dependencies) -> dict:
    body = _body(event)
    if len(body) > MAX_BODY_BYTES:
        return _json(413, {"error": "request too large"})
    try:
        request = json.loads(body or b"{}")
        if not isinstance(request, dict):
            raise ValueError
    except ValueError:
        return _json(400, {"error": "the body must be a JSON object"})

    pending = sum(1 for s in deps.subscriptions.store.all() if s.status == "pending")
    if pending >= MAX_PENDING:
        return _json(429, {"error": "too many pending sign-ups; try again later"})
    channel = request.get("channel")
    if channel == "email" and deps.send_mail is None:
        return _json(503, {"error": "e-mail alerts are not available yet"})

    try:
        subscription = deps.subscriptions.create(
            str(channel),
            request.get("address") if isinstance(request.get("address"), str) else None,
            request.get("cells") if isinstance(request.get("cells"), list) else [],
            request.get("zone_id") if isinstance(request.get("zone_id"), str) else None,
            request.get("language") if isinstance(request.get("language"), str) else None,
            place=request.get("place") if isinstance(request.get("place"), dict) else None,
        )
    except Cooldown:
        return _json(429, {"error": "a confirmation e-mail was just sent; wait a few minutes"})
    except InvalidSubscription as exc:
        return _json(400, {"error": str(exc)})

    answer: dict = {"id": subscription.id, "status": "pending_confirmation"}
    if subscription.channel == "telegram":
        if deps.bot_username:
            answer["confirm_url"] = f"https://t.me/{deps.bot_username}?start={subscription.id}"
        return _json(202, answer)

    try:
        assert deps.send_mail is not None and subscription.address
        subject, text = _confirmation_message(deps.web_url, subscription)
        deps.send_mail(subscription.address, subject, text)
    except Exception as exc:
        # The person never got the link, so the pending sign-up is of no use.
        deps.subscriptions.store.delete(subscription.id)
        logger.error("confirmation e-mail failed: %s", type(exc).__name__)
        return _json(503, {"error": "could not send the confirmation e-mail"})
    return _json(202, answer)


def _confirmation_message(web_url: str, subscription: Subscription) -> tuple[str, str]:
    link = (
        f"{web_url.rstrip('/')}{PREFIX}/{quote(subscription.id)}/confirm"
        f"?token={quote(subscription.token)}"
    )
    if subscription.language == "en":
        where = f" on {web_url}" if web_url else ""
        return (
            "Confirm your aeros fire alerts",
            "Someone asked for aeros fire alerts to be sent to this address"
            f"{where}. If it was you, confirm here (the link works for 24 hours):\n\n{link}\n\n"
            "If it was not you, ignore this message: nothing is sent until you confirm.",
        )
    where = f" desde {web_url}" if web_url else ""
    return (
        "Confirme sus avisos de incendios de aeros",
        f"Alguien pidió recibir en este correo los avisos de incendios de aeros{where}. "
        f"Si fue usted, confirme acá (el enlace sirve por 24 horas):\n\n{link}\n\n"
        "Si no fue usted, ignore este mensaje: no se le va a enviar nada hasta que confirme.",
    )


# Text of the pages the e-mail links open, by language. A link that fails does not say whose
# language to use, so those pages carry both.
_PAGES = {
    "es": {
        "confirmed": (
            "Ya está suscripto",
            "Le vamos a mandar un correo cuando el satélite detecte un posible incendio cerca "
            "de su zona, como mucho uno cada 12 horas. Cada mensaje trae un enlace para dejar "
            "de recibirlos.",
        ),
        "stopped": ("Avisos cancelados", "No le vamos a mandar más avisos a esta dirección."),
    },
    "en": {
        "confirmed": (
            "You are subscribed",
            "You will get an e-mail when the satellite sees a possible fire near your area, "
            "at most one every 12 hours. Every message has a link to stop them.",
        ),
        "stopped": ("Alerts stopped", "You will not get more alerts at this address."),
    },
}
_INVALID = (
    "Enlace no válido / Link not valid",
    "Este enlace no es válido o ya venció. / This link is not valid or has expired.",
)


def _confirm(deps: Dependencies, subscription_id: str, token: str) -> dict:
    try:
        confirmed = deps.subscriptions.confirm_with_token(subscription_id, token)
    except NotFound:
        return _page(404, *_INVALID)
    return _page(200, *_PAGES[confirmed.language]["confirmed"])


def _unsubscribe(deps: Dependencies, subscription_id: str, token: str, *, html: bool) -> dict:
    # Read the language first: after the unsubscribe there is nothing left to read it from.
    found = deps.subscriptions.store.get(subscription_id)
    gone = deps.subscriptions.unsubscribe(subscription_id, token)
    if html:
        if gone and found:
            return _page(200, *_PAGES[found.language]["stopped"])
        return _page(404, *_INVALID)
    return _json(204 if gone else 404, {} if gone else {"error": "not found"})


# ---------- the Telegram webhook ----------


def webhook_handler(event: Mapping, context=None, *, deps: Dependencies | None = None) -> dict:
    deps = deps or _webhook_dependencies()
    headers = event.get("headers") or {}
    if not telegram_bot.secret_is_valid(headers, deps.webhook_secret):
        return _json(403, {"error": "forbidden"})
    try:
        update = json.loads(_body(event) or b"{}")
    except ValueError:
        return _json(200, {})  # a retry would not make it parse
    if not isinstance(update, dict) or deps.reply is None:
        return _json(200, {})
    # A storage failure raises: Telegram retries a non-200 later, which is what we want.
    telegram_bot.handle(
        update,
        deps.subscriptions,
        deps.reply,
        web_url=deps.web_url,
        find=deps.find,
        answer=deps.answer,
    )
    return _json(200, {})


# ---------- wiring from the environment ----------

_cache: dict[str, Dependencies] = {}


def _subscriptions() -> Subscriptions:
    from dynamo_store import DynamoStore

    area = tuple(float(v) for v in os.environ["FIRMS_AREA"].split(","))
    return Subscriptions(DynamoStore.from_environment(), area=area)  # type: ignore[arg-type]


def _parameter(ssm, variable: str) -> str | None:
    name = os.environ.get(variable)
    return alerts.read_optional_parameter(ssm, name) if name else None


def _api_dependencies() -> Dependencies:
    if "api" not in _cache:
        import boto3

        ssm = boto3.client("ssm")
        send = alerts.email_sender_from_parameters(
            ssm,
            from_parameter=os.environ.get(
                "ALERT_EMAIL_FROM_PARAMETER", alerts.EMAIL_FROM_PARAMETER
            ),
            resend_key_parameter=os.environ.get(
                "ALERT_RESEND_KEY_PARAMETER", alerts.RESEND_KEY_PARAMETER
            ),
        )

        def send_mail(address: str, subject: str, text: str) -> None:
            assert send
            send([address], subject, text)

        service = _subscriptions()
        area = service.area
        assert area
        _cache["api"] = Dependencies(
            service,
            find=lambda query, language: places.search(query, language, area),
            web_url=os.environ.get("ALERT_WEB_URL", ""),
            bot_username=_parameter(ssm, "ALERT_TELEGRAM_BOT_PARAMETER"),
            send_mail=send_mail if send else None,
        )
    return _cache["api"]


def _webhook_dependencies() -> Dependencies:
    if "webhook" not in _cache:
        import boto3

        ssm = boto3.client("ssm")
        token = _parameter(ssm, "ALERT_TELEGRAM_TOKEN_PARAMETER")

        def reply(chat_id: int, text: str, markup: dict | None = None) -> None:
            assert token
            alerts.send_telegram(alerts._http_post, token, str(chat_id), text, markup)

        def answer(callback_id: str) -> None:
            assert token
            alerts.answer_telegram_button(alerts._http_post, token, callback_id)

        service = _subscriptions()
        area = service.area
        assert area
        _cache["webhook"] = Dependencies(
            service,
            web_url=os.environ.get("ALERT_WEB_URL", ""),
            reply=reply if token else None,
            find=lambda query, language: places.search(query, language, area),
            answer=answer if token else None,
            webhook_secret=_parameter(ssm, "ALERT_TELEGRAM_WEBHOOK_SECRET_PARAMETER"),
        )
    return _cache["webhook"]


def handler(event, context):
    """Function URL entry of the subscriptions API."""
    return api_handler(event, context)


def webhook(event, context):
    """Function URL entry of the Telegram webhook."""
    return webhook_handler(event, context)
