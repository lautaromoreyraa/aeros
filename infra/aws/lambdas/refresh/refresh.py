"""Daily FIRMS near-real-time download and early warning for the aeros data bucket.

For each NRT source and each of the last `FIRMS_DAYS_BACK` days, one request to
the FIRMS area API for exactly that day, stored as

    raw/firms/nrt/<YYYY-MM-DD>/fire_nrt_<sensor>_<YYYY-MM-DD>.csv

One file per source and day, overwritten on every run: FIRMS keeps adding late
granules for a day or two, so the newest download of a day is the most
complete and there are never two copies of the same detection. The file names
use the FIRMS prefixes that `aeros run` recognises, so the pipeline reads them
as they are.

After the downloads, the VIIRS files of the last seven complete days feed
`early_warning.py`, which writes `derived/early_warning.json` (see there).
When that report is an alert, `alerts.py` tells people by e-mail and Telegram.

The MAP_KEY is a SecureString in SSM Parameter Store (standard tier, AWS-managed
key: no charge), read on every run and never logged: it is part of the request
URL, so URLs are not logged either.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import alerts
from early_warning import WINDOW_DAYS, window

logger = logging.getLogger()
logger.setLevel(logging.INFO)

FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# FIRMS source name -> file prefix that aeros.sensors.FILE_PREFIXES maps to an
# instrument. VIIRS_SNPP_NRT stays accepted for backfills of older days, but the
# deployed source list leaves it out: Suomi NPP data stopped on 2026-11-02.
FILE_PREFIX = {
    "MODIS_NRT": "fire_nrt_m-c61",
    "VIIRS_SNPP_NRT": "fire_nrt_sv-c2",
    "VIIRS_NOAA20_NRT": "fire_nrt_j1v-c2",
    "VIIRS_NOAA21_NRT": "fire_nrt_j2v-c2",
}
_AREA = re.compile(r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$")
# FIRMS answers some errors (bad key, quota) with HTTP 200 and a text line, so
# a download only counts when it starts like a FIRMS CSV.
_CSV_HEADER = re.compile(rb"^(?:\xef\xbb\xbf)?latitude,longitude,", re.IGNORECASE)


class RefreshError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    bucket: str
    prefix: str
    map_key_parameter: str
    area: str
    sources: tuple[str, ...]
    days_back: int
    early_warning_key: str | None = None
    cells_key: str | None = None
    hotspots_key: str | None = None
    alert_settings: alerts.AlertSettings | None = None

    @classmethod
    def from_environment(cls) -> Settings:
        sources = tuple(s.strip() for s in os.environ["FIRMS_SOURCES"].split(",") if s.strip())
        unknown = sorted(set(sources) - set(FILE_PREFIX))
        if unknown:
            raise RefreshError(f"unknown FIRMS sources {unknown}")
        area = os.environ["FIRMS_AREA"].replace(" ", "")
        if not _AREA.match(area):
            raise RefreshError("FIRMS_AREA must be west,south,east,north")
        days = int(os.environ.get("FIRMS_DAYS_BACK", "7"))
        if not 1 <= days <= 10:
            raise RefreshError("FIRMS_DAYS_BACK must be between 1 and 10")
        early_warning_key = os.environ.get("EARLY_WARNING_KEY") or None
        if early_warning_key and days < WINDOW_DAYS:
            raise RefreshError(f"the early warning needs FIRMS_DAYS_BACK >= {WINDOW_DAYS}")
        prefix = os.environ.get("RAW_PREFIX", "raw/firms/")
        return cls(
            bucket=os.environ["DATA_BUCKET"],
            prefix=prefix if prefix.endswith("/") else prefix + "/",
            map_key_parameter=os.environ["FIRMS_MAP_KEY_PARAMETER"],
            area=area,
            sources=sources,
            days_back=days,
            early_warning_key=early_warning_key,
            cells_key=os.environ.get("CELLS_KEY"),
            hotspots_key=os.environ.get("HOTSPOTS_KEY"),
            alert_settings=alerts.AlertSettings.from_environment() if early_warning_key else None,
        )


Fetch = Callable[[str], bytes]
Downloads = dict[tuple[str, date], bytes]
# (downloads, days of the window, now) -> early_warning.json payload
EarlyWarning = Callable[[Downloads, list[date], datetime], dict]


def handler(
    event: dict | None = None,
    context: object = None,
    *,
    settings: Settings | None = None,
    s3=None,
    ssm=None,
    fetch: Fetch | None = None,
    now: datetime | None = None,
    early_warning: EarlyWarning | None = None,
    ses=None,
    post: alerts.Post | None = None,
) -> dict:
    settings = settings or Settings.from_environment()
    if s3 is None or ssm is None:
        import boto3

        s3 = s3 or boto3.client("s3")
        ssm = ssm or boto3.client("ssm")
    fetch = fetch or _http_get
    now = now or datetime.now(UTC)
    today = now.date()

    map_key = read_map_key(ssm, settings.map_key_parameter)
    downloads: Downloads = {}
    written, failed = [], []
    for day in days_to_fetch(today, settings.days_back):
        for source in settings.sources:
            key = object_key(settings.prefix, source, day)
            try:
                body = download(fetch, map_key, source, settings.area, day)
            except RefreshError as exc:
                # One bad source must not cost the others their day.
                logger.error("FIRMS %s %s failed: %s", source, day, exc)
                failed.append({"source": source, "day": day.isoformat(), "error": str(exc)})
                continue
            downloads[(source, day)] = body
            s3.put_object(
                Bucket=settings.bucket,
                Key=key,
                Body=body,
                ContentType="text/csv",
                Metadata={"firms-source": source, "firms-day": day.isoformat()},
            )
            rows = max(body.count(b"\n") - 1, 0)
            logger.info("stored %s (%d detections)", key, rows)
            written.append({"key": key, "detections": rows})

    summary: dict = {"written": written, "failed": failed}
    if failed and not written:
        # Nothing landed at all: fail the invocation so EventBridge retries
        # and the error metric shows it.
        raise RefreshError(json.dumps(summary))

    if settings.early_warning_key:
        early_warning = early_warning or _early_warning_from_s3(settings)
        try:
            report = early_warning(downloads, window(today), now)
        except Exception:
            # The downloads are already stored; a missing panel or a bad
            # query must not undo them. The log shows the error.
            logger.exception("early warning failed")
            summary["early_warning"] = "failed"
        else:
            s3.put_object(
                Bucket=settings.bucket,
                Key=settings.early_warning_key,
                Body=json.dumps(report, separators=(",", ":"), allow_nan=False).encode(),
                ContentType="application/json",
                CacheControl="public, max-age=900",
            )
            summary["early_warning"] = {
                "key": settings.early_warning_key,
                "days_with_data": len(report["days_with_data"]),
                "flagged_cells": len(report["cells"]),
            }
            if settings.alert_settings:
                try:
                    summary["alerts"] = alerts.notify(
                        report,
                        settings.alert_settings,
                        bucket=settings.bucket,
                        s3=s3,
                        ssm=ssm,
                        ses=ses,
                        post=post,
                    )
                except Exception:
                    # The report is already published; a broken alert path
                    # must not fail the run and trigger download retries.
                    logger.exception("alert notification failed")
                    summary["alerts"] = "failed"
    return summary


def _early_warning_from_s3(settings: Settings) -> EarlyWarning:
    def run(downloads: Downloads, days: list[date], now: datetime) -> dict:
        import early_warning as ew

        picked = ew.pick_days(downloads, days)
        con = ew.open_connection()
        clim = ew.load_climatology(
            con,
            f"s3://{settings.bucket}/{settings.cells_key}",
            f"s3://{settings.bucket}/{settings.hotspots_key}",
            [d.day for d in picked if d.status == "ok"],
        )
        return ew.build_report(picked, clim, now)

    return run


def read_map_key(ssm, parameter_name: str) -> str:
    """SecureString with the bare key; JSON {"MAP_KEY": "..."} is accepted too."""
    value = ssm.get_parameter(Name=parameter_name, WithDecryption=True)["Parameter"]["Value"]
    value = value.strip()
    if value.startswith("{"):
        value = str(json.loads(value).get("MAP_KEY", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9]{8,64}", value):
        raise RefreshError("FIRMS MAP_KEY parameter is empty or malformed")
    return value


def days_to_fetch(today: date, days_back: int) -> list[date]:
    """Yesterday and the days before it; today is still filling up."""
    return [today - timedelta(days=n) for n in range(days_back, 0, -1)]


def object_key(prefix: str, source: str, day: date) -> str:
    stamp = day.isoformat()
    return f"{prefix}nrt/{stamp}/{FILE_PREFIX[source]}_{stamp}.csv"


def firms_url(map_key: str, source: str, area: str, day: date) -> str:
    return f"{FIRMS_API}/{map_key}/{source}/{area}/1/{day.isoformat()}"


def download(fetch: Fetch, map_key: str, source: str, area: str, day: date) -> bytes:
    body = fetch(firms_url(map_key, source, area, day))
    if not _CSV_HEADER.match(body):
        # The first bytes say what went wrong ("Invalid MAP_KEY", quota)
        # without echoing the key, which is never in FIRMS' error text.
        snippet = body[:80].decode("utf-8", "replace").replace(map_key, "***").strip()
        raise RefreshError(f"FIRMS did not return CSV: {snippet!r}")
    return body


def _http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "aeros-firms-refresh"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            return response.read()
    except urllib.error.HTTPError as exc:
        raise RefreshError(f"FIRMS answered HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise RefreshError(f"FIRMS unreachable: {type(reason).__name__}") from None
