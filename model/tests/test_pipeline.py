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


def _calendar(values_by_month: dict[int, float], years=(2001, 2002, 2003)) -> pd.DataFrame:
    rows = [
        {"year": y, "month_of_year": m, "harmonized": values_by_month.get(m, 0.0)}
        for y in years
        for m in range(1, 13)
    ]
    return pd.DataFrame(rows)


def test_critical_period_wraps_around_the_year_end():
    table = _calendar({11: 30.0, 12: 40.0, 1: 20.0, 6: 10.0})
    period = burn_calendar.critical_period(table, share=0.8)
    assert period["months"] == [11, 12, 1]
    assert period["peak_month"] == 12


def test_critical_period_is_the_shortest_run():
    table = _calendar({8: 50.0, 9: 40.0, 10: 5.0, 3: 5.0})
    assert burn_calendar.critical_period(table, share=0.8)["months"] == [8, 9]


def _bridge_frame():
    weeks = pd.date_range("2025-06-02", periods=80, freq="7D")
    frame = pd.DataFrame({"cell": "a", "week": weeks})
    frame["month"] = grid.week_month(frame["week"])
    frame["terra_n"] = 5.0
    frame["aqua_n"] = 5.0
    frame["snpp_ref_n"] = 10.0
    frame["noaa20_ref_n"] = 8.0
    snpp_off = frame["week"] + pd.Timedelta(days=6) > pd.Timestamp("2026-11-01")
    frame.loc[snpp_off, "snpp_ref_n"] = 0.0
    outage = frame["week"].between("2026-12-07", "2026-12-14")
    frame.loc[outage, "noaa20_ref_n"] = 0.0
    return frame, snpp_off, outage


def test_reference_chain_bridges_noaa20_after_snpp_stops():
    from aeros import reference

    frame, snpp_off, outage = _bridge_frame()
    out = reference.chain(frame, ("SNPP", "NOAA20"))
    after = out[snpp_off & ~outage]
    assert (after["reference_platform"] == "NOAA20").all()
    # NOAA-20 sees 8 where SNPP saw 10: bridged values are back in SNPP units
    assert after["viirs_n"].round(6).eq(10.0).all()
    assert out.loc[~snpp_off, "reference_primary"].all()


def test_silent_platform_weeks_are_gaps_not_zero_fire():
    from aeros import reference

    frame, _, outage = _bridge_frame()
    out = reference.chain(frame, ("SNPP", "NOAA20"))
    assert out.loc[outage, "noaa20_gap"].all()
    assert not out.loc[outage, "reference_on"].any()


def test_noaa21_backs_up_noaa20_during_its_outage():
    from aeros import reference

    frame, snpp_off, outage = _bridge_frame()
    # NOAA-21 sees 9 where Suomi NPP saw 10, and keeps delivering through the outage.
    frame["noaa21_ref_n"] = 9.0
    out = reference.chain(frame, ("SNPP", "NOAA20", "NOAA21"))

    backup = out[outage]
    assert (backup["reference_platform"] == "NOAA21").all()
    assert backup["reference_on"].all()
    assert backup["viirs_n"].round(6).eq(10.0).all()
    # Outside the outage the earlier platform keeps speaking: NOAA-21 never takes over by default.
    assert (out.loc[snpp_off & ~outage, "reference_platform"] == "NOAA20").all()
    assert (out.loc[~snpp_off, "reference_platform"] == "SNPP").all()


def test_a_chain_with_no_noaa21_files_behaves_as_before():
    from aeros import reference

    frame, _, _ = _bridge_frame()
    before = reference.chain(frame, ("SNPP", "NOAA20"))
    frame["noaa21_ref_n"] = 0.0
    after = reference.chain(frame, ("SNPP", "NOAA20", "NOAA21"))

    for column in ("viirs_n", "reference_platform", "reference_on", "reference_primary"):
        assert after[column].equals(before[column]), column


def test_the_default_chain_ends_with_noaa21():
    assert features.DEFAULT_REFERENCE == ("SNPP", "NOAA20", "NOAA21")


def test_cell_day_unit_counts_days_not_pixels():
    raw = pd.DataFrame(
        {
            "latitude": [-26.0] * 4,
            "longitude": [-61.0] * 4,
            "acq_date": ["2015-08-03", "2015-08-03", "2015-08-03", "2015-08-04"],
            "acq_time": ["1730"] * 4,
            "satellite": ["N"] * 4,
            "frp": [5.0] * 4,
            "type": [0] * 4,
        }
    )
    det = firms.normalize(raw, "VIIRS")
    hotspots = features.build_panel(det, unit="hotspots").frame
    days = features.build_panel(det, unit="cell_days").frame
    assert hotspots["snpp_ref_n"].sum() == 4
    assert days["snpp_ref_n"].sum() == 2


def _weekly(
    cells=("84c2a01ffffffff",), years=range(2010, 2014), value=lambda y, w: float(w % 5 + y - 2010)
):
    rows = []
    for cell in cells:
        for week in pd.date_range(f"{years[0]}-01-04", f"{years[-1]}-12-27", freq="7D"):
            rows.append(
                {
                    "cell": cell,
                    "week": week,
                    "harmonized_n": value(week.year, week.isocalendar().week),
                }
            )
    return pd.DataFrame(rows)


def test_forecast_climatology_only_looks_at_earlier_years():
    from aeros import forecast

    table = forecast.weekly_series(_weekly())
    clim = forecast._climatology(table)
    first = clim[clim["year"] == 2010]
    assert first["climatology"].isna().all()
    # in 2013 the climatology of a week is the mean of 2010-2012 for that week
    row = clim[(clim["year"] == 2013) & (clim["woy"] == 10)].iloc[0]
    assert row["climatology"] == pytest.approx(float(10 % 5) + 1.0)


def test_forecast_builds_every_horizon_with_target_h_weeks_later():
    from aeros import forecast

    table = forecast.weekly_series(_weekly())
    examples = forecast.build_examples(table)
    assert set(examples["horizon"]) == set(forecast.HORIZONS)
    row = examples[(examples["horizon"] == 3)].dropna(subset=["target"]).iloc[0]
    expected = table.set_index("week").loc[row["target_week"], "y"]
    assert row["target"] == pytest.approx(expected)
    assert row["target_week"] - row["issue_week"] == pd.Timedelta(weeks=3)
