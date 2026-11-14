from datetime import date

import pandas as pd
import pytest

from aeros import database, firms, regions

MERCEDES_CTES = (-29.18, -58.08)
FILADELFIA_PY = (-22.35, -60.03)
PATAGONIA = (-45.0, -70.0)

MODIS_HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,"
    "confidence,version,bright_t31,frp,daynight,type"
)
VIIRS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,"
    "confidence,version,bright_ti5,frp,daynight"
)


def _modis(point, day, time, sat="Terra", conf=85, fire_type=0):
    lat, lon = point
    return (
        f"{lat},{lon},320.5,1.2,1.1,{day},{time},{sat},MODIS,{conf},61.03,295.0,12.5,D,{fire_type}"
    )


def _viirs(point, day, time, conf="n", version="2.0NRT", fire_type=None):
    lat, lon = point
    row = f"{lat},{lon},330.1,0.4,0.4,{day},{time},N,VIIRS,{conf},{version},290.2,4.0,N"
    return row if fire_type is None else f"{row},{fire_type}"


@pytest.fixture()
def raw(tmp_path):
    country = tmp_path / "raw" / "firms"
    recent = tmp_path / "raw" / "firms-recent"
    country.mkdir(parents=True)
    recent.mkdir(parents=True)
    rows = {
        "Argentina": [
            _modis(MERCEDES_CTES, "2020-08-03", "1405"),
            _modis(MERCEDES_CTES, "2020-08-02", "1730", sat="Aqua", conf=20),
            _modis(PATAGONIA, "2020-08-03", "1405"),
        ],
        "Paraguay": [_modis(FILADELFIA_PY, "2020-08-04", "0300", fire_type=2)],
        "Bolivia": [],
    }
    for name, lines in rows.items():
        (country / f"modis_2020_{name}.csv").write_text("\n".join([MODIS_HEADER, *lines]) + "\n")
    # The same SNPP detection served twice, by standard processing and NRT.
    same = _viirs(FILADELFIA_PY, "2021-01-02", "0500", version="2")
    (recent / "fire_archive_sv-c2_2021-01-01.csv").write_text(f"{VIIRS_HEADER},type\n{same},0\n")
    (recent / "fire_nrt_sv-c2_2021-01-01.csv").write_text(
        "\n".join([VIIRS_HEADER, same, _viirs(MERCEDES_CTES, "2021-01-03", "0510", conf="h")])
        + "\n"
    )
    return tmp_path


@pytest.fixture()
def built(raw):
    out = raw / "db"
    report = database.build(
        [raw / "raw" / "firms", raw / "raw" / "firms-recent"],
        out,
        regions.parse("all"),
        today=date(2021, 1, 10),
    )
    return out, report


def test_files_are_classified_by_name():
    s = database.describe(database.Path("modis_2020_Paraguay.csv"))
    assert (s.kind, s.level, s.platforms) == ("country", "SP", ("TERRA", "AQUA"))
    s = database.describe(database.Path("fire_nrt_j1v-c2_2026-11-09.csv"))
    assert (s.kind, s.level, s.platforms) == ("area_api", "NRT", ("NOAA20",))
    s = database.describe(database.Path("fire_archive_M-C61_848479.csv"))
    assert (s.kind, s.level) == ("area_request", "SP")
    assert database.describe(database.Path("J1_VIIRS_C2_Global_7d.csv")) is None


def test_detections_are_partitioned_by_platform_and_year(built):
    out, report = built
    parts = sorted(
        p.relative_to(out / "detections").parent.as_posix()
        for p in (out / "detections").rglob("*.parquet")
    )
    assert parts == [
        "platform=AQUA/year=2020",
        "platform=SNPP/year=2021",
        "platform=TERRA/year=2020",
    ]
    assert report["duplicates"] == 1


def test_database_keeps_the_box_sorts_by_time_and_flags_regions(built):
    out, _ = built
    det = database.load(out, with_cells=True)
    assert PATAGONIA[0] not in det["latitude"].tolist()
    assert det["acq_datetime"].is_monotonic_increasing
    terra = det[det["platform"] == "TERRA"].set_index("latitude")
    assert terra.loc[MERCEDES_CTES[0], "in_corrientes"]
    assert not terra.loc[MERCEDES_CTES[0], "in_paraguay"]
    assert terra.loc[FILADELFIA_PY[0], "in_gran_chaco"]
    assert not terra.loc[FILADELFIA_PY[0], "is_vegetation"]
    assert terra["bt_mir"].iloc[0] == pytest.approx(320.5)


def test_standard_processing_wins_and_nrt_type_is_marked_unknown(built):
    out, _ = built
    snpp = database.load(out, platforms=["SNPP"], with_cells=True)
    assert len(snpp) == 2
    assert snpp["processing_level"].tolist() == ["SP", "NRT"]
    assert snpp["type_known"].tolist() == [True, False]
    assert snpp["confidence_class"].tolist() == ["nominal", "high"]


def test_confidence_shares_one_scale_across_instruments(built):
    out, _ = built
    aqua = database.load(out, platforms=["AQUA"], with_cells=True)
    assert aqua["confidence_class"].tolist() == ["low"]


def test_load_returns_the_loader_schema(built):
    out, _ = built
    det = database.load(out, start=date(2020, 8, 3), end=date(2020, 8, 31))
    assert list(det.columns) == firms.COLUMNS
    assert det["acq_datetime"].min() >= pd.Timestamp("2020-08-03", tz="UTC")


def test_cell_days_counts_vegetation_fires_per_sensor(built):
    out, _ = built
    table = pd.read_parquet(out / "cell_days")
    assert table["n"].sum() == 4  # 5 stored detections, one industrial
    assert set(table["platform"].astype(str)) == {"TERRA", "AQUA", "SNPP"}


def test_coverage_needs_every_study_country_and_reports_gaps(raw):
    (raw / "raw" / "firms" / "modis_2020_Bolivia.csv").unlink()
    out = raw / "db"
    database.build(
        [raw / "raw" / "firms", raw / "raw" / "firms-recent"],
        out,
        regions.parse("all"),
        today=date(2021, 1, 10),
    )
    cov = __import__("json").loads((out / "coverage.json").read_text())
    assert ["2000-11-01", "2021-01-10"] in cov["TERRA"]["missing"]
    snpp = cov["SNPP"]
    assert snpp["covered_days"] == 5
    assert snpp["nrt_days"] == 0
    assert snpp["missing"][-1] == ["2021-01-06", "2021-01-10"]


def test_compare_matches_an_independent_download(built, tmp_path):
    out, _ = built
    reference = tmp_path / "fire_archive_M-C61_1.csv"
    reference.write_text(
        "\n".join(
            [
                MODIS_HEADER,
                _modis(MERCEDES_CTES, "2020-08-03", "1405"),
                _modis(FILADELFIA_PY, "2020-08-04", "0300", fire_type=2),
                _modis(MERCEDES_CTES, "2020-08-04", "1405"),
            ]
        )
        + "\n"
    )
    checks = {c["platform"]: c for c in database.compare(out, [reference], regions.parse("all"))}
    terra = checks["TERRA"]
    assert (terra["days"], terra["database"], terra["reference_count"]) == (2, 2, 3)
    assert terra["worst_days"] == {"2020-08-04": -1}
