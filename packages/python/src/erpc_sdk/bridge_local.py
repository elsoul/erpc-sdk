"""Local unsigned construction for the Mayan Swift v2 bridge.

This module contains the bounded, read-only source-swap and source-RPC
construction path.  It deliberately does not create keys, sign, submit, or
broadcast transactions, and it never falls back to the hosted ``/build``
endpoint.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import json
import math
import re
import struct
import time
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, TypeAlias, TypedDict, cast
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from Crypto.Hash import keccak

from .bridge import (
    _BRIDGE_CAPABILITIES,
    _MISSING,
    DEFAULT_BUILDER_ENDPOINT,
    DEFAULT_EXPLORER_ENDPOINT,
    ETHEREUM_CHAIN_ID,
    ETHEREUM_FORWARDER,
    MAYAN_USDC_MINT,
    SOLANA_CHAIN_ID,
    SOLANA_JUPITER_V6,
    SOLANA_SWIFT_PROGRAM,
    BridgeError,
    BridgeErrorCode,
    MayanSwiftV2Quote,
    MayanSwiftV2UnsignedTransaction,
    _await_provider,
    _base58_decode,
    _base58_encode,
    _build_route_from_quote,
    _fail,
    _JsonNode,
    _NormalizedBridgeConfig,
    _object_entry,
    _object_value,
    _parse_provider_response,
    _provider_address_matches,
    _strict_equal,
    _validate_normalized_quote_shape,
    _validate_raw_quote_for_build,
)
from .config import RpcEndpointConfig
from .token_catalog import get_token_deployment
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions


class MayanSwiftV2LocalContext(TypedDict):
    quote: MayanSwiftV2Quote
    swapperAddress: str
    destinationAddress: str
    orderNonce: str


class MayanSwiftV2LocalSourceSwapInstructionAccount(TypedDict):
    pubkey: str
    isSigner: bool
    isWritable: bool


class MayanSwiftV2LocalSourceSwapInstruction(TypedDict):
    programId: str
    accounts: list[MayanSwiftV2LocalSourceSwapInstructionAccount]
    dataBase64: str


class MayanSwiftV2LocalSourceSwapNone(TypedDict):
    kind: Literal["none"]


class MayanSwiftV2LocalSourceSwapEvmRouter(TypedDict):
    kind: Literal["evm-router"]
    routerAddress: str
    calldata: str
    rawResponseSha256: str
    rawProviderSourceSwapJson: str


class MayanSwiftV2LocalSourceSwapSolanaJupiter(TypedDict):
    kind: Literal["solana-jupiter-v6"]
    instructions: list[MayanSwiftV2LocalSourceSwapInstruction]
    addressLookupTableAddresses: list[str]
    rawResponseSha256: str
    rawProviderSourceSwapJson: str


MayanSwiftV2LocalSourceSwapPlan: TypeAlias = (
    MayanSwiftV2LocalSourceSwapNone
    | MayanSwiftV2LocalSourceSwapEvmRouter
    | MayanSwiftV2LocalSourceSwapSolanaJupiter
)


class MayanSwiftV2SourceSwapPlan(TypedDict):
    planKind: Literal["mayan-swift-v2-local-source-swap"]
    providerId: Literal["mayan-swift-v2"]
    capabilityId: str
    sourceChainId: str
    destinationChainId: str
    sourceTokenDeploymentId: str
    destinationTokenDeploymentId: str
    quoteId: str
    rawQuoteSha256: str
    orderNonce: str
    swapperAddress: str
    destinationAddress: str
    orderHash: str
    quoteBindingHash: str
    minimumIntermediateAmount: str
    sourceSwap: MayanSwiftV2LocalSourceSwapPlan
    planHash: str


class MayanSwiftV2LocalBuildRequest(MayanSwiftV2LocalContext):
    sourceSwapPlan: MayanSwiftV2SourceSwapPlan


class MayanSwiftV2LocalEvmRpcCode(TypedDict):
    address: str
    keccak256: str


class MayanSwiftV2LocalEvmRpcEvidence(TypedDict):
    kind: Literal["evm"]
    rpcChainId: Literal["0x1"]
    code: list[MayanSwiftV2LocalEvmRpcCode]


class MayanSwiftV2LocalSolanaRpcLookupTableEvidence(TypedDict):
    address: str
    dataSha256: str


class MayanSwiftV2LocalSolanaRpcEvidence(TypedDict):
    kind: Literal["solana"]
    genesisHash: str
    blockhashContextSlot: str
    accountContextSlot: str
    recentBlockhash: str
    lastValidBlockHeight: str
    lookupTables: list[MayanSwiftV2LocalSolanaRpcLookupTableEvidence]


MayanSwiftV2LocalSourceRpcEvidence: TypeAlias = (
    MayanSwiftV2LocalEvmRpcEvidence | MayanSwiftV2LocalSolanaRpcEvidence
)


class MayanSwiftV2LocalConstruction(TypedDict):
    mode: Literal["local"]
    referenceCommit: Literal["c4c98031aaad9264d17630d7b4de0cb18688cf78"]
    orderNonce: str
    orderHash: str
    minimumIntermediateAmount: str
    effectiveDependencies: list[str]
    sourceRpcEvidence: MayanSwiftV2LocalSourceRpcEvidence


class MayanSwiftV2LocalBuildValidation(TypedDict):
    level: Literal["local-structural"]
    quoteSignatureLocallyVerified: Literal[False]
    planBindingLocallyVerified: Literal[True]
    transactionBytesLocallyConstructed: Literal[True]
    settlementLocallyVerified: Literal[False]


class MayanSwiftV2LocalBuild(TypedDict):
    buildKind: Literal["mayan-swift-v2-local-unsigned"]
    providerId: Literal["mayan-swift-v2"]
    capabilityId: str
    quote: MayanSwiftV2Quote
    sourceChainId: str
    destinationChainId: str
    sourceSwapPlan: MayanSwiftV2SourceSwapPlan
    transaction: MayanSwiftV2UnsignedTransaction
    allowance: dict[str, str] | None
    construction: MayanSwiftV2LocalConstruction
    validation: MayanSwiftV2LocalBuildValidation


@dataclass(frozen=True, slots=True)
class LocalRuntime:
    local_build: Mapping[str, object] | None
    http_client: httpx.AsyncClient
    timeout: float
    minimum_quote_validity_seconds: int


@dataclass(frozen=True, slots=True)
class _LocalCapability:
    row: Mapping[str, object]
    is_usdc: bool

    @property
    def capability_id(self) -> str:
        return cast(str, self.row["bridgeCapabilityId"])

    @property
    def source_chain_id(self) -> str:
        return cast(str, self.row["sourceChainId"])

    @property
    def destination_chain_id(self) -> str:
        return cast(str, self.row["destinationChainId"])

    @property
    def source_token_deployment_id(self) -> str:
        return cast(str, self.row["sourceTokenDeploymentId"])

    @property
    def destination_token_deployment_id(self) -> str:
        return cast(str, self.row["destinationTokenDeploymentId"])

    @property
    def source_token_address(self) -> str:
        return cast(str, self.row["sourceTokenAddress"])

    @property
    def destination_token_address(self) -> str:
        return cast(str, self.row["destinationTokenAddress"])

    @property
    def source_usdc_address(self) -> str:
        return cast(str, self.row["sourceUsdcAddress"])

    @property
    def source_usdc_deployment_id(self) -> str:
        return cast(str, self.row["sourceUsdcDeploymentId"])

    @property
    def source_name(self) -> str:
        return cast(str, self.row["sourceProviderChainName"])

    @property
    def destination_name(self) -> str:
        return cast(str, self.row["destinationProviderChainName"])

    @property
    def source_provider_chain_id(self) -> int:
        return cast(int, self.row["sourceProviderChainId"])

    @property
    def destination_provider_chain_id(self) -> int:
        return cast(int, self.row["destinationProviderChainId"])

    @property
    def source_wormhole_chain_id(self) -> int:
        return cast(int, self.row["sourceWormholeChainId"])

    @property
    def destination_wormhole_chain_id(self) -> int:
        return cast(int, self.row["destinationWormholeChainId"])

    @property
    def swift_contract(self) -> str:
        return cast(str, self.row["swiftContract"])

    @property
    def dependencies(self) -> list[str]:
        return [cast(str, item) for item in cast(list[object], self.row["dependencies"])]


class _LocalValidationError(Exception):
    """Internal marker for a local plan/build validation failure."""


class _LocalTransportError(Exception):
    """Internal marker for a sanitized source transport failure."""


class _SourceResponseInvalidError(Exception):
    """Internal marker for a malformed or oversized source response."""


@dataclass(frozen=True, slots=True)
class _ParsedSourceQuote:
    raw: Mapping[str, object]
    root: _JsonNode
    minimum_intermediate_amount: str
    mode: Literal[2, 3]
    cancel_fee: int
    refund_fee: int
    submit_fee: int
    suggested_priority_fee: int | None


ETHEREUM_FORWARDER_PROVIDER: Final = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2"
SOLANA_TOKEN_PROGRAM: Final = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SOLANA_ASSOCIATED_TOKEN_PROGRAM: Final = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SOLANA_SYSTEM_PROGRAM: Final = "11111111111111111111111111111111"
SOLANA_SYSVAR_RENT: Final = "SysvarRent111111111111111111111111111111111"
SOLANA_COMPUTE_BUDGET_PROGRAM: Final = "ComputeBudget111111111111111111111111111111"
SOLANA_CPI_PROXY_PROGRAM: Final = "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa"
SOLANA_ANCHOR_EVENT_AUTHORITY: Final = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf"
SOLANA_FEE_MANAGER_PROGRAM: Final = "5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ"
SOLANA_MAINNET_GENESIS_HASH: Final = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
SOLANA_MAYAN_LOOKUP_TABLE: Final = "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht"
SOLANA_ADDRESS_LOOKUP_TABLE_OWNER: Final = "AddressLookupTab1e1111111111111111111111111"
SOLANA_ROUTE_V2_DISCRIMINATOR: Final = "bb64facc31c4af14"
SOLANA_ROUTE_V2_WHIRLPOOL_TAIL: Final = "000001000000110010270001"
SOLANA_ROUTE_V2_RAYDIUM_TAIL: Final = "0000010000001a10270001"
SOLANA_WHIRLPOOL_PROGRAM: Final = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
SOLANA_WHIRLPOOL_POOL: Final = "ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i"
SOLANA_RAYDIUM_CLMM_PROGRAM: Final = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
SOLANA_RAYDIUM_CLMM_POOL: Final = "2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w"
SOLANA_WHIRLPOOL_TICK_ARRAY_0: Final = "6i68TM44UYSawGAS4Bx1vX31Af7QNZaRNBLUbc4r8exB"
SOLANA_WHIRLPOOL_TICK_ARRAY_1: Final = "8aq9zUXe37KLtXSaEYt7oq65oNAJiu1my2kRNMRPhTD5"
SOLANA_WHIRLPOOL_TICK_ARRAY_2: Final = "7qscKXFXCd1WQinZJvSDLsGLTTEwjmd88a871pz2V3Ja"
SOLANA_WHIRLPOOL_ORACLE: Final = "CaohZGaBaLmXyFQ4cLc83wGZTET7Mt9xMtUqR9EGaMHF"
SOLANA_WHIRLPOOL_REWARD_VAULT: Final = "7Mr4WYMiGPAXkyt9ePsHHmV6ust3U6dHwBmyfMRiHPA7"
SOLANA_WHIRLPOOL_REMAINING: Final = "9BjNZYSCZ3ac3XUYVKte4YYtmBGd7ATKfRshTGN99NxQ"
SOLANA_RAYDIUM_CONFIG: Final = "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x"
SOLANA_RAYDIUM_OBSERVATION: Final = "GFwsANMCPK8W3WhqTnwVP8JiwHaAr3cNDe5TJqgHHSPe"
SOLANA_RAYDIUM_TICK_ARRAY_0: Final = "ECw2X1TYbsrqFgdiYApNpn2ggznbj8pL5tREpY9Fb8jY"
SOLANA_RAYDIUM_TICK_ARRAY_1: Final = "2UQncszfVU7igwDiGN3jq2sUKzziLxDZqNsJEXzEob5x"
SOLANA_RAYDIUM_TICK_ARRAY_2: Final = "BVvv13QAQjPYKTWrpX7wQbhBAu3pbWwTb8P9SAqgRNKQ"
SOLANA_RAYDIUM_TICK_ARRAY_3: Final = "4HSR9WBSHgw7n5V8WGYYhLW8g92RPSrgnf2CHzbeQrrr"
SOLANA_RAYDIUM_ORACLE: Final = "HssFpWsQcNbJXBro1NVWCFAYEh8jp6NJV2nyFhE1zMGj"
SOLANA_RAYDIUM_REMAINING: Final = "DKcmVcrXuiF5FZre6h8GqurR2sKChUGBakxdTX7dSDw9"
SOLANA_RAYDIUM_JUPITER_REMAINING: Final = SOLANA_JUPITER_V6
SOLANA_INIT_ORDER_DISCRIMINATOR: Final = "204c290c27a284db"
EVM_SOURCE_SWAP_SELECTOR: Final = "0x3f0bde25"
SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT: Final = "https://price-api.mayan.finance/v3"
MAYAN_REFERENCE_COMMIT: Final = "c4c98031aaad9264d17630d7b4de0cb18688cf78"
MAYAN_ORACLE_SDK_VERSION: Final = "15_2_2"
MAX_RESPONSE_BYTES: Final = 1024 * 1024
MAX_JSON_DEPTH: Final = 32
MAX_ROUTER_CALLDATA_BYTES: Final = 16_384
MAX_SOLANA_SWAP_ACCOUNTS: Final = 64
MAX_SOLANA_SWAP_DATA_BYTES: Final = 4096
MAX_LOOKUP_TABLES: Final = 8
MAX_LOOKUP_TABLE_ADDRESSES: Final = 256
MAX_SOLANA_TRANSACTION_BYTES: Final = 1232
UINT64_MAX: Final = (1 << 64) - 1
MAX_SAFE_INTEGER: Final = (1 << 53) - 1
EVM_ADDRESS_RE: Final = re.compile(r"0x[0-9a-fA-F]{40}")
HEX_BYTES_RE: Final = re.compile(r"0x(?:[0-9a-fA-F]{2})*")
UINT64_RE: Final = re.compile(r"(?:0|[1-9][0-9]*)")
NONCE_RE: Final = re.compile(r"0x[0-9a-f]{32}")
PLAIN_DECIMAL_RE: Final = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?")
EVM_SIGNATURE_RE: Final = re.compile(r"0x[0-9a-fA-F]{130}")


def _local_invalid() -> NoReturn:
    raise _LocalValidationError


def _bytes_to_hex(value: bytes) -> str:
    return value.hex()


def _sha256_hex(value: bytes | str) -> str:
    import hashlib

    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _keccak_hex(value: bytes) -> str:
    digest = keccak.new(digest_bits=256)
    digest.update(value)
    return digest.digest().hex()


def _concat(*parts: bytes) -> bytes:
    return b"".join(parts)


def _stable_json(value: object) -> str:
    if isinstance(value, Mapping):
        items = sorted(
            ((str(key), item) for key, item in value.items()),
            key=lambda entry: entry[0],
        )
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + _stable_json(item)
            for key, item in items
        ) + "}"
    if isinstance(value, list | tuple):
        return "[" + ",".join(_stable_json(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _clone_json(value: object) -> object:
    return json.loads(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _hex_to_bytes(value: str) -> bytes:
    source = value[2:] if value.startswith("0x") else value
    if len(source) % 2 or re.fullmatch(r"[0-9a-fA-F]*", source) is None:
        _local_invalid()
    try:
        return bytes.fromhex(source)
    except ValueError:
        _local_invalid()


def _normalize_evm_address(value: object) -> str:
    if not isinstance(value, str) or EVM_ADDRESS_RE.fullmatch(value) is None:
        _local_invalid()
    if value.lower() == "0x" + "0" * 40:
        _local_invalid()
    return value.lower()


def _base58_decode_local(value: object) -> bytes:
    if not isinstance(value, str) or not value:
        _local_invalid()
    try:
        return _base58_decode(value, 32, BridgeErrorCode.INVALID_ARGUMENT)
    except BridgeError:
        _local_invalid()


def _base58_encode_local(value: bytes) -> str:
    return _base58_encode(value)


def _canonical_solana_address(value: object) -> str:
    if not isinstance(value, str):
        _local_invalid()
    raw = _base58_decode_local(value)
    if len(raw) != 32 or _base58_encode_local(raw) != value:
        _local_invalid()
    return value


def _uint64(value: object, *, positive: bool = False) -> int:
    if not isinstance(value, str) or len(value) > 20 or UINT64_RE.fullmatch(value) is None:
        _local_invalid()
    parsed = int(value, 10)
    if parsed > UINT64_MAX or (positive and parsed == 0):
        _local_invalid()
    return parsed


def _word_uint(value: int) -> bytes:
    if value < 0 or value >= 1 << 256:
        _local_invalid()
    return value.to_bytes(32, "big")


def _word_address(value: str) -> bytes:
    return b"\0" * 12 + _hex_to_bytes(_normalize_evm_address(value))


def _word_bytes32(value: bytes) -> bytes:
    if len(value) != 32:
        _local_invalid()
    return value


def _pad32(value: bytes) -> bytes:
    return value + b"\0" * ((-len(value)) % 32)


def _encode_abi_bytes(value: bytes) -> bytes:
    return _word_uint(len(value)) + _pad32(value)


def _encode_abi_with_dynamics(head: Sequence[bytes], dynamics: Sequence[bytes]) -> bytes:
    offset = (len(head) + len(dynamics)) * 32
    offsets: list[bytes] = []
    for value in dynamics:
        offsets.append(_word_uint(offset))
        offset += 32 + len(_pad32(value))
    return _concat(*head, *offsets, *(_encode_abi_bytes(value) for value in dynamics))


def _native_address_bytes(value: str, chain_id: str) -> bytes:
    if chain_id == ETHEREUM_CHAIN_ID:
        return _word_address(value)
    return _base58_decode_local(_canonical_solana_address(value))


def _route_for_quote(quote: Mapping[str, object]) -> _LocalCapability:
    source_chain = quote.get("sourceChainId")
    destination_chain = quote.get("destinationChainId")
    source_token = quote.get("sourceTokenDeploymentId")
    destination_token = quote.get("destinationTokenDeploymentId")
    if not all(
        isinstance(value, str)
        for value in (source_chain, destination_chain, source_token, destination_token)
    ):
        _local_invalid()
    for row in _BRIDGE_CAPABILITIES:
        if (
            row.get("sourceChainId") == source_chain
            and row.get("destinationChainId") == destination_chain
            and row.get("sourceTokenDeploymentId") == source_token
            and row.get("destinationTokenDeploymentId") == destination_token
        ):
            capability_id = row.get("bridgeCapabilityId")
            if not isinstance(capability_id, str):
                _local_invalid()
            return _LocalCapability(row, "-usdc-" in capability_id)
    _local_invalid()


def _provider_standard(chain_id: str) -> Literal["erc20", "spl"]:
    return "erc20" if chain_id == ETHEREUM_CHAIN_ID else "spl"


def _assert_catalog_token(
    deployment_id: str,
    chain_id: str,
    address: str,
    standard: str,
) -> None:
    token = get_token_deployment(deployment_id)
    if token is None or token.address is None:
        _local_invalid()
    address_matches = (
        token.address.lower() == address.lower()
        if chain_id == ETHEREUM_CHAIN_ID
        else token.address == address
    )
    if not (
        token.deployment_id == deployment_id
        and token.chain_id == chain_id
        and address_matches
        and token.standard == standard
        and token.decimals == 6
        and token.status == "active"
    ):
        _local_invalid()


def _local_json_object(text: str) -> tuple[_JsonNode, Mapping[str, object]]:
    try:
        root = _parse_provider_response(text)
    except BridgeError:
        _local_invalid()
    if root.object_entries is None or not isinstance(root.value, Mapping):
        _local_invalid()
    return root, cast(Mapping[str, object], root.value)


def _node_value(root: _JsonNode, key: str) -> object:
    if root.object_entries is None:
        _local_invalid()
    child = root.object_entries.get(key)
    return child.value if child is not None else _MISSING


def _required_node(root: _JsonNode, key: str) -> _JsonNode:
    if root.object_entries is None:
        _local_invalid()
    child = root.object_entries.get(key)
    if child is None:
        _local_invalid()
    return child


def _raw_number_lexeme(root: _JsonNode, key: str) -> str:
    child = _required_node(root, key)
    if child.raw_number is None:
        _local_invalid()
    return child.raw_number


def _raw_number_zero(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(float(value)) and value == 0
    return value == "0"


def _raw_integer_is(value: object, expected: int) -> bool:
    return type(value) is int and value == expected


def _raw_uint64(raw: Mapping[str, object], key: str, *, required: bool = True) -> int:
    value = raw.get(key, _MISSING)
    if value is _MISSING and not required:
        return 0
    return _uint64(value, positive=False)


def _raw_optional_bounded_integer(
    raw: Mapping[str, object], key: str, maximum: int
) -> int | None:
    value = raw.get(key, _MISSING)
    if value is _MISSING:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or value < 0
        or int(value) != value
        or int(value) > maximum
    ):
        _local_invalid()
    return int(value)


def _raw_address_equals(value: object, expected: str) -> bool:
    return _provider_address_matches(value, expected)


def _validate_local_route(quote: object) -> _LocalCapability:
    if not isinstance(quote, Mapping):
        _local_invalid()
    quote_mapping = cast(Mapping[str, object], quote)
    route = _route_for_quote(quote_mapping)
    if route.row.get("providerId") != "mayan-swift-v2" or route.row.get("status") != "active":
        _local_invalid()
    _assert_catalog_token(
        route.source_token_deployment_id,
        route.source_chain_id,
        route.source_token_address,
        cast(str, route.row["sourceTokenStandard"]),
    )
    _assert_catalog_token(
        route.destination_token_deployment_id,
        route.destination_chain_id,
        route.destination_token_address,
        cast(str, route.row["destinationTokenStandard"]),
    )
    _assert_catalog_token(
        route.source_usdc_deployment_id,
        route.source_chain_id,
        route.source_usdc_address,
        cast(str, route.row["sourceUsdcStandard"]),
    )
    try:
        normalized = _validate_normalized_quote_shape(
            quote_mapping, BridgeErrorCode.LOCAL_PLAN_INVALID
        )
    except BridgeError:
        _local_invalid()
    if not _strict_equal(dict(quote_mapping), dict(normalized)):
        _local_invalid()
    return route


def _extract_raw_number_lexeme(text: str, root: _JsonNode, key: str) -> str:
    return _raw_number_lexeme(root, key)


@dataclass(frozen=True, slots=True)
class _ExactDecimal:
    source: str
    integer: int
    scale: int


def _parse_plain_decimal(value: str) -> _ExactDecimal:
    if PLAIN_DECIMAL_RE.fullmatch(value) is None:
        _local_invalid()
    separator = value.find(".")
    integer_part = value if separator < 0 else value[:separator]
    fractional_part = "" if separator < 0 else value[separator + 1 :]
    integer = int(integer_part, 10)
    kept_fraction = fractional_part[:6].ljust(6, "0")
    result = integer * 1_000_000 + int(kept_fraction or "0", 10)
    if result <= 0 or result > UINT64_MAX:
        _local_invalid()
    return _ExactDecimal(value, result, len(fractional_part))


def _binary64_rounded_decimal_units(value: str) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        _local_invalid()
    if not math.isfinite(number) or number <= 0:
        _local_invalid()
    encoded = int.from_bytes(struct.pack(">d", number), "big")
    exponent = (encoded >> 52) & 0x7FF
    fraction = encoded & ((1 << 52) - 1)
    mantissa = fraction if exponent == 0 else (1 << 52) | fraction
    binary_exponent = -1074 if exponent == 0 else exponent - 1023 - 52
    numerator = mantissa * 10_000_000
    denominator = 1
    if binary_exponent >= 0:
        numerator <<= binary_exponent
    else:
        denominator <<= -binary_exponent
    rounded, remainder = divmod(numerator, denominator)
    if remainder * 2 >= denominator:
        rounded += 1
    result = rounded // 10
    if result <= 0 or result > UINT64_MAX:
        _local_invalid()
    return result


def _exact_intermediate_amount(raw: str, direct: bool, amount_in: str) -> str:
    decimal = _parse_plain_decimal(raw)
    exact = decimal.integer
    if direct:
        if exact != _uint64(amount_in, positive=True):
            _local_invalid()
        return str(exact)
    if _binary64_rounded_decimal_units(raw) != exact:
        _local_invalid()
    return str(exact)


def _validate_destination_minimum_compatibility(
    root: _JsonNode, canonical_value: str
) -> None:
    """Bind the raw provider decimal to the canonical destination minimum.

    The provider's decimal lexeme is part of the signed quote.  Rebuilding a
    decimal from the already-normalized base-unit string would only validate
    our own DTO, so both the exact six-decimal floor and the pinned binary64
    compatibility conversion are checked against the raw lexeme here.
    """

    units = _uint64(canonical_value, positive=True)
    raw_lexeme = _raw_number_lexeme(root, "minAmountOut")
    exact = _parse_plain_decimal(raw_lexeme).integer
    if exact != units or _binary64_rounded_decimal_units(raw_lexeme) != units:
        _local_invalid()


# Field arithmetic below is only the bounded Edwards decompression predicate
# required for Solana PDA/ATA derivation.  It does not implement signing or
# signature verification.
_ED25519_P = (1 << 255) - 19
_ED25519_D = (-121665 * pow(121666, _ED25519_P - 2, _ED25519_P)) % _ED25519_P
_ED25519_SQRT_M1 = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)


def _is_on_curve_zip215(value: bytes) -> bool:
    if len(value) != 32:
        return False
    encoded = int.from_bytes(value, "little")
    sign = encoded >> 255
    y = (encoded & ((1 << 255) - 1)) % _ED25519_P
    y_squared = (y * y) % _ED25519_P
    numerator = (y_squared - 1) % _ED25519_P
    denominator = (_ED25519_D * y_squared + 1) % _ED25519_P
    if denominator == 0:
        return False
    x_squared = numerator * pow(denominator, _ED25519_P - 2, _ED25519_P) % _ED25519_P
    x = pow(x_squared, (_ED25519_P + 3) // 8, _ED25519_P)
    if (x * x - x_squared) % _ED25519_P != 0:
        x = x * _ED25519_SQRT_M1 % _ED25519_P
    if (x * x - x_squared) % _ED25519_P != 0:
        return False
    if x != 0 and (x & 1) != sign:
        x = _ED25519_P - x
    # ZIP215 accepts the x=0/sign=1 encoding.  No subgroup or small-order
    # rejection is applied, matching native Solana public-key semantics.
    return True


def _find_program_address(seeds: Sequence[bytes], program_id: str) -> tuple[str, int]:
    if len(seeds) > 16 or any(len(seed) > 32 for seed in seeds):
        _local_invalid()
    program = _base58_decode_local(program_id)
    if len(program) != 32:
        _local_invalid()
    suffix = b"ProgramDerivedAddress"
    import hashlib

    for bump in range(255, -1, -1):
        candidate = hashlib.sha256(_concat(*seeds, bytes([bump]), program, suffix)).digest()
        if not _is_on_curve_zip215(candidate):
            return _base58_encode_local(candidate), bump
    _local_invalid()


def _associated_token_address(owner: str, mint: str, allow_owner_off_curve: bool) -> str:
    owner_bytes = _base58_decode_local(owner)
    mint_bytes = _base58_decode_local(mint)
    if len(owner_bytes) != 32 or len(mint_bytes) != 32:
        _local_invalid()
    if not allow_owner_off_curve and not _is_on_curve_zip215(owner_bytes):
        _local_invalid()
    return _find_program_address(
        (owner_bytes, _base58_decode_local(SOLANA_TOKEN_PROGRAM), mint_bytes),
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
    )[0]


def _validate_raw_token(
    value: object,
    route: _LocalCapability,
    *,
    source: bool,
) -> None:
    if not isinstance(value, Mapping):
        _local_invalid()
    token = cast(Mapping[str, object], value)
    if source:
        address = route.source_token_address
        standard = _provider_standard(route.source_chain_id)
        chain_id = route.source_provider_chain_id
        wormhole_chain_id = route.source_wormhole_chain_id
        name = "USD Coin" if route.is_usdc else "EuroC"
        mint = (
            MAYAN_USDC_MINT
            if route.is_usdc and route.source_chain_id == ETHEREUM_CHAIN_ID
            else ("" if route.source_chain_id == ETHEREUM_CHAIN_ID else address)
        )
    else:
        address = route.destination_token_address
        standard = _provider_standard(route.destination_chain_id)
        chain_id = route.destination_provider_chain_id
        wormhole_chain_id = route.destination_wormhole_chain_id
        name = "USD Coin" if route.is_usdc else "EuroC"
        mint = (
            MAYAN_USDC_MINT
            if route.is_usdc and route.destination_chain_id == ETHEREUM_CHAIN_ID
            else ("" if route.destination_chain_id == ETHEREUM_CHAIN_ID else address)
        )
    if (
        not _raw_address_equals(token.get("contract"), address)
        or token.get("mint") != mint
        or not _raw_address_equals(token.get("realOriginContractAddress"), address)
        or token.get("name") != name
        or token.get("standard") != standard
        or not _raw_integer_is(token.get("chainId"), chain_id)
        or not _raw_integer_is(token.get("wChainId"), wormhole_chain_id)
        or not _raw_integer_is(token.get("realOriginChainId"), wormhole_chain_id)
        or not _raw_integer_is(token.get("decimals"), 6)
    ):
        _local_invalid()


def _parse_source_quote(quote: Mapping[str, object], route: _LocalCapability) -> _ParsedSourceQuote:
    root, raw = _local_json_object(cast(str, quote.get("rawSignedQuoteJson")))
    minimum_lexeme = _extract_raw_number_lexeme(
        cast(str, quote["rawSignedQuoteJson"]), root, "minMiddleAmount"
    )
    from_token_value = _node_value(root, "fromToken")
    to_token_value = _node_value(root, "toToken")
    if not isinstance(from_token_value, Mapping) or not isinstance(to_token_value, Mapping):
        _local_invalid()
    from_token = cast(Mapping[str, object], from_token_value)
    to_token = cast(Mapping[str, object], to_token_value)
    source_standard = _provider_standard(route.source_chain_id)
    signature = raw.get("signature")
    quote_signature = quote.get("providerSignature")
    source_swap_value = quote.get("sourceSwap")
    if not isinstance(source_swap_value, Mapping):
        _local_invalid()
    source_swap = cast(Mapping[str, object], source_swap_value)
    provider_minimum = source_swap.get("providerMinimumAmount")
    if (
        not isinstance(signature, str)
        or EVM_SIGNATURE_RE.fullmatch(signature) is None
        or not isinstance(quote_signature, str)
        or signature.lower() != quote_signature.lower()
        or not _raw_integer_is(raw.get("slippageBps"), cast(int, quote.get("slippageBps")))
        or provider_minimum != minimum_lexeme
    ):
        _local_invalid()
    _validate_raw_token(from_token, route, source=True)
    _validate_raw_token(to_token, route, source=False)
    if (
        raw.get("type") != "SWIFT"
        or raw.get("swiftVersion") != "V2"
        or raw.get("gasless") is not False
        or raw.get("onlyBridging") is not False
        or raw.get("swiftWrapAndLock", _MISSING) not in (_MISSING, False)
        or raw.get("fromChain") != route.source_name
        or raw.get("toChain") != route.destination_name
        or raw.get("effectiveAmountIn64") != quote.get("amountIn")
        or raw.get("expectedAmountOutBaseUnits") != quote.get("expectedAmountOut")
        or raw.get("minAmountOutBaseUnits") != quote.get("minimumAmountOut")
        or raw.get("minReceivedBaseUnits") != quote.get("minimumReceived")
        or raw.get("deadline64") != quote.get("deadline")
        or not isinstance(raw.get("quoteId"), str)
        or cast(str, raw.get("quoteId")).lower() != cast(str, quote.get("quoteId")).lower()
        or not _raw_integer_is(raw.get("swiftInputDecimals"), 6)
        or not _raw_address_equals(raw.get("swiftInputContract"), route.source_usdc_address)
        or raw.get("swiftInputContractStandard") != source_standard
        or not _raw_address_equals(raw.get("swiftMayanContract"), route.swift_contract)
        or not _raw_integer_is(raw.get("referrerBps"), 0)
        or not _raw_integer_is(raw.get("protocolBps"), 0)
        or not _raw_number_zero(raw.get("gasDrop"))
    ):
        _local_invalid()
    _validate_destination_minimum_compatibility(
        root, cast(str, quote["minimumAmountOut"])
    )
    mode_value = raw.get("swiftAuctionMode")
    if mode_value == 2:
        mode: Literal[2, 3] = 2
    elif mode_value == 3:
        mode = 3
    else:
        _local_invalid()
    expected_mode = 3 if route.is_usdc else 2
    if mode != expected_mode:
        _local_invalid()
    raw_router = raw.get("evmSwapRouterAddress", _MISSING)
    if route.is_usdc or route.source_chain_id == SOLANA_CHAIN_ID:
        if raw_router is not _MISSING and raw_router is not None:
            _local_invalid()
    else:
        expected_router = source_swap.get("routerAddress")
        if (
            not isinstance(raw_router, str)
            or EVM_ADDRESS_RE.fullmatch(raw_router) is None
            or not isinstance(expected_router, str)
            or raw_router.lower() != expected_router.lower()
            or source_swap.get("routerKind") != "provider-selected-evm"
        ):
            _local_invalid()
    raw_calldata = raw.get("evmSwapRouterCalldata", _MISSING)
    if raw_calldata is not _MISSING and raw_calldata is not None:
        if (
            not isinstance(raw_calldata, str)
            or HEX_BYTES_RE.fullmatch(raw_calldata) is None
            or raw_calldata == "0x"
            or len(_hex_to_bytes(raw_calldata)) > MAX_ROUTER_CALLDATA_BYTES
        ):
            _local_invalid()
    if mode == 3 and (
        raw.get("expectedAmountOutBaseUnits") != raw.get("minAmountOutBaseUnits")
        or raw.get("minAmountOutBaseUnits") != raw.get("minReceivedBaseUnits")
    ):
        _local_invalid()
    forbidden = (
        "customPayload",
        "memoHex",
        "referrer",
        "referrerAddress",
        "swiftRefundAddress",
        "permit",
        "approval",
        "approvalBatch",
        "separateSwapTx",
        "jito",
        "extraInstructions",
    )
    for key in forbidden:
        value = raw.get(key, _MISSING)
        if value is not _MISSING and value not in (None, False, ""):
            _local_invalid()
    minimum_intermediate_amount = _exact_intermediate_amount(
        minimum_lexeme, route.is_usdc, cast(str, quote["amountIn"])
    )
    if not route.is_usdc:
        try:
            numeric = float(minimum_lexeme)
        except (ValueError, OverflowError):
            _local_invalid()
        if not math.isfinite(numeric) or numeric <= 0:
            _local_invalid()
    return _ParsedSourceQuote(
        raw=raw,
        root=root,
        minimum_intermediate_amount=minimum_intermediate_amount,
        mode=mode,
        cancel_fee=_raw_uint64(raw, "cancelRelayerFee64"),
        refund_fee=_raw_uint64(raw, "refundRelayerFee64"),
        submit_fee=_raw_uint64(raw, "submitRelayerFee64"),
        suggested_priority_fee=_raw_optional_bounded_integer(
            raw, "suggestedPriorityFee", 100_000
        ),
    )


def _base64_decode_local(value: object, maximum_bytes: int = MAX_SOLANA_SWAP_DATA_BYTES) -> bytes:
    if not isinstance(value, str):
        _local_invalid()
    if len(value) > math.ceil(maximum_bytes * 4 / 3) + 4:
        _local_invalid()
    if re.fullmatch(
        r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?",
        value,
    ) is None:
        _local_invalid()
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        _local_invalid()
    if len(decoded) > maximum_bytes or base64.b64encode(decoded).decode("ascii") != value:
        _local_invalid()
    return decoded


def _instruction_from_raw(value: object) -> MayanSwiftV2LocalSourceSwapInstruction:
    if not isinstance(value, Mapping):
        _local_invalid()
    source = cast(Mapping[str, object], value)
    if set(source) != {"accounts", "data", "programId"}:
        _local_invalid()
    program_id = _canonical_solana_address(source.get("programId"))
    raw_accounts = source.get("accounts")
    if not isinstance(raw_accounts, list) or len(raw_accounts) > MAX_SOLANA_SWAP_ACCOUNTS:
        _local_invalid()
    accounts: list[MayanSwiftV2LocalSourceSwapInstructionAccount] = []
    for raw_account in raw_accounts:
        if not isinstance(raw_account, Mapping):
            _local_invalid()
        account = cast(Mapping[str, object], raw_account)
        if set(account) != {"isSigner", "isWritable", "pubkey"}:
            _local_invalid()
        if not isinstance(account.get("isSigner"), bool) or not isinstance(
            account.get("isWritable"), bool
        ):
            _local_invalid()
        accounts.append(
            {
                "pubkey": _canonical_solana_address(account.get("pubkey")),
                "isSigner": cast(bool, account["isSigner"]),
                "isWritable": cast(bool, account["isWritable"]),
            }
        )
    data = source.get("data")
    _base64_decode_local(data)
    return {"programId": program_id, "accounts": accounts, "dataBase64": cast(str, data)}


def _encode_instruction_data(value: str) -> bytes:
    return _base64_decode_local(value)


def _account_at(
    instruction: MayanSwiftV2LocalSourceSwapInstruction, index: int
) -> MayanSwiftV2LocalSourceSwapInstructionAccount:
    try:
        return instruction["accounts"][index]
    except (IndexError, KeyError):
        _local_invalid()


def _assert_account(
    account: MayanSwiftV2LocalSourceSwapInstructionAccount,
    pubkey: str,
    signer: bool,
    writable: bool,
) -> None:
    if (
        account.get("pubkey") != pubkey
        or account.get("isSigner") is not signer
        or account.get("isWritable") is not writable
    ):
        _local_invalid()


def _validate_compute_instructions(
    instructions: Sequence[MayanSwiftV2LocalSourceSwapInstruction],
) -> None:
    if len(instructions) > 2:
        _local_invalid()
    tags: set[int] = set()
    for instruction in instructions:
        if instruction["programId"] != SOLANA_COMPUTE_BUDGET_PROGRAM or instruction["accounts"]:
            _local_invalid()
        data = _encode_instruction_data(instruction["dataBase64"])
        if not data:
            _local_invalid()
        tag = data[0]
        if tag not in (2, 3) or tag in tags:
            _local_invalid()
        tags.add(tag)
        if tag == 2:
            if len(data) != 5 or int.from_bytes(data[1:], "little") > 1_400_000:
                _local_invalid()
        elif len(data) != 9 or int.from_bytes(data[1:], "little") > 100_000:
            _local_invalid()


def _validate_ata_setup(
    instructions: Sequence[MayanSwiftV2LocalSourceSwapInstruction],
    swapper_address: str,
    state_address: str,
    source_usdc_address: str,
) -> None:
    if not instructions or len(instructions) > 2:
        _local_invalid()
    owners: set[str] = set()
    for instruction in instructions:
        if (
            instruction["programId"] != SOLANA_ASSOCIATED_TOKEN_PROGRAM
            or len(instruction["accounts"]) != 6
        ):
            _local_invalid()
        _assert_account(_account_at(instruction, 0), swapper_address, True, True)
        owner = _account_at(instruction, 2)["pubkey"]
        if owner not in {swapper_address, state_address} or owner in owners:
            _local_invalid()
        owners.add(owner)
        _assert_account(_account_at(instruction, 2), owner, False, False)
        expected_ata = _associated_token_address(
            owner, source_usdc_address, owner == state_address
        )
        _assert_account(_account_at(instruction, 1), expected_ata, False, True)
        _assert_account(_account_at(instruction, 3), source_usdc_address, False, False)
        _assert_account(_account_at(instruction, 4), SOLANA_SYSTEM_PROGRAM, False, False)
        _assert_account(_account_at(instruction, 5), SOLANA_TOKEN_PROGRAM, False, False)
        data = _encode_instruction_data(instruction["dataBase64"])
        if data not in (b"", b"\x01"):
            _local_invalid()
    if state_address not in owners:
        _local_invalid()


def _validate_jupiter_instruction(
    instruction: MayanSwiftV2LocalSourceSwapInstruction,
    route: _LocalCapability,
    quote: Mapping[str, object],
    state_token_account: str,
    swapper_address: str,
    minimum_intermediate_amount: str,
    source_swap_raw: Mapping[str, object],
) -> None:
    if (
        instruction["programId"] != SOLANA_JUPITER_V6
        or not 8 <= len(instruction["accounts"]) <= MAX_SOLANA_SWAP_ACCOUNTS
    ):
        _local_invalid()
    data = _encode_instruction_data(instruction["dataBase64"])
    if data[:8].hex() != SOLANA_ROUTE_V2_DISCRIMINATOR:
        _local_invalid()
    quote_response_value = source_swap_raw.get("quoteResponse")
    if not isinstance(quote_response_value, Mapping):
        _local_invalid()
    quote_response = cast(Mapping[str, object], quote_response_value)
    quote_response_raw_value = quote_response.get("raw")
    if not isinstance(quote_response_raw_value, Mapping):
        _local_invalid()
    quote_response_raw = cast(Mapping[str, object], quote_response_raw_value)
    route_plan = quote_response_raw.get("routePlan")
    if not isinstance(route_plan, list) or len(route_plan) != 1:
        _local_invalid()
    route_entry = route_plan[0]
    if not isinstance(route_entry, Mapping):
        _local_invalid()
    swap_info_value = cast(Mapping[str, object], route_entry).get("swapInfo")
    if not isinstance(swap_info_value, Mapping):
        _local_invalid()
    swap_info = cast(Mapping[str, object], swap_info_value)
    if (
        not _raw_address_equals(quote_response.get("inputMint"), route.source_token_address)
        or not _raw_address_equals(quote_response.get("outputMint"), route.source_usdc_address)
        or not _raw_address_equals(quote_response_raw.get("inputMint"), route.source_token_address)
        or not _raw_address_equals(quote_response_raw.get("outputMint"), route.source_usdc_address)
        or not _raw_address_equals(swap_info.get("inputMint"), route.source_token_address)
        or not _raw_address_equals(swap_info.get("outputMint"), route.source_usdc_address)
        or not isinstance(swap_info.get("inAmount"), str)
        or not isinstance(swap_info.get("outAmount"), str)
        or _uint64(swap_info["inAmount"], positive=True)
        != _uint64(cast(str, quote["amountIn"]), positive=True)
        or _uint64(swap_info["outAmount"], positive=True)
        < _uint64(minimum_intermediate_amount, positive=True)
    ):
        _local_invalid()
    label = swap_info.get("label")
    if label == "Whirlpool":
        expected_tail = SOLANA_ROUTE_V2_WHIRLPOOL_TAIL
        expected_account_count = 22
        expected_pool = SOLANA_WHIRLPOOL_POOL
    elif label == "Raydium CLMM":
        expected_tail = SOLANA_ROUTE_V2_RAYDIUM_TAIL
        expected_account_count = 25
        expected_pool = SOLANA_RAYDIUM_CLMM_POOL
    else:
        _local_invalid()
    if len(data) != 28 + len(expected_tail) // 2 or data[28:].hex() != expected_tail:
        _local_invalid()
    if len(instruction["accounts"]) != expected_account_count:
        _local_invalid()
    if swap_info.get("ammKey") != expected_pool:
        _local_invalid()
    input_amount = int.from_bytes(data[8:16], "little")
    quoted_output = int.from_bytes(data[16:24], "little")
    slippage_bps = int.from_bytes(data[24:26], "little")
    platform_bps = int.from_bytes(data[26:28], "little")
    if (
        input_amount != _uint64(cast(str, quote["amountIn"]), positive=True)
        or quoted_output < _uint64(minimum_intermediate_amount, positive=True)
        or platform_bps != 0
        or slippage_bps > 10_000
    ):
        _local_invalid()
    trader_eurc = _associated_token_address(
        swapper_address, route.source_token_address, False
    )
    trader_usdc = _associated_token_address(
        swapper_address, route.source_usdc_address, False
    )
    expected_accounts: Sequence[tuple[str, bool, bool]]
    if label == "Whirlpool":
        expected_accounts = (
            (swapper_address, True, False),
            (trader_eurc, False, True),
            (trader_usdc, False, True),
            (route.source_token_address, False, False),
            (route.source_usdc_address, False, False),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (state_token_account, False, True),
            (SOLANA_ANCHOR_EVENT_AUTHORITY, False, False),
            (SOLANA_JUPITER_V6, False, False),
            (SOLANA_WHIRLPOOL_PROGRAM, False, False),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (swapper_address, False, False),
            (SOLANA_WHIRLPOOL_POOL, False, True),
            (trader_usdc, False, True),
            (SOLANA_WHIRLPOOL_TICK_ARRAY_0, False, True),
            (trader_eurc, False, True),
            (SOLANA_WHIRLPOOL_TICK_ARRAY_1, False, True),
            (SOLANA_WHIRLPOOL_TICK_ARRAY_2, False, True),
            (SOLANA_WHIRLPOOL_ORACLE, False, True),
            (SOLANA_WHIRLPOOL_REWARD_VAULT, False, True),
            (SOLANA_WHIRLPOOL_REMAINING, False, False),
        )
    else:
        expected_accounts = (
            (swapper_address, True, False),
            (trader_eurc, False, True),
            (trader_usdc, False, True),
            (route.source_token_address, False, False),
            (route.source_usdc_address, False, False),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (state_token_account, False, True),
            (SOLANA_ANCHOR_EVENT_AUTHORITY, False, False),
            (SOLANA_JUPITER_V6, False, False),
            (SOLANA_RAYDIUM_CLMM_PROGRAM, False, False),
            (swapper_address, False, False),
            (SOLANA_RAYDIUM_CONFIG, False, False),
            (SOLANA_RAYDIUM_CLMM_POOL, False, True),
            (trader_eurc, False, True),
            (trader_usdc, False, True),
            (SOLANA_RAYDIUM_OBSERVATION, False, True),
            (SOLANA_RAYDIUM_TICK_ARRAY_0, False, True),
            (SOLANA_RAYDIUM_TICK_ARRAY_1, False, True),
            (SOLANA_TOKEN_PROGRAM, False, False),
            (SOLANA_RAYDIUM_TICK_ARRAY_2, False, True),
            (SOLANA_RAYDIUM_TICK_ARRAY_3, False, True),
            (SOLANA_RAYDIUM_ORACLE, False, True),
            (SOLANA_RAYDIUM_REMAINING, False, True),
            (SOLANA_RAYDIUM_JUPITER_REMAINING, False, False),
        )
    if len(expected_accounts) != len(instruction["accounts"]):
        _local_invalid()
    for index, (pubkey, signer, writable) in enumerate(expected_accounts):
        _assert_account(_account_at(instruction, index), pubkey, signer, writable)


def _validate_source_swap_envelope(
    quote: Mapping[str, object],
    route: _LocalCapability,
    raw: Mapping[str, object],
    state_address: str,
    state_token_account: str,
    swapper_address: str,
    minimum_intermediate_amount: str,
) -> MayanSwiftV2LocalSourceSwapPlan:
    if route.is_usdc:
        _local_invalid()
    if route.source_chain_id == ETHEREUM_CHAIN_ID:
        if set(raw) != {"swapRouterAddress", "swapRouterCalldata"}:
            _local_invalid()
        router_address = _normalize_evm_address(raw.get("swapRouterAddress"))
        source_swap = quote.get("sourceSwap")
        if not isinstance(source_swap, Mapping):
            _local_invalid()
        if (
            source_swap.get("routerAddress") != router_address
            or source_swap.get("routerKind") != "provider-selected-evm"
        ):
            _local_invalid()
        calldata = raw.get("swapRouterCalldata")
        if not isinstance(calldata, str) or HEX_BYTES_RE.fullmatch(calldata) is None:
            _local_invalid()
        if (
            calldata == "0x"
            or not calldata.lower().startswith(EVM_SOURCE_SWAP_SELECTOR)
            or len(_hex_to_bytes(calldata)) > MAX_ROUTER_CALLDATA_BYTES
        ):
            _local_invalid()
        return {
            "kind": "evm-router",
            "routerAddress": router_address,
            "calldata": calldata.lower(),
            "rawResponseSha256": "",
            "rawProviderSourceSwapJson": "",
        }
    token_ledger = raw.get("tokenLedgerInstruction", _MISSING)
    if token_ledger is not _MISSING and token_ledger is not None:
        _local_invalid()
    compute_value = raw.get("computeBudgetInstructions")
    setup_value = raw.get("setupInstructions")
    swap_value = raw.get("swapInstruction", _MISSING)
    if not isinstance(compute_value, list) or not isinstance(setup_value, list):
        _local_invalid()
    if swap_value is _MISSING or swap_value is None:
        _local_invalid()
    cleanup = raw.get("cleanupInstruction", _MISSING)
    if cleanup is not _MISSING and cleanup is not None:
        _local_invalid()
    other = raw.get("otherInstructions")
    if not isinstance(other, list) or other:
        _local_invalid()
    simulation_error = raw.get("simulationError", _MISSING)
    if simulation_error is not _MISSING and simulation_error is not None:
        _local_invalid()
    separate_swap = raw.get("separateSwapTx", _MISSING)
    if separate_swap is not _MISSING and separate_swap is not False:
        _local_invalid()
    jito = raw.get("jito", _MISSING)
    if jito is not _MISSING and jito not in (False, None):
        _local_invalid()
    compute = [_instruction_from_raw(item) for item in compute_value]
    setup = [_instruction_from_raw(item) for item in setup_value]
    swap = _instruction_from_raw(swap_value)
    _validate_compute_instructions(compute)
    _validate_ata_setup(
        setup,
        swapper_address,
        state_address,
        route.source_usdc_address,
    )
    _validate_jupiter_instruction(
        swap,
        route,
        quote,
        state_token_account,
        swapper_address,
        minimum_intermediate_amount,
        raw,
    )
    signer_keys = {
        account["pubkey"]
        for instruction in (*compute, *setup, swap)
        for account in instruction["accounts"]
        if account["isSigner"]
    }
    if signer_keys != {swapper_address}:
        _local_invalid()
    provider_alts = raw.get("addressLookupTableAddresses")
    if not isinstance(provider_alts, list) or len(provider_alts) > MAX_LOOKUP_TABLES:
        _local_invalid()
    if any(
        not isinstance(address, str)
        or _canonical_solana_address(address) != address
        for address in provider_alts
    ):
        _local_invalid()
    priority_fee = raw.get("prioritizationFeeLamports", _MISSING)
    if priority_fee is not _MISSING and (
        isinstance(priority_fee, bool)
        or not isinstance(priority_fee, int)
        or priority_fee < 0
    ):
        _local_invalid()
    compute_limit = raw.get("computeUnitLimit", _MISSING)
    if compute_limit is not _MISSING and (
        isinstance(compute_limit, bool)
        or not isinstance(compute_limit, int)
        or compute_limit > 1_400_000
    ):
        _local_invalid()
    return {
        "kind": "solana-jupiter-v6",
        "instructions": [*compute, *setup, swap],
        "addressLookupTableAddresses": [cast(str, address) for address in provider_alts],
        "rawResponseSha256": "",
        "rawProviderSourceSwapJson": "",
    }


def _swift_random(quote_id: str, order_nonce: str) -> bytes:
    return _concat(_hex_to_bytes(quote_id), _hex_to_bytes(order_nonce))


def _write_uint16_be(value: int) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 0xFFFF:
        _local_invalid()
    return value.to_bytes(2, "big")


def _write_uint16_le(value: int) -> bytes:
    return _write_uint16_be(value)[::-1]


def _write_uint64_be(value: int) -> bytes:
    if value < 0 or value > UINT64_MAX:
        _local_invalid()
    return value.to_bytes(8, "big")


def _write_uint64_le(value: int) -> bytes:
    return _write_uint64_be(value)[::-1]


def _zero32() -> bytes:
    return b"\0" * 32


def _order_preimage(
    quote: Mapping[str, object],
    route: _LocalCapability,
    swapper_address: str,
    destination_address: str,
    order_nonce: str,
    cancel_fee: int,
    refund_fee: int,
    mode: int,
) -> bytes:
    parts = (
        b"\x01",
        _native_address_bytes(swapper_address, route.source_chain_id),
        _write_uint16_be(route.source_wormhole_chain_id),
        _native_address_bytes(route.source_usdc_address, route.source_chain_id),
        _native_address_bytes(destination_address, route.destination_chain_id),
        _write_uint16_be(route.destination_wormhole_chain_id),
        _native_address_bytes(route.destination_token_address, route.destination_chain_id),
        _write_uint64_be(_uint64(quote["minimumAmountOut"], positive=True)),
        _write_uint64_be(0),
        _write_uint64_be(cancel_fee),
        _write_uint64_be(refund_fee),
        _write_uint64_be(_uint64(quote["deadline"], positive=True)),
        _zero32(),
        bytes((0, 0, mode)),
        _swift_random(cast(str, quote["quoteId"]), order_nonce),
        _zero32(),
    )
    result = _concat(*parts)
    if len(result) != 272:
        _local_invalid()
    return result


def _hash_order(
    quote: Mapping[str, object],
    route: _LocalCapability,
    swapper_address: str,
    destination_address: str,
    order_nonce: str,
    cancel_fee: int,
    refund_fee: int,
    mode: int,
) -> str:
    return "0x" + _keccak_hex(
        _order_preimage(
            quote,
            route,
            swapper_address,
            destination_address,
            order_nonce,
            cancel_fee,
            refund_fee,
            mode,
        )
    )


def _quote_binding_hash(
    route: _LocalCapability,
    quote: Mapping[str, object],
    raw_quote_sha256: str,
    order_nonce: str,
    swapper_address: str,
    destination_address: str,
) -> str:
    value = {
        "capabilityId": route.capability_id,
        "destinationAddress": destination_address,
        "destinationChainId": route.destination_chain_id,
        "destinationTokenDeploymentId": route.destination_token_deployment_id,
        "orderNonce": order_nonce,
        "quoteId": quote["quoteId"],
        "rawQuoteSha256": raw_quote_sha256,
        "sourceChainId": route.source_chain_id,
        "sourceTokenDeploymentId": route.source_token_deployment_id,
        "swapperAddress": swapper_address,
    }
    return _sha256_hex(_stable_json(value))


def _source_swap_hash_projection(source_swap: Mapping[str, object]) -> Mapping[str, object]:
    if source_swap.get("kind") == "none":
        return source_swap
    return {
        key: value
        for key, value in source_swap.items()
        if key != "rawProviderSourceSwapJson"
    }


def _plan_hash(binding: str, source_swap: Mapping[str, object]) -> str:
    return _sha256_hex(
        _stable_json(
            {
                "quoteBindingHash": binding,
                "sourceSwap": _source_swap_hash_projection(source_swap),
            }
        )
    )


def _config_value(config: Mapping[str, object] | None, *names: str) -> object:
    if config is None:
        return _MISSING
    for name in names:
        if name in config:
            return config[name]
    return _MISSING


def _source_endpoint(config: Mapping[str, object] | None) -> str:
    value = _config_value(config, "source_swap_endpoint", "sourceSwapEndpoint")
    source = SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT if value is _MISSING else value
    if not isinstance(source, str) or not source or source.strip() != source:
        _local_invalid()
    try:
        parsed = urlsplit(source)
        port = parsed.port
    except ValueError:
        _local_invalid()
    hostname = parsed.hostname
    scheme = parsed.scheme.lower()
    if (
        not parsed.scheme
        or not parsed.netloc
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (
            scheme != "https"
            and not (
                scheme == "http"
                and hostname.lower() in {"localhost", "127.0.0.1", "::1"}
            )
        )
        or (port is not None and not 0 <= port <= 65535)
    ):
        _local_invalid()
    return urlunsplit((scheme, parsed.netloc, parsed.path.rstrip("/") or "/", "", ""))


def _js_string(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if not math.isfinite(value):
            _local_invalid()
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def _source_swap_url(
    endpoint: str,
    chain: Literal["evm", "solana"],
    params: Sequence[tuple[str, object]],
) -> str:
    parsed = urlsplit(endpoint)
    path = f"{parsed.path.rstrip('/')}/get-swap/{chain}".replace("//", "/")
    query = urlencode([(key, _js_string(value)) for key, value in params])
    return urlunsplit((parsed.scheme, parsed.netloc, path, query, ""))


async def _read_local_response_body(response: httpx.Response) -> str:
    chunks = bytearray()
    read_failed = False
    try:
        async for chunk in response.aiter_bytes():
            if len(chunks) + len(chunk) > MAX_RESPONSE_BYTES:
                raise _SourceResponseInvalidError
            chunks.extend(chunk)
    except _SourceResponseInvalidError:
        raise
    except Exception:
        read_failed = True
    if read_failed:
        _fail(BridgeErrorCode.PROVIDER_TRANSPORT)
    decode_failed = False
    try:
        return bytes(chunks).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        decode_failed = True
    if decode_failed:
        raise _SourceResponseInvalidError
    return ""


async def _fetch_source_swap(
    runtime: LocalRuntime,
    url: str,
    options: RequestOptions,
) -> tuple[str, _JsonNode, Mapping[str, object]]:
    try:
        request = httpx.Request("GET", url, headers={"accept": "application/json"})
    except (TypeError, UnicodeError, ValueError, httpx.InvalidURL):
        _local_invalid()
    async def request_and_read() -> str:
        response: httpx.Response | None = None
        try:
            response = await runtime.http_client.send(
                request,
                auth=None,
                follow_redirects=False,
                stream=True,
            )
            if not 200 <= response.status_code < 300:
                _fail(BridgeErrorCode.PROVIDER_HTTP)
            return await _read_local_response_body(response)
        finally:
            if response is not None:
                with suppress(Exception):
                    await response.aclose()

    result: tuple[str, _JsonNode, Mapping[str, object]] | None = None
    failure_code: BridgeErrorCode | None = None
    failure_status: int | None = None
    try:
        task = asyncio.create_task(request_and_read())
        text = await _await_provider(task, runtime.timeout, options)
        parse_failed = False
        try:
            root = _parse_provider_response(text)
        except BridgeError:
            parse_failed = True
        if parse_failed:
            _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
        if root.object_entries is None or not isinstance(root.value, Mapping):
            _fail(BridgeErrorCode.PROVIDER_INVALID_RESPONSE)
        raw = cast(Mapping[str, object], root.value)
        result = (text, root, raw)
    except BridgeError as error:
        failure_code = error.code
        failure_status = error.status
    except _SourceResponseInvalidError:
        failure_code = BridgeErrorCode.PROVIDER_INVALID_RESPONSE
    except _LocalTransportError:
        failure_code = BridgeErrorCode.PROVIDER_TRANSPORT
    except _LocalValidationError:
        failure_code = BridgeErrorCode.LOCAL_PLAN_INVALID
    except httpx.HTTPError:
        failure_code = BridgeErrorCode.PROVIDER_TRANSPORT
    except asyncio.CancelledError:
        if options.cancel_event is not None and options.cancel_event.is_set():
            failure_code = BridgeErrorCode.ABORTED
        else:
            raise
    except Exception:
        failure_code = BridgeErrorCode.PROVIDER_TRANSPORT
    if failure_code is not None:
        _fail(failure_code, failure_status)
    assert result is not None
    return result


def _context_mapping(value: object, *, build: bool) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        _local_invalid()
    result = cast(Mapping[str, object], value)
    expected = {
        "destinationAddress",
        "orderNonce",
        "quote",
        "sourceSwapPlan",
        "swapperAddress",
    }
    if not build:
        expected.remove("sourceSwapPlan")
    if set(result) != expected:
        _local_invalid()
    return result


def _normalize_local_address(value: object, chain_id: str) -> str:
    return (
        _normalize_evm_address(value)
        if chain_id == ETHEREUM_CHAIN_ID
        else _canonical_solana_address(value)
    )


def _validate_local_expiry(quote: Mapping[str, object], runtime: LocalRuntime) -> None:
    deadline = _uint64(quote["deadline"], positive=True)
    if int(time.time()) + runtime.minimum_quote_validity_seconds > deadline:
        _fail(BridgeErrorCode.QUOTE_EXPIRED)


def _revalidate_local_quote(
    value: object,
    runtime: LocalRuntime,
) -> MayanSwiftV2Quote:
    """Run the hosted quote parser locally before any local transport.

    Local construction accepts a caller-supplied hosted quote, so it must
    preserve the exact caller snapshot while reusing the existing strict
    route/raw parser.  The parser is pure and the configured client is never
    used here; only the local clock and validity margin are consulted.
    """

    if not isinstance(value, Mapping):
        _local_invalid()
    source = cast(MayanSwiftV2Quote, value)
    original = cast(MayanSwiftV2Quote, copy.deepcopy(dict(source)))
    raw_quote = original["rawSignedQuoteJson"]
    if not isinstance(raw_quote, str):
        _local_invalid()
    validation_quote = cast(MayanSwiftV2Quote, copy.deepcopy(dict(original)))
    validation_quote["rawSignedQuoteJson"] = raw_quote.rstrip(" \t\r\n")
    config = _NormalizedBridgeConfig(
        builder_endpoint=DEFAULT_BUILDER_ENDPOINT,
        explorer_endpoint=DEFAULT_EXPLORER_ENDPOINT,
        builder_api_key=None,
        allow_unauthenticated_build=True,
        minimum_quote_validity_seconds=runtime.minimum_quote_validity_seconds,
        timeout=runtime.timeout,
        http_client=runtime.http_client,
        owns_http_client=False,
        local_build=runtime.local_build,
    )
    try:
        hosted_route, normalized = _build_route_from_quote(validation_quote)
        _validate_raw_quote_for_build(normalized, hosted_route, config)
        return original
    except BridgeError as error:
        if error.code == BridgeErrorCode.QUOTE_EXPIRED:
            raise
        _local_invalid()
    except Exception:
        _local_invalid()


async def prepare_source_swap(
    context: object,
    runtime: LocalRuntime,
    options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
) -> MayanSwiftV2SourceSwapPlan:
    try:
        value = _context_mapping(context, build=False)
        quote = _revalidate_local_quote(value.get("quote"), runtime)
        route = _validate_local_route(quote)
        parsed_quote = _parse_source_quote(quote, route)
        swapper_address = _normalize_local_address(
            value.get("swapperAddress"), route.source_chain_id
        )
        destination_address = _normalize_local_address(
            value.get("destinationAddress"), route.destination_chain_id
        )
        order_nonce = value.get("orderNonce")
        if not isinstance(order_nonce, str) or NONCE_RE.fullmatch(order_nonce) is None:
            _local_invalid()
        _validate_destination_minimum_compatibility(
            parsed_quote.root, quote["minimumAmountOut"]
        )
        _validate_local_expiry(quote, runtime)
        raw_quote = quote["rawSignedQuoteJson"]
        raw_quote_sha256 = _sha256_hex(raw_quote)
        order_hash = _hash_order(
            quote,
            route,
            swapper_address,
            destination_address,
            order_nonce,
            parsed_quote.cancel_fee,
            parsed_quote.refund_fee,
            parsed_quote.mode,
        )
        binding = _quote_binding_hash(
            route,
            quote,
            raw_quote_sha256,
            order_nonce,
            swapper_address,
            destination_address,
        )
    except BridgeError:
        raise
    except _LocalValidationError:
        _fail(BridgeErrorCode.LOCAL_PLAN_INVALID)
    except Exception:
        _fail(BridgeErrorCode.LOCAL_PLAN_INVALID)

    source_swap: MayanSwiftV2LocalSourceSwapPlan
    if route.is_usdc:
        source_swap = {"kind": "none"}
    else:
        source_failure_code: BridgeErrorCode | None = None
        source_failure_status: int | None = None
        try:
            endpoint = _source_endpoint(runtime.local_build)
            raw_from_token = parsed_quote.raw.get("fromToken")
            if not isinstance(raw_from_token, Mapping):
                _local_invalid()
            if route.source_chain_id == ETHEREUM_CHAIN_ID:
                url = _source_swap_url(
                    endpoint,
                    "evm",
                    (
                        ("forwarderAddress", ETHEREUM_FORWARDER_PROVIDER),
                        ("slippageBps", quote["slippageBps"]),
                        ("fromToken", raw_from_token.get("contract")),
                        ("middleToken", route.source_usdc_address),
                        ("chainName", route.source_name),
                        ("amountIn64", quote["amountIn"]),
                        ("sdkVersion", MAYAN_ORACLE_SDK_VERSION),
                    ),
                )
            else:
                state_address = _find_program_address(
                    (b"STATE_SOURCE", _hex_to_bytes(order_hash), _write_uint16_le(2)),
                    SOLANA_SWIFT_PROGRAM,
                )[0]
                minimum_lexeme = _raw_number_lexeme(parsed_quote.root, "minMiddleAmount")
                try:
                    minimum_number = float(minimum_lexeme)
                except (ValueError, OverflowError):
                    _local_invalid()
                url = _source_swap_url(
                    endpoint,
                    "solana",
                    (
                        ("minMiddleAmount", minimum_number),
                        ("middleToken", route.source_usdc_address),
                        ("userWallet", swapper_address),
                        ("slippageBps", quote["slippageBps"]),
                        ("fromToken", route.source_token_address),
                        ("amountIn64", quote["amountIn"]),
                        ("depositMode", "SWIFT"),
                        ("fillMaxAccounts", False),
                        ("chainName", route.source_name),
                        ("userLedger", state_address),
                        ("sdkVersion", MAYAN_ORACLE_SDK_VERSION),
                    ),
                )
            text, root, raw = await _fetch_source_swap(runtime, url, options)
            if route.source_chain_id == SOLANA_CHAIN_ID:
                state_address = _find_program_address(
                    (b"STATE_SOURCE", _hex_to_bytes(order_hash), _write_uint16_le(2)),
                    SOLANA_SWIFT_PROGRAM,
                )[0]
                state_token_account = _associated_token_address(
                    state_address, route.source_usdc_address, True
                )
            else:
                state_address = ""
                state_token_account = ""
            source_swap = _validate_source_swap_envelope(
                quote,
                route,
                raw,
                state_address,
                state_token_account,
                swapper_address,
                parsed_quote.minimum_intermediate_amount,
            )
            if source_swap["kind"] == "none":
                _local_invalid()
            source_swap["rawResponseSha256"] = _sha256_hex(text)
            source_swap["rawProviderSourceSwapJson"] = text
        except BridgeError as error:
            source_failure_code = error.code
            source_failure_status = error.status
        except (_LocalValidationError, _LocalTransportError):
            source_failure_code = BridgeErrorCode.LOCAL_PLAN_INVALID
        except Exception:
            source_failure_code = BridgeErrorCode.LOCAL_PLAN_INVALID
        if source_failure_code is not None:
            _fail(source_failure_code, source_failure_status)

    plan: MayanSwiftV2SourceSwapPlan = {
        "planKind": "mayan-swift-v2-local-source-swap",
        "providerId": "mayan-swift-v2",
        "capabilityId": route.capability_id,
        "sourceChainId": route.source_chain_id,
        "destinationChainId": route.destination_chain_id,
        "sourceTokenDeploymentId": route.source_token_deployment_id,
        "destinationTokenDeploymentId": route.destination_token_deployment_id,
        "quoteId": quote["quoteId"],
        "rawQuoteSha256": raw_quote_sha256,
        "orderNonce": order_nonce,
        "swapperAddress": swapper_address,
        "destinationAddress": destination_address,
        "orderHash": order_hash,
        "quoteBindingHash": binding,
        "minimumIntermediateAmount": parsed_quote.minimum_intermediate_amount,
        "sourceSwap": source_swap,
        "planHash": _plan_hash(binding, source_swap),
    }
    return plan


@dataclass(frozen=True, slots=True)
class _LocalLookupTable:
    address: str
    addresses: list[str]
    data: bytes


@dataclass(frozen=True, slots=True)
class _SourceRpcResult:
    evidence: MayanSwiftV2LocalSourceRpcEvidence
    lookup_tables: list[_LocalLookupTable]
    recent_blockhash: str | None


def _rpc_endpoint(
    runtime: LocalRuntime,
    route: _LocalCapability,
) -> RpcEndpointConfig:
    config = runtime.local_build
    key = "ethereum_rpc" if route.source_chain_id == ETHEREUM_CHAIN_ID else "solana_rpc"
    camel = "ethereumRpc" if route.source_chain_id == ETHEREUM_CHAIN_ID else "solanaRpc"
    value = _config_value(config, key, camel)
    if value is _MISSING or value is None:
        _fail(BridgeErrorCode.LOCAL_RPC_REQUIRED)
    if isinstance(value, RpcEndpointConfig):
        return value
    if not isinstance(value, Mapping):
        _local_invalid()
    source = cast(Mapping[str, object], value)
    if any(key_value not in {"http_url", "httpUrl", "headers"} for key_value in source):
        _local_invalid()
    http_url = _config_value(source, "http_url", "httpUrl")
    if http_url is _MISSING:
        _local_invalid()
    headers = source.get("headers", {})
    if not isinstance(headers, Mapping):
        _local_invalid()
    try:
        return RpcEndpointConfig(
            http_url=cast(str, http_url),
            headers=cast(Mapping[str, str], headers),
        )
    except Exception:
        _local_invalid()


async def _read_rpc_body(response: httpx.Response) -> str:
    chunks = bytearray()
    read_failed = False
    try:
        async for chunk in response.aiter_bytes():
            if len(chunks) + len(chunk) > MAX_RESPONSE_BYTES:
                _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
            chunks.extend(chunk)
    except BridgeError:
        raise
    except Exception:
        read_failed = True
    if read_failed:
        _fail(BridgeErrorCode.SOURCE_RPC_TRANSPORT)
    decode_failed = False
    try:
        return bytes(chunks).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        decode_failed = True
    if decode_failed:
        _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
    return ""


async def _rpc_call(
    runtime: LocalRuntime,
    endpoint: RpcEndpointConfig,
    method: str,
    params: object,
    options: RequestOptions,
) -> object:
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    headers = dict(endpoint.headers)
    headers["accept"] = "application/json"
    headers["content-type"] = "application/json"
    try:
        request = httpx.Request(
            "POST",
            endpoint.http_url,
            headers=headers,
            content=body.encode("utf-8"),
        )
    except (TypeError, UnicodeError, ValueError, httpx.InvalidURL):
        _fail(BridgeErrorCode.SOURCE_RPC_TRANSPORT)
    async def request_and_read() -> str:
        response: httpx.Response | None = None
        try:
            response = await runtime.http_client.send(
                request,
                auth=None,
                follow_redirects=False,
                stream=True,
            )
            if not 200 <= response.status_code < 300:
                _fail(BridgeErrorCode.SOURCE_RPC_TRANSPORT)
            return await _read_rpc_body(response)
        finally:
            if response is not None:
                with suppress(Exception):
                    await response.aclose()

    text: str | None = None
    failure_code: BridgeErrorCode | None = None
    failure_status: int | None = None
    try:
        task = asyncio.create_task(request_and_read())
        text = await _await_provider(task, runtime.timeout, options)
    except BridgeError as error:
        failure_code = error.code
        failure_status = error.status
    except asyncio.CancelledError:
        if options.cancel_event is not None and options.cancel_event.is_set():
            failure_code = BridgeErrorCode.ABORTED
        else:
            raise
    except httpx.HTTPError:
        failure_code = BridgeErrorCode.SOURCE_RPC_TRANSPORT
    except Exception:
        failure_code = BridgeErrorCode.SOURCE_RPC_TRANSPORT
    if failure_code is not None:
        _fail(failure_code, failure_status)
    assert text is not None
    parse_failed = False
    try:
        root = _parse_provider_response(text)
    except BridgeError:
        parse_failed = True
    if parse_failed:
        _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
    if root.object_entries is None or not isinstance(root.value, Mapping):
        _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
    jsonrpc = _object_value(root, "jsonrpc")
    response_id = _object_value(root, "id")
    if jsonrpc != "2.0" or type(response_id) is not int or response_id != 1:
        _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
    if _object_entry(root, "error") is not None or _object_entry(root, "result") is None:
        _fail(BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE)
    return _object_value(root, "result")


def _parse_rpc_account(value: object) -> tuple[bytes, str]:
    if not isinstance(value, Mapping):
        _local_invalid()
    account = cast(Mapping[str, object], value)
    data = account.get("data")
    owner = account.get("owner")
    if (
        account.get("executable") is not False
        or not isinstance(data, list)
        or len(data) != 2
        or not isinstance(data[0], str)
        or data[1] != "base64"
        or not isinstance(owner, str)
    ):
        _local_invalid()
    raw = _base64_decode_local(data[0], 16_384)
    return raw, _canonical_solana_address(owner)


def _decode_lookup_table(
    address: str,
    data: bytes,
    owner: str,
    account_context_slot: int,
) -> _LocalLookupTable:
    if (
        owner != SOLANA_ADDRESS_LOOKUP_TABLE_OWNER
        or len(data) < 56
        or (len(data) - 56) % 32 != 0
        or data[0:4] != b"\x01\x00\x00\x00"
    ):
        _local_invalid()
    deactivation_slot = int.from_bytes(data[4:12], "little")
    last_extended_slot = int.from_bytes(data[12:20], "little")
    last_extended_start_index = data[20]
    authority_option = data[21]
    address_count = (len(data) - 56) // 32
    if (
        authority_option > 1
        or any(data[54:56])
        or (authority_option == 0 and any(data[22:54]))
        or address_count > MAX_LOOKUP_TABLE_ADDRESSES
    ):
        _local_invalid()
    if deactivation_slot != UINT64_MAX:
        _local_invalid()
    if last_extended_slot > account_context_slot:
        _local_invalid()
    if last_extended_start_index > address_count:
        _local_invalid()
    active_count = address_count
    if last_extended_slot == account_context_slot:
        active_count = last_extended_start_index
    if active_count > address_count:
        _local_invalid()
    addresses = [
        _base58_encode_local(data[offset : offset + 32])
        for offset in range(56, 56 + active_count * 32, 32)
    ]
    return _LocalLookupTable(address, addresses, data)


async def _fetch_source_rpc(
    route: _LocalCapability,
    plan: MayanSwiftV2SourceSwapPlan,
    runtime: LocalRuntime,
    options: RequestOptions,
) -> _SourceRpcResult:
    endpoint = _rpc_endpoint(runtime, route)
    result: _SourceRpcResult | None = None
    failure_code: BridgeErrorCode | None = None
    failure_status: int | None = None
    try:
        if route.source_chain_id == ETHEREUM_CHAIN_ID:
            chain_id = await _rpc_call(runtime, endpoint, "eth_chainId", [], options)
            if not isinstance(chain_id, str) or chain_id.lower() != "0x1":
                _local_invalid()
            addresses = [ETHEREUM_FORWARDER, route.swift_contract]
            source_swap = cast(Mapping[str, object], plan["sourceSwap"])
            if source_swap.get("kind") == "evm-router":
                addresses.append(cast(str, source_swap["routerAddress"]))
            code: list[MayanSwiftV2LocalEvmRpcCode] = []
            for address in addresses:
                bytecode = await _rpc_call(
                    runtime,
                    endpoint,
                    "eth_getCode",
                    [address, "latest"],
                    options,
                )
                if (
                    not isinstance(bytecode, str)
                    or HEX_BYTES_RE.fullmatch(bytecode) is None
                    or bytecode == "0x"
                ):
                    _local_invalid()
                code.append(
                    {
                        "address": _normalize_evm_address(address),
                        "keccak256": "0x" + _keccak_hex(_hex_to_bytes(bytecode)),
                    }
                )
            result = _SourceRpcResult(
                evidence={"kind": "evm", "rpcChainId": "0x1", "code": code},
                lookup_tables=[],
                recent_blockhash=None,
            )
        else:
            genesis_hash = await _rpc_call(runtime, endpoint, "getGenesisHash", [], options)
            if genesis_hash != SOLANA_MAINNET_GENESIS_HASH:
                _local_invalid()
            blockhash_result = await _rpc_call(
                runtime,
                endpoint,
                "getLatestBlockhash",
                [{"commitment": "confirmed"}],
                options,
            )
            if not isinstance(blockhash_result, Mapping):
                _local_invalid()
            blockhash_wrapper = cast(Mapping[str, object], blockhash_result)
            blockhash_context = blockhash_wrapper.get("context")
            blockhash_value = blockhash_wrapper.get("value")
            if not isinstance(blockhash_context, Mapping) or not isinstance(
                blockhash_value, Mapping
            ):
                _local_invalid()
            blockhash_slot = blockhash_context.get("slot")
            recent_blockhash = blockhash_value.get("blockhash")
            last_valid_block_height = blockhash_value.get("lastValidBlockHeight")
            if (
                isinstance(blockhash_slot, bool)
                or not isinstance(blockhash_slot, int)
                or blockhash_slot < 0
                or blockhash_slot > MAX_SAFE_INTEGER
                or not isinstance(recent_blockhash, str)
                or not isinstance(last_valid_block_height, int)
                or isinstance(last_valid_block_height, bool)
                or last_valid_block_height < 0
                or last_valid_block_height > MAX_SAFE_INTEGER
            ):
                _local_invalid()
            _canonical_solana_address(recent_blockhash)
            source_swap = cast(Mapping[str, object], plan["sourceSwap"])
            provider_alts = (
                cast(list[str], source_swap["addressLookupTableAddresses"])
                if source_swap.get("kind") == "solana-jupiter-v6"
                else []
            )
            alt_addresses = list(dict.fromkeys([SOLANA_MAYAN_LOOKUP_TABLE, *provider_alts]))
            if len(alt_addresses) > MAX_LOOKUP_TABLES:
                _local_invalid()
            accounts_result = await _rpc_call(
                runtime,
                endpoint,
                "getMultipleAccounts",
                [
                    alt_addresses,
                    {
                        "encoding": "base64",
                        "commitment": "confirmed",
                        "minContextSlot": blockhash_slot,
                    },
                ],
                options,
            )
            if not isinstance(accounts_result, Mapping):
                _local_invalid()
            accounts_wrapper = cast(Mapping[str, object], accounts_result)
            account_context = accounts_wrapper.get("context")
            account_values = accounts_wrapper.get("value")
            if not isinstance(account_context, Mapping) or not isinstance(account_values, list):
                _local_invalid()
            account_slot = account_context.get("slot")
            if (
                isinstance(account_slot, bool)
                or not isinstance(account_slot, int)
                or account_slot < blockhash_slot
                or account_slot > MAX_SAFE_INTEGER
                or len(account_values) != len(alt_addresses)
            ):
                _local_invalid()
            lookup_tables: list[_LocalLookupTable] = []
            for address, account_value in zip(alt_addresses, account_values, strict=True):
                data, owner = _parse_rpc_account(account_value)
                lookup_tables.append(
                    _decode_lookup_table(address, data, owner, account_slot)
                )
            result = _SourceRpcResult(
                evidence={
                    "kind": "solana",
                    "genesisHash": genesis_hash,
                    "blockhashContextSlot": str(blockhash_slot),
                    "accountContextSlot": str(account_slot),
                    "recentBlockhash": recent_blockhash,
                    "lastValidBlockHeight": str(last_valid_block_height),
                    "lookupTables": [
                        {"address": table.address, "dataSha256": _sha256_hex(table.data)}
                        for table in lookup_tables
                    ],
                },
                lookup_tables=lookup_tables,
                recent_blockhash=recent_blockhash,
            )
    except BridgeError as error:
        failure_code = error.code
        failure_status = error.status
    except _LocalValidationError:
        failure_code = BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE
    except Exception:
        failure_code = BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE
    if failure_code is not None:
        _fail(failure_code, failure_status)
    assert result is not None
    return result


def _wrap_in_cpi_proxy(
    instruction: MayanSwiftV2LocalSourceSwapInstruction,
) -> MayanSwiftV2LocalSourceSwapInstruction:
    return {
        "programId": SOLANA_CPI_PROXY_PROGRAM,
        "accounts": [
            {
                "pubkey": instruction["programId"],
                "isSigner": False,
                "isWritable": False,
            },
            *instruction["accounts"],
        ],
        "dataBase64": instruction["dataBase64"],
    }


def _make_ata_instruction(
    swapper_address: str,
    owner: str,
    mint: str,
    allow_owner_off_curve: bool,
) -> MayanSwiftV2LocalSourceSwapInstruction:
    return {
        "programId": SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        "accounts": [
            {"pubkey": swapper_address, "isSigner": True, "isWritable": True},
            {
                "pubkey": _associated_token_address(owner, mint, allow_owner_off_curve),
                "isSigner": False,
                "isWritable": True,
            },
            {"pubkey": owner, "isSigner": False, "isWritable": False},
            {"pubkey": mint, "isSigner": False, "isWritable": False},
            {"pubkey": SOLANA_SYSTEM_PROGRAM, "isSigner": False, "isWritable": False},
            {"pubkey": SOLANA_TOKEN_PROGRAM, "isSigner": False, "isWritable": False},
            {"pubkey": SOLANA_SYSVAR_RENT, "isSigner": False, "isWritable": False},
        ],
        "dataBase64": "AQ==",
    }


def _make_spl_transfer_instruction(
    source: str,
    destination: str,
    owner: str,
    amount: int,
) -> MayanSwiftV2LocalSourceSwapInstruction:
    data = bytes((3,)) + _write_uint64_le(amount)
    return {
        "programId": SOLANA_TOKEN_PROGRAM,
        "accounts": [
            {"pubkey": source, "isSigner": False, "isWritable": True},
            {"pubkey": destination, "isSigner": False, "isWritable": True},
            {"pubkey": owner, "isSigner": True, "isWritable": False},
        ],
        "dataBase64": base64.b64encode(data).decode("ascii"),
    }


def _make_compute_unit_price_instruction(
    micro_lamports: int,
) -> MayanSwiftV2LocalSourceSwapInstruction:
    data = bytes((3,)) + _write_uint64_le(micro_lamports)
    return {
        "programId": SOLANA_COMPUTE_BUDGET_PROGRAM,
        "accounts": [],
        "dataBase64": base64.b64encode(data).decode("ascii"),
    }


def _make_swift_init_instruction(
    quote: Mapping[str, object],
    route: _LocalCapability,
    swapper_address: str,
    destination_address: str,
    state_address: str,
    state_token_account: str,
    minimum_intermediate_amount: str,
    cancel_fee: int,
    refund_fee: int,
    submit_fee: int,
    mode: int,
    order_nonce: str,
) -> MayanSwiftV2LocalSourceSwapInstruction:
    relayer_account = _associated_token_address(
        swapper_address, route.source_usdc_address, False
    )
    data = bytearray(198)
    data[0:8] = _hex_to_bytes("0x" + SOLANA_INIT_ORDER_DISCRIMINATOR)
    data[8:16] = _write_uint64_le(_uint64(minimum_intermediate_amount, positive=True))
    data[16] = 0
    data[17:25] = _write_uint64_le(submit_fee)
    data[25:57] = _native_address_bytes(destination_address, route.destination_chain_id)
    data[57:59] = _write_uint16_le(route.destination_wormhole_chain_id)
    data[59:91] = _native_address_bytes(
        route.destination_token_address, route.destination_chain_id
    )
    data[91:99] = _write_uint64_le(_uint64(quote["minimumAmountOut"], positive=True))
    data[99:107] = _write_uint64_le(0)
    data[107:115] = _write_uint64_le(cancel_fee)
    data[115:123] = _write_uint64_le(refund_fee)
    data[123:131] = _write_uint64_le(_uint64(quote["deadline"], positive=True))
    data[131:163] = _zero32()
    data[163] = 0
    data[164] = 0
    data[165] = mode
    data[166:198] = _swift_random(cast(str, quote["quoteId"]), order_nonce)
    accounts: list[MayanSwiftV2LocalSourceSwapInstructionAccount] = [
        {"pubkey": swapper_address, "isSigner": False, "isWritable": False},
        {"pubkey": swapper_address, "isSigner": True, "isWritable": True},
        {"pubkey": state_address, "isSigner": False, "isWritable": True},
        {"pubkey": state_token_account, "isSigner": False, "isWritable": True},
        {"pubkey": relayer_account, "isSigner": False, "isWritable": True},
        {"pubkey": SOLANA_SWIFT_PROGRAM, "isSigner": False, "isWritable": False},
        {"pubkey": route.source_usdc_address, "isSigner": False, "isWritable": False},
        {"pubkey": SOLANA_FEE_MANAGER_PROGRAM, "isSigner": False, "isWritable": False},
        {"pubkey": SOLANA_TOKEN_PROGRAM, "isSigner": False, "isWritable": False},
        {"pubkey": SOLANA_SYSTEM_PROGRAM, "isSigner": False, "isWritable": False},
    ]
    return {
        "programId": SOLANA_SWIFT_PROGRAM,
        "accounts": accounts,
        "dataBase64": base64.b64encode(bytes(data)).decode("ascii"),
    }


def _encode_shortvec(value: int) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 0xFFFF:
        _local_invalid()
    output = bytearray()
    current = value
    while True:
        element = current & 0x7F
        current >>= 7
        if current:
            element |= 0x80
        output.append(element)
        if not current:
            return bytes(output)


@dataclass(slots=True)
class _KeyMeta:
    signer: bool = False
    writable: bool = False
    invoked: bool = False


@dataclass(frozen=True, slots=True)
class _CompiledInstruction:
    program_id_index: int
    account_key_indexes: list[int]
    data: bytes


def _compile_solana_v0(
    payer: str,
    recent_blockhash: str,
    instructions: Sequence[MayanSwiftV2LocalSourceSwapInstruction],
    lookup_tables: Sequence[_LocalLookupTable],
) -> str:
    key_meta: dict[str, _KeyMeta] = {}

    def get_or_insert(address: str) -> _KeyMeta:
        meta = key_meta.get(address)
        if meta is None:
            meta = _KeyMeta()
            key_meta[address] = meta
        return meta

    payer_meta = get_or_insert(payer)
    payer_meta.signer = True
    payer_meta.writable = True
    signer_keys: set[str] = set()
    for instruction in instructions:
        get_or_insert(instruction["programId"]).invoked = True
        for account in instruction["accounts"]:
            if account["isSigner"]:
                signer_keys.add(account["pubkey"])
            meta = get_or_insert(account["pubkey"])
            meta.signer = meta.signer or account["isSigner"]
            meta.writable = meta.writable or account["isWritable"]
    if signer_keys != {payer}:
        _local_invalid()

    lookup_table_lookups: list[tuple[str, list[int], list[int]]] = []
    writable_lookup_keys: list[str] = []
    readonly_lookup_keys: list[str] = []
    for table in lookup_tables:
        writable_indexes: list[int] = []
        readonly_indexes: list[int] = []
        for address, meta in list(key_meta.items()):
            if meta.signer or meta.invoked or not meta.writable:
                continue
            try:
                index = table.addresses.index(address)
            except ValueError:
                continue
            if index > 255:
                _local_invalid()
            writable_indexes.append(index)
            writable_lookup_keys.append(address)
            del key_meta[address]
        for address, meta in list(key_meta.items()):
            if meta.signer or meta.invoked or meta.writable:
                continue
            try:
                index = table.addresses.index(address)
            except ValueError:
                continue
            if index > 255:
                _local_invalid()
            readonly_indexes.append(index)
            readonly_lookup_keys.append(address)
            del key_meta[address]
        if writable_indexes or readonly_indexes:
            lookup_table_lookups.append((table.address, writable_indexes, readonly_indexes))
    if len(key_meta) > 256 or len(lookup_table_lookups) > MAX_LOOKUP_TABLES:
        _local_invalid()
    entries = list(key_meta.items())
    writable_signers = [entry for entry in entries if entry[1].signer and entry[1].writable]
    readonly_signers = [entry for entry in entries if entry[1].signer and not entry[1].writable]
    writable_non_signers = [
        entry for entry in entries if not entry[1].signer and entry[1].writable
    ]
    readonly_non_signers = [
        entry for entry in entries if not entry[1].signer and not entry[1].writable
    ]
    if (
        not writable_signers
        or writable_signers[0][0] != payer
        or len(writable_signers) != 1
        or readonly_signers
    ):
        _local_invalid()
    static_keys = [
        address for address, _ in writable_signers
    ] + [
        address for address, _ in readonly_signers
    ] + [
        address for address, _ in writable_non_signers
    ] + [
        address for address, _ in readonly_non_signers
    ]
    all_keys = [*static_keys, *writable_lookup_keys, *readonly_lookup_keys]
    if len(all_keys) > 256:
        _local_invalid()
    key_indexes = {address: index for index, address in enumerate(all_keys)}
    compiled: list[_CompiledInstruction] = []
    for instruction in instructions:
        program_index = key_indexes.get(instruction["programId"])
        if program_index is None:
            _local_invalid()
        account_indexes: list[int] = []
        for account in instruction["accounts"]:
            account_index = key_indexes.get(account["pubkey"])
            if account_index is None:
                _local_invalid()
            account_indexes.append(account_index)
        compiled.append(
            _CompiledInstruction(
                program_id_index=program_index,
                account_key_indexes=account_indexes,
                data=_encode_instruction_data(instruction["dataBase64"]),
            )
        )
    compiled_bytes = _concat(
        _encode_shortvec(len(compiled)),
        *(
            _concat(
                bytes((instruction.program_id_index,)),
                _encode_shortvec(len(instruction.account_key_indexes)),
                bytes(instruction.account_key_indexes),
                _encode_shortvec(len(instruction.data)),
                instruction.data,
            )
            for instruction in compiled
        ),
    )
    lookup_bytes = _concat(
        _encode_shortvec(len(lookup_table_lookups)),
        *(
            _concat(
                _base58_decode_local(address),
                _encode_shortvec(len(writable_indexes)),
                bytes(writable_indexes),
                _encode_shortvec(len(readonly_indexes)),
                bytes(readonly_indexes),
            )
            for address, writable_indexes, readonly_indexes in lookup_table_lookups
        ),
    )
    header = bytes(
        (
            len(writable_signers) + len(readonly_signers),
            len(readonly_signers),
            len(readonly_non_signers),
        )
    )
    message = _concat(
        b"\x80",
        header,
        _encode_shortvec(len(static_keys)),
        *(_base58_decode_local(address) for address in static_keys),
        _base58_decode_local(_canonical_solana_address(recent_blockhash)),
        compiled_bytes,
        lookup_bytes,
    )
    required_signatures = len(writable_signers) + len(readonly_signers)
    transaction = _concat(
        _encode_shortvec(required_signatures),
        b"\0" * (required_signatures * 64),
        message,
    )
    if len(transaction) > MAX_SOLANA_TRANSACTION_BYTES:
        _local_invalid()
    return base64.b64encode(transaction).decode("ascii")


def _build_evm_order_call(
    quote: Mapping[str, object],
    route: _LocalCapability,
    plan: Mapping[str, object],
    swapper_address: str,
    destination_address: str,
    minimum_intermediate_amount: str,
    cancel_fee: int,
    refund_fee: int,
    mode: int,
    order_nonce: str,
) -> str:
    order_words = [
        _word_uint(1),
        _word_bytes32(_native_address_bytes(swapper_address, route.source_chain_id)),
        _word_bytes32(_native_address_bytes(destination_address, route.destination_chain_id)),
        _word_uint(route.destination_wormhole_chain_id),
        _word_bytes32(_zero32()),
        _word_bytes32(
            _native_address_bytes(
                route.destination_token_address, route.destination_chain_id
            )
        ),
        _word_uint(_uint64(quote["minimumAmountOut"], positive=True)),
        _word_uint(0),
        _word_uint(cancel_fee),
        _word_uint(refund_fee),
        _word_uint(_uint64(quote["deadline"], positive=True)),
        _word_uint(0),
        _word_uint(mode),
        _word_bytes32(_swift_random(cast(str, quote["quoteId"]), order_nonce)),
    ]
    swift_call_data = "0xa3a30834" + _bytes_to_hex(
        _encode_abi_with_dynamics(
            [
                _word_address(route.source_usdc_address),
                _word_uint(_uint64(quote["amountIn"], positive=True)),
                *order_words,
            ],
            [b""],
        )
    )
    source_swap = plan.get("sourceSwap")
    if not isinstance(source_swap, Mapping):
        _local_invalid()
    if source_swap.get("kind") == "none":
        return "0xe4269fc4" + _bytes_to_hex(
            _encode_abi_with_dynamics(
                [
                    _word_address(route.source_usdc_address),
                    _word_uint(_uint64(quote["amountIn"], positive=True)),
                    _word_uint(0),
                    _word_uint(0),
                    _word_uint(0),
                    _word_bytes32(_zero32()),
                    _word_bytes32(_zero32()),
                    _word_address(route.swift_contract),
                ],
                [_hex_to_bytes(swift_call_data)],
            )
        )
    if source_swap.get("kind") != "evm-router":
        _local_invalid()
    router_address = cast(str, source_swap.get("routerAddress"))
    router_data = _hex_to_bytes(cast(str, source_swap.get("calldata")))
    router_offset = 13 * 32
    swift_offset = router_offset + 32 + len(_pad32(router_data))
    head = [
        _word_address(route.source_token_address),
        _word_uint(_uint64(quote["amountIn"], positive=True)),
        _word_uint(0),
        _word_uint(0),
        _word_uint(0),
        _word_bytes32(_zero32()),
        _word_bytes32(_zero32()),
        _word_address(router_address),
        _word_uint(router_offset),
        _word_address(route.source_usdc_address),
        _word_uint(_uint64(minimum_intermediate_amount, positive=True)),
        _word_address(route.swift_contract),
        _word_uint(swift_offset),
    ]
    return "0x30dedc57" + _bytes_to_hex(
        _concat(
            *head,
            _encode_abi_bytes(router_data),
            _encode_abi_bytes(_hex_to_bytes(swift_call_data)),
        )
    )


def _build_solana_instructions(
    quote: Mapping[str, object],
    route: _LocalCapability,
    plan: Mapping[str, object],
    swapper_address: str,
    destination_address: str,
    minimum_intermediate_amount: str,
    cancel_fee: int,
    refund_fee: int,
    submit_fee: int,
    mode: int,
    order_nonce: str,
    suggested_priority_fee: int | None,
) -> list[MayanSwiftV2LocalSourceSwapInstruction]:
    order_hash = _hash_order(
        quote,
        route,
        swapper_address,
        destination_address,
        order_nonce,
        cancel_fee,
        refund_fee,
        mode,
    )
    state_address = _find_program_address(
        (b"STATE_SOURCE", _hex_to_bytes(order_hash), _write_uint16_le(2)),
        SOLANA_SWIFT_PROGRAM,
    )[0]
    state_token_account = _associated_token_address(
        state_address, route.source_usdc_address, True
    )
    init = _make_swift_init_instruction(
        quote,
        route,
        swapper_address,
        destination_address,
        state_address,
        state_token_account,
        minimum_intermediate_amount,
        cancel_fee,
        refund_fee,
        submit_fee,
        mode,
        order_nonce,
    )
    if route.is_usdc:
        instructions: list[MayanSwiftV2LocalSourceSwapInstruction] = []
        if suggested_priority_fee is not None and suggested_priority_fee > 0:
            instructions.append(
                _make_compute_unit_price_instruction(suggested_priority_fee)
            )
        instructions.append(
            _wrap_in_cpi_proxy(
                _make_ata_instruction(
                    swapper_address,
                    state_address,
                    route.source_usdc_address,
                    True,
                )
            )
        )
        instructions.append(
            _wrap_in_cpi_proxy(
                _make_spl_transfer_instruction(
                    _associated_token_address(
                        swapper_address, route.source_usdc_address, False
                    ),
                    state_token_account,
                    swapper_address,
                    _uint64(quote["amountIn"], positive=True),
                )
            )
        )
        instructions.append(_wrap_in_cpi_proxy(init))
        return instructions
    source_swap = plan.get("sourceSwap")
    if not isinstance(source_swap, Mapping) or source_swap.get("kind") != "solana-jupiter-v6":
        _local_invalid()
    provider_instructions = cast(
        list[MayanSwiftV2LocalSourceSwapInstruction],
        source_swap["instructions"],
    )
    compute_count = sum(
        instruction["programId"] == SOLANA_COMPUTE_BUDGET_PROGRAM
        for instruction in provider_instructions
    )
    compute = provider_instructions[:compute_count]
    remainder = provider_instructions[compute_count:]
    swap_indexes = [
        index
        for index, instruction in enumerate(remainder)
        if instruction["programId"] == SOLANA_JUPITER_V6
    ]
    if not swap_indexes or swap_indexes[0] < 1:
        _local_invalid()
    swap_index = swap_indexes[0]
    setup = remainder[:swap_index]
    swap = remainder[swap_index]
    if len(remainder[swap_index + 1 :]) != 0:
        _local_invalid()
    return [
        *compute,
        *(_wrap_in_cpi_proxy(instruction) for instruction in setup),
        swap,
        _wrap_in_cpi_proxy(init),
    ]


def _exact_keys(value: object, expected: set[str]) -> bool:
    return isinstance(value, Mapping) and set(value) == expected


def _validate_plan(
    request: Mapping[str, object],
    route: _LocalCapability,
    parsed_quote: _ParsedSourceQuote,
    plan: object,
    raw_quote_sha256: str,
    order_hash: str,
    binding: str,
    swapper_address: str,
    destination_address: str,
) -> MayanSwiftV2SourceSwapPlan:
    expected_keys = {
        "planKind",
        "providerId",
        "capabilityId",
        "sourceChainId",
        "destinationChainId",
        "sourceTokenDeploymentId",
        "destinationTokenDeploymentId",
        "quoteId",
        "rawQuoteSha256",
        "orderNonce",
        "swapperAddress",
        "destinationAddress",
        "orderHash",
        "quoteBindingHash",
        "minimumIntermediateAmount",
        "sourceSwap",
        "planHash",
    }
    if not _exact_keys(plan, expected_keys):
        _local_invalid()
    result = cast(Mapping[str, object], plan)
    request_quote = request.get("quote")
    if not isinstance(request_quote, Mapping):
        _local_invalid()
    request_quote_mapping = cast(Mapping[str, object], request_quote)
    expected_pairs = {
        "planKind": "mayan-swift-v2-local-source-swap",
        "providerId": "mayan-swift-v2",
        "capabilityId": route.capability_id,
        "sourceChainId": route.source_chain_id,
        "destinationChainId": route.destination_chain_id,
        "sourceTokenDeploymentId": route.source_token_deployment_id,
        "destinationTokenDeploymentId": route.destination_token_deployment_id,
        "quoteId": request_quote_mapping.get("quoteId"),
        "rawQuoteSha256": raw_quote_sha256,
        "orderNonce": request.get("orderNonce"),
        "swapperAddress": swapper_address,
        "destinationAddress": destination_address,
        "orderHash": order_hash,
        "quoteBindingHash": binding,
        "minimumIntermediateAmount": parsed_quote.minimum_intermediate_amount,
    }
    if any(result.get(key) != value for key, value in expected_pairs.items()):
        _local_invalid()
    source_swap = result.get("sourceSwap")
    if not isinstance(source_swap, Mapping):
        _local_invalid()
    normalized_source_swap: Mapping[str, object]
    if route.is_usdc:
        if not _exact_keys(source_swap, {"kind"}) or source_swap.get("kind") != "none":
            _local_invalid()
        normalized_source_swap = {"kind": "none"}
    else:
        state_address = ""
        state_token_account = ""
        if route.source_chain_id == SOLANA_CHAIN_ID:
            state_address = _find_program_address(
                (b"STATE_SOURCE", _hex_to_bytes(order_hash), _write_uint16_le(2)),
                SOLANA_SWIFT_PROGRAM,
            )[0]
            state_token_account = _associated_token_address(
                state_address, route.source_usdc_address, True
            )
        raw_source_text = source_swap.get("rawProviderSourceSwapJson")
        if not isinstance(raw_source_text, str):
            _local_invalid()
        _, raw_source = _local_json_object(raw_source_text)
        expected_source_swap = _validate_source_swap_envelope(
            request_quote_mapping,
            route,
            raw_source,
            state_address,
            state_token_account,
            swapper_address,
            parsed_quote.minimum_intermediate_amount,
        )
        expected_with_blanks = {
            key: value
            for key, value in source_swap.items()
            if key not in {"rawResponseSha256", "rawProviderSourceSwapJson"}
        }
        expected_source_swap_blanks = {
            key: value
            for key, value in expected_source_swap.items()
            if key not in {"rawResponseSha256", "rawProviderSourceSwapJson"}
        }
        if not _strict_equal(expected_with_blanks, expected_source_swap_blanks):
            _local_invalid()
        if source_swap.get("rawResponseSha256") != _sha256_hex(raw_source_text):
            _local_invalid()
        normalized_source_swap = source_swap
    if result.get("planHash") != _plan_hash(binding, normalized_source_swap):
        _local_invalid()
    return cast(MayanSwiftV2SourceSwapPlan, copy.deepcopy(dict(result)))


def _local_build_dependencies(route: _LocalCapability) -> list[str]:
    return [
        dependency
        for dependency in route.dependencies
        if dependency != "mayan-hosted-transaction-builder"
    ] + [
        "configured-ethereum-rpc"
        if route.source_chain_id == ETHEREUM_CHAIN_ID
        else "configured-solana-rpc"
    ]


async def build_local_unsigned(
    request: object,
    runtime: LocalRuntime,
    options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
) -> MayanSwiftV2LocalBuild:
    try:
        value = _context_mapping(request, build=True)
        quote = _revalidate_local_quote(value.get("quote"), runtime)
        route = _validate_local_route(quote)
        parsed_quote = _parse_source_quote(quote, route)
        swapper_address = _normalize_local_address(
            value.get("swapperAddress"), route.source_chain_id
        )
        destination_address = _normalize_local_address(
            value.get("destinationAddress"), route.destination_chain_id
        )
        order_nonce = value.get("orderNonce")
        if not isinstance(order_nonce, str) or NONCE_RE.fullmatch(order_nonce) is None:
            _local_invalid()
        _validate_destination_minimum_compatibility(
            parsed_quote.root, quote["minimumAmountOut"]
        )
        _validate_local_expiry(quote, runtime)
        raw_quote = quote["rawSignedQuoteJson"]
        raw_quote_sha256 = _sha256_hex(raw_quote)
        order_hash = _hash_order(
            quote,
            route,
            swapper_address,
            destination_address,
            order_nonce,
            parsed_quote.cancel_fee,
            parsed_quote.refund_fee,
            parsed_quote.mode,
        )
        binding = _quote_binding_hash(
            route,
            quote,
            raw_quote_sha256,
            order_nonce,
            swapper_address,
            destination_address,
        )
        plan = _validate_plan(
            value,
            route,
            parsed_quote,
            value.get("sourceSwapPlan"),
            raw_quote_sha256,
            order_hash,
            binding,
            swapper_address,
            destination_address,
        )
    except BridgeError:
        raise
    except _LocalValidationError:
        _fail(BridgeErrorCode.LOCAL_BUILD_INVALID)
    except Exception:
        _fail(BridgeErrorCode.LOCAL_BUILD_INVALID)

    rpc = await _fetch_source_rpc(route, plan, runtime, options)
    try:
        if route.source_chain_id == ETHEREUM_CHAIN_ID:
            transaction: MayanSwiftV2UnsignedTransaction = {
                "kind": "evm-unsigned-transaction",
                "chainId": ETHEREUM_CHAIN_ID,
                "from": swapper_address,
                "to": ETHEREUM_FORWARDER,
                "data": _build_evm_order_call(
                    quote,
                    route,
                    plan,
                    swapper_address,
                    destination_address,
                    parsed_quote.minimum_intermediate_amount,
                    parsed_quote.cancel_fee,
                    parsed_quote.refund_fee,
                    parsed_quote.mode,
                    order_nonce,
                ),
                "value": "0",
            }
        else:
            instructions = _build_solana_instructions(
                quote,
                route,
                plan,
                swapper_address,
                destination_address,
                parsed_quote.minimum_intermediate_amount,
                parsed_quote.cancel_fee,
                parsed_quote.refund_fee,
                parsed_quote.submit_fee,
                parsed_quote.mode,
                order_nonce,
                parsed_quote.suggested_priority_fee,
            )
            if rpc.recent_blockhash is None:
                _local_invalid()
            transaction = {
                "kind": "solana-v0-unsigned-transaction",
                "chainId": SOLANA_CHAIN_ID,
                "feePayer": swapper_address,
                "transactionBase64": _compile_solana_v0(
                    swapper_address,
                    rpc.recent_blockhash,
                    instructions,
                    rpc.lookup_tables,
                ),
            }
        allowance = (
            {
                "tokenDeploymentId": route.source_token_deployment_id,
                "tokenAddress": route.source_token_address,
                "owner": swapper_address,
                "spender": ETHEREUM_FORWARDER,
                "requiredAmount": quote["amountIn"],
            }
            if route.source_chain_id == ETHEREUM_CHAIN_ID
            else None
        )
        quote_copy = cast(MayanSwiftV2Quote, _clone_json(dict(quote)))
        plan_copy = cast(MayanSwiftV2SourceSwapPlan, _clone_json(dict(plan)))
        return {
            "buildKind": "mayan-swift-v2-local-unsigned",
            "providerId": "mayan-swift-v2",
            "capabilityId": route.capability_id,
            "quote": quote_copy,
            "sourceChainId": route.source_chain_id,
            "destinationChainId": route.destination_chain_id,
            "sourceSwapPlan": plan_copy,
            "transaction": transaction,
            "allowance": allowance,
            "construction": {
                "mode": "local",
                "referenceCommit": MAYAN_REFERENCE_COMMIT,
                "orderNonce": order_nonce,
                "orderHash": order_hash,
                "minimumIntermediateAmount": parsed_quote.minimum_intermediate_amount,
                "effectiveDependencies": _local_build_dependencies(route),
                "sourceRpcEvidence": rpc.evidence,
            },
            "validation": {
                "level": "local-structural",
                "quoteSignatureLocallyVerified": False,
                "planBindingLocallyVerified": True,
                "transactionBytesLocallyConstructed": True,
                "settlementLocallyVerified": False,
            },
        }
    except BridgeError:
        raise
    except _LocalValidationError:
        _fail(BridgeErrorCode.LOCAL_BUILD_INVALID)
    except Exception:
        _fail(BridgeErrorCode.LOCAL_BUILD_INVALID)


__all__ = [
    "LocalRuntime",
    "MayanSwiftV2LocalBuild",
    "MayanSwiftV2LocalBuildRequest",
    "MayanSwiftV2LocalBuildValidation",
    "MayanSwiftV2LocalConstruction",
    "MayanSwiftV2LocalContext",
    "MayanSwiftV2LocalEvmRpcEvidence",
    "MayanSwiftV2LocalSolanaRpcEvidence",
    "MayanSwiftV2LocalSolanaRpcLookupTableEvidence",
    "MayanSwiftV2LocalSourceRpcEvidence",
    "MayanSwiftV2LocalSourceSwapEvmRouter",
    "MayanSwiftV2LocalSourceSwapInstruction",
    "MayanSwiftV2LocalSourceSwapInstructionAccount",
    "MayanSwiftV2LocalSourceSwapNone",
    "MayanSwiftV2LocalSourceSwapPlan",
    "MayanSwiftV2LocalSourceSwapSolanaJupiter",
    "MayanSwiftV2SourceSwapPlan",
    "build_local_unsigned",
    "prepare_source_swap",
]
