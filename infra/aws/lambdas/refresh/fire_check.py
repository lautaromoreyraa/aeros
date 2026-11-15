"""Someone says "there is a fire here": what the satellites saw around that point.

A neighbour who sees smoke can share where they are, from the web or from the
Telegram bot, and aeros answers with what its own data says about that spot:

* GOES-19, the newest scans (rewritten every 10 minutes by `goes_watch`): a fire
  pixel within REPORT_RADIUS_KM means the geostationary satellite sees heat
  there right now;
* VIIRS and MODIS, the near-real-time FIRMS files the daily refresh keeps in
  the data bucket: a detection within the radius in the last LOOKBACK_HOURS
  means a polar pass saw fire there since yesterday.

The answer is one of three verdicts, never a confirmation of a fire:

* `seen_now`: GOES sees a confident fire pixel nearby in its latest scans;
* `seen_recently`: a polar satellite or a low-confidence GOES pixel saw fire nearby;
* `not_seen`: nothing nearby, with both sources up to date. A small fire, clouds,
  thick smoke or a satellite that has not passed yet all hide a real fire, so this
  is "not seen", not "no fire";
* `unknown`: nothing nearby, but the GOES layer is missing or old, or no FIRMS file
  of the last days could be read. Saying "not seen" then would read as "no fire"
  from data that was never looked at, so the answer says it could not check.

Every answer starts by telling the person to call the fire brigade: aeros is an
early warning built on satellites, not an emergency service, and a report to it
reaches no one on the ground.

Nothing is stored: the point is rounded to about 100 m, used for this answer and
dropped, so a report leaves no trace of where someone was. Nothing logs it.
"""

from __future__ import annotations

import csv
import io
import json
import math
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

REPORT_RADIUS_KM = 15.0
LOOKBACK_HOURS = 48
#: A GOES report older than this is too old to say "right now".
GOES_MAX_AGE_MINUTES = 40
EARTH_RADIUS_KM = 6371.0

#: FIRMS source -> file prefix, as `refresh.FILE_PREFIX` stores them.
NRT_FILES = {
    "MODIS_NRT": "fire_nrt_m-c61",
    "VIIRS_NOAA20_NRT": "fire_nrt_j1v-c2",
    "VIIRS_NOAA21_NRT": "fire_nrt_j2v-c2",
}
SATELLITE_NAMES = {"N20": "NOAA-20", "N21": "NOAA-21", "N": "Suomi NPP", "T": "Terra", "A": "Aqua"}

#: The fire brigade, by country, for the study area.
EMERGENCY = (("Argentina", "100"), ("Paraguay", "132"), ("Bolivia", "119"))

#: key -> bytes, or None when the object is not there.
Get = Callable[[str], bytes | None]


class InvalidPoint(ValueError):
    pass


def parse_point(lat: object, lon: object) -> tuple[float, float]:
    """A latitude and longitude from untrusted text, or InvalidPoint."""
    try:
        latitude, longitude = float(str(lat).strip()), float(str(lon).strip())
    except ValueError as error:
        raise InvalidPoint("lat and lon must be numbers") from error
    if not (math.isfinite(latitude) and math.isfinite(longitude)):
        raise InvalidPoint("lat and lon must be numbers")
    if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
        raise InvalidPoint("lat must be within -90..90 and lon within -180..180")
    # About 100 m: plenty for a 15 km radius, and less precise than where someone stands.
    return round(latitude, 3), round(longitude, 3)


def inside(area: tuple[float, float, float, float], lat: float, lon: float) -> bool:
    west, south, east, north = area
    return west <= lon <= east and south <= lat <= north


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class Detection:
    lat: float
    lon: float
    when: datetime
    satellite: str
    confident: bool


def nrt_keys(prefix: str, now: datetime) -> list[str]:
    """The NRT files of today and the two days before, where `refresh` writes them."""
    prefix = prefix if prefix.endswith("/") else prefix + "/"
    days = [(now.astimezone(UTC) - timedelta(days=d)).date() for d in range(3)]
    return [
        f"{prefix}nrt/{day.isoformat()}/{name}_{day.isoformat()}.csv"
        for day in days
        for name in NRT_FILES.values()
    ]


def _when(row: Mapping[str, str]) -> datetime | None:
    try:
        day = date.fromisoformat(row["acq_date"])
        hhmm = row["acq_time"].strip().zfill(4)
        return datetime(day.year, day.month, day.day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=UTC)
    except (KeyError, ValueError):
        return None


