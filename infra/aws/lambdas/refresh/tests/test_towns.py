"""Saying where you live: finding the town, subscribing to it, and how far the fire is from it."""

import json
import urllib.error
from datetime import UTC, datetime

import h3
import pytest

import alert_text as t
import alerts_api as a
import notifier as n
import places
import subscriptions as s
import targeting
import telegram_bot as bot

AREA = (-69.0, -35.0, -53.0, -16.0)
CELL = h3.latlng_to_cell(-27.45, -58.98, 4)
NOW = datetime(2026, 11, 14, 22, 30, tzinfo=UTC)

RESISTENCIA = {
    "name": "Resistencia",
    "region": "Chaco",
    "country": "Argentina",
    "lat": -27.45,
    "lng": -58.99,
}


def row(name, lat, lng, region="", country="", code="PPLA"):
    return {
        "name": name,
        "latitude": lat,
        "longitude": lng,
        "admin1": region,
        "country": country,
        "feature_code": code,
    }


class Geocoder:
    """A stand-in for Open-Meteo's geocoding API: remembers what it was asked."""

    def __init__(self, *rows):
        self.rows = list(rows)
        self.urls: list[str] = []

    def __call__(self, url):
        self.urls.append(url)
        return {"results": self.rows}


@pytest.fixture(autouse=True)
def fresh_cache():
    places._cache.clear()


# ---------- finding a town ----------


def test_the_search_keeps_populated_places_inside_the_area_most_relevant_first():
    geocoder = Geocoder(
        row("Resistencia", -27.4514, -58.9867, "Chaco", "Argentina"),
        row("Resistencia", -27.4, -58.9, code="STM"),  # a stream, not a town
        row("Resistencia", 40.0, -3.7, "Madrid", "España"),  # another continent
        row("Resistencia", -27.4514, -58.9867, "Chaco", "Argentina"),  # the same town twice
        {"name": "sin posición"},
    )
    found = places.search("  Resistencia ", "es", AREA, get=geocoder)
    assert found == [
        {
            "name": "Resistencia",
            "region": "Chaco",
            "country": "Argentina",
            "lat": -27.45,
            "lng": -58.99,
        }
    ]
    assert "name=Resistencia" in geocoder.urls[0] and "language=es" in geocoder.urls[0]


def test_the_search_asks_in_the_readers_language_and_no_more_than_five_come_back():
    geocoder = Geocoder(
        *[row(f"San Pedro {i}", -25.0 - i * 0.1, -57.0, "X", "Y") for i in range(9)]
    )
    assert len(places.search("San Pedro", "en", AREA, get=geocoder)) == 5
    assert "language=en" in geocoder.urls[0]


@pytest.mark.parametrize("query", ["", " ", "a", "\n\t"])
def test_a_query_too_short_is_not_even_sent(query):
    geocoder = Geocoder()
    assert places.search(query, "es", AREA, get=geocoder) == []
    assert geocoder.urls == []


def test_only_the_name_typed_leaves_and_it_is_cut_and_encoded():
    geocoder = Geocoder()
    places.search("Villa Ángela & co?" + "x" * 100, "es", AREA, get=geocoder)
    assert "%C3%81ngela" in geocoder.urls[0] and "%26" in geocoder.urls[0]
    assert len(geocoder.urls[0].split("name=")[1].split("&count")[0]) < 200


def test_a_province_after_a_comma_narrows_the_answers_and_is_not_sent():
    geocoder = Geocoder(
        row("General Jose de San Martin", -26.54, -59.34, "Provincia del Chaco", "Argentina"),
        row("General José de San Martín", -34.5, -58.5, "Buenos Aires", "Argentina"),
    )
    found = places.search("General José de San Martín, chaco", "es", AREA, get=geocoder)
    assert [f["region"] for f in found] == ["Provincia del Chaco"]
    assert "%2C" not in geocoder.urls[0] and "chaco" not in geocoder.urls[0].lower()


def test_a_hint_that_matches_nothing_is_ignored_and_accents_do_not_matter():
    geocoder = Geocoder(row("Villa Ángela", -27.57, -60.72, "Chaco", "Argentina"))
    assert len(places.search("Villa Angela, Mars", "es", AREA, get=geocoder)) == 1
    places._cache.clear()
    assert len(places.search("Villa Angela, CHACÓ", "es", AREA, get=geocoder)) == 1
    assert places._fold("Ángela ÑANDÚ") == "angela nandu"
    assert places.search(", chaco", "es", AREA, get=geocoder) == []


def test_a_repeated_search_does_not_ask_again():
    geocoder = Geocoder(row("Formosa", -26.18, -58.17, "Formosa", "Argentina"))
    places.search("Formosa", "es", AREA, get=geocoder)
    places.search("formosa", "es", AREA, get=geocoder)
    assert len(geocoder.urls) == 1


