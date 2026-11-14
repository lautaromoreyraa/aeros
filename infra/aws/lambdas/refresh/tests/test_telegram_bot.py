import h3
import pytest

import subscriptions as s
import telegram_bot as bot

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]
SECRET = "s3cret-value"


def update(text, chat_id=42, chat_type="private"):
    return {"update_id": 1, "message": {"text": text, "chat": {"id": chat_id, "type": chat_type}}}


class Outbox:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []

    def __call__(self, chat_id, text):
        self.sent.append((chat_id, text))


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
    assert bot.parse(update("/start abc_DEF-123")) == bot.Command("start", 42, "abc_DEF-123")
    assert bot.parse(update("/start@AerosBot abc")) == bot.Command("start", 42, "abc")
    assert bot.parse(update("/START")) == bot.Command("start", 42, "")
    assert bot.parse(update("/stop")) == bot.Command("stop", 42, "")
    assert bot.parse(update("/whatever")) == bot.Command("help", 42, "")


def test_a_payload_that_is_not_a_link_token_is_dropped():
    for bad in ("a b", "x" * 65, "id;drop", "<b>x</b>", "ñ"):
        assert bot.parse(update(f"/start {bad}")).payload == ""


def test_only_commands_in_private_chats_are_read():
    assert bot.parse(update("hello")).kind == "ignore"
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
    assert chat == 555 and "subscribed" in text and "2 cells" in text and "/stop" in text


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
    assert "pick it on the map" in outbox.sent[-1][1]
    assert bot.handle(update("/anything"), service, outbox) == "help"
    assert "/start" in outbox.sent[-1][1] and "/stop" in outbox.sent[-1][1]


def test_stop_ends_the_subscriptions_of_that_chat_and_counts_them(service, outbox):
    for cells in ([ORIGIN], [NEIGHBOR]):
        sub = service.create("telegram", None, cells)
        service.confirm_telegram(sub.id, 42)
    assert bot.handle(update("/stop"), service, outbox) == "stopped"
    assert service.confirmed() == [] and "2 alerts ended" in outbox.sent[-1][1]
    bot.handle(update("/stop"), service, outbox)
    assert "no active alerts" in outbox.sent[-1][1]


def test_messages_that_are_not_for_the_bot_get_no_reply(service, outbox):
    assert bot.handle(update("hello"), service, outbox) == "ignored"
    assert bot.handle(update("/start abc", chat_type="group"), service, outbox) == "ignored"
    assert outbox.sent == []


def test_a_reply_that_fails_does_not_undo_the_subscription_or_leak_the_error(service, caplog):
    sub = service.create("telegram", None, [ORIGIN])

    def broken(chat_id, text):
        raise RuntimeError("POST https://api.telegram.org/bot123456:SECRET/sendMessage failed")

    with caplog.at_level("ERROR"):
        assert bot.handle(update(f"/start {sub.id}"), service, broken) == "confirmed"
    assert len(service.confirmed()) == 1
    assert (
        "RuntimeError" in caplog.text
        and "123456" not in caplog.text
        and "SECRET" not in caplog.text
    )
