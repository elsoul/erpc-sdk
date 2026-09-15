"""Offline DEX, pool, and native-wrap catalog lookups.

The records in :mod:`erpc_sdk._dex_catalog_data` are generated from the
canonical registry.  This module only builds in-memory indexes over those
immutable records; catalog reads never require a client, API key, filesystem,
or network access.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Final, Literal, TypeAlias, TypeGuard

from ._dex_catalog_data import (
    DEX_ALIASES,
    DEX_CATALOG_AS_OF_DATE,
    DEX_CATALOG_CONTENT_DIGEST,
    DEX_CATALOG_VERSION,
    DEX_CHAIN_IDS,
    DEX_DEPLOYMENTS,
    DEXES,
    NATIVE_WRAP_DEFINITIONS,
    POOL_DEFINITIONS,
    POOLS,
    DexAlias,
    DexDeployment,
    NativeWrapDefinition,
    PoolAdapter,
    PoolDefinition,
    dexes,
    pools,
)

DexChainId: TypeAlias = str
DexStatus: TypeAlias = Literal["active", "legacy", "winding-down", "retired"]


class DexChainIds:
    """Canonical chain IDs used by the bundled DEX catalog."""

    ETHEREUM_MAINNET: Final[DexChainId] = "eip155:1"
    SOLANA_MAINNET: Final[DexChainId] = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    AVALANCHE_C_MAINNET: Final[DexChainId] = "eip155:43114"

    def __init__(self) -> None:
        raise TypeError("DexChainIds is a constants namespace")


_EVM_CHAIN_IDS: Final[frozenset[str]] = frozenset(
    {DexChainIds.ETHEREUM_MAINNET, DexChainIds.AVALANCHE_C_MAINNET}
)
_KNOWN_CHAIN_IDS: Final[frozenset[str]] = frozenset(
    {
        DexChainIds.ETHEREUM_MAINNET,
        DexChainIds.SOLANA_MAINNET,
        DexChainIds.AVALANCHE_C_MAINNET,
    }
)
_EMPTY_POOLS: Final[tuple[PoolDefinition, ...]] = ()
_EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")

_DEXES_BY_ID: Final[dict[str, DexDeployment]] = {
    deployment.dex_deployment_id: deployment for deployment in DEX_DEPLOYMENTS
}
_POOLS_BY_ID: Final[dict[str, PoolDefinition]] = {
    pool.pool_definition_id: pool for pool in POOL_DEFINITIONS
}
_WRAPS_BY_NATIVE_ID: Final[dict[str, NativeWrapDefinition]] = {
    definition.native_token_deployment_id: definition for definition in NATIVE_WRAP_DEFINITIONS
}


def get_dex_deployment(dex_deployment_id: object) -> DexDeployment | None:
    """Return the exact catalog DEX identified by an opaque ID."""

    if not isinstance(dex_deployment_id, str):
        return None
    return _DEXES_BY_ID.get(dex_deployment_id)


def get_pool_definition(pool_definition_id: object) -> PoolDefinition | None:
    """Return the exact catalog pool identified by an opaque ID."""

    if not isinstance(pool_definition_id, str):
        return None
    return _POOLS_BY_ID.get(pool_definition_id)


def find_pool_definition_by_address(
    chain_id: object,
    address: object,
) -> PoolDefinition | None:
    """Find a pool by chain-qualified address.

    EVM addresses are matched case-insensitively after strict validation.
    Solana addresses use exact base58 text matching.
    """

    if not _is_known_chain_id(chain_id) or not isinstance(address, str) or not address:
        return None
    normalized = address
    if chain_id in _EVM_CHAIN_IDS:
        if _EVM_ADDRESS.fullmatch(address) is None:
            return None
        normalized = address.lower()
        if normalized == "0x" + "0" * 40:
            return None
    for pool in POOL_DEFINITIONS:
        if pool.chain_id == chain_id and pool.address == normalized:
            return pool
    return None


def find_pool_definitions_by_pair(
    chain_id: object,
    token_a_deployment_id: object,
    token_b_deployment_id: object,
) -> tuple[PoolDefinition, ...]:
    """Find all pools for an unordered token pair in pool-ID order."""

    if (
        not _is_known_chain_id(chain_id)
        or not isinstance(token_a_deployment_id, str)
        or not isinstance(token_b_deployment_id, str)
        or not token_a_deployment_id
        or not token_b_deployment_id
        or token_a_deployment_id == token_b_deployment_id
    ):
        return _EMPTY_POOLS
    wanted = tuple(sorted((token_a_deployment_id, token_b_deployment_id)))
    matches = tuple(
        sorted(
            (
                pool
                for pool in POOL_DEFINITIONS
                if pool.chain_id == chain_id
                and tuple(sorted((pool.token0_deployment_id, pool.token1_deployment_id))) == wanted
            ),
            key=lambda pool: pool.pool_definition_id,
        )
    )
    return matches if matches else _EMPTY_POOLS


def list_pool_definitions(
    options: Mapping[str, object] | None = None,
) -> tuple[PoolDefinition, ...]:
    """List pools using the exact optional ``chainId``/token/adapter filters."""

    if options is None:
        options = {}
    if not isinstance(options, Mapping):
        return _EMPTY_POOLS
    allowed = {"chainId", "tokenDeploymentId", "adapterKind"}
    if any(key not in allowed for key in options):
        return _EMPTY_POOLS
    chain_id = options.get("chainId")
    token_deployment_id = options.get("tokenDeploymentId")
    adapter_kind = options.get("adapterKind")
    if chain_id is not None and not _is_known_chain_id(chain_id):
        return _EMPTY_POOLS
    if token_deployment_id is not None and (
        not isinstance(token_deployment_id, str) or not token_deployment_id
    ):
        return _EMPTY_POOLS
    if adapter_kind is not None and (not isinstance(adapter_kind, str) or not adapter_kind):
        return _EMPTY_POOLS

    matches = tuple(
        sorted(
            (
                pool
                for pool in POOL_DEFINITIONS
                if (chain_id is None or pool.chain_id == chain_id)
                and (
                    token_deployment_id is None
                    or pool.token0_deployment_id == token_deployment_id
                    or pool.token1_deployment_id == token_deployment_id
                )
                and (adapter_kind is None or pool.adapter.kind == adapter_kind)
            ),
            key=lambda pool: pool.pool_definition_id,
        )
    )
    return matches if matches else _EMPTY_POOLS


def get_native_wrap_definition(
    native_token_deployment_id: object,
) -> NativeWrapDefinition | None:
    """Return the native-to-wrapped relationship for an opaque native ID."""

    if not isinstance(native_token_deployment_id, str):
        return None
    return _WRAPS_BY_NATIVE_ID.get(native_token_deployment_id)


def _is_known_chain_id(value: object) -> TypeGuard[DexChainId]:
    return isinstance(value, str) and value in _KNOWN_CHAIN_IDS


__all__ = [
    "DEX_ALIASES",
    "DEX_CATALOG_AS_OF_DATE",
    "DEX_CATALOG_CONTENT_DIGEST",
    "DEX_CATALOG_VERSION",
    "DEX_CHAIN_IDS",
    "DEX_DEPLOYMENTS",
    "DEXES",
    "NATIVE_WRAP_DEFINITIONS",
    "POOLS",
    "POOL_DEFINITIONS",
    "DexAlias",
    "DexChainId",
    "DexChainIds",
    "DexDeployment",
    "DexStatus",
    "NativeWrapDefinition",
    "PoolAdapter",
    "PoolDefinition",
    "dexes",
    "find_pool_definition_by_address",
    "find_pool_definitions_by_pair",
    "get_dex_deployment",
    "get_native_wrap_definition",
    "get_pool_definition",
    "list_pool_definitions",
    "pools",
]
