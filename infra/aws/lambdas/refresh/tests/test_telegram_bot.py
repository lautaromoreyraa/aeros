import h3
import pytest

import subscriptions as s
import telegram_bot as bot

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]
SECRET = "s3cret-value"


def update(text, chat_id=42, chat_type="private", language="en"):
    message = {"text": text, "chat": {"id": chat_id, "type": chat_type}}
    if language:
        message["from"] = {"language_code": language}
    return {"update_id": 1, "message": message}


class Outbox:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []
        self.markups: list[dict | None] = []

    def __call__(self, chat_id, text, markup=None):
        self.sent.append((chat_id, text))
        self.markups.append(markup)


@pytest.fixture
def service():
    return s.Subscriptions(s.MemoryStore())


@pytest.fixture
def outbox():
    return Outbox()


# ---------- the webhook secret ----------


def test_the_secret_must_be_configured_and_match_exactly():
    header = {"X-Telegram-Bot-Api-Secret-Token": SECRET}
    assert bot.secret_is_valid(header, SECRET)
    assert bot.secret_is_valid({"x-telegram-bot-api-secret-token": SECRET}, SECRET)  # any case
    assert not bot.secret_is_valid({"X-Telegram-Bot-Api-Secret-Token": "other"}, SECRET)
    assert not bot.secret_is_valid({}, SECRET)
    # With no secret configured nothing is accepted, not even a call that sends none.
    assert not bot.secret_is_valid({}, None) and not bot.secret_is_valid({}, "")
    assert not bot.secret_is_valid({"x-telegram-bot-api-secret-token": ""}, "")


# ---------- reading an update ----------


def test_commands_are_read_with_their_payload():
    assert bot.parse(update("/start abc_DEF-123")) == bot.Command("start", 42, "abc_DEF-123", "en")
    assert bot.parse(update("/start@AerosBot abc")) == bot.Command("start", 42, "abc", "en")
    assert bot.parse(update("/START")) == bot.Command("start", 42, "", "en")
    assert bot.parse(update("/stop")) == bot.Command("stop", 42, "", "en")
    assert bot.parse(update("/whatever")) == bot.Command("help", 42, "", "en")


def test_a_payload_that_is_not_a_link_token_is_dropped():
    for bad in ("a b", "x" * 65, "id;drop", "<b>x</b>", "ñ"):
        assert bot.parse(update(f"/start {bad}")).payload == ""


def test_only_commands_in_private_chats_are_read():
    assert bot.parse(update("hello")).kind == "search"  # a town being named
    assert bot.parse(update("hello", chat_type="group")).kind == "ignore"
    assert bot.parse(update("/start abc", chat_type="group")).kind == "ignore"
    assert bot.parse(update("/start abc", chat_type="supergroup")).kind == "ignore"
    for other in (
        {},
        {"edited_message": {"text": "/start"}},
        {"callback_query": {}},
        {"message": {}},
    ):
        assert bot.parse(other).kind == "ignore"


# ---------- acting on it ----------


def test_start_with_a_valid_link_subscribes_the_chat_and_says_so(service, outbox):
    sub = service.create("telegram", None, [ORIGIN, NEIGHBOR])
    outcome = bot.handle(update(f"/start {sub.id}", chat_id=555), service, outbox)
    assert outcome == "confirmed"
    assert [x.address for x in service.confirmed()] == ["555"]
    ((chat, text),) = outbox.sent
    assert chat == 555 and "subscribed" in text and "the areas you picked" in text
    assert "every 12 hours" in text and "/stop" in text


def test_a_link_that_is_unknown_expired_or_already_taken_says_to_pick_the_area_again(
    service, outbox
):
    assert (
        bot.handle(update("/start nope"), service, outbox, web_url="https://aeros.example")
        == "expired"
    )
    assert "https://aeros.example" in outbox.sent[-1][1]
    sub = service.create("telegram", None, [ORIGIN])
    bot.handle(update(f"/start {sub.id}", chat_id=1), service, outbox)
    assert bot.handle(update(f"/start {sub.id}", chat_id=2), service, outbox) == "expired"
    assert [x.address for x in service.confirmed()] == ["1"]  # the second chat took nothing


def test_start_without_a_link_welcomes_and_any_other_command_helps(service, outbox):
    assert bot.handle(update("/start"), service, outbox) == "welcome"
    assert "write the name of your town" in outbox.sent[-1][1]
    assert bot.handle(update("/anything"), service, outbox) == "help"
    assert "town" in outbox.sent[-1][1] and "/stop" in outbox.sent[-1][1]
    assert "/help" in outbox.sent[-1][1]  # the short help points to the guide


# ---------- the guide and /zona ----------

RESISTENCIA = {
    "name": "Resistencia",
    "region": "Chaco",
    "country": "Argentina",
    "lat": -27.45,
    "lng": -58.98,
}


def test_the_guide_says_what_aeros_is_what_it_warns_about_how_often_and_how_to_start(
    service, outbox
):
    bot.handle(update("/start", language="es"), service, outbox, web_url="https://aeros.example")
    guide = outbox.sent[-1][1]
    for part in (
        "¿Qué es aeros?",
        "GOES-19",
        "cada 10 minutos",
        "¿Qué le voy a avisar?",
        "a menos de unos 50 km",
        "puede ser una quema controlada",
        "no confirma un incendio",
        "¿Cada cuánto?",
        "como mucho un mensaje cada 12 horas",
        "Para empezar, escriba el nombre de su localidad",
        "No necesita registrarse ni compartir su ubicación",
        "/zona",
        "/stop",
        "/ayuda",
        "Mapa del Gran Chaco: https://aeros.example",
    ):
        assert part in guide, part
    # /ayuda and /help show the same guide.
    assert bot.handle(update("/ayuda", language="es"), service, outbox) == "welcome"
    assert "¿Qué es aeros?" in outbox.sent[-1][1]
    assert bot.handle(update("/help", language="en"), service, outbox) == "welcome"
    assert "What is aeros?" in outbox.sent[-1][1] and "/zone" in outbox.sent[-1][1]


