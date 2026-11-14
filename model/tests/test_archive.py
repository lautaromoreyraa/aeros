import io
import urllib.error

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
