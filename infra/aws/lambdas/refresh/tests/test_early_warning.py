"""Early warning on a hand-checkable fixture.

Window 2026-11-07..13. Cell A burns 7, 14, 7 and 21 VIIRS-equivalent hotspots a
week in 2025, 2024, 2023 and 2022; 2021 has no harmonized value (like the weeks
before Terra) and 2020 is outside the panel, so both drop out. B never burns,
S is a static industrial source in the archive, D is not in the panel at all.

2026-11-10 has no VIIRS data (gap) and NOAA-20 is missing on 2026-11-12, where
NOAA-21 stands in. With six data days, A's expected count per past year is
6/7 of its weekly value: 6, 12, 6, 18, so the median is 9.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, localcontext
from pathlib import Path

import duckdb
import h3
import pytest

import early_warning as ew

RES = 4
CELL_A = h3.latlng_to_cell(-27.45, -58.98, RES)
CELL_B = h3.latlng_to_cell(-31.0, -64.0, RES)
CELL_S = h3.latlng_to_cell(-38.9, -68.1, RES)
CELL_D = h3.latlng_to_cell(-25.0, -55.0, RES)
WEEKLY_A = {2025: 7.0, 2024: 14.0, 2023: 7.0, 2022: 21.0, 2021: None}
DAYS = ew.window(date(2026, 11, 14))
NOW = datetime(2026, 11, 14, 6, 0, tzinfo=UTC)


def center(cell: str) -> tuple[float, float]:
    return h3.cell_to_latlng(cell)


@pytest.fixture(scope="module")
def parquet(tmp_path_factory) -> tuple[str, str]:
    out: Path = tmp_path_factory.mktemp("panel")
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE panel (cell VARCHAR, week TIMESTAMP_NS, month TIMESTAMP_NS, "
        "harmonized_n DOUBLE, harmonized_source VARCHAR)"
    )
    week = date(2020, 12, 28)
    rows = []
    while week <= date(2026, 1, 5):
        a = WEEKLY_A.get(week.year, 7.0)
        nan_year = week.year == 2021
        for cell, value in ((CELL_A, a), (CELL_B, 0.0), (CELL_S, 70.0)):
            rows.append(
                [cell, week, week.replace(day=1), None if nan_year else value, "modeled_terra"]
            )
        week += timedelta(days=7)
    con.executemany("INSERT INTO panel VALUES (?, ?, ?, ?, ?)", rows)
    cells_path = (out / "harmonized_cells.parquet").as_posix()
    con.execute(f"COPY panel TO '{cells_path}' (FORMAT parquet)")

    con.execute("CREATE TABLE hotspots (cell VARCHAR, type BIGINT, harmonized_weight DOUBLE)")
    con.executemany(
        "INSERT INTO hotspots VALUES (?, ?, ?)",
        [[CELL_A, 0, 1.0], [CELL_S, 2, 0.0], [CELL_S, 0, 1.0], [CELL_B, 0, 1.0]],
    )
    hotspots_path = (out / "hotspots_harmonized.parquet").as_posix()
    con.execute(f"COPY hotspots TO '{hotspots_path}' (FORMAT parquet)")
    return cells_path, hotspots_path


def csv_of(points: list[tuple[float, float]]) -> bytes:
    lines = ["latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,frp"]
    lines += [f"{lat},{lon},330,0.4,0.4,2026-11-10,0412,N20,5" for lat, lon in points]
    return ("\n".join(lines) + "\n").encode()


def downloads() -> dict:
    """A: 30 detections, B: 1, D: 5, S: 100 (masked), spread over the data days."""
    a, b, d, s = center(CELL_A), center(CELL_B), center(CELL_D), center(CELL_S)
    per_day = {
        date(2026, 11, 7): [a] * 5 + [s] * 20,
        date(2026, 11, 8): [a] * 5 + [b] + [s] * 20,
        date(2026, 11, 9): [a] * 5 + [d] * 5 + [s] * 20,
        date(2026, 11, 11): [a] * 5 + [s] * 20,
        date(2026, 11, 12): [a] * 5 + [s] * 10,  # only NOAA-21 this day
        date(2026, 11, 13): [a] * 5 + [s] * 10,
    }
    out = {}
    for day in DAYS:
        if day == date(2026, 11, 10):
            out[("VIIRS_NOAA20_NRT", day)] = csv_of([])
            out[("VIIRS_NOAA21_NRT", day)] = csv_of([])
        elif day == date(2026, 11, 12):
            out[("VIIRS_NOAA21_NRT", day)] = csv_of(per_day[day])
        else:
            out[("VIIRS_NOAA20_NRT", day)] = csv_of(per_day[day])
            # NOAA-21 saw the same fires; counting it too would double them.
            out[("VIIRS_NOAA21_NRT", day)] = csv_of(per_day[day])
    return out


def test_days_pick_one_satellite_and_mark_gaps():
    picked = ew.pick_days(downloads(), DAYS)
    status = {d.day: (d.status, d.source) for d in picked}
    assert status[date(2026, 11, 10)] == ("gap", None)
    assert status[date(2026, 11, 12)] == ("ok", "VIIRS_NOAA21_NRT")
    assert status[date(2026, 11, 7)] == ("ok", "VIIRS_NOAA20_NRT")
    assert sum(len(d.points) for d in picked) == 36 + 100


def test_climatology_drops_incomplete_years_and_masks_static_cells(parquet):
    data_days = [d.day for d in ew.pick_days(downloads(), DAYS) if d.status == "ok"]
    clim = ew.load_climatology(duckdb.connect(), *parquet, data_days)
    assert clim.resolution == RES
    assert clim.static_cells == {CELL_S}
    assert clim.years == (1, 2, 3, 4)  # 2025..2022; 2021 is null, 2020 not in the panel
    assert CELL_S not in clim.by_cell
    assert CELL_B not in clim.by_cell  # never burned: implicit zero
    assert {k: round(v, 6) for k, v in clim.by_cell[CELL_A].items()} == {
        1: 6.0,
        2: 12.0,
        3: 6.0,
        4: 18.0,
    }


def test_report(parquet):
    picked = ew.pick_days(downloads(), DAYS)
    clim = ew.load_climatology(
        duckdb.connect(), *parquet, [d.day for d in picked if d.status == "ok"]
    )
    report = ew.build_report(picked, clim, NOW)

    assert report["generated_at"] == "2026-11-14T06:00:00Z"
    assert report["window"] == ["2026-11-07", "2026-11-13"]
    assert report["gap_days"] == ["2026-11-10"]
    assert len(report["days_with_data"]) == 6
    day12 = next(d for d in report["days"] if d["date"] == "2026-11-12")
    assert day12 == {"date": "2026-11-12", "status": "ok", "satellite": "NOAA-21", "detections": 15}
    gap = next(d for d in report["days"] if d["date"] == "2026-11-10")
    assert gap["detections"] is None  # a gap is not a zero

    region = report["region"]
    assert region["observed"] == 36  # S's 100 detections are masked
    assert region["expected"] == 9.0
    assert region["ratio"] == 4.0
    assert region["p_value"] == pytest.approx(ew.poisson_sf(36, 9.0), rel=1e-3)
    assert region["p_value"] < 0.01

    cells = {c["cell"]: c for c in report["cells"]}
    assert set(cells) == {CELL_A, CELL_D}  # B's single detection is not unusual
    assert cells[CELL_A]["observed"] == 30
    assert cells[CELL_A]["expected"] == 9.0
    assert cells[CELL_A]["ratio"] == pytest.approx(3.333)
    assert cells[CELL_D]["expected"] == 0.0
    assert cells[CELL_D]["ratio"] is None  # no history: no ratio, floor in the test
    assert cells[CELL_D]["p_value"] == pytest.approx(ew.poisson_sf(5, ew.EXPECTED_FLOOR), rel=1e-3)
    assert report["cells"][0]["cell"] == CELL_A  # most significant first


def test_all_gaps_give_no_scores(parquet):
    empty = {(s, d): csv_of([]) for s in ew.VIIRS_PREFERENCE for d in DAYS}
    picked = ew.pick_days(empty, DAYS)
    clim = ew.load_climatology(duckdb.connect(), *parquet, [])
    report = ew.build_report(picked, clim, NOW)
    assert report["days_with_data"] == []
    assert len(report["gap_days"]) == 7
    assert report["region"] is None
    assert report["cells"] == []


@pytest.mark.parametrize(
    ("k", "lam"), [(0, 3.0), (1, 0.5), (3, 3.0), (10, 2.0), (30, 9.0), (50, 80.0), (200, 150.0)]
)
def test_poisson_upper_tail_matches_exact_value(k, lam):
    # Reference in 60-digit decimals: 1 - CDF in floats loses the small tails.
    with localcontext() as ctx:
        ctx.prec = 60
        lam_d, term, lower = Decimal(lam), Decimal(-lam).exp(), Decimal(0)
        for i in range(k):
            lower += term
            term = term * lam_d / (i + 1)
        exact = float(1 - lower)
    assert ew.poisson_sf(k, lam) == pytest.approx(exact, rel=1e-9, abs=1e-300)


def test_poisson_tiny_tail_is_not_rounded_to_zero():
    # 1 - CDF would underflow to 0 here; the direct upper sum must not.
    p = ew.poisson_sf(60, 5.0)
    assert 0.0 < p < 1e-30


def test_window_is_the_last_seven_complete_days():
    assert ew.window(date(2026, 1, 3)) == [date(2025, 12, 27) + timedelta(days=i) for i in range(7)]
