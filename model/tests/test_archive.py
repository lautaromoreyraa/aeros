import io
import threading
import urllib.error
from datetime import date, timedelta

import pytest

from aeros import archive, sensors


def test_plan_starts_each_product_at_its_first_year():
    files = archive.plan(["Paraguay"], last_year=2019)
    years = {p: sorted(f.year for f in files if f.product == p) for p in archive.FIRST_YEAR}
    assert years["modis"][0] == 2000
    assert years["viirs-snpp"][0] == 2012
    assert years["viirs-jpss1"] == [2018, 2019]
    assert all(f.year <= 2019 for f in files)


def test_file_names_are_the_ones_the_loader_recognizes():
    f = archive.ArchiveFile("viirs-jpss1", 2024, "Argentina")
    assert f.url == f"{archive.BASE_URL}/viirs-jpss1/2024/viirs-jpss1_2024_Argentina.csv"
    assert sensors.instrument_from_filename(f.name) == "VIIRS"


def test_download_skips_present_files_and_reports_unpublished_ones(tmp_path):
    files = archive.plan(["Bolivia"], last_year=2000, products=["modis"]) + [
        archive.ArchiveFile("modis", 2001, "Bolivia"),
        archive.ArchiveFile("modis", 2002, "Bolivia"),
    ]
    (tmp_path / files[0].name).write_text("kept")
    requested = []

    def opener(url):
        requested.append(url)
        if "2002" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
        return io.BytesIO(b"latitude,longitude\n")

    report = archive.download(files, tmp_path, opener)

    assert report == {
        "downloaded": ["modis_2001_Bolivia.csv"],
        "present": ["modis_2000_Bolivia.csv"],
        "missing": ["modis_2002_Bolivia.csv"],
    }
    assert len(requested) == 2
    assert (tmp_path / files[0].name).read_text() == "kept"
    assert not list(tmp_path.glob("*.part"))


def test_download_raises_on_server_errors(tmp_path):
    def opener(url):
        raise urllib.error.HTTPError(url, 503, "Unavailable", None, None)

    with pytest.raises(urllib.error.HTTPError):
        archive.download([archive.ArchiveFile("modis", 2000, "Paraguay")], tmp_path, opener)
    assert not list(tmp_path.iterdir())


def test_download_fetches_several_files_at_once(tmp_path):
    # Fails with BrokenBarrierError if the files are requested one after another.
    barrier = threading.Barrier(3, timeout=5)

    def opener(url):
        barrier.wait()
        return io.BytesIO(b"latitude,longitude\n")

    files = archive.plan(["Paraguay"], last_year=2002, products=["modis"])
    report = archive.download(files, tmp_path, opener, workers=3)
    assert sorted(report["downloaded"]) == sorted(f.name for f in files)


AVAILABLE = {
    "MODIS_SP": (date(2000, 11, 1), date(2026, 8, 31)),
    "MODIS_NRT": (date(2026, 9, 1), date(2026, 11, 14)),
    "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 7, 31)),
    "VIIRS_SNPP_NRT": (date(2026, 8, 1), date(2026, 11, 2)),
    "VIIRS_NOAA20_SP": (date(2018, 4, 1), date(2026, 7, 31)),
    "VIIRS_NOAA20_NRT": (date(2026, 8, 1), date(2026, 11, 14)),
    "VIIRS_NOAA21_SP": (date(2023, 3, 1), date(2026, 7, 31)),
    "VIIRS_NOAA21_NRT": (date(2026, 8, 1), date(2026, 11, 14)),
}


def _days(requests):
    return [r.start + timedelta(days=i) for r in requests for i in range(r.days)]


def test_recent_plan_takes_each_day_from_one_processing_level_only():
    requests = archive.recent_plan(
        AVAILABLE, archive.STUDY_AREA, date(2026, 1, 1), date(2026, 11, 14)
    )
    assert all(r.days <= archive.MAX_DAYS for r in requests)
    for (sp, _), (nrt, _) in archive.RECENT_SOURCES:
        sp_days = _days([r for r in requests if r.source == sp])
        nrt_days = _days([r for r in requests if r.source == nrt])
        assert len(set(sp_days)) == len(sp_days)
        assert not set(sp_days) & set(nrt_days)
        assert min(sp_days) == date(2026, 1, 1)
        assert max(sp_days) == AVAILABLE[sp][1]
        assert max(nrt_days) == AVAILABLE[nrt][1]
    snpp = [r for r in requests if r.source == "VIIRS_SNPP_NRT"]
    assert snpp[-1].end == date(2026, 11, 2)


def test_recent_file_names_are_the_ones_the_loader_recognizes():
    for (_, sp_prefix), (_, nrt_prefix) in archive.RECENT_SOURCES:
        for prefix in (sp_prefix, nrt_prefix):
            r = archive.AreaRequest("X", prefix, archive.STUDY_AREA, date(2026, 3, 1), 5)
            assert sensors.instrument_from_filename(r.name) in {"MODIS", "VIIRS"}


def test_recent_plan_rejects_a_malformed_area():
    with pytest.raises(ValueError):
        archive.recent_plan(AVAILABLE, "south america", date(2026, 1, 1), date(2026, 1, 5))


