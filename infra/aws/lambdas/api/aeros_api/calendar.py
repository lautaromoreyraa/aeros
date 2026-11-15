"""Month x year burning calendar, the same arithmetic as `aeros.burn_calendar.monthly`.

* `harmonized`: VIIRS-equivalent hotspots in the area that month;
* `low`/`high`: 90 % interval. Cell-week variances add up as independent, the
  translator's shared error adds up linearly (it moves every cell together);
* `median_same_month`: median of the same calendar month over every *other*
  year, so an extreme season does not drag its own reference toward itself;
* `anomaly`, `anomaly_ratio`: harmonized against that median.

Kept free of pandas so the Lambda image stays small; the tests pin it to the
model's numbers on a fixture.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from collections.abc import Iterable
from datetime import date

from aeros_api.store import MonthSourceRow

# Two-sided 90 % normal quantile, as aeros.models.Z90.
Z90 = 1.6448536269514722
DECIMALS = 3


def monthly(rows: Iterable[MonthSourceRow], start: date, end: date) -> list[dict]:
    by_month: dict[str, list[MonthSourceRow]] = defaultdict(list)
    for row in rows:
        by_month[row.month].append(row)

    table = [_month(month, group) for month, group in sorted(by_month.items())]
    _attach_anomalies(table)

    first, last = (start.year, start.month), (end.year, end.month)
    return [_rounded(r) for r in table if first <= (r["year"], r["month_of_year"]) <= last]


def _month(month: str, group: list[MonthSourceRow]) -> dict:
    harmonized = _sum(r.harmonized for r in group)
    variance = _sum(r.variance for r in group)
    shared = _sum(r.shared_sd for r in group)
    if variance is not None and shared is not None:
        variance += shared**2
    half = Z90 * math.sqrt(max(variance or 0.0, 0.0))
    year, month_of_year = (int(part) for part in month.split("-"))
    return {
        "year": year,
        "month_of_year": month_of_year,
        "harmonized": harmonized,
        "low": None if harmonized is None else max(harmonized - half, 0.0),
        "high": None if harmonized is None else harmonized + half,
        "stacked_raw": math.fsum(r.stacked_raw for r in group),
        "unattached": math.fsum(r.unattached for r in group),
        # Most frequent source among the month's cell-weeks; ties go to the
        # alphabetically first, as pandas' Series.mode does.
        "source": min(_weeks_by_source(group).items(), key=lambda kv: (-kv[1], kv[0]))[0],
    }


def _weeks_by_source(group: list[MonthSourceRow]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for r in group:
        counts[r.source] += r.weeks
    return counts


def _sum(values: Iterable[float | None]) -> float | None:
    """Sum that stays None when every value is None (pandas' min_count=1)."""
    present = [v for v in values if v is not None and not math.isnan(v)]
    return math.fsum(present) if present else None


def _attach_anomalies(table: list[dict]) -> None:
    by_calendar_month: dict[int, list[dict]] = defaultdict(list)
    for row in table:
        by_calendar_month[row["month_of_year"]].append(row)
    for rows in by_calendar_month.values():
        for row in rows:
            others = [r["harmonized"] for r in rows if r is not row and r["harmonized"] is not None]
            median = statistics.median(others) if others else None
            value = row["harmonized"]
            row["median_same_month"] = median
            row["anomaly"] = None if value is None or median is None else value - median
            row["anomaly_ratio"] = (
                value / median if value is not None and median is not None and median > 0 else None
            )


def _rounded(row: dict) -> dict:
    return {k: round(v, DECIMALS) if isinstance(v, float) else v for k, v in row.items()}
