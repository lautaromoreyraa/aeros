import base64
import json
from datetime import UTC, datetime

import h3
import pytest

import alerts_api as a
import subscriptions as s

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
AREA = (-69.0, -35.0, -53.0, -16.0)
SECRET = "s3cret-value"


class Mailbox:
    def __init__(self, fail=False):
        self.sent: list[tuple[str, str, str]] = []
        self.fail = fail

    def __call__(self, address, subject, text):
        if self.fail:
            raise RuntimeError("SES down")
        self.sent.append((address, subject, text))


class Chat:
    def __init__(self):
        self.said: list[tuple[int, str]] = []

    def __call__(self, chat_id, text, markup=None):
        self.said.append((chat_id, text))


@pytest.fixture
def mailbox():
    return Mailbox()


@pytest.fixture
def chat():
    return Chat()


@pytest.fixture
def deps(mailbox, chat):
    clock = lambda: datetime(2026, 11, 14, 22, 0, tzinfo=UTC)  # noqa: E731
    return a.Dependencies(
        s.Subscriptions(s.MemoryStore(), now=clock, area=AREA),
        web_url="https://aeros.example",
        bot_username="aeros_bot",
        send_mail=mailbox,
        reply=chat,
        webhook_secret=SECRET,
    )


def request(method, path, body=None, query=None, headers=None, base64_body=False):
    raw = json.dumps(body) if body is not None else ""
    if base64_body:
        raw = base64.b64encode(raw.encode()).decode()
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "queryStringParameters": query,
        "headers": headers or {},
        "body": raw,
        "isBase64Encoded": base64_body,
    }


def call(deps, method, path, **kwargs):
    return a.api_handler(request(method, path, **kwargs), deps=deps)


def answer(response):
    return json.loads(response["body"])


def create(deps, **fields):
    body = {
        "channel": "email",
        "address": "ana@example.com",
        "cells": [ORIGIN],
        "language": "en",
        **fields,
    }
    return call(deps, "POST", a.PREFIX, body=body)


# ---------- subscribing ----------


def test_an_email_sign_up_is_pending_and_sends_the_confirmation_link(deps, mailbox):
    response = create(deps)
    assert response["statusCode"] == 202
    body = answer(response)
    assert body["status"] == "pending_confirmation" and "confirm_url" not in body
    (address, subject, text) = mailbox.sent[0]
    stored = deps.subscriptions.store.get(body["id"])
    assert address == "ana@example.com" and subject == "Confirm your aeros fire alerts"
    assert f"https://aeros.example{a.PREFIX}/{stored.id}/confirm?token={stored.token}" in text
    assert stored.status == "pending"
    assert stored.token not in response["body"]


def test_a_telegram_sign_up_returns_the_deep_link_and_ignores_any_address(deps, mailbox):
    response = create(deps, channel="telegram", address="999")
    body = answer(response)
    assert response["statusCode"] == 202
    assert body["confirm_url"] == f"https://t.me/aeros_bot?start={body['id']}"
    assert deps.subscriptions.store.get(body["id"]).address is None and mailbox.sent == []


def test_a_telegram_sign_up_without_a_bot_still_works_with_no_link(deps):
    deps.bot_username = None
    assert "confirm_url" not in answer(create(deps, channel="telegram"))


def test_a_body_sent_base64_encoded_is_read(deps):
    response = call(
        deps,
        "POST",
        a.PREFIX,
        body={"channel": "email", "address": "ana@example.com", "cells": [ORIGIN]},
        base64_body=True,
    )
    assert response["statusCode"] == 202


@pytest.mark.parametrize(
    "fields",
    [
        {"channel": "sms"},
        {"cells": []},
        {"cells": ["nope"]},
        {"address": "not-an-address"},
        {"zone_id": "bad zone!"},
        {"cells": "x"},
        {"address": 5},
    ],
)
def test_invalid_sign_ups_are_a_400_with_a_message_and_store_nothing(deps, mailbox, fields):
    response = create(deps, **fields)
    assert response["statusCode"] == 400 and answer(response)["error"]
    assert deps.subscriptions.store.all() == [] and mailbox.sent == []


