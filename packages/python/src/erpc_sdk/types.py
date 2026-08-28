"""Public JSON, RPC, REST, and Cloud type declarations."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal, NotRequired, TypeAlias, TypedDict

JsonPrimitive: TypeAlias = bool | float | int | None | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonRpcId: TypeAlias = int | str
JsonRpcParams: TypeAlias = list[JsonValue] | dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class RequestOptions:
    """Per-request cancellation options."""

    cancel_event: asyncio.Event | None = None


DEFAULT_REQUEST_OPTIONS = RequestOptions()


class RpcBatchCall(TypedDict):
    """One call in an intact JSON-RPC batch."""

    method: str
    params: NotRequired[JsonRpcParams]


class SolanaContext(TypedDict):
    slot: int
    apiVersion: NotRequired[str]


class SolanaContextResult(TypedDict):
    context: SolanaContext
    value: JsonValue


class PriorityFeeEstimate(TypedDict, total=False):
    priorityFeeEstimate: float


class AssetRequest(TypedDict, total=False):
    id: str
    displayOptions: dict[str, bool]


class AssetBatchRequest(TypedDict, total=False):
    ids: list[str]
    displayOptions: dict[str, bool]


class AssetListRequest(TypedDict, total=False):
    cursor: str
    limit: int
    page: int


class PriceFeedMetadata(TypedDict):
    id: str
    attributes: NotRequired[dict[str, str]]


class PricePoint(TypedDict):
    conf: str
    expo: int
    price: str
    publish_time: int


class ParsedPriceUpdate(TypedDict):
    ema_price: PricePoint
    id: str
    price: PricePoint
    metadata: NotRequired[dict[str, int]]


class BinaryUpdate(TypedDict):
    data: list[str]
    encoding: str


class PriceUpdateResponse(TypedDict):
    binary: BinaryUpdate
    parsed: NotRequired[list[ParsedPriceUpdate]]


class PriceStreamEvent(TypedDict):
    data: PriceUpdateResponse
    event: NotRequired[str]
    id: NotRequired[str]


class TokenBalance(TypedDict):
    max_tokens: int
    next_refill_at: str | None
    plan: Literal["business", "developer", "free", "pro"]
    remaining_tokens: int


class MonthlyApiKeyMethodUsage(TypedDict):
    count: float
    creditCost: float
    credits: float
    method: str
    updatedAt: str | None


class MonthlyApiKeyChainUsage(TypedDict):
    chain: str
    count: float
    credits: float
    methods: list[MonthlyApiKeyMethodUsage]
    updatedAt: str | None


class MonthlyApiKeyUsageEntry(TypedDict):
    apiKeyLast4: str
    apiKeyLength: float
    chains: list[MonthlyApiKeyChainUsage]
    count: float
    credits: float
    keyId: float | None
    updatedAt: str | None


class MonthlyApiKeyUsage(TypedDict):
    apiKeys: list[MonthlyApiKeyUsageEntry]
    chains: list[MonthlyApiKeyChainUsage]
    hasStrandedUsage: bool
    keyCount: float
    totalCount: float
    totalCredits: float
    updatedAt: str | None
    yearMonth: str


CloudResourceKind: TypeAlias = Literal["bare-metal", "solana-grpc", "solana-shredstream", "vps"]
CloudResourceMode: TypeAlias = Literal["dedicated", "direct", "shared"]


class CloudOffering(TypedDict):
    capabilities: list[str]
    description: str
    id: str
    kind: CloudResourceKind
    name: str
    regions: list[str]
    mode: NotRequired[CloudResourceMode]
    compute: NotRequired[dict[str, str]]
    solana: NotRequired[dict[str, str]]
    billing: NotRequired[dict[str, int | str]]


class CloudCredit(TypedDict):
    alertLevel: Literal["critical", "normal", "suspended", "warning"]
    balanceCents: int
    burnRateCentsPerHour: int
    quoteExpiresAt: str
    quoteTimestamp: str
    timeToZeroHours: float | None


class CloudResource(TypedDict):
    id: str
    kind: CloudResourceKind
    status: str
    mode: NotRequired[CloudResourceMode]
    name: NotRequired[str]
    region: NotRequired[str]
    createdAt: NotRequired[str]


class CloudResourceStatus(TypedDict):
    id: str
    status: str
    billing: NotRequired[dict[str, JsonValue]]
