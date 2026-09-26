from __future__ import annotations

import json
import os
import platform
import re
import sys
from pathlib import Path
from typing import Any

import pytest

from erpc_sdk import (
    TOKEN_ALIASES,
    TOKEN_ASSETS,
    TOKEN_CATALOG_AS_OF_DATE,
    TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION,
    TOKEN_CHAIN_IDS,
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
    TokenChainIds.BASE_MAINNET,
)


def test_generated_metadata_and_immutable_alias_groups() -> None:
    assert TOKEN_CATALOG_VERSION == "1.1.0"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", TOKEN_CATALOG_AS_OF_DATE)
    assert re.fullmatch(r"[0-9a-f]{64}", TOKEN_CATALOG_CONTENT_DIGEST)
    assert len(TOKEN_ASSETS) == 49
    assert len(TOKEN_DEPLOYMENTS) == 73
    assert len(TOKEN_ALIASES) == 73

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


def test_base_records_keep_ids_decimals_aliases_and_evm_lookup_normalization() -> None:
    base_chain = TokenChainIds.BASE_MAINNET
    base_eth = get_token_deployment(tokens.base.ETH)
    assert base_eth is not None
    assert base_eth.deployment_id == "deployment-0061"
    assert base_eth.asset_id == "asset-0001"
    assert base_eth.chain_id == base_chain
    assert base_eth.symbol == "ETH"
    assert base_eth.decimals == 18
    assert base_eth.standard == "native"
    assert base_eth.address is None
    assert get_native_token_deployment(base_chain) is base_eth

    base_usdc = get_token_deployment(tokens.base.USDC)
    assert base_usdc is not None
    assert base_usdc.deployment_id == "deployment-0062"
    assert base_usdc.asset_id == "asset-0007"
    assert base_usdc.chain_id == base_chain
    assert base_usdc.symbol == "USDC"
    assert base_usdc.decimals == 6
    assert base_usdc.standard == "erc20"
    assert base_usdc.address is not None
    base_usdc_address = base_usdc.address
    assert base_usdc_address == "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

    base_eurc = get_token_deployment(tokens.base.EURC)
    assert base_eurc is not None
    assert base_eurc.deployment_id == "deployment-0063"
    assert base_eurc.asset_id == "asset-0008"
    assert base_eurc.chain_id == base_chain
    assert base_eurc.symbol == "EURC"
    assert base_eurc.decimals == 6
    assert base_eurc.standard == "erc20"
    assert base_eurc.address == "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42"

    assert [deployment.deployment_id for deployment in list_token_deployments(base_chain)] == [
        "deployment-0061",
        "deployment-0062",
        "deployment-0063",
    ]
    assert [
        deployment.deployment_id
        for deployment in find_token_deployments_by_symbol(base_chain, "ETH")
    ] == ["deployment-0061"]
    assert [
        deployment.deployment_id
        for deployment in find_token_deployments_by_symbol(base_chain, "USDC")
    ] == ["deployment-0062"]
    assert [
        deployment.deployment_id
        for deployment in find_token_deployments_by_symbol(base_chain, "EURC")
    ] == ["deployment-0063"]

    for deployment in (base_usdc, base_eurc):
        assert deployment.address is not None
        mixed_case = "0x" + deployment.address[2:].swapcase()
        assert find_token_deployment_by_address(base_chain, mixed_case) is deployment

    assert find_token_deployment_by_address(base_chain, "0x" + "0" * 40) is None
    assert find_token_deployment_by_address(base_chain, "0x1234") is None
    assert find_token_deployment_by_address("eip155:999", base_usdc_address) is None
    assert (
        find_token_deployment_by_address(
            base_chain,
            "0X" + base_usdc_address[2:],
        )
        is None
    )
    assert find_token_deployment_by_address(base_chain, "deployment-0062") is None

    for alias in TOKEN_ALIASES:
        if alias.namespace == "base":
            assert get_token_deployment(alias.deployment_id) is not None


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


