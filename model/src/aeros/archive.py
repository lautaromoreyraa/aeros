"""Download FIRMS yearly country summaries, the public standard-quality archive.

FIRMS publishes one CSV per product, year and country with no login, carrying
the `type` column the pipeline needs to keep non-vegetation fires apart. The
current year is not published until it closes; its months come from the area
API instead (see `recent_plan`), which needs a MAP_KEY.
"""

from __future__ import annotations

import csv
import io
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import BinaryIO

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country"
API_URL = "https://firms.modaps.eosdis.nasa.gov/api"

# First full year each product covers.
FIRST_YEAR = {"modis": 2000, "viirs-snpp": 2012, "viirs-jpss1": 2018}

GRAN_CHACO_COUNTRIES = ("Argentina", "Paraguay", "Bolivia")


@dataclass(frozen=True)
class ArchiveFile:
    product: str
    year: int
    country: str

    @property
    def name(self) -> str:
        return f"{self.product}_{self.year}_{self.country}.csv"

    @property
    def url(self) -> str:
        return f"{BASE_URL}/{self.product}/{self.year}/{self.name}"


def plan(
    countries: Iterable[str], last_year: int, products: Iterable[str] = tuple(FIRST_YEAR)
) -> list[ArchiveFile]:
    return [
        ArchiveFile(product, year, country)
        for product in products
        for year in range(FIRST_YEAR[product], last_year + 1)
        for country in countries
    ]


Opener = Callable[[str], BinaryIO]


def _open(url: str) -> BinaryIO:
    return urllib.request.urlopen(url, timeout=120)


def download(
    files: Iterable[ArchiveFile], out: Path, opener: Opener = _open, workers: int = 4
) -> dict[str, list[str]]:
    """Fetch every file not already in `out`; a file is only kept once complete.

    FIRMS throttles each connection to a few dozen KB/s, so a sequential run
    over the whole archive takes hours; a few files are fetched at once.
    """
    out.mkdir(parents=True, exist_ok=True)
    files = list(files)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        outcomes = list(pool.map(lambda f: _fetch(f, out, opener), files))
    report: dict[str, list[str]] = {"downloaded": [], "present": [], "missing": []}
    for f, outcome in zip(files, outcomes, strict=True):
        report[outcome].append(f.name)
    return report


def _fetch(f: ArchiveFile, out: Path, opener: Opener) -> str:
    target = out / f.name
    if target.exists():
        return "present"
    partial = target.with_suffix(".part")
    try:
        with opener(f.url) as response, partial.open("wb") as sink:
            while chunk := response.read(1 << 20):
                sink.write(chunk)
    except urllib.error.HTTPError as error:
        partial.unlink(missing_ok=True)
        if error.code != 404:
            raise
        return "missing"
    partial.rename(target)
    return "downloaded"


# The three MVP study regions (Gran Chaco, Corrientes, Paraguay) with one
# degree of margin, so their border cells keep their neighbors.
STUDY_AREA = "-69,-35,-53,-16"

# Per platform: standard-processing source, then near-real-time, each with the
# file prefix `aeros.sensors.FILE_PREFIXES` maps to an instrument. NOAA-21 is
# left out, as in the yearly archive: it is not in the reference chain.
RECENT_SOURCES = (
    (("MODIS_SP", "fire_archive_m-c61"), ("MODIS_NRT", "fire_nrt_m-c61")),
    (("VIIRS_SNPP_SP", "fire_archive_sv-c2"), ("VIIRS_SNPP_NRT", "fire_nrt_sv-c2")),
    (("VIIRS_NOAA20_SP", "fire_archive_j1v-c2"), ("VIIRS_NOAA20_NRT", "fire_nrt_j1v-c2")),
)
# The area API serves at most five days per request.
MAX_DAYS = 5
# FIRMS keeps adding late granules for a day or two, so chunks ending this
# close to today are downloaded again on every run.
SETTLE_DAYS = 2
_AREA = re.compile(r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$")
# Errors such as a bad MAP_KEY come back as HTTP 200 with one line of text.
_CSV_HEADER = re.compile(rb"^(?:\xef\xbb\xbf)?latitude,longitude,", re.IGNORECASE)


class FirmsApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class AreaRequest:
    source: str
    prefix: str
    area: str
    start: date
    days: int

    @property
    def end(self) -> date:
        return self.start + timedelta(days=self.days - 1)

    @property
    def name(self) -> str:
        return f"{self.prefix}_{self.start.isoformat()}.csv"

    def url(self, map_key: str) -> str:
        return f"{API_URL}/area/csv/{map_key}/{self.source}/{self.area}/{self.days}/{self.start}"


Availability = dict[str, tuple[date, date]]


def availability(map_key: str, opener: Opener = _open) -> Availability:
    """First and last day FIRMS serves for every source."""
    try:
        with opener(f"{API_URL}/data_availability/csv/{map_key}/ALL") as response:
            text = response.read().decode()
    except urllib.error.HTTPError as error:
        raise FirmsApiError(f"availability: HTTP {error.code}") from None
    if not text.startswith("data_id"):
        raise FirmsApiError(f"FIRMS refused the availability request: {text.strip()[:80]}")
    return {
        row["data_id"]: (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
        for row in csv.DictReader(io.StringIO(text))
    }


def recent_plan(available: Availability, area: str, start: date, end: date) -> list[AreaRequest]:
    """Requests covering `start`..`end`: standard processing while it exists, NRT after.

    Each day comes from exactly one source per platform, so the same detection
    is never stored twice under two processing levels.
    """
    if not _AREA.match(area):
        raise ValueError(f'area must be "west,south,east,north", got {area!r}')
    requests = []
    for (sp, sp_prefix), (nrt, nrt_prefix) in RECENT_SOURCES:
        nrt_from = start
        if sp in available:
            first, last = available[sp]
            requests += _chunks(sp, sp_prefix, area, max(start, first), min(end, last))
            nrt_from = max(start, last + timedelta(days=1))
        if nrt in available:
            first, last = available[nrt]
            requests += _chunks(nrt, nrt_prefix, area, max(nrt_from, first), min(end, last))
    return requests


def _chunks(source: str, prefix: str, area: str, first: date, last: date) -> list[AreaRequest]:
    out = []
    day = first
    while day <= last:
        days = min(MAX_DAYS, (last - day).days + 1)
        out.append(AreaRequest(source, prefix, area, day, days))
        day += timedelta(days=days)
    return out


def download_recent(
    requests: Iterable[AreaRequest],
    out: Path,
    map_key: str,
    today: date,
    opener: Opener = _open,
) -> dict[str, list[str]]:
    """Fetch area API chunks; settled chunks already on disk are not requested again.

    URLs carry the MAP_KEY, so they are never printed or put in an error.
    """
    report: dict[str, list[str]] = {"downloaded": [], "present": []}
    out.mkdir(parents=True, exist_ok=True)
    for r in requests:
        target = out / r.name
        settled = r.end <= today - timedelta(days=SETTLE_DAYS)
        if settled and target.exists():
            report["present"].append(r.name)
            continue
        try:
            with opener(r.url(map_key)) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            raise FirmsApiError(f"{r.source} {r.start}: HTTP {error.code}") from None
        if not _CSV_HEADER.match(body):
            line = body.decode(errors="replace").strip()[:80]
            raise FirmsApiError(f"{r.source} {r.start}: FIRMS answered {line!r}")
        partial = target.with_suffix(".part")
        partial.write_bytes(body)
        partial.rename(target)
        report["downloaded"].append(r.name)
    return report
