#![allow(missing_docs)]

use erpc_sdk::{
    DEX_ALIASES, DEX_CATALOG_CONTENT_DIGEST, DEX_CHAIN_IDS, DEX_DEPLOYMENTS,
    ListPoolDefinitionsOptions, NATIVE_WRAP_DEFINITIONS, POOL_DEFINITIONS, dexes,
    find_pool_definition_by_address, find_pool_definitions_by_pair, get_dex_deployment,
    get_native_wrap_definition, get_pool_definition, list_pool_definitions, pools, tokens,
};

#[test]
fn generated_records_and_aliases_round_trip() {
    assert!(!DEX_DEPLOYMENTS.is_empty());
    assert!(!POOL_DEFINITIONS.is_empty());
    assert!(!NATIVE_WRAP_DEFINITIONS.is_empty());
    assert!(!DEX_ALIASES.is_empty());
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

    let reverse =
        find_pool_definitions_by_pair(ethereum, tokens::ethereum::USDC, tokens::ethereum::WETH);
    assert!(
        reverse
            .iter()
            .any(|pool| pool.pool_definition_id == pools::ethereum::UNISWAP_V2_USDC_WETH)
    );
    let solana_pair =
        find_pool_definitions_by_pair(solana, tokens::solana::EURC, tokens::solana::WSOL);
    assert!(
        solana_pair
            .iter()
            .any(|pool| pool.pool_definition_id == pools::solana::ORCA_WHIRLPOOLS_WSOL_EURC)
    );
    assert!(
        solana_pair
            .iter()
            .any(|pool| pool.pool_definition_id == pools::solana::RAYDIUM_CLMM_WSOL_EURC)
    );
    assert!(
        find_pool_definitions_by_pair(ethereum, tokens::ethereum::WETH, tokens::ethereum::WETH)
            .is_empty()
    );

    let filtered = list_pool_definitions(ListPoolDefinitionsOptions {
        chain_id: Some(solana),
        token_deployment_id: Some(tokens::solana::WSOL),
        adapter_kind: None,
    });
    assert!(
        filtered
            .iter()
            .any(|pool| pool.pool_definition_id == pools::solana::ORCA_WHIRLPOOLS_WSOL_EURC)
    );
    assert!(
        filtered
            .iter()
            .any(|pool| pool.pool_definition_id == pools::solana::RAYDIUM_CLMM_WSOL_EURC)
    );
    assert!(filtered.iter().all(|pool| {
        pool.chain_id == solana
            && (pool.token0_deployment_id == tokens::solana::WSOL
                || pool.token1_deployment_id == tokens::solana::WSOL)
    }));
    assert!(
        list_pool_definitions(ListPoolDefinitionsOptions {
            chain_id: Some("unknown:chain"),
            ..Default::default()
        })
        .is_empty()
    );
}
