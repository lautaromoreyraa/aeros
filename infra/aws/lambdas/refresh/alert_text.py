"""Alert texts in the language of the person who reads them.

The region speaks Spanish (Argentina, Paraguay, Bolivia), so Spanish is the
default and English is for whoever asks for it. The language comes from the
person: Telegram tells the bot the language of their app, and the web sends the
language of the browser when it signs someone up for e-mail.

The Spanish message is written for neighbours, not analysts. No jargon (no
"hotspot", no "fire weather index", no "ratio"), numbers in words where they
help ("unas 340 veces lo habitual"), the wind as a direction and a strength,
and what to do. It addresses the reader as "usted", which sounds right in every
country of the region. It never gives an emergency number, because they differ
by country and a wrong one is worse than none, and it says plainly that this is
an early warning computed from satellites, not a confirmed fire.

English keeps the message the interface previews (see `targeting.format_message`).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date, datetime

import targeting

LANGUAGES = ("es", "en")
DEFAULT_LANGUAGE = "es"

_MONTHS = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
)  # fmt: skip
_COMPASS = ("norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste")


def pick_language(code: object) -> str:
    """The language for a code like "es-AR", "en" or "pt-BR"; anything unknown is Spanish."""
    base = str(code or "").lower().replace("_", "-").split("-")[0]
    return "en" if base == "en" else DEFAULT_LANGUAGE


def telegram_stop(language: str) -> str:
    """What a Telegram subscriber reads in place of an unsubscribe link: the bot answers /stop."""
    return "send /stop in this chat" if language == "en" else "envíe /stop en este chat"


# ---------- small pieces of Spanish ----------


def _number(value: float, decimals: int = 0) -> str:
    """1.975 and 1,4: dots for thousands and a comma for decimals."""
    text = f"{value:,.{decimals}f}"
    return text.replace(",", "\0").replace(".", ",").replace("\0", ".")


def _dates(start: str, end: str) -> str:
    try:
        first, last = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError:
        return f"{start} – {end}"
    if (first.year, first.month) == (last.year, last.month):
        return f"del {first.day} al {last.day} de {_MONTHS[last.month - 1]}"
    return (
        f"del {first.day} de {_MONTHS[first.month - 1]} al {last.day} de {_MONTHS[last.month - 1]}"
    )


def _place(lat: float, lng: float) -> str:
    south_north = "S" if lat < 0 else "N"
    west_east = "O" if lng < 0 else "E"
    return f"{_number(abs(lat), 1)}° {south_north}, {_number(abs(lng), 1)}° {west_east}"


def _offset(km: float, bearing_deg: float, label: str) -> str:
    """ "a unos 75 km al noreste de Resistencia": how far and which way from the person's town."""
    where = "la zona que eligió" if label == "zone" else label
    if km < 5:
        return f"muy cerca de {where}"
    step = 5 if km < 100 else 10
    direction = _COMPASS[round(bearing_deg / 45) % 8]
    return f"a unos {step * round(km / step)} km al {direction} de {where}"


def _times(ratio: float | None) -> str:
    """How many times the usual, in words a neighbour says."""
    if ratio is None or not math.isfinite(ratio) or ratio < 1.5:
        return "más de lo habitual"
    if ratio < 10:
        return f"{_number(ratio, 1)} veces lo habitual"
    return f"unas {_number(round(ratio))} veces lo habitual"


def _expected(value: float) -> str:
    return "menos de 1" if value < 1 else f"unos {_number(round(value))}"


def _wind(wind: targeting.Wind) -> str:
    speed = wind.speed_kmh
    strength = (
        "flojo"
        if speed < 15
        else "moderado"
        if speed < 30
        else "fuerte"
        if speed < 50
        else "muy fuerte"
    )
    point = _COMPASS[round(wind.blows_to / 45) % 8]
    return (
        f"El viento sopla hacia el {point} ({strength}, {round(speed)} km/h): "
        "el humo y el fuego pueden avanzar en esa dirección."
    )


_WEATHER = {
    "elevated": (
        "Hoy el aire está más seco y ventoso que lo habitual: "
        "el fuego se propaga con más facilidad."
    ),
    "high": "Hoy el aire está muy seco y ventoso: el fuego se propaga rápido.",
    "extreme": (
        "Hoy el aire está extremadamente seco y ventoso: "
        "un fuego puede propagarse muy rápido y ser difícil de controlar."
    ),
}


def _coverage(report: Mapping) -> str:
    start, end = (report.get("window") or ["?", "?"])[:2]
    try:
        days = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days + 1
    except ValueError:
        return ""
    with_data = report.get("days_with_data")
    data_days = min(with_data if isinstance(with_data, int) else len(with_data or []), days)
    gaps = days - data_days
    line = f"Se usaron {data_days} de {days} días con datos de satélite"
    if gaps > 0:
        missing = "falta 1 día" if gaps == 1 else f"faltan {gaps} días"
        return f"{line}; {missing}, y un día sin datos no es un día tranquilo."
    return f"{line}."


