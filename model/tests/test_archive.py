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
