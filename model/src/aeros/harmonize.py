"""Build the harmonized series and the per-hotspot weights.

Every cell-week ends up in "VIIRS-equivalent hotspots", the unit of the sensor
that keeps flying:

* weeks where the reference VIIRS platform was operating keep its observed count;
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
    out["modeled_n"] = mean
    out["harmonized_n"] = np.where(observed, out["viirs_n"], mean)
    out["harmonized_var"] = np.where(observed, 0.0, variance)
    out["harmonized_shared_sd"] = np.where(observed, 0.0, shared)
    out["harmonized_source"] = np.where(
        observed, "observed", np.where(out["aqua_on"], "modeled_terra_aqua", "modeled_terra")
    )
    # Weeks before Terra's first fire product carry no information at all.
    out.loc[
        ~out["terra_on"] & ~out["reference_on"],
        ["harmonized_n", "harmonized_var", "harmonized_shared_sd"],
    ] = np.nan
    return out


def hotspot_weights(
    detections: pd.DataFrame, harmonized: pd.DataFrame, resolution: int, reference: tuple[str, ...]
) -> pd.DataFrame:
    """Attach to every detection how many VIIRS-equivalent hotspots it stands for.

    * reference VIIRS detections in observed weeks: weight 1;
    * MODIS detections in modeled weeks: the cell-week prediction shared evenly
      among the MODIS detections of that cell-week;
    * anything else (MODIS during the VIIRS era, non-reference VIIRS platforms,
      non-vegetation sources): weight 0, kept for traceability.

    Modeled fire in cell-weeks where MODIS saw nothing has no detection to carry
    it; it is still in the calendar totals, flagged as `unattached_n` there.
    """
    det = detections.copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    det["week"] = grid.week_start(det["acq_datetime"])
    keys = harmonized[
        ["cell", "week", "harmonized_n", "harmonized_source", "terra_n", "aqua_n", "aqua_on"]
    ]
    det = det.merge(keys, on=["cell", "week"], how="left")

    is_modis = det["platform"].isin(["TERRA", "AQUA"])
    modeled = det["harmonized_source"].fillna("").str.startswith("modeled")
    modis_in_week = np.where(
        det["aqua_on"].fillna(False), det["terra_n"] + det["aqua_n"], det["terra_n"]
    )
    counts_modis = is_modis & (det["aqua_on"].fillna(False) | (det["platform"] == "TERRA"))

    weight = np.zeros(len(det))
    observed_ref = det["platform"].isin(reference) & (det["harmonized_source"] == "observed")
    weight[observed_ref.to_numpy()] = 1.0
    share = modeled & counts_modis & det["is_vegetation"] & (modis_in_week > 0)
    weight[share.to_numpy()] = (det.loc[share, "harmonized_n"] / modis_in_week[share]).to_numpy()
    weight[~det["is_vegetation"].to_numpy()] = 0.0

    det["harmonized_weight"] = weight
    return det.drop(columns=["harmonized_n", "terra_n", "aqua_n", "aqua_on"])


def unattached(harmonized: pd.DataFrame) -> pd.Series:
    """Modeled VIIRS-equivalent fire in cell-weeks with no MODIS detection."""
    no_modis = (harmonized["terra_n"] + harmonized["aqua_n"]) == 0
    modeled = harmonized["harmonized_source"] != "observed"
    return harmonized["harmonized_n"].where(no_modis & modeled, 0.0).fillna(0.0)