def _runtime_asset(asset: Any) -> dict[str, Any]:
    return {
        "assetId": asset.asset_id,
        "name": asset.name,
        "representationKind": asset.representation_kind,
        "stableCurrency": asset.stable_currency,
        "underlyingAssetId": asset.underlying_asset_id,
        "economicReferenceAssetId": asset.economic_reference_asset_id,
    }


def _runtime_deployment(deployment: Any) -> dict[str, Any]:
    return {
        "deploymentId": deployment.deployment_id,
        "assetId": deployment.asset_id,
        "name": deployment.name,
        "representationKind": deployment.representation_kind,
        "stableCurrency": deployment.stable_currency,
        "underlyingAssetId": deployment.underlying_asset_id,
        "economicReferenceAssetId": deployment.economic_reference_asset_id,
        "chainId": deployment.chain_id,
        "symbol": deployment.symbol,
        "decimals": deployment.decimals,
        "standard": deployment.standard,
        "address": deployment.address,
        "status": deployment.status,
        "replacedByDeploymentId": deployment.replaced_by_deployment_id,
    }


def _runtime_alias(alias: Any) -> dict[str, Any]:
    return {
        "namespace": alias.namespace,
        "name": alias.name,
        "deploymentId": alias.deployment_id,
    }


def _deployment_ids(deployments: tuple[Any, ...]) -> list[str]:
    return sorted(deployment.deployment_id for deployment in deployments)


def _catalog_capture_behavior() -> dict[str, list[dict[str, Any]]]:
    behavior: dict[str, list[dict[str, Any]]] = {
        "lookupAsset": [
            {
                "input": asset.asset_id,
                "result": found.asset_id if (found := get_token_asset(asset.asset_id)) else None,
            }
            for asset in TOKEN_ASSETS
        ],
        "lookupDeployment": [
            {
                "input": deployment.deployment_id,
                "result": (
                    found.deployment_id
                    if (found := get_token_deployment(deployment.deployment_id))
                    else None
                ),
            }
            for deployment in TOKEN_DEPLOYMENTS
        ],
        "nativeDeployment": [
            {
                "chainId": chain_id,
                "result": (
                    found.deployment_id
                    if (found := get_native_token_deployment(chain_id))
                    else None
                ),
            }
            for chain_id in TOKEN_CHAIN_IDS.values()
        ],
        "symbol": [],
        "address": [],
        "alias": [
            {
                "namespace": alias.namespace,
                "name": alias.name,
                "result": (
                    found.deployment_id
                    if (
                        found := next(
                            (
                                candidate
                                for candidate in TOKEN_ALIASES
                                if candidate.namespace == alias.namespace
                                and candidate.name == alias.name
                            ),
                            None,
                        )
                    )
                    else None
                ),
            }
            for alias in TOKEN_ALIASES
        ],
        "list": [],
    }
    behavior["lookupAsset"].append({"input": "__unknown_asset__", "result": None})
    behavior["lookupDeployment"].append({"input": "__unknown_deployment__", "result": None})
    behavior["nativeDeployment"].append({"chainId": "unknown:chain", "result": None})

    symbol_keys = sorted(
        {(deployment.chain_id, deployment.symbol) for deployment in TOKEN_DEPLOYMENTS}
    )
    behavior["symbol"].extend(
        {
            "chainId": chain_id,
            "symbol": symbol,
            "result": _deployment_ids(find_token_deployments_by_symbol(chain_id, symbol)),
        }
        for chain_id, symbol in symbol_keys
    )
    behavior["symbol"].extend(
        [
            {
                "chainId": TokenChainIds.ETHEREUM_MAINNET,
                "symbol": "__unknown_symbol__",
                "result": [],
            },
            {"chainId": "unknown:chain", "symbol": "USDC", "result": []},
        ]
    )

    for deployment in TOKEN_DEPLOYMENTS:
        if deployment.address is None:
            continue
        behavior["address"].append(
            {
                "chainId": deployment.chain_id,
                "address": deployment.address,
                "result": (
                    found.deployment_id
                    if (
                        found := find_token_deployment_by_address(
                            deployment.chain_id, deployment.address
                        )
                    )
                    else None
                ),
            }
        )
        if deployment.chain_id in {
            TokenChainIds.ETHEREUM_MAINNET,
            TokenChainIds.AVALANCHE_C_MAINNET,
            TokenChainIds.BASE_MAINNET,
        }:
            uppercase = "0x" + deployment.address[2:].upper()
            behavior["address"].append(
                {
                    "chainId": deployment.chain_id,
                    "address": uppercase,
                    "result": (
                        found.deployment_id
                        if (
                            found := find_token_deployment_by_address(
                                deployment.chain_id, uppercase
                            )
                        )
                        else None
                    ),
                }
            )
    behavior["address"].extend(
        [
            {
                "chainId": TokenChainIds.ETHEREUM_MAINNET,
                "address": "0x" + "0" * 40,
                "result": None,
            },
            {
                "chainId": TokenChainIds.ETHEREUM_MAINNET,
                "address": "not-an-address",
                "result": None,
            },
            {
                "chainId": TokenChainIds.SOLANA_MAINNET,
                "address": "not-a-solana-address",
                "result": None,
            },
            {
                "chainId": "unknown:chain",
                "address": "0x0000000000000000000000000000000000000001",
                "result": None,
            },
        ]
    )

    list_inputs: list[tuple[str | None, str | None]] = [(None, None)]
    list_inputs.extend((chain_id, None) for chain_id in TOKEN_CHAIN_IDS.values())
    list_inputs.extend((None, currency) for currency in ("USD", "EUR", "JPY"))
    list_inputs.extend(
        [
            (TokenChainIds.ETHEREUM_MAINNET, "USD"),
            (TokenChainIds.SOLANA_MAINNET, "EUR"),
            ("unknown:chain", None),
            (None, "unknown"),
        ]
    )
    behavior["list"] = [
        {
            "chainId": chain_id,
            "stableCurrency": stable_currency,
            "result": _deployment_ids(list_token_deployments(chain_id, stable_currency)),
        }
        for chain_id, stable_currency in list_inputs
    ]
    behavior["alias"].extend(
        [
            {"namespace": "ethereum", "name": "__UNKNOWN_ALIAS__", "result": None},
            {"namespace": "unknown", "name": "USDC", "result": None},
        ]
    )
    return behavior


