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
    )


def _welcome(web_url: str) -> str:
    where = f" at {web_url}" if web_url else ""
    return (
        "aeros fire alerts for the Gran Chaco. To get alerts for your area, pick it on the "
        f"map{where} and press the Telegram button there. Send /stop to end your alerts."
    )


def _confirmed(cells: int) -> str:
    return (
        f"You are subscribed: you will get an alert here when a fire above its normal "
        f"burns near your {cells} {'cell' if cells == 1 else 'cells'}. One message per weekly "
        "window, and another only if it gets worse. Send /stop at any time to end the alerts."
    )


def _expired(web_url: str) -> str:
    where = f": {web_url}" if web_url else ""
    return f"That link is not valid or has expired. Pick your area again on the site{where}"


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

    if command.kind == "start" and command.payload:
        confirmed = subscriptions.confirm_telegram(command.payload, chat)
        if confirmed is None:
            outcome, text = "expired", _expired(web_url)
        else:
            outcome, text = "confirmed", _confirmed(len(confirmed.cells))
    elif command.kind == "start":
        outcome, text = "welcome", _welcome(web_url)
    elif command.kind == "stop":
        ended = subscriptions.unsubscribe_chat(chat)
        outcome = "stopped"
        text = (
            f"Done: {ended} {'alert' if ended == 1 else 'alerts'} ended. You will not get more."
            if ended
            else "You had no active alerts here."
        )
    else:
        outcome, text = (
            "help",
            "Send /start after picking your area on the site, or /stop to end your alerts.",
        )

    try:
        send(chat, text)
    except Exception as exc:
        # Only the class: the message of a Telegram error can hold the bot token.
        logger.error("could not reply on Telegram: %s", type(exc).__name__)
    return outcome
