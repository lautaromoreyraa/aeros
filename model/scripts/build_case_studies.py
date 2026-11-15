"""Build the two past fires the web replays on its map, as processed H3 views.

* Los Angeles, January 2025 (Palisades and Eaton fires): every satellite pass
  from the FIRMS yearly United States 2025 files (MODIS C6.1, VIIRS S-NPP and
  NOAA-20), H3 resolution 8, downloaded into `<raw>` when missing (no key).
* Corrientes, December 2021 to March 2022: one step per local day from the
  detection database (`aeros build-db`), VIIRS S-NPP and NOAA-20 vegetation
  fires inside the Corrientes study region, H3 resolution 6, plus a
  retrospective run of the early warning's region rule.

Only cell counts and summed FRP leave this script, never raw FIRMS rows.

    uv run python scripts/build_case_studies.py --db ../data/db \\
        --raw ../data/case-studies/raw --out ../web/public/data/case-studies
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.request
from importlib import resources
from pathlib import Path

import h3
import pandas as pd
import pyarrow.dataset as ds

from aeros.archive import ArchiveFile

Box = tuple[float, float, float, float]

LA_BOX: Box = (-118.9, 33.95, -117.9, 34.55)
LA_TZ = "America/Los_Angeles"
LA_WINDOW = ("2025-01-07T10:00", "2025-01-13T00:00")
# Rough boxes around each fire of the firestorm. Inside them every pixel is
# kept: FIRMS marks some pixels of this urban, coastal fire as static sources
# or offshore. Outside them only presumed vegetation fires (type 0) are kept.
FIRES: dict[str, Box] = {
    "Palisades": (-118.70, 34.00, -118.45, 34.15),
    "Eaton": (-118.20, 34.14, -117.98, 34.28),
    "Hurst": (-118.52, 34.28, -118.42, 34.36),
    "Kenneth": (-118.72, 34.15, -118.62, 34.22),
}
# Lake Avenue: west of it, Altadena got its first evacuation order hours late.
LAKE_AVENUE = -118.131
CORRIENTES_TZ = "America/Argentina/Buenos_Aires"
CORRIENTES_DAYS = ("2021-12-15", "2022-03-15")
SATELLITES = {"N": "Suomi NPP", "N20": "NOAA-20", "Terra": "Terra", "Aqua": "Aqua"}
RETROSPECTIVE = "aeros, retrospective run with Suomi NPP"


def _inside(frame: pd.DataFrame, box: Box) -> pd.Series:
    west, south, east, north = box
    return frame["longitude"].between(west, east) & frame["latitude"].between(south, north)


def _iso(stamp: pd.Timestamp) -> str:
    return stamp.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _h3(frame: pd.DataFrame, resolution: int) -> list[str]:
    points = zip(frame["latitude"], frame["longitude"], strict=True)
    return [h3.latlng_to_cell(lat, lng, resolution) for lat, lng in points]


def _cells(part: pd.DataFrame) -> list[list]:
    grouped = part.groupby("cell").agg(n=("frp", "size"), frp=("frp", "sum")).reset_index()
    return [[row.cell, int(row.n), round(float(row.frp), 1)] for row in grouped.itertuples()]


def _events(rows: list[list[str]]) -> list[dict]:
    return [{"time": time, "text": text, "source": source} for time, text, source in rows]


def los_angeles(raw: Path) -> dict:
    raw.mkdir(parents=True, exist_ok=True)
    frames = []
    for product in ("modis", "viirs-snpp", "viirs-jpss1"):
        source = ArchiveFile(product, 2025, "United_States")
        path = raw / source.name
        if not path.exists():
            urllib.request.urlretrieve(source.url, path)  # noqa: S310 (fixed https URL)
        frame = pd.read_csv(path, dtype={"acq_time": str, "confidence": str, "version": str})
        in_fire = pd.concat([_inside(frame, box) for box in FIRES.values()], axis=1).any(axis=1)
        frame = frame[_inside(frame, LA_BOX) & (in_fire | (frame["type"] == 0))]
        frames.append(frame.assign(sensor="MODIS" if product == "modis" else "VIIRS"))
    det = pd.concat(frames, ignore_index=True)
    clock = det["acq_time"].str.zfill(4)
    stamp = det["acq_date"] + " " + clock.str[:2] + ":" + clock.str[2:]
    det["utc"] = pd.to_datetime(stamp, utc=True)
    start, end = (pd.Timestamp(t, tz=LA_TZ) for t in LA_WINDOW)
    det = det[(det["utc"] >= start) & (det["utc"] < end)].copy()
    det["cell"] = _h3(det, 8)

    steps = [
        {
            "time": _iso(utc),
            "label": f"{SATELLITES.get(str(sat), sat)} {sensor}",
            "cells": _cells(part),
        }
        for (utc, sensor, sat), part in det.groupby(["utc", "sensor", "satellite"])
    ]

    def first_pass(fire: str, after: str, sensor: str | None = None) -> pd.DataFrame:
        part = det[_inside(det, FIRES[fire]) & (det["utc"] >= pd.Timestamp(after, tz=LA_TZ))]
        if sensor:
            part = part[part["sensor"] == sensor]
        return part[part["utc"] == part["utc"].min()]

    palisades = first_pass("Palisades", "2025-01-07T10:30")
    eaton = first_pass("Eaton", "2025-01-07T18:18", "VIIRS")
    west = int((eaton["longitude"] < LAKE_AVENUE).sum())
    events = [
        ["2025-01-07T10:30:00-08:00", "The Palisades fire starts", "Cal Fire"],
        [
            "2025-01-07T11:27:00-08:00",
            "Homes are already burning in Pacific Palisades",
            "AP, scanner traffic",
        ],
        [
            _iso(palisades["utc"].iloc[0]),
            f"{len(palisades)} fire pixels: the satellite sees the Palisades fire",
            "NASA FIRMS",
        ],
        ["2025-01-07T18:18:00-08:00", "The Eaton fire starts", "Cal Fire"],
        [
            _iso(eaton["utc"].iloc[0]),
            f"{len(eaton)} fire pixels over the Eaton fire, {west} already west of Lake Avenue",
            "NASA FIRMS",
        ],
        [
            "2025-01-08T03:25:00-08:00",
            "First evacuation order for west Altadena",
            "Los Angeles County report",
        ],
    ]
    return {
        "id": "los-angeles-2025",
        "name": "Los Angeles, January 2025",
        "detail": "Palisades and Eaton fires",
        "time_zone": LA_TZ,
        "granularity": "pass",
        "resolution": 8,
        "source": "NASA FIRMS, United States 2025 files: MODIS C6.1, VIIRS 375 m (S-NPP, NOAA-20)",
        "steps": steps,
        "events": _events(events),
    }


def _poisson_sf(k: int, mu: float) -> float:
    """P(X >= k) for X ~ Poisson(mu)."""
    if k <= 0:
        return 1.0
    term = math.exp(-mu)
    cdf = term
    for i in range(1, k):
        term *= mu / i
        cdf += term
    return max(0.0, 1.0 - cdf)


def retrospective_alert(snpp_days: pd.Series, first: str, last: str) -> dict:
    """The longest run of days the region rule would have kept on, with its peak.

    Same rule as the live early warning, with the only satellite of the whole
    record: the last 7 days at least twice the median of the same 7 days in the
    ten years before, and a one-sided Poisson p below 0.01.
    """
    daily = snpp_days.reindex(pd.date_range("2012-02-01", last), fill_value=0)
    week = daily.rolling(7).sum()
    rows = []
    for day in pd.date_range(first, last):
        past = [week.get(day - pd.DateOffset(years=k)) for k in range(1, 11)]
        expected = float(pd.Series([p for p in past if p == p]).median())
        observed = int(week[day])
        floor = max(expected, 1)
        on = observed >= 2 * floor and _poisson_sf(observed, max(expected, 0.5)) < 0.01
        rows.append((day, observed, expected, on))
    frame = pd.DataFrame(rows, columns=["day", "observed", "expected", "on"])
    runs = (frame["on"] != frame["on"].shift()).cumsum()
    longest = max((g for _, g in frame[frame["on"]].groupby(runs[frame["on"]])), key=len)
    peak = longest.loc[(longest["observed"] / longest["expected"].clip(lower=1)).idxmax()]
    return {
        "start": longest["day"].iloc[0],
        "peak": peak["day"],
        "observed": int(peak["observed"]),
        "expected": float(peak["expected"]),
    }


def corrientes(db: Path) -> dict:
    table = ds.dataset(db / "detections", format="parquet", partitioning="hive")
    wanted = ds.field("in_corrientes") & ds.field("is_vegetation")
    frames = []
    for platform in ("SNPP", "NOAA20"):
        part = table.to_table(
            columns=["acq_datetime", "latitude", "longitude", "frp"],
            filter=(ds.field("platform") == platform) & wanted,
        ).to_pandas()
        frames.append(part.assign(platform=platform))
    det = pd.concat(frames, ignore_index=True)
    local = det["acq_datetime"].dt.tz_convert(CORRIENTES_TZ)
    det["day"] = local.dt.normalize().dt.tz_localize(None)

    snpp = det[det["platform"] == "SNPP"].groupby("day").size()
    alert = retrospective_alert(snpp, "2021-11-01", CORRIENTES_DAYS[1])
    window = det[det["day"].between(*CORRIENTES_DAYS)].copy()
    window["cell"] = _h3(window, 6)
    steps = [
        {
            "time": _iso(day.tz_localize(CORRIENTES_TZ)),
            "label": "VIIRS (S-NPP, NOAA-20)",
            "cells": _cells(window[window["day"] == day]),
        }
        for day in pd.date_range(*CORRIENTES_DAYS)
    ]
    busiest = max(steps, key=lambda step: sum(cell[1] for cell in step["cells"]))
    busiest_count = sum(cell[1] for cell in busiest["cells"])
    ratio = alert["observed"] / max(alert["expected"], 1)

    def local_day(day: pd.Timestamp) -> str:
        return day.tz_localize(CORRIENTES_TZ).isoformat()

    events = [
        [
            local_day(alert["start"]),
            "The early warning's region rule would have raised the alert here, and kept it on",
            RETROSPECTIVE,
        ],
        [
            local_day(alert["peak"]),
            f"{alert['observed']:,} detections in 7 days, {ratio:.0f} times the usual",
            RETROSPECTIVE,
        ],
        [
            busiest["time"],
            f"Busiest day: {busiest_count:,} detections; that night a public fundraiser "
            "for the firefighters starts",
            "NASA FIRMS; La Nación",
        ],
        [
            "2022-02-27T00:00:00-03:00",
            "1,042,514 ha burned, 12 % of the province",
            "INTA Corrientes",
        ],
    ]
    outline = json.loads((resources.files("aeros.regions") / "corrientes.geojson").read_text())
    feature = outline["features"][0] if "features" in outline else outline
    return {
        "id": "corrientes-2022",
        "name": "Corrientes, summer 2021-2022",
        "detail": "Iberá wetlands and the province around them",
        "time_zone": CORRIENTES_TZ,
        "granularity": "day",
        "resolution": 6,
        "source": "NASA FIRMS VIIRS 375 m (S-NPP, NOAA-20), vegetation fires in Corrientes",
        "outline": feature["geometry"]["coordinates"][0],
        "steps": steps,
        "events": _events(events),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", type=Path, required=True, help="`aeros build-db` output")
    parser.add_argument("--raw", type=Path, required=True, help="where the FIRMS US files go")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for fire in (los_angeles(args.raw), corrientes(args.db)):
        path = args.out / f"{fire['id']}.json"
        path.write_text(json.dumps(fire, separators=(",", ":")))
        cells = sum(len(step["cells"]) for step in fire["steps"])
        print(f"{path}: {len(fire['steps'])} steps, {cells} cells, {path.stat().st_size:,} bytes")
        for event in fire["events"]:
            print("   ", event["time"], event["text"])


if __name__ == "__main__":
    main()
