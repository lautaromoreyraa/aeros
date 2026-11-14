from __future__ import annotations

import base64
import csv
import io
import json

import pytest

from aeros_api.handler import handler
from aeros_api.store import HOTSPOT_COLUMNS
from tests.conftest import CELL_A, CELL_B, CELL_C, RESOLUTION, area_around, event


def call(store, path: str, body, **kwargs) -> dict:
    return handler(event(path, body, **kwargs), None, store_factory=lambda: store)


def body(response: dict) -> dict:
    return json.loads(response["body"])


def by_month(months: list[dict]) -> dict[tuple[int, int], dict]:
    return {(m["year"], m["month_of_year"]): m for m in months}


class TestCalendar:
    def test_sums_area_cells_with_interval_and_anomaly(self, store):
        response = call(
            store,
            "/calendar",
            {"area": area_around(CELL_A, CELL_B), "start": "2000-01", "end": "2003-12"},
        )
        assert response["statusCode"] == 200
        payload = body(response)
        assert payload["area"] == {"cells": 2, "resolution": RESOLUTION}
        assert payload["unit"] == "VIIRS-equivalent hotspots"
        months = by_month(payload["months"])
        assert list(months) == [(2000, 1), (2001, 1), (2001, 2), (2002, 1), (2003, 1)]

        jan01 = months[(2001, 1)]
        # variance 1 + 3 independent, shared sd 0.5 + 0.5 added linearly -> 4 + 1.
        # half width = 1.6448536 * sqrt(5) = 3.678
        assert jan01 == {
            "year": 2001,
            "month_of_year": 1,
            "harmonized": 5.0,
            "low": 1.322,
            "high": 8.678,
            "stacked_raw": 1.0,
            "unattached": 3.0,
            "source": "modeled_terra",
            "median_same_month": 8.0,  # median of 2002 (10) and 2003 (6)
            "anomaly": -3.0,
            "anomaly_ratio": 0.625,
        }
        assert months[(2002, 1)]["median_same_month"] == 5.5
        assert months[(2002, 1)]["anomaly"] == 4.5
        assert months[(2002, 1)]["low"] == months[(2002, 1)]["high"] == 10.0
        assert months[(2003, 1)]["anomaly"] == -1.5

    def test_pre_terra_month_has_no_value_but_keeps_reference(self, store):
        payload = body(
            call(
                store,
                "/calendar",
                {"area": area_around(CELL_A, CELL_B), "start": "2000-01", "end": "2000-01"},
            )
        )
        [month] = payload["months"]
        assert month["harmonized"] is None
        assert month["low"] is None and month["high"] is None
        assert month["anomaly"] is None and month["anomaly_ratio"] is None
        assert month["median_same_month"] == 6.0

    def test_range_trims_output_but_not_the_reference_years(self, store):
        payload = body(
            call(
                store,
                "/calendar",
                {"area": area_around(CELL_A, CELL_B), "start": "2001-01", "end": "2002-12"},
            )
        )
        months = by_month(payload["months"])
        assert list(months) == [(2001, 1), (2001, 2), (2002, 1)]
        # 2003 is outside the range but still part of January's median.
        assert months[(2001, 1)]["median_same_month"] == 8.0

    def test_source_tie_goes_to_alphabetically_first(self, store):
        payload = body(
            call(
                store,
                "/calendar",
                {"area": area_around(CELL_A, CELL_B), "start": "2001-02", "end": "2001-02"},
            )
        )
        [feb] = payload["months"]
        assert feb["source"] == "modeled_terra"
        assert feb["harmonized"] == 3.0
        assert (feb["low"], feb["high"]) == (2.178, 3.822)
        assert feb["median_same_month"] is None

    def test_single_cell_area(self, store):
        months = by_month(
            body(
                call(
                    store,
                    "/calendar",
                    {"area": area_around(CELL_C), "start": "2001-01", "end": "2001-01"},
                )
            )["months"]
        )
        assert months[(2001, 1)]["harmonized"] == 100.0

    def test_area_smaller_than_a_cell_falls_back_to_touched_cell(self, store):
        payload = body(
            call(
                store,
                "/calendar",
                {
                    "area": area_around(CELL_C, pad=0.0001),
                    "start": "2001-01",
                    "end": "2001-01",
                },
            )
        )
        assert payload["area"]["cells"] == 1

    def test_area_without_data_returns_empty_calendar(self, store):
        ring = [[10.0, 10.0], [10.5, 10.0], [10.5, 10.5], [10.0, 10.5], [10.0, 10.0]]
        payload = body(
            call(
                store,
                "/calendar",
                {
                    "area": {"type": "Polygon", "coordinates": [ring]},
                    "start": "2001-01",
                    "end": "2001-12",
                },
            )
        )
        assert payload["months"] == []

    def test_feature_and_base64_body_are_accepted(self, store):
        raw = json.dumps(
            {
                "area": {"type": "Feature", "geometry": area_around(CELL_A, CELL_B)},
                "start": "2003-01",
                "end": "2003-01",
            }
        )
        request = event("/calendar", base64.b64encode(raw.encode()).decode())
        request["isBase64Encoded"] = True
        response = handler(request, None, store_factory=lambda: store)
        assert response["statusCode"] == 200
        assert body(response)["months"][0]["harmonized"] == 6.0

    def test_area_over_cell_limit_is_rejected(self, store, monkeypatch):
        monkeypatch.setenv("MAX_CELLS", "1")
        response = call(
            store,
            "/calendar",
            {"area": area_around(CELL_A, CELL_B), "start": "2001-01", "end": "2001-12"},
        )
        assert response["statusCode"] == 400
        assert "limit is 1" in body(response)["error"]


