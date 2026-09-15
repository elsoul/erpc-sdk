from __future__ import annotations

import re

import pytest

from erpc_sdk import (
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
    DexChainIds,
    dexes,
    find_pool_definition_by_address,
    find_pool_definitions_by_pair,
    get_dex_deployment,
    get_native_wrap_definition,
    get_pool_definition,
    list_pool_definitions,
    pools,
)


def test_generated_metadata_and_alias_namespaces() -> None:
    assert DEX_CATALOG_VERSION == "1.0.0"
    assert DEX_CATALOG_AS_OF_DATE == "2026-09-15"
    assert re.fullmatch(r"[0-9a-f]{64}", DEX_CATALOG_CONTENT_DIGEST)
    assert dict(DEX_CHAIN_IDS) == {
        "ethereum": DexChainIds.ETHEREUM_MAINNET,
        "solana": DexChainIds.SOLANA_MAINNET,
        "avalancheC": DexChainIds.AVALANCHE_C_MAINNET,
    }
    assert DEXES is dexes
    assert POOLS is pools
    assert dexes.ethereum.UNISWAP_V2 == "dex-deployment-0001"
    assert pools.ethereum.UNISWAP_V2_USDC_WETH == "pool-0001"
    assert pools.solana.ORCA_WHIRLPOOLS_WSOL_EURC == "pool-0003"


def test_all_records_round_trip_and_alias_targets() -> None:
    assert len(DEX_DEPLOYMENTS) == 4
    assert len(POOL_DEFINITIONS) == 4
    assert len(NATIVE_WRAP_DEFINITIONS) == 3
    assert len(DEX_ALIASES) == 8
    for deployment in DEX_DEPLOYMENTS:
        assert get_dex_deployment(deployment.dex_deployment_id) is deployment
    for pool in POOL_DEFINITIONS:
        assert get_pool_definition(pool.pool_definition_id) is pool
        assert get_dex_deployment(pool.dex_deployment_id) is not None
    for definition in NATIVE_WRAP_DEFINITIONS:
        assert get_native_wrap_definition(definition.native_token_deployment_id) is definition
    for alias in DEX_ALIASES:
        target = alias.dex_deployment_id or alias.pool_definition_id
        assert target is not None
        assert (
            get_dex_deployment(target) is not None
            if alias.dex_deployment_id is not None
            else get_pool_definition(target) is not None
        )


def test_address_pair_and_filter_lookups_are_stable() -> None:
    pool = get_pool_definition("pool-0001")
    assert pool is not None
    mixed_case = "0x" + pool.address[2:].swapcase()
    assert find_pool_definition_by_address(pool.chain_id, mixed_case) is pool
    assert find_pool_definition_by_address(pool.chain_id, "0x" + "0" * 40) is None
    assert find_pool_definition_by_address(pool.chain_id, "not-an-address") is None

    forward = find_pool_definitions_by_pair(
        pool.chain_id,
        pool.token0_deployment_id,
        pool.token1_deployment_id,
    )
    reverse = find_pool_definitions_by_pair(
        pool.chain_id,
        pool.token1_deployment_id,
        pool.token0_deployment_id,
    )
    assert forward == reverse == (pool,)
    assert [
        entry.pool_definition_id
        for entry in find_pool_definitions_by_pair(
            DexChainIds.SOLANA_MAINNET,
            "deployment-0006",
            "deployment-0013",
        )
    ] == ["pool-0003", "pool-0004"]
    assert list_pool_definitions({}) == tuple(POOL_DEFINITIONS)
    assert [
        entry.pool_definition_id
        for entry in list_pool_definitions({"adapterKind": "evm-constant-product-v2"})
    ] == [
        "pool-0001",
        "pool-0002",
    ]
    assert list_pool_definitions({"chainId": "unknown:chain"}) == ()
    assert list_pool_definitions({"status": "active"}) == ()


def test_lookups_reject_malformed_or_mutating_inputs() -> None:
    assert get_dex_deployment(None) is None
    assert get_dex_deployment("dex-deployment-0001:extra") is None
    assert get_pool_definition([]) is None
    assert get_native_wrap_definition("native-wrap-0001") is None
    assert (
        find_pool_definitions_by_pair(
            DexChainIds.ETHEREUM_MAINNET,
            "deployment-0001",
            "deployment-0001",
        )
        == ()
    )
    assert (
        find_pool_definitions_by_pair(
            {},
            "deployment-0002",
            "deployment-0008",
        )
        == ()
    )
    assert list_pool_definitions([]) == ()

    with pytest.raises(AttributeError):
        pools.ethereum.UNISWAP_V2_USDC_WETH = "changed"  # type: ignore[misc]
    with pytest.raises(AttributeError):
        POOL_DEFINITIONS[0].address = "changed"  # type: ignore[misc]
    assert get_pool_definition("pool-0001") is POOL_DEFINITIONS[0]
