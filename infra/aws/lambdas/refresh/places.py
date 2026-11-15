"""Finding a town by its name, so a person can say where they live and nothing more.

Neither Telegram nor an e-mail knows where its reader is, and guessing from the network
address puts people in the capital of their provider. So the person says it: they write
the name of their town in the bot, or type it on the site, and this finds it.

The search is Open-Meteo's geocoding API (free, no key, CC BY 4.0, built on GeoNames; the
project already credits Open-Meteo for the wind). Only populated places inside the monitored
area come back, so "San Pedro" offers the ones of this region and not the other twenty on
the planet. Nothing about the person is sent: only the name they typed.

A town is a public place, not a position of a person: what a subscription keeps is the name
and the town's centre, to a hundredth of a degree.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence

logger = logging.getLogger()

GEOCODING = "https://geocoding-api.open-meteo.com/v1/search"
MAX_RESULTS = 5
MAX_QUERY = 60
#: Queries asked so far in this container; towns do not move, and the API has a daily quota.
_CACHE_SIZE = 500

Get = Callable[[str], dict]


class PlacesError(RuntimeError):
    """The geocoder could not be reached or answered nonsense; the message is safe to log."""


def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "aeros-places"})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:  # noqa: S310
            return json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise PlacesError(f"geocoding failed: {type(exc).__name__}") from None


_cache: dict[tuple[str, str], list[dict]] = {}


def search(
    query: str,
    language: str,
    area: Sequence[float],
    *,
    get: Get = _get_json,
) -> list[dict]:
    """Up to five towns called like `query` inside `area` (west, south, east, north).

    Each is {"name", "region", "country", "lat", "lng"}; the most relevant first.
    """
    text = " ".join(str(query).split())[:MAX_QUERY]
    if len(text) < 2:
        return []
    lang = "en" if language == "en" else "es"
    key = (text.lower(), lang)
    if key in _cache:
        return _cache[key]

    url = f"{GEOCODING}?" + urllib.parse.urlencode(
        {"name": text, "count": 20, "language": lang, "format": "json"}
    )
    west, south, east, north = area
    found: list[dict] = []
    seen: set[tuple] = set()
    for row in get(url).get("results") or []:
        try:
            lat, lng = round(float(row["latitude"]), 2), round(float(row["longitude"]), 2)
            name = str(row["name"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        # Populated places only: a river or a hill called like the town is not where anyone lives.
        if not str(row.get("feature_code") or "").startswith("PPL") or not name:
            continue
        if not (south <= lat <= north and west <= lng <= east):
            continue
        place = {
            "name": name,
            "region": str(row.get("admin1") or ""),
            "country": str(row.get("country") or ""),
            "lat": lat,
            "lng": lng,
        }
        identity = (name.lower(), place["region"].lower(), lat, lng)
        if identity not in seen:
            seen.add(identity)
            found.append(place)
    found = found[:MAX_RESULTS]
    if len(_cache) >= _CACHE_SIZE:
        _cache.clear()
    _cache[key] = found
    return found


def label(place: dict) -> str:
    """ "Resistencia, Chaco, Argentina": what a person recognises their town by."""
    return ", ".join(
        part for part in (place["name"], place.get("region"), place.get("country")) if part
    )