def test_a_cell_outside_the_monitored_area_is_refused(deps):
    far = h3.latlng_to_cell(40.0, -3.0, 4)
    assert create(deps, cells=[far])["statusCode"] == 400


def test_a_body_that_is_not_a_json_object_or_is_too_big_is_refused(deps):
    event = request("POST", a.PREFIX)
    event["body"] = "[1, 2]"
    assert a.api_handler(event, deps=deps)["statusCode"] == 400
    event["body"] = "{" + " " * a.MAX_BODY_BYTES + "}"
    assert a.api_handler(event, deps=deps)["statusCode"] == 413
    event["body"] = "not json"
    assert a.api_handler(event, deps=deps)["statusCode"] == 400


def test_a_failed_confirmation_e_mail_leaves_no_pending_sign_up(deps):
    deps.send_mail = Mailbox(fail=True)
    response = create(deps)
    assert response["statusCode"] == 503
    assert deps.subscriptions.store.all() == []
    assert "SES" not in response["body"]


def test_an_sms_sign_up_sends_a_text_with_no_link_and_stores_the_number(deps):
    sent = []
    deps.send_sms = lambda address, text: sent.append((address, text))
    response = create(deps, channel="sms", address="+54 9 362 400 0000", language="en")
    assert response["statusCode"] == 202
    stored = deps.subscriptions.store.get(answer(response)["id"])
    assert stored.address == "+5493624000000" and stored.status == "pending"
    assert sent[0][0] == "+5493624000000" and "YES" in sent[0][1] and "http" not in sent[0][1]


def test_sms_is_unavailable_when_twilio_is_not_configured(deps):
    assert create(deps, channel="sms", address="+5493624000000")["statusCode"] == 503
    assert deps.subscriptions.store.all() == []


def test_a_signed_yes_confirms_the_number_and_a_bad_signature_does_nothing(deps):
    import hashlib
    import hmac
    from urllib.parse import urlencode

    import sms

    deps.send_sms = lambda address, text: None
    created = answer(create(deps, channel="sms", address="+5493624000000"))
    token = "twilio-secret"
    deps.twilio_token = token
    params = {"From": "+5493624000000", "Body": "YES", "MessageSid": "SM1"}
    url = "https://sms.example/twilio"
    payload = url + "".join(key + params[key] for key in sorted(params))
    digest = hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()
    signature = base64.b64encode(digest).decode()
    event = {
        "rawPath": "/twilio",
        "rawQueryString": "",
        "requestContext": {"domainName": "sms.example"},
        "headers": {"X-Twilio-Signature": signature},
        "body": urlencode(params),
        "isBase64Encoded": False,
    }
    response = a.sms_webhook_handler(event, deps=deps)
    assert response["statusCode"] == 200 and "text/xml" in response["headers"]["content-type"]
    assert deps.subscriptions.store.get(created["id"]).status == "confirmed"
    event["headers"] = {"X-Twilio-Signature": "nope"}
    refused = a.sms_webhook_handler(event, deps=deps)
    assert refused["statusCode"] == 403
    assert sms.signature_is_valid(url, params, signature, token)


