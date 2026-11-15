from datetime import date
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd
import pytest

from aeros import forecast, pipeline, power


def fake_payload(start: date, end: date, soil=lambda d: 0.5, t_max=30.0, dew=10.0, wind=5.0):
    days = pd.date_range(start, end, freq="D")
    keys = [d.strftime("%Y%m%d") for d in days]
    return {
        "properties": {
            "parameter": {
                "GWETROOT": {k: soil(d) for k, d in zip(keys, days, strict=True)},
                "T2M_MAX": dict.fromkeys(keys, t_max),
                "T2MDEW": dict.fromkeys(keys, dew),
                "WS10M_MAX": dict.fromkeys(keys, wind),
            }
        }
    }


class FakePower:
    def __init__(self, **values):
        self.calls: list[str] = []
        self.values = values

    def __call__(self, url: str) -> dict:
        self.calls.append(url)
        q = parse_qs(urlparse(url).query)
        start = date.fromisoformat(pd.Timestamp(q["start"][0]).date().isoformat())
        end = date.fromisoformat(pd.Timestamp(q["end"][0]).date().isoformat())
        return fake_payload(start, end, **self.values)


def test_cells_take_the_nearest_node_of_the_power_grid():
    assert power.node_for(-24.2, -60.3) == (-24.0, -60.0)
    assert power.node_for(-24.3, -60.4) == (-24.5, -60.625)


def test_hot_dry_windy_proxy_is_deficit_times_wind_and_never_negative():
    out = power.daily_hdw(np.array([30.0, 10.0]), np.array([10.0, 12.0]), np.array([5.0, 5.0]))
    deficit = power.saturation_vapour_pressure(np.array(30.0)) - power.saturation_vapour_pressure(
        np.array(10.0)
    )
    assert out[0] == pytest.approx(deficit * 5.0)
    assert out[1] == 0.0  # dew point above the maximum


def test_fill_values_become_missing():
    payload = fake_payload(date(2020, 1, 1), date(2020, 1, 2))
    payload["properties"]["parameter"]["GWETROOT"]["20200102"] = -999.0
    frame = power.parse(payload)
    assert np.isnan(frame.loc["2020-01-02", "GWETROOT"])
    assert frame.loc["2020-01-01", "GWETROOT"] == 0.5


def test_answer_without_a_parameter_is_an_error():
    payload = fake_payload(date(2020, 1, 1), date(2020, 1, 2))
    del payload["properties"]["parameter"]["T2MDEW"]
    with pytest.raises(power.PowerError):
        power.parse(payload)


def test_anomaly_compares_with_the_1991_2020_normal_of_the_same_week():
    # Soil wetness 0.5 every year, except a drier 2023.
    fetch = FakePower(soil=lambda d: 0.3 if d.year == 2023 else 0.5)
    daily = power.parse(fetch(power.url((-24.0, -60.0), power.FIRST_DAY, date(2024, 12, 31))))
    weeks = power.with_anomalies(power.weekly(daily))
    mid_2023 = weeks.loc["2023-06-05"]
    assert mid_2023["soil_wet"] == pytest.approx(0.3)
    assert mid_2023["soil_wet_anom"] == pytest.approx(-0.2)
    assert weeks.loc["2024-06-03", "soil_wet_anom"] == pytest.approx(0.0)


def test_nodes_are_fetched_once_and_then_read_from_the_cache(tmp_path):
    cells = ["8481a1bffffffff"]
    fetch = FakePower()
    first = power.build(cells, date(2000, 3, 1), tmp_path, fetch=fetch, pause=0)
    again = power.build(cells, date(2000, 3, 1), tmp_path, fetch=FakePower(), pause=0)
    assert len(fetch.calls) == 1
    assert list(first.columns) == ["cell", "week", *power.COLUMNS]
    pd.testing.assert_frame_equal(first, again)
    query = parse_qs(urlparse(fetch.calls[0]).query)
    assert query["start"] == ["19910101"] and query["end"] == ["20000301"]