def venue_text(language: str, name: str) -> tuple[str, str]:
    """Title and address of the map pin Telegram shows for a zone; the pin is approximate."""
    if language == "en":
        return "Area with a lot of fire (approximate)", f"{name} · within about 20 km"
    return "Zona con mucho fuego (aproximada)", f"{name} · dentro de unos 20 km"


# ---------- a possible fire, as GOES-19 sees it ----------


def _minutes_ago(last_seen: str, now: datetime, language: str) -> str:
    """ "hace unos 15 minutos": relative, so nobody has to convert a time zone."""
    try:
        seen = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return ""
    minutes = max(0, round((now - seen).total_seconds() / 60))
    if minutes < 5:
        return "a few minutes ago" if language == "en" else "hace pocos minutos"
    if minutes < 90:
        step = 5 * round(minutes / 5)
        return f"about {step} minutes ago" if language == "en" else f"hace unos {step} minutos"
    hours = round(minutes / 60)
    return f"about {hours} hours ago" if language == "en" else f"hace unas {hours} horas"


def fire_pin_text(language: str, offset: tuple[float, float, str]) -> tuple[str, str]:
    """Title and address of the map pin of a possible fire; GOES places it within a few km."""
    if language == "en":
        return "Possible fire (approximate)", targeting.offset_en(*offset).rstrip(".")
    where = _offset(*offset)
    return "Posible incendio (ubicación aproximada)", where[0].upper() + where[1:]


def fire_message(
    fires: list[tuple[Mapping, tuple[float, float, str]]],
    language: str = DEFAULT_LANGUAGE,
    *,
    scans: int,
    now: datetime,
    wind: targeting.Wind | None = None,
    web_url: str = "",
    unsubscribe: str = "",
    pins: bool = False,
    map_links: bool = False,
    max_fires: int = 3,
) -> tuple[str, str]:
    """(subject, text) of a possible fire near one subscriber; `fires` come nearest first.

    Each fire is a cell of `goes_latest.json` with the (km, bearing, label) from the person.
    It says plainly that it may be a controlled burn: GOES sees heat, not its cause.
    """
    first, offset = fires[0]
    ago = _minutes_ago(first.get("last_seen", ""), now, language)
    seen = first.get("confident_scans") or 2
    if language == "en":
        where = targeting.offset_en(*offset).rstrip(".")
        lines = [
            "Possible fire near you",
            f"The GOES-19 satellite sees active fire {where[0].lower() + where[1:]}, "
            f"in {seen} of its last {scans} scans (one every 10 minutes)."
            + (f" Last seen {ago}." if ago else ""),
        ]
        for _entry, other in fires[1:max_fires]:
            lines.append(f"• Also: {targeting.offset_en(*other)}")
        if len(fires) > max_fires:
            lines.append(f"• and {len(fires) - max_fires} more nearby.")
        if map_links:
            lines.append(f"See it on a map: {targeting.map_link(*targeting.place_of(first))}")
        if pins:
            lines.append("The approximate location follows on a map.")
        if wind is not None and wind.speed_kmh >= 1:
            lines += ["", f"The wind blows {targeting.describe_wind(wind)}."]
        lines += [
            "",
            "What to do:",
            "• Do not light fires or burn grass or rubbish.",
            "• If you see smoke or fire, call your local fire brigade at once.",
            "• If there is smoke nearby, close the windows and avoid effort outdoors.",
            "",
            "This is an automatic alert from satellites: the location is approximate (a few km) "
            "and it may be a controlled burn. It does not confirm a fire.",
        ]
        if web_url:
            lines.append(f"Map: {web_url}")
        if unsubscribe:
            lines.append(f"To stop these alerts: {unsubscribe}")
        return f"Possible fire {where[0].lower() + where[1:]}", "\n".join(lines)

    where = _offset(*offset)
    lines = [
        "🔥 Posible incendio cerca de usted",
        f"El satélite GOES-19 detecta fuego activo {where}, en {seen} de sus últimas "
        f"{scans} pasadas (pasa cada 10 minutos)." + (f" Última detección: {ago}." if ago else ""),
    ]
    for _entry, other in fires[1:max_fires]:
        lines.append(f"• También: {_offset(*other)}.")
    if len(fires) > max_fires:
        extra = len(fires) - max_fires
        lines.append(f"• y {extra} {'foco más' if extra == 1 else 'focos más'} cerca.")
    if map_links:
        lines.append(f"Verlo en el mapa: {targeting.map_link(*targeting.place_of(first))}")
    if pins:
        lines.append("Abajo le mando la ubicación aproximada en el mapa.")
    if wind is not None and wind.speed_kmh >= 1:
        lines += ["", _wind(wind)]
    lines += [
        "",
        "Qué conviene hacer:",
        "• No haga fuego, no queme pastos ni basura y no tire colillas.",
        "• Si ve humo o fuego, avise de inmediato a los bomberos de su zona.",
        "• Si hay humo cerca, cierre las ventanas y evite el esfuerzo al aire libre.",
        "",
        "Es un aviso automático calculado con satélites: la ubicación es aproximada (unos "
        "pocos km) y puede tratarse de una quema controlada. No confirma un incendio.",
    ]
    if web_url:
        lines.append(f"Mapa: {web_url}")
    if unsubscribe:
        lines.append(f"Para dejar de recibir estos avisos: {unsubscribe}")
    return f"Posible incendio {where}", "\n".join(lines)


