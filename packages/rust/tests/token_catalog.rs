#![allow(missing_docs)]

use std::{collections::BTreeSet, env, fs, path::PathBuf};

use erpc_sdk::{
    TOKEN_ALIASES, TOKEN_ASSETS, TOKEN_CATALOG_AS_OF_DATE, TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION, TOKEN_CHAIN_IDS, TOKEN_DEPLOYMENTS, TokenAlias, TokenAsset,
    TokenDeployment, TokenRepresentationKind, TokenStandard, TokenStatus,
    find_token_deployment_by_address, find_token_deployments_by_symbol,
    get_native_token_deployment, get_token_asset, get_token_deployment, list_token_deployments,
    token_chain_ids, tokens,
};
use serde_json::{Map, Value, json};

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
    assert_eq!(
        tokens::base::ETH,
        get_token_deployment(tokens::base::ETH)
            .expect("Base ETH alias")
            .deployment_id
    );
    assert_eq!(
        tokens::base::USDC,
        get_token_deployment(tokens::base::USDC)
            .expect("Base USDC alias")
            .deployment_id
    );
    assert_eq!(
        tokens::base::EURC,
        get_token_deployment(tokens::base::EURC)
            .expect("Base EURC alias")
            .deployment_id
    );
}

#[test]
#[allow(clippy::too_many_lines)]
fn lookups_cover_ambiguous_symbols_addresses_lifecycle_and_standards() {
    let ethereum_eure = find_token_deployments_by_symbol(token_chain_ids::ETHEREUM_MAINNET, "EURe");
    assert!(ethereum_eure.len() >= 2, "EURe v1/v2 remains discoverable");
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
    let eurcv_eth = eurcv_eth
        .iter()
        .find(|deployment| deployment.deployment_id == tokens::ethereum::EURCV)
        .expect("Ethereum EURCV sentinel");
    let eurcv_sol = eurcv_sol
        .iter()
        .find(|deployment| deployment.deployment_id == tokens::solana::EURCV)
        .expect("Solana EURCV sentinel");
    assert_eq!(eurcv_eth.decimals, 18);
    assert_eq!(eurcv_sol.decimals, 2);
}

