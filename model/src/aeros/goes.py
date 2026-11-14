"""Fast fire layer from GOES-19, the geostationary GOES-East satellite.

MODIS and VIIRS pass over the Chaco a few times a day; GOES-19 looks at the
whole of the Americas every 10 minutes. NOAA publishes its ABI Fire/Hot Spot
Characterization product (ABI-L2-FDCF, full disk) as one ~2 MB NetCDF per
scan in the public `noaa-goes19` bucket of AWS Open Data: no account, no key.

This layer is for speed, not for the calendar. A GOES pixel is about 2 km at
nadir and wider at the Chaco's latitude, so it misses small fires VIIRS sees;
it is never mixed into the harmonized MODIS/VIIRS record. It says "something
is burning here right now" between polar passes.

The NetCDF is HDF5 underneath, so only `h5py` is needed. Fire pixels are few
(hundreds to a few thousand per disk), so only they are geolocated, with the
GOES-R fixed-grid equations of the Product User's Guide.
"""

from __future__ import annotations

import re
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import h3
import numpy as np
import pandas as pd

BUCKET_URL = "https://noaa-goes19.s3.amazonaws.com"
PRODUCT = "ABI-L2-FDCF"

# Mask codes of fire pixels and the category each stands for. The 3x codes are
# the same categories after the temporal filter (seen again in recent scans).
FIRE_CODES = {
    10: "good",
    11: "saturated",
    12: "cloud_contaminated",
    13: "high_probability",
    14: "medium_probability",
    15: "low_probability",
    30: "good",
    31: "saturated",
    32: "cloud_contaminated",
    33: "high_probability",
    34: "medium_probability",
    35: "low_probability",
}
# What an alert may act on: the categories GOES itself calls reliable. Low and
# medium probability pixels are kept in the output but never raise an alert.
CONFIDENT = {"good", "saturated", "high_probability"}

J2000 = datetime(2000, 1, 1, 12, tzinfo=UTC)
_NAME = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")


@dataclass(frozen=True)
class Scan:
    key: str
    start: datetime

    @property
    def url(self) -> str:
        return f"{BUCKET_URL}/{self.key}"


def scan_start(key: str) -> datetime:
    """Scan start time from a GOES file name (`..._sYYYYDDDHHMMSSt_...`)."""
    m = _NAME.search(key)
    if not m:
        raise ValueError(f"not a GOES product file name: {key}")
    year, doy, hh, mm, ss = (int(g) for g in m.groups())
    return datetime(year, 1, 1, hh, mm, ss, tzinfo=UTC) + timedelta(days=doy - 1)


Lister = Callable[[str], list[str]]


