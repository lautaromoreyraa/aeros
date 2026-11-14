from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest

import refresh
from refresh import RefreshError, Settings

KEY = "abcdef0123456789abcdef0123456789"
TODAY = date(2026, 11, 14)
NOW = datetime(2026, 11, 14, 6, 0, tzinfo=UTC)
HEADER = b"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,frp\n"


def settings(**overrides) -> Settings:
    base = dict(
        bucket="data-bucket",
        prefix="raw/firms/",
        map_key_parameter="/aeros/firms/map-key",
        area="-74,-56,-53,-21",
        sources=("MODIS_NRT", "VIIRS_SNPP_NRT"),
        days_back=2,
    )
    base.update(overrides)
    return Settings(**base)


class FakeS3:
    def __init__(self):
        self.objects: dict[str, dict] = {}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs


class FakeSsm:
    def __init__(self, value: str):
        self.value = value
        self.asked: list[tuple[str, bool]] = []

    def get_parameter(self, Name: str, WithDecryption: bool):  # noqa: N803 (boto3 signature)
        self.asked.append((Name, WithDecryption))
        return {"Parameter": {"Name": Name, "Type": "SecureString", "Value": self.value}}


def csv_with(rows: int) -> bytes:
    line = b"-30.1,-60.2,330.1,0.4,0.4,2026-11-12,0412,N,5.2\n"
    return HEADER + line * rows


def run(fetch, secret=KEY, early_warning=None, **overrides):
    s3 = FakeS3()
    ssm = FakeSsm(secret)
    summary = refresh.handler(
        {},
        None,
        settings=settings(**overrides),
        s3=s3,
        ssm=ssm,
        fetch=fetch,
        now=NOW,
        early_warning=early_warning,
    )
    return summary, s3, ssm


def test_one_file_per_source_and_day_named_for_the_pipeline():
    urls = []

    def fetch(url):
        urls.append(url)
        return csv_with(3)

    summary, s3, ssm = run(fetch)
    assert ssm.asked == [("/aeros/firms/map-key", True)]
    assert sorted(s3.objects) == [
        "raw/firms/nrt/2026-11-12/fire_nrt_m-c61_2026-11-12.csv",
        "raw/firms/nrt/2026-11-12/fire_nrt_sv-c2_2026-11-12.csv",
        "raw/firms/nrt/2026-11-13/fire_nrt_m-c61_2026-11-13.csv",
        "raw/firms/nrt/2026-11-13/fire_nrt_sv-c2_2026-11-13.csv",
    ]
    assert f"/api/area/csv/{KEY}/VIIRS_SNPP_NRT/-74,-56,-53,-21/1/2026-11-13" in urls[-1]
    stored = s3.objects["raw/firms/nrt/2026-11-13/fire_nrt_sv-c2_2026-11-13.csv"]
    assert stored["Bucket"] == "data-bucket"
    assert stored["ContentType"] == "text/csv"
    assert stored["Body"] == csv_with(3)
    assert [w["detections"] for w in summary["written"]] == [3, 3, 3, 3]
    assert summary["failed"] == []


def test_file_names_are_recognised_by_the_model():
    # Mirror of aeros.sensors.FILE_PREFIXES for the NRT products.
    model_prefixes = {
        "fire_nrt_m-c61": "MODIS",
        "fire_nrt_sv-c2": "VIIRS",
        "fire_nrt_j1v-c2": "VIIRS",
        "fire_nrt_j2v-c2": "VIIRS",
    }
    for source, prefix in refresh.FILE_PREFIX.items():
        assert prefix in model_prefixes
        assert model_prefixes[prefix] == ("MODIS" if source.startswith("MODIS") else "VIIRS")


def test_empty_day_is_still_stored():
    summary, s3, _ = run(lambda url: HEADER, sources=("MODIS_NRT",), days_back=1)
    assert list(s3.objects) == ["raw/firms/nrt/2026-11-13/fire_nrt_m-c61_2026-11-13.csv"]
    assert summary["written"][0]["detections"] == 0


def test_json_secret_is_accepted():
    _, s3, _ = run(lambda url: csv_with(1), secret=json.dumps({"MAP_KEY": KEY}), days_back=1)
    assert len(s3.objects) == 2


@pytest.mark.parametrize("secret", ["", "   ", '{"other": "x"}', "short", "has spaces in it!"])
def test_malformed_secret_fails_before_any_request(secret):
    def fetch(url):
        raise AssertionError("must not call FIRMS without a valid key")

    with pytest.raises(RefreshError, match="MAP_KEY"):
        run(fetch, secret=secret)


