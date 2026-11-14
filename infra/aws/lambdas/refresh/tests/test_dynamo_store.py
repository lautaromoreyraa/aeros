from datetime import UTC, datetime
from decimal import Decimal

import h3
import pytest

import dynamo_store as d
import subscriptions as s

ORIGIN = h3.latlng_to_cell(-25.0, -61.0, 4)
NEIGHBOR = h3.grid_ring(ORIGIN, 1)[0]


class FakeTable:
    """The part of a DynamoDB Table resource the store uses, with its float rule and paging."""

    def __init__(self, page_size=2):
        self.items: dict[str, dict] = {}
        self.page_size = page_size
        self.scans = 0

    @staticmethod
    def _refuse_floats(value):
        if isinstance(value, float):
            raise TypeError("Float types are not supported. Use Decimal types instead")
        if isinstance(value, dict):
            [FakeTable._refuse_floats(v) for v in value.values()]
        if isinstance(value, list):
            [FakeTable._refuse_floats(v) for v in value]

    def put_item(self, Item):
        self._refuse_floats(Item)
        self.items[Item["id"]] = dict(Item)

    def get_item(self, Key):
        found = self.items.get(Key["id"])
        return {"Item": dict(found)} if found else {}

    def delete_item(self, Key):
        self.items.pop(Key["id"], None)

    def scan(self, ExclusiveStartKey=None):
        self.scans += 1
        keys = sorted(self.items)
        start = keys.index(ExclusiveStartKey["id"]) + 1 if ExclusiveStartKey else 0
        chunk = keys[start : start + self.page_size]
        page = {"Items": [dict(self.items[k]) for k in chunk]}
        if start + self.page_size < len(keys):
            page["LastEvaluatedKey"] = {"id": chunk[-1]}
        return page


@pytest.fixture
def table():
    return FakeTable()


@pytest.fixture
def service(table):
    clock = lambda: datetime(2026, 11, 14, 22, 0, tzinfo=UTC)  # noqa: E731
    return s.Subscriptions(d.DynamoStore(table), now=clock)


def test_a_pending_subscription_carries_its_expiry_as_an_epoch_for_the_ttl(service, table):
    sub = service.create("email", "ana@example.com", [ORIGIN, NEIGHBOR])
    item = table.items[sub.id]
    assert item["ttl"] == int(datetime(2026, 11, 15, 22, 0, tzinfo=UTC).timestamp())
    assert item["cells"] == [ORIGIN, NEIGHBOR] and item["status"] == "pending"
    # Fields with no value are not stored as null.
    assert "confirmed_at" not in item and "memory" not in item and "zone_id" not in item


def test_confirming_drops_the_ttl_so_the_subscription_stays(service, table):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(sub.id, sub.token)
    item = table.items[sub.id]
    assert item["status"] == "confirmed" and "ttl" not in item and "expires_at" not in item


def test_a_stored_subscription_reads_back_equal(service):
    sub = service.create("email", "ana@example.com", [ORIGIN], "chaco-1")
    assert service.store.get(sub.id) == sub
    assert service.store.get("unknown") is None


def test_the_memory_of_the_notifier_survives_the_float_rule(service, table):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.confirm_with_token(sub.id, sub.token)
    memory = {"window": "2026-11-08/2026-11-14", "cells": [ORIGIN], "ratio": 3.3, "weather": "high"}
    service.remember(sub.id, memory)
    assert table.items[sub.id]["memory"]["ratio"] == Decimal("3.3")
    back = service.store.get(sub.id).memory
    assert back == memory and isinstance(back["ratio"], float)


def test_whole_numbers_come_back_as_int_and_the_ttl_never_leaks_into_the_subscription(service):
    sub = service.create("telegram", None, [ORIGIN])
    service.confirm_telegram(sub.id, 4242)
    service.remember(sub.id, {"ratio": 4.0, "cells": [ORIGIN]})
    stored = service.store.get(sub.id)
    assert stored.memory["ratio"] == 4 and isinstance(stored.memory["ratio"], int)
    assert not hasattr(stored, "ttl")


def test_all_follows_every_page_of_the_scan(service, table):
    for i in range(5):
        service.create("email", f"user{i}@example.com", [ORIGIN])
    table.scans = 0  # creating an email subscription already scans, to replace older pending ones
    assert len(service.store.all()) == 5 and table.scans == 3  # pages of 2: 2 + 2 + 1


def test_delete_removes_the_item_and_a_missing_one_is_not_an_error(service, table):
    sub = service.create("email", "ana@example.com", [ORIGIN])
    service.store.delete(sub.id)
    service.store.delete(sub.id)
    assert table.items == {}


def test_the_store_runs_the_whole_flow_the_service_expects(service):
    mail = service.create("email", "ana@example.com", [ORIGIN])
    chat = service.create("telegram", None, [NEIGHBOR])
    service.confirm_with_token(mail.id, mail.token)
    service.confirm_telegram(chat.id, 77)
    assert sorted(x.address for x in service.confirmed()) == ["77", "ana@example.com"]
    assert service.unsubscribe_chat(77) == 1 and service.unsubscribe(mail.id, mail.token)
    assert service.confirmed() == []
