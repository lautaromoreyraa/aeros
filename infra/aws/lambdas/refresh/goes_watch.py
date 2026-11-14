"""Fast fire watch: GOES-19 every 10 minutes, between the polar passes.

The daily early warning compares a week of VIIRS against the climatology, so it
sees a fire the morning after. GOES-19 (GOES-East) scans the Americas every 10
minutes and NOAA publishes its fire product, ABI-L2-FDCF, as one ~2 MB NetCDF
per full-disk scan in the public `noaa-goes19` bucket: no account, no key and
no area query, so each run reads the newest scans whole and keeps only the
fire pixels inside the monitored box. The scans are not copied: NOAA keeps
them, and copying one every 10 minutes would only cost storage.

This mirrors `model/src/aeros/goes.py` without pandas, which the layer does not
carry. A GOES pixel is several km wide over the Chaco, so the layer answers
"something is burning here right now"; it never enters the harmonized record.

What may raise an alert:

* only the categories GOES itself calls reliable (good, saturated, high
  probability), never the low or medium probability ones;
* only inside the study cells, the cells the harmonized panel covers; when
  they cannot be read, the run still publishes the map layer but alerts no one;
* only a cell with confident pixels in at least PERSISTENCE of the last SCANS
  scans: a hot roof or a sun glint lights one scan, a fire keeps burning.

A cell is told once and again only after QUIET_HOURS without being told, so a
fire that burns all afternoon is one message, not eighteen. The memory is a
small JSON object in the data bucket, written only after a channel delivered.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import alerts

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET_URL = "https://noaa-goes19.s3.amazonaws.com"
PRODUCT = "ABI-L2-FDCF"
SATELLITE = "GOES-19"
RESOLUTION = 4
SCANS = 3
PERSISTENCE = 2
QUIET_HOURS = 12
TOP_CELLS = 5

# Mask codes of fire pixels; the 3x codes are the same categories after the
# product's temporal filter.
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
CONFIDENT = frozenset({"good", "saturated", "high_probability"})
J2000 = datetime(2000, 1, 1, 12, tzinfo=UTC)
_NAME = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")
_AREA = re.compile(r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$")


class WatchError(RuntimeError):
    pass


@dataclass(frozen=True)
class Scan:
    key: str
    start: datetime


@dataclass(frozen=True)
class Pixel:
    latitude: float
    longitude: float
    category: str
    frp: float | None
    scan_start: datetime

    @property
    def confident(self) -> bool:
        return self.category in CONFIDENT


@dataclass(frozen=True)
class Settings:
    bucket: str
    area: tuple[float, float, float, float]
    output_key: str
    cells_key: str | None
    alert_settings: alerts.AlertSettings | None

    @classmethod
    def from_environment(cls) -> Settings:
        area = os.environ["FIRMS_AREA"].replace(" ", "")
        if not _AREA.match(area):
            raise WatchError("FIRMS_AREA must be west,south,east,north")
        base = alerts.AlertSettings.from_environment()
        if base is not None:
            # Same channels and texts as the daily alert, its own memory.
            base = alerts.AlertSettings(
                **{**base.__dict__, "state_key": os.environ["GOES_ALERT_STATE_KEY"]}
            )
        return cls(
            bucket=os.environ["DATA_BUCKET"],
            area=tuple(float(v) for v in area.split(",")),  # type: ignore[arg-type]
            output_key=os.environ["GOES_LATEST_KEY"],
            cells_key=os.environ.get("CELLS_KEY") or None,
            alert_settings=base,
        )


Lister = Callable[[str], list[str]]
Fetch = Callable[[str], bytes]
# () -> set of study cells
Domain = Callable[[], frozenset[str]]


def scan_start(key: str) -> datetime:
    m = _NAME.search(key)
    if not m:
        raise WatchError(f"not a GOES product file name: {key}")
    year, doy, hh, mm, ss = (int(g) for g in m.groups())
    return datetime(year, 1, 1, hh, mm, ss, tzinfo=UTC) + timedelta(days=doy - 1)


def latest_scans(now: datetime, lister: Lister, count: int = SCANS) -> list[Scan]:
    """The `count` newest full-disk scans, looking back up to three hours."""
    found: list[Scan] = []
    for hours_back in range(3):
        moment = now - timedelta(hours=hours_back)
        prefix = f"{PRODUCT}/{moment:%Y}/{moment:%j}/{moment:%H}/"
        found += [Scan(k, scan_start(k)) for k in lister(prefix) if k.endswith(".nc")]
        if len(found) >= count:
            break
    return sorted(found, key=lambda s: s.start, reverse=True)[:count]


def geolocate(x, y, projection: dict):
    """Latitude and longitude (degrees) of fixed-grid scan angles (radians), GOES-R PUG."""
    import numpy as np

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
    import numpy as np

    value = dataset.attrs.get(name)
    return float(np.ravel(value)[0]) if value is not None else default


def decode(body: bytes, area: tuple[float, float, float, float]) -> list[Pixel]:
    """Fire pixels of one scan inside `area` (west, south, east, north)."""
    import h5py
    import numpy as np

    with h5py.File(io.BytesIO(body), "r") as f:
        mask = f["Mask"][:]
        rows, cols = np.nonzero(np.isin(mask, list(FIRE_CODES)))
        codes = mask[rows, cols]
        xs, ys = f["x"], f["y"]
        x = cols * _attr(xs, "scale_factor", 1.0) + _attr(xs, "add_offset")
        y = rows * _attr(ys, "scale_factor", 1.0) + _attr(ys, "add_offset")
        projection = {k: np.ravel(v)[0] for k, v in f["goes_imager_projection"].attrs.items()}
        power = f["Power"][:][rows, cols].astype(float)
        fill = _attr(f["Power"], "_FillValue", -9.0)
        # The product's own clock (seconds since J2000), not the file name.
        started = J2000 + timedelta(seconds=float(f["time_bounds"][0]))
    lat, lon = geolocate(x, y, projection)
    west, south, east, north = area
    return [
        Pixel(
            round(float(la), 4),
            round(float(lo), 4),
            FIRE_CODES[int(code)],
            None if p == fill else round(float(p), 2),
            started,
        )
        for la, lo, code, p in zip(lat, lon, codes, power, strict=True)
        if south <= la <= north and west <= lo <= east
    ]


def summarize(
    pixels: list[Pixel],
    scans: list[Scan],
    domain: frozenset[str] | None,
    area: str,
    generated_at: datetime,
) -> dict:
    """`goes_latest.json`: what the web draws and what the alert reads."""
    import h3

    by_cell: dict[str, list[Pixel]] = {}
    for p in pixels:
        by_cell.setdefault(h3.latlng_to_cell(p.latitude, p.longitude, RESOLUTION), []).append(p)
    cells = []
    for cell, group in by_cell.items():
        confident_scans = {p.scan_start for p in group if p.confident}
        cells.append(
            {
                "cell": cell,
                "pixels": len(group),
                "confident_pixels": sum(p.confident for p in group),
                "confident_scans": len(confident_scans),
                "frp_sum": round(sum(p.frp or 0.0 for p in group), 2),
                "last_seen": max(p.scan_start for p in group).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "in_study_area": None if domain is None else cell in domain,
                "persistent": len(confident_scans) >= PERSISTENCE
                and (domain is not None and cell in domain),
            }
        )
    return {
        "generated_at": generated_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "satellite": SATELLITE,
        "product": PRODUCT,
        "area": area,
        "resolution": RESOLUTION,
        "scans": [s.start.strftime("%Y-%m-%dT%H:%M:%SZ") for s in scans],
        "pixels": len(pixels),
        "confident_pixels": sum(p.confident for p in pixels),
        "rule": {
            "confident": sorted(CONFIDENT),
            "persistence": f"confident pixels in >= {PERSISTENCE} of the last {len(scans)} scans",
            "study_area_known": domain is not None,
        },
        "cells": sorted(
            cells, key=lambda c: (not c["persistent"], -c["confident_pixels"], -c["pixels"])
        ),
    }


def to_tell(report: dict, state: dict | None, now: datetime) -> tuple[list[dict], dict]:
    """Persistent cells not told in the last QUIET_HOURS, and the pruned memory."""
    horizon = now - timedelta(hours=QUIET_HOURS)
    told = {
        cell: when
        for cell, when in ((state or {}).get("told") or {}).items()
        if datetime.fromisoformat(when) > horizon
    }
    fresh = [c for c in report["cells"] if c["persistent"] and c["cell"] not in told]
    return fresh, {"told": told}


def format_message(
    cells: list[dict], report: dict, settings: alerts.AlertSettings
) -> tuple[str, str]:
    subject = f"aeros: active fire seen by {SATELLITE} in {settings.region_name}"
    lines = [
        f"Active fire right now: {settings.region_name}",
        f"{SATELLITE} saw confident fire pixels in {len(cells)} cell(s), "
        f"in at least {PERSISTENCE} of its last {len(report['scans'])} scans (10 min apart).",
        f"Latest scan: {report['scans'][0] if report['scans'] else 'n/a'} UTC",
    ]
    for c in cells[:TOP_CELLS]:
        lat, lon = alerts.centroid(c["cell"])
        lines.append(
            f"- {lat:.3f}, {lon:.3f}: {c['confident_pixels']} pixel(s), "
            f"FRP {c['frp_sum']:.0f} MW, last seen {c['last_seen']}"
        )
    lines.append("GOES pixels are several km wide: check the location against the next VIIRS pass.")
    if settings.web_url:
        lines.append(f"Map: {settings.web_url}")
    return subject, "\n".join(lines)


def handler(
    event: dict | None = None,
    context: object = None,
    *,
    settings: Settings | None = None,
    s3=None,
    ssm=None,
    ses=None,
    lister: Lister | None = None,
    fetch: Fetch | None = None,
    domain: Domain | None = None,
    post: alerts.Post | None = None,
    now: datetime | None = None,
) -> dict:
    settings = settings or Settings.from_environment()
    if s3 is None or ssm is None:
        import boto3

        s3 = s3 or boto3.client("s3")
        ssm = ssm or boto3.client("ssm")
    now = now or datetime.now(UTC)
    fetch = fetch or _http_get

    scans = latest_scans(now, lister or _list_keys)
    if not scans:
        raise WatchError("no GOES scan in the last three hours")
    pixels: list[Pixel] = []
    for scan in scans:
        try:
            pixels += decode(fetch(f"{BUCKET_URL}/{scan.key}"), settings.area)
        except Exception as exc:
            # One unreadable scan leaves the others; the persistence rule is
            # counted over the scans that were read.
            logger.error("GOES scan %s failed: %s", scan.key, exc)
            scans = [s for s in scans if s != scan]
    if not scans:
        raise WatchError("no GOES scan could be read")

    study = None
    try:
        study = (domain or _domain_from_s3(settings))()
    except Exception:
        logger.exception("study cells unavailable; publishing without alerts")

    area = ",".join(f"{v:g}" for v in settings.area)
    report = summarize(pixels, scans, study, area, now)
    s3.put_object(
        Bucket=settings.bucket,
        Key=settings.output_key,
        Body=json.dumps(report, separators=(",", ":"), allow_nan=False).encode(),
        ContentType="application/json",
        CacheControl="public, max-age=300",
    )
    summary: dict = {
        "scans": report["scans"],
        "pixels": report["pixels"],
        "persistent_cells": sum(c["persistent"] for c in report["cells"]),
    }
    if settings.alert_settings and summary["persistent_cells"]:
        try:
            summary["alerts"] = notify(
                report, settings, s3=s3, ssm=ssm, ses=ses, post=post, now=now
            )
        except Exception:
            logger.exception("GOES alert failed")
            summary["alerts"] = "failed"
    return summary


def notify(report: dict, settings: Settings, *, s3, ssm, ses, post, now: datetime) -> dict:
    alert = settings.alert_settings
    assert alert is not None
    state = alerts.load_state(s3, settings.bucket, alert.state_key)
    fresh, memory = to_tell(report, state, now)
    if not fresh:
        return {"decision": "repeat"}
    subject, text = format_message(fresh, report, alert)
    channels = alerts.deliver(subject, text, alert, ssm=ssm, ses=ses, post=post)
    if any(v.startswith("sent") for v in channels.values()):
        stamp = now.astimezone(UTC).isoformat(timespec="seconds")
        memory["told"].update({c["cell"]: stamp for c in fresh})
        alerts.save_state(s3, settings.bucket, alert.state_key, memory)
    return {"decision": "new", "cells": len(fresh), "channels": channels}


_STUDY_CELLS: frozenset[str] | None = None


def _domain_from_s3(settings: Settings) -> Domain:
    def load() -> frozenset[str]:
        # Kept between warm invocations: the study cells change only when the
        # pipeline publishes a new panel, and reading them costs a DuckDB query.
        global _STUDY_CELLS
        if _STUDY_CELLS is None:
            if not settings.cells_key:
                raise WatchError("CELLS_KEY is not set")
            import early_warning as ew

            con = ew.open_connection()
            uri = f"s3://{settings.bucket}/{settings.cells_key}"
            rows = con.execute("SELECT DISTINCT cell FROM read_parquet(?)", [uri]).fetchall()
            _STUDY_CELLS = frozenset(r[0] for r in rows)
        return _STUDY_CELLS

    return load


def _list_keys(prefix: str) -> list[str]:
    body = _http_get(f"{BUCKET_URL}/?list-type=2&prefix={prefix}")
    root = ET.fromstring(body)  # noqa: S314 (NOAA's public S3 listing)
    ns = {"s3": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    path = "s3:Contents/s3:Key" if ns else "Contents/Key"
    return [k.text for k in root.findall(path, ns) if k.text]


def _http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "aeros-goes-watch"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            expected = response.headers.get("Content-Length")
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise WatchError(f"NOAA bucket answered HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise WatchError(f"NOAA bucket unreachable: {type(reason).__name__}") from None
    if expected is not None and len(body) != int(expected):
        raise WatchError("short read from the NOAA bucket")
    return body