def test_download_recent_refreshes_unsettled_chunks_and_hides_the_key(tmp_path):
    today = date(2026, 11, 14)
    old = archive.AreaRequest("MODIS_SP", "fire_archive_m-c61", "1,2,3,4", date(2026, 1, 1), 5)
    fresh = archive.AreaRequest("MODIS_NRT", "fire_nrt_m-c61", "1,2,3,4", date(2026, 11, 13), 2)
    (tmp_path / old.name).write_text("kept")
    (tmp_path / fresh.name).write_text("stale")
    requested = []

    def opener(url):
        requested.append(url)
        return io.BytesIO(b"latitude,longitude,acq_date\n-27,-58,2026-11-13\n")

    report = archive.download_recent([old, fresh], tmp_path, "SECRET", today, opener)
    assert report == {"downloaded": [fresh.name], "present": [old.name]}
    assert (tmp_path / fresh.name).read_text().startswith("latitude")
    assert requested == [f"{archive.API_URL}/area/csv/SECRET/MODIS_NRT/1,2,3,4/2/2026-11-13"]

    def refusing(url):
        return io.BytesIO(b"Invalid MAP_KEY.")

    bad = archive.AreaRequest("MODIS_NRT", "fire_nrt_m-c61", "1,2,3,4", date(2026, 11, 1), 5)
    with pytest.raises(archive.FirmsApiError) as error:
        archive.download_recent([bad], tmp_path, "SECRET", today, refusing)
    assert "SECRET" not in str(error.value)
    assert not (tmp_path / bad.name).exists()


class _Response(io.BytesIO):
    """A response whose server announced more bytes than arrived."""

    def __init__(self, body: bytes, declared: int):
        super().__init__(body)
        self.headers = {"Content-Length": str(declared)}


def test_download_rejects_a_transfer_that_ends_early_and_keeps_nothing(tmp_path):
    f = archive.ArchiveFile("modis", 2001, "Bolivia")

    def opener(url):
        return _Response(b"latitude,longitude\n-18.8,-6", declared=1000)

    with pytest.raises(archive.IncompleteDownload):
        archive.download([f], tmp_path, opener)

    assert list(tmp_path.iterdir()) == []


def test_download_accepts_a_transfer_that_matches_its_declared_size(tmp_path):
    f = archive.ArchiveFile("modis", 2001, "Bolivia")
    body = b"latitude,longitude\n-18.8,-60.1\n"

    report = archive.download([f], tmp_path, lambda url: _Response(body, declared=len(body)))

    assert report["downloaded"] == [f.name]
    assert (tmp_path / f.name).read_bytes() == body


def test_recent_plan_fetches_noaa21_from_the_area_api_when_it_lists_it():
    available = {"VIIRS_NOAA21_NRT": (date(2025, 1, 1), date(2026, 11, 12))}

    requests = archive.recent_plan(
        available, archive.STUDY_AREA, date(2026, 11, 1), date(2026, 11, 10)
    )

    assert {r.prefix for r in requests} == {"fire_nrt_j2v-c2"}
    assert [r.start for r in requests] == [date(2026, 11, 1), date(2026, 11, 6)]
    assert sensors.instrument_from_filename(requests[0].name) == "VIIRS"


def test_recent_plan_skips_noaa21_sources_the_api_does_not_list():
    available = {"VIIRS_NOAA20_NRT": (date(2025, 1, 1), date(2026, 11, 12))}

    requests = archive.recent_plan(
        available, archive.STUDY_AREA, date(2026, 11, 1), date(2026, 11, 10)
    )

    assert all("j2v" not in r.prefix for r in requests)


def test_verify_flags_files_shorter_or_longer_than_the_server(tmp_path):
    sizes = {
        "modis_2010_Argentina.csv": 10,
        "modis_2011_Argentina.csv": 10,
        "viirs-snpp_2015_Paraguay.csv": 10,
    }
    for name, size in {
        "modis_2010_Argentina.csv": 10,
        "modis_2011_Argentina.csv": 6,
        "viirs-snpp_2015_Paraguay.csv": 12,
    }.items():
        (tmp_path / name).write_bytes(b"x" * size)
    (tmp_path / "notes.csv").write_bytes(b"ignored")

    report = archive.verify([tmp_path], lambda url: sizes[url.rsplit("/", 1)[-1]])

    assert [p.rsplit("\\", 1)[-1].rsplit("/", 1)[-1] for p in report["ok"]] == [
        "modis_2010_Argentina.csv"
    ]
    assert "modis_2011_Argentina.csv (6 of 10 bytes)" in report["short"][0]
    assert "viirs-snpp_2015_Paraguay.csv (12 of 10 bytes)" in report["longer"][0]
    assert report["unknown"] == []


def test_verify_reports_unknown_when_the_server_gives_no_size(tmp_path):
    (tmp_path / "modis_2010_Bolivia.csv").write_bytes(b"x")
    report = archive.verify([tmp_path], lambda url: None)
    assert len(report["unknown"]) == 1 and not report["ok"]


def test_recent_plan_can_be_limited_to_one_platform():
    available = {
        "VIIRS_NOAA20_NRT": (date(2025, 1, 1), date(2026, 11, 12)),
        "VIIRS_NOAA21_SP": (date(2023, 3, 1), date(2026, 7, 31)),
        "VIIRS_NOAA21_NRT": (date(2025, 1, 1), date(2026, 11, 12)),
    }

    requests = archive.recent_plan(
        available, archive.STUDY_AREA, date(2026, 7, 28), date(2026, 8, 3), ("NOAA21",)
    )

    assert {r.source for r in requests} == {"VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"}
    assert requests[0].start == date(2026, 7, 28) and requests[-1].end == date(2026, 8, 3)


def test_recent_plan_rejects_an_unknown_platform():
    with pytest.raises(ValueError):
        archive.recent_plan({}, archive.STUDY_AREA, date(2026, 1, 1), date(2026, 1, 2), ("GOES",))
