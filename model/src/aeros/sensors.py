"""Sensor identity and operating windows.

The sensor is read from the FIRMS archive file name, not from the `satellite`
column: Suomi NPP is coded as a bare `N`, which is easy to confuse.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path


@dataclass(frozen=True)
class Platform:
    label: str
    instrument: str
    first_day: date
    last_day: date | None
    # Nominal local overpass, daytime. Used only for documentation and checks:
    # the model reads the real acquisition time of every detection.
    nominal_day_overpass: float


PLATFORMS: dict[str, Platform] = {
    "TERRA": Platform("TERRA", "MODIS", date(2000, 11, 1), None, 10.5),
    "AQUA": Platform("AQUA", "MODIS", date(2002, 7, 4), None, 13.5),
    "SNPP": Platform("SNPP", "VIIRS", date(2012, 1, 20), date(2026, 11, 1), 13.5),
    "NOAA20": Platform("NOAA20", "VIIRS", date(2018, 4, 1), None, 13.5),
    "NOAA21": Platform("NOAA21", "VIIRS", date(2023, 3, 1), None, 13.5),
}

# FIRMS `satellite` column values, per instrument.
SATELLITE_CODES = {
    "Terra": "TERRA",
    "T": "TERRA",
    "Aqua": "AQUA",
    "A": "AQUA",
    "N": "SNPP",
    "N20": "NOAA20",
    "N21": "NOAA21",
}

FILE_PREFIXES = {
    "modis": "MODIS",
    "viirs-snpp": "VIIRS",
    "viirs-jpss1": "VIIRS",
    "viirs-jpss2": "VIIRS",
    "fire_archive_m-c61": "MODIS",
    "fire_archive_sv-c2": "VIIRS",
    "fire_archive_j1v-c2": "VIIRS",
    "fire_archive_j2v-c2": "VIIRS",
    "fire_nrt_m-c61": "MODIS",
    "fire_nrt_sv-c2": "VIIRS",
    "fire_nrt_j1v-c2": "VIIRS",
    "fire_nrt_j2v-c2": "VIIRS",
}


def instrument_from_filename(path: Path | str) -> str:
    name = Path(path).name.lower()
    # Longest prefix first so "viirs-snpp" never matches a shorter key by accident.
    for prefix in sorted(FILE_PREFIXES, key=len, reverse=True):
        if name.startswith(prefix):
            return FILE_PREFIXES[prefix]
    raise ValueError(f"cannot infer instrument from file name: {Path(path).name}")