def _bearer(key: str, payload: dict | None = None) -> str:
    import hashlib
    import hmac
    import json

    def part(value: dict) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(value).encode()).decode()
        return raw.rstrip("=")

    header = part({"alg": "HS256", "typ": "JWT"})
    body = part(payload or {"sub": "httpsms"})
    digest = hmac.new(key.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    signature = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return f"Bearer {header}.{body}.{signature}"


def test_a_signed_httpsms_reply_confirms_the_number_and_a_bad_token_does_nothing(deps):
    deps.send_sms = lambda address, text: None
    created = answer(create(deps, channel="sms", address="+5493624000000"))
    deps.httpsms_signing_key = "signing-key"
    event = {
        "headers": {"Authorization": _bearer("signing-key")},
        "body": json.dumps(
            {
                "type": "message.phone.received",
                "data": {"contact": "+5493624000000", "content": "SI"},
            }
        ),
        "isBase64Encoded": False,
    }
    response = a.sms_webhook_handler(event, deps=deps)
    assert response["statusCode"] == 200
    assert deps.subscriptions.store.get(created["id"]).status == "confirmed"
    event["headers"] = {"Authorization": _bearer("other-key")}
    event["body"] = json.dumps(
        {
            "type": "message.phone.received",
            "data": {"contact": "+5493624000000", "content": "STOP"},
        }
    )
    assert a.sms_webhook_handler(event, deps=deps)["statusCode"] == 403
    assert deps.subscriptions.store.get(created["id"]).status == "confirmed"


def test_an_httpsms_delivery_event_is_acknowledged_and_changes_nothing(deps):
    deps.send_sms = lambda address, text: None
    created = answer(create(deps, channel="sms", address="+5493624000000"))
    deps.httpsms_signing_key = "signing-key"
    event = {
        "headers": {"Authorization": _bearer("signing-key")},
        "body": json.dumps({"type": "message.phone.sent", "data": {"contact": "+5493624000000"}}),
        "isBase64Encoded": False,
    }
    assert a.sms_webhook_handler(event, deps=deps)["statusCode"] == 200
    assert deps.subscriptions.store.get(created["id"]).status == "pending"


def test_httpsms_posts_the_text_and_a_refusal_does_not_reveal_the_api_key(monkeypatch):
    import io
    import urllib.error
    import urllib.request
    from email.message import Message

    import sms

    seen = {}

    def post(url, key, payload):
        seen["url"] = url
        seen["payload"] = payload
        return {}

    sms.send_httpsms("secret-key", "+5491100000000", "+5493624000000", "hola", post=post)
    assert seen["url"] == sms.HTTPSMS_API
    assert seen["payload"] == {
        "content": "hola",
        "from": "+5491100000000",
        "to": "+5493624000000",
    }

    def refuse(request, timeout):
        raise urllib.error.HTTPError(
            sms.HTTPSMS_API, 401, "no", Message(), io.BytesIO(b"secret-key")
        )

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    with pytest.raises(sms.SmsError, match="HTTP 401") as caught:
        sms.send_httpsms("secret-key", "+5491100000000", "+5493624000000", "hola")
    assert "secret-key" not in str(caught.value)


def test_email_is_unavailable_when_the_sender_is_not_configured(deps):
    deps.send_mail = None
    assert create(deps)["statusCode"] == 503
    assert create(deps, channel="telegram")["statusCode"] == 202


def test_too_many_pending_sign_ups_are_turned_away(deps, monkeypatch):
    monkeypatch.setattr(a, "MAX_PENDING", 2)
    for i in range(2):
        assert create(deps, address=f"user{i}@example.com")["statusCode"] == 202
    assert create(deps, address="late@example.com")["statusCode"] == 429


# ---------- confirming and leaving ----------


def test_the_link_in_the_email_confirms_the_subscription(deps):
    created = deps.subscriptions.store.get(answer(create(deps))["id"])
    response = call(deps, "GET", f"{a.PREFIX}/{created.id}/confirm", query={"token": created.token})
    assert response["statusCode"] == 200 and "text/html" in response["headers"]["content-type"]
    assert deps.subscriptions.store.get(created.id).status == "confirmed"
    assert "no-store" in response["headers"]["cache-control"]


def test_a_second_sign_up_for_the_same_address_within_minutes_is_a_429_and_sends_nothing(
    deps, mailbox
):
    assert create(deps)["statusCode"] == 202
    response = create(deps)
    assert response["statusCode"] == 429 and len(mailbox.sent) == 1


def test_ids_that_cannot_exist_are_a_404_before_they_reach_the_store(deps):
    class Strict:
        def get(self, subscription_id):
            raise AssertionError("must not be asked")

    deps.subscriptions.store = Strict()
    for bad in ["", "x" * 33, "a b", "a%00b"]:
        path = f"{a.PREFIX}/{bad}/confirm"
        assert call(deps, "GET", path, query={"token": "t"})["statusCode"] == 404
    assert call(deps, "DELETE", f"{a.PREFIX}/{'y' * 40}", query={"token": "t"})["statusCode"] == 404


def test_a_wrong_token_or_unknown_id_look_the_same(deps):
    created = deps.subscriptions.store.get(answer(create(deps))["id"])
    wrong = call(deps, "GET", f"{a.PREFIX}/{created.id}/confirm", query={"token": "nope"})
    unknown = call(deps, "GET", f"{a.PREFIX}/unknown/confirm", query={"token": created.token})
    missing = call(deps, "GET", f"{a.PREFIX}/{created.id}/confirm")
    assert wrong == unknown == missing and wrong["statusCode"] == 404
    assert deps.subscriptions.store.get(created.id).status == "pending"


def test_the_pages_never_echo_the_request(deps):
    page = call(deps, "GET", f"{a.PREFIX}/<script>/confirm", query={"token": "<b>x</b>"})
    assert "<script>" not in page["body"] and "<b>" not in page["body"]


def test_one_click_unsubscribe_and_delete_end_the_subscription(deps):
    first = deps.subscriptions.store.get(answer(create(deps))["id"])
    page = call(deps, "GET", f"{a.PREFIX}/{first.id}/unsubscribe", query={"token": first.token})
    assert page["statusCode"] == 200 and deps.subscriptions.store.get(first.id) is None

    second = deps.subscriptions.store.get(answer(create(deps, address="bo@example.com"))["id"])
    refused = call(deps, "DELETE", f"{a.PREFIX}/{second.id}", query={"token": "wrong"})
    assert refused["statusCode"] == 404 and deps.subscriptions.store.get(second.id)
    done = call(deps, "DELETE", f"{a.PREFIX}/{second.id}", query={"token": second.token})
    assert done["statusCode"] == 204 and deps.subscriptions.store.get(second.id) is None


def test_the_unsubscribe_link_carries_the_id_and_the_token():
    sub = s.Subscription("abc", "email", "a@b.co", (ORIGIN,), None, "confirmed", "tok", "n", None)
    assert a.unsubscribe_url("https://aeros.example/", sub) == (
        f"https://aeros.example{a.PREFIX}/abc/unsubscribe?token=tok"
    )


def test_other_routes_and_methods_are_a_404(deps):
    assert call(deps, "GET", a.PREFIX)["statusCode"] == 404
    assert call(deps, "GET", "/api/alerts/other")["statusCode"] == 404
    assert call(deps, "PUT", f"{a.PREFIX}/x")["statusCode"] == 404
    assert call(deps, "POST", f"{a.PREFIX}/x/confirm")["statusCode"] == 404


# ---------- the Telegram webhook ----------


def hook(deps, update, secret=SECRET, header="X-Telegram-Bot-Api-Secret-Token"):
    headers = {header: secret} if secret is not None else {}
    event = request("POST", "/", body=update, headers=headers)
    return a.webhook_handler(event, deps=deps)


def start(chat_id, payload, language="en"):
    return {
        "message": {
            "chat": {"id": chat_id, "type": "private"},
            "from": {"language_code": language},
            "text": f"/start {payload}",
        }
    }


def test_the_webhook_refuses_a_missing_or_wrong_secret_and_does_nothing(deps, chat):
    sub = deps.subscriptions.create("telegram", None, [ORIGIN])
    assert hook(deps, start(7, sub.id), secret=None)["statusCode"] == 403
    assert hook(deps, start(7, sub.id), secret="wrong")["statusCode"] == 403
    assert deps.subscriptions.store.get(sub.id).status == "pending" and chat.said == []


def test_with_no_secret_configured_everything_is_refused(deps):
    deps.webhook_secret = None
    assert hook(deps, start(7, "x"), secret="")["statusCode"] == 403


def test_start_with_the_id_confirms_the_chat_and_the_bot_answers(deps, chat):
    sub = deps.subscriptions.create("telegram", None, [ORIGIN])
    assert (
        hook(deps, start(7, sub.id), header="x-telegram-bot-api-secret-token")["statusCode"] == 200
    )
    stored = deps.subscriptions.store.get(sub.id)
    assert (stored.status, stored.address) == ("confirmed", "7")
    assert chat.said[0][0] == 7 and "subscribed" in chat.said[0][1]


def test_garbage_after_the_secret_check_is_a_quiet_200(deps, chat):
    event = request("POST", "/", headers={a.telegram_bot.SECRET_HEADER: SECRET})
    event["body"] = "not json"
    assert a.webhook_handler(event, deps=deps)["statusCode"] == 200
    assert hook(deps, [1, 2])["statusCode"] == 200 and chat.said == []


def test_a_storage_failure_is_not_a_200_so_telegram_retries(deps):
    class Broken:
        def all(self, *args):
            raise RuntimeError("dynamo down")

        get = delete = put = all

    deps.subscriptions.store = Broken()
    with pytest.raises(RuntimeError):
        hook(deps, start(7, "someid"))


# ---------- in Spanish, for the people of the region ----------


def test_a_sign_up_without_a_language_gets_the_confirmation_e_mail_in_spanish(deps, mailbox):
    body = {"channel": "email", "address": "ana@example.com", "cells": [ORIGIN]}
    response = call(deps, "POST", a.PREFIX, body=body)
    assert response["statusCode"] == 202
    (_, subject, text) = mailbox.sent[0]
    assert subject == "Confirme sus avisos de incendios de aeros"
    assert "Si fue usted, confirme acá" in text and "ignore este mensaje" in text
    assert deps.subscriptions.store.get(answer(response)["id"]).language == "es"


def test_the_language_of_the_browser_decides_the_e_mail_and_the_pages(deps, mailbox):
    english = answer(create(deps, language="en-US"))
    sub = deps.subscriptions.store.get(english["id"])
    assert mailbox.sent[0][1] == "Confirm your aeros fire alerts" and sub.language == "en"
    page = call(deps, "GET", f"{a.PREFIX}/{sub.id}/confirm", query={"token": sub.token})
    assert "You are subscribed" in page["body"]

    spanish = deps.subscriptions.store.get(
        answer(create(deps, address="luis@example.com", language="es-AR"))["id"]
    )
    page = call(deps, "GET", f"{a.PREFIX}/{spanish.id}/confirm", query={"token": spanish.token})
    assert "Ya está suscripto" in page["body"]
    page = call(deps, "GET", f"{a.PREFIX}/{spanish.id}/unsubscribe", query={"token": spanish.token})
    assert "Avisos cancelados" in page["body"] and page["statusCode"] == 200


def test_a_link_that_fails_carries_both_languages(deps):
    page = call(deps, "GET", f"{a.PREFIX}/unknown/confirm", query={"token": "t"})
    assert "Enlace no válido" in page["body"] and "Link not valid" in page["body"]
    assert page["statusCode"] == 404


def test_the_telegram_confirmation_follows_the_app_language(deps, chat):
    sub = deps.subscriptions.create("telegram", None, [ORIGIN])
    hook(deps, start(7, sub.id, language="es-BO"))
    assert "ya está suscripto" in chat.said[0][1]
    assert deps.subscriptions.store.get(sub.id).language == "es"
