"""The Telegram bot: confirms subscriptions and answers /stop.

Telegram calls a webhook with one update per message. The webhook URL is
public, so the first thing is to check the secret Telegram sends in a header
with every call, set when the webhook is registered (`secret_token`); with no
secret configured everything is refused, never accepted.

The bot only talks in private chats and understands:

* `/start <id>`: the link on the site. The chat that pressed it becomes the
  subscriber of the pending subscription with that id (see `subscriptions`).
* the name of a town, written as a plain message: that is the whole sign-up. One match
  subscribes the chat; several show a button each, and pressing one subscribes it. The bot
  never asks for a location: the person says where they live.
* `/stop`: ends every subscription of that chat.
* anything else: how to use it.

The webhook must be registered allowing `message` and `callback_query` updates.

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

import places
from alert_text import pick_language
from subscriptions import InvalidSubscription, Subscriptions

logger = logging.getLogger()

SECRET_HEADER = "x-telegram-bot-api-secret-token"
# What Telegram allows in the payload of a /start link.
_PAYLOAD = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: (chat_id, text, reply_markup=None)
Send = Callable[..., None]
#: (query, language) -> towns, as `places.search` returns them.
Find = Callable[[str, str], list[dict]]
#: Stops the spinner of a button the person pressed.
Answer = Callable[[str], None]

PICK_PREFIX = "p|"
#: Telegram allows 64 bytes in the data of a button.
_DATA_LIMIT = 64


def pick_data(place: Mapping) -> str:
    """What a town's button carries: "p|-27.45|-58.98|Resistencia", cut to fit."""
    head = f"{PICK_PREFIX}{place['lat']:.2f}|{place['lng']:.2f}|"
    room = _DATA_LIMIT - len(head.encode())
    return head + str(place["name"]).encode()[:room].decode(errors="ignore")


def place_from_pick(data: str) -> dict | None:
    """The town a button carried; the numbers are checked again by the subscription."""
    if not data.startswith(PICK_PREFIX):
        return None
    parts = data[len(PICK_PREFIX) :].split("|", 2)
    if len(parts) != 3:
        return None
    try:
        return {"name": parts[2], "lat": float(parts[0]), "lng": float(parts[1])}
    except ValueError:
        return None


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
    #: The id of the button press, for kind "pick".
    callback_id: str = ""


def parse(update: Mapping) -> Command:
    press = update.get("callback_query")
    if isinstance(press, Mapping):
        chat = (press.get("message") or {}).get("chat") or {}
        data = str(press.get("data") or "")
        if chat.get("type") != "private" or "id" not in chat or not data.startswith(PICK_PREFIX):
            return Command("ignore")
        language = (press.get("from") or {}).get("language_code")
        return Command("pick", chat["id"], data, language, str(press.get("id") or ""))

    message = update.get("message") or {}
    chat = message.get("chat") or {}
    text = (message.get("text") or "").strip()
    if chat.get("type") != "private" or "id" not in chat or not text:
        return Command("ignore")
    language = (message.get("from") or {}).get("language_code")
    if not text.startswith("/"):
        # Anything that is not a command is a town the person is naming.
        return Command("search", chat["id"], text[: places.MAX_QUERY], language)
    head, _, rest = text.partition(" ")
    name = head[1:].split("@")[0].lower()  # "/start@AerosBot" in a chat with several bots
    payload = rest.strip()
    return Command(
        {"start": "start", "stop": "stop"}.get(name, "help"),
        chat["id"],
        payload if _PAYLOAD.match(payload) else "",
        language,
    )


def _where(web_url: str, language: str) -> str:
    if not web_url:
        return ""
    return f" en {web_url}" if language == "es" else f" at {web_url}"