#[test]
fn base_records_keep_ids_decimals_aliases_and_evm_lookup_normalization() {
    let base_chain = token_chain_ids::BASE_MAINNET;
    let base_eth = get_token_deployment(tokens::base::ETH).expect("Base ETH deployment");
    assert_eq!(base_eth.deployment_id, "deployment-0061");
    assert_eq!(base_eth.asset_id, "asset-0001");
    assert_eq!(base_eth.chain_id, base_chain);
    assert_eq!(base_eth.symbol, "ETH");
    assert_eq!(base_eth.decimals, 18);
    assert_eq!(base_eth.standard, TokenStandard::Native);
    assert!(base_eth.address.is_none());
    assert_eq!(get_native_token_deployment(base_chain), Some(base_eth));

    let base_usdc = get_token_deployment(tokens::base::USDC).expect("Base USDC deployment");
    assert_eq!(base_usdc.deployment_id, "deployment-0062");
    assert_eq!(base_usdc.asset_id, "asset-0007");
    assert_eq!(base_usdc.chain_id, base_chain);
    assert_eq!(base_usdc.symbol, "USDC");
    assert_eq!(base_usdc.decimals, 6);
    assert_eq!(base_usdc.standard, TokenStandard::Erc20);
    assert_eq!(
        base_usdc.address,
        Some("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
    );

    let base_eurc = get_token_deployment(tokens::base::EURC).expect("Base EURC deployment");
    assert_eq!(base_eurc.deployment_id, "deployment-0063");
    assert_eq!(base_eurc.asset_id, "asset-0008");
    assert_eq!(base_eurc.chain_id, base_chain);
    assert_eq!(base_eurc.symbol, "EURC");
    assert_eq!(base_eurc.decimals, 6);
    assert_eq!(base_eurc.standard, TokenStandard::Erc20);
    assert_eq!(
        base_eurc.address,
        Some("0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42")
    );

    for alias in TOKEN_ALIASES
        .iter()
        .filter(|alias| alias.namespace == "base")
    {
        assert_eq!(
            get_token_deployment(alias.deployment_id).map(|deployment| deployment.deployment_id),
            Some(alias.deployment_id)
        );
    }
    assert_eq!(
        find_token_deployments_by_symbol(base_chain, "ETH"),
        vec![base_eth]
    );
    assert_eq!(
        find_token_deployments_by_symbol(base_chain, "USDC"),
        vec![base_usdc]
    );
    assert_eq!(
        find_token_deployments_by_symbol(base_chain, "EURC"),
        vec![base_eurc]
    );

    for deployment in [base_usdc, base_eurc] {
        let address = deployment.address.expect("Base ERC-20 address");
        let mixed_case: String = address
            .char_indices()
            .map(|(index, character)| {
                if index >= 2 && character.is_ascii_alphabetic() {
                    if index % 2 == 0 {
                        character.to_ascii_uppercase()
                    } else {
                        character.to_ascii_lowercase()
                    }
                } else {
                    character
                }
            })
            .collect();
        assert_eq!(
            find_token_deployment_by_address(base_chain, &mixed_case)
                .map(|found| found.deployment_id),
            Some(deployment.deployment_id)
        );
    }
    assert!(
        find_token_deployment_by_address(base_chain, base_eth.address.unwrap_or_default())
            .is_none()
    );
    assert!(find_token_deployment_by_address(base_chain, eth_zero_address()).is_none());
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

fn representation_kind_name(kind: TokenRepresentationKind) -> &'static str {
    match kind {
        TokenRepresentationKind::Native => "native",
        TokenRepresentationKind::Issued => "issued",
        TokenRepresentationKind::Wrapped => "wrapped",
        TokenRepresentationKind::Bridged => "bridged",
        TokenRepresentationKind::Unclassified => "unclassified",
    }
}

fn standard_name(standard: TokenStandard) -> &'static str {
    match standard {
        TokenStandard::Native => "native",
        TokenStandard::Erc20 => "erc20",
        TokenStandard::SplToken => "spl-token",
        TokenStandard::SplToken2022 => "spl-token-2022",
    }
}

fn status_name(status: TokenStatus) -> &'static str {
    match status {
        TokenStatus::Active => "active",
        TokenStatus::Legacy => "legacy",
        TokenStatus::WindingDown => "winding-down",
        TokenStatus::Retired => "retired",
    }
}

fn runtime_asset(asset: &TokenAsset) -> Value {
    json!({
        "assetId": asset.asset_id,
        "name": asset.name,
        "representationKind": representation_kind_name(asset.representation_kind),
        "stableCurrency": asset.stable_currency,
        "underlyingAssetId": asset.underlying_asset_id,
        "economicReferenceAssetId": asset.economic_reference_asset_id,
    })
}

fn runtime_deployment(deployment: &TokenDeployment) -> Value {
    json!({
        "deploymentId": deployment.deployment_id,
        "assetId": deployment.asset_id,
        "name": deployment.name,
        "representationKind": representation_kind_name(deployment.representation_kind),
        "stableCurrency": deployment.stable_currency,
        "underlyingAssetId": deployment.underlying_asset_id,
        "economicReferenceAssetId": deployment.economic_reference_asset_id,
        "chainId": deployment.chain_id,
        "symbol": deployment.symbol,
        "decimals": deployment.decimals,
        "standard": standard_name(deployment.standard),
        "address": deployment.address,
        "status": status_name(deployment.status),
        "replacedByDeploymentId": deployment.replaced_by_deployment_id,
    })
}

fn runtime_alias(alias: &TokenAlias) -> Value {
    json!({
        "namespace": alias.namespace,
        "name": alias.name,
        "deploymentId": alias.deployment_id,
    })
}

fn deployment_ids<'a>(deployments: impl IntoIterator<Item = &'a TokenDeployment>) -> Value {
    let mut ids = deployments
        .into_iter()
        .map(|deployment| deployment.deployment_id)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    json!(ids)
}