def test_a_failing_source_does_not_block_the_others():
    def fetch(url):
        if "MODIS_NRT" in url:
            return b"Invalid MAP_KEY."
        return csv_with(2)

    summary, s3, _ = run(fetch, days_back=1)
    assert list(s3.objects) == ["raw/firms/nrt/2026-11-13/fire_nrt_sv-c2_2026-11-13.csv"]
    assert summary["failed"][0]["source"] == "MODIS_NRT"
    assert "Invalid MAP_KEY" in summary["failed"][0]["error"]


def test_everything_failing_raises_so_eventbridge_retries():
    with pytest.raises(RefreshError):
        run(lambda url: b"Exceeding allowed transaction limit")


def test_errors_never_carry_the_key():
    def fetch(url):
        return f"error for {KEY}".encode()

    with pytest.raises(RefreshError) as info:
        run(fetch, days_back=1)
    assert KEY not in str(info.value)


def test_http_failure_is_reported_without_url(monkeypatch):
    import urllib.error

    def boom(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)

    monkeypatch.setattr(refresh.urllib.request, "urlopen", boom)
    with pytest.raises(RefreshError) as info:
        refresh._http_get(refresh.firms_url(KEY, "MODIS_NRT", "0,0,1,1", TODAY))
    assert "503" in str(info.value)
    assert KEY not in str(info.value)


def test_settings_from_environment(monkeypatch):
    monkeypatch.setenv("DATA_BUCKET", "b")
    monkeypatch.setenv("RAW_PREFIX", "raw/firms")
    monkeypatch.setenv("FIRMS_MAP_KEY_PARAMETER", "/aeros/firms/map-key")
    monkeypatch.setenv("FIRMS_AREA", "-74, -56, -53, -21")
    monkeypatch.setenv("FIRMS_SOURCES", "MODIS_NRT, VIIRS_NOAA21_NRT")
    monkeypatch.setenv("FIRMS_DAYS_BACK", "3")
    s = Settings.from_environment()
    assert s.prefix == "raw/firms/"
    assert s.area == "-74,-56,-53,-21"
    assert s.sources == ("MODIS_NRT", "VIIRS_NOAA21_NRT")
    assert s.days_back == 3


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("FIRMS_SOURCES", "MODIS_NRT,LANDSAT"),
        ("FIRMS_AREA", "world"),
        ("FIRMS_DAYS_BACK", "11"),
    ],
)
def test_bad_settings_are_rejected(monkeypatch, name, value):
    monkeypatch.setenv("DATA_BUCKET", "b")
    monkeypatch.setenv("FIRMS_MAP_KEY_PARAMETER", "/p")
    monkeypatch.setenv("FIRMS_AREA", "-74,-56,-53,-21")
    monkeypatch.setenv("FIRMS_SOURCES", "MODIS_NRT")
    monkeypatch.setenv(name, value)
    with pytest.raises(RefreshError):
        Settings.from_environment()


def test_early_warning_runs_on_this_runs_downloads_and_is_published():
    seen = {}

    def early_warning(downloads, days, now):
        seen.update(downloads=downloads, days=days, now=now)
        return {"days_with_data": [d.isoformat() for d in days], "cells": [{"cell": "x"}]}

    summary, s3, _ = run(
        lambda url: csv_with(1),
        early_warning=early_warning,
        sources=("VIIRS_NOAA20_NRT",),
        days_back=7,
        early_warning_key="derived/early_warning.json",
    )
    assert seen["days"] == [date(2026, 11, d) for d in range(7, 14)]
    assert ("VIIRS_NOAA20_NRT", date(2026, 11, 13)) in seen["downloads"]
    published = s3.objects["derived/early_warning.json"]
    assert published["ContentType"] == "application/json"
    assert json.loads(published["Body"])["cells"] == [{"cell": "x"}]
    assert summary["early_warning"]["flagged_cells"] == 1


def test_early_warning_failure_keeps_the_downloads():
    def broken(downloads, days, now):
        raise LookupError("harmonized_cells.parquet missing")

    summary, s3, _ = run(
        lambda url: csv_with(1),
        early_warning=broken,
        sources=("VIIRS_NOAA20_NRT",),
        days_back=7,
        early_warning_key="derived/early_warning.json",
    )
    assert summary["early_warning"] == "failed"
    assert "derived/early_warning.json" not in s3.objects
    assert len(s3.objects) == 7


def test_early_warning_needs_a_full_window(monkeypatch):
    monkeypatch.setenv("DATA_BUCKET", "b")
    monkeypatch.setenv("FIRMS_MAP_KEY_PARAMETER", "/p")
    monkeypatch.setenv("FIRMS_AREA", "-74,-56,-53,-21")
    monkeypatch.setenv("FIRMS_SOURCES", "VIIRS_NOAA20_NRT")
    monkeypatch.setenv("FIRMS_DAYS_BACK", "3")
    monkeypatch.setenv("EARLY_WARNING_KEY", "derived/early_warning.json")
    with pytest.raises(RefreshError, match="FIRMS_DAYS_BACK"):
        Settings.from_environment()
