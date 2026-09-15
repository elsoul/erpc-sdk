"""RPC-only exact-input swap quotes for the bundled EVM V2 pools."""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Literal, NoReturn, NotRequired, TypedDict, cast

from ._token_catalog_data import TokenDeployment
from .dex_catalog import (
    DEX_CATALOG_CONTENT_DIGEST,
    DEX_CHAIN_IDS,
    DexDeployment,
    PoolDefinition,
    get_dex_deployment,
    get_pool_definition,
)
from .errors import ErpcAbortedError
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

_FACTORY_GET_PAIR_SELECTOR = "0xe6a43905"
_PAIR_FACTORY_SELECTOR = "0xc45a0155"
_PAIR_TOKEN0_SELECTOR = "0x0dfe1681"
_PAIR_TOKEN1_SELECTOR = "0xd21220a7"
_PAIR_GET_RESERVES_SELECTOR = "0x0902f1ac"


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
    "QuoteFee",
    "SUPPORTED_QUOTE_ADAPTER",
    "SwapClient",
    "SwapFreshness",
    "SwapQuoteError",
    "SwapQuoteErrorCode",
    "SWAP_QUOTE_ERROR_MESSAGES",
]
