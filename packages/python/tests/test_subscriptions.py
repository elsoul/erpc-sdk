from __future__ import annotations

from collections.abc import Callable

import pytest

from erpc_sdk import EthereumSubscriptions, SolanaSubscriptions
from erpc_sdk.types import DEFAULT_REQUEST_OPTIONS, JsonRpcParams, JsonValue, RequestOptions


class FakeWebSocketTransport:
    def __init__(self, subscription_id: JsonValue) -> None:
        self.subscription_id = subscription_id
        self.calls: list[tuple[str, JsonRpcParams | None]] = []
        self.listeners: set[Callable[[dict[str, JsonValue]], object]] = set()
        self.closed = False

    async def request(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        self.calls.append((method, params))
        if method.endswith("Unsubscribe") or method == "eth_unsubscribe":
            return True
        return self.subscription_id

    def on_notification(
        self, listener: Callable[[dict[str, JsonValue]], object]
    ) -> Callable[[], None]:
        self.listeners.add(listener)

        def remove() -> None:
            self.listeners.discard(listener)

        return remove

    async def close(self) -> None:
        self.closed = True

    def notify(self, subscription_id: JsonValue, result: JsonValue) -> None:
        notification: dict[str, JsonValue] = {
            "jsonrpc": "2.0",
            "method": "notification",
            "params": {"subscription": subscription_id, "result": result},
        }
        for listener in tuple(self.listeners):
            listener(notification)


@pytest.mark.asyncio
async def test_solana_subscription_routes_notifications_and_unsubscribes_once() -> None:
    transport = FakeWebSocketTransport(7)
    subscriptions = SolanaSubscriptions(transport)  # type: ignore[arg-type]
    received: list[JsonValue] = []
    subscription = await subscriptions.account_subscribe(
        "address", {"commitment": "processed"}, listener=received.append
    )
    transport.notify(8, "wrong")
    transport.notify(7, {"slot": 12})
    assert await anext(subscription) == {"slot": 12}
    assert received == [{"slot": 12}]
    assert await subscription.unsubscribe() is True
    assert await subscription.unsubscribe() is True
    assert transport.calls == [
        ("accountSubscribe", ["address", {"commitment": "processed"}]),
        ("accountUnsubscribe", [7]),
    ]
    assert transport.listeners == set()


@pytest.mark.asyncio
async def test_ethereum_subscription_uses_string_id() -> None:
    transport = FakeWebSocketTransport("sub-id")
    subscriptions = EthereumSubscriptions(transport)  # type: ignore[arg-type]
    subscription = await subscriptions.subscribe("newHeads", {"include": "full"})
    transport.notify("sub-id", {"number": "0x1"})
    assert await anext(subscription) == {"number": "0x1"}
    assert await subscription.unsubscribe() is True
    assert transport.calls == [
        ("eth_subscribe", ["newHeads", {"include": "full"}]),
        ("eth_unsubscribe", ["sub-id"]),
    ]