def _format_es(
    match: targeting.Match,
    report: Mapping,
    *,
    region_ratio: float | None,
    sector_of: Mapping[str, str] | None,
    web_url: str,
    unsubscribe: str,
    wind: targeting.Wind | None,
    fire_weather: Mapping | None,
    pins: bool,
    map_links: bool,
    max_places: int,
    distances: Mapping[str, tuple[float, float, str]] | None,
) -> tuple[str, str]:
    start, end = (report.get("window") or ["?", "?"])[:2]
    sector_of = sector_of or {}
    areas = len(match.flagged)
    subject = (
        "Aviso de incendios: actividad de fuego muy por encima de lo normal "
        f"en {areas} {'zona' if areas == 1 else 'zonas'} cerca de usted"
    )

    lines = [
        "⚠ Aviso temprano de incendios",
        "Cerca de la zona que eligió se detectó mucho más fuego de lo habitual "
        f"{_dates(start, end)}.",
    ]
    if region_ratio is not None:
        lines.append(
            f"En toda la región hay {_times(region_ratio).replace('lo habitual', 'lo normal')}."
        )
    lines += ["", "Dónde:"]
    for entry in match.flagged[:max_places]:
        lat, lng = targeting.place_of(entry)
        name = sector_of.get(entry["cell"], "Gran Chaco")
        # With a pin or a link the reader sees the place on a map: no coordinates to decipher.
        if distances and entry["cell"] in distances:
            where = f", {_offset(*distances[entry['cell']])}"
        elif pins or map_links:
            where = ""
        else:
            where = f" (cerca de {_place(lat, lng)})"
        lines.append(
            f"• {name}{where}: {_times(entry.get('ratio'))}. "
            f"Se detectaron {_number(entry['observed'])} puntos de calor desde satélite; "
            f"lo normal serían {_expected(entry['expected'])}."
        )
        if map_links:
            lines.append(
                f"  Ver la ubicación aproximada en el mapa: {targeting.map_link(lat, lng)}"
            )
    if areas > max_places:
        extra = areas - max_places
        lines.append(f"• y {extra} {'zona más' if extra == 1 else 'zonas más'} con mucho fuego.")
    if pins:
        lines.append("Abajo le mando la ubicación aproximada en el mapa.")

    conditions = []
    if wind is not None and wind.speed_kmh >= 1:
        conditions.append(_wind(wind))
    if fire_weather and fire_weather["level"] in _WEATHER:
        conditions.append(_WEATHER[fire_weather["level"]])
    if conditions:
        lines += ["", *conditions]

    lines += [
        "",
        "Qué conviene hacer:",
        "• No haga fuego, no queme pastos ni basura y no tire colillas.",
        "• Si ve humo o fuego, avise de inmediato a los bomberos de su zona.",
        "• Si hay humo cerca, cierre las ventanas y evite el esfuerzo al aire libre.",
        "",
        "Es un aviso temprano calculado con satélites de la NASA: indica que hay más fuego "
        "que de costumbre, no confirma un incendio en un lugar exacto.",
    ]
    if coverage := _coverage(report):
        lines.append(coverage)
    if web_url:
        lines.append(f"Mapa: {web_url}")
    if unsubscribe:
        lines.append(f"Para dejar de recibir estos avisos: {unsubscribe}")
    return subject, "\n".join(lines)


def format_message(
    match: targeting.Match,
    report: Mapping,
    language: str = DEFAULT_LANGUAGE,
    *,
    region_ratio: float | None = None,
    sector_of: Mapping[str, str] | None = None,
    web_url: str = "",
    unsubscribe: str = "",
    wind: targeting.Wind | None = None,
    fire_weather: Mapping | None = None,
    pins: bool = False,
    map_links: bool = False,
    max_places: int = targeting.MAX_PLACES,
    distances: Mapping[str, tuple[float, float, str]] | None = None,
) -> tuple[str, str]:
    """(subject, text) for one subscriber, in their language.

    `pins` says map pins follow the message (Telegram); `map_links` puts a link under each zone
    (e-mail). Either one replaces the coordinates with the place on a map.
    """
    options = dict(
        region_ratio=region_ratio,
        sector_of=sector_of,
        web_url=web_url,
        unsubscribe=unsubscribe,
        wind=wind,
        fire_weather=fire_weather,
    )
    if language == "en":
        return targeting.format_message(
            match,
            report,
            map_links=map_links,
            max_places=max_places,
            distances=distances,
            **options,
        )
    return _format_es(
        match,
        report,
        pins=pins,
        map_links=map_links,
        max_places=max_places,
        distances=distances,
        **options,
    )
