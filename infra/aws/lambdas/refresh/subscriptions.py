"""Alert subscriptions: who asked to hear about fires near which cells.

A subscription keeps a channel, an address and the cells chosen, and nothing
else about the person. It is born pending and only counts once confirmed, with
a double opt-in on every channel: the person presses Start in the Telegram bot,
or follows the link e-mailed to the address. A pending one expires after a day,
so a mistyped or malicious address never lingers.

Telegram is the delicate one. The browser cannot know a chat id, and accepting
one from it would let anybody subscribe somebody else's chat and make the bot
write to a stranger. So for Telegram the address sent by the browser is
ignored: the chat id is set only by the bot, from the chat that pressed Start.

Nothing here talks to AWS: storage is the `Store` protocol, and time and
random values are injected, so every rule is tested without a network.
"""

from __future__ import annotations

import hmac
import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Protocol

import h3

from alert_text import DEFAULT_LANGUAGE, pick_language

CHANNELS = ("telegram", "email")
RESOLUTION = 4
#: A zone is a cell and its ring (7 cells); this leaves room for a few of them.
MAX_CELLS = 60
PENDING_TTL = timedelta(hours=24)
#: Cells around a town that count as "near it": its own panel of the map (an H3 resolution-4
#: cell, about 25 km across) and the neighbouring ones, so about 50 km. `fire_alerts` measures
#: the 50 km from the town itself; these cells are what the map draws.
PLACE_RING = 1
#: Least time between two confirmation e-mails to the same address.
RESEND_COOLDOWN = timedelta(minutes=10)
# Plain characters only: SES reads "Name <address>" as a display name plus an address,
# so brackets, quotes and commas must not get through.
_EMAIL = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$")
_CHAT_ID = re.compile(r"^-?\d{1,20}$")
_ZONE = re.compile(r"^[A-Za-z0-9_-]{1,60}$")


class InvalidSubscription(ValueError):
    """The request is wrong in a way the client can fix; the message is safe to return."""


class Cooldown(Exception):
    """A confirmation e-mail already went to this address a moment ago."""


class NotFound(LookupError):
    """Unknown, expired or wrongly authenticated: deliberately not told apart."""


@dataclass(frozen=True)
class Subscription:
    id: str
    channel: str
    #: An e-mail address, or the Telegram chat id once the bot has confirmed it.
    address: str | None
    cells: tuple[str, ...]
    zone_id: str | None
    status: str  # "pending" or "confirmed"
    #: Secret of the confirmation and unsubscribe links of an e-mail subscription.
    token: str
    created_at: str
    expires_at: str | None
    confirmed_at: str | None = None
    #: What the notifier told this subscriber in the current window.
    memory: dict | None = None
    #: "es" or "en": the language of every message this person gets.
    language: str = DEFAULT_LANGUAGE
    #: The town the person asked alerts about: {name, region, country, lat, lng}. Alerts are
    #: then about fires near it, and the cells are the ones around it.
    place: dict | None = None

    def to_dict(self) -> dict:
        return {**self.__dict__, "cells": list(self.cells)}

    @classmethod
    def from_dict(cls, data: dict) -> Subscription:
        return cls(**{**data, "cells": tuple(data["cells"])})


class Store(Protocol):
    def put(self, subscription: Subscription) -> None: ...

    def get(self, subscription_id: str) -> Subscription | None: ...

    def delete(self, subscription_id: str) -> None: ...

    def all(self) -> list[Subscription]: ...


class MemoryStore:
    """A store in a dict, for tests and for the local demo."""

    def __init__(self) -> None:
        self.items: dict[str, Subscription] = {}

    def put(self, subscription: Subscription) -> None:
        self.items[subscription.id] = subscription

    def get(self, subscription_id: str) -> Subscription | None:
        return self.items.get(subscription_id)

    def delete(self, subscription_id: str) -> None:
        self.items.pop(subscription_id, None)

    def all(self) -> list[Subscription]:
        return list(self.items.values())


def _clean(value: object, limit: int) -> str:
    """Text a person can read back: trimmed, no control characters, not too long."""
    text = "".join(ch for ch in str(value or "") if ch.isprintable()).strip()
    return text[:limit]


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