def test_the_guide_of_a_chat_that_already_has_alerts_says_what_it_gets(service, outbox):
    service.subscribe_place(42, RESISTENCIA, "es")
    bot.handle(update("/start", language="es"), service, outbox)
    guide = outbox.sent[-1][1]
    assert "Recibe avisos de fuego cerca de Resistencia, Chaco, Argentina" in guide
    assert "Para empezar" not in guide


def test_zona_says_the_town_the_area_or_how_to_start(service, outbox):
    assert bot.handle(update("/zona", language="es"), service, outbox) == "no_zone"
    assert "Todavía no recibe avisos" in outbox.sent[-1][1]

    service.subscribe_place(42, RESISTENCIA, "es")
    assert bot.handle(update("/zona", language="es"), service, outbox) == "zone"
    assert "cerca de Resistencia, Chaco, Argentina" in outbox.sent[-1][1]

    sub = service.create("telegram", None, [ORIGIN, NEIGHBOR])
    service.confirm_telegram(sub.id, 7)
    assert bot.handle(update("/zone", chat_id=7), service, outbox) == "zone"
    assert "the areas you picked on the map" in outbox.sent[-1][1]

    bot.handle(update("/stop"), service, outbox)
    assert bot.handle(update("/zona", language="es"), service, outbox) == "no_zone"


def test_of_chat_finds_only_the_confirmed_subscription_of_that_chat(service):
    pending = service.create("telegram", None, [ORIGIN])
    assert service.of_chat(42) is None  # pending: nobody owns it yet
    service.confirm_telegram(pending.id, 42)
    assert service.of_chat(42).id == pending.id
    assert service.of_chat("42").id == pending.id
    assert service.of_chat(43) is None


def test_stop_ends_the_subscriptions_of_that_chat_and_counts_them(service, outbox):
    sub = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(sub.id, 42)
    assert bot.handle(update("/stop"), service, outbox) == "stopped"
    assert service.confirmed() == [] and "1 alert ended" in outbox.sent[-1][1]
    bot.handle(update("/stop"), service, outbox)
    assert "no active alerts" in outbox.sent[-1][1]


def test_messages_that_are_not_for_the_bot_get_no_reply(service, outbox):
    assert bot.handle(update("hello", chat_type="group"), service, outbox) == "ignored"
    assert bot.handle(update("/start abc", chat_type="group"), service, outbox) == "ignored"
    assert outbox.sent == []


def test_a_reply_that_fails_does_not_undo_the_subscription_or_leak_the_error(service, caplog):
    sub = service.create("telegram", None, [ORIGIN])

    def broken(chat_id, text, markup=None):
        raise RuntimeError("POST https://api.telegram.org/bot123456:SECRET/sendMessage failed")

    with caplog.at_level("ERROR"):
        assert bot.handle(update(f"/start {sub.id}"), service, broken) == "confirmed"
    assert len(service.confirmed()) == 1
    assert (
        "RuntimeError" in caplog.text
        and "123456" not in caplog.text
        and "SECRET" not in caplog.text
    )


# ---------- in Spanish ----------


def test_the_bot_answers_in_the_language_of_the_persons_app(service, outbox):
    assert bot.handle(update("/start", language="es-AR"), service, outbox) == "welcome"
    assert "bot de avisos de incendios de aeros" in outbox.sent[-1][1]
    assert "/stop - dejar de recibir avisos" in outbox.sent[-1][1]
    bot.handle(update("/start", language="en-GB"), service, outbox)
    assert "aeros fire alert bot" in outbox.sent[-1][1]
    bot.handle(update("/start", language=None), service, outbox)
    assert "bot de avisos de incendios" in outbox.sent[-1][1]  # unknown language: Spanish


def test_confirming_in_spanish_stores_the_language_for_every_alert(service, outbox):
    sub = service.create("telegram", None, [ORIGIN])
    assert bot.handle(update(f"/start {sub.id}", language="es-PY"), service, outbox) == "confirmed"
    assert "ya está suscripto" in outbox.sent[-1][1]
    assert service.store.get(sub.id).language == "es"


def test_an_old_link_is_explained_in_spanish(service, outbox):
    assert bot.handle(update("/start nope", language="es"), service, outbox) == "expired"
    assert "no es válido o ya venció" in outbox.sent[-1][1]


def test_stop_and_help_in_spanish(service, outbox):
    sub = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(sub.id, 42)
    bot.handle(update("/stop", language="es"), service, outbox)
    assert "dejó de recibir avisos" in outbox.sent[-1][1]
    bot.handle(update("/stop", language="es"), service, outbox)
    assert "No tenía avisos activos" in outbox.sent[-1][1]
    bot.handle(update("/ayuda", language="es"), service, outbox)
    assert "escriba el nombre de su localidad" in outbox.sent[-1][1]
    bot.handle(update("/otra", language="es"), service, outbox)
    assert "Escriba el nombre de su localidad" in outbox.sent[-1][1]