def test_a_failing_geocoder_is_an_error_without_its_url(monkeypatch):
    def refuse(request, timeout):
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(places.urllib.request, "urlopen", refuse)
    with pytest.raises(places.PlacesError) as info:
        places._get_json(places.GEOCODING)
    assert str(info.value) == "geocoding failed: URLError"


def test_a_town_is_labelled_the_way_people_say_it():
    assert places.label(RESISTENCIA) == "Resistencia, Chaco, Argentina"
    assert places.label({"name": "Villa X", "region": "", "country": None}) == "Villa X"


# ---------- subscribing to a town ----------


@pytest.fixture
def service():
    return s.Subscriptions(s.MemoryStore(), area=AREA)


def test_a_town_gives_the_cells_around_it_without_the_client_sending_any(service):
    sub = service.create("email", "ana@example.com", [], place=RESISTENCIA)
    assert sub.place == RESISTENCIA
    assert CELL in sub.cells and len(sub.cells) > 7  # about 100 km around, not just one cell
    assert all(h3.get_resolution(c) == 4 for c in sub.cells)


def test_the_town_is_cleaned_and_must_be_inside_the_area(service):
    dirty = {"name": "  Resis\x00tencia  ", "lat": "-27.451", "lng": -58.99, "region": "C" * 99}
    sub = service.create("email", "ana@example.com", [], place=dirty)
    assert sub.place["name"] == "Resistencia" and sub.place["lat"] == -27.45
    assert len(sub.place["region"]) == 60
    long_name = {"name": "x" * 200, "lat": -27.4, "lng": -58.9}
    assert len(service.create("email", "bo@example.com", [], place=long_name).place["name"]) == 80
    for bad in (
        "Resistencia",
        {"lat": -27.4, "lng": -58.9},
        {"name": "Madrid", "lat": 40.4, "lng": -3.7},
        {"name": "Nowhere", "lat": 95, "lng": 0},
        {"name": "Nowhere", "lat": "north", "lng": 0},
    ):
        with pytest.raises(s.InvalidSubscription):
            service.create("email", "luis@example.com", [], place=bad)


def test_writing_a_town_to_the_bot_is_the_whole_sign_up(service):
    sub = service.subscribe_place(555, RESISTENCIA, "es-AR")
    assert (sub.status, sub.address, sub.language) == ("confirmed", "555", "es")
    assert sub.place["name"] == "Resistencia"
    assert [x.id for x in service.confirmed()] == [sub.id]


def test_a_new_town_replaces_the_old_one_of_the_same_chat(service):
    service.subscribe_place(555, RESISTENCIA)
    other = service.subscribe_place(555, {"name": "Formosa", "lat": -26.18, "lng": -58.17})
    assert [x.id for x in service.confirmed()] == [other.id]


def test_the_town_survives_being_stored_and_read_back(service):
    sub = service.subscribe_place(555, RESISTENCIA)
    assert s.Subscription.from_dict(sub.to_dict()) == sub


# ---------- how far, in words ----------


def test_the_distance_and_direction_are_measured_from_the_town_not_from_a_cell(service):
    sub = service.subscribe_place(555, RESISTENCIA)
    north = {"cell": h3.latlng_to_cell(-26.5, -58.99, 4), "lat": -26.5, "lng": -58.99}
    km, bearing, label = targeting.offset_from(sub, north)
    assert label == "Resistencia" and 100 < km < 110 and (bearing < 5 or bearing > 355)
    assert (
        targeting.offset_from(service.create("email", "a@example.com", [CELL]), north)[2] == "zone"
    )


def test_the_message_says_how_far_from_the_town_in_plain_words():
    assert t._offset(75.3, 45.0, "Resistencia") == "a unos 75 km al noreste de Resistencia"
    assert t._offset(112.0, 200.0, "Resistencia") == "a unos 110 km al sur de Resistencia"
    assert t._offset(3.0, 90.0, "Resistencia") == "muy cerca de Resistencia"
    assert t._offset(40.0, 270.0, "zone") == "a unos 40 km al oeste de la zona que eligió"
    assert (
        targeting.offset_en(75.3, 45.0, "Resistencia") == "About 75 km north-east of Resistencia."
    )
    assert targeting.offset_en(3.0, 90.0, "zone") == "Very close to the area you chose."


def entry(cell, **extra):
    return {"cell": cell, "observed": 203, "expected": 0.6, "ratio": 339.7, "p_value": 0.0, **extra}