fn is_evm_chain_for_capture(chain_id: &str) -> bool {
    matches!(
        chain_id,
        token_chain_ids::ETHEREUM_MAINNET
            | token_chain_ids::AVALANCHE_C_MAINNET
            | token_chain_ids::BASE_MAINNET
    )
}

fn uppercase_evm_address(address: &str) -> String {
    format!(
        "0x{}",
        address
            .strip_prefix("0x")
            .unwrap_or_default()
            .to_uppercase()
    )
}

#[allow(clippy::too_many_lines)]
fn token_catalog_capture_behavior() -> Value {
    let mut behavior = Map::new();

    let mut lookup_assets = TOKEN_ASSETS
        .iter()
        .map(|asset| {
            json!({
                "input": asset.asset_id,
                "result": get_token_asset(asset.asset_id).map(|found| found.asset_id),
            })
        })
        .collect::<Vec<_>>();
    lookup_assets.push(json!({
        "input": "__unknown_asset__",
        "result": Value::Null,
    }));
    behavior.insert("lookupAsset".to_owned(), Value::Array(lookup_assets));

    let mut lookup_deployments = TOKEN_DEPLOYMENTS
        .iter()
        .map(|deployment| {
            json!({
                "input": deployment.deployment_id,
                "result": get_token_deployment(deployment.deployment_id)
                    .map(|found| found.deployment_id),
            })
        })
        .collect::<Vec<_>>();
    lookup_deployments.push(json!({
        "input": "__unknown_deployment__",
        "result": Value::Null,
    }));
    behavior.insert(
        "lookupDeployment".to_owned(),
        Value::Array(lookup_deployments),
    );

    let mut native_deployments = TOKEN_CHAIN_IDS
        .iter()
        .map(|(_, chain_id)| {
            json!({
                "chainId": chain_id,
                "result": get_native_token_deployment(chain_id)
                    .map(|deployment| deployment.deployment_id),
            })
        })
        .collect::<Vec<_>>();
    native_deployments.push(json!({
        "chainId": "unknown:chain",
        "result": Value::Null,
    }));
    behavior.insert(
        "nativeDeployment".to_owned(),
        Value::Array(native_deployments),
    );

    let symbol_keys = TOKEN_DEPLOYMENTS
        .iter()
        .map(|deployment| (deployment.chain_id, deployment.symbol))
        .collect::<BTreeSet<_>>();
    let mut symbols = symbol_keys
        .into_iter()
        .map(|(chain_id, symbol)| {
            json!({
                "chainId": chain_id,
                "symbol": symbol,
                "result": deployment_ids(find_token_deployments_by_symbol(chain_id, symbol)),
            })
        })
        .collect::<Vec<_>>();
    symbols.push(json!({
        "chainId": token_chain_ids::ETHEREUM_MAINNET,
        "symbol": "__unknown_symbol__",
        "result": [],
    }));
    symbols.push(json!({
        "chainId": "unknown:chain",
        "symbol": "USDC",
        "result": [],
    }));
    behavior.insert("symbol".to_owned(), Value::Array(symbols));

    let mut addresses = Vec::new();
    for deployment in TOKEN_DEPLOYMENTS {
        let Some(address) = deployment.address else {
            continue;
        };
        addresses.push(json!({
            "chainId": deployment.chain_id,
            "address": address,
            "result": find_token_deployment_by_address(deployment.chain_id, address)
                .map(|found| found.deployment_id),
        }));
        if is_evm_chain_for_capture(deployment.chain_id) {
            let uppercase = uppercase_evm_address(address);
            addresses.push(json!({
                "chainId": deployment.chain_id,
                "address": uppercase,
                "result": find_token_deployment_by_address(deployment.chain_id, &uppercase)
                    .map(|found| found.deployment_id),
            }));
        }
    }
    addresses.extend([
        json!({
            "chainId": token_chain_ids::ETHEREUM_MAINNET,
            "address": eth_zero_address(),
            "result": Value::Null,
        }),
        json!({
            "chainId": token_chain_ids::ETHEREUM_MAINNET,
            "address": "not-an-address",
            "result": Value::Null,
        }),
        json!({
            "chainId": token_chain_ids::SOLANA_MAINNET,
            "address": "not-a-solana-address",
            "result": Value::Null,
        }),
        json!({
            "chainId": "unknown:chain",
            "address": "0x0000000000000000000000000000000000000001",
            "result": Value::Null,
        }),
    ]);
    behavior.insert("address".to_owned(), Value::Array(addresses));

    let mut aliases = TOKEN_ALIASES
        .iter()
        .map(|alias| {
            json!({
                "namespace": alias.namespace,
                "name": alias.name,
                "result": TOKEN_ALIASES
                    .iter()
                    .find(|candidate| {
                        candidate.namespace == alias.namespace && candidate.name == alias.name
                    })
                    .map(|found| found.deployment_id),
            })
        })
        .collect::<Vec<_>>();
    aliases.extend([
        json!({
            "namespace": "ethereum",
            "name": "__UNKNOWN_ALIAS__",
            "result": Value::Null,
        }),
        json!({
            "namespace": "unknown",
            "name": "USDC",
            "result": Value::Null,
        }),
    ]);
    behavior.insert("alias".to_owned(), Value::Array(aliases));

    let mut list_inputs = vec![(None, None)];
    list_inputs.extend(
        TOKEN_CHAIN_IDS
            .iter()
            .map(|(_, chain_id)| (Some(*chain_id), None)),
    );
    list_inputs.extend(
        [("USD"), ("EUR"), ("JPY")]
            .into_iter()
            .map(|currency| (None, Some(currency))),
    );
    list_inputs.extend([
        (Some(token_chain_ids::ETHEREUM_MAINNET), Some("USD")),
        (Some(token_chain_ids::SOLANA_MAINNET), Some("EUR")),
        (Some("unknown:chain"), None),
        (None, Some("unknown")),
    ]);
    let lists = list_inputs
        .into_iter()
        .map(|(chain_id, stable_currency)| {
            json!({
                "chainId": chain_id,
                "stableCurrency": stable_currency,
                "result": deployment_ids(list_token_deployments(chain_id, stable_currency)),
            })
        })
        .collect::<Vec<_>>();
    behavior.insert("list".to_owned(), Value::Array(lists));

    Value::Object(behavior)
}

