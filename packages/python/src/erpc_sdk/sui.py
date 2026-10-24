"""Public bounded Sui gRPC-Web read facade."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

from ._sui_grpc_web import (
    SUI_GRPC_WEB_CONTENT_TYPE,
    SUI_GRPC_WEB_METHODS,
    SuiGrpcWebTransport,
)
from ._sui_proto import (
    SuiBalanceWire,
    SuiObjectSummaryWire,
    SuiServiceInfoWire,
    decode_balance_response,
    decode_object_response,
    decode_service_info_response,
    encode_get_balance_request,
    encode_get_object_request,
    encode_get_service_info_request,
)
from .errors import ErpcConfigError
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class SuiServiceInfo:
    chain_id: str
    chain: str
    epoch: int
    checkpoint_height: int
    timestamp_seconds: int
    timestamp_nanos: int
    lowest_available_checkpoint: int
    lowest_available_checkpoint_objects: int
    server: str | None = None


@dataclass(frozen=True, slots=True)
class SuiObjectSummary:
    object_id: str
    version: int
    digest: str


@dataclass(frozen=True, slots=True)
class SuiBalance:
    coin_type: str
    balance: int
    address_balance: int
    coin_balance: int


class PendingSuiGrpcWebRequest(Generic[T]):
    """Inert Sui read that starts transport work only when ``send`` is awaited."""

    __slots__ = ("_transport", "_method", "_body", "_decode")

    def __init__(
        self,
        transport: SuiGrpcWebTransport,
        method: str,
        body: bytes,
        decode: Callable[[bytes], T],
    ) -> None:
        self._transport = transport
        self._method = method
        self._body = body
        self._decode = decode

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> T:
        return self._decode(await self._transport.execute(self._method, self._body, options))


class SuiGrpcWebClient:
    __slots__ = ("_transport",)

    def __init__(self, transport: SuiGrpcWebTransport) -> None:
        self._transport = transport

    @property
    def endpoint(self) -> str:
        return self._transport.endpoint

    def get_service_info(self) -> PendingSuiGrpcWebRequest[SuiServiceInfo]:
        return PendingSuiGrpcWebRequest(
            self._transport,
            SUI_GRPC_WEB_METHODS[0],
            encode_get_service_info_request(),
            _decode_service_info,
        )

    def get_object(
        self,
        object_id: str,
        version: int | None = None,
    ) -> PendingSuiGrpcWebRequest[SuiObjectSummary]:
        if not isinstance(object_id, str):
            raise ErpcConfigError("Sui object ID is invalid")
        return PendingSuiGrpcWebRequest(
            self._transport,
            SUI_GRPC_WEB_METHODS[1],
            encode_get_object_request(object_id, version),
            _decode_object_summary,
        )

    def get_balance(
        self,
        owner: str,
        coin_type: str,
    ) -> PendingSuiGrpcWebRequest[SuiBalance]:
        return PendingSuiGrpcWebRequest(
            self._transport,
            SUI_GRPC_WEB_METHODS[2],
            encode_get_balance_request(owner, coin_type),
            _decode_balance,
        )


@dataclass(frozen=True, slots=True)
class SuiClient:
    grpc: SuiGrpcWebClient


def _service_info(value: SuiServiceInfoWire) -> SuiServiceInfo:
    return SuiServiceInfo(
        chain_id=value.chain_id,
        chain=value.chain,
        epoch=value.epoch,
        checkpoint_height=value.checkpoint_height,
        timestamp_seconds=value.timestamp.seconds,
        timestamp_nanos=value.timestamp.nanos,
        lowest_available_checkpoint=value.lowest_available_checkpoint,
        lowest_available_checkpoint_objects=value.lowest_available_checkpoint_objects,
        server=value.server,
    )


def _decode_service_info(payload: bytes) -> SuiServiceInfo:
    return _service_info(decode_service_info_response(payload))


def _object_summary(value: SuiObjectSummaryWire) -> SuiObjectSummary:
    return SuiObjectSummary(value.object_id, value.version, value.digest)


def _decode_object_summary(payload: bytes) -> SuiObjectSummary:
    return _object_summary(decode_object_response(payload))


def _balance(value: SuiBalanceWire) -> SuiBalance:
    return SuiBalance(value.coin_type, value.balance, value.address_balance, value.coin_balance)


def _decode_balance(payload: bytes) -> SuiBalance:
    return _balance(decode_balance_response(payload))


def create_sui_client(transport: SuiGrpcWebTransport) -> SuiClient:
    return SuiClient(grpc=SuiGrpcWebClient(transport))


__all__ = [
    "PendingSuiGrpcWebRequest",
    "SUI_GRPC_WEB_CONTENT_TYPE",
    "SUI_GRPC_WEB_METHODS",
    "SuiBalance",
    "SuiClient",
    "SuiGrpcWebClient",
    "SuiObjectSummary",
    "SuiServiceInfo",
    "create_sui_client",
]