def _list_keys(prefix: str) -> list[str]:
    url = f"{BUCKET_URL}/?list-type=2&prefix={prefix}"
    with urllib.request.urlopen(url, timeout=60) as response:
        root = ET.fromstring(response.read())
    ns = {"s3": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    path = "s3:Contents/s3:Key" if ns else "Contents/Key"
    return [k.text for k in root.findall(path, ns) if k.text]


def latest_scans(now: datetime, count: int = 1, lister: Lister = _list_keys) -> list[Scan]:
    """The `count` most recent full-disk scans, looking back up to three hours."""
    found: list[Scan] = []
    for hours_back in range(3):
        moment = now - timedelta(hours=hours_back)
        prefix = f"{PRODUCT}/{moment:%Y}/{moment:%j}/{moment:%H}/"
        found += [Scan(k, scan_start(k)) for k in lister(prefix) if k.endswith(".nc")]
        if len(found) >= count:
            break
    return sorted(found, key=lambda s: s.start, reverse=True)[:count]


def download(scan: Scan, folder: Path) -> Path:
    """Keep every downloaded scan: raw data is never deleted (project rule)."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / Path(scan.key).name
    if not target.exists():
        partial = target.with_suffix(".part")
        with urllib.request.urlopen(scan.url, timeout=120) as response:
            expected = response.headers.get("Content-Length")
            partial.write_bytes(response.read())
        if expected is not None and partial.stat().st_size != int(expected):
            partial.unlink()
            raise OSError(f"{target.name}: short download")
        partial.replace(target)
    return target


def geolocate(x: np.ndarray, y: np.ndarray, projection: dict) -> tuple[np.ndarray, np.ndarray]:
    """Latitude and longitude (degrees) of fixed-grid scan angles x, y (radians)."""
    r_eq = float(projection["semi_major_axis"])
    r_pol = float(projection["semi_minor_axis"])
    height = float(projection["perspective_point_height"]) + r_eq
    lon0 = np.radians(float(projection["longitude_of_projection_origin"]))
    a = np.sin(x) ** 2 + np.cos(x) ** 2 * (np.cos(y) ** 2 + (r_eq**2 / r_pol**2) * np.sin(y) ** 2)
    b = -2.0 * height * np.cos(x) * np.cos(y)
    c = height**2 - r_eq**2
    with np.errstate(invalid="ignore"):
        r_s = (-b - np.sqrt(b**2 - 4.0 * a * c)) / (2.0 * a)
    s_x = r_s * np.cos(x) * np.cos(y)
    s_y = -r_s * np.sin(x)
    s_z = r_s * np.cos(x) * np.sin(y)
    lat = np.degrees(np.arctan((r_eq**2 / r_pol**2) * s_z / np.sqrt((height - s_x) ** 2 + s_y**2)))
    lon = np.degrees(lon0 - np.arctan(s_y / (height - s_x)))
    return lat, lon


def _attr(dataset, name: str, default: float = 0.0) -> float:
    value = dataset.attrs.get(name)
    return float(np.ravel(value)[0]) if value is not None else default


def decode(path: Path, area: tuple[float, float, float, float]) -> pd.DataFrame:
    """Fire pixels of one scan inside `area` (west, south, east, north)."""
    import h5py

    with h5py.File(path, "r") as f:
        mask = f["Mask"][:]
        rows, cols = np.nonzero(np.isin(mask, list(FIRE_CODES)))
        codes = mask[rows, cols]
        xs, ys = f["x"], f["y"]
        x = cols * _attr(xs, "scale_factor", 1.0) + _attr(xs, "add_offset")
        y = rows * _attr(ys, "scale_factor", 1.0) + _attr(ys, "add_offset")
        projection = {k: np.ravel(v)[0] for k, v in f["goes_imager_projection"].attrs.items()}
        power = f["Power"][:][rows, cols].astype(float)
        fill = _attr(f["Power"], "_FillValue", -9.0)
        # Seconds since 2000-01-01 12:00:00 UTC (J2000), the product's own clock,
        # so the scan time does not depend on the file keeping its name.
        started = J2000 + timedelta(seconds=float(f["time_bounds"][0]))
    lat, lon = geolocate(x, y, projection)
    west, south, east, north = area
    frame = pd.DataFrame(
        {
            "latitude": lat,
            "longitude": lon,
            "category": [FIRE_CODES[int(c)] for c in codes],
            "temporally_filtered": codes >= 30,
            "frp": np.where(power == fill, np.nan, power),
        }
    )
    inside = frame["latitude"].between(south, north) & frame["longitude"].between(west, east)
    frame = frame[inside].reset_index(drop=True)
    frame["confident"] = frame["category"].isin(CONFIDENT)
    frame["scan_start"] = started
    return frame


def summarize(frame: pd.DataFrame, resolution: int, area: str, generated_at: datetime) -> dict:
    """The `goes_latest.json` the web and the alert read."""
    if frame.empty:
        cells: list[dict] = []
    else:
        frame = frame.assign(
            cell=[
                h3.latlng_to_cell(a, o, resolution)
                for a, o in zip(frame.latitude, frame.longitude, strict=True)
            ]
        )
        grouped = frame.groupby("cell")
        cells = [
            {
                "cell": cell,
                "pixels": int(len(g)),
                "confident_pixels": int(g["confident"].sum()),
                "frp_sum": round(float(g["frp"].sum(skipna=True)), 2),
                "last_seen": g["scan_start"].max().isoformat(),
            }
            for cell, g in grouped
        ]
    scans = sorted({t.isoformat() for t in frame["scan_start"]}) if not frame.empty else []
    return {
        "generated_at": generated_at.isoformat(timespec="seconds"),
        "satellite": "GOES-19",
        "product": PRODUCT,
        "area": area,
        "resolution": resolution,
        "scans": scans,
        "pixels": int(len(frame)),
        "confident_pixels": int(frame["confident"].sum()) if not frame.empty else 0,
        "cells": sorted(cells, key=lambda c: (-c["confident_pixels"], -c["pixels"])),
    }
