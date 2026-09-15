#![allow(missing_docs)]

use erpc_sdk::{
    DEX_ALIASES, DEX_CATALOG_CONTENT_DIGEST, DEX_CHAIN_IDS, DEX_DEPLOYMENTS,
    ListPoolDefinitionsOptions, NATIVE_WRAP_DEFINITIONS, POOL_DEFINITIONS, dexes,
    find_pool_definition_by_address, find_pool_definitions_by_pair, get_dex_deployment,
    get_native_wrap_definition, get_pool_definition, list_pool_definitions, pools,
};

#[test]
fn generated_records_and_aliases_round_trip() {
    assert_eq!(DEX_DEPLOYMENTS.len(), 4);
    assert_eq!(POOL_DEFINITIONS.len(), 4);
    assert_eq!(NATIVE_WRAP_DEFINITIONS.len(), 3);
    assert_eq!(DEX_ALIASES.len(), 8);
    assert_eq!(DEX_CATALOG_CONTENT_DIGEST.len(), 64);

    assert_eq!(dexes::ethereum::UNISWAP_V2, "dex-deployment-0001");
    assert_eq!(pools::ethereum::UNISWAP_V2_USDC_WETH, "pool-0001");
    assert_eq!(dexes::avalanche_c::LFJ_LEGACY, "dex-deployment-0002");
    assert_eq!(pools::avalanche_c::LFJ_LEGACY_WAVAX_USDC, "pool-0002");
    assert_eq!(dexes::solana::ORCA_WHIRLPOOLS, "dex-deployment-0003");
    assert_eq!(pools::solana::ORCA_WHIRLPOOLS_WSOL_EURC, "pool-0003");

    for deployment in DEX_DEPLOYMENTS {
        assert_eq!(
            get_dex_deployment(deployment.dex_deployment_id),
            Some(deployment)
        );
    }
    for pool in POOL_DEFINITIONS {
        assert_eq!(get_pool_definition(pool.pool_definition_id), Some(pool));
    }
    for wrap in NATIVE_WRAP_DEFINITIONS {
        assert_eq!(
            get_native_wrap_definition(wrap.native_token_deployment_id),
            Some(wrap)
        );
    }
}

#[test]
fn address_pair_and_filter_lookups_are_deterministic() {
    let ethereum = DEX_CHAIN_IDS
        .iter()
        .find(|(name, _)| *name == "ethereum")
        .map(|(_, chain)| *chain)
        .expect("ethereum chain");
    let solana = DEX_CHAIN_IDS
        .iter()
        .find(|(name, _)| *name == "solana")
        .map(|(_, chain)| *chain)
        .expect("solana chain");

    assert_eq!(
        find_pool_definition_by_address(ethereum, "0xB4E16D0168E52D35CACD2C6185B44281EC28C9DC")
            .map(|pool| pool.pool_definition_id),
        Some("pool-0001")
    );
    assert!(find_pool_definition_by_address(ethereum, "0xnot-an-address").is_none());
    assert!(find_pool_definition_by_address("unknown:chain", "not-an-address").is_none());

    let reverse = find_pool_definitions_by_pair(ethereum, "deployment-0008", "deployment-0002");
    assert_eq!(
        reverse
            .iter()
            .map(|pool| pool.pool_definition_id)
            .collect::<Vec<_>>(),
        vec!["pool-0001"]
    );
    let solana_pair = find_pool_definitions_by_pair(solana, "deployment-0013", "deployment-0006");
    assert_eq!(
        solana_pair
            .iter()
            .map(|pool| pool.pool_definition_id)
            .collect::<Vec<_>>(),
        vec!["pool-0003", "pool-0004"]
    );
    assert!(
        find_pool_definitions_by_pair(ethereum, "deployment-0002", "deployment-0002").is_empty()
    );

    let filtered = list_pool_definitions(ListPoolDefinitionsOptions {
        chain_id: Some(solana),
        token_deployment_id: Some("deployment-0006"),
        adapter_kind: None,
    });
    assert_eq!(
        filtered
            .iter()
            .map(|pool| pool.pool_definition_id)
            .collect::<Vec<_>>(),
        vec!["pool-0003", "pool-0004"]
    );
    assert!(
        list_pool_definitions(ListPoolDefinitionsOptions {
            chain_id: Some("unknown:chain"),
            ..Default::default()
        })
        .is_empty()
    );
}
