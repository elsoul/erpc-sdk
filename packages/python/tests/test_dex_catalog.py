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
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", DEX_CATALOG_AS_OF_DATE)
    assert re.fullmatch(r"[0-9a-f]{64}", DEX_CATALOG_CONTENT_DIGEST)
    assert dict(DEX_CHAIN_IDS) == {
        "ethereum": DexChainIds.ETHEREUM_MAINNET,
        "solana": DexChainIds.SOLANA_MAINNET,
        "avalancheC": DexChainIds.AVALANCHE_C_MAINNET,
    }
    assert DEXES is dexes
    assert POOLS is pools
    ethereum_dex_id = dexes.ethereum.UNISWAP_V2
    ethereum_pool_id = pools.ethereum.UNISWAP_V2_USDC_WETH
    solana_pool_id = pools.solana.ORCA_WHIRLPOOLS_WSOL_EURC
    assert get_dex_deployment(ethereum_dex_id) is not None
    assert get_pool_definition(ethereum_pool_id) is not None
    assert get_pool_definition(solana_pool_id) is not None


def test_all_records_round_trip_and_alias_targets() -> None:
    assert get_dex_deployment("dex-deployment-0001") is not None
    assert get_dex_deployment("dex-deployment-0002") is not None
    assert get_pool_definition("pool-0001") is not None
    assert get_pool_definition("pool-0002") is not None
    assert get_native_wrap_definition("deployment-0001") is not None
    assert get_native_wrap_definition("deployment-0003") is not None
    assert get_native_wrap_definition("deployment-0005") is not None
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
    expected = tuple(
        sorted(
            (
                entry
                for entry in POOL_DEFINITIONS
                if entry.chain_id == pool.chain_id
                and tuple(sorted((entry.token0_deployment_id, entry.token1_deployment_id)))
                == tuple(sorted((pool.token0_deployment_id, pool.token1_deployment_id)))
            ),
            key=lambda entry: entry.pool_definition_id,
        )
    )
    assert forward == reverse == expected
    solana_pair = find_pool_definitions_by_pair(
        DexChainIds.SOLANA_MAINNET,
        "deployment-0006",
        "deployment-0013",
    )
    assert solana_pair
    assert [entry.pool_definition_id for entry in solana_pair] == sorted(
        entry.pool_definition_id
        for entry in POOL_DEFINITIONS
        if entry.chain_id == DexChainIds.SOLANA_MAINNET
        and {
            entry.token0_deployment_id,
            entry.token1_deployment_id,
        }
        == {"deployment-0006", "deployment-0013"}
    )
    assert list_pool_definitions({}) == tuple(POOL_DEFINITIONS)
    assert [
        entry.pool_definition_id
        for entry in list_pool_definitions({"adapterKind": "evm-constant-product-v2"})
    ] == [
        entry.pool_definition_id
        for entry in POOL_DEFINITIONS
        if entry.adapter.kind == "evm-constant-product-v2"
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
        POOL_DEFINITIONS.append(None)  # type: ignore[attr-defined]
    pool = get_pool_definition("pool-0001")
    assert pool is not None
    with pytest.raises(AttributeError):
        pool.address = "changed"  # type: ignore[misc]
    assert get_pool_definition("pool-0001") is pool
