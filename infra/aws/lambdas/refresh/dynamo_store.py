"""The subscriptions store on DynamoDB.

One item per subscription, keyed by its id. The table is tiny (a subscriber is
a channel, an address and a few cells), so the notifier reads it with a Scan:
no index, nothing to size, and it stays inside the always-free allowance
(25 GB, 25 read and 25 write capacity units).

A pending subscription also carries `ttl`, its expiry as epoch seconds, which
the table's time-to-live setting uses to delete it by itself some time after
the day it was given; reading code still checks the expiry, because DynamoDB
removes expired items lazily. Confirmed ones have no `ttl` and stay.

DynamoDB refuses Python floats, so numbers go in as Decimal and come back as
int or float.
"""

from __future__ import annotations

import os
from datetime import datetime
from decimal import Decimal
from typing import Any

from subscriptions import Subscription


def _to_dynamo(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_dynamo(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_dynamo(v) for v in value]
    return value


def _from_dynamo(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _from_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_dynamo(v) for v in value]
    return value


class DynamoStore:
    def __init__(self, table) -> None:
        self.table = table

    @classmethod
    def from_environment(cls) -> DynamoStore:
        import boto3  # shipped with the Lambda runtime

        return cls(boto3.resource("dynamodb").Table(os.environ["SUBSCRIPTIONS_TABLE"]))

    def put(self, subscription: Subscription) -> None:
        item = _to_dynamo(subscription.to_dict())
        # Optional fields are left out instead of stored as null.
        item = {k: v for k, v in item.items() if v is not None}
        if subscription.status == "pending" and subscription.expires_at:
            item["ttl"] = int(datetime.fromisoformat(subscription.expires_at).timestamp())
        self.table.put_item(Item=item)

    def get(self, subscription_id: str) -> Subscription | None:
        found = self.table.get_item(Key={"id": subscription_id}).get("Item")
        return _subscription(found) if found else None

    def delete(self, subscription_id: str) -> None:
        self.table.delete_item(Key={"id": subscription_id})

    def all(self) -> list[Subscription]:
        items: list[dict] = []
        kwargs: dict = {}
        while True:
            page = self.table.scan(**kwargs)
            items += page.get("Items", [])
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        return [_subscription(item) for item in items]


def _subscription(item: dict) -> Subscription:
    data = _from_dynamo(item)
    data.pop("ttl", None)
    for optional in ("address", "zone_id", "expires_at", "confirmed_at", "memory"):
        data.setdefault(optional, None)
    return Subscription.from_dict(data)
