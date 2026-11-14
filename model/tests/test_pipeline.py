import numpy as np
import pandas as pd
import pytest

from aeros import burn_calendar, features, firms, grid, models, sensors, synthetic, validation


def test_instrument_is_read_from_file_name():
    assert sensors.instrument_from_filename("viirs-snpp_2025_Brazil.csv") == "VIIRS"
    assert sensors.instrument_from_filename("fire_archive_M-C61_123.csv") == "MODIS"
    with pytest.raises(ValueError):
        sensors.instrument_from_filename("hotspots.csv")


def test_normalize_keeps_every_row_and_flags_non_vegetation():
    raw = pd.DataFrame(
        {
            "latitude": [-26.0, -26.1],
            "longitude": [-61.0, -61.1],
            "acq_date": ["2020-08-03", "2020-08-04"],
            "acq_time": ["124", "1430"],
            "satellite": ["N", "N"],
            "frp": [5.0, 0.0],
            "type": [0, 2],
            "daynight": ["N", "D"],
        }
    )
    out = firms.normalize(raw, "VIIRS", "x.csv")
    assert len(out) == 2
    assert out["platform"].tolist() == ["SNPP", "SNPP"]
    assert out["is_vegetation"].tolist() == [True, False]
    # "124" is 01:24 UTC, not 12:40
    assert out["acq_datetime"].iloc[0].hour == 1
    assert str(out["acq_datetime"].dt.tz) == "UTC"


def test_week_belongs_to_the_month_of_its_thursday():
    week = pd.Series(pd.to_datetime(["2024-07-29"]))  # Monday; Thursday is Aug 1
    assert grid.week_month(week).iloc[0] == pd.Timestamp("2024-08-01")


def test_baseline_predicts_floor_where_modis_is_blank():
    frame = pd.DataFrame(
        {
            "week": pd.to_datetime(["2015-08-03"] * 4),
            "terra_n": [0.0, 0.0, 2.0, 4.0],
            "aqua_n": [0.0, 0.0, 0.0, 0.0],
        }
    )
    model = models.RatioBaseline(("terra_n", "aqua_n")).fit(frame, pd.Series([1.0, 3.0, 6.0, 12.0]))
    np.testing.assert_allclose(model.predict(frame), [2.0, 2.0, 6.0, 12.0])


def test_leave_one_out_median_excludes_the_year_itself():
    table = pd.DataFrame(
        {
            "month": pd.to_datetime(["2001-08-01", "2002-08-01", "2003-08-01"]),
            "harmonized_n": [10.0, 20.0, 100.0],
            "harmonized_var": [0.0, 0.0, 0.0],
            "harmonized_shared_sd": [0.0, 0.0, 0.0],
            "stacked_n": [5.0, 10.0, 50.0],
            "harmonized_source": ["observed"] * 3,
            "terra_n": [1.0, 1.0, 1.0],
            "aqua_n": [0.0, 0.0, 0.0],
            "cell": ["a", "a", "a"],
        }
    )
    out = burn_calendar.monthly(table)
    assert out["median_same_month"].tolist() == [60.0, 55.0, 15.0]


@pytest.fixture(scope="module")
def small_panel():
    archive = synthetic.generate(
        start="2010-01-04", end="2016-12-26", bbox=(-62.0, -26.0, -61.0, -25.0), seed=3
    )
    det = pd.concat(
        [firms.normalize(archive.modis, "MODIS"), firms.normalize(archive.viirs, "VIIRS")],
        ignore_index=True,
    )
    return features.build_panel(det).frame


def test_panel_has_no_location_or_year_features(small_panel):
    for leaked in ("cell", "year", "latitude", "longitude"):
        assert leaked not in features.ALL_FEATURES
    assert {"viirs_n", "stacked_n", "reference_on"} <= set(small_panel)


def test_translators_beat_raw_modis_out_of_sample(small_panel):
    report, fitted = validation.evaluate(small_panel, split_year=2014)
    test = validation.overlap(small_panel)
    test = test[test["year"] > 2014]
    raw = validation.scores(
        test, test["viirs_n"].to_numpy(), (test["terra_n"] + test["aqua_n"]).to_numpy()
    )
    assert report.winner in models.FAMILIES
    assert report.temporal[report.winner]["mae_cell_year"] < raw["mae_cell_year"]
    assert abs(report.temporal[report.winner]["bias_total"]) < abs(raw["bias_total"])
    assert set(fitted) == set(models.FAMILIES)
