"""GOES watch with the NOAA bucket, S3, SSM and the channels replaced by fakes."""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime, timedelta

import h3
import h5py
import numpy as np

import goes_watch
from alerts import AlertSettings
from tests.test_alerts import TOKEN, ClientError

BUCKET = "data-bucket"
PROJECTION = {
    "semi_major_axis": 6378137.0,
    "semi_minor_axis": 6356752.31414,
    "perspective_point_height": 35786023.0,
    "longitude_of_projection_origin": -75.0,
}
NOW = datetime(2026, 11, 14, 21, 5, tzinfo=UTC)
ALERT = AlertSettings(
    state_key="state/goes_alerts.json",
    web_url="https://aeros.example.org",
    region_name="Gran Chaco",
    area="-69,-35,-53,-16",
)
SETTINGS = goes_watch.Settings(
    bucket=BUCKET,
    area=(-69.0, -35.0, -53.0, -16.0),
    output_key="derived/goes_latest.json",
    cells_key="harmonized/harmonized_cells.parquet",
    alert_settings=ALERT,
)
# Scan angles (radians) that land inside the Chaco box.
X, Y = 0.04, -0.07  # about -23.8, -60.5


def _cell_at(x: float, y: float) -> str:
    lat, lon = goes_watch.geolocate(np.array([x]), np.array([y]), PROJECTION)
    return h3.latlng_to_cell(float(lat[0]), float(lon[0]), goes_watch.RESOLUTION)


STUDY = frozenset([_cell_at(X, Y)])


def scan_bytes(start: datetime, code: int | None) -> bytes:
    """A 3x3 fixed grid around (X, Y); the middle pixel carries `code`."""
    mask = np.full((3, 3), 100, dtype=np.int16)
    if code is not None:
        mask[1, 1] = code
    buffer = io.BytesIO()
    with h5py.File(buffer, "w") as f:
        f["Mask"] = mask
        f["Power"] = np.where(mask < 100, 120.0, -9.0).astype(np.float32)
        f["Power"].attrs["_FillValue"] = np.array([-9.0], dtype=np.float32)
        f["x"] = np.arange(3, dtype=np.int16)
        f["x"].attrs["scale_factor"] = np.array([1e-4], dtype=np.float32)
        f["x"].attrs["add_offset"] = np.array([X - 1e-4], dtype=np.float32)
        f["y"] = np.arange(3, dtype=np.int16)
        f["y"].attrs["scale_factor"] = np.array([-1e-4], dtype=np.float32)
        f["y"].attrs["add_offset"] = np.array([Y + 1e-4], dtype=np.float32)
        f["goes_imager_projection"] = np.int32(0)
        for k, v in PROJECTION.items():
            f["goes_imager_projection"].attrs[k] = np.array([v])
        f["time_bounds"] = np.array([(start - goes_watch.J2000).total_seconds()] * 2)
    return buffer.getvalue()


def key_for(start: datetime) -> str:
    return (
        f"ABI-L2-FDCF/{start:%Y}/{start:%j}/{start:%H}/"
        f"OR_ABI-L2-FDCF-M6_G19_s{start:%Y%j%H%M%S}0_e1_c1.nc"
    )


