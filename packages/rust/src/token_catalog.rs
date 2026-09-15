//! Offline token and deployment catalog lookups.
//!
//! Records are generated from the canonical registry and exposed as static
//! values. Lookup functions only inspect those values and never access the
//! network, client configuration, or an API key.

use crate::generated::token_catalog as generated;

pub use generated::{
    TOKEN_ALIASES, TOKEN_ASSETS, TOKEN_CATALOG_AS_OF_DATE, TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION, TOKEN_CHAIN_IDS, TOKEN_DEPLOYMENTS, TokenAlias, TokenAsset,
    TokenChainId, TokenDeployment, TokenRepresentationKind, TokenStandard, TokenStatus,
};

pub use generated::{token_chain_ids, tokens};

/// Returns the canonical asset identified by `asset_id`.
#[must_use]
pub fn get_token_asset(asset_id: &str) -> Option<&'static TokenAsset> {
    TOKEN_ASSETS.iter().find(|asset| asset.asset_id == asset_id)
}

/// Returns the canonical deployment identified by `deployment_id`.
#[must_use]
pub fn get_token_deployment(deployment_id: &str) -> Option<&'static TokenDeployment> {
    TOKEN_DEPLOYMENTS
        .iter()
        .find(|deployment| deployment.deployment_id == deployment_id)
}

/// Lists deployments, optionally restricted to a chain and stable currency.
///
/// Every lifecycle status is included. A supplied stable currency is matched
/// exactly against the canonical `USD`, `EUR`, or `JPY` value; unknown values
/// therefore produce an empty result.
#[must_use]
pub fn list_token_deployments(
    chain_id: Option<&str>,
    stable_currency: Option<&str>,
) -> Vec<&'static TokenDeployment> {
    if chain_id.is_some_and(|chain| !is_known_chain_id(chain))
        || stable_currency.is_some_and(|currency| !is_known_stable_currency(currency))
    {
        return Vec::new();
    }

    TOKEN_DEPLOYMENTS
        .iter()
        .filter(|deployment| {
            chain_id.is_none_or(|chain| deployment.chain_id == chain)
                && stable_currency
                    .is_none_or(|currency| deployment.stable_currency == Some(currency))
        })
        .collect()
}

/// Finds all exact-case symbol matches on `chain_id`, ordered by deployment ID.
#[must_use]
pub fn find_token_deployments_by_symbol(
    chain_id: &str,
    symbol: &str,
) -> Vec<&'static TokenDeployment> {
    if !is_known_chain_id(chain_id) || symbol.is_empty() {
        return Vec::new();
    }

    let mut matches: Vec<_> = TOKEN_DEPLOYMENTS
        .iter()
        .filter(|deployment| deployment.chain_id == chain_id && deployment.symbol == symbol)
        .collect();
    matches.sort_unstable_by_key(|deployment| deployment.deployment_id);
    matches
}

/// Finds a deployment by a chain-qualified address.
///
/// EVM addresses must be exactly `0x` followed by 40 ASCII hexadecimal
/// characters and are compared case-insensitively. Solana addresses are
/// compared exactly. Native deployments have no address and are never
/// selected by this function.
#[must_use]
pub fn find_token_deployment_by_address(
    chain_id: &str,
    address: &str,
) -> Option<&'static TokenDeployment> {
    if address.is_empty() || !is_known_chain_id(chain_id) {
        return None;
    }

    let valid_address = if is_evm_chain_id(chain_id) {
        is_valid_evm_address(address)
    } else {
        true
    };
    if !valid_address || (is_evm_chain_id(chain_id) && is_zero_evm_address(address)) {
        return None;
    }

    TOKEN_DEPLOYMENTS.iter().find(|deployment| {
        deployment.chain_id == chain_id
            && deployment.address.is_some_and(|candidate| {
                if is_evm_chain_id(chain_id) {
                    candidate.eq_ignore_ascii_case(address)
                } else {
                    candidate == address
                }
            })
    })
}

/// Returns the native deployment for a known chain.
#[must_use]
pub fn get_native_token_deployment(chain_id: &str) -> Option<&'static TokenDeployment> {
    if !is_known_chain_id(chain_id) {
        return None;
    }

    TOKEN_DEPLOYMENTS.iter().find(|deployment| {
        deployment.chain_id == chain_id
            && deployment.standard == TokenStandard::Native
            && deployment.address.is_none()
    })
}

fn is_known_chain_id(chain_id: &str) -> bool {
    matches!(
        chain_id,
        token_chain_ids::ETHEREUM_MAINNET
            | token_chain_ids::SOLANA_MAINNET
            | token_chain_ids::AVALANCHE_C_MAINNET
    )
}

fn is_evm_chain_id(chain_id: &str) -> bool {
    matches!(
        chain_id,
        token_chain_ids::ETHEREUM_MAINNET | token_chain_ids::AVALANCHE_C_MAINNET
    )
}

fn is_known_stable_currency(currency: &str) -> bool {
    matches!(currency, "USD" | "EUR" | "JPY")
}

fn is_valid_evm_address(address: &str) -> bool {
    let bytes = address.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(u8::is_ascii_hexdigit)
}

fn is_zero_evm_address(address: &str) -> bool {
    is_valid_evm_address(address) && address[2..].bytes().all(|byte| byte == b'0')
}
