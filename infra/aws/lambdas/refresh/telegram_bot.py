"""The Telegram bot: confirms subscriptions and answers /stop.

Telegram calls a webhook with one update per message. The webhook URL is
public, so the first thing is to check the secret Telegram sends in a header
with every call, set when the webhook is registered (`secret_token`); with no
secret configured everything is refused, never accepted.

The bot only talks in private chats and only understands three commands:

* `/start <id>`: the link on the site. The chat that pressed it becomes the
  subscriber of the pending subscription with that id (see `subscriptions`).
* `/stop`: ends every subscription of that chat.
* anything else: how to use it.

Replies are plain text. A failure to send a reply is logged without its
message, because Telegram errors can carry the bot token inside the URL, and
never breaks the webhook: Telegram would retry an update that got a non-200.
"""

from __future__ import annotations

import hmac
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from alert_text import pick_language
from subscriptions import Subscriptions

logger = logging.getLogger()

SECRET_HEADER = "x-telegram-bot-api-secret-token"
# What Telegram allows in the payload of a /start link.
_PAYLOAD = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

Send = Callable[[int, str], None]


def secret_is_valid(headers: Mapping[str, str], expected: str | None) -> bool:
    """True only when a secret is configured and the call carries exactly it."""
    if not expected:
        return False
    given = {name.lower(): value for name, value in headers.items()}.get(SECRET_HEADER, "")
    return hmac.compare_digest(given.encode(), expected.encode())


@dataclass(frozen=True)
class Command:
    kind: str  # "start", "stop", "help" or "ignore"
    chat_id: int | None = None
    payload: str = ""
    #: What Telegram says the language of the person's app is, like "es-AR".
    language: str | None = None


def parse(update: Mapping) -> Command:
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    text = (message.get("text") or "").strip()
    if chat.get("type") != "private" or "id" not in chat or not text.startswith("/"):
        return Command("ignore")
    head, _, rest = text.partition(" ")
    name = head[1:].split("@")[0].lower()  # "/start@AerosBot" in a chat with several bots
    payload = rest.strip()
    return Command(
        {"start": "start", "stop": "stop"}.get(name, "help"),
        chat["id"],
        payload if _PAYLOAD.match(payload) else "",
        (message.get("from") or {}).get("language_code"),
    )


def _where(web_url: str, language: str) -> str:
    if not web_url:
        return ""
    return f" en {web_url}" if language == "es" else f" at {web_url}"


def _welcome(web_url: str, language: str) -> str:
    where = _where(web_url, language)
    if language == "en":
        return (
            "aeros fire alerts for the Gran Chaco. To get alerts for your area, pick it on the "
            f"map{where} and press the Telegram button there. Send /stop to end your alerts."
        )
    return (
        "Avisos de incendios de aeros para el Gran Chaco. Para recibir avisos de su zona, "
        f"elíjala en el mapa{where} y toque el botón de Telegram. "
        "Envíe /stop cuando quiera dejar de recibirlos."
    )


def _confirmed(cells: int, language: str) -> str:
    if language == "en":
        return (
            f"You are subscribed: you will get an alert here when a fire above its normal "
            f"burns near your {cells} {'cell' if cells == 1 else 'cells'}. One message per weekly "
            "window, and another only if it gets worse. Send /stop at any time to end the alerts."
        )
    return (
        "Listo, ya está suscripto. Le vamos a escribir acá cuando se detecte mucho más fuego "
        f"de lo habitual cerca de {'la zona' if cells == 1 else 'las zonas'} que eligió. "
        "Es un mensaje por semana y otro solo si la situación empeora. "
        "Envíe /stop cuando quiera dejar de recibir los avisos."
    )


def _expired(web_url: str, language: str) -> str:
    if language == "en":
        where = f": {web_url}" if web_url else ""
        return f"That link is not valid or has expired. Pick your area again on the site{where}"
    where = f": {web_url}" if web_url else ""
    return f"Ese enlace no es válido o ya venció. Vuelva a elegir su zona en el sitio{where}"


def _stopped(ended: int, language: str) -> str:
    if language == "en":
        if not ended:
            return "You had no active alerts here."
        return f"Done: {ended} {'alert' if ended == 1 else 'alerts'} ended. You will not get more."
    if not ended:
        return "No tenía avisos activos en este chat."
    return "Listo, dejó de recibir avisos. No le vamos a escribir más."


def _help(language: str) -> str:
    if language == "en":
        return "Send /start after picking your area on the site, or /stop to end your alerts."
    return (
        "Elija su zona en el sitio y toque el botón de Telegram, "
        "o envíe /stop para dejar de recibir avisos."
    )


def handle(
    update: Mapping,
    subscriptions: Subscriptions,
    send: Send,
    *,
    web_url: str = "",
) -> str:
    """Acts on one update; returns welcome, confirmed, expired, stopped, help or ignored."""
    command = parse(update)
    if command.kind == "ignore":
        return "ignored"
    chat = command.chat_id
    assert chat is not None
    language = pick_language(command.language)

    if command.kind == "start" and command.payload:
        confirmed = subscriptions.confirm_telegram(command.payload, chat, command.language)
        if confirmed is None:
            outcome, text = "expired", _expired(web_url, language)
        else:
            # The reply uses what the subscription now says, which is this person's app language.
            outcome, text = "confirmed", _confirmed(len(confirmed.cells), confirmed.language)
    elif command.kind == "start":
        outcome, text = "welcome", _welcome(web_url, language)
    elif command.kind == "stop":
        ended = subscriptions.unsubscribe_chat(chat)
        outcome, text = "stopped", _stopped(ended, language)
    else:
        outcome, text = "help", _help(language)

    try:
        send(chat, text)
    except Exception as exc:
        # Only the class: the message of a Telegram error can hold the bot token.
        logger.error("could not reply on Telegram: %s", type(exc).__name__)
    return outcome
