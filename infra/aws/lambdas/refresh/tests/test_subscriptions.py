from datetime import UTC, datetime, timedelta
from itertools import count

import h3
import pytest

import subscriptions as s

AREA = (-69.0, -35.0, -53.0, -16.0)
ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]
START = datetime(2026, 11, 14, 22, 0, tzinfo=UTC)


class Clock:
    def __init__(self):
        self.now = START

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += timedelta(**kwargs)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def service(clock):
    ids, tokens = count(1), count(1)
    return s.Subscriptions(
        s.MemoryStore(),
        now=clock,
        make_id=lambda: f"id{next(ids)}",
        make_token=lambda: f"token{next(tokens)}",
        area=AREA,
    )


# ---------- creating ----------


def test_a_new_subscription_is_pending_and_expires_in_a_day(service):
    sub = service.create("email", " Ana@Example.com ", [ORIGIN, NEIGHBOR], "chaco-1")
    assert (sub.status, sub.address, sub.cells, sub.zone_id) == (
        "pending", "ana@example.com", (ORIGIN, NEIGHBOR), "chaco-1",
    )  # fmt: skip
    assert sub.expires_at == "2026-11-15T22:00:00+00:00" and sub.confirmed_at is None
    assert service.confirmed() == []


def test_the_address_of_a_telegram_subscription_comes_only_from_the_bot(service):
    sub = service.create("telegram", "123456789", [ORIGIN])
    assert sub.address is None  # whatever the browser sent is ignored
    assert service.create("telegram", None, [ORIGIN]).address is None


def test_cells_are_deduplicated_and_must_be_valid_inside_the_area(service):
    assert service.create("telegram", None, [ORIGIN, ORIGIN, NEIGHBOR]).cells == (ORIGIN, NEIGHBOR)
    outside = h3.latlng_to_cell(40.0, -3.7, 4)  # Madrid
    wrong_resolution = h3.latlng_to_cell(-25.0, -61.0, 5)
    for cells, message in [
        ([], "at least one"),
        ("8499a1bffffffff", "at least one"),
        (["nope"], "valid H3"),
        ([wrong_resolution], "resolution 4"),
        ([outside], "outside the monitored area"),
        (list(h3.grid_disk(ORIGIN, 4)), "at most"),
    ]:
        with pytest.raises(s.InvalidSubscription, match=message):
            service.create("telegram", None, cells)


def test_the_channel_the_address_and_the_zone_are_validated(service):
    with pytest.raises(s.InvalidSubscription, match="telegram or email"):
        service.create("whatsapp", "+54911", [ORIGIN])
    for bad in (
        None,
        "",
        "ana",
        "ana@",
        "@example.com",
        "a b@example.com",
        "a@b",
        "x" * 300 + "@e.com",
    ):
        with pytest.raises(s.InvalidSubscription, match="e-mail"):
            service.create("email", bad, [ORIGIN])
    with pytest.raises(s.InvalidSubscription, match="zone_id"):
        service.create("telegram", None, [ORIGIN], zone_id="a b; drop")


def test_a_new_request_for_the_same_address_replaces_its_pending_one(service):
    first = service.create("email", "ana@example.com", [ORIGIN])
    second = service.create("email", "ana@example.com", [NEIGHBOR])
    assert service.store.get(first.id) is None and service.store.get(second.id) is not None
    other = service.create("email", "luis@example.com", [ORIGIN])
    assert service.store.get(other.id) is not None


def test_ids_and_tokens_are_long_unguessable_and_different():
    real = s.Subscriptions(s.MemoryStore())
    a, b = (real.create("email", f"a{i}@example.com", [ORIGIN]) for i in range(2))
    assert len(a.id) >= 12 and len(a.token) >= 32
    assert a.id != b.id and a.token != b.token and a.id != a.token


# ---------- confirming ----------


def test_the_email_link_confirms_with_the_right_token_only(service):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    with pytest.raises(s.NotFound):
        service.confirm_with_token(sub.id, "bad-token")
    with pytest.raises(s.NotFound):
        service.confirm_with_token("unknown", sub.token)
    confirmed = service.confirm_with_token(sub.id, sub.token)
    assert confirmed.status == "confirmed" and confirmed.expires_at is None
    assert confirmed.confirmed_at == "2026-11-14T22:00:00+00:00"
    assert [x.id for x in service.confirmed()] == [sub.id]
    # Following the link again is harmless.
    assert service.confirm_with_token(sub.id, sub.token) == confirmed


def test_a_link_that_expired_does_not_confirm(service, clock):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    clock.advance(hours=24, minutes=1)
    with pytest.raises(s.NotFound):
        service.confirm_with_token(sub.id, sub.token)
    assert service.store.get(sub.id) is None


def test_the_bot_confirms_a_telegram_subscription_with_the_chat_that_pressed_start(service):
    sub = service.create("telegram", None, [ORIGIN])
    confirmed = service.confirm_telegram(sub.id, 987654321)
    assert confirmed.address == "987654321" and confirmed.status == "confirmed"
    assert [x.address for x in service.confirmed()] == ["987654321"]
    # The same chat pressing the link again is fine; another chat cannot take it over.
    assert service.confirm_telegram(sub.id, "987654321") == confirmed
    assert service.confirm_telegram(sub.id, 555) is None


def test_telegram_confirmation_rejects_unknown_expired_or_other_channel_links(service, clock):
    assert service.confirm_telegram("unknown", 1) is None
    mail = service.create("email", "ana@example.com", [ORIGIN])
    assert service.confirm_telegram(mail.id, 1) is None
    sub = service.create("telegram", None, [ORIGIN])
    assert service.confirm_telegram(sub.id, "not-a-number") is None
    clock.advance(days=2)
    assert service.confirm_telegram(sub.id, 1) is None


# ---------- leaving ----------


def test_unsubscribing_needs_the_token_and_does_not_say_why_it_failed(service):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(sub.id, sub.token)
    assert not service.unsubscribe(sub.id, "bad") and not service.unsubscribe("unknown", sub.token)
    assert len(service.confirmed()) == 1
    assert service.unsubscribe(sub.id, sub.token)
    assert service.confirmed() == []


def test_stop_in_the_bot_removes_every_subscription_of_that_chat(service):
    for cells in ([ORIGIN], [NEIGHBOR]):
        sub = service.create("telegram", None, cells)
        service.confirm_telegram(sub.id, 42)
    other = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(other.id, 43)
    assert service.unsubscribe_chat(42) == 2
    assert [x.address for x in service.confirmed()] == ["43"]
    assert service.unsubscribe_chat(42) == 0


# ---------- keeping house ----------


def test_pending_subscriptions_are_purged_after_their_day_and_confirmed_ones_stay(service, clock):
    kept = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(kept.id, kept.token)
    service.create("telegram", None, [ORIGIN])
    clock.advance(hours=25)
    assert service.purge_expired() == 1
    assert [x.id for x in service.store.all()] == [kept.id]


def test_what_the_notifier_told_a_subscriber_is_kept_and_survives_serialization(service):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(sub.id, sub.token)
    memory = {"window": "2026-11-08/2026-11-14", "cells": [ORIGIN], "ratio": 3.3, "weather": "high"}
    service.remember(sub.id, memory)
    stored = service.store.get(sub.id)
    assert stored.memory == memory
    assert s.Subscription.from_dict(stored.to_dict()) == stored
    service.remember("unknown", memory)  # nothing to remember it for: not an error