class Bucket:
    """The NOAA bucket: one scan every 10 minutes, the newest last."""

    def __init__(self, codes: list[int | None], now: datetime = NOW):
        self.scans = {}
        for i, code in enumerate(codes):
            start = now - timedelta(minutes=10 * (len(codes) - i))
            self.scans[key_for(start)] = scan_bytes(start, code)

    def list(self, prefix: str) -> list[str]:
        return [k for k in self.scans if k.startswith(prefix)]

    def get(self, url: str) -> bytes:
        return self.scans[url.removeprefix(goes_watch.BUCKET_URL + "/")]


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def get_object(self, Bucket: str, Key: str):  # noqa: N803 (boto3 signature)
        if Key not in self.objects:
            raise ClientError("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def json(self, key: str):
        return json.loads(self.objects[key])


class FakeSSM:
    """Only Telegram is configured; e-mail is skipped."""

    def get_parameter(self, Name: str, WithDecryption: bool = False):  # noqa: N803
        values = {ALERT.telegram_token_parameter: TOKEN, ALERT.telegram_chat_parameter: "-100"}
        if Name not in values:
            raise ClientError("ParameterNotFound")
        return {"Parameter": {"Value": values[Name]}}


def run(codes, *, bucket=None, study=STUDY, s3=None, answer=None, now=NOW, **extra):
    bucket = bucket or Bucket(codes, now)
    s3 = s3 or FakeS3()
    sent: list[dict] = []

    def post(url: str, body: dict) -> dict:
        sent.append(body)
        return answer or {"ok": True}

    def domain() -> frozenset[str]:
        if study is None:
            raise RuntimeError("no parquet")
        return frozenset(study)

    summary = goes_watch.handler(
        settings=extra.pop("settings", SETTINGS),
        s3=s3,
        ssm=FakeSSM(),
        lister=bucket.list,
        fetch=bucket.get,
        domain=domain,
        post=post,
        now=now,
        **extra,
    )
    return summary, s3, sent


def test_the_sub_satellite_point_is_under_the_satellite():
    lat, lon = goes_watch.geolocate(np.array([0.0]), np.array([0.0]), PROJECTION)
    assert abs(lat[0]) < 1e-9 and abs(lon[0] + 75.0) < 1e-9


def test_the_test_scan_lands_in_the_chaco_box():
    lat, lon = goes_watch.geolocate(np.array([X]), np.array([Y]), PROJECTION)
    assert -35 < lat[0] < -16 and -69 < lon[0] < -53


def test_a_fire_in_two_of_three_scans_is_published_and_told_once():
    summary, s3, sent = run([None, 10, 13])
    report = s3.json("derived/goes_latest.json")
    assert summary["persistent_cells"] == 1 and len(report["scans"]) == 3
    assert report["cells"][0]["confident_scans"] == 2 and report["cells"][0]["persistent"]
    assert len(sent) == 1 and "GOES-19" in sent[0]["text"]

    # Ten minutes later the same fire is still burning: no second message.
    later = NOW + timedelta(minutes=10)
    _, _, sent_again = run([10, 13, 10], s3=s3, now=later)
    assert sent_again == []


def test_the_cell_is_told_again_after_the_quiet_hours():
    _, s3, _ = run([None, 10, 13])
    later = NOW + timedelta(hours=goes_watch.QUIET_HOURS, minutes=10)
    _, _, sent = run([None, 10, 13], s3=s3, now=later)
    assert len(sent) == 1


def test_one_scan_is_not_enough():
    summary, s3, sent = run([None, None, 10])
    assert summary["persistent_cells"] == 0 and sent == []
    assert s3.json("derived/goes_latest.json")["cells"][0]["confident_pixels"] == 1


def test_low_and_medium_probability_pixels_are_shown_but_never_told():
    summary, s3, sent = run([15, 14, 35])
    cell = s3.json("derived/goes_latest.json")["cells"][0]
    assert cell["pixels"] == 3 and cell["confident_pixels"] == 0
    assert summary["persistent_cells"] == 0 and sent == []


def test_fires_outside_the_study_cells_never_raise_an_alert():
    summary, s3, sent = run([10, 10, 10], study=["8400001ffffffff"])
    assert s3.json("derived/goes_latest.json")["cells"][0]["in_study_area"] is False
    assert summary["persistent_cells"] == 0 and sent == []


def test_without_the_study_cells_the_layer_is_published_and_nobody_is_told():
    _, s3, sent = run([10, 10, 10], study=None)
    assert s3.json("derived/goes_latest.json")["rule"]["study_area_known"] is False
    assert sent == []


def test_a_broken_scan_is_skipped_and_the_rest_still_count():
    bucket = Bucket([10, 10, 13])
    bucket.scans[next(iter(bucket.scans))] = b"not hdf5"
    _, s3, sent = run(None, bucket=bucket)
    report = s3.json("derived/goes_latest.json")
    assert len(report["scans"]) == 2 and report["cells"][0]["persistent"]
    assert len(sent) == 1


def test_nothing_is_remembered_when_no_channel_delivered():
    summary, s3, _ = run([10, 10, 10], answer={"ok": False, "description": "chat not found"})
    assert summary["alerts"]["channels"]["telegram"] == "failed"
    assert ALERT.state_key not in s3.objects


# ---------- subscribers ----------


def test_each_cell_says_where_its_confident_pixels_are():
    _, s3, _ = run([10, 10, None])
    (cell,) = s3.json(SETTINGS.output_key)["cells"]
    assert h3.latlng_to_cell(cell["lat"], cell["lng"], 4) == cell["cell"]


def test_a_subscriber_near_a_persistent_fire_is_told_too():
    import subscriber_alerts
    import subscriptions as subs

    store = subs.MemoryStore()
    service = subs.Subscriptions(store)
    sub = service.create("telegram", None, list(STUDY), language="es")
    service.confirm_telegram(sub.id, 777)
    with_subscribers = goes_watch.Settings(
        **{
            **SETTINGS.__dict__,
            "subscriber_settings": subscriber_alerts.SubscriberSettings(
                bucket=BUCKET, web_url="", area=SETTINGS.area
            ),
        }
    )
    summary, _, sent = run([10, 10, None], settings=with_subscribers, subscriptions_store=store)
    assert summary["subscribers"]["sent"] == 1
    assert any(
        body.get("chat_id") == "777" and "Posible incendio" in body.get("text", "") for body in sent
    )
