"""The Telegram bot: confirms subscriptions and answers /stop.

Telegram calls a webhook with one update per message. The webhook URL is
public, so the first thing is to check the secret Telegram sends in a header
with every call, set when the webhook is registered (`secret_token`); with no
secret configured everything is refused, never accepted.

The bot only talks in private chats and understands:

* `/start <id>`: the link on the site. The chat that pressed it becomes the
  subscriber of the pending subscription with that id (see `subscriptions`).
* the name of a town, written as a plain message: that is the whole sign-up. One match
  subscribes the chat; several show a button each, and pressing one subscribes it. Signing
  up never asks for a location: the person says where they live.
* `/start` alone, `/ayuda` or `/help`: the guide, which says what aeros is, what it
  will warn about and how often, and how to start (or what the chat already gets).
* `/zona` or `/zone`: which town or area the chat gets alerts about.
* `/stop`: ends every subscription of that chat.
* `/reportar` or `/report`: how to report a fire, with a button that shares the location.
* a shared location: a fire report. The bot answers what the satellites saw around that
  point (see `fire_check`): fire brigade numbers first, then the verdict. The point is not
  stored. This is the only time the bot reads a location, and only because the person sent it.
* any other command: a short pointer to the guide.

There is no account or login: Telegram already says who is writing, so the chat is the
identity, and asking a neighbour for anything more is a reason for them to give up.

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
from datetime import UTC, datetime

import fire_check
import places
from alert_text import pick_language
from subscriptions import InvalidSubscription, Subscription, Subscriptions

logger = logging.getLogger()

SECRET_HEADER = "x-telegram-bot-api-secret-token"
#: Commands by name, in both languages; any other command gets the short help.
_COMMANDS = {
    "start": "start",
    "stop": "stop",
    "ayuda": "guide",
    "help": "guide",
    "zona": "zone",
    "zone": "zone",
    "reportar": "report",
    "report": "report",
}
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
    #: "start", "guide", "zone", "stop", "help", "search", "pick", "report", "located"
    #: or "ignore"
    kind: str
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
    location = message.get("location")
    if isinstance(location, Mapping) and chat.get("type") == "private" and "id" in chat:
        try:
            lat, lon = fire_check.parse_point(location.get("latitude"), location.get("longitude"))
        except fire_check.InvalidPoint:
            return Command("ignore")
        language = (message.get("from") or {}).get("language_code")
        return Command("located", chat["id"], f"{lat},{lon}", language)
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
        _COMMANDS.get(name, "help"),
        chat["id"],
        payload if _PAYLOAD.match(payload) else "",
        language,
    )


def _guide(web_url: str, language: str, status: str) -> str:
    """What the bot is and how to use it: the first thing a person reads after pressing Start.

    Short blocks with a question each, because it is read on a phone by neighbours, not
    analysts. `status` closes it: how to start, or what the chat already gets.
    """
    if language == "en":
        lines = [
            "Hello. I am the aeros fire alert bot.",
            "",
            "What is aeros?",
            "A system that watches the Gran Chaco (Argentina, Paraguay and Bolivia) with "
            "satellites. The GOES-19 weather satellite looks at it every 10 minutes and "
            "sees the heat of a fire.",
            "",
            "What will I warn you about?",
            "A possible fire within about 50 km of your town: your area of the map and the "
            "neighbouring one. The alert says how far and which way, which way the wind blows "
            "and what to do. The location is approximate and it may be a controlled burn: it "
            "does not confirm a fire and does not replace the fire brigade.",
            "",
            "How often?",
            "Only when there is a possible fire near you, and at most one message every 12 "
            "hours. If nothing burns, I do not write.",
            "",
            status,
            "",
            "Commands:",
            "/zone - see which town you get alerts about",
            "/report - see a fire? I tell you what the satellites see there",
            "/stop - stop the alerts",
            "/help - show this message again",
        ]
        if web_url:
            lines.append(f"Map of the Gran Chaco: {web_url}")
        return "\n".join(lines)
    lines = [
        "Hola. Soy el bot de avisos de incendios de aeros.",
        "",
        "¿Qué es aeros?",
        "Un sistema que vigila el Gran Chaco (Argentina, Paraguay y Bolivia) con satélites. "
        "El satélite meteorológico GOES-19 lo mira cada 10 minutos y detecta el calor de "
        "un fuego.",
        "",
        "¿Qué le voy a avisar?",
        "Un posible incendio a menos de unos 50 km de su localidad: su zona del mapa y la "
        "vecina. El aviso le dice a qué distancia y hacia dónde, hacia dónde sopla el viento "
        "y qué conviene hacer. La ubicación es aproximada y puede ser una quema controlada: "
        "no confirma un incendio ni reemplaza a los bomberos.",
        "",
        "¿Cada cuánto?",
        "Solo cuando hay un posible incendio cerca, y como mucho un mensaje cada 12 horas. "
        "Si no se quema nada, no le escribo.",
        "",
        status,
        "",
        "Comandos:",
        "/zona - ver para qué localidad recibe avisos",
        "/reportar - ¿ve un fuego? le digo qué ven los satélites en ese lugar",
        "/stop - dejar de recibir avisos",
        "/ayuda - volver a ver este mensaje",
    ]
    if web_url:
        lines.append(f"Mapa del Gran Chaco: {web_url}")
    return "\n".join(lines)


def _how_to_start(language: str) -> str:
    if language == "en":
        return (
            "To start, write the name of your town, for example: Resistencia, or "
            "Villa Ángela, Chaco. You do not need to sign up or share your location: I only "
            "keep this chat and the town you choose."
        )
    return (
        "Para empezar, escriba el nombre de su localidad, por ejemplo: Resistencia, o "
        "Villa Ángela, Chaco. No necesita registrarse ni compartir su ubicación: solo guardo "
        "este chat y la localidad que elija."
    )


def _zone(subscription: Subscription | None, language: str) -> str:
    """What a chat gets alerts about, or how to start when it gets none."""
    if subscription is None:
        if language == "en":
            return "You get no alerts in this chat yet. " + _how_to_start(language)
        return "Todavía no recibe avisos en este chat. " + _how_to_start(language)
    if subscription.place:
        town = places.label(subscription.place)
        if language == "en":
            return (
                f"You get alerts about fire near {town} (up to about 50 km). "
                "To change town, write another name. Send /stop to end the alerts."
            )
        return (
            f"Recibe avisos de fuego cerca de {town} (hasta unos 50 km). "
            "Para cambiar de localidad, escriba otro nombre. "
            "Envíe /stop para dejar de recibirlos."
        )
    areas = len(subscription.cells)
    if language == "en":
        return (
            f"You get alerts about the {'area' if areas == 1 else 'areas'} you picked on the "
            "map. To use a town instead, write its name. Send /stop to end the alerts."
        )
    return (
        f"Recibe avisos de {'la zona' if areas == 1 else 'las zonas'} que eligió en el mapa. "
        "Para usar una localidad, escriba su nombre. Envíe /stop para dejar de recibirlos."
    )


def _confirmed(cells: int, language: str) -> str:
    if language == "en":
        return (
            "You are subscribed: you will get an alert here when the satellite sees a possible "
            f"fire in the {'area' if cells == 1 else 'areas'} you picked, at most one message "
            "every 12 hours. Send /stop at any time to end the alerts."
        )
    return (
        "Listo, ya está suscripto. Le vamos a escribir acá cuando el satélite detecte un "
        f"posible incendio en {'la zona' if cells == 1 else 'las zonas'} que eligió, como "
        "mucho un mensaje cada 12 horas. "
        "Envíe /stop cuando quiera dejar de recibir los avisos."
    )


def _subscribed(town: str, language: str) -> str:
    if language == "en":
        return (
            f"Done: I will alert you when the satellite sees a possible fire near {town} "
            "(up to about 50 km), at most one message every 12 hours. To change town, write "
            "another name. Send /stop to end the alerts."
        )
    return (
        f"Listo: le voy a avisar cuando el satélite detecte un posible incendio cerca de {town} "
        "(hasta unos 50 km), como mucho un mensaje cada 12 horas. "
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


def _check_unavailable(language: str) -> str:
    numbers = ", ".join(f"{c} {n}" for c, n in fire_check.EMERGENCY)
    if language == "en":
        return (
            f"🚒 If you see fire, call the fire brigade: {numbers}.\n\n"
            "I could not read the satellite data just now. Try again in a few minutes."
        )
    return (
        f"🚒 Si ve fuego, llame a los bomberos: {numbers}.\n\n"
        "No pude leer los datos satelitales en este momento. Pruebe de nuevo en unos minutos."
    )


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
        return (
            "Write the name of your town to get alerts. /zone shows what you get, /stop ends "
            "the alerts and /help explains how it works."
        )
    return (
        "Escriba el nombre de su localidad para recibir avisos. /zona muestra qué recibe, "
        "/stop los termina y /ayuda le explica cómo funciona."
    )


def _report_how(language: str) -> tuple[str, dict]:
    """How to report a fire, with a one-tap button that shares the location (phones only)."""
    if language == "en":
        text = (
            "🚒 If you see fire, call the fire brigade first: "
            + ", ".join(f"{c} {n}" for c, n in fire_check.EMERGENCY)
            + ".\n\nThen press the button below (or 📎 → Location) and I will tell you what "
            "the satellites see around you. Your location is used for this answer only."
        )
        button = "📍 Share my location"
    else:
        text = (
            "🚒 Si ve fuego, llame primero a los bomberos: "
            + ", ".join(f"{c} {n}" for c, n in fire_check.EMERGENCY)
            + ".\n\nDespués toque el botón de abajo (o 📎 → Ubicación) y le digo qué ven "
            "los satélites cerca suyo. Su ubicación se usa sólo para esta respuesta."
        )
        button = "📍 Compartir mi ubicación"
    markup = {
        "keyboard": [[{"text": button, "request_location": True}]],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }
    return text, markup


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
    check_fire: Callable[[float, float], dict] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
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
    elif command.kind in ("start", "guide"):
        current = subscriptions.of_chat(chat)
        status = _how_to_start(language) if current is None else _zone(current, language)
        outcome, text = "welcome", _guide(web_url, language, status)
    elif command.kind == "report":
        outcome = "report_how"
        text, markup = _report_how(language)
    elif command.kind == "located":
        lat, lon = (float(v) for v in command.payload.split(","))
        if check_fire is None:
            outcome, text = "unavailable", _check_unavailable(language)
        else:
            try:
                result = check_fire(lat, lon)
            except Exception as exc:
                logger.error("fire check failed: %s", type(exc).__name__)
                outcome, text = "unavailable", _check_unavailable(language)
            else:
                outcome = result["verdict"]
                text = fire_check.message(result, language, now())
        markup = {"remove_keyboard": True}
    elif command.kind == "zone":
        current = subscriptions.of_chat(chat)
        outcome, text = ("zone" if current else "no_zone"), _zone(current, language)
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
