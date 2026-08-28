"""Persistent WebSocket JSON-RPC transport and subscription helpers."""

from __future__ import annotations

import asyncio
import inspect
import itertools
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import suppress
from typing import Generic, TypeVar, cast

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from .errors import (
    ErpcAbortedError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcTimeoutError,
    ErpcTransportError,
    redact_text,
    redact_value,
)
from .transport import _wait
from .types import (
    DEFAULT_REQUEST_OPTIONS,
    JsonRpcId,
    JsonRpcParams,
    JsonValue,
    RequestOptions,
)

SubscriptionId = int | str
Notification = dict[str, JsonValue]
NotificationListener = Callable[[Notification], object]
SubscriptionListener = Callable[[JsonValue], object]
TId = TypeVar("TId", int, str)


class WebSocketJsonRpcTransport:
    """Lazy persistent WebSocket transport; the credential URL is never exposed."""

    def __init__(self, connection_url: str, credential: str, timeout: float) -> None:
        self._connection_url = connection_url
        self._credential = credential
        self._timeout = timeout
        self._ids = itertools.count(1)
        self._connection: ClientConnection | None = None
        self._connect_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[JsonRpcId, asyncio.Future[object]] = {}
        self._listeners: set[NotificationListener] = set()
        self._closed = False

    async def _ensure_connection(self) -> ClientConnection:
        if self._closed:
            raise ErpcTransportError("WebSocket transport is closed")
        if self._connection is not None:
            return self._connection
        async with self._connect_lock:
            if self._connection is not None:
                return self._connection
            try:
                async with asyncio.timeout(self._timeout):
                    connection = await connect(self._connection_url, open_timeout=self._timeout)
            except TimeoutError as error:
                raise ErpcTimeoutError(self._timeout) from error
            except (OSError, WebSocketException) as error:
                raise ErpcTransportError("Unable to reach ERPC WebSocket") from error
            self._connection = connection
            self._reader_task = asyncio.create_task(self._read(connection))
            return connection

    async def request(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        connection = await self._ensure_connection()
        request_id = next(self._ids)
        body: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            body["params"] = params
        future: asyncio.Future[object] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            try:
                await _wait(connection.send(json.dumps(body)), self._timeout, options)
                response = await _wait(future, self._timeout, options)
            except (ErpcAbortedError, ErpcTimeoutError):
                raise
            except (OSError, WebSocketException) as error:
                raise ErpcTransportError("Unable to reach ERPC WebSocket") from error
        finally:
            self._pending.pop(request_id, None)
        if not isinstance(response, dict) or response.get("id") != request_id:
            raise ErpcInvalidResponseError("ERPC returned an invalid WebSocket response")
        if "error" in response:
            rpc_error = response["error"]
            if not isinstance(rpc_error, dict):
                raise ErpcInvalidResponseError("ERPC returned an invalid RPC error")
            code = rpc_error.get("code")
            message = rpc_error.get("message")
            if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
                raise ErpcInvalidResponseError("ERPC returned an invalid RPC error")
            data = rpc_error.get("data")
            raise ErpcJsonRpcError(
                code,
                redact_text(message, self._credential),
                redact_value(data, self._credential) if data is not None else None,
            )
        if "result" not in response:
            raise ErpcInvalidResponseError("ERPC returned an invalid WebSocket response")
        return cast(JsonValue, response["result"])

    async def _read(self, connection: ClientConnection) -> None:
        error: ErpcTransportError | None = None
        try:
            async for raw in connection:
                try:
                    value = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(value, dict):
                    continue
                request_id = value.get("id")
                if isinstance(request_id, (int, str)) and not isinstance(request_id, bool):
                    pending = self._pending.get(request_id)
                    if pending is not None and not pending.done():
                        pending.set_result(value)
                elif isinstance(value.get("method"), str) and "params" in value:
                    notification = cast(Notification, value)
                    for listener in tuple(self._listeners):
                        try:
                            result = listener(notification)
                            if inspect.isawaitable(result):
                                asyncio.ensure_future(cast(Awaitable[object], result))
                        except Exception:
                            # A listener cannot interrupt notification routing.
                            continue
        except asyncio.CancelledError:
            raise
        except (OSError, WebSocketException):
            error = ErpcTransportError("ERPC WebSocket connection closed")
        finally:
            if self._connection is connection:
                self._connection = None
            if error is not None:
                for pending in tuple(self._pending.values()):
                    if not pending.done():
                        pending.set_exception(error)

    def on_notification(self, listener: NotificationListener) -> Callable[[], None]:
        self._listeners.add(listener)

        def remove() -> None:
            self._listeners.discard(listener)

        return remove

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        connection, self._connection = self._connection, None
        reader, self._reader_task = self._reader_task, None
        if connection is not None:
            with suppress(Exception):
                await connection.close()
        if reader is not None:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        error = ErpcTransportError("WebSocket transport is closed")
        for pending in tuple(self._pending.values()):
            if not pending.done():
                pending.set_exception(error)
        self._pending.clear()
        self._listeners.clear()


class RpcSubscription(Generic[TId], AsyncIterator[JsonValue]):
    """An async iterator over one subscription with idempotent unsubscribe."""

    def __init__(
        self,
        subscription_id: TId,
        queue: asyncio.Queue[JsonValue],
        unsubscribe: Callable[[], Awaitable[bool]],
    ) -> None:
        self.id: TId = subscription_id
        self._queue = queue
        self._unsubscribe = unsubscribe
        self._closed = False

    def __aiter__(self) -> RpcSubscription[TId]:
        return self

    async def __anext__(self) -> JsonValue:
        if self._closed and self._queue.empty():
            raise StopAsyncIteration
        return await self._queue.get()

    async def unsubscribe(self) -> bool:
        if self._closed:
            return True
        result = await self._unsubscribe()
        if result:
            self._closed = True
        return result


def _notification_params(notification: Notification) -> tuple[SubscriptionId, JsonValue] | None:
    params = notification.get("params")
    if not isinstance(params, dict):
        return None
    subscription_id = params.get("subscription")
    if (
        not isinstance(subscription_id, (int, str))
        or isinstance(subscription_id, bool)
        or "result" not in params
    ):
        return None
    return subscription_id, params["result"]


class _SubscriptionsBase:
    def __init__(self, transport: WebSocketJsonRpcTransport) -> None:
        self._transport = transport

    def on_notification(self, listener: NotificationListener) -> Callable[[], None]:
        return self._transport.on_notification(listener)

    async def raw(self, method: str, params: JsonRpcParams | None = None) -> JsonValue:
        return await self._transport.request(method, params)

    async def close(self) -> None:
        await self._transport.close()

    async def _subscribe(
        self,
        subscribe_method: str,
        params: list[JsonValue],
        unsubscribe_method: str,
        listener: SubscriptionListener | None,
    ) -> RpcSubscription[int] | RpcSubscription[str]:
        queue: asyncio.Queue[JsonValue] = asyncio.Queue()
        subscription_id: SubscriptionId | None = None

        def notification(received: Notification) -> object:
            value = _notification_params(received)
            if value is None or value[0] != subscription_id:
                return None
            queue.put_nowait(value[1])
            return listener(value[1]) if listener is not None else None

        remove = self._transport.on_notification(notification)
        try:
            raw_id = await self._transport.request(subscribe_method, params)
            if not isinstance(raw_id, (int, str)) or isinstance(raw_id, bool):
                raise ErpcInvalidResponseError("ERPC returned an invalid subscription id")
            subscription_id = raw_id
        except Exception:
            remove()
            raise

        async def unsubscribe() -> bool:
            result = await self._transport.request(unsubscribe_method, [subscription_id])
            if not isinstance(result, bool):
                raise ErpcInvalidResponseError("ERPC returned an invalid unsubscribe result")
            if result:
                remove()
            return result

        if isinstance(subscription_id, int):
            return RpcSubscription(subscription_id, queue, unsubscribe)
        return RpcSubscription(subscription_id, queue, unsubscribe)


class EthereumSubscriptions(_SubscriptionsBase):
    async def subscribe(
        self,
        subscription: str,
        *options: JsonValue,
        listener: SubscriptionListener | None = None,
    ) -> RpcSubscription[str]:
        result = await self._subscribe(
            "eth_subscribe", [subscription, *options], "eth_unsubscribe", listener
        )
        if not isinstance(result.id, str):
            await result.unsubscribe()
            raise ErpcInvalidResponseError("ERPC returned an invalid subscription id")
        return result


class SolanaSubscriptions(_SubscriptionsBase):
    async def account_subscribe(
        self,
        address: str,
        options: dict[str, JsonValue] | None = None,
        *,
        listener: SubscriptionListener | None = None,
    ) -> RpcSubscription[int]:
        params: list[JsonValue] = [address]
        if options is not None:
            params.append(options)
        return await self._numeric_subscribe(
            "accountSubscribe", params, "accountUnsubscribe", listener
        )

    async def transaction_subscribe(
        self,
        filter: dict[str, JsonValue],
        options: dict[str, JsonValue] | None = None,
        *,
        listener: SubscriptionListener | None = None,
    ) -> RpcSubscription[int]:
        params: list[JsonValue] = [filter]
        if options is not None:
            params.append(options)
        return await self._numeric_subscribe(
            "transactionSubscribe", params, "transactionUnsubscribe", listener
        )

    async def raw_subscribe(
        self,
        subscribe_method: str,
        params: list[JsonValue],
        unsubscribe_method: str,
        *,
        listener: SubscriptionListener | None = None,
    ) -> RpcSubscription[int] | RpcSubscription[str]:
        return await self._subscribe(subscribe_method, params, unsubscribe_method, listener)

    async def _numeric_subscribe(
        self,
        subscribe_method: str,
        params: list[JsonValue],
        unsubscribe_method: str,
        listener: SubscriptionListener | None,
    ) -> RpcSubscription[int]:
        result = await self._subscribe(subscribe_method, params, unsubscribe_method, listener)
        if not isinstance(result.id, int) or isinstance(result.id, bool):
            await result.unsubscribe()
            raise ErpcInvalidResponseError("ERPC returned an invalid subscription id")
        return result