def _history(weeks: pd.DatetimeIndex, cells: list[str], dry: dict) -> pd.DataFrame:
    """Fire follows the soil of the week before: dry weeks burn, the rest do not."""
    rows = []
    for cell in cells:
        for i, week in enumerate(weeks):
            prev = weeks[i - 1] if i else week
            rows.append(
                {"cell": cell, "week": week, "harmonized_n": 8.0 if dry[(cell, prev)] else 0.0}
            )
    return pd.DataFrame(rows)


def test_forecast_uses_the_weather_and_learns_from_it_when_it_explains_the_fire():
    rng = np.random.default_rng(0)
    cells = ["8481a1bffffffff", "8481a13ffffffff", "8481a17ffffffff"]
    weeks = pd.date_range("2010-01-04", "2018-12-31", freq="7D")
    dry = {(c, w): bool(rng.random() < 0.3) for c in cells for w in weeks}
    harmonized = _history(weeks, cells, dry)
    conditions = pd.DataFrame(
        [
            {
                "cell": c,
                "week": w,
                "soil_wet": 0.5,
                "soil_wet_anom": 0.0,
                "hdw_week": 120.0 if dry[(c, w)] else 20.0,
                "hdw_anom": 60.0 if dry[(c, w)] else -20.0,
            }
            for c in cells
            for w in weeks
        ]
    )
    choice = pipeline.fit_forecast(harmonized, conditions)
    assert choice.chosen == "history+weather"
    assert set(choice.comparison) == {"history", "history+weather"}
    assert choice.forecaster.features == forecast.FEATURES + forecast.WEATHER
    history = choice.comparison["history"]["mae_cell_week"]
    assert choice.comparison[choice.chosen]["mae_cell_week"] < history
    payload = choice.to_json("hotspots")
    assert payload["features"]["chosen"] == choice.chosen
    assert payload["features"]["source"] == power.SOURCE
    every = pipeline.fit_forecast(harmonized, conditions, compare_all=True)
    assert set(every.comparison) == set(pipeline.FEATURE_SETS)
    assert every.chosen == "history+weather"


def test_forecast_without_conditions_uses_the_history_alone():
    cells = ["8481a1bffffffff", "8481a13ffffffff"]
    weeks = pd.date_range("2010-01-04", "2016-12-26", freq="7D")
    harmonized = _history(weeks, cells, {(c, w): w.month in (8, 9) for c in cells for w in weeks})
    choice = pipeline.fit_forecast(harmonized)
    assert choice.chosen == "history"
    assert choice.forecaster.features == forecast.FEATURES
    assert "source" not in choice.to_json("hotspots")["features"]


def test_live_forecast_rows_have_every_feature_the_trees_learned():
    cells = ["8481a1bffffffff", "8481a13ffffffff"]
    weeks = pd.date_range("2010-01-04", "2016-12-26", freq="7D")
    harmonized = _history(weeks, cells, {(c, w): w.month in (8, 9) for c in cells for w in weeks})
    examples = forecast.build_examples(forecast.weekly_series(harmonized))
    live = examples[examples["issue_week"] == examples["issue_week"].max()]
    assert live["target"].isna().all()
    assert not live[forecast.FEATURES].isna().any().any()
    # The year before of the same week, as the training rows get it.
    row = live[(live["cell"] == cells[0]) & (live["horizon"] == 1)].iloc[0]
    woy, year = int(row["woy"]), int(row["year"])
    series = forecast.weekly_series(harmonized)
    expected = series[
        (series["cell"] == cells[0]) & (series["woy"] == woy) & (series["year"] == year - 1)
    ]["y"].sum()
    assert row["climatology_prev_year"] == expected


def test_a_week_that_is_not_over_is_scaled_to_seven_days():
    harmonized = pd.DataFrame(
        {
            "cell": ["a", "a"],
            "week": pd.to_datetime(["2026-11-02", "2026-11-09"]),
            "harmonized_n": [70.0, 60.0],
        }
    )
    from datetime import date

    full = forecast.weekly_series(harmonized)
    partial = forecast.weekly_series(harmonized, last_day=date(2026, 11, 14))
    assert full["y"].tolist() == [70.0, 60.0]
    assert partial["y"].tolist() == [70.0, 70.0]  # 6 of 7 days seen
    over = forecast.weekly_series(harmonized, last_day=date(2026, 11, 15))
    assert over["y"].tolist() == [70.0, 60.0]