def _confident(row: Mapping[str, str]) -> bool:
    """VIIRS says l/n/h; MODIS says 0-100. Low confidence is kept but marked."""
    value = (row.get("confidence") or "").strip().lower()
    if value in ("l", "low"):
        return False
    if value.isdigit():
        return int(value) >= 30
    return True


def parse_nrt(body: bytes) -> list[Detection]:
    out = []
    for row in csv.DictReader(io.StringIO(body.decode("utf-8", "replace"))):
        when = _when(row)
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
        except (KeyError, ValueError):
            continue
        if when is None:
            continue
        satellite = (row.get("satellite") or "").strip()
        out.append(
            Detection(lat, lon, when, SATELLITE_NAMES.get(satellite, satellite), _confident(row))
        )
    return out


def nearest(
    lat: float, lon: float, points: Iterable[tuple[float, float, dict]], radius: float
) -> dict | None:
    best: dict | None = None
    for p_lat, p_lon, info in points:
        d = distance_km(lat, lon, p_lat, p_lon)
        if d <= radius and (best is None or d < best["distance_km"]):
            best = {**info, "lat": p_lat, "lon": p_lon, "distance_km": round(d, 1)}
    return best


def outside_answer(lat: float, lon: float, now: datetime) -> dict:
    """For a point aeros does not watch: no satellite data is read for it."""
    return {
        "verdict": "outside",
        "point": {"lat": lat, "lon": lon},
        "checked_at": now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "emergency": [{"country": c, "number": n} for c, n in EMERGENCY],
    }


