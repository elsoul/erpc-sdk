"""Bounded typed NEAR status, block, and account reads."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import Any, TypeAlias, cast

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .errors import ErpcConfigError, ErpcInvalidResponseError
from .near_transport import NearHttpTransport, _NearIntegerToken, _ordinary_integer_token
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

U64_MAX = 18_446_744_073_709_551_615


def _generated_near_methods() -> tuple[str, ...]:
    method_sets = _RPC_NETWORK_CONTRACT.get("methodSets")
    if not isinstance(method_sets, list):
        raise RuntimeError("generated RPC contract has no method sets")
    method_set = next(
        (
            item
            for item in method_sets
            if isinstance(item, dict) and item.get("methodSetId") == "near-read3"
        ),
        None,
    )
    capabilities = method_set.get("capabilities") if isinstance(method_set, dict) else None
    if not isinstance(capabilities, list):
        raise RuntimeError("missing generated NEAR capabilities")
    methods = tuple(
        item["wireOperation"]
        for item in capabilities
        if isinstance(item, dict) and isinstance(item.get("wireOperation"), str)
    )
    if len(methods) != len(capabilities) or not methods:
        raise RuntimeError("invalid generated NEAR capabilities")
    return methods


NEAR_RPC_METHODS = _generated_near_methods()

NearJsonPrimitive: TypeAlias = None | bool | str | int | Decimal
NearJsonValue: TypeAlias = NearJsonPrimitive | list["NearJsonValue"] | dict[str, "NearJsonValue"]
NearBlockId: TypeAlias = str | int


class NearFinality(StrEnum):
    FINAL = "final"
    OPTIMISTIC = "optimistic"


def _invalid() -> ErpcInvalidResponseError:
    return ErpcInvalidResponseError("ERPC returned an invalid NEAR response")


def _freeze_json(value: object) -> object:
    if isinstance(value, _NearIntegerToken):
        return _ordinary_integer_token(value)
    if isinstance(value, dict):
        return MappingProxyType(
            {str(key): cast(NearJsonValue, _freeze_json(item)) for key, item in value.items()}
        )
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _object(value: object) -> dict[str, NearJsonValue]:
    if not isinstance(value, dict):
        raise _invalid()
    return value


def _required(value: dict[str, NearJsonValue], key: str) -> NearJsonValue:
    if key not in value:
        raise _invalid()
    return value[key]


def _string(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid()
    return value


def _boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise _invalid()
    return value


def _u64(value: object) -> int:
    if isinstance(value, _NearIntegerToken):
        raw = value.raw
        if raw == "0":
            return 0
        if (
            not raw
            or raw[0] == "-"
            or raw[0] == "0"
            or not all("0" <= character <= "9" for character in raw)
            or len(raw) > len(str(U64_MAX))
            or (len(raw) == len(str(U64_MAX)) and raw > str(U64_MAX))
        ):
            raise _invalid()
        return int(raw)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > U64_MAX:
        raise _invalid()
    return value


def _optional_u64(value: dict[str, NearJsonValue], key: str) -> int | None:
    if key not in value or value[key] is None:
        return None
    return _u64(value[key])


def _optional_string(value: dict[str, NearJsonValue], key: str) -> str | None:
    if key not in value or value[key] is None:
        return None
    return _string(value[key])


def _additional(value: dict[str, NearJsonValue], known: set[str]) -> dict[str, NearJsonValue]:
    return cast(
        dict[str, NearJsonValue],
        MappingProxyType(
            {
                key: cast(NearJsonValue, _freeze_json(item))
                for key, item in value.items()
                if key not in known
            }
        ),
    )


@dataclass(frozen=True, slots=True)
class NearBlockReference:
    """Exactly one NEAR finality or block ID selector."""

    finality: NearFinality | str | None = None
    block_id: NearBlockId | None = None

    def __post_init__(self) -> None:
        if self.finality is not None and self.block_id is not None:
            raise ErpcConfigError("NEAR block reference requires exactly one selector")
        if self.finality is not None:
            try:
                finality = NearFinality(self.finality)
            except (TypeError, ValueError):
                raise ErpcConfigError("NEAR finality is invalid") from None
            object.__setattr__(self, "finality", finality)

    @classmethod
    def final(cls) -> NearBlockReference:
        return cls(finality=NearFinality.FINAL)

    @classmethod
    def optimistic(cls) -> NearBlockReference:
        return cls(finality=NearFinality.OPTIMISTIC)

    @classmethod
    def height(cls, value: int) -> NearBlockReference:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > U64_MAX:
            raise ErpcConfigError("NEAR block height must be an unsigned integer")
        return cls(block_id=value)

    @classmethod
    def hash(cls, value: str) -> NearBlockReference:
        if (
            not isinstance(value, str)
            or not value
            or any(ord(item) < 0x20 or ord(item) == 0x7F for item in value)
        ):
            raise ErpcConfigError("NEAR block hash must be a non-empty string")
        return cls(block_id=value)

    def to_params(self) -> dict[str, str | int]:
        if self.finality is not None:
            return {"finality": NearFinality(self.finality).value}
        if isinstance(self.block_id, bool):
            raise ErpcConfigError("NEAR block ID is invalid")
        if isinstance(self.block_id, int):
            if self.block_id < 0 or self.block_id > U64_MAX:
                raise ErpcConfigError("NEAR block height must be an unsigned integer")
            return {"block_id": self.block_id}
        if (
            isinstance(self.block_id, str)
            and self.block_id
            and not any(ord(item) < 0x20 or ord(item) == 0x7F for item in self.block_id)
        ):
            return {"block_id": self.block_id}
        raise ErpcConfigError("NEAR block reference is invalid")


@dataclass(frozen=True, slots=True)
class NearSyncInfo:
    latest_block_hash: str
    latest_block_height: int
    latest_block_time: str
    latest_state_root: str
    syncing: bool
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearSyncInfo:
        item = _object(value)
        return cls(
            _string(_required(item, "latest_block_hash")),
            _u64(_required(item, "latest_block_height")),
            _string(_required(item, "latest_block_time")),
            _string(_required(item, "latest_state_root")),
            _boolean(_required(item, "syncing")),
            _additional(
                item,
                {
                    "latest_block_hash",
                    "latest_block_height",
                    "latest_block_time",
                    "latest_state_root",
                    "syncing",
                },
            ),
        )


@dataclass(frozen=True, slots=True)
class NearNodeVersion:
    version: str
    build: str
    rustc_version: str | None
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearNodeVersion:
        item = _object(value)
        return cls(
            _string(_required(item, "version")),
            _string(_required(item, "build")),
            _optional_string(item, "rustc_version"),
            _additional(item, {"version", "build", "rustc_version"}),
        )


@dataclass(frozen=True, slots=True)
class NearStatus:
    chain_id: str
    genesis_hash: str
    latest_protocol_version: int
    protocol_version: int
    sync_info: NearSyncInfo
    version: NearNodeVersion
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearStatus:
        item = _object(value)
        return cls(
            _string(_required(item, "chain_id")),
            _string(_required(item, "genesis_hash")),
            _u64(_required(item, "latest_protocol_version")),
            _u64(_required(item, "protocol_version")),
            NearSyncInfo.from_value(_required(item, "sync_info")),
            NearNodeVersion.from_value(_required(item, "version")),
            _additional(
                item,
                {
                    "chain_id",
                    "genesis_hash",
                    "latest_protocol_version",
                    "protocol_version",
                    "sync_info",
                    "version",
                },
            ),
        )


@dataclass(frozen=True, slots=True)
class NearBlockHeader:
    hash: str
    height: int
    prev_hash: str
    timestamp: int
    timestamp_nanosec: str
    gas_price: str
    total_supply: str
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearBlockHeader:
        item = _object(value)
        return cls(
            _string(_required(item, "hash")),
            _u64(_required(item, "height")),
            _string(_required(item, "prev_hash")),
            _u64(_required(item, "timestamp")),
            _string(_required(item, "timestamp_nanosec")),
            _string(_required(item, "gas_price")),
            _string(_required(item, "total_supply")),
            _additional(
                item,
                {
                    "hash",
                    "height",
                    "prev_hash",
                    "timestamp",
                    "timestamp_nanosec",
                    "gas_price",
                    "total_supply",
                },
            ),
        )


@dataclass(frozen=True, slots=True)
class NearBlockView:
    author: str
    header: NearBlockHeader
    chunks: tuple[NearJsonValue, ...]
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearBlockView:
        item = _object(value)
        chunks_value = _required(item, "chunks")
        if not isinstance(chunks_value, list):
            raise _invalid()
        chunks = tuple(cast(NearJsonValue, _freeze_json(chunk)) for chunk in chunks_value)
        return cls(
            _string(_required(item, "author")),
            NearBlockHeader.from_value(_required(item, "header")),
            chunks,
            _additional(item, {"author", "header", "chunks"}),
        )


@dataclass(frozen=True, slots=True)
class NearAccountView:
    amount: str
    locked: str
    code_hash: str
    storage_usage: int
    storage_paid_at: int | None
    block_height: int
    block_hash: str
    state: str | None
    bootstrap_nonce: int | None
    global_contract_account_id: str | None
    global_contract_hash: str | None
    additional: dict[str, NearJsonValue]

    @classmethod
    def from_value(cls, value: object) -> NearAccountView:
        item = _object(value)
        return cls(
            _string(_required(item, "amount")),
            _string(_required(item, "locked")),
            _string(_required(item, "code_hash")),
            _u64(_required(item, "storage_usage")),
            _optional_u64(item, "storage_paid_at"),
            _u64(_required(item, "block_height")),
            _string(_required(item, "block_hash")),
            _optional_string(item, "state"),
            _optional_u64(item, "bootstrap_nonce"),
            _optional_string(item, "global_contract_account_id"),
            _optional_string(item, "global_contract_hash"),
            _additional(
                item,
                {
                    "amount",
                    "locked",
                    "code_hash",
                    "storage_usage",
                    "storage_paid_at",
                    "block_height",
                    "block_hash",
                    "state",
                    "bootstrap_nonce",
                    "global_contract_account_id",
                    "global_contract_hash",
                },
            ),
        )


class NearPendingRequest:
    __slots__ = ("_callback",)

    def __init__(self, callback: Any) -> None:
        self._callback = callback

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> Any:
        return await self._callback(options)


class NearRpcClient:
    __slots__ = ("_transport",)

    def __init__(self, transport: NearHttpTransport) -> None:
        self._transport = transport

    @property
    def endpoint(self) -> str:
        return self._transport.endpoint

    def status(self) -> NearPendingRequest:
        async def execute(options: RequestOptions) -> NearStatus:
            return NearStatus.from_value(
                await self._transport.request(NEAR_RPC_METHODS[1], [], options)
            )

        return NearPendingRequest(execute)

    def block(self, reference: NearBlockReference) -> NearPendingRequest:
        params = _selector(reference)

        async def execute(options: RequestOptions) -> NearBlockView:
            return NearBlockView.from_value(
                await self._transport.request(NEAR_RPC_METHODS[0], params, options)
            )

        return NearPendingRequest(execute)

    def view_account(self, account_id: str, reference: NearBlockReference) -> NearPendingRequest:
        if not isinstance(account_id, str) or not account_id:
            raise ErpcConfigError("NEAR account ID is invalid")
        params: dict[str, str | int] = {
            "request_type": "view_account",
            "account_id": account_id,
        }
        params.update(_selector(reference))

        async def execute(options: RequestOptions) -> NearAccountView:
            return NearAccountView.from_value(
                await self._transport.request(NEAR_RPC_METHODS[2], params, options)
            )

        return NearPendingRequest(execute)


def _selector(reference: NearBlockReference) -> dict[str, str | int]:
    if type(reference) is not NearBlockReference:
        raise ErpcConfigError("NEAR block reference is invalid")
    finality = reference.finality
    block_id = reference.block_id
    if finality is not None and block_id is not None:
        raise ErpcConfigError("NEAR block reference requires exactly one selector")
    if finality is not None:
        if finality == NearFinality.FINAL:
            return {"finality": NearFinality.FINAL.value}
        if finality == NearFinality.OPTIMISTIC:
            return {"finality": NearFinality.OPTIMISTIC.value}
        raise ErpcConfigError("NEAR finality is invalid")
    if isinstance(block_id, bool):
        raise ErpcConfigError("NEAR block ID is invalid")
    if isinstance(block_id, int):
        if block_id < 0 or block_id > U64_MAX:
            raise ErpcConfigError("NEAR block height must be an unsigned integer")
        return {"block_id": block_id}
    if isinstance(block_id, str) and block_id and not any(
        ord(item) < 0x20 or ord(item) == 0x7F for item in block_id
    ):
        return {"block_id": block_id}
    if block_id is None:
        raise ErpcConfigError("NEAR block reference is required")
    raise ErpcConfigError("NEAR block reference is invalid")


@dataclass(frozen=True, slots=True)
class NearClient:
    rpc: NearRpcClient


def create_near_client(transport: Any) -> NearClient:
    return NearClient(rpc=NearRpcClient(transport))


__all__ = [
    "NEAR_RPC_METHODS",
    "NearAccountView",
    "NearBlockHeader",
    "NearBlockId",
    "NearBlockReference",
    "NearBlockView",
    "NearClient",
    "NearFinality",
    "NearJsonValue",
    "NearNodeVersion",
    "NearPendingRequest",
    "NearRpcClient",
    "NearStatus",
    "NearSyncInfo",
    "create_near_client",
]
