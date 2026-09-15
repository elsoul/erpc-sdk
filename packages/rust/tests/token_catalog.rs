#![allow(missing_docs)]

use std::{env, fs, path::PathBuf};

use erpc_sdk::{
    TOKEN_ALIASES, TOKEN_ASSETS, TOKEN_CATALOG_AS_OF_DATE, TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION, TOKEN_DEPLOYMENTS, TokenRepresentationKind, TokenStandard, TokenStatus,
    find_token_deployment_by_address, find_token_deployments_by_symbol,
    get_native_token_deployment, get_token_asset, get_token_deployment, list_token_deployments,
    token_chain_ids, tokens,
};
use serde_json::Value;

#[test]
fn generated_records_round_trip_and_preserve_flattened_asset_fields() {
    assert!(!TOKEN_ASSETS.is_empty());
    assert!(!TOKEN_DEPLOYMENTS.is_empty());
    assert!(!TOKEN_ALIASES.is_empty());

    for asset in TOKEN_ASSETS {
        assert_eq!(get_token_asset(asset.asset_id), Some(asset));
    }

    for deployment in TOKEN_DEPLOYMENTS {
        assert_eq!(
            get_token_deployment(deployment.deployment_id),
            Some(deployment)
        );
        let asset = get_token_asset(deployment.asset_id).expect("deployment asset exists");
        assert_eq!(deployment.name, asset.name);
        assert_eq!(deployment.representation_kind, asset.representation_kind);
        assert_eq!(deployment.stable_currency, asset.stable_currency);
        assert_eq!(deployment.underlying_asset_id, asset.underlying_asset_id);
        assert_eq!(
            deployment.economic_reference_asset_id,
            asset.economic_reference_asset_id
        );

        if let Some(asset_id) = deployment.underlying_asset_id {
            assert!(get_token_asset(asset_id).is_some());
        }
        if let Some(asset_id) = deployment.economic_reference_asset_id {
            assert!(get_token_asset(asset_id).is_some());
        }
        if let Some(replacement_id) = deployment.replaced_by_deployment_id {
            assert!(get_token_deployment(replacement_id).is_some());
        }
        if let Some(address) = deployment.address {
            assert_eq!(
                find_token_deployment_by_address(deployment.chain_id, address)
                    .map(|record| record.deployment_id),
                Some(deployment.deployment_id)
            );
        }
    }

    for alias in TOKEN_ALIASES {
        assert_eq!(
            get_token_deployment(alias.deployment_id).map(|deployment| deployment.deployment_id),
            Some(alias.deployment_id)
        );
    }
}

#[test]
fn generated_metadata_and_aliases_are_static_and_usable() {
    assert!(!TOKEN_CATALOG_VERSION.is_empty());
    assert!(!TOKEN_CATALOG_AS_OF_DATE.is_empty());
    assert!(!TOKEN_CATALOG_CONTENT_DIGEST.is_empty());
    assert_eq!(
        tokens::ethereum::USDC,
        get_token_deployment(tokens::ethereum::USDC)
            .unwrap()
            .deployment_id
    );
    assert_eq!(
        tokens::solana::USDC,
        get_token_deployment(tokens::solana::USDC)
            .expect("Solana USDC alias")
            .deployment_id
    );
    assert_eq!(
        tokens::avalanche_c::USDC,
        get_token_deployment(tokens::avalanche_c::USDC)
            .expect("Avalanche USDC alias")
            .deployment_id
    );
}

#[test]
fn lookups_cover_ambiguous_symbols_addresses_lifecycle_and_standards() {
    let ethereum_eure = find_token_deployments_by_symbol(token_chain_ids::ETHEREUM_MAINNET, "EURe");
    assert_eq!(ethereum_eure.len(), 2, "EURe v1/v2 remains discoverable");
    let deployment_ids: Vec<_> = ethereum_eure
        .iter()
        .map(|deployment| deployment.deployment_id)
        .collect();
    let mut sorted_ids = deployment_ids.clone();
    sorted_ids.sort_unstable();
    assert_eq!(deployment_ids, sorted_ids);

    let eth_usdc = get_token_deployment(tokens::ethereum::USDC).expect("Ethereum USDC");
    let eth_address = eth_usdc.address.expect("ERC-20 address");
    let mixed_case: String = eth_address
        .char_indices()
        .map(|(index, character)| {
            if index >= 2 && character.is_ascii_alphabetic() {
                if index % 2 == 0 {
                    character.to_ascii_lowercase()
                } else {
                    character.to_ascii_uppercase()
                }
            } else {
                character
            }
        })
        .collect();
    assert_eq!(
        find_token_deployment_by_address(token_chain_ids::ETHEREUM_MAINNET, &mixed_case)
            .map(|deployment| deployment.deployment_id),
        Some(eth_usdc.deployment_id)
    );

    let sol_usdc = get_token_deployment(tokens::solana::USDC).expect("Solana USDC");
    let sol_address = sol_usdc.address.expect("SPL mint address");
    let mutated_sol_address = sol_address
        .chars()
        .map(|character| {
            if character.is_ascii_alphabetic() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect::<String>();
    if mutated_sol_address != sol_address {
        assert!(
            find_token_deployment_by_address(token_chain_ids::SOLANA_MAINNET, &mutated_sol_address)
                .is_none()
        );
    }

    let native = get_native_token_deployment(token_chain_ids::ETHEREUM_MAINNET)
        .expect("Ethereum native deployment");
    assert_eq!(native.standard, TokenStandard::Native);
    assert!(native.address.is_none());
    assert!(
        find_token_deployment_by_address(
            token_chain_ids::ETHEREUM_MAINNET,
            "0x0000000000000000000000000000000000000000"
        )
        .is_none()
    );

    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.representation_kind == TokenRepresentationKind::Wrapped)
    );
    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.representation_kind == TokenRepresentationKind::Bridged)
    );
    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.standard == TokenStandard::SplToken2022)
    );
    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.status == TokenStatus::Legacy)
    );
    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.status == TokenStatus::WindingDown)
    );
    assert!(
        TOKEN_DEPLOYMENTS
            .iter()
            .any(|deployment| deployment.status == TokenStatus::Retired)
    );

    let eurcv_eth = find_token_deployments_by_symbol(token_chain_ids::ETHEREUM_MAINNET, "EURCV");
    let eurcv_sol = find_token_deployments_by_symbol(token_chain_ids::SOLANA_MAINNET, "EURCV");
    assert_eq!(eurcv_eth.len(), 1);
    assert_eq!(eurcv_sol.len(), 1);
    assert_eq!(eurcv_eth[0].decimals, 18);
    assert_eq!(eurcv_sol[0].decimals, 2);
}

