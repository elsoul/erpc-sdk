"""Standalone Mayan Swift v2 EURC bridge client.

The bridge client is deliberately separate from :class:`ErpcClient`.  It
talks only to the explicitly configured Mayan builder and Explorer endpoints,
and returns unsigned, structurally checked provider output.  It does not sign,
submit, or verify settlement on behalf of a caller.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import json
import math
import re
import time
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, NoReturn, NotRequired, TypeAlias, TypedDict, TypeVar, cast
from urllib.parse import quote as url_quote
from urllib.parse import urlsplit, urlunsplit

import httpx

from ._bridge_capabilities_data import (
    BRIDGE_CAPABILITIES_AS_OF_DATE,
    BRIDGE_CAPABILITIES_CONTENT_DIGEST,
    BRIDGE_CAPABILITIES_JSON,
)
from .token_catalog import get_token_deployment
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions


class BridgeErrorCode(StrEnum):
    """Stable machine-readable bridge errors."""

    INVALID_ARGUMENT = "BRIDGE_INVALID_ARGUMENT"
    UNSUPPORTED_ROUTE = "BRIDGE_UNSUPPORTED_ROUTE"
    PROVIDER_AUTH_REQUIRED = "BRIDGE_PROVIDER_AUTH_REQUIRED"
    PROVIDER_TRANSPORT = "BRIDGE_PROVIDER_TRANSPORT"
    PROVIDER_HTTP = "BRIDGE_PROVIDER_HTTP"
    PROVIDER_INVALID_RESPONSE = "BRIDGE_PROVIDER_INVALID_RESPONSE"
    QUOTE_UNAVAILABLE = "BRIDGE_QUOTE_UNAVAILABLE"
    QUOTE_EXPIRED = "BRIDGE_QUOTE_EXPIRED"
    QUOTE_MISMATCH = "BRIDGE_QUOTE_MISMATCH"
    BUILD_INVALID = "BRIDGE_BUILD_INVALID"
    STATUS_NOT_FOUND = "BRIDGE_STATUS_NOT_FOUND"
    TIMEOUT = "BRIDGE_TIMEOUT"
    ABORTED = "BRIDGE_ABORTED"

    BRIDGE_INVALID_ARGUMENT = INVALID_ARGUMENT
    BRIDGE_UNSUPPORTED_ROUTE = UNSUPPORTED_ROUTE
    BRIDGE_PROVIDER_AUTH_REQUIRED = PROVIDER_AUTH_REQUIRED
    BRIDGE_PROVIDER_TRANSPORT = PROVIDER_TRANSPORT
    BRIDGE_PROVIDER_HTTP = PROVIDER_HTTP
    BRIDGE_PROVIDER_INVALID_RESPONSE = PROVIDER_INVALID_RESPONSE
    BRIDGE_QUOTE_UNAVAILABLE = QUOTE_UNAVAILABLE
    BRIDGE_QUOTE_EXPIRED = QUOTE_EXPIRED
    BRIDGE_QUOTE_MISMATCH = QUOTE_MISMATCH
    BRIDGE_BUILD_INVALID = BUILD_INVALID
    BRIDGE_STATUS_NOT_FOUND = STATUS_NOT_FOUND
    BRIDGE_TIMEOUT = TIMEOUT
    BRIDGE_ABORTED = ABORTED


BRIDGE_ERROR_MESSAGES: Final[dict[BridgeErrorCode, str]] = {
    BridgeErrorCode.INVALID_ARGUMENT: "Bridge request is invalid",
    BridgeErrorCode.UNSUPPORTED_ROUTE: "Bridge route is unsupported",
    BridgeErrorCode.PROVIDER_AUTH_REQUIRED: "Bridge provider authentication is required",
    BridgeErrorCode.PROVIDER_TRANSPORT: "Bridge provider transport failed",
    BridgeErrorCode.PROVIDER_HTTP: "Bridge provider HTTP request failed",
    BridgeErrorCode.PROVIDER_INVALID_RESPONSE: "Bridge provider response is invalid",
    BridgeErrorCode.QUOTE_UNAVAILABLE: "Bridge quote is unavailable",
    BridgeErrorCode.QUOTE_EXPIRED: "Bridge quote is expired",
    BridgeErrorCode.QUOTE_MISMATCH: "Bridge quote does not match the request",
    BridgeErrorCode.BUILD_INVALID: "Bridge provider build is invalid",
    BridgeErrorCode.STATUS_NOT_FOUND: "Bridge status was not found",
    BridgeErrorCode.TIMEOUT: "Bridge provider request timed out",
    BridgeErrorCode.ABORTED: "Bridge provider request was aborted",
}


class BridgeError(Exception):
    """Secret-free, stable error raised by the standalone bridge client."""

    code: BridgeErrorCode
    status: int | None

    def __init__(self, code: BridgeErrorCode, status: int | None = None) -> None:
        self.code = code
        self.status = status
        super().__init__(BRIDGE_ERROR_MESSAGES[code])


@dataclass(frozen=True, repr=False, slots=True)
class MayanSwiftV2BridgeConfig:
    """Configuration for a standalone Mayan Swift v2 client.

    Endpoint and credential validation is performed locally.  A caller-owned
    ``http_client`` is never closed by the bridge client.
    """

    builder_endpoint: str = "https://tx-builder.mayan.finance"
    explorer_endpoint: str = "https://explorer-api.mayan.finance/v3"
    builder_api_key: str | None = None
    allow_unauthenticated_build: bool = False
    minimum_quote_validity_seconds: int = 60
    timeout: int | float = 30
    http_client: httpx.AsyncClient | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "builder_endpoint", _normalize_provider_endpoint(self.builder_endpoint)
        )
        object.__setattr__(
            self, "explorer_endpoint", _normalize_provider_endpoint(self.explorer_endpoint)
        )
        object.__setattr__(self, "builder_api_key", _normalize_api_key(self.builder_api_key))
        if not isinstance(self.allow_unauthenticated_build, bool):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        if (
            isinstance(self.minimum_quote_validity_seconds, bool)
            or not isinstance(self.minimum_quote_validity_seconds, int)
            or self.minimum_quote_validity_seconds < 0
            or self.minimum_quote_validity_seconds > 300
        ):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        if (
            isinstance(self.timeout, bool)
            or not isinstance(self.timeout, (int, float))
            or not math.isfinite(float(self.timeout))
            or float(self.timeout) <= 0
        ):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        if self.http_client is not None and not hasattr(self.http_client, "send"):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        object.__setattr__(
            self, "minimum_quote_validity_seconds", self.minimum_quote_validity_seconds
        )
        object.__setattr__(self, "timeout", float(self.timeout))

    def __repr__(self) -> str:
        key = "[REDACTED]" if self.builder_api_key is not None else None
        client = "[configured]" if self.http_client is not None else None
        return (
            "MayanSwiftV2BridgeConfig("
            f"builder_endpoint={self.builder_endpoint!r}, "
            f"explorer_endpoint={self.explorer_endpoint!r}, "
            f"builder_api_key={key!r}, "
            f"allow_unauthenticated_build={self.allow_unauthenticated_build!r}, "
            f"minimum_quote_validity_seconds={self.minimum_quote_validity_seconds!r}, "
            f"timeout={self.timeout!r}, http_client={client!r})"
        )


class BridgeRequestOptions(TypedDict, total=False):
    """Reserved request-options shape for callers that use mapping options."""

    cancel_event: object


class MayanSwiftV2QuoteRequest(TypedDict):
    sourceChainId: str
    destinationChainId: str
    sourceTokenDeploymentId: str
    destinationTokenDeploymentId: str
    amountIn: str
    slippageBps: int


class MayanSwiftV2SourceSwap(TypedDict):
    required: bool
    inputTokenDeploymentId: str
    intermediateTokenDeploymentId: str
    intermediateTokenAddress: str
    intermediateTokenStandard: str
    intermediateTokenDecimals: int
    providerMinimumAmount: str
    routerKind: str
    routerAddress: str


class MayanSwiftV2Quote(TypedDict):
    quoteKind: str
    providerId: str
    sourceChainId: str
    destinationChainId: str
    sourceTokenDeploymentId: str
    destinationTokenDeploymentId: str
    amountIn: str
    expectedAmountOut: str
    minimumAmountOut: str
    minimumReceived: str
    deadline: str
    slippageBps: int
    quoteId: str
    providerSignature: str
    sourceSwap: MayanSwiftV2SourceSwap
    dependencies: list[str]
    quoteVerification: str
    rawSignedQuoteJson: str


MayanEvmUnsignedTransaction = TypedDict(
    "MayanEvmUnsignedTransaction",
    {
        "kind": str,
        "chainId": str,
        "from": str,
        "to": str,
        "data": str,
        "value": str,
    },
)


class MayanSolanaUnsignedTransaction(TypedDict):
    kind: str
    chainId: str
    feePayer: str
    transactionBase64: str


MayanSwiftV2UnsignedTransaction: TypeAlias = (
    MayanEvmUnsignedTransaction | MayanSolanaUnsignedTransaction
)


class MayanSwiftV2BuildValidation(TypedDict):
    level: str
    quoteSignatureLocallyVerified: bool
    transactionSemanticsLocallyVerified: bool
    settlementLocallyVerified: bool


class MayanSwiftV2Allowance(TypedDict):
    tokenDeploymentId: str
    tokenAddress: str
    owner: str
    spender: str
    requiredAmount: str


class MayanSwiftV2Build(TypedDict):
    buildKind: str
    providerId: str
    quote: MayanSwiftV2Quote
    sourceChainId: str
    destinationChainId: str
    transaction: dict[str, object]
    allowance: MayanSwiftV2Allowance | None
    validation: MayanSwiftV2BuildValidation
    rawProviderBuildJson: str


class MayanSwiftV2BuildRequest(TypedDict):
    quote: MayanSwiftV2Quote
    swapperAddress: str
    destinationAddress: str
    refundAddress: NotRequired[str]


MayanSwiftV2BuildUnsignedRequest = MayanSwiftV2BuildRequest


class MayanSwiftV2StatusRequest(TypedDict):
    sourceChainId: str
    sourceTransactionHash: str


class MayanSwiftV2Status(TypedDict):
    statusKind: str
    providerId: str
    sourceChainId: str
    sourceTransactionHash: str
    state: str
    providerClientStatus: str
    providerStatus: str | None
    statusVerification: str
    rawProviderStatusJson: str


MayanSwiftV2QuoteResult = list[MayanSwiftV2Quote]
MayanSwiftV2BuildResult = MayanSwiftV2Build
MayanSwiftV2StatusResult = MayanSwiftV2Status


ETHEREUM_CHAIN_ID: Final = "eip155:1"
SOLANA_CHAIN_ID: Final = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
ETHEREUM_NAME: Final = "ethereum"
SOLANA_NAME: Final = "solana"
ETHEREUM_EURC_DEPLOYMENT_ID: Final = "deployment-0011"
SOLANA_EURC_DEPLOYMENT_ID: Final = "deployment-0013"
ETHEREUM_USDC_DEPLOYMENT_ID: Final = "deployment-0008"
SOLANA_USDC_DEPLOYMENT_ID: Final = "deployment-0010"
ETHEREUM_EURC_ADDRESS: Final = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c"
SOLANA_EURC_ADDRESS: Final = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"
ETHEREUM_USDC_ADDRESS: Final = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
SOLANA_USDC_ADDRESS: Final = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
ETHEREUM_SWIFT_CONTRACT: Final = "0x40ffe85a28dc9993541449464d7529a922142960"
SOLANA_SWIFT_PROGRAM: Final = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny"
ETHEREUM_FORWARDER: Final = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2"
SOLANA_JUPITER_V6: Final = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
ETHEREUM_FORWARDER_SELECTOR: Final = "0x30dedc57"
DEFAULT_BUILDER_ENDPOINT: Final = "https://tx-builder.mayan.finance"
DEFAULT_EXPLORER_ENDPOINT: Final = "https://explorer-api.mayan.finance/v3"
DEFAULT_TIMEOUT: Final = 30.0
MAX_RESPONSE_BYTES: Final = 1024 * 1024
MAX_RAW_QUOTE_BYTES: Final = 256 * 1024
MAX_JSON_DEPTH: Final = 32
MAX_QUOTES: Final = 16
UINT64_MAX: Final = (1 << 64) - 1
MAX_SAFE_INTEGER: Final = (1 << 53) - 1
BASE58_ALPHABET: Final = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BASE58_INDEX: Final = {character: index for index, character in enumerate(BASE58_ALPHABET)}
BASE_DEPENDENCIES: Final = [
    "mayan-hosted-quote-api",
    "mayan-hosted-transaction-builder",
    "mayan-hosted-source-swap-builder",
    "swift-auction-solvers",
    "relayers",
    "wormhole-guardian-messaging",
    "mayan-explorer-indexer",
]

_EVM_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
_EVM_HASH_RE = re.compile(r"0x[0-9a-fA-F]{64}")
_QUOTE_ID_RE = re.compile(r"0x[0-9a-fA-F]{32}")
_EVM_SIGNATURE_RE = re.compile(r"0x[0-9a-fA-F]{130}")
_HEX_BYTES_RE = re.compile(r"0x[0-9a-fA-F]*")
_POSITIVE_UINT64_RE = re.compile(r"[1-9][0-9]*")
_CANONICAL_UINT64_RE = re.compile(r"(?:0|[1-9][0-9]*)")
_NUMBER_RE = re.compile(
    r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
)
_CONFIG_KEYS = {
    "builder_endpoint",
    "explorer_endpoint",
    "builder_api_key",
    "allow_unauthenticated_build",
    "minimum_quote_validity_seconds",
    "timeout",
    "http_client",
    "builderEndpoint",
    "explorerEndpoint",
    "builderApiKey",
    "allowUnauthenticatedBuild",
    "minimumQuoteValiditySeconds",
    "timeoutMs",
    "httpClient",
}
_QUOTE_KEYS: Final[tuple[str, ...]] = (
    "quoteKind",
    "providerId",
    "sourceChainId",
    "destinationChainId",
    "sourceTokenDeploymentId",
    "destinationTokenDeploymentId",
    "amountIn",
    "expectedAmountOut",
    "minimumAmountOut",
    "minimumReceived",
    "deadline",
    "slippageBps",
    "quoteId",
    "providerSignature",
    "sourceSwap",
    "dependencies",
    "quoteVerification",
    "rawSignedQuoteJson",
)
_SOURCE_SWAP_KEYS: Final[tuple[str, ...]] = (
    "required",
    "inputTokenDeploymentId",
    "intermediateTokenDeploymentId",
    "intermediateTokenAddress",
    "intermediateTokenStandard",
    "intermediateTokenDecimals",
    "providerMinimumAmount",
    "routerKind",
    "routerAddress",
)


def _fail(code: BridgeErrorCode, status: int | None = None) -> NoReturn:
    raise BridgeError(code, status) from None


def _is_mapping(value: object) -> bool:
    return isinstance(value, Mapping)


def _mapping(value: object, code: BridgeErrorCode) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        _fail(code)
    result = cast(Mapping[object, object], value)
    if any(not isinstance(key, str) for key in result):
        _fail(code)
    return cast(Mapping[str, object], result)


def _require_string(value: object, code: BridgeErrorCode, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        _fail(code)
    return value


def _exact_keys(
    value: Mapping[str, object], expected: tuple[str, ...], code: BridgeErrorCode
) -> None:
    if set(value) != set(expected) or len(value) != len(expected):
        _fail(code)


def _normalize_evm_address(value: object, code: BridgeErrorCode) -> str:
    address = _require_string(value, code)
    if _EVM_ADDRESS_RE.fullmatch(address) is None or address.lower() == "0x" + "0" * 40:
        _fail(code)
    return address.lower()


def _normalize_positive_uint64(
    value: object, code: BridgeErrorCode
) -> tuple[str, int]:
    source = _require_string(value, code)
    if len(source) > 20 or _POSITIVE_UINT64_RE.fullmatch(source) is None:
        _fail(code)
    parsed = int(source, 10)
    if parsed <= 0 or parsed > UINT64_MAX:
        _fail(code)
    return source, parsed


def _normalize_canonical_uint64(
    value: object, code: BridgeErrorCode
) -> tuple[str, int]:
    source = _require_string(value, code)
    if len(source) > 20 or _CANONICAL_UINT64_RE.fullmatch(source) is None:
        _fail(code)
    parsed = int(source, 10)
    if parsed > UINT64_MAX:
        _fail(code)
    return source, parsed


def _normalize_slippage(value: object, code: BridgeErrorCode) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 500:
        _fail(code)
    return value


@dataclass(frozen=True, slots=True)
class _DirectionFacts:
    bridge_capability_id: str
    source_chain_id: str
    destination_chain_id: str
    source_token_deployment_id: str
    destination_token_deployment_id: str
    source_token_address: str
    destination_token_address: str
    source_token_standard: str
    destination_token_standard: str
    source_provider_chain_id: int
    destination_provider_chain_id: int
    source_wormhole_chain_id: int
    destination_wormhole_chain_id: int
    source_name: str
    destination_name: str
    source_eurc_mint: str
    destination_eurc_mint: str
    source_usdc_deployment_id: str
    source_usdc_address: str
    source_usdc_standard: str
    swift_contract: str


@dataclass(frozen=True, slots=True)
class _NormalizedRoute:
    request: dict[str, object]
    facts: _DirectionFacts
    capability: Mapping[str, object]


def _direction_facts(source_chain_id: str, destination_chain_id: str) -> _DirectionFacts:
    if source_chain_id == ETHEREUM_CHAIN_ID and destination_chain_id == SOLANA_CHAIN_ID:
        return _DirectionFacts(
            "bridge-mayan-swift-v2-eurc-eth-sol",
            source_chain_id,
            destination_chain_id,
            ETHEREUM_EURC_DEPLOYMENT_ID,
            SOLANA_EURC_DEPLOYMENT_ID,
            ETHEREUM_EURC_ADDRESS,
            SOLANA_EURC_ADDRESS,
            "erc20",
            "spl-token",
            1,
            0,
            2,
            1,
            ETHEREUM_NAME,
            SOLANA_NAME,
            "",
            SOLANA_EURC_ADDRESS,
            ETHEREUM_USDC_DEPLOYMENT_ID,
            ETHEREUM_USDC_ADDRESS,
            "erc20",
            ETHEREUM_SWIFT_CONTRACT,
        )
    if source_chain_id == SOLANA_CHAIN_ID and destination_chain_id == ETHEREUM_CHAIN_ID:
        return _DirectionFacts(
            "bridge-mayan-swift-v2-eurc-sol-eth",
            source_chain_id,
            destination_chain_id,
            SOLANA_EURC_DEPLOYMENT_ID,
            ETHEREUM_EURC_DEPLOYMENT_ID,
            SOLANA_EURC_ADDRESS,
            ETHEREUM_EURC_ADDRESS,
            "spl-token",
            "erc20",
            0,
            1,
            1,
            2,
            SOLANA_NAME,
            ETHEREUM_NAME,
            SOLANA_EURC_ADDRESS,
            "",
            SOLANA_USDC_DEPLOYMENT_ID,
            SOLANA_USDC_ADDRESS,
            "spl-token",
            SOLANA_SWIFT_PROGRAM,
        )
    _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)


def _catalog_token_matches(
    deployment_id: str,
    chain_id: str,
    address: str,
    standard: str,
) -> bool:
    token = get_token_deployment(deployment_id)
    if token is None or token.status != "active" or token.address is None:
        return False
    address_matches = (
        token.address.lower() == address.lower()
        if chain_id == ETHEREUM_CHAIN_ID
        else token.address == address
    )
    return (
        token.deployment_id == deployment_id
        and token.chain_id == chain_id
        and address_matches
        and token.standard == standard
        and token.decimals == 6
    )


def _capability_records() -> tuple[Mapping[str, object], ...]:
    try:
        parsed = json.loads(BRIDGE_CAPABILITIES_JSON)
    except (TypeError, ValueError):
        return ()
    if not isinstance(parsed, list):
        return ()
    return tuple(
        cast(Mapping[str, object], entry) for entry in parsed if isinstance(entry, Mapping)
    )


_BRIDGE_CAPABILITIES: Final[tuple[Mapping[str, object], ...]] = _capability_records()


def _validate_capability(facts: _DirectionFacts) -> Mapping[str, object]:
    capability: Mapping[str, object] | None = None
    for entry in _BRIDGE_CAPABILITIES:
        if (
            entry.get("bridgeCapabilityId") == facts.bridge_capability_id
            and entry.get("sourceChainId") == facts.source_chain_id
            and entry.get("destinationChainId") == facts.destination_chain_id
            and entry.get("sourceTokenDeploymentId") == facts.source_token_deployment_id
            and entry.get("destinationTokenDeploymentId") == facts.destination_token_deployment_id
        ):
            capability = entry
            break
    if capability is None:
        _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)
    expected: dict[str, object] = {
        "bridgeCapabilityId": facts.bridge_capability_id,
        "providerId": "mayan-swift-v2",
        "capabilityKind": "external-provider-dynamic",
        "sourceChainId": facts.source_chain_id,
        "destinationChainId": facts.destination_chain_id,
        "sourceTokenDeploymentId": facts.source_token_deployment_id,
        "destinationTokenDeploymentId": facts.destination_token_deployment_id,
        "sourceTokenAddress": facts.source_token_address,
        "destinationTokenAddress": facts.destination_token_address,
        "sourceTokenStandard": facts.source_token_standard,
        "destinationTokenStandard": facts.destination_token_standard,
        "sourceTokenDecimals": 6,
        "destinationTokenDecimals": 6,
        "sourceProviderChainName": facts.source_name,
        "destinationProviderChainName": facts.destination_name,
        "sourceProviderChainId": facts.source_provider_chain_id,
        "destinationProviderChainId": facts.destination_provider_chain_id,
        "sourceWormholeChainId": facts.source_wormhole_chain_id,
        "destinationWormholeChainId": facts.destination_wormhole_chain_id,
        "sourceUsdcDeploymentId": facts.source_usdc_deployment_id,
        "sourceUsdcAddress": facts.source_usdc_address,
        "sourceUsdcStandard": facts.source_usdc_standard,
        "sourceUsdcDecimals": 6,
        "swiftContract": facts.swift_contract,
        "forwarderAddress": (
            ETHEREUM_FORWARDER if facts.source_chain_id == ETHEREUM_CHAIN_ID else None
        ),
        "forwarderFunctionSelector": (
            ETHEREUM_FORWARDER_SELECTOR
            if facts.source_chain_id == ETHEREUM_CHAIN_ID
            else None
        ),
        "jupiterProgramAddress": (
            SOLANA_JUPITER_V6 if facts.source_chain_id == SOLANA_CHAIN_ID else None
        ),
        "builderEndpoint": DEFAULT_BUILDER_ENDPOINT,
        "explorerEndpoint": DEFAULT_EXPLORER_ENDPOINT,
        "dependencies": [
            *BASE_DEPENDENCIES,
            *( ["jupiter-v6-source-swap"] if facts.source_chain_id == SOLANA_CHAIN_ID else []),
        ],
        "status": "active",
    }
    if not _strict_equal(dict(capability), expected):
        _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)
    return capability


def _validate_route(value: object) -> _NormalizedRoute:
    request = _mapping(value, BridgeErrorCode.INVALID_ARGUMENT)
    expected_keys = (
        "sourceChainId",
        "destinationChainId",
        "sourceTokenDeploymentId",
        "destinationTokenDeploymentId",
        "amountIn",
        "slippageBps",
    )
    _exact_keys(request, expected_keys, BridgeErrorCode.INVALID_ARGUMENT)
    source_chain_id = _require_string(request["sourceChainId"], BridgeErrorCode.INVALID_ARGUMENT)
    destination_chain_id = _require_string(
        request["destinationChainId"], BridgeErrorCode.INVALID_ARGUMENT
    )
    source_token_id = _require_string(
        request["sourceTokenDeploymentId"], BridgeErrorCode.INVALID_ARGUMENT
    )
    destination_token_id = _require_string(
        request["destinationTokenDeploymentId"], BridgeErrorCode.INVALID_ARGUMENT
    )
    amount_text, _ = _normalize_positive_uint64(
        request["amountIn"], BridgeErrorCode.INVALID_ARGUMENT
    )
    slippage = _normalize_slippage(request["slippageBps"], BridgeErrorCode.INVALID_ARGUMENT)
    facts = _direction_facts(source_chain_id, destination_chain_id)
    if (
        source_token_id != facts.source_token_deployment_id
        or destination_token_id != facts.destination_token_deployment_id
    ):
        _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)
    if not (
        _catalog_token_matches(
            facts.source_token_deployment_id,
            facts.source_chain_id,
            facts.source_token_address,
            facts.source_token_standard,
        )
        and _catalog_token_matches(
            facts.destination_token_deployment_id,
            facts.destination_chain_id,
            facts.destination_token_address,
            facts.destination_token_standard,
        )
        and _catalog_token_matches(
            facts.source_usdc_deployment_id,
            facts.source_chain_id,
            facts.source_usdc_address,
            facts.source_usdc_standard,
        )
    ):
        _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)
    capability = _validate_capability(facts)
    return _NormalizedRoute(
        {
            "sourceChainId": source_chain_id,
            "destinationChainId": destination_chain_id,
            "sourceTokenDeploymentId": source_token_id,
            "destinationTokenDeploymentId": destination_token_id,
            "amountIn": amount_text,
            "slippageBps": slippage,
        },
        facts,
        capability,
    )


@dataclass(frozen=True, slots=True)
class _JsonNode:
    value: object
    start: int
    end: int
    object_entries: dict[str, _JsonNode] | None = None
    array_items: list[_JsonNode] | None = None
    raw_number: str | None = None


class _StrictJsonParser:
    def __init__(self, source: str) -> None:
        self._source = source
        self._index = 0

    def parse(self) -> _JsonNode:
        self._skip_whitespace()
        result = self._value(0)
        self._skip_whitespace()
        if self._index != len(self._source):
            self._invalid()
        return result

    def _value(self, depth: int) -> _JsonNode:
        if depth > MAX_JSON_DEPTH:
            self._invalid()
        start = self._index
        character = self._source[self._index : self._index + 1]
        if character == "{":
            return self._object(start, depth)
        if character == "[":
            return self._array(start, depth)
        if character == '"':
            return _JsonNode(self._string(), start, self._index)
        if self._source.startswith("true", self._index):
            self._index += 4
            return _JsonNode(True, start, self._index)
        if self._source.startswith("false", self._index):
            self._index += 5
            return _JsonNode(False, start, self._index)
        if self._source.startswith("null", self._index):
            self._index += 4
            return _JsonNode(None, start, self._index)
        match = _NUMBER_RE.match(self._source, self._index)
        if match is not None:
            raw = match.group(0)
            self._index = match.end()
            conversion_failed = False
            try:
                if "." in raw or "e" in raw.lower():
                    number: object = float(raw)
                else:
                    # Check the conversion against JavaScript Number's finite
                    # range even though Python integers have arbitrary size.
                    if not math.isfinite(float(raw)):
                        self._invalid()
                    number = int(raw, 10)
            except (OverflowError, ValueError):
                conversion_failed = True
                number = 0
            if conversion_failed:
                self._invalid()
            if isinstance(number, float) and not math.isfinite(number):
                self._invalid()
            return _JsonNode(number, start, self._index, raw_number=raw)
        self._invalid()

    def _object(self, start: int, depth: int) -> _JsonNode:
        self._index += 1
        self._skip_whitespace()
        values: dict[str, object] = {}
        entries: dict[str, _JsonNode] = {}
        if self._source[self._index : self._index + 1] == "}":
            self._index += 1
            return _JsonNode(values, start, self._index, object_entries=entries)
        while True:
            if self._source[self._index : self._index + 1] != '"':
                self._invalid()
            key = self._string()
            if key in entries:
                self._invalid()
            self._skip_whitespace()
            if self._source[self._index : self._index + 1] != ":":
                self._invalid()
            self._index += 1
            self._skip_whitespace()
            child = self._value(depth + 1)
            values[key] = child.value
            entries[key] = child
            self._skip_whitespace()
            delimiter = self._source[self._index : self._index + 1]
            if delimiter == "}":
                self._index += 1
                return _JsonNode(values, start, self._index, object_entries=entries)
            if delimiter != ",":
                self._invalid()
            self._index += 1
            self._skip_whitespace()

    def _array(self, start: int, depth: int) -> _JsonNode:
        self._index += 1
        self._skip_whitespace()
        values: list[object] = []
        entries: list[_JsonNode] = []
        if self._source[self._index : self._index + 1] == "]":
            self._index += 1
            return _JsonNode(values, start, self._index, array_items=entries)
        while True:
            child = self._value(depth + 1)
            values.append(child.value)
            entries.append(child)
            self._skip_whitespace()
            delimiter = self._source[self._index : self._index + 1]
            if delimiter == "]":
                self._index += 1
                return _JsonNode(values, start, self._index, array_items=entries)
            if delimiter != ",":
                self._invalid()
            self._index += 1
            self._skip_whitespace()

    def _string(self) -> str:
        start = self._index
        self._index += 1
        while self._index < len(self._source):
            character = self._source[self._index]
            if character == '"':
                self._index += 1
                raw = self._source[start : self._index]
                parse_failed = False
                try:
                    parsed = json.loads(raw)
                except (TypeError, ValueError):
                    parse_failed = True
                    parsed = None
                if parse_failed:
                    self._invalid()
                if not isinstance(parsed, str):
                    self._invalid()
                return parsed
            if character == "\\":
                self._index += 1
                if self._index >= len(self._source):
                    self._invalid()
                escape = self._source[self._index]
                if escape == "u":
                    digits = self._source[self._index + 1 : self._index + 5]
                    if re.fullmatch(r"[0-9a-fA-F]{4}", digits) is None:
                        self._invalid()
                    self._index += 5
                    continue
                if escape not in '"\\/bfnrt':
                    self._invalid()
                self._index += 1
                continue
            if ord(character) < 0x20:
                self._invalid()
            self._index += 1
        self._invalid()

    def _skip_whitespace(self) -> None:
        while self._index < len(self._source) and self._source[self._index] in " \n\r\t":
            self._index += 1

    def _invalid(self) -> NoReturn:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)


def _parse_provider_response(text: str) -> _JsonNode:
    return _StrictJsonParser(text).parse()


def _object_entry(node: _JsonNode, key: str) -> _JsonNode | None:
    return node.object_entries.get(key) if node.object_entries is not None else None


def _object_value(node: _JsonNode, key: str) -> object:
    child = _object_entry(node, key)
    return child.value if child is not None else _MISSING


_MISSING = object()


def _required_node(node: _JsonNode, key: str) -> _JsonNode:
    child = _object_entry(node, key)
    if child is None:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return child


def _provider_string(node: _JsonNode, key: str, *, allow_empty: bool = False) -> str:
    value = _required_node(node, key).value
    if not isinstance(value, str) or (not allow_empty and not value):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return value


def _provider_boolean(node: _JsonNode, key: str) -> bool:
    value = _required_node(node, key).value
    if not isinstance(value, bool):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return value


def _provider_number(node: _JsonNode, key: str) -> int | float:
    value = _required_node(node, key).value
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return value


def _provider_integer(node: _JsonNode, key: str) -> int:
    value = _provider_number(node, key)
    if isinstance(value, float) and not value.is_integer():
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if isinstance(value, int) and abs(value) > MAX_SAFE_INTEGER:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if int(value) > MAX_SAFE_INTEGER or int(value) < -MAX_SAFE_INTEGER:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return int(value)


def _provider_uint64(node: _JsonNode, key: str, *, positive: bool) -> tuple[str, int]:
    value = _required_node(node, key).value
    return (
        _normalize_positive_uint64(value, BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
        if positive
        else _normalize_canonical_uint64(value, BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    )


def _provider_address_matches(value: object, expected: str) -> bool:
    if not isinstance(value, str):
        return False
    if _EVM_ADDRESS_RE.fullmatch(value) is not None:
        return value.lower() == expected.lower()
    return value == expected


def _provider_address(node: _JsonNode, key: str, expected: str) -> str:
    value = _provider_string(node, key)
    if not _provider_address_matches(value, expected):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return value.lower() if _EVM_ADDRESS_RE.fullmatch(value) is not None else value


def _provider_token(
    node: _JsonNode,
    *,
    address: str,
    standard: str,
    chain_id: int,
    wormhole_chain_id: int,
    mint: str,
) -> None:
    if node.object_entries is None:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if not _provider_address_matches(_provider_string(node, "contract"), address):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "mint", allow_empty=True) != mint:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if not _provider_address_matches(_provider_string(node, "realOriginContractAddress"), address):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "name") != "EuroC":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "standard") != standard:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "chainId") != chain_id:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "wChainId") != wormhole_chain_id:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "realOriginChainId") != wormhole_chain_id:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "decimals") != 6:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)


def _ensure_quote_deadline(deadline: int, margin: int) -> None:
    now = int(time.time())
    if deadline < now + margin:
        _fail(BridgeErrorCode.QUOTE_EXPIRED)


def _validate_provider_quote(
    node: _JsonNode,
    text: str,
    request: Mapping[str, object],
    facts: _DirectionFacts,
    config: _NormalizedBridgeConfig,
) -> MayanSwiftV2Quote:
    if node.object_entries is None or not isinstance(node.value, Mapping):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    raw = text[node.start : node.end]
    if len(raw.encode("utf-8")) > MAX_RAW_QUOTE_BYTES:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "type") != "SWIFT":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "swiftVersion") != "V2":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_boolean(node, "gasless"):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "fromChain") != facts.source_name:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "toChain") != facts.destination_name:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "slippageBps") != request["slippageBps"]:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_boolean(node, "onlyBridging"):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    effective_amount, _ = _provider_uint64(node, "effectiveAmountIn64", positive=True)
    if effective_amount != request["amountIn"]:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    expected_amount, expected_value = _provider_uint64(
        node, "expectedAmountOutBaseUnits", positive=True
    )
    minimum_amount, minimum_value = _provider_uint64(
        node, "minAmountOutBaseUnits", positive=True
    )
    minimum_received, minimum_received_value = _provider_uint64(
        node, "minReceivedBaseUnits", positive=True
    )
    if minimum_value > expected_value or minimum_received_value > minimum_value:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    deadline, deadline_value = _provider_uint64(node, "deadline64", positive=True)
    _ensure_quote_deadline(deadline_value, config.minimum_quote_validity_seconds)

    source_token = _required_node(node, "fromToken")
    destination_token = _required_node(node, "toToken")
    _provider_token(
        source_token,
        address=facts.source_token_address,
        standard="erc20" if facts.source_chain_id == ETHEREUM_CHAIN_ID else "spl",
        chain_id=facts.source_provider_chain_id,
        wormhole_chain_id=facts.source_wormhole_chain_id,
        mint=facts.source_eurc_mint,
    )
    _provider_token(
        destination_token,
        address=facts.destination_token_address,
        standard="erc20" if facts.destination_chain_id == ETHEREUM_CHAIN_ID else "spl",
        chain_id=facts.destination_provider_chain_id,
        wormhole_chain_id=facts.destination_wormhole_chain_id,
        mint=facts.destination_eurc_mint,
    )
    source_provider_standard = "erc20" if facts.source_chain_id == ETHEREUM_CHAIN_ID else "spl"
    if (
        _provider_address(node, "swiftInputContract", facts.source_usdc_address)
        != facts.source_usdc_address
    ):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "swiftInputContractStandard") != source_provider_standard:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(node, "swiftInputDecimals") != 6:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_address(node, "swiftMayanContract", facts.swift_contract) != facts.swift_contract:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)

    middle_node = _required_node(node, "minMiddleAmount")
    if (
        middle_node.raw_number is None
        or isinstance(middle_node.value, bool)
        or not isinstance(middle_node.value, (int, float))
        or not math.isfinite(float(middle_node.value))
        or float(middle_node.value) <= 0
    ):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)

    if facts.source_chain_id == ETHEREUM_CHAIN_ID:
        router_address = _normalize_evm_address(
            _provider_string(node, "evmSwapRouterAddress"),
            BridgeErrorCode.PROVIDER_INVALID_RESPONSE,
        )
        router_kind = "provider-selected-evm"
    else:
        router_address = SOLANA_JUPITER_V6
        router_kind = "jupiter-v6"
        evm_router = _object_value(node, "evmSwapRouterAddress")
        if evm_router is not _MISSING and evm_router is not None:
            _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)

    quote_id = _provider_string(node, "quoteId")
    if _QUOTE_ID_RE.fullmatch(quote_id) is None:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    signature = _provider_string(node, "signature")
    if _EVM_SIGNATURE_RE.fullmatch(signature) is None:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)

    dependencies = [
        *BASE_DEPENDENCIES,
        *( ["jupiter-v6-source-swap"] if facts.source_chain_id == SOLANA_CHAIN_ID else []),
    ]
    quote: MayanSwiftV2Quote = {
        "quoteKind": "mayan-swift-v2",
        "providerId": "mayan-swift-v2",
        "sourceChainId": facts.source_chain_id,
        "destinationChainId": facts.destination_chain_id,
        "sourceTokenDeploymentId": facts.source_token_deployment_id,
        "destinationTokenDeploymentId": facts.destination_token_deployment_id,
        "amountIn": effective_amount,
        "expectedAmountOut": expected_amount,
        "minimumAmountOut": minimum_amount,
        "minimumReceived": minimum_received,
        "deadline": deadline,
        "slippageBps": request["slippageBps"],
        "quoteId": quote_id.lower(),
        "providerSignature": signature.lower(),
        "sourceSwap": {
            "required": True,
            "inputTokenDeploymentId": facts.source_token_deployment_id,
            "intermediateTokenDeploymentId": facts.source_usdc_deployment_id,
            "intermediateTokenAddress": facts.source_usdc_address,
            "intermediateTokenStandard": source_provider_standard,
            "intermediateTokenDecimals": 6,
            "providerMinimumAmount": middle_node.raw_number,
            "routerKind": router_kind,
            "routerAddress": router_address,
        },
        "dependencies": dependencies,
        "quoteVerification": "provider-signed-not-locally-verified",
        "rawSignedQuoteJson": raw,
    }
    return quote


def _strict_equal(left: object, right: object) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        if set(left) != set(right):
            return False
        return all(_strict_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _strict_equal(a, b) for a, b in zip(left, right, strict=True)
        )
    return left == right


def _validate_normalized_quote_shape(value: object, code: BridgeErrorCode) -> MayanSwiftV2Quote:
    quote = _mapping(value, code)
    _exact_keys(quote, _QUOTE_KEYS, code)
    if quote["quoteKind"] != "mayan-swift-v2" or quote["providerId"] != "mayan-swift-v2":
        _fail(code)
    source_chain = _require_string(quote["sourceChainId"], code)
    destination_chain = _require_string(quote["destinationChainId"], code)
    facts = _direction_facts(source_chain, destination_chain)
    if (
        quote["sourceTokenDeploymentId"] != facts.source_token_deployment_id
        or quote["destinationTokenDeploymentId"] != facts.destination_token_deployment_id
    ):
        _fail(code)
    amount, amount_value = _normalize_positive_uint64(quote["amountIn"], code)
    expected_amount, expected_value = _normalize_positive_uint64(quote["expectedAmountOut"], code)
    minimum_amount, minimum_value = _normalize_positive_uint64(quote["minimumAmountOut"], code)
    minimum_received, minimum_received_value = _normalize_positive_uint64(
        quote["minimumReceived"], code
    )
    if minimum_value > expected_value or minimum_received_value > minimum_value:
        _fail(code)
    deadline, _ = _normalize_positive_uint64(quote["deadline"], code)
    slippage = _normalize_slippage(quote["slippageBps"], code)
    if quote["quoteVerification"] != "provider-signed-not-locally-verified":
        _fail(code)
    quote_id = _require_string(quote["quoteId"], code)
    if _QUOTE_ID_RE.fullmatch(quote_id) is None:
        _fail(code)
    signature = _require_string(quote["providerSignature"], code)
    if _EVM_SIGNATURE_RE.fullmatch(signature) is None:
        _fail(code)
    source_swap = _mapping(quote["sourceSwap"], code)
    _exact_keys(source_swap, _SOURCE_SWAP_KEYS, code)
    if source_swap["required"] is not True:
        _fail(code)
    if (
        source_swap["inputTokenDeploymentId"] != facts.source_token_deployment_id
        or source_swap["intermediateTokenDeploymentId"] != facts.source_usdc_deployment_id
        or source_swap["intermediateTokenAddress"] != facts.source_usdc_address
        or source_swap["intermediateTokenStandard"]
        != ("erc20" if facts.source_chain_id == ETHEREUM_CHAIN_ID else "spl")
        or source_swap["intermediateTokenDecimals"] != 6
    ):
        _fail(code)
    provider_minimum = source_swap["providerMinimumAmount"]
    if not isinstance(provider_minimum, str) or not provider_minimum:
        _fail(code)
    if facts.source_chain_id == ETHEREUM_CHAIN_ID:
        router_address = source_swap["routerAddress"]
        if (
            source_swap["routerKind"] != "provider-selected-evm"
            or not isinstance(router_address, str)
            or _EVM_ADDRESS_RE.fullmatch(router_address) is None
            or router_address.lower() == "0x" + "0" * 40
        ):
            _fail(code)
        normalized_router = router_address.lower()
        router_kind = "provider-selected-evm"
    else:
        if (
            source_swap["routerKind"] != "jupiter-v6"
            or source_swap["routerAddress"] != SOLANA_JUPITER_V6
        ):
            _fail(code)
        normalized_router = SOLANA_JUPITER_V6
        router_kind = "jupiter-v6"
    dependencies = [
        *BASE_DEPENDENCIES,
        *( ["jupiter-v6-source-swap"] if facts.source_chain_id == SOLANA_CHAIN_ID else []),
    ]
    if not _strict_equal(quote["dependencies"], dependencies):
        _fail(code)
    raw = _require_string(quote["rawSignedQuoteJson"], code)
    if len(raw.encode("utf-8")) > MAX_RAW_QUOTE_BYTES:
        _fail(code)
    normalized: MayanSwiftV2Quote = {
        "quoteKind": "mayan-swift-v2",
        "providerId": "mayan-swift-v2",
        "sourceChainId": source_chain,
        "destinationChainId": destination_chain,
        "sourceTokenDeploymentId": facts.source_token_deployment_id,
        "destinationTokenDeploymentId": facts.destination_token_deployment_id,
        "amountIn": amount,
        "expectedAmountOut": expected_amount,
        "minimumAmountOut": minimum_amount,
        "minimumReceived": minimum_received,
        "deadline": deadline,
        "slippageBps": slippage,
        "quoteId": quote_id.lower(),
        "providerSignature": signature.lower(),
        "sourceSwap": {
            "required": True,
            "inputTokenDeploymentId": facts.source_token_deployment_id,
            "intermediateTokenDeploymentId": facts.source_usdc_deployment_id,
            "intermediateTokenAddress": facts.source_usdc_address,
            "intermediateTokenStandard": (
                "erc20" if facts.source_chain_id == ETHEREUM_CHAIN_ID else "spl"
            ),
            "intermediateTokenDecimals": 6,
            "providerMinimumAmount": provider_minimum,
            "routerKind": router_kind,
            "routerAddress": normalized_router,
        },
        "dependencies": dependencies,
        "quoteVerification": "provider-signed-not-locally-verified",
        "rawSignedQuoteJson": raw,
    }
    return normalized


def _quote_from_response(
    root: _JsonNode,
    text: str,
    request: Mapping[str, object],
    facts: _DirectionFacts,
    config: _NormalizedBridgeConfig,
) -> list[MayanSwiftV2Quote]:
    if root.object_entries is None or not isinstance(root.value, Mapping):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _object_value(root, "success") is not True:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    quotes_node = _required_node(root, "quotes")
    if quotes_node.array_items is None or len(quotes_node.array_items) > MAX_QUOTES:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    selected: list[MayanSwiftV2Quote] = []
    for quote_node in quotes_node.array_items:
        if quote_node.object_entries is None or not isinstance(quote_node.value, Mapping):
            continue
        if (
            quote_node.value.get("type") != "SWIFT"
            or quote_node.value.get("swiftVersion") != "V2"
            or quote_node.value.get("gasless") is not False
        ):
            continue
        selected.append(_validate_provider_quote(quote_node, text, request, facts, config))
    if not selected:
        _fail(BridgeErrorCode.QUOTE_UNAVAILABLE)
    for quote in selected:
        _, deadline = _normalize_positive_uint64(
            quote["deadline"], BridgeErrorCode.PROVIDER_INVALID_RESPONSE
        )
        _ensure_quote_deadline(deadline, config.minimum_quote_validity_seconds)
    return copy.deepcopy(selected)


def _base58_decode(value: object, expected_bytes: int, code: BridgeErrorCode) -> bytes:
    text = _require_string(value, code)
    if not text or len(text) > expected_bytes * 2 or any(c not in BASE58_INDEX for c in text):
        _fail(code)
    number = 0
    for character in text:
        number = number * 58 + BASE58_INDEX[character]
    raw = number.to_bytes(max(1, (number.bit_length() + 7) // 8), "big")
    leading_zeroes = len(text) - len(text.lstrip("1"))
    if number == 0:
        raw = b""
    result = b"\0" * leading_zeroes + raw
    if len(result) != expected_bytes or _base58_encode(result) != text:
        _fail(code)
    return result


def _base58_encode(value: bytes) -> str:
    leading_zeroes = len(value) - len(value.lstrip(b"\0"))
    number = int.from_bytes(value, "big")
    if number == 0:
        return "1" * leading_zeroes
    chars: list[str] = []
    while number:
        number, remainder = divmod(number, 58)
        chars.append(BASE58_ALPHABET[remainder])
    return "1" * leading_zeroes + "".join(reversed(chars))


def _is_canonical_solana_address(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        _base58_decode(value, 32, BridgeErrorCode.INVALID_ARGUMENT)
    except BridgeError:
        return False
    return True


def _normalize_chain_address(value: object, chain_id: str, code: BridgeErrorCode) -> str:
    if chain_id == ETHEREUM_CHAIN_ID:
        return _normalize_evm_address(value, code)
    _base58_decode(value, 32, code)
    return _require_string(value, code)


def _reject_address_from_other_chain(value: object, expected_chain_id: str) -> None:
    is_evm = (
        isinstance(value, str)
        and _EVM_ADDRESS_RE.fullmatch(value) is not None
        and value.lower() != "0x" + "0" * 40
    )
    is_solana = _is_canonical_solana_address(value)
    if (expected_chain_id == ETHEREUM_CHAIN_ID and is_solana) or (
        expected_chain_id == SOLANA_CHAIN_ID and is_evm
    ):
        _fail(BridgeErrorCode.QUOTE_MISMATCH)


def _normalize_destination_address(value: object, destination_chain_id: str) -> str:
    return _normalize_chain_address(value, destination_chain_id, BridgeErrorCode.INVALID_ARGUMENT)


def _build_route_from_quote(quote: MayanSwiftV2Quote) -> tuple[_NormalizedRoute, MayanSwiftV2Quote]:
    normalized = _validate_normalized_quote_shape(quote, BridgeErrorCode.QUOTE_MISMATCH)
    if not _strict_equal(quote, normalized):
        _fail(BridgeErrorCode.QUOTE_MISMATCH)
    route = _validate_route(
        {
            "sourceChainId": normalized["sourceChainId"],
            "destinationChainId": normalized["destinationChainId"],
            "sourceTokenDeploymentId": normalized["sourceTokenDeploymentId"],
            "destinationTokenDeploymentId": normalized["destinationTokenDeploymentId"],
            "amountIn": normalized["amountIn"],
            "slippageBps": normalized["slippageBps"],
        }
    )
    return route, normalized


def _validate_raw_quote_for_build(
    quote: MayanSwiftV2Quote,
    route: _NormalizedRoute,
    config: _NormalizedBridgeConfig,
) -> MayanSwiftV2Quote:
    try:
        root = _parse_provider_response(quote["rawSignedQuoteJson"])
    except BridgeError as error:
        if error.code == BridgeErrorCode.QUOTE_EXPIRED:
            raise
        _fail(BridgeErrorCode.QUOTE_MISMATCH)
    text = quote["rawSignedQuoteJson"]
    if root.object_entries is None or root.start != 0 or root.end != len(text):
        _fail(BridgeErrorCode.QUOTE_MISMATCH)
    try:
        rebuilt = _validate_provider_quote(root, text, route.request, route.facts, config)
    except BridgeError as error:
        if error.code == BridgeErrorCode.QUOTE_EXPIRED:
            raise
        _fail(BridgeErrorCode.QUOTE_MISMATCH)
    if not _strict_equal(rebuilt, quote):
        _fail(BridgeErrorCode.QUOTE_MISMATCH)
    return copy.deepcopy(quote)


def _numeric_zero(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(float(value)) and value == 0
    return isinstance(value, str) and (
        value == "0"
        or re.fullmatch(r"0x0+", value, re.IGNORECASE) is not None
    )


def _validate_evm_build_result(node: _JsonNode, swapper_address: str) -> dict[str, object]:
    if _provider_string(node, "chainCategory") != "evm":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "quoteType") != "SWIFT":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_boolean(node, "gasless"):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    transaction = _required_node(node, "transaction")
    if transaction.object_entries is None or not isinstance(transaction.value, Mapping):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    to = _provider_string(transaction, "to")
    if not _provider_address_matches(to, ETHEREUM_FORWARDER):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_integer(transaction, "chainId") != 1:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if not _numeric_zero(_object_value(transaction, "value")):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    data = _provider_string(transaction, "data").lower()
    if (
        _HEX_BYTES_RE.fullmatch(data) is None
        or len(data) % 2 != 0
        or not data.startswith(ETHEREUM_FORWARDER_SELECTOR)
        or len(data) < 2 + 8 + 13 * 64
    ):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return {
        "kind": "evm-unsigned-transaction",
        "chainId": ETHEREUM_CHAIN_ID,
        "from": swapper_address,
        "to": ETHEREUM_FORWARDER,
        "data": data,
        "value": "0",
    }


def _read_shortvec(data: bytes, cursor: list[int], maximum: int, code: BridgeErrorCode) -> int:
    value = 0
    shift = 0
    for count in range(5):
        if cursor[0] >= len(data):
            _fail(code)
        byte = data[cursor[0]]
        cursor[0] += 1
        payload = byte & 0x7F
        if shift >= 28 or payload > MAX_SAFE_INTEGER // (1 << shift):
            _fail(code)
        value += payload << shift
        if (byte & 0x80) == 0:
            if count > 0 and payload == 0:
                _fail(code)
            if value > maximum:
                _fail(code)
            return value
        shift += 7
    _fail(code)


def _read_bytes(data: bytes, cursor: list[int], count: int, code: BridgeErrorCode) -> bytes:
    if count < 0 or cursor[0] + count > len(data):
        _fail(code)
    result = data[cursor[0] : cursor[0] + count]
    cursor[0] += count
    return result


def _validate_solana_transaction(value: object, fee_payer: str) -> str:
    encoded = _require_string(value, BridgeErrorCode.BUILD_INVALID)
    decode_failed = False
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        decode_failed = True
        decoded = b""
    if decode_failed:
        _fail(BridgeErrorCode.BUILD_INVALID)
    if base64.b64encode(decoded).decode("ascii") != encoded:
        _fail(BridgeErrorCode.BUILD_INVALID)
    if not decoded or len(decoded) > 1232:
        _fail(BridgeErrorCode.BUILD_INVALID)
    cursor = [0]
    signature_count = _read_shortvec(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID)
    if signature_count != 1 or any(
        byte != 0 for byte in _read_bytes(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
    ):
        _fail(BridgeErrorCode.BUILD_INVALID)
    if _read_bytes(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID) != b"\x80":
        _fail(BridgeErrorCode.BUILD_INVALID)
    required_signatures = _read_bytes(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID)[0]
    readonly_signed = _read_bytes(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID)[0]
    readonly_unsigned = _read_bytes(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID)[0]
    if required_signatures != 1 or readonly_signed != 0:
        _fail(BridgeErrorCode.BUILD_INVALID)
    static_key_count = _read_shortvec(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
    if static_key_count == 0 or readonly_unsigned >= static_key_count:
        _fail(BridgeErrorCode.BUILD_INVALID)
    static_keys = _read_bytes(decoded, cursor, static_key_count * 32, BridgeErrorCode.BUILD_INVALID)
    payer = _base58_decode(fee_payer, 32, BridgeErrorCode.BUILD_INVALID)
    if static_keys[:32] != payer:
        _fail(BridgeErrorCode.BUILD_INVALID)
    _read_bytes(decoded, cursor, 32, BridgeErrorCode.BUILD_INVALID)
    instruction_count = _read_shortvec(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
    largest_account_index = -1
    for _ in range(instruction_count):
        largest_account_index = max(
            largest_account_index,
            _read_bytes(decoded, cursor, 1, BridgeErrorCode.BUILD_INVALID)[0],
        )
        account_count = _read_shortvec(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
        account_indices = _read_bytes(decoded, cursor, account_count, BridgeErrorCode.BUILD_INVALID)
        if account_indices:
            largest_account_index = max(largest_account_index, max(account_indices))
        data_length = _read_shortvec(decoded, cursor, 1024, BridgeErrorCode.BUILD_INVALID)
        _read_bytes(decoded, cursor, data_length, BridgeErrorCode.BUILD_INVALID)
    lookup_count = _read_shortvec(decoded, cursor, 32, BridgeErrorCode.BUILD_INVALID)
    loaded_address_count = 0
    for _ in range(lookup_count):
        _read_bytes(decoded, cursor, 32, BridgeErrorCode.BUILD_INVALID)
        writable_count = _read_shortvec(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
        _read_bytes(decoded, cursor, writable_count, BridgeErrorCode.BUILD_INVALID)
        readonly_count = _read_shortvec(decoded, cursor, 64, BridgeErrorCode.BUILD_INVALID)
        _read_bytes(decoded, cursor, readonly_count, BridgeErrorCode.BUILD_INVALID)
        loaded_address_count += writable_count + readonly_count
        if loaded_address_count > 256:
            _fail(BridgeErrorCode.BUILD_INVALID)
    if (
        largest_account_index >= static_key_count + loaded_address_count
        or cursor[0] != len(decoded)
    ):
        _fail(BridgeErrorCode.BUILD_INVALID)
    return encoded


def _validate_solana_build_result(node: _JsonNode, swapper_address: str) -> dict[str, object]:
    if _provider_string(node, "chainCategory") != "svm":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    if _provider_string(node, "quoteType") != "SWIFT":
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    gasless = _object_value(node, "gasless")
    if gasless is not _MISSING and gasless is not False:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    encoded = _validate_solana_transaction(
        _required_node(node, "transaction").value,
        swapper_address,
    )
    return {
        "kind": "solana-v0-unsigned-transaction",
        "chainId": SOLANA_CHAIN_ID,
        "feePayer": swapper_address,
        "transactionBase64": encoded,
    }


def _validate_build_response(
    root: _JsonNode,
    raw_text: str,
    quote: MayanSwiftV2Quote,
    facts: _DirectionFacts,
    swapper_address: str,
) -> MayanSwiftV2Build:
    if root.object_entries is None or _object_value(root, "success") is not True:
        _fail(BridgeErrorCode.BUILD_INVALID)
    wrapper = _required_node(root, "transaction")
    if wrapper.object_entries is None or not isinstance(wrapper.value, Mapping):
        _fail(BridgeErrorCode.BUILD_INVALID)
    signers = _object_value(wrapper, "signers")
    if signers is not _MISSING and signers is not None and (
        not isinstance(signers, list) or len(signers) != 0
    ):
        _fail(BridgeErrorCode.BUILD_INVALID)
    swap_message = _object_value(wrapper, "swapMessageV0Params")
    if swap_message is not _MISSING and swap_message is not None:
        _fail(BridgeErrorCode.BUILD_INVALID)
    try:
        transaction = (
            _validate_evm_build_result(wrapper, swapper_address)
            if facts.source_chain_id == ETHEREUM_CHAIN_ID
            else _validate_solana_build_result(wrapper, swapper_address)
        )
    except BridgeError as error:
        if error.code == BridgeErrorCode.BUILD_INVALID:
            raise
        _fail(BridgeErrorCode.BUILD_INVALID)
    allowance: MayanSwiftV2Allowance | None
    if facts.source_chain_id == ETHEREUM_CHAIN_ID:
        allowance = {
            "tokenDeploymentId": ETHEREUM_EURC_DEPLOYMENT_ID,
            "tokenAddress": ETHEREUM_EURC_ADDRESS,
            "owner": swapper_address,
            "spender": ETHEREUM_FORWARDER,
            "requiredAmount": quote["amountIn"],
        }
    else:
        allowance = None
    return {
        "buildKind": "mayan-swift-v2-unsigned",
        "providerId": "mayan-swift-v2",
        "quote": copy.deepcopy(quote),
        "sourceChainId": quote["sourceChainId"],
        "destinationChainId": quote["destinationChainId"],
        "transaction": transaction,
        "allowance": allowance,
        "validation": {
            "level": "structural",
            "quoteSignatureLocallyVerified": False,
            "transactionSemanticsLocallyVerified": False,
            "settlementLocallyVerified": False,
        },
        "rawProviderBuildJson": raw_text,
    }


def _normalize_status_request(value: object) -> dict[str, str]:
    request = _mapping(value, BridgeErrorCode.INVALID_ARGUMENT)
    _exact_keys(
        request,
        ("sourceChainId", "sourceTransactionHash"),
        BridgeErrorCode.INVALID_ARGUMENT,
    )
    chain_id = _require_string(request["sourceChainId"], BridgeErrorCode.INVALID_ARGUMENT)
    tx_hash = _require_string(request["sourceTransactionHash"], BridgeErrorCode.INVALID_ARGUMENT)
    if chain_id == ETHEREUM_CHAIN_ID:
        if _EVM_HASH_RE.fullmatch(tx_hash) is None:
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        return {"sourceChainId": chain_id, "sourceTransactionHash": tx_hash.lower()}
    if chain_id == SOLANA_CHAIN_ID:
        _base58_decode(tx_hash, 64, BridgeErrorCode.INVALID_ARGUMENT)
        return {"sourceChainId": chain_id, "sourceTransactionHash": tx_hash}
    _fail(BridgeErrorCode.UNSUPPORTED_ROUTE)


def _status_from_response(
    root: _JsonNode, raw_text: str, request: Mapping[str, str]
) -> MayanSwiftV2Status:
    if root.object_entries is None or not isinstance(root.value, Mapping):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    provider_client_status = _provider_string(root, "clientStatus")
    if len(provider_client_status) > 128:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    provider_status_value = _object_value(root, "status")
    if (
        provider_status_value is not _MISSING
        and provider_status_value is not None
        and (not isinstance(provider_status_value, str) or len(provider_status_value) > 1024)
    ):
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    provider_status = (
        None
        if provider_status_value is _MISSING
        else cast(str | None, provider_status_value)
    )
    state = {
        "INPROGRESS": "in-progress",
        "COMPLETED": "completed",
        "REFUNDED": "refunded",
    }.get(provider_client_status, "unknown")
    return {
        "statusKind": "mayan-explorer-index",
        "providerId": "mayan-swift-v2",
        "sourceChainId": request["sourceChainId"],
        "sourceTransactionHash": request["sourceTransactionHash"],
        "state": state,
        "providerClientStatus": provider_client_status,
        "providerStatus": provider_status,
        "statusVerification": "provider-indexed-not-locally-verified",
        "rawProviderStatusJson": raw_text,
    }


@dataclass(frozen=True, slots=True)
class _NormalizedBridgeConfig:
    builder_endpoint: str
    explorer_endpoint: str
    builder_api_key: str | None
    allow_unauthenticated_build: bool
    minimum_quote_validity_seconds: int
    timeout: float
    http_client: httpx.AsyncClient
    owns_http_client: bool


def _normalize_api_key(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or any(
        ord(character) < 0x20 or ord(character) == 0x7F for character in value
    ):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if not value:
        return None
    # HTTPX rejects non-ASCII header values.  Reject them before any I/O so
    # the native exception cannot retain the credential in its context.
    if not value.isascii():
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    return value


def _normalize_provider_endpoint(value: object) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if (
        any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
        or any(character.isspace() for character in value)
    ):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if "://" not in value or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", value) is None:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if "?" in value or "#" in value:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    parse_failed = False
    try:
        parsed = urlsplit(value)
        port = parsed.port
        hostname_value = parsed.hostname
    except ValueError:
        parse_failed = True
        parsed = urlsplit("https://invalid")
        port = None
        hostname_value = None
    if parse_failed:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if not parsed.scheme or not parsed.netloc or not hostname_value:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    scheme = parsed.scheme.lower()
    hostname = hostname_value.lower()
    if any(character in hostname for character in "%\\/@[]"):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if ":" in hostname:
        if not parsed.netloc.startswith("[") or "]" not in parsed.netloc:
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
    elif any(
        not (character.isalnum() or character in ".-_") for character in hostname
    ):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if scheme != "https" and not (
        scheme == "http" and hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    if parsed.netloc.endswith(":") or (port is not None and (port < 0 or port > 65535)):
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def _config_from_value(
    config: MayanSwiftV2BridgeConfig | Mapping[str, object] | None,
    http_client: httpx.AsyncClient | None,
) -> tuple[MayanSwiftV2BridgeConfig, httpx.AsyncClient | None]:
    if config is None:
        normalized = MayanSwiftV2BridgeConfig()
    elif isinstance(config, MayanSwiftV2BridgeConfig):
        normalized = config
    elif isinstance(config, Mapping):
        if any(not isinstance(key, str) or key not in _CONFIG_KEYS for key in config):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        source = dict(config)
        aliases = {
            "builderEndpoint": "builder_endpoint",
            "explorerEndpoint": "explorer_endpoint",
            "builderApiKey": "builder_api_key",
            "allowUnauthenticatedBuild": "allow_unauthenticated_build",
            "minimumQuoteValiditySeconds": "minimum_quote_validity_seconds",
            "httpClient": "http_client",
        }
        for old, new in aliases.items():
            if old in source:
                if new in source:
                    _fail(BridgeErrorCode.INVALID_ARGUMENT)
                source[new] = source.pop(old)
        if "timeoutMs" in source:
            if "timeout" in source:
                _fail(BridgeErrorCode.INVALID_ARGUMENT)
            timeout_ms = source.pop("timeoutMs")
            if (
                isinstance(timeout_ms, bool)
                or not isinstance(timeout_ms, (int, float))
                or not math.isfinite(float(timeout_ms))
                or float(timeout_ms) <= 0
            ):
                _fail(BridgeErrorCode.INVALID_ARGUMENT)
            source["timeout"] = float(timeout_ms) / 1000
        construction_failed = False
        try:
            normalized = MayanSwiftV2BridgeConfig(**source)  # type: ignore[arg-type]
        except TypeError:
            construction_failed = True
        if construction_failed:
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
    else:
        _fail(BridgeErrorCode.INVALID_ARGUMENT)
    selected_client = http_client if http_client is not None else normalized.http_client
    return normalized, selected_client


def _endpoint_with_path(endpoint: str, path: str) -> str:
    parsed = urlsplit(endpoint)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            f"{parsed.path.rstrip('/')}/{path.lstrip('/')}",
            "",
            "",
        )
    )


def _request_options(value: object) -> RequestOptions:
    if isinstance(value, RequestOptions):
        return value
    # Accept a small mapping convenience while keeping the package's normal
    # RequestOptions type as the documented API.
    if isinstance(value, Mapping) and set(value).issubset({"cancel_event"}):
        event = value.get("cancel_event")
        if event is None or isinstance(event, asyncio.Event):
            return RequestOptions(cancel_event=event)
    _fail(BridgeErrorCode.INVALID_ARGUMENT)


async def _cancel_task(task: asyncio.Task[object]) -> None:
    if not task.done():
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)


_T = TypeVar("_T")


async def _await_provider(
    task: asyncio.Task[_T],
    timeout: float,
    options: RequestOptions,
) -> _T:
    cancel_event = options.cancel_event
    if cancel_event is not None and cancel_event.is_set():
        await _cancel_task(cast(asyncio.Task[object], task))
        _fail(BridgeErrorCode.ABORTED)
    cancel_task: asyncio.Task[bool] | None = None
    try:
        if cancel_event is None:
            timed_out = False
            try:
                return await asyncio.wait_for(task, timeout)
            except TimeoutError:
                await _cancel_task(cast(asyncio.Task[object], task))
                timed_out = True
            if timed_out:
                _fail(BridgeErrorCode.TIMEOUT)
        assert cancel_event is not None
        cancel_task = asyncio.create_task(cancel_event.wait())
        done, _ = await asyncio.wait(
            {task, cancel_task}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        if not done:
            await _cancel_task(cast(asyncio.Task[object], task))
            _fail(BridgeErrorCode.TIMEOUT)
        if cancel_task in done:
            await _cancel_task(cast(asyncio.Task[object], task))
            _fail(BridgeErrorCode.ABORTED)
        return await task
    except asyncio.CancelledError:
        await _cancel_task(cast(asyncio.Task[object], task))
        raise
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()
        if cancel_task is not None:
            await asyncio.gather(cancel_task, return_exceptions=True)


async def _read_provider_body(response: httpx.Response) -> str:
    chunks = bytearray()
    read_failed = False
    try:
        async for chunk in response.aiter_bytes():
            if len(chunks) + len(chunk) > MAX_RESPONSE_BYTES:
                _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
            chunks.extend(chunk)
    except BridgeError:
        raise
    except Exception:
        read_failed = True
    if read_failed:
        _fail(BridgeErrorCode.PROVIDER_TRANSPORT)
    try:
        return bytes(chunks).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        decode_failed = True
    else:
        decode_failed = False
    if decode_failed:
        _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
    return ""


class MayanSwiftV2BridgeClient:
    """Async standalone client for the reviewed EURC bridge directions."""

    def __init__(
        self,
        config: MayanSwiftV2BridgeConfig | Mapping[str, object] | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        public_config, selected_client = _config_from_value(config, http_client)
        owns = selected_client is None
        client = (
            selected_client
            if selected_client is not None
            else httpx.AsyncClient(timeout=None, follow_redirects=False)
        )
        self._config = _NormalizedBridgeConfig(
            builder_endpoint=public_config.builder_endpoint,
            explorer_endpoint=public_config.explorer_endpoint,
            builder_api_key=public_config.builder_api_key,
            allow_unauthenticated_build=public_config.allow_unauthenticated_build,
            minimum_quote_validity_seconds=public_config.minimum_quote_validity_seconds,
            timeout=public_config.timeout,
            http_client=client,
            owns_http_client=owns,
        )
        self._closed = False

    async def _provider_request(
        self,
        endpoint: str,
        method: str,
        body: str | None,
        *,
        include_builder_key: bool,
        operation: str,
        options: RequestOptions,
    ) -> tuple[str, int]:
        if options.cancel_event is not None and options.cancel_event.is_set():
            _fail(BridgeErrorCode.ABORTED)
        headers: dict[str, str] = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = "application/json"
        if include_builder_key and self._config.builder_api_key is not None:
            headers["x-api-key"] = self._config.builder_api_key
        request_failed = False
        try:
            request = httpx.Request(
                method,
                endpoint,
                headers=headers,
                content=body.encode("utf-8") if body is not None else None,
            )
        except (TypeError, UnicodeError, ValueError, httpx.InvalidURL):
            request_failed = True
            request = httpx.Request("GET", "https://invalid.example")
        if request_failed:
            _fail(BridgeErrorCode.PROVIDER_TRANSPORT)
        async def request_and_read() -> tuple[str, int]:
            response: httpx.Response | None = None
            try:
                response = await self._config.http_client.send(
                    request,
                    auth=None,
                    follow_redirects=False,
                    stream=True,
                )
                status = response.status_code
                if operation == "status" and status == 404:
                    _fail(BridgeErrorCode.STATUS_NOT_FOUND)
                if 300 <= status < 400:
                    _fail(BridgeErrorCode.PROVIDER_TRANSPORT)
                if operation == "build" and status in {401, 403}:
                    _fail(BridgeErrorCode.PROVIDER_AUTH_REQUIRED)
                if status not in {200, 201}:
                    _fail(BridgeErrorCode.PROVIDER_HTTP, status)
                return await _read_provider_body(response), status
            finally:
                if response is not None:
                    with suppress(Exception):
                        await response.aclose()

        provider_failed = False
        try:
            task = asyncio.create_task(request_and_read())
            result = await _await_provider(task, self._config.timeout, options)
        except BridgeError:
            raise
        except asyncio.CancelledError:
            if options.cancel_event is not None and options.cancel_event.is_set():
                _fail(BridgeErrorCode.ABORTED)
            raise
        except httpx.HTTPError:
            provider_failed = True
        except Exception:
            provider_failed = True
        if provider_failed:
            _fail(BridgeErrorCode.PROVIDER_TRANSPORT)
        if options.cancel_event is not None and options.cancel_event.is_set():
            _fail(BridgeErrorCode.ABORTED)
        return result

    async def quote_exact_input(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> list[MayanSwiftV2Quote]:
        """Fetch all valid provider Swift v2 quotes for one exact route."""

        route = _validate_route(request)
        quote_body = json.dumps(
            {
                "fromToken": route.facts.source_token_address,
                "fromChain": route.facts.source_name,
                "toToken": route.facts.destination_token_address,
                "toChain": route.facts.destination_name,
                "amountIn64": route.request["amountIn"],
                "slippageBps": route.request["slippageBps"],
                "swift": True,
                "mctp": False,
                "fastMctp": False,
                "wormhole": False,
                "monoChain": False,
                "gasless": False,
                "fullList": True,
                "guaranteedOutput": True,
                "gasDrop": 0,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        normalized_options = _request_options(options)
        text, _ = await self._provider_request(
            _endpoint_with_path(self._config.builder_endpoint, "/quote"),
            "POST",
            quote_body,
            include_builder_key=False,
            operation="quote",
            options=normalized_options,
        )
        root = _parse_provider_response(text)
        return _quote_from_response(root, text, route.request, route.facts, self._config)

    async def build_unsigned(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> MayanSwiftV2Build:
        """Build one provider unsigned transaction after local quote checks."""

        snapshot = _mapping(request, BridgeErrorCode.INVALID_ARGUMENT)
        if set(snapshot) - {"quote", "swapperAddress", "destinationAddress", "refundAddress"}:
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        if (
            "quote" not in snapshot
            or "swapperAddress" not in snapshot
            or "destinationAddress" not in snapshot
        ):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        try:
            quote_snapshot = cast(MayanSwiftV2Quote, copy.deepcopy(snapshot["quote"]))
        except Exception:
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        if not isinstance(quote_snapshot, Mapping):
            _fail(BridgeErrorCode.INVALID_ARGUMENT)
        route, normalized_quote = _build_route_from_quote(quote_snapshot)
        _reject_address_from_other_chain(
            snapshot["swapperAddress"], route.facts.source_chain_id
        )
        source_address = _normalize_chain_address(
            snapshot["swapperAddress"],
            route.facts.source_chain_id,
            BridgeErrorCode.INVALID_ARGUMENT,
        )
        destination_address = _normalize_destination_address(
            snapshot["destinationAddress"], route.facts.destination_chain_id
        )
        refund_address: str | None = None
        if "refundAddress" in snapshot:
            refund_address = _normalize_chain_address(
                snapshot["refundAddress"],
                route.facts.source_chain_id,
                BridgeErrorCode.INVALID_ARGUMENT,
            )
        if self._config.builder_api_key is None and not self._config.allow_unauthenticated_build:
            _fail(BridgeErrorCode.PROVIDER_AUTH_REQUIRED)
        quote = _validate_raw_quote_for_build(normalized_quote, route, self._config)
        params: dict[str, object] = {
            "swapperAddress": source_address,
            "destinationAddress": destination_address,
        }
        if route.facts.source_chain_id == ETHEREUM_CHAIN_ID:
            params["signerChainId"] = 1
        if refund_address is not None:
            params["swiftRefundAddress"] = refund_address
        params_json = json.dumps(params, ensure_ascii=False, separators=(",", ":"))
        body = f'{{"quote":{quote["rawSignedQuoteJson"]},"params":{params_json}}}'
        text, _ = await self._provider_request(
            _endpoint_with_path(self._config.builder_endpoint, "/build"),
            "POST",
            body,
            include_builder_key=True,
            operation="build",
            options=_request_options(options),
        )
        root = _parse_provider_response(text)
        _, deadline = _normalize_positive_uint64(quote["deadline"], BridgeErrorCode.QUOTE_EXPIRED)
        _ensure_quote_deadline(deadline, self._config.minimum_quote_validity_seconds)
        return _validate_build_response(root, text, quote, route.facts, source_address)

    async def get_status(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> MayanSwiftV2Status:
        """Read one indexed source transaction status from Mayan Explorer."""

        normalized = _normalize_status_request(request)
        encoded_hash = url_quote(normalized["sourceTransactionHash"], safe="-._~")
        text, _ = await self._provider_request(
            _endpoint_with_path(
                self._config.explorer_endpoint,
                f"/swap/trx/{encoded_hash}",
            ),
            "GET",
            None,
            include_builder_key=False,
            operation="status",
            options=_request_options(options),
        )
        root = _parse_provider_response(text)
        return _status_from_response(root, text, normalized)

    async def close(self) -> None:
        """Close an internally created HTTP client; caller clients remain open."""

        if self._closed:
            return
        self._closed = True
        if self._config.owns_http_client:
            await self._config.http_client.aclose()

    async def __aenter__(self) -> MayanSwiftV2BridgeClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


BridgeClient = MayanSwiftV2BridgeClient


def create_mayan_swift_v2_bridge_client(
    config: MayanSwiftV2BridgeConfig | Mapping[str, object] | None = None,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> MayanSwiftV2BridgeClient:
    """Create a standalone Mayan Swift v2 bridge client."""

    return MayanSwiftV2BridgeClient(config, http_client=http_client)


__all__ = [
    "BRIDGE_CAPABILITIES_AS_OF_DATE",
    "BRIDGE_CAPABILITIES_CONTENT_DIGEST",
    "BRIDGE_ERROR_MESSAGES",
    "BridgeClient",
    "BridgeError",
    "BridgeErrorCode",
    "BridgeRequestOptions",
    "MayanEvmUnsignedTransaction",
    "MayanSolanaUnsignedTransaction",
    "MayanSwiftV2BridgeClient",
    "MayanSwiftV2BridgeConfig",
    "MayanSwiftV2Build",
    "MayanSwiftV2BuildRequest",
    "MayanSwiftV2BuildResult",
    "MayanSwiftV2BuildUnsignedRequest",
    "MayanSwiftV2BuildValidation",
    "MayanSwiftV2Quote",
    "MayanSwiftV2QuoteRequest",
    "MayanSwiftV2QuoteResult",
    "MayanSwiftV2SourceSwap",
    "MayanSwiftV2Status",
    "MayanSwiftV2StatusRequest",
    "MayanSwiftV2StatusResult",
    "MayanSwiftV2UnsignedTransaction",
    "create_mayan_swift_v2_bridge_client",
]
