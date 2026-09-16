from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

import pytest

import erpc_sdk.subscriptions as subscription_module
from erpc_sdk import (
    ErpcClient,
    ErpcClientConfig,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    EthereumSubscriptions,
    RpcEndpointConfig,
    SolanaSubscriptions,
)
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


@pytest.mark.asyncio
async def test_direct_subscription_without_wss_fails_locally_even_with_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unexpected_connect(*_: object, **__: object) -> object:
        raise AssertionError("direct subscription attempted an unexpected connection")

    monkeypatch.setattr(subscription_module, "connect", unexpected_connect)
    client = ErpcClient(
        ErpcClientConfig(
            "shared-key",
            ethereum_rpc=RpcEndpointConfig("https://customer.example/rpc"),
        )
    )
    with pytest.raises(ErpcNotConfiguredError) as captured:
        await client.ethereum.subscriptions.subscribe("newHeads")
    assert captured.value.namespace == "ethereum.subscriptions"
    await client.close()


class _DirectConnection:
    def __init__(self) -> None:
        self.messages: asyncio.Queue[str | None] = asyncio.Queue()
        self.sent: list[str] = []

    def __aiter__(self) -> _DirectConnection:
        return self

    async def __anext__(self) -> str:
        value = await self.messages.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def send(self, raw: str) -> None:
        self.sent.append(raw)
        request = json.loads(raw)
        await self.messages.put(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {
                        "code": -32000,
                        "message": "ws%2fx ws/x header-secret",
                        "data": {"ws/x": "ws%2fx", "header-secret": "header-secret"},
                    },
                }
            )
        )

    async def close(self) -> None:
        await self.messages.put(None)


@pytest.mark.asyncio
async def test_direct_subscription_redacts_independent_ws_query_and_header_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _DirectConnection()
    connected_urls: list[str] = []

    async def fake_connect(url: str, *, open_timeout: float) -> _DirectConnection:
        del open_timeout
        connected_urls.append(url)
        return connection

    monkeypatch.setattr(subscription_module, "connect", fake_connect)
    client = ErpcClient(
        ErpcClientConfig(
            ethereum_rpc=RpcEndpointConfig(
                "https://customer.example/rpc?token=http%2Fsecret",
                websocket_url="wss://customer.example/socket?token=ws%2Fx",
                headers={"authorization": "Bearer header-secret"},
            )
        )
    )
    with pytest.raises(ErpcJsonRpcError) as captured:
        await client.ethereum.subscriptions.raw("eth_subscribe", ["newHeads"])
    rendered = f"{captured.value} {captured.value.data!r}"
    for secret in ("ws%2fx", "ws%2Fx", "ws/x", "header-secret"):
        assert secret not in rendered
    assert connected_urls == ["wss://customer.example/socket?token=ws%2Fx"]
    assert "api-key" not in connected_urls[0]
    await client.close()