def report(*entries):
    return {
        "window": ["2026-11-08", "2026-11-14"],
        "days_with_data": 7,
        "region": {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
        "cells": list(entries),
    }


def test_the_alert_says_how_far_the_fire_is_from_the_town_and_pins_the_nearest(service):
    service.subscribe_place(555, RESISTENCIA)
    north = h3.latlng_to_cell(-26.5, -58.99, 4)
    far = h3.latlng_to_cell(-24.5, -58.99, 4)
    sent = []
    pins = []
    n.notify(
        report(entry(far, lat=-24.5, lng=-58.99), entry(north, lat=-26.5, lng=-58.99, ratio=5.0)),
        service,
        {"telegram": lambda sub, subject, text: sent.append(text)},
        place_senders={"telegram": lambda sub, places_: pins.append(places_)},
        now=NOW,
    )
    (text,) = sent
    assert "al norte de Resistencia" in text and "° S" not in text
    assert [p[0][:2] for p in pins] == [(-26.5, -58.99)]  # the near one, not the far one


# ---------- the bot ----------


class Outbox:
    def __init__(self):
        self.sent: list[tuple[int, str, dict | None]] = []

    def __call__(self, chat_id, text, markup=None):
        self.sent.append((chat_id, text, markup))


def message(text, language="es", chat_type="private"):
    return {
        "message": {
            "text": text,
            "chat": {"id": 42, "type": chat_type},
            "from": {"language_code": language},
        }
    }


def press(data, language="es"):
    return {
        "callback_query": {
            "id": "cb1",
            "data": data,
            "from": {"language_code": language},
            "message": {"chat": {"id": 42, "type": "private"}},
        }
    }


def run(service, update, found=None, **kwargs):
    outbox = Outbox()
    outcome = bot.handle(
        update, service, outbox, find=lambda query, language: found or [], **kwargs
    )
    return outcome, outbox


def test_one_town_found_subscribes_the_chat_at_once(service):
    outcome, outbox = run(service, message("Resistencia"), [RESISTENCIA])
    assert outcome == "subscribed"
    assert "cerca de Resistencia, Chaco, Argentina" in outbox.sent[0][1]
    (sub,) = service.confirmed()
    assert sub.address == "42" and sub.place["name"] == "Resistencia"


def test_the_bot_answers_in_english_to_an_english_app(service):
    _, outbox = run(service, message("Resistencia", "en-US"), [RESISTENCIA])
    assert "much more fire than usual near Resistencia" in outbox.sent[0][1]


def test_several_towns_show_a_button_each_and_subscribe_nothing_yet(service):
    towns = [
        {
            "name": "San Pedro",
            "region": "Jujuy",
            "country": "Argentina",
            "lat": -24.23,
            "lng": -64.87,
        },
        {
            "name": "San Pedro",
            "region": "San Pedro",
            "country": "Paraguay",
            "lat": -24.09,
            "lng": -57.08,
        },
    ]
    outcome, outbox = run(service, message("San Pedro"), towns)
    assert outcome == "choose" and service.confirmed() == []
    keyboard = outbox.sent[0][2]["inline_keyboard"]
    assert [row_[0]["text"] for row_ in keyboard] == [
        "San Pedro, Jujuy, Argentina",
        "San Pedro, San Pedro, Paraguay",
    ]
    assert all(len(row_[0]["callback_data"].encode()) <= 64 for row_ in keyboard)


def test_pressing_a_button_subscribes_and_answers_the_press(service):
    answered = []
    data = bot.pick_data({"name": "San Pedro", "lat": -24.09, "lng": -57.08})
    outcome, outbox = run(service, press(data), answer=answered.append)
    assert outcome == "subscribed" and answered == ["cb1"]
    assert service.confirmed()[0].place["name"] == "San Pedro"
    assert "cerca de San Pedro" in outbox.sent[0][1]


def test_a_button_with_nonsense_or_a_place_out_of_the_area_subscribes_nothing(service):
    for data in ("p|north|east|Algo", "p|only|two", "x|1|2|Nope", "p|40.4|-3.7|Madrid"):
        outcome, _ = run(service, press(data))
        assert outcome in ("expired", "outside", "ignored"), data
    assert service.confirmed() == []


def test_the_data_of_a_button_is_cut_to_fit_without_breaking_a_letter():
    data = bot.pick_data({"name": "Ñandú" * 30, "lat": -24.09, "lng": -57.08})
    assert len(data.encode()) <= 64
    assert bot.place_from_pick(data)["name"].startswith("Ñandú")


def test_an_unknown_town_and_a_geocoder_that_fails_get_a_kind_answer(service):
    outcome, outbox = run(service, message("Zzzz"), [])
    assert outcome == "not_found" and "No encontré «Zzzz»" in outbox.sent[0][1]

    def down(query, language):
        raise places.PlacesError("geocoding failed: URLError")

    out = Outbox()
    assert bot.handle(message("Resistencia"), service, out, find=down) == "unavailable"
    assert "No pude buscar" in out.sent[0][1] and service.confirmed() == []


def test_without_a_geocoder_a_message_is_just_help(service):
    out = Outbox()
    assert bot.handle(message("Resistencia"), service, out) == "help"


def test_start_asks_for_the_town_and_never_for_a_location(service):
    outcome, outbox = run(service, message("/start"))
    text = outbox.sent[0][1]
    assert outcome == "welcome" and "escriba el nombre de su localidad" in text
    assert outbox.sent[0][2] is None  # no keyboard, no location button
    # The only word about the location is that it is not needed.
    assert text.count("ubicación") == 1 and "ni compartir su ubicación" in text


def test_stop_ends_the_alerts_of_a_town_too(service):
    run(service, message("Resistencia"), [RESISTENCIA])
    outcome, outbox = run(service, message("/stop"))
    assert outcome == "stopped" and service.confirmed() == []


# ---------- the API ----------


def event(method, path, query=None, body=None):
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "queryStringParameters": query,
        "headers": {},
        "body": json.dumps(body) if body is not None else "",
    }


