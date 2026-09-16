from __future__ import annotations

import re

import pytest

from erpc_sdk import (
    TOKEN_ALIASES,
    TOKEN_ASSETS,
    TOKEN_CATALOG_AS_OF_DATE,
    TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION,
    TOKEN_DEPLOYMENTS,
    TokenChainIds,
    find_token_deployment_by_address,
    find_token_deployments_by_symbol,
    get_native_token_deployment,
    get_token_asset,
    get_token_deployment,
    list_token_deployments,
    tokens,
)

CHAINS = (
    TokenChainIds.ETHEREUM_MAINNET,
    TokenChainIds.SOLANA_MAINNET,
    TokenChainIds.AVALANCHE_C_MAINNET,
)


def test_generated_metadata_and_immutable_alias_groups() -> None:
    assert TOKEN_CATALOG_VERSION == "1.0.0"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", TOKEN_CATALOG_AS_OF_DATE)
    assert re.fullmatch(r"[0-9a-f]{64}", TOKEN_CATALOG_CONTENT_DIGEST)

    assert isinstance(tokens.ethereum.USDC, str)
    assert isinstance(tokens.solana.USDC, str)
    assert isinstance(tokens.avalanche_c.USDC, str)
    with pytest.raises(AttributeError):
        tokens.ethereum.USDC = "mutated"  # type: ignore[misc]

    for alias in TOKEN_ALIASES:
        group_name = "avalanche_c" if alias.namespace == "avalancheC" else alias.namespace
        group = getattr(tokens, group_name)
        assert getattr(group, alias.name) == alias.deployment_id
        assert get_token_deployment(alias.deployment_id) is not None


def test_records_round_trip_and_flatten_asset_metadata() -> None:
    assert TOKEN_ASSETS
    assert TOKEN_DEPLOYMENTS
    assert TOKEN_ALIASES

    for asset in TOKEN_ASSETS:
        assert get_token_asset(asset.asset_id) is asset

    for deployment in TOKEN_DEPLOYMENTS:
        assert get_token_deployment(deployment.deployment_id) is deployment
        asset = get_token_asset(deployment.asset_id)
        assert asset is not None
        assert deployment.name == asset.name
        assert deployment.representation_kind == asset.representation_kind
        assert deployment.stable_currency == asset.stable_currency
        assert deployment.underlying_asset_id == asset.underlying_asset_id
        assert deployment.economic_reference_asset_id == asset.economic_reference_asset_id
        if deployment.underlying_asset_id is not None:
            assert get_token_asset(deployment.underlying_asset_id) is not None
        if deployment.economic_reference_asset_id is not None:
            assert get_token_asset(deployment.economic_reference_asset_id) is not None
        if deployment.replaced_by_deployment_id is not None:
            assert get_token_deployment(deployment.replaced_by_deployment_id) is not None

    for alias in TOKEN_ALIASES:
        assert get_token_deployment(alias.deployment_id) is not None


def test_duplicate_symbols_and_shared_asset_identity_remain_discoverable() -> None:
    eure = find_token_deployments_by_symbol(TokenChainIds.ETHEREUM_MAINNET, "EURe")
    assert len(eure) >= 2
    assert [deployment.deployment_id for deployment in eure] == sorted(
        deployment.deployment_id for deployment in eure
    )

    wsol = find_token_deployments_by_symbol(TokenChainIds.SOLANA_MAINNET, "WSOL")
    assert {deployment.standard for deployment in wsol} >= {"spl-token", "spl-token-2022"}

    eurcv_eth = find_token_deployments_by_symbol(TokenChainIds.ETHEREUM_MAINNET, "EURCV")
    eurcv_sol = find_token_deployments_by_symbol(TokenChainIds.SOLANA_MAINNET, "EURCV")
    eth_18 = next(deployment for deployment in eurcv_eth if deployment.decimals == 18)
    sol_2 = next(deployment for deployment in eurcv_sol if deployment.decimals == 2)
    assert eth_18.asset_id == sol_2.asset_id


def test_chain_qualified_symbols_lifecycle_and_native_records() -> None:
    for chain_id in CHAINS:
        matches = find_token_deployments_by_symbol(chain_id, "USDC")
        assert matches
        assert all(deployment.chain_id == chain_id for deployment in matches)
        assert all(deployment.symbol == "USDC" for deployment in matches)

        native = get_native_token_deployment(chain_id)
        assert native is not None
        assert native.chain_id == chain_id
        assert native.standard == "native"
        assert native.address is None
        assert find_token_deployment_by_address(chain_id, "") is None
        assert find_token_deployment_by_address(chain_id, None) is None

    all_deployments = list_token_deployments()
    assert len(all_deployments) == len(TOKEN_DEPLOYMENTS)
    assert {deployment.status for deployment in all_deployments} >= {
        "active",
        "legacy",
        "winding-down",
        "retired",
    }
    assert {deployment.representation_kind for deployment in all_deployments} >= {
        "native",
        "wrapped",
        "bridged",
    }