#[test]
#[allow(clippy::too_many_lines)]
fn captures_native_token_catalog_parity_when_requested() {
    let Some(output) = env::var_os("ERPC_SDK_TOKEN_CATALOG_PARITY_OUTPUT") else {
        return;
    };

    let chain_ids = TOKEN_CHAIN_IDS
        .iter()
        .map(|(name, chain_id)| ((*name).to_owned(), json!(chain_id)))
        .collect::<Map<_, _>>();
    let snapshot = json!({
        "snapshotVersion": 1,
        "snapshotKind": "native-runtime",
        "language": "rust",
        "runtime": format!("rust-cargo-test-erpc-sdk-{}", env!("CARGO_PKG_VERSION")),
        "metadata": {
            "version": TOKEN_CATALOG_VERSION,
            "asOfDate": TOKEN_CATALOG_AS_OF_DATE,
            "contentDigest": TOKEN_CATALOG_CONTENT_DIGEST,
            "chainIds": chain_ids,
        },
        "assets": TOKEN_ASSETS.iter().map(runtime_asset).collect::<Vec<_>>(),
        "deployments": TOKEN_DEPLOYMENTS.iter().map(runtime_deployment).collect::<Vec<_>>(),
        "aliases": TOKEN_ALIASES.iter().map(runtime_alias).collect::<Vec<_>>(),
        "behavior": token_catalog_capture_behavior(),
    });

    let output = PathBuf::from(output);
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).expect("token catalog parity output directory");
    }
    let mut encoded =
        serde_json::to_vec_pretty(&snapshot).expect("token catalog snapshot serializes");
    encoded.push(b'\n');
    fs::write(output, encoded).expect("token catalog parity snapshot write");
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
