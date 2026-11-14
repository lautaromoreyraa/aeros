"""What disappears when Terra stops.

Terra is the only platform in the record with a morning overpass. Fires that
burn in the morning and are out (or under cloud) by the early-afternoon passes
of Aqua and VIIRS are seen by Terra alone. This module measures that share and
the drift of Terra's overpass, which has moved earlier as its orbit decays.
"""

from __future__ import annotations

import pandas as pd

from aeros import grid

AFTERNOON = ("AQUA", "SNPP", "NOAA20", "NOAA21")


def terra_only_share(detections: pd.DataFrame, resolution: int) -> pd.DataFrame:
    det = detections[detections["is_vegetation"] & (detections["daynight"] == "D")].copy()
    det["cell"] = grid.cells_for(det["latitude"], det["longitude"], resolution)
    det["day"] = det["acq_datetime"].dt.tz_convert("UTC").dt.date
    seen = det.groupby(["cell", "day"])["platform"].agg(set)
    terra_days = seen[seen.map(lambda s: "TERRA" in s)]
    only = terra_days.map(lambda s: not (s & set(AFTERNOON)))
    by_year = (
        pd.DataFrame(
            {
                "year": pd.to_datetime(pd.Series(terra_days.index.get_level_values("day"))).dt.year,
                "terra_only": only.to_numpy(),
            }
        )
        .groupby("year")["terra_only"]
        .agg(["sum", "count"])
    )
    by_year.columns = ["terra_only_cell_days", "terra_cell_days"]
    by_year["terra_only_share"] = by_year["terra_only_cell_days"] / by_year["terra_cell_days"]

    terra = det[det["platform"] == "TERRA"]
    drift = terra.groupby(terra["acq_datetime"].dt.year)["solar_hour"].median()
    by_year["terra_median_solar_hour"] = drift
    return by_year.reset_index()