@pytest.fixture
def deps(service):
    return a.Dependencies(
        service,
        web_url="https://aeros.example",
        send_mail=lambda address, subject, text: None,
        find=lambda query, language: [RESISTENCIA] if query.lower().startswith("resis") else [],
    )


def test_the_site_searches_towns_by_name(deps):
    ok = a.api_handler(event("GET", a.PLACES, {"q": "Resis", "language": "es"}), deps=deps)
    assert ok["statusCode"] == 200 and json.loads(ok["body"]) == {"places": [RESISTENCIA]}
    none = a.api_handler(event("GET", a.PLACES, {"q": "zzz"}), deps=deps)
    assert json.loads(none["body"]) == {"places": []}
    assert a.api_handler(event("GET", a.PLACES), deps=deps)["statusCode"] == 200


def test_the_search_is_unavailable_without_a_geocoder_and_a_502_when_it_fails(deps):
    deps.find = None
    assert a.api_handler(event("GET", a.PLACES, {"q": "x"}), deps=deps)["statusCode"] == 503

    def down(query, language):
        raise places.PlacesError("geocoding failed: URLError")

    deps.find = down
    answer = a.api_handler(event("GET", a.PLACES, {"q": "xx"}), deps=deps)
    assert answer["statusCode"] == 502 and "URLError" not in answer["body"]


def test_a_sign_up_by_town_needs_no_cells(deps):
    body = {"channel": "email", "address": "ana@example.com", "place": RESISTENCIA}
    response = a.api_handler(event("POST", a.PREFIX, body=body), deps=deps)
    assert response["statusCode"] == 202
    (sub,) = deps.subscriptions.store.all()
    assert sub.place["name"] == "Resistencia" and CELL in sub.cells


def test_a_sign_up_with_a_bad_town_is_a_400(deps):
    body = {
        "channel": "email",
        "address": "ana@example.com",
        "place": {"name": "Madrid", "lat": 40, "lng": -3},
    }
    response = a.api_handler(event("POST", a.PREFIX, body=body), deps=deps)
    assert response["statusCode"] == 400 and deps.subscriptions.store.all() == []


def test_the_webhook_passes_the_town_search_and_the_button_answer_to_the_bot(deps):
    said = []
    answered = []
    deps.reply = lambda chat_id, text, markup=None: said.append((chat_id, text))
    deps.answer = answered.append
    deps.webhook_secret = "s3cret"
    data = bot.pick_data(RESISTENCIA)
    update = press(data)
    response = a.webhook_handler(
        {
            "headers": {bot.SECRET_HEADER: "s3cret"},
            "body": json.dumps(update),
            "requestContext": {"http": {"method": "POST"}},
        },
        deps=deps,
    )
    assert response["statusCode"] == 200 and answered == ["cb1"]
    assert deps.subscriptions.confirmed()[0].place["name"] == "Resistencia"


def test_the_buttons_data_and_the_telegram_helpers_build_what_telegram_expects():
    calls = []
    import alerts

    def post(url, body):
        calls.append((url.rsplit("/", 1)[1], body))
        return {"ok": True}

    alerts.answer_telegram_button(post, "BOT:TOKEN", "cb1")
    alerts.send_telegram(post, "BOT:TOKEN", "42", "hola", {"inline_keyboard": []})
    alerts.send_telegram(post, "BOT:TOKEN", "42", "hola")
    assert calls[0] == ("answerCallbackQuery", {"callback_query_id": "cb1"})
    assert calls[1][1]["reply_markup"] == {"inline_keyboard": []}
    assert "reply_markup" not in calls[2][1]
