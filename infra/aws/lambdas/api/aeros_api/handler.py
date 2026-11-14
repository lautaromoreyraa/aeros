"""Lambda entry point for the HTTP API (payload format 2.0).

POST /calendar      -> JSON month x year calendar for the area
POST /hotspots.csv  -> CSV of the area's detections with their harmonized weight

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
ROUTES = ("POST /calendar", "POST /hotspots.csv")

_store: Store | None = None


def _default_store() -> Store:
    # Created once per execution environment and reused while it stays warm.
    global _store
    if _store is None:
        _store = Store.from_environment()
    return _store


def handler(
    event: dict,
    context: object = None,
    store_factory: Callable[[], Store] | None = None,
) -> dict:
    store_factory = store_factory or _default_store
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    route = f"{method} {event.get('rawPath') or ''}"
    if route not in ROUTES:
        return _json(404, {"error": "not found"})
    try:
        query = parse(_body(event))
        if route == "POST /calendar":
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
