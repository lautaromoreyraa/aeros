"""Download FIRMS yearly country summaries, the public standard-quality archive.

FIRMS publishes one CSV per product, year and country with no login, carrying
the `type` column the pipeline needs to keep non-vegetation fires apart. The
current year is not published until it closes; recent months come from NRT.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country"

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
    files: Iterable[ArchiveFile], out: Path, opener: Opener = _open
) -> dict[str, list[str]]:
    """Fetch every file not already in `out`; a file is only kept once complete."""
    report: dict[str, list[str]] = {"downloaded": [], "present": [], "missing": []}
    out.mkdir(parents=True, exist_ok=True)
    for f in files:
        target = out / f.name
        if target.exists():
            report["present"].append(f.name)
            continue
        partial = target.with_suffix(".part")
        try:
            with opener(f.url) as response, partial.open("wb") as sink:
                while chunk := response.read(1 << 20):
                    sink.write(chunk)
        except urllib.error.HTTPError as error:
            partial.unlink(missing_ok=True)
            if error.code != 404:
                raise
            report["missing"].append(f.name)
            continue
        partial.rename(target)
        report["downloaded"].append(f.name)
    return report