class TestHotspotsCsv:
    def read(self, response: dict) -> list[dict]:
        return list(csv.DictReader(io.StringIO(response["body"])))

    def test_filters_by_area_and_inclusive_dates(self, store):
        response = call(
            store,
            "/hotspots.csv",
            {"area": area_around(CELL_A, CELL_B), "start": "2002-01-01", "end": "2003-01"},
        )
        assert response["statusCode"] == 200
        assert response["headers"]["content-type"].startswith("text/csv")
        assert response["headers"]["x-aeros-truncated"] == "false"
        assert (
            "aeros_hotspots_2002-01-01_2003-01-31.csv" in response["headers"]["content-disposition"]
        )
        assert response["body"].splitlines()[0] == ",".join(HOTSPOT_COLUMNS)
        rows = self.read(response)
        assert [(r["acq_datetime"], r["platform"]) for r in rows] == [
            ("2002-01-08T04:10:00Z", "AQUA"),
            ("2002-01-08T04:10:00Z", "SNPP"),
            ("2003-01-31T23:59:00Z", "SNPP"),
        ]
        assert {r["cell"] for r in rows} == {CELL_A, CELL_B}
        assert [r["harmonized_weight"] for r in rows] == ["0.0", "1.0", "1.0"]
        assert rows[2]["is_vegetation"] == "false"

    def test_truncation_is_flagged(self, store, monkeypatch):
        monkeypatch.setenv("MAX_CSV_ROWS", "2")
        response = call(
            store,
            "/hotspots.csv",
            {"area": area_around(CELL_A, CELL_B), "start": "2001-01", "end": "2003-12"},
        )
        assert response["headers"]["x-aeros-truncated"] == "true"
        assert len(self.read(response)) == 2

    def test_exact_limit_is_not_truncated(self, store, monkeypatch):
        monkeypatch.setenv("MAX_CSV_ROWS", "5")
        response = call(
            store,
            "/hotspots.csv",
            {"area": area_around(CELL_A, CELL_B), "start": "2001-01", "end": "2003-12"},
        )
        assert response["headers"]["x-aeros-truncated"] == "false"
        assert len(self.read(response)) == 5


class TestErrors:
    @pytest.mark.parametrize(
        "payload",
        [
            None,
            "not json",
            "[]",
            {"start": "2001-01", "end": "2001-02"},
            {
                "area": {"type": "Point", "coordinates": [0, 0]},
                "start": "2001-01",
                "end": "2001-02",
            },
            {
                "area": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0.5]]]},
                "start": "2001-01",
                "end": "2001-02",
            },
            {
                "area": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [200, 1], [0, 0]]]},
                "start": "2001-01",
                "end": "2001-02",
            },
            {
                "area": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [True, 1], [0, 0]]]},
                "start": "2001-01",
                "end": "2001-02",
            },
            {"area": area_around(CELL_A), "start": "2001-13", "end": "2002-01"},
            {"area": area_around(CELL_A), "start": "2002-01", "end": "2001-01"},
            {"area": area_around(CELL_A), "start": "2001-02-30", "end": "2002-01"},
        ],
    )
    def test_bad_requests_are_400(self, store, payload):
        response = call(store, "/calendar", payload)
        assert response["statusCode"] == 400
        assert body(response)["error"]

    def test_unknown_route_is_404(self, store):
        assert call(store, "/calendar", {}, method="GET")["statusCode"] == 404
        assert call(store, "/other", {})["statusCode"] == 404

    def test_internal_errors_do_not_leak(self, store):
        class Broken:
            def resolution(self):
                raise RuntimeError("s3://secret-bucket/key exploded")

        response = handler(
            event(
                "/calendar",
                {"area": area_around(CELL_A), "start": "2001-01", "end": "2001-02"},
            ),
            None,
            store_factory=lambda: Broken(),
        )
        assert response["statusCode"] == 500
        assert "secret-bucket" not in response["body"]
