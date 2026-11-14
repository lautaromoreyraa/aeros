"""A continuous VIIRS reference built from a chain of platforms.

Suomi NPP is the reference unit because it has the longest VIIRS record
(2012-01 to 2026-11-02). NOAA-20 carries the same instrument but on another
orbit phase and with its own calibration, so its counts are bridged to SNPP
units with a monthly ratio fitted where both flew (2018-04 to 2026-11).

Data gaps are not zeros: a platform that is "operating" by its mission window
but delivered nothing for a whole week across the region, while MODIS saw fire,
had an outage (Earthdata reported NOAA-20/21 gaps from 2026-11-05). Those
weeks fall through to the next platform in the chain, or to the MODIS model.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from aeros import models
from aeros.models import RatioBaseline

# A region-wide MODIS total below this is too little evidence to call a
# silent VIIRS week an outage rather than a quiet week.
GAP_MIN_MODIS = 3


def platform_gaps(frame: pd.DataFrame, platform: str) -> pd.Series:
    """Per row: True when `platform` was operating but silent region-wide that week."""
    col = f"{platform.lower()}_ref_n"
    weekly = frame.groupby("week").agg(
        ref=(col, "sum"), modis=("terra_n", "sum"), modis_aqua=("aqua_n", "sum")
    )
    silent = (weekly["ref"] == 0) & ((weekly["modis"] + weekly["modis_aqua"]) >= GAP_MIN_MODIS)
    return frame["week"].map(silent).fillna(False).astype(bool)


def chain(frame: pd.DataFrame, reference: tuple[str, ...]) -> pd.DataFrame:
    from aeros.features import operating

    out = frame.copy()
    primary = reference[0]
    usable = {}
    for platform in reference:
        on = operating(out, platform)
        gap = platform_gaps(out, platform) & on
        usable[platform] = on & ~gap
        out[f"{platform.lower()}_gap"] = gap

    viirs = pd.Series(np.nan, index=out.index)
    variance = pd.Series(0.0, index=out.index)
    shared_sd = pd.Series(0.0, index=out.index)
    source = pd.Series("", index=out.index, dtype=object)
    for platform in reference:
        counts = out[f"{platform.lower()}_ref_n"]
        phi = kappa = 0.0
        if platform != primary:
            counts, phi, kappa = _bridge(out, platform, primary, usable)
        take = usable[platform] & viirs.isna()
        viirs[take] = counts[take]
        variance[take] = phi * np.maximum(counts[take], 0.05)
        shared_sd[take] = np.sqrt(kappa) * counts[take]
        source[take] = platform

    out["viirs_n"] = viirs.fillna(0.0)
    out["viirs_var"] = variance
    out["viirs_shared_sd"] = shared_sd
    out["reference_on"] = viirs.notna()
    out["reference_platform"] = source
    # Training uses only weeks measured by the primary platform itself, so the
    # translator never learns from bridged (already modeled) values.
    out["reference_primary"] = source == primary
    return out


def _bridge(
    frame: pd.DataFrame, platform: str, primary: str, usable: dict[str, pd.Series]
) -> tuple[pd.Series, float, float]:
    """Counts of `platform` in `primary` units, with the bridge's own uncertainty.

    The dispersion and systematic terms are measured on the overlap the same
    way as for the MODIS translators, so bridged weeks carry an honest band
    instead of being presented as exact observations.
    """
    col, target = f"{platform.lower()}_ref_n", f"{primary.lower()}_ref_n"
    both = usable[platform] & usable[primary]
    if not both.any():
        return frame[col], 1.0, 0.0
    model = RatioBaseline((col,)).fit(frame[both], frame.loc[both, target])
    on_overlap = model.predict(frame[both])
    y = frame.loc[both, target].to_numpy()
    phi = models.dispersion(y, on_overlap)
    kappa = models.systematic(frame[both], y, on_overlap)
    return pd.Series(model.predict(frame), index=frame.index), phi, kappa
