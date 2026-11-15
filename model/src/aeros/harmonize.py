"""Build the harmonized series and the per-hotspot weights.

Every cell-week ends up in "VIIRS-equivalent hotspots", the unit of the sensor
that keeps flying:

* weeks measured by the reference VIIRS chain keep that count (Suomi NPP, or
  NOAA-20 bridged to Suomi NPP units once SNPP stopped);
* earlier weeks get the translator's prediction from what MODIS saw.

So the sensor of origin no longer matters downstream: the calendar, the
anomalies and the CSV all read the same `harmonized_n` column.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from aeros import grid
from aeros.models import Translator


def harmonize_panel(frame: pd.DataFrame, translator: Translator) -> pd.DataFrame:
    out = frame.copy()
    mean, variance, shared = translator.predict(out)
    observed = out["reference_on"].to_numpy()
    primary = out["reference_primary"].to_numpy()
    out["modeled_n"] = mean
    out["harmonized_n"] = np.where(observed, out["viirs_n"], mean)
    out["harmonized_var"] = np.where(observed, out["viirs_var"], variance)
    out["harmonized_shared_sd"] = np.where(observed, out["viirs_shared_sd"], shared)
    out["harmonized_source"] = np.select(
        [primary, observed, out["aqua_on"].to_numpy()],
        ["observed", "bridged", "modeled_terra_aqua"],
        default="modeled_terra",
    )
    # Weeks before Terra's first fire product carry no information at all.
    out.loc[
        ~out["terra_on"] & ~out["reference_on"],
        ["harmonized_n", "harmonized_var", "harmonized_shared_sd"],
    ] = np.nan
    return out


def hotspot_weights(
    detections: pd.DataFrame, harmonized: pd.DataFrame, resolution: int
) -> pd.DataFrame:
    """Attach to every detection how much harmonized activity it stands for.

    Each cell-week's harmonized value is shared evenly among the detections of
    the platform that defines that week: the reference VIIRS platform when it
    was observed or bridged, MODIS (Terra, plus Aqua once it flew) when the
    week was modeled. Weights of a cell-week therefore add up to its
    harmonized value in either unit. Every other detection keeps weight 0 and
    stays in the table for traceability.

    Modeled fire in cell-weeks where MODIS saw nothing has no detection to carry
    it; it is still in the calendar totals, flagged as `unattached_n` there.
    """
    det = detections.copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    det["week"] = grid.week_start(det["acq_datetime"])
    keys = harmonized[
        ["cell", "week", "harmonized_n", "harmonized_source", "reference_platform", "aqua_on"]
    ]
    det = det.merge(keys, on=["cell", "week"], how="left")

    source = det["harmonized_source"].fillna("")
    from_reference = source.isin(["observed", "bridged"]) & (
        det["platform"] == det["reference_platform"]
    )
    counted_modis = (det["platform"] == "TERRA") | (
        (det["platform"] == "AQUA") & det["aqua_on"].fillna(False).astype(bool)
    )
    from_modis = source.str.startswith("modeled") & counted_modis
    carrier = (from_reference | from_modis) & det["is_vegetation"]
    carriers = det[carrier].groupby(["cell", "week"]).size().rename("carriers")
    det = det.merge(carriers.reset_index(), on=["cell", "week"], how="left")

    weight = np.where(carrier, det["harmonized_n"] / det["carriers"], 0.0)
    det["harmonized_weight"] = np.nan_to_num(weight)
    return det.drop(columns=["harmonized_n", "aqua_on", "carriers"])


def unattached(harmonized: pd.DataFrame) -> pd.Series:
    """Modeled VIIRS-equivalent fire in cell-weeks with no MODIS detection."""
    no_modis = (harmonized["terra_n"] + harmonized["aqua_n"]) == 0
    modeled = harmonized["harmonized_source"].str.startswith("modeled")
    return harmonized["harmonized_n"].where(no_modis & modeled, 0.0).fillna(0.0)
