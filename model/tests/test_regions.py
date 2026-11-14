import json

import h3
import pandas as pd
import pytest

from aeros import firms, grid, pipeline, regions, synthetic

# (lat, lon) of places whose region is not in doubt. Towns on a border river
# are left out on purpose: membership is decided by the cell center, and a
# ~22 km cell around Corrientes city is centered across the Parana, in Chaco.
FILADELFIA_PY = (-22.35, -60.03)  # Paraguayan Chaco
ASUNCION = (-25.28, -57.63)  # inside the Humid Chaco ecoregion too
MERCEDES_CTES = (-29.18, -58.08)
CIUDAD_DEL_ESTE = (-25.51, -54.61)  # eastern Paraguay, Atlantic forest
BUENOS_AIRES = (-34.60, -58.38)


def _cell(point):
    return h3.latlng_to_cell(*point, 4)


def test_every_region_ships_an_outline_with_its_source():
    for region_id in regions.REGION_IDS:
        region = regions.load(region_id)
        assert region.source and region.license
        assert len(region.cells(4)) > 20


@pytest.mark.parametrize(
    ("point", "inside"),
    [
        (FILADELFIA_PY, {"gran-chaco", "paraguay"}),
        (ASUNCION, {"gran-chaco", "paraguay"}),
        (MERCEDES_CTES, {"corrientes"}),
        (CIUDAD_DEL_ESTE, {"paraguay"}),
        (BUENOS_AIRES, set()),
    ],
)
def test_known_places_fall_in_the_right_regions(point, inside):
    found = {r for r in regions.REGION_IDS if _cell(point) in regions.load(r).cells(4)}
    assert found == inside


def test_unknown_region_is_an_error():
    with pytest.raises(ValueError):
        regions.parse("patagonia")
    assert [r.id for r in regions.parse("all")] == list(regions.REGION_IDS)


def _detections(points):
    raw = pd.DataFrame(
        {
            "latitude": [p[0] for p in points],
            "longitude": [p[1] for p in points],
            "acq_date": "2020-08-03",
            "acq_time": "1730",
            "satellite": "N",
            "frp": 5.0,
            "type": 0,
        }
    )
    return firms.normalize(raw, "VIIRS")


def test_clip_keeps_regions_and_their_border_ring_only():
    corrientes = regions.load("corrientes")
    inside = corrientes.cells(4)
    outside = next(n for c in sorted(inside) for n in h3.grid_disk(c, 1) if n not in inside)
    ring_point = h3.cell_to_latlng(outside)
    det = _detections([MERCEDES_CTES, ring_point, BUENOS_AIRES, FILADELFIA_PY])
    out = regions.clip(det, [corrientes], 4)
    assert set(out["cell"]) == {_cell(MERCEDES_CTES), outside}


def test_run_reports_each_region_from_one_translator(tmp_path):
    archive = synthetic.generate(
        start="2010-01-04", end="2016-12-26", bbox=(-60.5, -23.0, -59.5, -22.0), seed=3
    )
    det = pd.concat(
        [firms.normalize(archive.modis, "MODIS"), firms.normalize(archive.viirs, "VIIRS")],
        ignore_index=True,
    )
    chosen = regions.parse("gran-chaco,paraguay")
    result = pipeline.run(det, tmp_path, split_year=2014, study_regions=chosen)

    assert json.loads((tmp_path / "regions.json").read_text())[0]["id"] == "gran-chaco"
    for region in chosen:
        meta = json.loads((tmp_path / region.id / "meta.json").read_text())
        assert meta["region"]["id"] == region.id
        assert meta["model"] == result.translator_name
        cells = pd.read_parquet(tmp_path / region.id / "harmonized_cells.parquet")
        assert set(cells["cell"]) <= region.cells(4)
        calendar = json.loads((tmp_path / region.id / "calendar_region.json").read_text())
        total = sum(r["harmonized"] or 0 for r in calendar)
        assert total == pytest.approx(cells["harmonized_n"].sum(), rel=1e-6)
    assert grid.DEFAULT_RESOLUTION == 4


def test_load_many_clips_each_file_before_joining(tmp_path):
    path = tmp_path / "fire_archive_M-C61_1.csv"
    path.write_text(
        "latitude,longitude,acq_date,acq_time,satellite,frp,type\n"
        f"{MERCEDES_CTES[0]},{MERCEDES_CTES[1]},2020-08-03,1730,Terra,5.0,0\n"
        f"{BUENOS_AIRES[0]},{BUENOS_AIRES[1]},2020-08-03,1730,Terra,5.0,0\n"
    )
    study = regions.parse("corrientes")
    det = firms.load_many([path], keep=lambda d: regions.clip(d, study, 4))
    assert det["latitude"].tolist() == [MERCEDES_CTES[0]]
