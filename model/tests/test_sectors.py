import json

from aeros import cli, regions, sectors


def _region_cells():
    return regions.load(sectors.PARENT_REGION).cells(4)


def test_every_sector_loads_with_its_provenance():
    for sector_id in sectors.SECTOR_IDS:
        s = sectors.load(sector_id)
        assert s.id == sector_id
        assert s.name and s.place
        assert "RESOLVE" in s.source and "geoBoundaries" in s.source


def test_sectors_split_the_gran_chaco_without_counting_a_cell_twice():
    cells = _region_cells()
    assigned = sectors.assign(cells, 4)
    flat = [c for ids in assigned.values() for c in ids]
    assert len(flat) == len(set(flat))
    assert set(flat) <= set(cells)
    # Simplified outlines leave only a thin seam of cells out.
    assert len(flat) / len(cells) > 0.98
    assert all(assigned[s] for s in sectors.SECTOR_IDS)


def test_payload_matches_the_web_contract():
    payload = sectors.payload(_region_cells(), 4)
    assert [s["id"] for s in payload] == list(sectors.SECTOR_IDS)
    for s in payload:
        assert set(s) == {"id", "name", "place", "cells", "source", "license"}
        assert s["cells"] == sorted(s["cells"])


def test_cli_writes_sectors_json(tmp_path):
    target = tmp_path / "gran-chaco" / "sectors.json"
    assert cli.main(["sectors", "--out", str(target)]) == 0
    written = json.loads(target.read_text())
    assert {s["id"] for s in written} == set(sectors.SECTOR_IDS)
