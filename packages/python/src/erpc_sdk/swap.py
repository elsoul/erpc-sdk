"""RPC-only exact-input swap quotes and unsigned execution for EVM V2 pools."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Literal, NamedTuple, NoReturn, NotRequired, TypedDict, cast

from ._swap_execution_capabilities_data import (
    SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
    SWAP_EXECUTION_CAPABILITIES_JSON,
    SWAP_EXECUTION_FUNCTION_SELECTOR,
    SWAP_EXECUTION_FUNCTION_SIGNATURE,
)
from ._token_catalog_data import TokenDeployment
from .dex_catalog import (
    DEX_CATALOG_CONTENT_DIGEST,
    DEX_CHAIN_IDS,
    NATIVE_WRAP_DEFINITIONS,
    DexDeployment,
    PoolDefinition,
    get_dex_deployment,
    get_pool_definition,
)
from .errors import ErpcAbortedError, ErpcJsonRpcError
from .token_catalog import TOKEN_CATALOG_CONTENT_DIGEST, get_token_deployment
from .transport import HttpJsonRpcTransport
from .types import DEFAULT_REQUEST_OPTIONS, JsonRpcParams, RequestOptions


class SwapQuoteErrorCode(StrEnum):
    """Stable machine-readable errors produced by local quote validation."""

    INVALID_ARGUMENT = "SWAP_INVALID_ARGUMENT"
    UNSUPPORTED_CHAIN = "SWAP_UNSUPPORTED_CHAIN"
    UNKNOWN_POOL = "SWAP_UNKNOWN_POOL"
    UNKNOWN_TOKEN = "SWAP_UNKNOWN_TOKEN"
    TOKEN_NOT_ACTIVE = "SWAP_TOKEN_NOT_ACTIVE"
    UNSUPPORTED_TOKEN_STANDARD = "SWAP_UNSUPPORTED_TOKEN_STANDARD"
    UNSUPPORTED_TOKEN = "SWAP_UNSUPPORTED_TOKEN"
    UNSUPPORTED_ADAPTER = "SWAP_UNSUPPORTED_ADAPTER"
    CHAIN_MISMATCH = "SWAP_CHAIN_MISMATCH"
    POOL_TOKEN_MISMATCH = "SWAP_POOL_TOKEN_MISMATCH"
    PROGRAM_MISMATCH = "SWAP_PROGRAM_MISMATCH"
    INVALID_POOL_STATE = "SWAP_INVALID_POOL_STATE"
    STATE_STALE = "SWAP_STATE_STALE"
    INSUFFICIENT_LIQUIDITY = "SWAP_INSUFFICIENT_LIQUIDITY"
    ARITHMETIC = "SWAP_ARITHMETIC"

    # Keep the prefixed spellings available for callers that use the shared
    # cross-language error identifiers as enum members.
    SWAP_INVALID_ARGUMENT = INVALID_ARGUMENT
    SWAP_UNSUPPORTED_CHAIN = UNSUPPORTED_CHAIN
    SWAP_UNKNOWN_POOL = UNKNOWN_POOL
    SWAP_UNKNOWN_TOKEN = UNKNOWN_TOKEN
    SWAP_TOKEN_NOT_ACTIVE = TOKEN_NOT_ACTIVE
    SWAP_UNSUPPORTED_TOKEN_STANDARD = UNSUPPORTED_TOKEN_STANDARD
    SWAP_UNSUPPORTED_TOKEN = UNSUPPORTED_TOKEN
    SWAP_UNSUPPORTED_ADAPTER = UNSUPPORTED_ADAPTER
    SWAP_CHAIN_MISMATCH = CHAIN_MISMATCH
    SWAP_POOL_TOKEN_MISMATCH = POOL_TOKEN_MISMATCH
    SWAP_PROGRAM_MISMATCH = PROGRAM_MISMATCH
    SWAP_INVALID_POOL_STATE = INVALID_POOL_STATE
    SWAP_STATE_STALE = STATE_STALE
    SWAP_INSUFFICIENT_LIQUIDITY = INSUFFICIENT_LIQUIDITY
    SWAP_ARITHMETIC = ARITHMETIC


SWAP_QUOTE_ERROR_MESSAGES: Final[dict[SwapQuoteErrorCode, str]] = {
    SwapQuoteErrorCode.INVALID_ARGUMENT: "Swap request is invalid",
    SwapQuoteErrorCode.UNSUPPORTED_CHAIN: "Swap chain is unsupported",
    SwapQuoteErrorCode.UNKNOWN_POOL: "Swap pool is unknown",
    SwapQuoteErrorCode.UNKNOWN_TOKEN: "Swap token is unknown",
    SwapQuoteErrorCode.TOKEN_NOT_ACTIVE: "Swap token is not active",
    SwapQuoteErrorCode.UNSUPPORTED_TOKEN_STANDARD: "Swap token standard is unsupported",
    SwapQuoteErrorCode.UNSUPPORTED_TOKEN: "Swap token is unsupported for the selected pool",
    SwapQuoteErrorCode.UNSUPPORTED_ADAPTER: "Swap adapter is unsupported",
    SwapQuoteErrorCode.CHAIN_MISMATCH: "Swap chain does not match the selected records",
    SwapQuoteErrorCode.POOL_TOKEN_MISMATCH: "Swap pool tokens do not match the request",
    SwapQuoteErrorCode.PROGRAM_MISMATCH: "Swap program does not match the selected records",
    SwapQuoteErrorCode.INVALID_POOL_STATE: "Swap pool state is invalid",
    SwapQuoteErrorCode.STATE_STALE: "Swap pool state is stale",
    SwapQuoteErrorCode.INSUFFICIENT_LIQUIDITY: "Swap pool liquidity is insufficient",
    SwapQuoteErrorCode.ARITHMETIC: "Swap arithmetic overflowed or produced an invalid result",
}


class SwapQuoteError(Exception):
    """A deterministic quote-domain error.

    Existing transport, timeout, cancellation, and JSON-RPC exceptions are
    deliberately not wrapped by the quote client and therefore retain their
    native type and source.
    """

    code: SwapQuoteErrorCode

    def __init__(self, code: SwapQuoteErrorCode) -> None:
        self.code = code
        super().__init__(SWAP_QUOTE_ERROR_MESSAGES[code])


class SwapExecutionErrorCode(StrEnum):
    """Stable machine-readable errors produced by execution preflight."""

    INVALID_ARGUMENT = "SWAP_EXECUTION_INVALID_ARGUMENT"
    UNSUPPORTED_EXECUTION = "SWAP_UNSUPPORTED_EXECUTION"
    PROGRAM_MISMATCH = "SWAP_PROGRAM_MISMATCH"
    INSUFFICIENT_ALLOWANCE = "SWAP_INSUFFICIENT_ALLOWANCE"
    SIMULATION_REVERTED = "SWAP_SIMULATION_REVERTED"
    INVALID_SIMULATION = "SWAP_INVALID_SIMULATION"

    # Keep the prefixed spellings available for callers that use the shared
    # cross-language error identifiers as enum members.
    SWAP_EXECUTION_INVALID_ARGUMENT = INVALID_ARGUMENT
    SWAP_UNSUPPORTED_EXECUTION = UNSUPPORTED_EXECUTION
    SWAP_PROGRAM_MISMATCH = PROGRAM_MISMATCH
    SWAP_INSUFFICIENT_ALLOWANCE = INSUFFICIENT_ALLOWANCE
    SWAP_SIMULATION_REVERTED = SIMULATION_REVERTED
    SWAP_INVALID_SIMULATION = INVALID_SIMULATION


SWAP_EXECUTION_ERROR_MESSAGES: Final[dict[SwapExecutionErrorCode, str]] = {
    SwapExecutionErrorCode.INVALID_ARGUMENT: "Swap execution request is invalid",
    SwapExecutionErrorCode.UNSUPPORTED_EXECUTION: (
        "Swap execution is unsupported for the selected records"
    ),
    SwapExecutionErrorCode.PROGRAM_MISMATCH: "Swap program does not match the selected records",
    SwapExecutionErrorCode.INSUFFICIENT_ALLOWANCE: "Swap allowance is insufficient",
    SwapExecutionErrorCode.SIMULATION_REVERTED: "Swap simulation reverted",
    SwapExecutionErrorCode.INVALID_SIMULATION: "Swap simulation result is invalid",
}


class SwapExecutionError(Exception):
    """A deterministic unsigned-preparation or simulation error.

    Quote-domain failures, transport errors, cancellation, and non-revert
    JSON-RPC errors retain their existing native Python error types. Only the
    final router call's recognized execution-revert responses are converted
    into this error family.
    """

    code: SwapExecutionErrorCode

    def __init__(self, code: SwapExecutionErrorCode) -> None:
        self.code = code
        super().__init__(SWAP_EXECUTION_ERROR_MESSAGES[code])


class SwapFreshness(TypedDict, total=False):
    """Optional freshness limits for an exact-input quote."""

    maxBlockAgeSeconds: int
    maxBlockLag: int
    maxClockSkewSeconds: int


class ExactInputQuoteRequest(TypedDict):
    """The six-field public quote request."""

    chainId: str
    poolDefinitionId: str
    inputTokenDeploymentId: str
    outputTokenDeploymentId: str
    amountIn: str
    freshness: NotRequired[SwapFreshness]


class QuoteFee(TypedDict):
    numerator: str
    denominator: str


class EvmBlockSnapshot(TypedDict):
    kind: Literal["evm-block"]
    blockNumber: str
    blockHash: str
    blockTimestamp: str


class ExactInputQuoteResult(TypedDict):
    """Result returned by :meth:`SwapClient.quote_exact_input`."""

    quoteKind: Literal["exact-input"]
    chainId: str
    poolDefinitionId: str
    dexDeploymentId: str
    adapterKind: str
    inputTokenDeploymentId: str
    outputTokenDeploymentId: str
    amountIn: str
    amountOut: str
    fee: QuoteFee
    snapshot: EvmBlockSnapshot
    tokenCatalogDigest: str
    dexCatalogDigest: str


class PrepareExactInputSwapRequest(ExactInputQuoteRequest):
    """Flat exact-input request with the local execution fields."""

    sender: str
    recipient: str
    slippageBps: int
    deadline: str


# Alias for callers that prefer a shorter execution request name.
ExactInputSwapRequest = PrepareExactInputSwapRequest


class ExactInputSwapPathEntry(TypedDict):
    tokenDeploymentId: str
    address: str
    standard: Literal["erc20"]
    representationKind: str


ExactInputSwapTransaction = TypedDict(
    "ExactInputSwapTransaction",
    {
        "kind": Literal["evm-unsigned-transaction"],
        "chainId": str,
        "from": str,
        "to": str,
        "data": str,
        "value": Literal["0"],
    },
)


class ExactInputSwapAllowance(TypedDict):
    tokenDeploymentId: str
    tokenAddress: str
    owner: str
    spender: str
    requiredAmount: str


class ExactInputSwapPreparation(TypedDict):
    """Unsigned, chain-bound EVM transaction preparation."""

    preparationKind: Literal["evm-router-v2-exact-input"]
    executionCapabilityId: str
    executionCapabilityDigest: str
    quote: ExactInputQuoteResult
    minimumAmountOut: str
    slippageBps: int
    deadline: str
    recipient: str
    path: list[ExactInputSwapPathEntry]
    transaction: ExactInputSwapTransaction
    allowance: ExactInputSwapAllowance


class ExactInputSwapSimulation(TypedDict):
    """Read-only router simulation result."""

    simulationKind: Literal["evm-call"]
    preparation: ExactInputSwapPreparation
    snapshot: EvmBlockSnapshot
    currentAllowance: str
    amounts: list[str]
    amountOut: str


# Aliases matching the method-name result spellings used by other packages.
PrepareExactInputSwapResult = ExactInputSwapPreparation
SimulateExactInputSwapResult = ExactInputSwapSimulation
SwapPreparation = ExactInputSwapPreparation
SwapSimulation = ExactInputSwapSimulation


@dataclass(frozen=True, slots=True)
class _Freshness:
    max_block_age_seconds: int
    max_block_lag: int
    max_clock_skew_seconds: int


@dataclass(frozen=True, slots=True)
class _NormalizedRequest:
    chain_id: str
    pool_definition_id: str
    input_token_deployment_id: str
    output_token_deployment_id: str
    amount_in_text: str
    amount_in: int
    freshness: _Freshness
    pool: PoolDefinition
    dex: DexDeployment
    input_token: TokenDeployment
    output_token: TokenDeployment


@dataclass(frozen=True, slots=True)
class _Header:
    number: int
    block_hash: str
    timestamp: int


@dataclass(frozen=True, slots=True)
class _Reserves:
    reserve0: int
    reserve1: int


@dataclass(frozen=True, slots=True)
class _EvmState:
    initial: _Header
    latest_after_reads: _Header
    reserves: _Reserves


@dataclass(frozen=True, slots=True)
class _ExecutionRequestSnapshot:
    quote_request: Mapping[str, object]
    sender: object
    recipient: object
    slippage_bps: object
    deadline: object


@dataclass(frozen=True, slots=True)
class _NormalizedExecutionRequest:
    normalized: _NormalizedRequest
    sender: str
    recipient: str
    slippage_bps: int
    deadline: str
    deadline_value: int


@dataclass(frozen=True, slots=True)
class _PreparedExecutionContext:
    normalized: _NormalizedExecutionRequest
    capability: Mapping[str, object]
    transport: HttpJsonRpcTransport
    state: _EvmState
    quote: ExactInputQuoteResult
    preparation: ExactInputSwapPreparation


class _SupportedQuoteCapability(NamedTuple):
    """One reviewed pool/token tuple allowed to reach the quote RPC path."""

    chain_id: str
    dex_deployment_id: str
    factory_address: str
    pool_definition_id: str
    pool_address: str
    token0_deployment_id: str
    token0_address: str
    token0_decimals: int
    token0_standard: Literal["erc20"]
    token1_deployment_id: str
    token1_address: str
    token1_decimals: int
    token1_standard: Literal["erc20"]
    adapter_kind: Literal["evm-constant-product-v2"]
    fee_numerator: str
    fee_denominator: str


SUPPORTED_QUOTE_ADAPTER: Final = "evm-constant-product-v2"
_DEFAULT_FRESHNESS = _Freshness(120, 3, 5)
_UINT256_MAX: Final = (1 << 256) - 1
_UINT112_MAX: Final = (1 << 112) - 1
_UINT32_MAX: Final = (1 << 32) - 1
_UINT256_DECIMAL = re.compile(r"[1-9][0-9]*")
_NONNEGATIVE_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)")
_HEX_BYTES = re.compile(r"0x[0-9a-fA-F]*")
_HEX_QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)")
_EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_OPAQUE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_KNOWN_CHAIN_IDS: Final[frozenset[str]] = frozenset(
    {DEX_CHAIN_IDS["ethereum"], DEX_CHAIN_IDS["solana"], DEX_CHAIN_IDS["avalancheC"]}
)
_EVM_NETWORK_IDS: Final[dict[str, int]] = {
    DEX_CHAIN_IDS["ethereum"]: 1,
    DEX_CHAIN_IDS["avalancheC"]: 43114,
}

# Quote eligibility is a handwritten review boundary. Catalog growth may add
# lookup, monitoring, or ranking records without granting them RPC quote
# access.
_SUPPORTED_QUOTE_CAPABILITIES: Final[tuple[_SupportedQuoteCapability, ...]] = (
    _SupportedQuoteCapability(
        chain_id="eip155:1",
        dex_deployment_id="dex-deployment-0001",
        factory_address="0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
        pool_definition_id="pool-0001",
        pool_address="0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
        token0_deployment_id="deployment-0008",
        token0_address="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        token0_decimals=6,
        token0_standard="erc20",
        token1_deployment_id="deployment-0002",
        token1_address="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        token1_decimals=18,
        token1_standard="erc20",
        adapter_kind="evm-constant-product-v2",
        fee_numerator="3",
        fee_denominator="1000",
    ),
    _SupportedQuoteCapability(
        chain_id="eip155:43114",
        dex_deployment_id="dex-deployment-0002",
        factory_address="0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
        pool_definition_id="pool-0002",
        pool_address="0xf4003f4efbe8691b60249e6afbd307abe7758adb",
        token0_deployment_id="deployment-0004",
        token0_address="0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
        token0_decimals=18,
        token0_standard="erc20",
        token1_deployment_id="deployment-0009",
        token1_address="0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
        token1_decimals=6,
        token1_standard="erc20",
        adapter_kind="evm-constant-product-v2",
        fee_numerator="3",
        fee_denominator="1000",
    ),
)

_FACTORY_GET_PAIR_SELECTOR = "0xe6a43905"
_PAIR_FACTORY_SELECTOR = "0xc45a0155"
_PAIR_TOKEN0_SELECTOR = "0x0dfe1681"
_PAIR_TOKEN1_SELECTOR = "0xd21220a7"
_PAIR_GET_RESERVES_SELECTOR = "0x0902f1ac"

_ROUTER_FACTORY_SELECTOR = "0xc45a0155"
_ROUTER_GET_AMOUNTS_OUT_SELECTOR = "0xd06ca61f"
_ERC20_ALLOWANCE_SELECTOR = "0xdd62ed3e"
_EXECUTION_REQUEST_KEYS: Final[frozenset[str]] = frozenset(
    {
        "chainId",
        "poolDefinitionId",
        "inputTokenDeploymentId",
        "outputTokenDeploymentId",
        "amountIn",
        "freshness",
        "sender",
        "recipient",
        "slippageBps",
        "deadline",
    }
)
_EXECUTION_QUOTE_KEYS: Final[tuple[str, ...]] = (
    "chainId",
    "poolDefinitionId",
    "inputTokenDeploymentId",
    "outputTokenDeploymentId",
    "amountIn",
    "freshness",
)
_EXECUTION_CAPABILITIES: Final[tuple[Mapping[str, object], ...]] = tuple(
    cast(
        Mapping[str, object],
        row,
    )
    for row in cast(list[object], json.loads(SWAP_EXECUTION_CAPABILITIES_JSON))
    if isinstance(row, Mapping)
)


def _fail(code: SwapQuoteErrorCode) -> NoReturn:
    raise SwapQuoteError(code)


def _as_mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    return cast(Mapping[str, object], value)


def _ensure_uint256(value: int, code: SwapQuoteErrorCode = SwapQuoteErrorCode.ARITHMETIC) -> int:
    if isinstance(value, bool) or value < 0 or value > _UINT256_MAX:
        _fail(code)
    return value


def _parse_amount(value: str) -> int:
    if len(value) > 78 or _UINT256_DECIMAL.fullmatch(value) is None:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    try:
        parsed = int(value, 10)
    except ValueError:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    if parsed <= 0:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    return _ensure_uint256(parsed, SwapQuoteErrorCode.INVALID_ARGUMENT)


def _normalize_freshness(value: object) -> _Freshness:
    if value is None:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    if value is _MISSING:
        return _DEFAULT_FRESHNESS
    mapping = _as_mapping(value)
    if mapping is None:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    allowed = {"maxBlockAgeSeconds", "maxBlockLag", "maxClockSkewSeconds"}
    if any(key not in allowed for key in mapping):
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    ranges = {
        "maxBlockAgeSeconds": (0, 86400, _DEFAULT_FRESHNESS.max_block_age_seconds),
        "maxBlockLag": (0, 1024, _DEFAULT_FRESHNESS.max_block_lag),
        "maxClockSkewSeconds": (0, 300, _DEFAULT_FRESHNESS.max_clock_skew_seconds),
    }
    normalized: dict[str, int] = {}
    for key, (minimum, maximum, default) in ranges.items():
        current = mapping[key] if key in mapping else default
        if isinstance(current, bool) or not isinstance(current, int):
            _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
        if current < minimum or current > maximum:
            _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
        normalized[key] = current
    return _Freshness(
        max_block_age_seconds=normalized["maxBlockAgeSeconds"],
        max_block_lag=normalized["maxBlockLag"],
        max_clock_skew_seconds=normalized["maxClockSkewSeconds"],
    )


_MISSING = object()


def _normalize_request(request: object) -> _NormalizedRequest:
    mapping = _as_mapping(request)
    if mapping is None:
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
    allowed = {
        "chainId",
        "poolDefinitionId",
        "inputTokenDeploymentId",
        "outputTokenDeploymentId",
        "amountIn",
        "freshness",
    }
    if any(key not in allowed for key in mapping):
        _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)

    required = (
        "chainId",
        "poolDefinitionId",
        "inputTokenDeploymentId",
        "outputTokenDeploymentId",
        "amountIn",
    )
    values: dict[str, str] = {}
    for key in required:
        current = mapping.get(key)
        if not isinstance(current, str) or not current or current.strip() != current:
            _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
        values[key] = current
    for key in ("poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId"):
        if _OPAQUE_ID.fullmatch(values[key]) is None:
            _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)

    freshness_value = mapping["freshness"] if "freshness" in mapping else _MISSING
    freshness = _normalize_freshness(freshness_value)
    amount_in = _parse_amount(values["amountIn"])
    chain_id = values["chainId"]
    if chain_id not in _KNOWN_CHAIN_IDS:
        _fail(SwapQuoteErrorCode.UNSUPPORTED_CHAIN)

    pool = get_pool_definition(values["poolDefinitionId"])
    if pool is None:
        _fail(SwapQuoteErrorCode.UNKNOWN_POOL)
    if pool.chain_id != chain_id:
        _fail(SwapQuoteErrorCode.CHAIN_MISMATCH)
    if pool.status != "active":
        _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
    dex = get_dex_deployment(pool.dex_deployment_id)
    if dex is None or dex.status != "active":
        _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)

    input_token = get_token_deployment(values["inputTokenDeploymentId"])
    if input_token is None:
        _fail(SwapQuoteErrorCode.UNKNOWN_TOKEN)
    output_token = get_token_deployment(values["outputTokenDeploymentId"])
    if output_token is None:
        _fail(SwapQuoteErrorCode.UNKNOWN_TOKEN)
    if input_token.chain_id != chain_id or output_token.chain_id != chain_id:
        _fail(SwapQuoteErrorCode.CHAIN_MISMATCH)
    for token in (input_token, output_token):
        if token.status != "active":
            _fail(SwapQuoteErrorCode.TOKEN_NOT_ACTIVE)
    # Classic SPL records reach the adapter gate. Native and Token-2022
    # records fail before any address or RPC work.
    for token in (input_token, output_token):
        if token.standard not in {"erc20", "spl-token"}:
            _fail(SwapQuoteErrorCode.UNSUPPORTED_TOKEN_STANDARD)
    if values["inputTokenDeploymentId"] == values["outputTokenDeploymentId"]:
        _fail(SwapQuoteErrorCode.POOL_TOKEN_MISMATCH)
    wanted = tuple(sorted((values["inputTokenDeploymentId"], values["outputTokenDeploymentId"])))
    actual = tuple(sorted((pool.token0_deployment_id, pool.token1_deployment_id)))
    if wanted != actual:
        _fail(SwapQuoteErrorCode.POOL_TOKEN_MISMATCH)
    if pool.adapter.kind != SUPPORTED_QUOTE_ADAPTER or dex.adapter_kind != SUPPORTED_QUOTE_ADAPTER:
        _fail(SwapQuoteErrorCode.UNSUPPORTED_ADAPTER)
    if input_token.standard != "erc20" or output_token.standard != "erc20":
        _fail(SwapQuoteErrorCode.UNSUPPORTED_TOKEN_STANDARD)
    if not _matches_supported_quote_capability(pool, dex, input_token, output_token):
        _fail(SwapQuoteErrorCode.UNSUPPORTED_TOKEN)

    # Only immutable scalar copies are retained after validation. This keeps a
    # caller mutating the request mapping while awaits are in progress from
    # changing the quote or its result.
    return _NormalizedRequest(
        chain_id=chain_id,
        pool_definition_id=values["poolDefinitionId"],
        input_token_deployment_id=values["inputTokenDeploymentId"],
        output_token_deployment_id=values["outputTokenDeploymentId"],
        amount_in_text=values["amountIn"],
        amount_in=amount_in,
        freshness=freshness,
        pool=pool,
        dex=dex,
        input_token=input_token,
        output_token=output_token,
    )


def _matches_supported_quote_capability(
    pool: PoolDefinition,
    dex: DexDeployment,
    input_token: TokenDeployment,
    output_token: TokenDeployment,
) -> bool:
    """Return whether the selected records equal a reviewed quote tuple."""

    capability = next(
        (
            entry
            for entry in _SUPPORTED_QUOTE_CAPABILITIES
            if entry.pool_definition_id == pool.pool_definition_id
        ),
        None,
    )
    if capability is None:
        return False
    if (
        input_token.representation_kind == "unclassified"
        or output_token.representation_kind == "unclassified"
    ):
        return False

    def matches_token(
        token: TokenDeployment,
        deployment_id: str,
        address: str,
        decimals: int,
        standard: Literal["erc20"],
    ) -> bool:
        return (
            token.chain_id == capability.chain_id
            and token.deployment_id == deployment_id
            and token.address == address
            and token.decimals == decimals
            and token.standard == standard
        )

    matches_input = matches_token(
        input_token,
        capability.token0_deployment_id,
        capability.token0_address,
        capability.token0_decimals,
        capability.token0_standard,
    ) or matches_token(
        input_token,
        capability.token1_deployment_id,
        capability.token1_address,
        capability.token1_decimals,
        capability.token1_standard,
    )
    matches_output = matches_token(
        output_token,
        capability.token0_deployment_id,
        capability.token0_address,
        capability.token0_decimals,
        capability.token0_standard,
    ) or matches_token(
        output_token,
        capability.token1_deployment_id,
        capability.token1_address,
        capability.token1_decimals,
        capability.token1_standard,
    )

    return (
        pool.chain_id == capability.chain_id
        and pool.dex_deployment_id == capability.dex_deployment_id
        and pool.address == capability.pool_address
        and pool.token0_deployment_id == capability.token0_deployment_id
        and pool.token1_deployment_id == capability.token1_deployment_id
        and pool.adapter.kind == capability.adapter_kind
        and pool.adapter.fee_numerator == capability.fee_numerator
        and pool.adapter.fee_denominator == capability.fee_denominator
        and dex.dex_deployment_id == capability.dex_deployment_id
        and dex.chain_id == capability.chain_id
        and dex.program_address == capability.factory_address
        and dex.adapter_kind == capability.adapter_kind
        and matches_input
        and matches_output
    )


def _parse_hex_bytes(
    value: object,
    expected_bytes: int | None = None,
    code: SwapQuoteErrorCode = SwapQuoteErrorCode.INVALID_POOL_STATE,
) -> str:
    if not isinstance(value, str) or _HEX_BYTES.fullmatch(value) is None or len(value) % 2 != 0:
        _fail(code)
    if expected_bytes is not None and len(value) != expected_bytes * 2 + 2:
        _fail(code)
    return value.lower()


def _parse_hex_quantity(
    value: object,
    code: SwapQuoteErrorCode = SwapQuoteErrorCode.INVALID_POOL_STATE,
) -> int:
    if not isinstance(value, str) or len(value) > 66 or _HEX_QUANTITY.fullmatch(value) is None:
        _fail(code)
    try:
        parsed = int(value, 16)
    except ValueError:
        _fail(code)
    return _ensure_uint256(parsed, code)


def _parse_decimal_quantity(
    value: object,
    code: SwapQuoteErrorCode = SwapQuoteErrorCode.INVALID_POOL_STATE,
) -> int:
    if (
        not isinstance(value, str)
        or len(value) > 78
        or _NONNEGATIVE_DECIMAL.fullmatch(value) is None
    ):
        _fail(code)
    try:
        parsed = int(value, 10)
    except ValueError:
        _fail(code)
    return _ensure_uint256(parsed, code)


def _address_word(value: object) -> str:
    word = _parse_hex_bytes(value, 32)[2:]
    if not word.startswith("0" * 24) or _EVM_ADDRESS.fullmatch("0x" + word[24:]) is None:
        _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
    return "0x" + word[24:]


def _uint_word(value: object, maximum: int = _UINT256_MAX) -> int:
    bytes_value = _parse_hex_bytes(value, 32)
    parsed = int(bytes_value[2:], 16)
    if parsed > maximum:
        _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
    return parsed


def _reserve_words(value: object) -> _Reserves:
    bytes_value = _parse_hex_bytes(value, 96)[2:]
    reserve0 = _uint_word("0x" + bytes_value[0:64], _UINT112_MAX)
    reserve1 = _uint_word("0x" + bytes_value[64:128], _UINT112_MAX)
    _uint_word("0x" + bytes_value[128:192], _UINT32_MAX)
    return _Reserves(reserve0, reserve1)


def _block_header(value: object) -> _Header:
    mapping = _as_mapping(value)
    if mapping is None:
        _fail(SwapQuoteErrorCode.STATE_STALE)
    return _Header(
        number=_parse_hex_quantity(mapping.get("number"), SwapQuoteErrorCode.STATE_STALE),
        block_hash=_parse_hex_bytes(mapping.get("hash"), 32, SwapQuoteErrorCode.STATE_STALE),
        timestamp=_parse_hex_quantity(mapping.get("timestamp"), SwapQuoteErrorCode.STATE_STALE),
    )


def _assert_chain_id(value: object, chain_id: str) -> None:
    network = _parse_hex_quantity(value, SwapQuoteErrorCode.CHAIN_MISMATCH)
    expected = _EVM_NETWORK_IDS.get(chain_id)
    if expected is None or network != expected:
        _fail(SwapQuoteErrorCode.CHAIN_MISMATCH)


def _rpc_selector(block_hash: str) -> dict[str, object]:
    return {"blockHash": block_hash, "requireCanonical": True}


def _abi_call(to: str, data: str) -> dict[str, object]:
    return {"to": to, "data": data}


def _encode_address_argument(address: str) -> str:
    if _EVM_ADDRESS.fullmatch(address) is None:
        _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
    return address[2:].lower().rjust(64, "0")


def _execution_fail(code: SwapExecutionErrorCode) -> NoReturn:
    raise SwapExecutionError(code)


def _snapshot_execution_request(request: object) -> _ExecutionRequestSnapshot:
    mapping = _as_mapping(request)
    if mapping is None or any(
        not isinstance(key, str) or key not in _EXECUTION_REQUEST_KEYS for key in mapping
    ):
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)

    quote_request: dict[str, object] = {}
    for key in _EXECUTION_QUOTE_KEYS:
        value = mapping.get(key, _MISSING)
        if value is _MISSING:
            continue
        # Freshness is the only request value that is itself a mapping. Copy it
        # synchronously so mutations while RPC is in flight cannot affect the
        # quote's validation or freshness policy.
        if key == "freshness" and isinstance(value, Mapping):
            value = dict(value)
        quote_request[key] = value

    return _ExecutionRequestSnapshot(
        quote_request=quote_request,
        sender=mapping.get("sender", _MISSING),
        recipient=mapping.get("recipient", _MISSING),
        slippage_bps=mapping.get("slippageBps", _MISSING),
        deadline=mapping.get("deadline", _MISSING),
    )


def _normalize_execution_address(value: object) -> str:
    if not isinstance(value, str) or _EVM_ADDRESS.fullmatch(value) is None:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    normalized = value.lower()
    if normalized == "0x" + "0" * 40:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    return normalized


def _normalize_execution_slippage(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9999:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    return value


def _parse_execution_deadline(value: object) -> tuple[str, int]:
    if (
        not isinstance(value, str)
        or len(value) > 78
        or _UINT256_DECIMAL.fullmatch(value) is None
    ):
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    try:
        parsed = int(value, 10)
    except ValueError:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    if parsed <= 0 or parsed > _UINT256_MAX:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)
    return value, parsed


def _normalize_execution_request(
    request: object,
    current_clock: Callable[[], int],
) -> _NormalizedExecutionRequest:
    snapshot = _snapshot_execution_request(request)
    sender = _normalize_execution_address(snapshot.sender)
    recipient = _normalize_execution_address(snapshot.recipient)
    slippage_bps = _normalize_execution_slippage(snapshot.slippage_bps)
    deadline, deadline_value = _parse_execution_deadline(snapshot.deadline)

    # Reject an already-expired deadline before the first RPC. The quote block
    # timestamp and completion clock are checked again after their reads.
    now = current_clock()
    if deadline_value <= now:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)

    try:
        normalized = _normalize_request(snapshot.quote_request)
    except SwapQuoteError as error:
        if error.code in {
            SwapQuoteErrorCode.UNKNOWN_POOL,
            SwapQuoteErrorCode.UNSUPPORTED_ADAPTER,
            SwapQuoteErrorCode.UNSUPPORTED_TOKEN,
            SwapQuoteErrorCode.UNSUPPORTED_TOKEN_STANDARD,
        }:
            _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)
        raise

    return _NormalizedExecutionRequest(
        normalized=normalized,
        sender=sender,
        recipient=recipient,
        slippage_bps=slippage_bps,
        deadline=deadline,
        deadline_value=deadline_value,
    )


def _matches_execution_token(
    token: TokenDeployment | None,
    deployment_id: object,
    address: object,
    standard: object,
    chain_id: object,
) -> bool:
    return (
        token is not None
        and isinstance(deployment_id, str)
        and isinstance(address, str)
        and isinstance(standard, str)
        and isinstance(chain_id, str)
        and token.deployment_id == deployment_id
        and token.chain_id == chain_id
        and token.address == address
        and token.standard == standard == "erc20"
        and token.status == "active"
    )


def _is_execution_address(value: object) -> bool:
    return (
        isinstance(value, str)
        and _EVM_ADDRESS.fullmatch(value) is not None
        and value.lower() != "0x" + "0" * 40
    )


def _is_execution_selector(value: object) -> bool:
    return isinstance(value, str) and _HEX_BYTES.fullmatch(value) is not None and len(value) == 10


def _execution_capability_for(
    normalized: _NormalizedRequest,
) -> Mapping[str, object]:
    capability = next(
        (
            entry
            for entry in _EXECUTION_CAPABILITIES
            if entry.get("poolDefinitionId") == normalized.pool_definition_id
        ),
        None,
    )
    if capability is None or capability.get("status") != "active":
        _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)

    chain_id = capability.get("chainId")
    dex_id = capability.get("dexDeploymentId")
    token0_id = capability.get("token0DeploymentId")
    token1_id = capability.get("token1DeploymentId")
    wrapped_id = capability.get("wrappedNativeTokenDeploymentId")
    token0 = get_token_deployment(token0_id)
    token1 = get_token_deployment(token1_id)
    wrapped = get_token_deployment(wrapped_id)
    native_wrap = next(
        (
            definition
            for definition in NATIVE_WRAP_DEFINITIONS
            if definition.chain_id == chain_id
            and definition.wrapped_token_deployment_id == wrapped_id
        ),
        None,
    )

    input_matches = _matches_execution_token(
        normalized.input_token,
        token0_id,
        capability.get("token0Address"),
        capability.get("token0Standard"),
        chain_id,
    ) or _matches_execution_token(
        normalized.input_token,
        token1_id,
        capability.get("token1Address"),
        capability.get("token1Standard"),
        chain_id,
    )
    output_matches = _matches_execution_token(
        normalized.output_token,
        token0_id,
        capability.get("token0Address"),
        capability.get("token0Standard"),
        chain_id,
    ) or _matches_execution_token(
        normalized.output_token,
        token1_id,
        capability.get("token1Address"),
        capability.get("token1Standard"),
        chain_id,
    )

    matches = (
        chain_id == normalized.pool.chain_id
        and dex_id == normalized.pool.dex_deployment_id
        and isinstance(capability.get("swapExecutionCapabilityId"), str)
        and _is_execution_address(capability.get("factoryAddress"))
        and _is_execution_address(capability.get("routerAddress"))
        and _is_execution_address(capability.get("wrappedNativeTokenAddress"))
        and _is_execution_selector(capability.get("wrappedNativeFunctionSelector"))
        and capability.get("adapterKind") == SUPPORTED_QUOTE_ADAPTER
        and capability.get("functionKind") == "exact-input-erc20-to-erc20"
        and capability.get("functionSignature") == SWAP_EXECUTION_FUNCTION_SIGNATURE
        and capability.get("functionSelector") == SWAP_EXECUTION_FUNCTION_SELECTOR
        and normalized.dex.status == "active"
        and normalized.dex.program_address == capability.get("factoryAddress")
        and normalized.dex.adapter_kind == capability.get("adapterKind")
        and normalized.pool.status == "active"
        and normalized.pool.adapter.kind == capability.get("adapterKind")
        and normalized.pool.adapter.fee_numerator == "3"
        and normalized.pool.adapter.fee_denominator == "1000"
        and normalized.pool.token0_deployment_id == token0_id
        and normalized.pool.token1_deployment_id == token1_id
        and input_matches
        and output_matches
        and token0 is not None
        and token1 is not None
        and wrapped is not None
        and wrapped.chain_id == chain_id
        and wrapped.address == capability.get("wrappedNativeTokenAddress")
        and wrapped.standard == "erc20"
        and wrapped.status == "active"
        and native_wrap is not None
        and native_wrap.status == "active"
        and native_wrap.wrapped_token_deployment_id == wrapped_id
    )
    if not matches:
        _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)
    return capability


def _parse_execution_hex_bytes(
    value: object,
    expected_bytes: int | None = None,
    code: SwapExecutionErrorCode = SwapExecutionErrorCode.INVALID_SIMULATION,
) -> str:
    if not isinstance(value, str) or _HEX_BYTES.fullmatch(value) is None or len(value) % 2 != 0:
        _execution_fail(code)
    if expected_bytes is not None and len(value) != expected_bytes * 2 + 2:
        _execution_fail(code)
    return value.lower()


def _execution_address_word(
    value: object,
    code: SwapExecutionErrorCode = SwapExecutionErrorCode.INVALID_SIMULATION,
) -> str:
    word = _parse_execution_hex_bytes(value, 32, code)[2:]
    if not word.startswith("0" * 24) or _EVM_ADDRESS.fullmatch("0x" + word[24:]) is None:
        _execution_fail(code)
    return "0x" + word[24:]


def _execution_uint_word(
    value: object,
    code: SwapExecutionErrorCode = SwapExecutionErrorCode.INVALID_SIMULATION,
) -> int:
    return int(_parse_execution_hex_bytes(value, 32, code)[2:], 16)


def _execution_uint_array_of_two(value: object) -> tuple[int, int]:
    payload = _parse_execution_hex_bytes(value)[2:]
    # offset, length, and two values are exactly four ABI words. Reject both
    # truncated and trailing data instead of silently accepting a prefix.
    if len(payload) != 256:
        _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)
    try:
        offset = int(payload[0:64], 16)
        length = int(payload[64:128], 16)
    except ValueError:
        _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)
    if offset != 0x20 or length != 2:
        _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)
    return (
        _execution_uint_word("0x" + payload[128:192]),
        _execution_uint_word("0x" + payload[192:256]),
    )


def _encode_execution_uint256_word(value: int) -> str:
    _ensure_uint256(value)
    return format(value, "064x")


def _execution_token_address(token: TokenDeployment) -> str:
    if token.address is None or _EVM_ADDRESS.fullmatch(token.address) is None:
        _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)
    return token.address.lower()


def _execution_get_amounts_out_data(amount_in: int, input_address: str, output_address: str) -> str:
    return (
        _ROUTER_GET_AMOUNTS_OUT_SELECTOR
        + _encode_execution_uint256_word(amount_in)
        + _encode_execution_uint256_word(0x40)
        + _encode_execution_uint256_word(2)
        + _encode_address_argument(input_address)
        + _encode_address_argument(output_address)
    )


def _execution_swap_data(
    amount_in: int,
    minimum_amount_out: int,
    input_address: str,
    output_address: str,
    recipient: str,
    deadline: int,
) -> str:
    return (
        SWAP_EXECUTION_FUNCTION_SELECTOR
        + _encode_execution_uint256_word(amount_in)
        + _encode_execution_uint256_word(minimum_amount_out)
        + _encode_execution_uint256_word(0xA0)
        + _encode_address_argument(recipient)
        + _encode_execution_uint256_word(deadline)
        + _encode_execution_uint256_word(2)
        + _encode_address_argument(input_address)
        + _encode_address_argument(output_address)
    )


def _is_recognized_execution_revert(error: object) -> bool:
    if not isinstance(error, ErpcJsonRpcError) or error.rpc_code not in {
        3,
        -32000,
        -32015,
        -32603,
    }:
        return False
    message = str(error).lower()
    return (
        "execution reverted" in message
        or "transaction reverted" in message
        or "vm execution error" in message
        or re.match(r"^revert(?:ed)?(?:\b|:)", message) is not None
    )


def _assert_execution_deadline(
    execution: _NormalizedExecutionRequest,
    quote_timestamp: int,
    completion_clock: int,
) -> None:
    if execution.deadline_value <= quote_timestamp or execution.deadline_value <= completion_clock:
        _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)


class SwapClient:
    """Configured RPC-backed swap quote client.

    ``_clock`` is intentionally private and exists for deterministic package
    tests. The normal :class:`ErpcClient` construction leaves it unset and
    uses the local wall clock.
    """

    def __init__(
        self,
        ethereum: HttpJsonRpcTransport,
        avalanche: HttpJsonRpcTransport,
        *,
        _clock: Callable[[], int] | None = None,
    ) -> None:
        self._ethereum = ethereum
        self._avalanche = avalanche
        self._clock = _clock

    async def _rpc_request(
        self,
        transport: HttpJsonRpcTransport,
        method: str,
        params: list[object],
        options: RequestOptions,
    ) -> object:
        if options.cancel_event is not None and options.cancel_event.is_set():
            raise ErpcAbortedError()
        return await transport.request(
            method,
            cast(JsonRpcParams, params),
            options,
        )

    async def quote_exact_input(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> ExactInputQuoteResult:
        """Read a consistent EVM V2 snapshot and calculate an exact-input quote."""

        normalized = _normalize_request(request)
        if (
            normalized.pool.adapter.kind != SUPPORTED_QUOTE_ADAPTER
            or normalized.dex.adapter_kind != SUPPORTED_QUOTE_ADAPTER
        ):
            _fail(SwapQuoteErrorCode.UNSUPPORTED_ADAPTER)
        if normalized.chain_id == DEX_CHAIN_IDS["ethereum"]:
            transport = self._ethereum
        elif normalized.chain_id == DEX_CHAIN_IDS["avalancheC"]:
            transport = self._avalanche
        else:
            _fail(SwapQuoteErrorCode.UNSUPPORTED_ADAPTER)

        if options.cancel_event is not None and options.cancel_event.is_set():
            raise ErpcAbortedError()
        state = await self._read_evm_state(transport, normalized, options)
        # Recheck immediately before decoding/calculating the result so a
        # test clock or a moving wall clock cannot silently age the quote.
        self._assert_freshness(state, normalized.freshness)
        amount_out, fee_numerator, fee_denominator = self._calculate_quote(normalized, state)
        return self._quote_result(
            normalized,
            state,
            amount_out,
            fee_numerator,
            fee_denominator,
        )

    def _transport_for_normalized(self, normalized: _NormalizedRequest) -> HttpJsonRpcTransport:
        if normalized.chain_id == DEX_CHAIN_IDS["ethereum"]:
            return self._ethereum
        if normalized.chain_id == DEX_CHAIN_IDS["avalancheC"]:
            return self._avalanche
        _fail(SwapQuoteErrorCode.UNSUPPORTED_ADAPTER)

    def _build_execution_preparation(
        self,
        execution: _NormalizedExecutionRequest,
        capability: Mapping[str, object],
        quote: ExactInputQuoteResult,
    ) -> ExactInputSwapPreparation:
        input_address = _execution_token_address(execution.normalized.input_token)
        output_address = _execution_token_address(execution.normalized.output_token)
        quote_amount_out = _parse_decimal_quantity(
            quote["amountOut"],
            SwapQuoteErrorCode.ARITHMETIC,
        )
        product = quote_amount_out * (10000 - execution.slippage_bps)
        _ensure_uint256(product, SwapQuoteErrorCode.ARITHMETIC)
        minimum_amount_out = product // 10000
        if minimum_amount_out <= 0:
            _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)

        router_address = capability.get("routerAddress")
        if not isinstance(router_address, str):
            _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)
        transaction: ExactInputSwapTransaction = {
            "kind": "evm-unsigned-transaction",
            "chainId": quote["chainId"],
            "from": execution.sender,
            "to": router_address,
            "data": _execution_swap_data(
                execution.normalized.amount_in,
                minimum_amount_out,
                input_address,
                output_address,
                execution.recipient,
                execution.deadline_value,
            ),
            "value": "0",
        }
        path: list[ExactInputSwapPathEntry] = [
            {
                "tokenDeploymentId": execution.normalized.input_token_deployment_id,
                "address": input_address,
                "standard": "erc20",
                "representationKind": execution.normalized.input_token.representation_kind,
            },
            {
                "tokenDeploymentId": execution.normalized.output_token_deployment_id,
                "address": output_address,
                "standard": "erc20",
                "representationKind": execution.normalized.output_token.representation_kind,
            },
        ]
        return {
            "preparationKind": "evm-router-v2-exact-input",
            "executionCapabilityId": str(capability["swapExecutionCapabilityId"]),
            "executionCapabilityDigest": SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
            "quote": quote,
            "minimumAmountOut": str(minimum_amount_out),
            "slippageBps": execution.slippage_bps,
            "deadline": execution.deadline,
            "recipient": execution.recipient,
            "path": path,
            "transaction": transaction,
            "allowance": {
                "tokenDeploymentId": execution.normalized.input_token_deployment_id,
                "tokenAddress": input_address,
                "owner": execution.sender,
                "spender": router_address,
                "requiredAmount": quote["amountIn"],
            },
        }

    async def _prepare_execution_context(
        self,
        execution: _NormalizedExecutionRequest,
        capability: Mapping[str, object],
        transport: HttpJsonRpcTransport,
        options: RequestOptions,
    ) -> _PreparedExecutionContext:
        # Reuse the existing eleven-call quote path verbatim. Router reads are
        # appended only after the quote has passed its own freshness checks.
        state = await self._read_evm_state(transport, execution.normalized, options)
        self._assert_freshness(state, execution.normalized.freshness)
        amount_out, fee_numerator, fee_denominator = self._calculate_quote(
            execution.normalized,
            state,
        )
        quote = self._quote_result(
            execution.normalized,
            state,
            amount_out,
            fee_numerator,
            fee_denominator,
        )
        if execution.deadline_value <= state.initial.timestamp:
            _execution_fail(SwapExecutionErrorCode.INVALID_ARGUMENT)

        input_address = _execution_token_address(execution.normalized.input_token)
        output_address = _execution_token_address(execution.normalized.output_token)
        router_address = capability.get("routerAddress")
        factory_address = capability.get("factoryAddress")
        wrapped_selector = capability.get("wrappedNativeFunctionSelector")
        if (
            not isinstance(router_address, str)
            or not isinstance(factory_address, str)
            or not isinstance(wrapped_selector, str)
        ):
            _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)
        selector = _rpc_selector(state.initial.block_hash)

        router_code_raw = await self._rpc_request(
            transport,
            "eth_getCode",
            [router_address, selector],
            options,
        )
        router_code = _parse_execution_hex_bytes(router_code_raw)
        if len(router_code) <= 2:
            _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)

        router_factory_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(router_address, _ROUTER_FACTORY_SELECTOR), selector],
            options,
        )
        router_factory = _execution_address_word(router_factory_raw)
        if router_factory != factory_address:
            _execution_fail(SwapExecutionErrorCode.PROGRAM_MISMATCH)

        wrapped_native_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(router_address, wrapped_selector), selector],
            options,
        )
        wrapped_native = _execution_address_word(wrapped_native_raw)
        if wrapped_native != capability.get("wrappedNativeTokenAddress"):
            _execution_fail(SwapExecutionErrorCode.PROGRAM_MISMATCH)

        amounts_out_raw = await self._rpc_request(
            transport,
            "eth_call",
            [
                _abi_call(
                    router_address,
                    _execution_get_amounts_out_data(
                        execution.normalized.amount_in,
                        input_address,
                        output_address,
                    ),
                ),
                selector,
            ],
            options,
        )
        amounts_out = _execution_uint_array_of_two(amounts_out_raw)
        quote_amount_out = _parse_decimal_quantity(
            quote["amountOut"],
            SwapQuoteErrorCode.ARITHMETIC,
        )
        if amounts_out != (execution.normalized.amount_in, quote_amount_out):
            _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)

        latest_after_router_reads = _block_header(
            await self._rpc_request(
                transport,
                "eth_getBlockByNumber",
                ["latest", False],
                options,
            )
        )
        self._assert_freshness(
            _EvmState(state.initial, latest_after_router_reads, state.reserves),
            execution.normalized.freshness,
        )
        preparation = self._build_execution_preparation(execution, capability, quote)
        _assert_execution_deadline(
            execution,
            state.initial.timestamp,
            self._current_clock_seconds(),
        )
        return _PreparedExecutionContext(
            normalized=execution,
            capability=capability,
            transport=transport,
            state=state,
            quote=quote,
            preparation=preparation,
        )

    async def prepare_exact_input_swap(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> ExactInputSwapPreparation:
        """Prepare unsigned ERC20-to-ERC20 router calldata from fresh RPC data."""

        execution = _normalize_execution_request(request, self._current_clock_seconds)
        capability = _execution_capability_for(execution.normalized)
        transport = self._transport_for_normalized(execution.normalized)
        context = await self._prepare_execution_context(execution, capability, transport, options)
        return context.preparation

    async def simulate_exact_input_swap(
        self,
        request: object,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> ExactInputSwapSimulation:
        """Prepare and simulate an unsigned router call through configured RPC."""

        execution = _normalize_execution_request(request, self._current_clock_seconds)
        capability = _execution_capability_for(execution.normalized)
        transport = self._transport_for_normalized(execution.normalized)
        context = await self._prepare_execution_context(execution, capability, transport, options)

        selector = _rpc_selector(context.state.initial.block_hash)
        router_address = context.capability.get("routerAddress")
        if not isinstance(router_address, str):
            _execution_fail(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)
        input_address = context.preparation["allowance"]["tokenAddress"]
        allowance_data = (
            _ERC20_ALLOWANCE_SELECTOR
            + _encode_address_argument(execution.sender)
            + _encode_address_argument(router_address)
        )
        allowance_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(input_address, allowance_data), selector],
            options,
        )
        current_allowance = _execution_uint_word(
            allowance_raw,
            SwapExecutionErrorCode.INSUFFICIENT_ALLOWANCE,
        )
        if current_allowance < execution.normalized.amount_in:
            _execution_fail(SwapExecutionErrorCode.INSUFFICIENT_ALLOWANCE)

        try:
            simulation_raw = await self._rpc_request(
                transport,
                "eth_call",
                [
                    {
                        "from": context.preparation["transaction"]["from"],
                        "to": context.preparation["transaction"]["to"],
                        "data": context.preparation["transaction"]["data"],
                        "value": "0x0",
                    },
                    selector,
                ],
                options,
            )
        except ErpcJsonRpcError as error:
            if _is_recognized_execution_revert(error):
                # The transport error is already credential-redacted. Do not
                # retain a provider/native exception as an execution cause.
                raise SwapExecutionError(
                    SwapExecutionErrorCode.SIMULATION_REVERTED
                ) from None
            raise

        latest_after_simulation = _block_header(
            await self._rpc_request(
                transport,
                "eth_getBlockByNumber",
                ["latest", False],
                options,
            )
        )
        self._assert_freshness(
            _EvmState(context.state.initial, latest_after_simulation, context.state.reserves),
            execution.normalized.freshness,
        )

        amounts = _execution_uint_array_of_two(simulation_raw)
        quote_amount_out = _parse_decimal_quantity(
            context.quote["amountOut"],
            SwapQuoteErrorCode.ARITHMETIC,
        )
        minimum_amount_out = _parse_decimal_quantity(
            context.preparation["minimumAmountOut"],
            SwapQuoteErrorCode.ARITHMETIC,
        )
        if (
            amounts[0] != execution.normalized.amount_in
            or amounts[1] != quote_amount_out
            or amounts[1] < minimum_amount_out
        ):
            _execution_fail(SwapExecutionErrorCode.INVALID_SIMULATION)

        _assert_execution_deadline(
            execution,
            context.state.initial.timestamp,
            self._current_clock_seconds(),
        )
        return {
            "simulationKind": "evm-call",
            "preparation": context.preparation,
            "snapshot": context.quote["snapshot"],
            "currentAllowance": str(current_allowance),
            "amounts": [str(amounts[0]), str(amounts[1])],
            "amountOut": str(amounts[1]),
        }

    async def _read_evm_state(
        self,
        transport: HttpJsonRpcTransport,
        normalized: _NormalizedRequest,
        options: RequestOptions,
    ) -> _EvmState:
        chain_value = await self._rpc_request(transport, "eth_chainId", [], options)
        _assert_chain_id(chain_value, normalized.pool.chain_id)
        initial = _block_header(
            await self._rpc_request(transport, "eth_getBlockByNumber", ["latest", False], options)
        )
        selector = _rpc_selector(initial.block_hash)

        # Keep all state responses opaque until both final headers have passed
        # freshness and reorg checks. This gives stale state precedence over a
        # malformed ABI response received from the same snapshot.
        factory_code_raw = await self._rpc_request(
            transport,
            "eth_getCode",
            [normalized.dex.program_address, selector],
            options,
        )
        pool_code_raw = await self._rpc_request(
            transport,
            "eth_getCode",
            [normalized.pool.address, selector],
            options,
        )
        token0 = get_token_deployment(normalized.pool.token0_deployment_id)
        token1 = get_token_deployment(normalized.pool.token1_deployment_id)
        if token0 is None or token1 is None or not token0.address or not token1.address:
            _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
        pair_data = (
            _FACTORY_GET_PAIR_SELECTOR
            + _encode_address_argument(token0.address)
            + _encode_address_argument(token1.address)
        )
        factory_pair_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(normalized.dex.program_address, pair_data), selector],
            options,
        )
        pair_factory_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(normalized.pool.address, _PAIR_FACTORY_SELECTOR), selector],
            options,
        )
        pair_token0_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(normalized.pool.address, _PAIR_TOKEN0_SELECTOR), selector],
            options,
        )
        pair_token1_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(normalized.pool.address, _PAIR_TOKEN1_SELECTOR), selector],
            options,
        )
        reserves_raw = await self._rpc_request(
            transport,
            "eth_call",
            [_abi_call(normalized.pool.address, _PAIR_GET_RESERVES_SELECTOR), selector],
            options,
        )

        latest_after_reads = _block_header(
            await self._rpc_request(transport, "eth_getBlockByNumber", ["latest", False], options)
        )
        reread = _block_header(
            await self._rpc_request(
                transport,
                "eth_getBlockByNumber",
                [f"0x{initial.number:x}", False],
                options,
            )
        )
        if (
            reread.number != initial.number
            or reread.block_hash != initial.block_hash
            or reread.timestamp != initial.timestamp
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)

        buffered = _EvmState(initial, latest_after_reads, _Reserves(0, 0))
        self._assert_freshness(buffered, normalized.freshness)

        factory_code = _parse_hex_bytes(factory_code_raw)
        if len(factory_code) <= 2:
            _fail(SwapQuoteErrorCode.PROGRAM_MISMATCH)
        pool_code = _parse_hex_bytes(pool_code_raw)
        if len(pool_code) <= 2:
            _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
        factory_pair = _address_word(factory_pair_raw)
        if factory_pair != normalized.pool.address:
            _fail(SwapQuoteErrorCode.PROGRAM_MISMATCH)
        pair_factory = _address_word(pair_factory_raw)
        if pair_factory != normalized.dex.program_address:
            _fail(SwapQuoteErrorCode.PROGRAM_MISMATCH)
        pair_token0 = _address_word(pair_token0_raw)
        pair_token1 = _address_word(pair_token1_raw)
        if pair_token0 != token0.address.lower() or pair_token1 != token1.address.lower():
            _fail(SwapQuoteErrorCode.POOL_TOKEN_MISMATCH)
        reserves = _reserve_words(reserves_raw)
        return _EvmState(initial, latest_after_reads, reserves)

    def _current_clock_seconds(self) -> int:
        value = int(time.time()) if self._clock is None else self._clock()
        if isinstance(value, bool) or not isinstance(value, int):
            _fail(SwapQuoteErrorCode.INVALID_ARGUMENT)
        return value

    def _assert_freshness(self, state: _EvmState, freshness: _Freshness) -> None:
        now = self._current_clock_seconds()
        initial_age = now - state.initial.timestamp
        if (
            initial_age < -freshness.max_clock_skew_seconds
            or initial_age > freshness.max_block_age_seconds
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)
        latest_age = now - state.latest_after_reads.timestamp
        if (
            latest_age < -freshness.max_clock_skew_seconds
            or latest_age > freshness.max_block_age_seconds
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)
        if (
            state.latest_after_reads.number < state.initial.number
            or state.latest_after_reads.number - state.initial.number > freshness.max_block_lag
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)
        if (
            state.latest_after_reads.number == state.initial.number
            and state.latest_after_reads.block_hash != state.initial.block_hash
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)
        if (
            state.latest_after_reads.number > state.initial.number
            and state.latest_after_reads.timestamp < state.initial.timestamp
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)
        if (
            state.latest_after_reads.number == state.initial.number
            and state.latest_after_reads.block_hash == state.initial.block_hash
            and state.latest_after_reads.timestamp != state.initial.timestamp
        ):
            _fail(SwapQuoteErrorCode.STATE_STALE)

    def _calculate_quote(
        self,
        normalized: _NormalizedRequest,
        state: _EvmState,
    ) -> tuple[int, int, int]:
        fee_numerator = _parse_decimal_quantity(
            normalized.pool.adapter.fee_numerator,
            SwapQuoteErrorCode.ARITHMETIC,
        )
        fee_denominator = _parse_decimal_quantity(
            normalized.pool.adapter.fee_denominator,
            SwapQuoteErrorCode.ARITHMETIC,
        )
        if fee_denominator <= fee_numerator:
            _fail(SwapQuoteErrorCode.ARITHMETIC)
        token0 = get_token_deployment(normalized.pool.token0_deployment_id)
        if token0 is None or not token0.address or not normalized.input_token.address:
            _fail(SwapQuoteErrorCode.INVALID_POOL_STATE)
        input_is_token0 = normalized.input_token.address.lower() == token0.address.lower()
        reserve_in = state.reserves.reserve0 if input_is_token0 else state.reserves.reserve1
        reserve_out = state.reserves.reserve1 if input_is_token0 else state.reserves.reserve0
        if reserve_in <= 0 or reserve_out <= 0:
            _fail(SwapQuoteErrorCode.INSUFFICIENT_LIQUIDITY)

        adjusted = _ensure_uint256(normalized.amount_in * (fee_denominator - fee_numerator))
        denominator = _ensure_uint256(reserve_in * fee_denominator + adjusted)
        if denominator <= 0:
            _fail(SwapQuoteErrorCode.ARITHMETIC)
        numerator = _ensure_uint256(adjusted * reserve_out)
        amount_out = numerator // denominator
        _ensure_uint256(amount_out)
        if amount_out <= 0 or amount_out > reserve_out:
            _fail(SwapQuoteErrorCode.INSUFFICIENT_LIQUIDITY)
        return amount_out, fee_numerator, fee_denominator

    @staticmethod
    def _quote_result(
        normalized: _NormalizedRequest,
        state: _EvmState,
        amount_out: int,
        fee_numerator: int,
        fee_denominator: int,
    ) -> ExactInputQuoteResult:
        return {
            "quoteKind": "exact-input",
            "chainId": normalized.chain_id,
            "poolDefinitionId": normalized.pool_definition_id,
            "dexDeploymentId": normalized.pool.dex_deployment_id,
            "adapterKind": normalized.pool.adapter.kind,
            "inputTokenDeploymentId": normalized.input_token_deployment_id,
            "outputTokenDeploymentId": normalized.output_token_deployment_id,
            "amountIn": str(normalized.amount_in),
            "amountOut": str(amount_out),
            "fee": {
                "numerator": str(fee_numerator),
                "denominator": str(fee_denominator),
            },
            "snapshot": {
                "kind": "evm-block",
                "blockNumber": str(state.initial.number),
                "blockHash": state.initial.block_hash,
                "blockTimestamp": str(state.initial.timestamp),
            },
            "tokenCatalogDigest": TOKEN_CATALOG_CONTENT_DIGEST,
            "dexCatalogDigest": DEX_CATALOG_CONTENT_DIGEST,
        }


__all__ = [
    "EvmBlockSnapshot",
    "ExactInputQuoteRequest",
    "ExactInputQuoteResult",
    "ExactInputSwapAllowance",
    "ExactInputSwapPathEntry",
    "ExactInputSwapPreparation",
    "ExactInputSwapRequest",
    "ExactInputSwapSimulation",
    "ExactInputSwapTransaction",
    "PrepareExactInputSwapRequest",
    "PrepareExactInputSwapResult",
    "QuoteFee",
    "SimulateExactInputSwapResult",
    "SUPPORTED_QUOTE_ADAPTER",
    "SwapClient",
    "SwapExecutionError",
    "SwapExecutionErrorCode",
    "SwapFreshness",
    "SwapPreparation",
    "SwapQuoteError",
    "SwapQuoteErrorCode",
    "SwapSimulation",
    "SWAP_EXECUTION_ERROR_MESSAGES",
    "SWAP_QUOTE_ERROR_MESSAGES",
]