def test_captures_native_token_catalog_parity_from_the_installed_wheel_when_requested() -> None:
    output_path = os.environ.get("ERPC_SDK_TOKEN_CATALOG_PARITY_OUTPUT")
    if not output_path:
        return

    import erpc_sdk

    package_path = Path(erpc_sdk.__file__).resolve()
    workspace_package = Path(__file__).resolve().parents[1] / "src" / "erpc_sdk"
    runtime_root = Path(sys.prefix).resolve()
    if package_path.parent == workspace_package or runtime_root not in package_path.parents:
        pytest.fail(
            "ERPC_SDK_TOKEN_CATALOG_PARITY_OUTPUT requires an installed wheel; "
            "run python -I -m pytest --import-mode=importlib packages/python/tests "
            f"(loaded {package_path})"
        )

    snapshot = {
        "snapshotVersion": 1,
        "snapshotKind": "native-runtime",
        "language": "python",
        "runtime": (
            f"python-installed-wheel-{platform.python_implementation()}-"
            f"{platform.python_version()}-{sys.implementation.name}"
        ),
        "metadata": {
            "version": erpc_sdk.TOKEN_CATALOG_VERSION,
            "asOfDate": erpc_sdk.TOKEN_CATALOG_AS_OF_DATE,
            "contentDigest": erpc_sdk.TOKEN_CATALOG_CONTENT_DIGEST,
            "chainIds": dict(erpc_sdk.TOKEN_CHAIN_IDS),
        },
        "assets": [_runtime_asset(asset) for asset in erpc_sdk.TOKEN_ASSETS],
        "deployments": [
            _runtime_deployment(deployment) for deployment in erpc_sdk.TOKEN_DEPLOYMENTS
        ],
        "aliases": [_runtime_alias(alias) for alias in erpc_sdk.TOKEN_ALIASES],
        "behavior": _catalog_capture_behavior(),
    }
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(snapshot, indent=2) + "\n")
    assert destination.stat().st_size > 0
