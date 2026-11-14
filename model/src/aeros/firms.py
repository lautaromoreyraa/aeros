"""Load FIRMS active fire CSV files into one typed detection table.

Rows are never dropped. Non-vegetation sources (`type` 1, 2, 3: volcanoes,
static industrial sources, offshore) are flagged so the caller decides.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pandas as pd

from aeros.sensors import SATELLITE_CODES, instrument_from_filename

COLUMNS = [
    "instrument",
    "platform",
    "latitude",
    "longitude",
    "acq_datetime",
    "solar_hour",
    "daynight",
    "frp",
    "scan",
    "track",
    "confidence",
    "type",
    "is_vegetation",
    "source_file",
    "source_row",
]


def read_firms_csv(path: Path | str) -> pd.DataFrame:
    path = Path(path)
    instrument = instrument_from_filename(path)
    raw = pd.read_csv(path, dtype={"acq_time": str, "confidence": str, "version": str})
    return normalize(raw, instrument, source_file=path.name)


def normalize(raw: pd.DataFrame, instrument: str, source_file: str = "") -> pd.DataFrame:
    """Map a raw FIRMS frame (archive or NRT layout) onto the common schema."""
    missing = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "frp"} - set(raw)
    if missing:
        raise ValueError(f"{source_file}: missing FIRMS columns {sorted(missing)}")

    acq_time = raw["acq_time"].astype(str).str.zfill(4)
    acq_datetime = pd.to_datetime(
        raw["acq_date"].astype(str) + " " + acq_time.str[:2] + ":" + acq_time.str[2:],
        format="%Y-%m-%d %H:%M",
        utc=True,
    )
    hours = acq_datetime.dt.hour + acq_datetime.dt.minute / 60.0
    # Mean local solar time from the pixel longitude. It ignores the equation of
    # time (< 17 min), which is far below the overpass differences we care about.
    solar_hour = (hours + raw["longitude"].astype(float) / 15.0) % 24.0

    platform = raw["satellite"].astype(str).map(SATELLITE_CODES)
    if platform.isna().any():
        unknown = sorted(raw.loc[platform.isna(), "satellite"].astype(str).unique())
        raise ValueError(f"{source_file}: unknown satellite codes {unknown}")

    fire_type = raw["type"].astype("Int64") if "type" in raw else pd.Series(0, index=raw.index)

    out = pd.DataFrame(
        {
            "instrument": instrument,
            "platform": platform.values,
            "latitude": raw["latitude"].astype(float).values,
            "longitude": raw["longitude"].astype(float).values,
            # A Series, not `.values`: the numpy array would drop the UTC tz.
            "acq_datetime": acq_datetime.reset_index(drop=True),
            "solar_hour": solar_hour.values,
            "daynight": raw.get("daynight", pd.Series("D", index=raw.index)).astype(str).values,
            "frp": raw["frp"].astype(float).values,
            "scan": raw.get("scan", pd.Series(np.nan, index=raw.index)).astype(float).values,
            "track": raw.get("track", pd.Series(np.nan, index=raw.index)).astype(float).values,
            "confidence": raw.get("confidence", pd.Series("", index=raw.index)).astype(str).values,
            "type": fire_type.fillna(0).astype(int).values,
            "source_file": source_file,
            "source_row": np.arange(1, len(raw) + 1),
        }
    )
    out["is_vegetation"] = out["type"] == 0
    return out[COLUMNS]


def load_many(paths: Iterable[Path | str]) -> pd.DataFrame:
    frames = [read_firms_csv(p) for p in paths]
    if not frames:
        raise FileNotFoundError("no FIRMS CSV files given")
    return pd.concat(frames, ignore_index=True)