def _welcome(web_url: str, language: str) -> str:
    where = _where(web_url, language)
    if language == "en":
        return (
            "aeros fire alerts for the Gran Chaco. Write the name of your town (for example: "
            f"Resistencia) and I will alert you when there is much more fire than usual near it. "
            f"You can also pick your area on the map{where}. Send /stop to end your alerts."
        )
    return (
        "Avisos de incendios de aeros para el Gran Chaco. Escriba el nombre de su localidad "
        "(por ejemplo: Resistencia) y le aviso cuando haya mucho más fuego de lo habitual cerca. "
        f"También puede elegir su zona en el mapa{where}. "
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


def _subscribed(town: str, language: str) -> str:
    if language == "en":
        return (
            f"Done: I will alert you when there is much more fire than usual near {town} "
            "(up to about 100 km). One message per weekly window, and another only if it gets "
            "worse. To change town, write another name. Send /stop to end the alerts."
        )
    return (
        f"Listo: le voy a avisar cuando haya mucho más fuego de lo habitual cerca de {town} "
        "(hasta unos 100 km). Es un mensaje por semana y otro solo si la situación empeora. "
        "Para cambiar de localidad, escriba otro nombre. "
        "Envíe /stop cuando quiera dejar de recibir los avisos."
    )


def _not_found(query: str, language: str) -> str:
    if language == "en":
        return (
            f"I did not find «{query}» in the area we cover (the Gran Chaco and its "
            "surroundings). Try the name of another town nearby."
        )
    return (
        f"No encontré «{query}» en la zona que cubrimos (el Gran Chaco y alrededores). "
        "Pruebe con el nombre de otra localidad cercana."
    )


def _choose(language: str) -> str:
    if language == "en":
        return "There are several towns with that name. Which one is yours?"
    return "Hay varias localidades con ese nombre. ¿Cuál es la suya?"


def _unavailable(language: str) -> str:
    if language == "en":
        return "I could not look the town up just now. Try again in a few minutes."
    return "No pude buscar la localidad en este momento. Pruebe de nuevo en unos minutos."


def _outside(language: str) -> str:
    if language == "en":
        return "That place is outside the area we cover (the Gran Chaco and its surroundings)."
    return "Ese lugar está fuera de la zona que cubrimos (el Gran Chaco y alrededores)."


def _expired(web_url: str, language: str) -> str:
    where = f": {web_url}" if web_url else ""
    if language == "en":
        return f"That link is not valid or has expired. Pick your area again on the site{where}"
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
        return "Write the name of your town to get alerts, or send /stop to end your alerts."
    return (
        "Escriba el nombre de su localidad para recibir avisos, "
        "o envíe /stop para dejar de recibirlos."
    )


def _choices(found: list[dict]) -> dict:
    """One button per town, each carrying what is needed to subscribe to it."""
    return {
        "inline_keyboard": [
            [{"text": places.label(place), "callback_data": pick_data(place)}] for place in found
        ]
    }


def _subscribe_place(
    subscriptions: Subscriptions, chat: int, place: Mapping, language_code: str | None
) -> tuple[str, str]:
    language = pick_language(language_code)
    try:
        sub = subscriptions.subscribe_place(chat, place, language_code)
    except InvalidSubscription:
        return "outside", _outside(language)
    return "subscribed", _subscribed(places.label(sub.place or dict(place)), sub.language)


def handle(
    update: Mapping,
    subscriptions: Subscriptions,
    send: Send,
    *,
    web_url: str = "",
    find: Find | None = None,
    answer: Answer | None = None,
) -> str:
    """Acts on one update; returns what it did: welcome, subscribed, choose, stopped, ...."""
    command = parse(update)
    if command.kind == "ignore":
        return "ignored"
    chat = command.chat_id
    assert chat is not None
    language = pick_language(command.language)
    markup: dict | None = None

    if command.kind == "search":
        if find is None:
            outcome, text = "help", _help(language)
        else:
            try:
                found = find(command.payload, language)
            except places.PlacesError as exc:
                logger.error("%s", exc)
                outcome, text = "unavailable", _unavailable(language)
            else:
                if not found:
                    outcome, text = "not_found", _not_found(command.payload, language)
                elif len(found) == 1:
                    outcome, text = _subscribe_place(
                        subscriptions, chat, found[0], command.language
                    )
                else:
                    outcome, text, markup = "choose", _choose(language), _choices(found)
    elif command.kind == "pick":
        town = place_from_pick(command.payload)
        if town is None:
            outcome, text = "expired", _help(language)
        else:
            outcome, text = _subscribe_place(subscriptions, chat, town, command.language)
        if answer and command.callback_id:
            try:
                answer(command.callback_id)
            except Exception as exc:
                logger.error("could not answer a button on Telegram: %s", type(exc).__name__)
    elif command.kind == "start" and command.payload:
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
        send(chat, text, markup)
    except Exception as exc:
        # Only the class: the message of a Telegram error can hold the bot token.
        logger.error("could not reply on Telegram: %s", type(exc).__name__)
    return outcome
