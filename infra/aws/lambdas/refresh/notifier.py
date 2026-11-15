"""Tells each confirmed subscriber about the fires that can reach their cells.

The daily alert tells a fixed list that the region burns above its normal.
This tells each subscriber only about the flagged cells whose risk zone touches
the cells they chose (see `targeting`), with the wind and the fire weather of
the moment, through the channel they subscribed on.

A subscriber is told once per weekly window and again only if it escalates.
What they were told is kept only after the message went out: when sending
fails nothing is remembered, so the next run tries again instead of treating a
person who got nothing as informed.

No AWS here: subscriptions, senders, report and the wind and weather files come
in as plain values, so the whole flow runs the same in a Lambda, in a test and
in the local runner that sends one real message for a demo.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import UTC, datetime

import alert_text
import alerts
import targeting
from subscriptions import Subscription, Subscriptions

logger = logging.getLogger()

#: Sends one message to one subscriber; raises when it did not go out.
Sender = Callable[[Subscription, str, str], None]
#: What Telegram subscribers read in place of a link: the bot answers /stop.
TELEGRAM_STOP = "send /stop in this chat"


def telegram_sender(post: alerts.Post, token: str) -> Sender:
    """The chat id of a confirmed Telegram subscription is its address."""

    def send(subscription: Subscription, subject: str, text: str) -> None:
        alerts.send_telegram(post, token, str(subscription.address), text)

    return send


#: Zones a message names and pins on a map: the one nearest to the subscriber, and a count
#: of the others. More than one pin is a puzzle for someone who just wants to know if it is near.
PLACES_SHOWN = 1

#: Sends the pins of a message: the subscriber and the (lat, lng, name) of each zone.
PlaceSender = Callable[[Subscription, list[tuple[float, float, str]]], None]


def telegram_place_sender(post: alerts.Post, token: str) -> PlaceSender:
    """One map pin per zone, after the message, with a name in the reader's language."""

    def send(subscription: Subscription, places: list[tuple[float, float, str]]) -> None:
        for lat, lng, name in places:
            title, address = alert_text.venue_text(subscription.language, name)
            alerts.send_telegram_venue(
                post, token, str(subscription.address), lat, lng, title, address
            )

    return send


def email_sender(ses, from_address: str) -> Sender:
    def send(subscription: Subscription, subject: str, text: str) -> None:
        alerts.send_email(ses, from_address, [str(subscription.address)], subject, text)

    return send


def mail_sender(send: alerts.MailSender) -> Sender:
    """Any e-mail provider: `send` is what `alerts.email_sender_from_parameters` returns."""

    def deliver(subscription: Subscription, subject: str, text: str) -> None:
        send([str(subscription.address)], subject, text)

    return deliver


def notify(
    report: Mapping,
    subscriptions: Subscriptions,
    senders: Mapping[str, Sender],
    *,
    wind_field: Mapping | None = None,
    fire_weather: Mapping | None = None,
    sector_of: Mapping[str, str] | None = None,
    web_url: str = "",
    unsubscribe_url: Callable[[Subscription], str] | None = None,
    place_senders: Mapping[str, PlaceSender] | None = None,
    now: datetime | None = None,
) -> dict:
    """Sends what each subscriber has not been told yet; returns what happened, in counts."""
    when = now or datetime.now(UTC)
    subscribers = subscriptions.confirmed()
    summary = {
        "alert": False,
        "subscribers": len(subscribers),
        "reached": 0,
        "sent": 0,
        "unchanged": 0,
        "failed": 0,
        "no_channel": 0,
    }
    alert = alerts.assess(dict(report))
    # A region-wide alert with no flagged cell has nothing to reach: it is for the daily list.
    if alert is None or not report.get("cells"):
        return summary
    summary["alert"] = True

    zones = targeting.alert_zones(report, wind_field, when)
    region_ratio = alert.region_ratio if alert.region_alert else None
    for match in targeting.reach(subscribers, report, zones):
        summary["reached"] += 1
        subscriber = match.subscriber
        match = targeting.nearest_first(match)
        sender = senders.get(subscriber.channel)
        if sender is None:
            summary["no_channel"] += 1
            continue

        weather = targeting.fire_weather_for(match, fire_weather, when)
        level = weather["level"] if weather else None
        if not targeting.should_send(subscriber.memory, match, report, weather_level=level):
            summary["unchanged"] += 1
            continue

        lat, lng = targeting.place_of(match.flagged[0])
        place_sender = (place_senders or {}).get(subscriber.channel)
        language = getattr(subscriber, "language", alert_text.DEFAULT_LANGUAGE)
        stop = (
            alert_text.telegram_stop(language)
            if subscriber.channel == "telegram"
            else (unsubscribe_url(subscriber) if unsubscribe_url else "")
        )
        subject, text = alert_text.format_message(
            match,
            report,
            language,
            region_ratio=region_ratio,
            sector_of=sector_of,
            web_url=web_url,
            unsubscribe=stop,
            wind=targeting.wind_at(wind_field, lat, lng, when),
            fire_weather=weather,
            pins=place_sender is not None,
            map_links=subscriber.channel == "email",
            max_places=PLACES_SHOWN,
        )
        try:
            sender(subscriber, subject, text)
        except Exception as exc:
            # Only the class: an error from Telegram can hold the bot token in its URL.
            logger.error("an alert could not be delivered: %s", type(exc).__name__)
            summary["failed"] += 1
            continue
        subscriptions.remember(
            subscriber.id,
            targeting.next_memory(subscriber.memory, match, report, weather_level=level),
        )
        summary["sent"] += 1
        if place_sender is not None:
            places = [
                (*targeting.place_of(entry), (sector_of or {}).get(entry["cell"], "Gran Chaco"))
                for entry in match.flagged[:PLACES_SHOWN]
            ]
            try:
                place_sender(subscriber, places)
            except Exception as exc:
                # The message already went out and was remembered: a pin that fails is only a pity.
                logger.error("a location could not be delivered: %s", type(exc).__name__)
                summary["pins_failed"] = summary.get("pins_failed", 0) + 1
    return summary