#[test]
fn list_filter_and_invalid_inputs_are_deterministic() {
    let all = list_token_deployments(None, None);
    assert_eq!(all.len(), TOKEN_DEPLOYMENTS.len());

    let usd = list_token_deployments(None, Some("USD"));
    assert!(!usd.is_empty());
    assert!(
        usd.iter()
            .all(|deployment| { deployment.stable_currency == Some("USD") })
    );
    let sol_eur = list_token_deployments(Some(token_chain_ids::SOLANA_MAINNET), Some("EUR"));
    assert!(!sol_eur.is_empty());
    assert!(
        sol_eur
            .iter()
            .all(|deployment| deployment.chain_id == token_chain_ids::SOLANA_MAINNET)
    );
    assert!(
        sol_eur
            .iter()
            .all(|deployment| deployment.stable_currency == Some("EUR"))
    );

    assert!(
        all.iter()
            .any(|deployment| deployment.status == TokenStatus::Active)
    );
    assert!(
        all.iter()
            .any(|deployment| deployment.status == TokenStatus::Legacy)
    );
    assert!(
        all.iter()
            .any(|deployment| deployment.status == TokenStatus::WindingDown)
    );
    assert!(
        all.iter()
            .any(|deployment| deployment.status == TokenStatus::Retired)
    );

    assert!(list_token_deployments(Some(""), None).is_empty());
    assert!(list_token_deployments(Some("eip155:999"), None).is_empty());
    assert!(list_token_deployments(None, Some("")).is_empty());
    assert!(list_token_deployments(None, Some("GBP")).is_empty());
    assert!(find_token_deployments_by_symbol("", "USDC").is_empty());
    assert!(find_token_deployments_by_symbol(token_chain_ids::ETHEREUM_MAINNET, "usdc").is_empty());
    assert!(get_token_asset("").is_none());
    assert!(get_token_deployment("").is_none());
    assert!(get_native_token_deployment("").is_none());
    assert!(find_token_deployment_by_address(token_chain_ids::ETHEREUM_MAINNET, "0x123").is_none());
    assert!(find_token_deployment_by_address(token_chain_ids::ETHEREUM_MAINNET, "").is_none());
    assert!(find_token_deployment_by_address("eip155:999", eth_zero_address()).is_none());
}

fn eth_zero_address() -> &'static str {
    "0x0000000000000000000000000000000000000000"
}

#[test]
fn shared_fixture_cases_are_present_and_bound_to_rust_coverage() {
    let Some(fixture) = read_shared_fixture() else {
        // A packaged crate intentionally has no dependency on the repository
        // registry. The fixture is consumed automatically from a checkout and
        // can be supplied explicitly through the environment for package QA.
        return;
    };

    assert_eq!(fixture["schemaVersion"], 1);
    let behavior_names = fixture["behavior"]
        .as_array()
        .expect("fixture behavior cases")
        .iter()
        .filter_map(|case| case["name"].as_str())
        .collect::<Vec<_>>();
    for expected in [
        "native-deployments-have-null-address",
        "evm-address-normalization",
        "solana-address-identity",
        "wrapped-and-token-2022-identity",
        "lifecycle-visibility",
        "offline-lookup",
    ] {
        assert!(
            behavior_names.contains(&expected),
            "shared fixture is missing {expected}"
        );
    }

    let invalid_names = fixture["invalidCases"]
        .as_array()
        .expect("fixture invalid cases")
        .iter()
        .filter_map(|case| case["name"].as_str())
        .collect::<Vec<_>>();
    for expected in [
        "unknown-chain",
        "uppercase-evm-address",
        "invalid-solana-address",
        "native-address",
        "alias-not-portable",
        "unknown-reference",
    ] {
        assert!(
            invalid_names.contains(&expected),
            "shared fixture is missing {expected}"
        );
    }
}

fn read_shared_fixture() -> Option<Value> {
    let path = env::var_os("ERPC_SDK_TOKEN_CATALOG_FIXTURE").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../registry/fixtures/token-catalog-cases.json")
        },
        PathBuf::from,
    );
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}
