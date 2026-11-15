import json

import pytest

from aeros import cli, publish


def _run(root, regions, unit_tag, sectors_for=()):
    root.mkdir(parents=True)
    (root / "regions.json").write_text(json.dumps([{"id": r, "name": r.title()} for r in regions]))
    for r in regions:
        d = root / r
        d.mkdir()
        for name in publish.ARTIFACTS:
            (d / name).write_text(json.dumps({"region": r, "unit": unit_tag, "file": name}))
        (d / "harmonized_cells.parquet").write_bytes(b"not for the web")
        if r in sectors_for:
            (d / "sectors.json").write_text(json.dumps([{"id": "dry-chaco", "cells": []}]))
    return root


def test_bundle_lays_out_regions_units_sectors_and_the_legacy_path(tmp_path):
    hot = _run(tmp_path / "hot", ["gran-chaco", "paraguay"], "hotspots", {"gran-chaco"})
    days = _run(tmp_path / "days", ["gran-chaco", "paraguay"], "cell_days")
    out = tmp_path / "public"

    index = publish.bundle({"hotspots": hot, "cell_days": days}, out)

    assert index["default_region"] == "gran-chaco"
    assert index["units"] == ["cell_days", "hotspots"]
    gran = next(r for r in index["regions"] if r["id"] == "gran-chaco")
    assert gran["sectors"] is True and sorted(gran["units"]) == ["cell_days", "hotspots"]
    assert (
        json.loads((out / "paraguay" / "cell_days" / "meta.json").read_text())["unit"]
        == "cell_days"
    )
    assert (out / "gran-chaco" / "sectors.json").exists()
    # the path the app read before regions existed serves the default region
    legacy = json.loads((out / "hotspots" / "calendar_region.json").read_text())
    assert legacy == {"region": "gran-chaco", "unit": "hotspots", "file": "calendar_region.json"}
    # Parquet tables never reach the static site
    assert not list(out.rglob("*.parquet"))
    assert json.loads((out / "regions.json").read_text()) == index
    root_forecast = json.loads((out / "forecast.json").read_text())
    assert root_forecast == {"region": "gran-chaco", "unit": "hotspots", "file": "forecast.json"}


def test_bundle_refuses_a_region_without_its_calendar(tmp_path):
    run = _run(tmp_path / "hot", ["gran-chaco"], "hotspots")
    (run / "gran-chaco" / "cells_monthly.json").unlink()
    with pytest.raises(FileNotFoundError):
        publish.bundle({"hotspots": run}, tmp_path / "public")


def test_cli_publish_rejects_an_unknown_unit(tmp_path):
    with pytest.raises(SystemExit):
        cli.main(["publish", "--run", f"pixels={tmp_path}", "--out", str(tmp_path / "o")])
