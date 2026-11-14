"""Lambda entry point behind the function URL (payload format 2.0).

The URL only accepts SigV4-signed calls, and only CloudFront signs them (origin
access control), so every request arrives through the distribution, with the
path the browser used:

POST /api/calendar       -> JSON month x year calendar for the area
POST /api/hotspots.csv   -> CSV of the area's detections with their harmonized weight
GET  /api/early-warning  -> the latest early_warning.json from the daily refresh

Browsers must send `x-amz-content-sha256` (hex SHA-256 of the body) with every
POST: CloudFront signs the request for Lambda with it and Lambda does not
accept unsigned payloads.

Client mistakes come back as 400 with a message; anything else is logged and
answered with a bare 500 so internals (bucket names, SQL) never leak.
"""

from __future__ import annotations

import base64
import binascii
import csv
import io
import json
import logging
import os
from collections.abc import Callable

from aeros_api import calendar
from aeros_api.cells import AreaTooLarge, cells_for
from aeros_api.request import AreaQuery, BadRequest, parse
from aeros_api.store import HOTSPOT_COLUMNS, Store

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Lambda caps a synchronous response at 6 MB; leave room for headers.
MAX_RESPONSE_BYTES = 5_500_000
UNIT = "VIIRS-equivalent hotspots"
CALENDAR = "POST /api/calendar"
HOTSPOTS = "POST /api/hotspots.csv"
EARLY_WARNING = "GET /api/early-warning"
ROUTES = (CALENDAR, HOTSPOTS, EARLY_WARNING)
# CloudFront caches the early warning; it changes once a day.
EARLY_WARNING_MAX_AGE = 900

_store: Store | None = None


def _default_store() -> Store:
    # Created once per execution environment and reused while it stays warm.
    global _store
    if _store is None:
        _store = Store.from_environment()
    return _store


def _read_data_object(key: str) -> bytes | None:
    import boto3  # shipped with the Lambda runtime

    client = boto3.client("s3")
    try:
        return client.get_object(Bucket=os.environ["DATA_BUCKET"], Key=key)["Body"].read()
    except client.exceptions.NoSuchKey:
        return None


def handler(
    event: dict,
    context: object = None,
    store_factory: Callable[[], Store] | None = None,
    read_object: Callable[[str], bytes | None] | None = None,
) -> dict:
    store_factory = store_factory or _default_store
    read_object = read_object or _read_data_object
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    route = f"{method} {event.get('rawPath') or ''}"
    if route not in ROUTES:
        return _json(404, {"error": "not found"})
    try:
        if route == EARLY_WARNING:
            return _early_warning(read_object)
        query = parse(_body(event))
        if route == CALENDAR:
            return _calendar(store_factory(), query)
        return _hotspots(store_factory(), query)
    except (BadRequest, AreaTooLarge) as exc:
        return _json(400, {"error": str(exc)})
    except Exception:
        logger.exception("unhandled error on %s", route)
        return _json(500, {"error": "internal error"})


def _calendar(store: Store, query: AreaQuery) -> dict:
    resolution = store.resolution()
    cells = cells_for(query.geometry, resolution, _max_cells())
    rows = store.monthly_by_source(cells) if cells else []
    return _json(
        200,
        {
            "unit": UNIT,
            "area": {"cells": len(cells), "resolution": resolution},
            "range": {"start": query.start.isoformat(), "end": query.end.isoformat()},
            "interval": 0.9,
            "months": calendar.monthly(rows, query.start, query.end),
        },
    )


def _hotspots(store: Store, query: AreaQuery) -> dict:
    cells = cells_for(query.geometry, store.resolution(), _max_cells())
    limit = int(os.environ.get("MAX_CSV_ROWS", "50000"))

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(HOTSPOT_COLUMNS)
    written, truncated = 0, False
    # Asking for one row past the limit tells whether there was more.
    rows = store.hotspots(cells, query.start, query.end, limit + 1) if cells else []
    for row in rows:
        if written == limit or buffer.tell() > MAX_RESPONSE_BYTES:
            truncated = True
            break
        writer.writerow([_csv_value(v) for v in row])
        written += 1

    filename = f"aeros_hotspots_{query.start.isoformat()}_{query.end.isoformat()}.csv"
    return {
        "statusCode": 200,
        "headers": {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": f'attachment; filename="{filename}"',
            "x-aeros-truncated": "true" if truncated else "false",
            "cache-control": "no-store",
        },
        "body": buffer.getvalue(),
    }


def _early_warning(read_object: Callable[[str], bytes | None]) -> dict:
    body = read_object(os.environ.get("EARLY_WARNING_KEY", "derived/early_warning.json"))
    if body is None:
        return _json(404, {"error": "no early warning published yet"})
    return {
        "statusCode": 200,
        "headers": {
            "content-type": "application/json",
            "cache-control": f"public, max-age={EARLY_WARNING_MAX_AGE}",
        },
        "body": body.decode("utf-8"),
    }


def _csv_value(value: object) -> object:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return round(value, 6)
    return "" if value is None else value


def _body(event: dict) -> str | bytes | None:
    body = event.get("body")
    if body is not None and event.get("isBase64Encoded"):
        try:
            return base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise BadRequest("request body is not valid base64") from exc
    return body


def _max_cells() -> int:
    return int(os.environ.get("MAX_CELLS", "20000"))


def _json(status: int, payload: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(payload, separators=(",", ":"), allow_nan=False),
    }