class Subscriptions:
    def __init__(
        self,
        store: Store,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        make_id: Callable[[], str] = lambda: secrets.token_urlsafe(9),
        make_token: Callable[[], str] = lambda: secrets.token_urlsafe(24),
        area: tuple[float, float, float, float] | None = None,
    ) -> None:
        self.store = store
        self._now = now
        self._make_id = make_id
        self._make_token = make_token
        #: West, south, east, north of the monitored area; cells outside it get no alerts.
        self.area = area

    # ---------- creating ----------

    def create(
        self,
        channel: str,
        address: str | None,
        cells: Sequence[str],
        zone_id: str | None = None,
        language: str | None = None,
        place: Mapping | None = None,
    ) -> Subscription:
        if channel not in CHANNELS:
            raise InvalidSubscription("channel must be telegram or email")
        clean_place = self._valid_place(place) if place is not None else None
        if clean_place and not cells:
            cells = self.cells_around(clean_place["lat"], clean_place["lng"])
        chosen = self._valid_cells(cells)
        if zone_id is not None and not _ZONE.match(zone_id):
            raise InvalidSubscription("zone_id may only hold letters, digits, - and _")
        if channel == "email":
            address = (address or "").strip().lower()
            if len(address) > 254 or not _EMAIL.match(address):
                raise InvalidSubscription("a valid e-mail address is needed")
            # A new request for the same address replaces its older pending ones, but not
            # within minutes of the last: nobody may use this to flood a mailbox.
            now = self._now()
            for old in self.store.all():
                if old.channel == "email" and old.address == address and old.status == "pending":
                    if now - datetime.fromisoformat(old.created_at) < RESEND_COOLDOWN:
                        raise Cooldown
                    self.store.delete(old.id)
        else:
            address = None  # set by the bot, never by the browser

        now = self._now()
        subscription = Subscription(
            id=self._make_id(),
            channel=channel,
            address=address,
            cells=chosen,
            zone_id=zone_id,
            language=pick_language(language),
            place=clean_place,
            status="pending",
            token=self._make_token(),
            created_at=now.isoformat(timespec="seconds"),
            expires_at=(now + PENDING_TTL).isoformat(timespec="seconds"),
        )
        self.store.put(subscription)
        return subscription

    def _valid_cells(self, cells: Sequence[str]) -> tuple[str, ...]:
        if isinstance(cells, str) or not cells:
            raise InvalidSubscription("choose at least one cell")
        unique = tuple(dict.fromkeys(cells))
        if len(unique) > MAX_CELLS:
            raise InvalidSubscription(f"at most {MAX_CELLS} cells per subscription")
        for cell in unique:
            if not isinstance(cell, str) or not h3.is_valid_cell(cell):
                raise InvalidSubscription("every cell must be a valid H3 cell")
            if h3.get_resolution(cell) != RESOLUTION:
                raise InvalidSubscription(f"cells must be H3 resolution {RESOLUTION}")
            if self.area and not self._inside(cell):
                raise InvalidSubscription("a cell is outside the monitored area")
        return unique

    def _inside(self, cell: str) -> bool:
        return self._inside_point(*h3.cell_to_latlng(cell))

    def _inside_point(self, lat: float, lng: float) -> bool:
        west, south, east, north = self.area  # type: ignore[misc]
        return south <= lat <= north and west <= lng <= east

    def cells_around(self, lat: float, lng: float) -> tuple[str, ...]:
        """The cell of a point and its neighbours (about 50 km), inside the monitored area."""
        centre = h3.latlng_to_cell(lat, lng, RESOLUTION)
        return tuple(
            c for c in h3.grid_disk(centre, PLACE_RING) if not self.area or self._inside(c)
        )

    def _valid_place(self, place: object) -> dict:
        """A town as the client sends it, cleaned: the name is shown back to the person."""
        if not isinstance(place, Mapping):
            raise InvalidSubscription("place must be an object with a name and a position")
        name = _clean(place.get("name"), 80)
        if not name:
            raise InvalidSubscription("a place needs a name")
        try:
            lat, lng = round(float(place["lat"]), 2), round(float(place["lng"]), 2)
        except (KeyError, TypeError, ValueError):
            raise InvalidSubscription("a place needs a latitude and a longitude") from None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise InvalidSubscription("a place needs a latitude and a longitude")
        if self.area and not self._inside_point(lat, lng):
            raise InvalidSubscription("this place is outside the monitored area")
        cleaned: dict = {
            "name": name,
            "region": _clean(place.get("region"), 60),
            "country": _clean(place.get("country"), 60),
            "lat": lat,
            "lng": lng,
        }
        if "radius_km" in place:
            try:
                r = float(place["radius_km"])
                if 1.0 <= r <= 100.0:
                    cleaned["radius_km"] = round(r, 1)
            except (KeyError, TypeError, ValueError):
                pass
        return cleaned

    # ---------- confirming ----------

    def _live(self, subscription_id: str) -> Subscription | None:
        found = self.store.get(subscription_id)
        if found is None:
            return None
        if found.status == "pending" and found.expires_at:
            if datetime.fromisoformat(found.expires_at) < self._now():
                self.store.delete(found.id)
                return None
        return found

    def confirm_with_token(self, subscription_id: str, token: str) -> Subscription:
        """E-mail: the link in the message. Idempotent for an already confirmed one."""
        found = self._live(subscription_id)
        if found is None or found.channel != "email" or not _same(found.token, token or ""):
            raise NotFound("this link is not valid or has expired")
        if found.status == "confirmed":
            return found
        confirmed = replace(
            found,
            status="confirmed",
            confirmed_at=self._now().isoformat(timespec="seconds"),
            expires_at=None,
        )
        self.store.put(confirmed)
        self._drop_others(confirmed)
        return confirmed

    def _drop_others(self, kept: Subscription) -> None:
        """One subscription per address or chat: confirming a new one replaces the old."""
        for other in self.store.all():
            same = other.channel == kept.channel and other.address == kept.address
            if same and other.id != kept.id and other.status == "confirmed":
                self.store.delete(other.id)

    def confirm_telegram(
        self, subscription_id: str, chat_id: int | str, language: str | None = None
    ) -> Subscription | None:
        """The bot saw `/start <id>` from `chat_id`: that chat is the subscriber."""
        chat = str(chat_id)
        if not _CHAT_ID.match(chat):
            return None
        found = self._live(subscription_id)
        if found is None or found.channel != "telegram":
            return None
        if found.status == "confirmed":
            # Pressing the same link again is fine; another chat taking it is not.
            return found if found.address == chat else None
        confirmed = replace(
            found,
            address=chat,
            # The app of the person who pressed Start says their language better than the site did.
            language=pick_language(language) if language else found.language,
            status="confirmed",
            confirmed_at=self._now().isoformat(timespec="seconds"),
            expires_at=None,
        )
        self.store.put(confirmed)
        self._drop_others(confirmed)
        return confirmed

    def subscribe_place(
        self, chat_id: int | str, place: Mapping, language: str | None = None
    ) -> Subscription:
        """A Telegram chat said which town it wants alerts about: that is the whole sign-up.

        Writing to the bot is the double opt-in, so the subscription is born confirmed. It
        replaces whatever that chat had before (see `_drop_others`).
        """
        chat = str(chat_id)
        if not _CHAT_ID.match(chat):
            raise InvalidSubscription("not a chat")
        pending = self.create("telegram", None, (), language=language, place=place)
        confirmed = self.confirm_telegram(pending.id, chat, language)
        assert confirmed is not None
        return confirmed

    # ---------- leaving ----------

    def unsubscribe(self, subscription_id: str, token: str) -> bool:
        found = self.store.get(subscription_id)
        if found is None or not _same(found.token, token or ""):
            return False
        self.store.delete(subscription_id)
        return True

    def unsubscribe_chat(self, chat_id: int | str) -> int:
        """`/stop` in the bot: every Telegram subscription of that chat goes."""
        chat = str(chat_id)
        gone = [s for s in self.store.all() if s.channel == "telegram" and s.address == chat]
        for subscription in gone:
            self.store.delete(subscription.id)
        return len(gone)

    # ---------- reading ----------

    def confirmed(self) -> list[Subscription]:
        return [s for s in self.store.all() if s.status == "confirmed" and s.address]

    def of_chat(self, chat_id: int | str) -> Subscription | None:
        """The confirmed subscription of a Telegram chat; `_drop_others` keeps at most one."""
        chat = str(chat_id)
        for subscription in self.confirmed():
            if subscription.channel == "telegram" and subscription.address == chat:
                return subscription
        return None

    def purge_expired(self) -> int:
        """For stores without their own expiry: drops pending subscriptions past their day."""
        now = self._now()
        stale = [
            s
            for s in self.store.all()
            if s.status == "pending" and s.expires_at and datetime.fromisoformat(s.expires_at) < now
        ]
        for subscription in stale:
            self.store.delete(subscription.id)
        return len(stale)

    def remember(self, subscription_id: str, memory: dict) -> None:
        """Keeps what the notifier told a subscriber, so the next run can tell what changed."""
        found = self.store.get(subscription_id)
        if found is not None:
            self.store.put(replace(found, memory=memory))
