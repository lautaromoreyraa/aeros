from datetime import UTC, datetime, timedelta

import h5py
import numpy as np

from aeros import goes

PROJECTION = {
    "semi_major_axis": 6378137.0,
    "semi_minor_axis": 6356752.31414,
    "perspective_point_height": 35786023.0,
    "longitude_of_projection_origin": -75.0,
}


def test_the_sub_satellite_point_is_on_the_equator_under_the_satellite():
    lat, lon = goes.geolocate(np.array([0.0]), np.array([0.0]), PROJECTION)
    assert abs(lat[0]) < 1e-9 and abs(lon[0] + 75.0) < 1e-9


def test_scan_angles_south_and_east_land_south_and_east():
    lat, lon = goes.geolocate(np.array([0.02]), np.array([-0.04]), PROJECTION)
    assert lat[0] < -10 and lon[0] > -75


def test_scan_start_reads_the_file_name():
    name = "OR_ABI-L2-FDCF-M6_G19_s20263182050208_e20263182059516_c20263182100003.nc"
    assert goes.scan_start(name) == datetime(2026, 11, 14, 20, 50, 20, tzinfo=UTC)


def test_latest_scans_looks_back_an_hour_when_the_current_one_is_empty():
    keys = {
        "ABI-L2-FDCF/2026/318/19/": [
            "ABI-L2-FDCF/2026/318/19/OR_ABI-L2-FDCF-M6_G19_s20263181940208_e1_c1.nc",
            "ABI-L2-FDCF/2026/318/19/OR_ABI-L2-FDCF-M6_G19_s20263181950208_e1_c1.nc",
        ]
    }
    scans = goes.latest_scans(
        datetime(2026, 11, 14, 20, 1, tzinfo=UTC), 2, lambda p: keys.get(p, [])
    )
    assert [s.start.minute for s in scans] == [50, 40]


def _fake_scan(path, mask):
    with h5py.File(path, "w") as f:
        f["Mask"] = mask.astype(np.int16)
        f["Power"] = np.where(mask > 0, 50.0, -9.0).astype(np.float32)
        f["Power"].attrs["_FillValue"] = np.array([-9.0], dtype=np.float32)
        n = mask.shape[0]
        f["x"] = np.arange(n, dtype=np.int16)
        f["x"].attrs["scale_factor"] = np.array([0.01], dtype=np.float32)
        f["x"].attrs["add_offset"] = np.array([-0.02], dtype=np.float32)
        f["y"] = np.arange(n, dtype=np.int16)
        f["y"].attrs["scale_factor"] = np.array([-0.01], dtype=np.float32)
        f["y"].attrs["add_offset"] = np.array([0.02], dtype=np.float32)
        f["goes_imager_projection"] = np.int32(0)
        for k, v in PROJECTION.items():
            f["goes_imager_projection"].attrs[k] = np.array([v])
        start = datetime(2026, 11, 14, 20, 50, tzinfo=UTC) - goes.J2000
        f["time_bounds"] = np.array([start.total_seconds(), start.total_seconds() + 590])


def test_decode_keeps_fire_pixels_in_the_area_and_marks_the_confident_ones(tmp_path):
    mask = np.full((5, 5), 100)  # processed, no fire
    mask[4, 3] = 10  # good fire pixel, south-east of the sub-satellite point
    mask[4, 4] = 15  # low probability
    mask[0, 0] = 30  # temporally filtered good pixel, north-west
    path = tmp_path / "scan.nc"
    _fake_scan(path, mask)

    everything = goes.decode(path, (-180, -90, 180, 90))
    south_east = goes.decode(path, (-75, -90, 0, 0))

    assert len(everything) == 3
    assert set(south_east["category"]) == {"good", "low_probability"}
    assert south_east["confident"].tolist().count(True) == 1
    assert south_east["scan_start"].iloc[0] == datetime(2026, 11, 14, 20, 50, tzinfo=UTC)
    summary = goes.summarize(south_east, 4, "-75,-90,0,0", datetime(2026, 11, 14, 21, tzinfo=UTC))
    assert summary["pixels"] == 2 and summary["confident_pixels"] == 1
    assert sum(c["pixels"] for c in summary["cells"]) == 2


def test_summary_of_an_empty_scan_has_no_cells():
    import pandas as pd

    summary = goes.summarize(pd.DataFrame(), 4, "-69,-35,-53,-16", datetime.now(UTC) - timedelta(0))
    assert summary["cells"] == [] and summary["pixels"] == 0
