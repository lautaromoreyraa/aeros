"""Daily FIRMS near-real-time download into the aeros data bucket.

For each NRT source and each of the last `FIRMS_DAYS_BACK` days, one request to
the FIRMS area API for exactly that day, stored as

    raw/firms/nrt/<YYYY-MM-DD>/fire_nrt_<sensor>_<YYYY-MM-DD>.csv

One file per source and day, overwritten on every run: FIRMS keeps adding late
granules for a day or two, so the newest download of a day is the most
complete and there are never two copies of the same detection. The file names
use the FIRMS prefixes that `aeros run` recognises, so the pipeline reads them
as they are.

Only the standard library and boto3 (shipped with the Lambda runtime). The
MAP_KEY is read from Secrets Manager on every run and never logged: it is part
of the request URL, so URLs are not logged either.
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

logger = logging.getLogger()
logger.setLevel(logging.INFO)

FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# FIRMS source name -> file prefix that aeros.sensors.FILE_PREFIXES maps to an instrument.
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
    secret_name: str
    area: str
    sources: tuple[str, ...]
    days_back: int

    @classmethod
    def from_environment(cls) -> Settings:
        sources = tuple(s.strip() for s in os.environ["FIRMS_SOURCES"].split(",") if s.strip())
        unknown = sorted(set(sources) - set(FILE_PREFIX))
        if unknown:
            raise RefreshError(f"unknown FIRMS sources {unknown}")
        area = os.environ["FIRMS_AREA"].replace(" ", "")
        if not _AREA.match(area):
            raise RefreshError("FIRMS_AREA must be west,south,east,north")
        days = int(os.environ.get("FIRMS_DAYS_BACK", "2"))
        if not 1 <= days <= 5:
            raise RefreshError("FIRMS_DAYS_BACK must be between 1 and 5")
        prefix = os.environ.get("RAW_PREFIX", "raw/firms/")
        return cls(
            bucket=os.environ["DATA_BUCKET"],
            prefix=prefix if prefix.endswith("/") else prefix + "/",
            secret_name=os.environ["FIRMS_SECRET_NAME"],
            area=area,
            sources=sources,
            days_back=days,
        )


Fetch = Callable[[str], bytes]


def handler(
    event: dict | None = None,
    context: object = None,
    *,
    settings: Settings | None = None,
    s3=None,
    secrets=None,
    fetch: Fetch | None = None,
    today: date | None = None,
) -> dict:
    settings = settings or Settings.from_environment()
    if s3 is None or secrets is None:
        import boto3

        s3 = s3 or boto3.client("s3")
        secrets = secrets or boto3.client("secretsmanager")
    fetch = fetch or _http_get
    today = today or datetime.now(UTC).date()

    map_key = read_map_key(secrets, settings.secret_name)
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

    summary = {"written": written, "failed": failed}
    if failed and not written:
        # Nothing landed at all: fail the invocation so EventBridge retries
        # and the error metric shows it.
        raise RefreshError(json.dumps(summary))
    return summary


def read_map_key(secrets, secret_name: str) -> str:
    """The secret holds the key as plain text or as {"MAP_KEY": "..."}."""
    value = secrets.get_secret_value(SecretId=secret_name)["SecretString"].strip()
    if value.startswith("{"):
        value = str(json.loads(value).get("MAP_KEY", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9]{8,64}", value):
        raise RefreshError("FIRMS MAP_KEY secret is empty or malformed")
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
