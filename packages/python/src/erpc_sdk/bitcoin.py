"""Explicit named-read Bitcoin facade."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from .bitcoin_codec import (
    BITCOIN_RPC_METHODS,
    BitcoinJsonValue,
    as_bitcoin_block_count,
    as_bitcoin_nullable_object,
    as_bitcoin_string,
)
from .bitcoin_transport import BitcoinHttpTransport
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

T = TypeVar("T")


class BitcoinPendingRequest(Generic[T]):
    """An inert named request; network I/O begins only when ``send`` is awaited."""

    __slots__ = ("_callback",)

    def __init__(self, callback: Callable[[RequestOptions], Awaitable[T]]) -> None:
        self._callback = callback

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> T:
        return await self._callback(options)


def _wire(transport: BitcoinHttpTransport, name: str) -> str:
    return transport.wire_method(name)


def _pending(
    transport: BitcoinHttpTransport,
    method: str,
    params: list[Any],
    projector: Callable[[object], T] | None = None,
) -> BitcoinPendingRequest[T]:
    async def execute(options: RequestOptions) -> T:
        value = await transport.request(method, params, options, projector=projector)
        return value  # type: ignore[return-value]

    return BitcoinPendingRequest(execute)


class BitcoinRpcClient:
    """The twelve explicit Bitcoin read helpers and endpoint metadata."""

    __slots__ = ("_transport",)

    def __init__(self, transport: BitcoinHttpTransport) -> None:
        self._transport = transport

    @property
    def endpoint(self) -> str:
        return self._transport.endpoint

    def estimate_smart_fee(
        self,
        conf_target: int | None = None,
        estimate_mode: str | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue]:
        if estimate_mode is not None and conf_target is None:
            raise ValueError("estimate_mode requires conf_target")
        params: list[Any] = [] if conf_target is None else [conf_target]
        if estimate_mode is not None:
            params.append(estimate_mode)
        return _pending(
            self._transport,
            _wire(self._transport, "estimate_smart_fee"),
            params,
        )

    def get_best_block_hash(self) -> BitcoinPendingRequest[str]:
        return _pending(
            self._transport,
            _wire(self._transport, "get_best_block_hash"),
            [],
            as_bitcoin_string,
        )

    def get_block(
        self,
        block_hash: str,
        verbosity: bool | int | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue]:
        params: list[Any] = [block_hash]
        if verbosity is not None:
            params.append(verbosity)
        return _pending(self._transport, _wire(self._transport, "get_block"), params)

    def get_blockchain_info(self) -> BitcoinPendingRequest[BitcoinJsonValue]:
        return _pending(
            self._transport,
            _wire(self._transport, "get_blockchain_info"),
            [],
        )

    def get_block_count(self) -> BitcoinPendingRequest[int]:
        return _pending(
            self._transport,
            _wire(self._transport, "get_block_count"),
            [],
            as_bitcoin_block_count,
        )

    def get_block_hash(self, height: int) -> BitcoinPendingRequest[str]:
        return _pending(
            self._transport,
            _wire(self._transport, "get_block_hash"),
            [height],
            as_bitcoin_string,
        )

    def get_block_header(
        self,
        block_hash: str,
        verbose: bool | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue]:
        params: list[Any] = [block_hash]
        if verbose is not None:
            params.append(verbose)
        return _pending(
            self._transport,
            _wire(self._transport, "get_block_header"),
            params,
        )

    def get_mempool_info(self) -> BitcoinPendingRequest[BitcoinJsonValue]:
        return _pending(self._transport, _wire(self._transport, "get_mempool_info"), [])

    def get_network_info(self) -> BitcoinPendingRequest[BitcoinJsonValue]:
        return _pending(self._transport, _wire(self._transport, "get_network_info"), [])

    def get_raw_mempool(
        self,
        verbose: bool | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue]:
        params = [] if verbose is None else [verbose]
        return _pending(self._transport, _wire(self._transport, "get_raw_mempool"), params)

    def get_raw_transaction(
        self,
        transaction_id: str,
        verbose: bool | int | None = None,
        block_hash: str | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue]:
        params: list[Any] = [transaction_id]
        if verbose is not None:
            params.append(verbose)
        if block_hash is not None:
            params.append(block_hash)
        return _pending(
            self._transport,
            _wire(self._transport, "get_raw_transaction"),
            params,
        )

    def get_tx_out(
        self,
        transaction_id: str,
        output_index: int,
        include_mempool: bool | None = None,
    ) -> BitcoinPendingRequest[BitcoinJsonValue | None]:
        params: list[Any] = [transaction_id, output_index]
        if include_mempool is not None:
            params.append(include_mempool)
        return _pending(
            self._transport,
            _wire(self._transport, "get_tx_out"),
            params,
            as_bitcoin_nullable_object,
        )


@dataclass(frozen=True, slots=True)
class BitcoinClient:
    """Frozen composition root for the named Bitcoin facade."""

    rpc: BitcoinRpcClient


def create_bitcoin_client(transport: BitcoinHttpTransport) -> BitcoinClient:
    return BitcoinClient(rpc=BitcoinRpcClient(transport))


__all__ = [
    "BITCOIN_RPC_METHODS",
    "BitcoinClient",
    "BitcoinPendingRequest",
    "BitcoinRpcClient",
    "create_bitcoin_client",
]
