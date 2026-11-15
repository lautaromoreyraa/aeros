"""SMS alerts for a phone that has signal but no mobile data.

A text message rides the cellular network, so the person does not need internet
to receive it or to answer it. The Lambda that asks for the text does. A phone
with no signal at all cannot be reached this way.

For the MVP the text is sent by an Android phone running httpSMS: this module
calls that HTTP API, and the phone's own SIM delivers a normal SMS. Twilio
remains available when its parameters exist and the httpSMS ones do not.

Confirmation is a reply, never a link: YES (or SI) confirms the number that
replied, STOP ends it. An httpSMS webhook is a JWT signed with the signing
key. A Twilio webhook is the X-Twilio-Signature. A request that fails its
check changes nothing.

Nothing here is called unless the parameters of one sender exist. Each message
is billed by the SIM or by Twilio, so this module only sends the one text a
caller asks for.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from xml.sax.saxutils import escape

TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts"
HTTPSMS_API = "https://api.httpsms.com/v1/messages/send"
#: POST (url, account sid, auth token, form fields) -> parsed JSON. Injected in tests.
PostForm = Callable[[str, str, str, dict], dict]
#: POST (url, api key, JSON body) -> parsed JSON. Injected in tests.
PostJson = Callable[[str, str, dict], dict]

# The first word of a reply. Accents are stripped before the comparison.
_YES = frozenset({"YES", "SI", "OK"})
_STOP = frozenset({"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "BAJA"})

_REPLIES = {
    "en": {
        "confirmed": "Aeros: you will get fire alerts by SMS. Reply STOP to end them.",
        "already": "Aeros: this number is already subscribed. Reply STOP to end them.",
        "stopped": "Aeros: fire alerts to this number have stopped.",
        "unknown": "Aeros: this number has no alert waiting.",
        "ignored": "Aeros: reply YES to confirm, or STOP to refuse.",
    },
    "es": {
        "confirmed": "Aeros: va a recibir avisos de incendio por SMS. Responda STOP para salir.",
        "already": "Aeros: este numero ya esta suscripto. Responda STOP para salir.",
        "stopped": "Aeros: los avisos a este numero se detuvieron.",
        "unknown": "Aeros: este numero no tiene un aviso pendiente.",
        "ignored": "Aeros: responda SI para confirmar, o STOP para rechazar.",
    },
}


class SmsError(RuntimeError):
    pass


def confirmation(language: str) -> str:
    """The one text that asks the phone to opt in. No link: it may have no data."""
    if language == "en":
        return (
            "Aeros fire alerts: reply YES within 24 hours to confirm this number. "
            "Reply STOP to refuse. Nothing is sent until you confirm."
        )
    return (
        "Avisos de incendio de aeros: responda SI antes de 24 horas para confirmar. "
        "Responda STOP para rechazar. No enviamos nada hasta que confirme."
    )


def reply_text(result: str, language: str) -> str:
    table = _REPLIES["en" if language == "en" else "es"]
    return table.get(result, table["ignored"])


def word_of(body: str) -> str:
    """The first word of a reply, in ASCII capitals, so 'Sí.' and 'SI' match."""
    stripped = (body or "").strip()
    if not stripped:
        return ""
    first = stripped.split()[0].strip(".,!?")
    folded = unicodedata.normalize("NFKD", first)
    return "".join(ch for ch in folded if ch.isascii()).upper()


def is_yes(body: str) -> bool:
    return word_of(body) in _YES


def is_stop(body: str) -> bool:
    return word_of(body) in _STOP


def send_httpsms(
    api_key: str,
    from_number: str,
    to: str,
    body: str,
    post: PostJson | None = None,
) -> None:
    """Queue one SMS on the Android phone. Raises SmsError if the API refuses it.

    The API key never appears in the exception text.
    """
    (post or _post_json)(
        HTTPSMS_API,
        api_key,
        {"content": body, "from": from_number, "to": to},
    )


def httpsms_event_type(body: bytes) -> str | None:
    """The CloudEvent type, or None when the body is not an httpSMS event."""
    try:
        event = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    return kind if isinstance(kind, str) and kind.startswith("message.") else None


def received_sms(body: bytes) -> tuple[str, str] | None:
    """(sender, text) of a message the Android phone received, else None."""
    if httpsms_event_type(body) != "message.phone.received":
        return None
    data = json.loads(body).get("data")
    if not isinstance(data, dict):
        return None
    contact = _phone(str(data.get("contact") or ""))
    if not contact:
        return None
    return contact, str(data.get("content") or "")


def jwt_is_valid(authorization: str | None, key: str | None) -> bool:
    """True when Authorization is a Bearer HS256 JWT signed with the webhook key."""
    if not key or not authorization or not authorization.startswith("Bearer "):
        return False
    parts = authorization.removeprefix("Bearer ").strip().split(".")
    if len(parts) != 3:
        return False
    try:
        header = json.loads(_b64url(parts[0]))
        if not isinstance(header, dict) or header.get("alg") != "HS256":
            return False
        payload = json.loads(_b64url(parts[1]))
        given = _b64url(parts[2])
    except (json.JSONDecodeError, ValueError):
        return False
    expected = hmac.new(key.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
    if len(expected) != len(given) or not hmac.compare_digest(expected, given):
        return False
    exp = payload.get("exp") if isinstance(payload, dict) else None
    return not isinstance(exp, (int, float)) or exp >= time.time()


def _phone(value: str) -> str:
    text = "".join(ch for ch in value if ch.isdigit() or ch == "+")
    if text and not text.startswith("+"):
        text = f"+{text}"
    return text


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _post_json(url: str, api_key: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "x-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "aeros-alerts",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            if not raw:
                return {}
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        raise SmsError(f"httpSMS answered HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SmsError(f"httpSMS unreachable: {type(reason).__name__}") from None


def send_sms(
    account_sid: str,
    token: str,
    from_number: str,
    to: str,
    body: str,
    post: PostForm | None = None,
) -> None:
    """One SMS. Raises SmsError when Twilio does not accept it. Never logs the token."""
    url = f"{TWILIO_API}/{account_sid}/Messages.json"
    answer = (post or _post)(url, account_sid, token, {"To": to, "From": from_number, "Body": body})
    if not answer.get("sid"):
        raise SmsError("Twilio refused the message")


def _post(url: str, account_sid: str, token: str, fields: dict) -> dict:
    data = urllib.parse.urlencode(fields).encode()
    cred = base64.b64encode(f"{account_sid}:{token}".encode()).decode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Basic {cred}",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "aeros-alerts",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise SmsError(f"Twilio answered HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise SmsError(f"Twilio unreachable: {type(reason).__name__}") from None


def signature_is_valid(
    url: str, params: Mapping[str, str], signature: str | None, token: str | None
) -> bool:
    """Twilio's X-Twilio-Signature: HMAC-SHA1 of the URL plus the sorted form fields."""
    if not token or not signature:
        return False
    payload = url + "".join(key + params[key] for key in sorted(params))
    digest = base64.b64encode(hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest())
    return hmac.compare_digest(digest, signature.encode())


def twiml(message: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<Response><Message>{escape(message)}</Message></Response>"
    )


def form_params(body: bytes) -> dict[str, str]:
    parsed = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {key: values[-1] for key, values in parsed.items()}