def test_stable_currency_filters_preserve_all_matching_statuses() -> None:
    for currency in ("USD", "EUR", "JPY"):
        filtered = list_token_deployments(stable_currency=currency)
        assert filtered
        assert all(deployment.stable_currency == currency for deployment in filtered)

    solana_eur = list_token_deployments(
        TokenChainIds.SOLANA_MAINNET,
        "EUR",
    )
    assert solana_eur
    assert all(
        deployment.chain_id == TokenChainIds.SOLANA_MAINNET
        and deployment.stable_currency == "EUR"
        for deployment in solana_eur
    )


def test_malformed_inputs_are_safe_and_ids_are_opaque() -> None:
    first = next(iter(TOKEN_DEPLOYMENTS))
    assert get_token_asset(f"{first.asset_id}:extra") is None
    assert get_token_deployment(f"{first.deployment_id}:extra") is None
    assert get_token_asset(None) is None
    assert get_token_asset({"asset_id": first.asset_id}) is None
    assert get_token_deployment([]) is None

    assert find_token_deployments_by_symbol(TokenChainIds.ETHEREUM_MAINNET, "usdc") == ()
    assert find_token_deployments_by_symbol(TokenChainIds.ETHEREUM_MAINNET, "") == ()
    assert find_token_deployments_by_symbol("eip155:999", first.symbol) == ()
    assert find_token_deployments_by_symbol([], first.symbol) == ()
    assert list_token_deployments("eip155:999") == ()
    assert list_token_deployments({}, None) == ()
    assert list_token_deployments(None, "GBP") == ()
    assert list_token_deployments(None, []) == ()
    assert get_native_token_deployment("eip155:999") is None


def test_address_lookup_is_case_insensitive_only_for_valid_evm_addresses() -> None:
    evm = next(
        deployment
        for deployment in TOKEN_DEPLOYMENTS
        if deployment.chain_id == TokenChainIds.ETHEREUM_MAINNET
        and deployment.address is not None
    )
    assert evm.address is not None
    mixed_case = "0x" + evm.address[2:].swapcase()
    assert find_token_deployment_by_address(evm.chain_id, mixed_case) is evm
    assert find_token_deployment_by_address(evm.chain_id, "0x1234") is None
    assert find_token_deployment_by_address(
        evm.chain_id,
        "0x" + "0" * 40,
    ) is None
    assert find_token_deployment_by_address(evm.chain_id, "0X" + evm.address[2:]) is None
    assert find_token_deployment_by_address(evm.chain_id, b"0x" + evm.address[2:].encode()) is None

    solana = next(
        deployment
        for deployment in TOKEN_DEPLOYMENTS
        if deployment.chain_id == TokenChainIds.SOLANA_MAINNET
        and deployment.address is not None
    )
    assert solana.address is not None
    assert find_token_deployment_by_address(solana.chain_id, solana.address) is solana
    replacement = "1" if solana.address[0] != "1" else "2"
    assert find_token_deployment_by_address(
        solana.chain_id,
        replacement + solana.address[1:],
    ) is None


def test_catalog_records_and_results_cannot_be_mutated() -> None:
    assert isinstance(TOKEN_ASSETS, tuple)
    assert isinstance(TOKEN_DEPLOYMENTS, tuple)
    assert isinstance(TOKEN_ALIASES, tuple)
    with pytest.raises(AttributeError):
        TOKEN_DEPLOYMENTS.append(None)  # type: ignore[attr-defined]

    listed = list_token_deployments()
    assert listed
    listed_entry = next(iter(listed))
    assert listed_entry is get_token_deployment(listed_entry.deployment_id)
    with pytest.raises(AttributeError):
        listed_entry.symbol = "MUTATED"  # type: ignore[misc]
    with pytest.raises(AttributeError):
        listed.append(None)  # type: ignore[attr-defined]


def test_catalog_lookups_are_offline() -> None:
    # There is no client/configuration object involved in any catalog read.
    assert get_native_token_deployment(TokenChainIds.ETHEREUM_MAINNET) is not None
    assert list_token_deployments(TokenChainIds.SOLANA_MAINNET)