def check(
    lat: float,
    lon: float,
    now: datetime,
    goes: Mapping | None,
    detections: list[Detection],
    nrt_files: int,
    radius: float = REPORT_RADIUS_KM,
) -> dict:
    """The verdict and the evidence behind it, as the API returns it."""
    now = now.astimezone(UTC)
    goes_fresh = False
    goes_now = goes_any = None
    if goes:
        try:
            generated = datetime.fromisoformat(str(goes["generated_at"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            generated = None
        goes_fresh = generated is not None and now - generated <= timedelta(
            minutes=GOES_MAX_AGE_MINUTES
        )
        cells = goes.get("cells") or []
        candidates = [
            (
                float(c["lat"]),
                float(c["lng"]),
                {
                    "last_seen": c.get("last_seen"),
                    "confident": bool(c.get("confident_pixels")),
                    "persistent": bool(c.get("persistent")),
                },
            )
            for c in cells
            if "lat" in c and "lng" in c
        ]
        goes_any = nearest(lat, lon, candidates, radius)
        goes_now = nearest(lat, lon, [c for c in candidates if c[2]["confident"]], radius)

    since = now - timedelta(hours=LOOKBACK_HOURS)
    recent = [d for d in detections if since <= d.when <= now]
    polar = nearest(
        lat,
        lon,
        (
            (
                d.lat,
                d.lon,
                {
                    "when": d.when.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "satellite": d.satellite,
                    "confident": d.confident,
                },
            )
            for d in recent
        ),
        radius,
    )
    polar_count = sum(1 for d in recent if distance_km(lat, lon, d.lat, d.lon) <= radius)

    if goes_now and goes_fresh:
        verdict = "seen_now"
    elif polar or goes_any:
        verdict = "seen_recently"
    elif goes_fresh and nrt_files > 0:
        verdict = "not_seen"
    else:
        verdict = "unknown"
    return {
        "verdict": verdict,
        "point": {"lat": lat, "lon": lon},
        "radius_km": radius,
        "goes": {
            "available": goes is not None,
            "fresh": goes_fresh,
            "generated_at": (goes or {}).get("generated_at"),
            "scans": list((goes or {}).get("scans") or []),
            "nearest": goes_now or goes_any,
        },
        "polar": {
            "lookback_hours": LOOKBACK_HOURS,
            "files": nrt_files,
            "detections": polar_count,
            "nearest": polar,
        },
        "checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "emergency": [{"country": c, "number": n} for c, n in EMERGENCY],
    }


def load(
    get: Get, goes_key: str, raw_prefix: str, now: datetime
) -> tuple[dict | None, list[Detection], int]:
    """What `check` needs from the data bucket, and how many NRT files were there.

    A missing file is just missing here; `check` turns too little data into `unknown`.
    """
    goes_body = get(goes_key)
    goes = None
    if goes_body:
        try:
            goes = json.loads(goes_body)
        except ValueError:
            goes = None
    detections: list[Detection] = []
    files = 0
    for key in nrt_keys(raw_prefix, now):
        body = get(key)
        if body:
            files += 1
            detections += parse_nrt(body)
    return goes, detections, files


# ---------- the answer as a message ----------

NL = "\n"


def _hours_ago(stamp: str | None, now: datetime) -> str:
    if not stamp:
        return ""
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return ""
    minutes = max(0, int((now - when).total_seconds() // 60))
    return f"{minutes} min" if minutes < 120 else f"{minutes // 60} h"


def message(result: Mapping, language: str, now: datetime) -> str:
    """The reply the bot sends: brigade first, then what the satellites saw."""
    numbers = ", ".join(f"{c} {n}" for c, n in EMERGENCY)
    verdict = result["verdict"]
    if verdict == "outside":
        if language == "en":
            return (
                f"🚒 If you see fire, call the fire brigade first: {numbers}.\n\n"
                "That point is outside the Gran Chaco, the area aeros watches, so it has no "
                "satellite data to check it against."
            )
        return (
            f"🚒 Si ve fuego, llame primero a los bomberos: {numbers}.\n\n"
            "Ese punto está fuera del Gran Chaco, la zona que vigila aeros, así que no hay "
            "datos satelitales para revisarlo."
        )
    goes = result["goes"]["nearest"]
    polar = result["polar"]["nearest"]
    radius = int(result["radius_km"])
    if verdict == "unknown":
        if language == "en":
            return (
                f"🚒 If you see fire, call the fire brigade first: {numbers}."
                + NL
                + NL
                + "I could not check that point: the satellite data I have is missing or "
                "out of date. That says nothing about whether there is a fire."
            )
        return (
            f"🚒 Si ve fuego, llame primero a los bomberos: {numbers}."
            + NL
            + NL
            + "No pude revisar ese punto: los datos satelitales que tengo faltan o están "
            "desactualizados. Eso no dice nada sobre si hay fuego o no."
        )
    if language == "en":
        lines = [f"🚒 If you see fire, call the fire brigade first: {numbers}.", ""]
        if verdict == "seen_now":
            lines.append(
                f"🔥 GOES-19 sees heat {goes['distance_km']} km from you in its latest scans "
                f"({_hours_ago(goes.get('last_seen'), now)} ago)."
            )
        elif verdict == "seen_recently":
            if polar:
                lines.append(
                    f"🛰️ {polar['satellite']} saw fire {polar['distance_km']} km from you "
                    f"{_hours_ago(polar['when'], now)} ago "
                    f"({result['polar']['detections']} detections within {radius} km, last 48 h)."
                )
            if goes:
                lines.append(
                    f"🛰️ GOES-19 had a fire pixel {goes['distance_km']} km away "
                    f"{_hours_ago(goes.get('last_seen'), now)} ago."
                )
        else:
            lines.append(
                f"No satellite saw fire within {radius} km in the last 48 hours. That does not "
                "mean there is none: a small fire, clouds or smoke can hide it, and the next "
                "pass may catch it."
            )
        lines += ["", "aeros is a satellite early warning, not an emergency service."]
        return "\n".join(lines)
    lines = [f"🚒 Si ve fuego, llame primero a los bomberos: {numbers}.", ""]
    if verdict == "seen_now":
        lines.append(
            f"🔥 GOES-19 ve calor a {goes['distance_km']} km de usted en sus últimos escaneos "
            f"(hace {_hours_ago(goes.get('last_seen'), now)})."
        )
    elif verdict == "seen_recently":
        if polar:
            lines.append(
                f"🛰️ {polar['satellite']} vio fuego a {polar['distance_km']} km de usted hace "
                f"{_hours_ago(polar['when'], now)} "
                f"({result['polar']['detections']} detecciones a menos de {radius} km "
                "en las últimas 48 h)."
            )
        if goes:
            lines.append(
                f"🛰️ GOES-19 tuvo un píxel de fuego a {goes['distance_km']} km hace "
                f"{_hours_ago(goes.get('last_seen'), now)}."
            )
    else:
        lines.append(
            f"Ningún satélite vio fuego a menos de {radius} km en las últimas 48 horas. "
            "Eso no quiere decir que no haya: un fuego chico, las nubes o el humo pueden "
            "ocultarlo, y la próxima pasada puede detectarlo."
        )
    lines += ["", "aeros es un aviso temprano satelital, no un servicio de emergencias."]
    return "\n".join(lines)
