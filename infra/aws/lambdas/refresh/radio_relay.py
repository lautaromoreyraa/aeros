"""Puts the same short fire text on a LoRa radio, from a place that has a connection.

Telegram and email need internet. SMS needs cellular signal. A post with neither
still hears a mesh of small radios only if some other point can reach aeros.
This module is that point: it reads the published ``goes_latest.json`` and calls
``send_text`` with the same words an SMS would carry. The mesh is not an AWS
channel. Nothing here opens a public broker, and nothing transmits unless the
caller passes a sender.

A stale report is ignored. Each post is told at most once every QUIET_HOURS,
and a failed send is not remembered. Left off the Lambda allow-list on purpose:
it runs on the gateway machine, next to the radio.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import alert_text
import fire_alerts
import targeting

logger = logging.getLogger()

SendText = Callable[[str], None]


class RadioError(RuntimeError):
    """The gateway could not use a radio. The report itself is fine."""


@dataclass(frozen=True)
class Post:
    """A place on the mesh. ``name`` is the label in the text and the memory key."""

    name: str
    lat: float
    lng: float
    language: str = "es"


@dataclass(frozen=True)
class _Place:
    """The few fields ``fires_near`` reads: a named town, and no map cells."""

    place: dict
    cells: tuple[str, ...] = ()


def load_posts(data: Mapping) -> list[Post]:
    """Posts from a config object. Raises ``ValueError`` when the list is unusable."""
    raw = data.get("posts")
    if not isinstance(raw, list) or not raw:
        raise ValueError("posts must list at least one place")
    posts: list[Post] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, Mapping):
            raise ValueError("each post needs a name, lat and lng")
        name = str(item.get("name") or "").strip()
        if not name or len(name) > 40:
            raise ValueError("each post needs a short name")
        if name in seen:
            raise ValueError(f"{name}: a post name is used twice")
        seen.add(name)
        try:
            lat = float(item["lat"])
            lng = float(item["lng"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{name}: lat and lng must be numbers") from exc
        if not -90 <= lat <= 90 or not -180 <= lng <= 180:
            raise ValueError(f"{name}: lat or lng is out of range")
        language = str(item.get("language") or "es")
        if language not in ("es", "en"):
            raise ValueError(f"{name}: language must be es or en")
        posts.append(Post(name, lat, lng, language))
    return posts


def read_report(source: str, *, fetch: Callable[[str], bytes] | None = None) -> dict:
    """A ``goes_latest.json`` from a local path or an http(s) URL."""
    if source.startswith(("https://", "http://")):
        body = (fetch or _http_get)(source)
    else:
        body = Path(source).read_bytes()
    try:
        report = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("the report is not JSON") from exc
    if not isinstance(report, dict):
        raise ValueError("the report must be an object")
    return report


def relay(
    report: Mapping,
    posts: list[Post],
    send_text: SendText,
    memory: dict,
    *,
    now: datetime | None = None,
) -> dict:
    """Sends one short text per post with a persistent fire within 50 km.

    ``memory`` is updated in place only after ``send_text`` returns. A stale
    report sends nothing and leaves memory as it was.
    """
    when = _aware(now)
    summary = {"posts": len(posts), "near": 0, "sent": 0, "quiet": 0, "failed": 0, "skipped": None}
    if report.get("stale"):
        summary["skipped"] = "stale"
        return summary
    cells = [c for c in report.get("cells") or [] if isinstance(c, Mapping)]
    for post in posts:
        view = _Place({"name": post.name, "lat": post.lat, "lng": post.lng})
        near = fire_alerts.fires_near(view, cells)
        if not near:
            continue
        summary["near"] += 1
        if fire_alerts.is_quiet(memory.get(post.name), when):
            summary["quiet"] += 1
            continue
        where = targeting.offset_from(view, near[0])[2]
        text = alert_text.fire_sms(post.language, where)
        try:
            send_text(text)
        except Exception as exc:
            logger.error("a radio relay could not send: %s", type(exc).__name__)
            summary["failed"] += 1
            continue
        memory[post.name] = {"fire_told_at": when.astimezone(UTC).isoformat(timespec="seconds")}
        summary["sent"] += 1
    return summary


def open_radio(device: str):
    """A Meshtastic interface for ``device`` (a serial port, or ``tcp:host``).

    The library is imported here so tests and ``--print`` never need it, and so
    this module never dials the public Meshtastic broker.
    """
    try:
        if device.startswith("tcp:"):
            from meshtastic.tcp_interface import TCPInterface

            return TCPInterface(device.removeprefix("tcp:"))
        from meshtastic.serial_interface import SerialInterface

        return SerialInterface(device)
    except ImportError as exc:
        raise RadioError(
            "The meshtastic package is not installed on this gateway. "
            "Use --print, or install it beside the radio."
        ) from exc


def sender_for(interface) -> SendText:
    """The ``sendText`` of a Meshtastic interface, as the relay's sender."""

    def send(text: str) -> None:
        interface.sendText(text)

    return send


def main(argv: list[str] | None = None) -> int:
    """Read a report and the posts, then print the texts or hand them to a radio."""
    parser = argparse.ArgumentParser(
        description="Relay a published GOES alert onto a LoRa radio at a connected gateway."
    )
    parser.add_argument("--report", required=True, help="Path or http(s) URL of goes_latest.json")
    parser.add_argument("--posts", required=True, help="JSON file: posts with name, lat, lng")
    parser.add_argument("--memory", help="JSON file of what each post was already told")
    parser.add_argument("--now", help="ISO time, used by tests instead of the clock")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--print", action="store_true", dest="to_stdout", help="Write each text")
    mode.add_argument("--device", help="Meshtastic serial port, or tcp:host")
    args = parser.parse_args(argv)

    try:
        report = read_report(args.report)
        posts = load_posts(json.loads(Path(args.posts).read_text(encoding="utf-8")))
        when = _aware(datetime.fromisoformat(args.now)) if args.now else None
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        return 2

    memory_path = Path(args.memory) if args.memory else _memory_path(args.posts)
    memory = _read_memory(memory_path)
    if memory is None:
        return 2

    radio = None
    try:
        if args.to_stdout:

            def send(text: str) -> None:
                print(text)

        else:
            radio = open_radio(args.device)
            send = sender_for(radio)
        summary = relay(report, posts, send, memory, now=when)
    except RadioError as exc:
        print(exc, file=sys.stderr)
        return 2
    finally:
        close = getattr(radio, "close", None)
        if close:
            close()
    if summary["sent"]:
        memory_path.write_text(json.dumps(memory), encoding="utf-8")
    return 0


def _memory_path(posts: str) -> Path:
    path = Path(posts)
    return path.with_name(f"{path.stem}.memory.json")


def _read_memory(path: Path) -> dict | None:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        return None
    if not isinstance(loaded, dict):
        print("memory must be an object", file=sys.stderr)
        return None
    return loaded


def _aware(now: datetime | None) -> datetime:
    when = now or datetime.now(UTC)
    if when.tzinfo is None:
        return when.replace(tzinfo=UTC)
    return when


def _http_get(url: str) -> bytes:
    from urllib.request import Request, urlopen

    request = Request(url, headers={"User-Agent": "aeros-radio-relay"})
    with urlopen(request, timeout=20) as response:
        return response.read()


if __name__ == "__main__":
    raise SystemExit(main())
