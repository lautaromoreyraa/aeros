import h3
import pytest

import alert_text as t
import targeting

ORIGIN = h3.latlng_to_cell(-20.8, -61.2, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]
REPORT = {
    "window": ["2026-11-08", "2026-11-14"],
    "days_with_data": 7,
    "region": {"observed": 100, "expected": 90.0, "ratio": 1.1, "p_value": 0.4},
}


def match(*entries):
    flagged = tuple(
        {"cell": c, "observed": obs, "expected": exp, "ratio": ratio, "p_value": 0.0}
        for c, obs, exp, ratio in entries
    )
    return targeting.Match(targeting.Subscriber("i", "telegram", "1", frozenset([ORIGIN])), flagged)


ONE = match((ORIGIN, 203, 0.598, 339.671))


def spanish(m=ONE, report=REPORT, **kwargs):
    return t.format_message(m, report, "es", **kwargs)


# ---------- which language ----------


@pytest.mark.parametrize(
    ("code", "language"),
    [
        ("es", "es"), ("es-AR", "es"), ("es_PY", "es"), ("gn", "es"), ("pt-BR", "es"),
        ("en", "en"), ("en-US", "en"), ("EN-gb", "en"),
        (None, "es"), ("", "es"), (5, "es"),
    ],
)  # fmt: skip
def test_the_language_is_spanish_unless_the_person_asks_for_english(code, language):
    assert t.pick_language(code) == language


def test_telegram_subscribers_read_the_stop_command_in_their_language():
    assert t.telegram_stop("es") == "envíe /stop en este chat"
    assert t.telegram_stop("en") == "send /stop in this chat"


def test_english_is_the_message_the_interface_previews():
    subject, text = t.format_message(ONE, REPORT, "en")
    assert subject == "Early warning: 1 area near you well above normal"
    assert "Window: Nov 8 – Nov 14" in text


# ---------- the Spanish message ----------


def test_the_message_says_where_how_much_and_what_to_do():
    subject, text = spanish(web_url="https://aeros.example", unsubscribe="envíe /stop en este chat")
    assert subject == (
        "Aviso de incendios: actividad de fuego muy por encima de lo normal "
        "en 1 zona cerca de usted"
    )
    assert "del 8 al 14 de noviembre" in text
    assert "Gran Chaco (cerca de 20,8° S, 61,2° O): unas 340 veces lo habitual." in text
    assert "Se detectaron 203 puntos de calor desde satélite; lo normal serían menos de 1." in text
    assert "Qué conviene hacer:" in text
    assert "avise de inmediato a los bomberos de su zona" in text
    assert "Mapa: https://aeros.example" in text
    assert text.endswith("Para dejar de recibir estos avisos: envíe /stop en este chat")


def test_it_is_honest_that_this_is_an_early_warning_and_never_gives_a_phone_number():
    _, text = spanish()
    assert "no confirma un incendio en un lugar exacto" in text
    assert "satélites de la NASA" in text
    import re

    assert not re.search(r"\b(?:100|103|132|119|193|911)\b", text)  # no emergency numbers


def test_it_avoids_the_words_only_analysts_use():
    _, text = spanish(
        wind=targeting.Wind(10.0, 0.0),
        fire_weather={"level": "high", "percentile": 93.0, "hdw": 200.0},
    )
    lowered = text.lower()
    for jargon in ("hotspot", "hot-dry-windy", "ratio", "percentil", "h3", "p-valor", "p_value"):
        assert jargon not in lowered
    assert " usted" in lowered or "su zona" in lowered  # it speaks to the reader with respect


def test_the_wind_is_a_direction_and_a_strength_in_words():
    _, text = spanish(wind=targeting.Wind(10.0, 0.0))  # 36 km/h toward the east
    assert "El viento sopla hacia el este (fuerte, 36 km/h)" in text
    assert "el humo y el fuego pueden avanzar en esa dirección" in text
    for u, v, word in [(2.0, 0.0, "flojo"), (6.0, 0.0, "moderado"), (20.0, 0.0, "muy fuerte")]:
        assert word in spanish(wind=targeting.Wind(u, v))[1]
    assert "hacia el norte" in spanish(wind=targeting.Wind(0.0, 5.0))[1]
    assert "hacia el suroeste" in spanish(wind=targeting.Wind(-5.0, -5.0))[1]
    assert "viento" not in spanish(wind=targeting.Wind(0.0, 0.0))[1].lower().replace("conviene", "")


@pytest.mark.parametrize(
    ("level", "phrase"),
    [
        ("elevated", "más seco y ventoso que lo habitual"),
        ("high", "muy seco y ventoso: el fuego se propaga rápido"),
        ("extreme", "extremadamente seco y ventoso"),
    ],
)
def test_the_fire_weather_is_told_as_how_dry_and_windy_the_air_is(level, phrase):
    _, text = spanish(fire_weather={"level": level, "percentile": 96.0, "hdw": 1.0})
    assert phrase in text


def test_a_normal_day_adds_no_weather_line():
    _, text = spanish(fire_weather={"level": "normal", "percentile": 20.0, "hdw": 1.0})
    assert "seco y ventoso" not in text


def test_how_much_above_normal_is_said_in_words_a_neighbour_uses():
    assert t._times(339.7) == "unas 340 veces lo habitual"
    assert t._times(4.26) == "4,3 veces lo habitual"
    assert t._times(1.2) == "más de lo habitual"
    assert t._times(None) == "más de lo habitual"
    assert t._times(float("inf")) == "más de lo habitual"
    assert t._expected(0.6) == "menos de 1"
    assert t._expected(1975.6) == "unos 1.976"


def test_dates_numbers_and_places_follow_spanish_usage():
    assert t._dates("2026-11-08", "2026-11-14") == "del 8 al 14 de noviembre"
    assert t._dates("2026-10-28", "2026-11-03") == "del 28 de octubre al 3 de noviembre"
    assert t._dates("?", "?") == "? – ?"
    assert t._number(1234567.891, 1) == "1.234.567,9"
    assert t._place(-20.8, -61.2) == "20,8° S, 61,2° O"
    assert t._place(10.0, 5.0) == "10,0° N, 5,0° E"


def test_several_zones_show_the_first_three_and_count_the_rest():
    cells = h3.grid_disk(ORIGIN, 1)[:5]
    m = match(*[(c, 50, 2.0, 25.0) for c in cells])
    subject, text = spanish(m)
    assert "en 5 zonas cerca de usted" in subject
    assert "• y 2 zonas más con mucho fuego." in text


def test_a_whole_region_alert_says_so_in_plain_words():
    _, text = spanish(region_ratio=4.0)
    assert "En toda la región hay 4,0 veces lo normal." in text


def test_missing_days_are_said_and_are_not_a_quiet_day():
    _, text = spanish(report={**REPORT, "days_with_data": 5})
    assert "Se usaron 5 de 7 días con datos de satélite; faltan 2 días" in text
    assert "no es un día tranquilo" in text
    _, one = spanish(report={**REPORT, "days_with_data": 6})
    assert "falta 1 día" in one
    _, full = spanish()
    assert "Se usaron 7 de 7 días con datos de satélite." in full


def test_the_sector_name_comes_from_the_dashboard_when_there_is_one():
    _, text = spanish(sector_of={ORIGIN: "Chaco Boreal"})
    assert "• Chaco Boreal (cerca de" in text
