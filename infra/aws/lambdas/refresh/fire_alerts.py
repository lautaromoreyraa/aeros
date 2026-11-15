"""Tells each subscriber about a possible fire near them, as GOES-19 sees it.

`goes_watch` reads GOES-19 every 10 minutes and marks a cell `persistent` when
it holds confident fire pixels in at least two of the last three scans. This
module turns those cells into one message per subscriber:

* a fire is near a person when it burns within FIRE_RADIUS_KM of the town they
  named, measured from the mean position of its confident pixels. 50 km is a
  panel of the dashboard (an H3 resolution-4 cell, about 25 km across) and the
  neighbouring one, so a person can find the fire on the map they know;
* a person who chose cells on the map instead hears about fires in those cells;
* one message every QUIET_HOURS at most, with every fire near them in it: in
  the burning season a busy afternoon must not become a message every 10
  minutes.

The weekly anomaly (much more fire than usual) stays on the dashboard and in
the fixed-list alert; subscribers only hear about something burning now.

What a person was told is kept only after the message went out, so a failed
send is retried on the next run instead of counting as told.

Nothing here talks to AWS: the report, the subscriptions and the senders come
in as plain values (see `subscriber_alerts.run` for the AWS side).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta

import alert_text
import targeting
from subscriptions import Subscription, Subscriptions

logger = logging.getLogger()

FIRE_RADIUS_KM = 50.0
QUIET_HOURS = 12
#: Fires listed in one message; the rest are counted.
FIRES_SHOWN = 3

#: (subscription, subject, text)
Sender = Callable[[Subscription, str, str], None]
#: (subscription, lat, lng, title, address): one map pin after the message.
PinSender = Callable[[Subscription, float, float, str, str], None]


def fires_near(subscription: Subscription, cells: list[Mapping]) -> list[Mapping]:
    """The persistent cells near a subscriber, the closest first."""
    found: list[tuple[float, Mapping]] = []
    for entry in cells:
        if not entry.get("persistent"):
            continue
        km = targeting.offset_from(subscription, entry)[0]
        if subscription.place:
            if km <= FIRE_RADIUS_KM:
                found.append((km, entry))
        elif entry["cell"] in subscription.cells:
            found.append((km, entry))
    return [entry for _, entry in sorted(found, key=lambda pair: pair[0])]


def is_quiet(memory: Mapping | None, now: datetime) -> bool:
    """True while the person was told about a fire less than QUIET_HOURS ago."""
    told = (memory or {}).get("fire_told_at")
    if not told:
        return False
    try:
        return now - datetime.fromisoformat(told) < timedelta(hours=QUIET_HOURS)
    except ValueError:
        return False


def notify(
    report: Mapping,
    subscriptions: Subscriptions,
    senders: Mapping[str, Sender],
    *,
    pin_senders: Mapping[str, PinSender] | None = None,
    wind_field: Mapping | None = None,
    web_url: str = "",
    unsubscribe_url: Callable[[Subscription], str] | None = None,
    now: datetime | None = None,
) -> dict:
    """Sends each subscriber the fires near them; returns what happened, in counts."""
    when = now or datetime.now(UTC)
    cells = [c for c in report.get("cells") or [] if c.get("persistent")]
    subscribers = subscriptions.confirmed()
    summary = {
        "subscribers": len(subscribers),
        "near": 0,
        "sent": 0,
        "quiet": 0,
        "failed": 0,
        "no_channel": 0,
    }
    if not cells:
        return summary

    for subscriber in subscribers:
        near = fires_near(subscriber, cells)
        if not near:
            continue
        summary["near"] += 1
        if is_quiet(subscriber.memory, when):
            summary["quiet"] += 1
            continue
        sender = senders.get(subscriber.channel)
        if sender is None:
            summary["no_channel"] += 1
            continue

        pin_sender = (pin_senders or {}).get(subscriber.channel)
        stop = (
            alert_text.telegram_stop(subscriber.language)
            if subscriber.channel == "telegram"
            else (unsubscribe_url(subscriber) if unsubscribe_url else "")
        )
        lat, lng = targeting.place_of(near[0])
        nearest = targeting.offset_from(subscriber, near[0])
        subject, text = alert_text.fire_message(
            [(entry, targeting.offset_from(subscriber, entry)) for entry in near],
            subscriber.language,
            scans=len(report.get("scans") or []),
            now=when,
            wind=targeting.wind_at(wind_field, lat, lng, when),
            web_url=web_url,
            unsubscribe=stop,
            pins=pin_sender is not None,
            map_links=subscriber.channel == "email",
            max_fires=FIRES_SHOWN,
        )
        try:
            sender(subscriber, subject, text)
        except Exception as exc:
            # Only the class: an error from Telegram can hold the bot token in its URL.
            logger.error("a fire alert could not be delivered: %s", type(exc).__name__)
            summary["failed"] += 1
            continue
        memory = dict(subscriber.memory or {})
        memory["fire_told_at"] = when.astimezone(UTC).isoformat(timespec="seconds")
        subscriptions.remember(subscriber.id, memory)
        summary["sent"] += 1
        if pin_sender is not None:
            # Only the nearest fire gets a pin: several pins are a puzzle on a phone.
            title, address = alert_text.fire_pin_text(subscriber.language, nearest)
            try:
                pin_sender(subscriber, lat, lng, title, address)
            except Exception as exc:
                logger.error("a location could not be delivered: %s", type(exc).__name__)
                summary["pins_failed"] = summary.get("pins_failed", 0) + 1
    return summary
