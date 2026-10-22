//! Offline DEX deployment, pool, alias, and native-wrap lookups.
//!
//! The generated DEX records are emitted from the canonical registry. This
//! module contains only the package-facing lookup
//! logic; it never reads the network or exposes mutable catalog state.

use crate::generated::dex_catalog as generated;

pub use generated::{
    DEX_ALIASES, DEX_CATALOG_AS_OF_DATE, DEX_CATALOG_CONTENT_DIGEST, DEX_CATALOG_VERSION,
    DEX_CHAIN_IDS, DEX_DEPLOYMENTS, DexAlias, DexDeployment, NATIVE_WRAP_DEFINITIONS,
    NativeWrapDefinition, POOL_DEFINITIONS, PoolAdapter, PoolDefinition,
};

/// Chain identifier used by the DEX catalog.
pub type DexChainId = &'static str;

/// Generated chain-qualified DEX aliases.
pub use generated::dexes;

/// Generated chain-qualified pool aliases.
pub use generated::pools;

/// Optional filters for [`list_pool_definitions`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ListPoolDefinitionsOptions<'a> {
    /// Restrict results to one supported chain identifier.
    pub chain_id: Option<&'a str>,
    /// Restrict results to pools containing this token deployment.
    pub token_deployment_id: Option<&'a str>,
    /// Restrict results to one adapter kind.
    pub adapter_kind: Option<&'a str>,
}

/// Returns the DEX deployment with the exact opaque identifier.
#[must_use]
pub fn get_dex_deployment(dex_deployment_id: &str) -> Option<&'static DexDeployment> {
    DEX_DEPLOYMENTS
        .iter()
        .find(|deployment| deployment.dex_deployment_id == dex_deployment_id)
}

/// Returns the pool definition with the exact opaque identifier.
#[must_use]
pub fn get_pool_definition(pool_definition_id: &str) -> Option<&'static PoolDefinition> {
    POOL_DEFINITIONS
        .iter()
        .find(|pool| pool.pool_definition_id == pool_definition_id)
}

/// Finds one pool by chain-qualified address.
///
/// EVM addresses are required to be 20-byte hexadecimal text and are matched
/// case-insensitively. Solana addresses remain case-sensitive base58 text.
#[must_use]
pub fn find_pool_definition_by_address(
    chain_id: &str,
    address: &str,
) -> Option<&'static PoolDefinition> {
    if !is_known_chain(chain_id) || address.is_empty() {
        return None;
    }
    if is_evm_chain(chain_id) {
        if !is_evm_address(address) {
            return None;
        }
        POOL_DEFINITIONS
            .iter()
            .find(|pool| pool.chain_id == chain_id && pool.address.eq_ignore_ascii_case(address))
    } else {
        POOL_DEFINITIONS
            .iter()
            .find(|pool| pool.chain_id == chain_id && pool.address == address)
    }
}

/// Finds pools for an unordered token pair in stable pool-ID order.
#[must_use]
pub fn find_pool_definitions_by_pair(
    chain_id: &str,
    first_token_deployment_id: &str,
    second_token_deployment_id: &str,
) -> Vec<&'static PoolDefinition> {
    if !is_known_chain(chain_id)
        || first_token_deployment_id.is_empty()
        || second_token_deployment_id.is_empty()
        || first_token_deployment_id == second_token_deployment_id
    {
        return Vec::new();
    }
    let (wanted_left, wanted_right) =
        ordered_pair(first_token_deployment_id, second_token_deployment_id);
    let mut matches: Vec<_> = POOL_DEFINITIONS
        .iter()
        .filter(|pool| {
            if pool.chain_id != chain_id {
                return false;
            }
            let (left, right) = ordered_pair(pool.token0_deployment_id, pool.token1_deployment_id);
            left == wanted_left && right == wanted_right
        })
        .collect();
    matches.sort_unstable_by_key(|pool| pool.pool_definition_id);
    matches
}

/// Lists pool definitions using the exact optional filters.
///
/// Every lifecycle status remains visible. Unknown chain identifiers produce
/// an empty list, while omitted filters match every catalog record.
#[must_use]
pub fn list_pool_definitions(
    options: ListPoolDefinitionsOptions<'_>,
) -> Vec<&'static PoolDefinition> {
    if options.chain_id.is_some_and(|chain| !is_known_chain(chain)) {
        return Vec::new();
    }
    let mut matches: Vec<_> = POOL_DEFINITIONS
        .iter()
        .filter(|pool| {
            options.chain_id.is_none_or(|chain| pool.chain_id == chain)
                && options.token_deployment_id.is_none_or(|token| {
                    !token.is_empty()
                        && (pool.token0_deployment_id == token
                            || pool.token1_deployment_id == token)
                })
                && options
                    .adapter_kind
                    .is_none_or(|adapter| !adapter.is_empty() && pool.adapter.kind == adapter)
        })
        .collect();
    matches.sort_unstable_by_key(|pool| pool.pool_definition_id);
    matches
}

/// Returns the native-to-wrapped definition for an exact native deployment ID.
#[must_use]
pub fn get_native_wrap_definition(
    native_token_deployment_id: &str,
) -> Option<&'static NativeWrapDefinition> {
    NATIVE_WRAP_DEFINITIONS
        .iter()
        .find(|definition| definition.native_token_deployment_id == native_token_deployment_id)
}

fn is_known_chain(chain_id: &str) -> bool {
    DEX_CHAIN_IDS
        .iter()
        .any(|(_, candidate)| *candidate == chain_id)
}

fn is_evm_chain(chain_id: &str) -> bool {
    DEX_DEPLOYMENTS.iter().any(|deployment| {
        deployment.chain_id == chain_id && deployment.program_address.starts_with("0x")
    })
}

fn is_evm_address(address: &str) -> bool {
    let bytes = address.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(u8::is_ascii_hexdigit)
}

fn ordered_pair<'a>(left: &'a str, right: &'a str) -> (&'a str, &'a str) {
    if left <= right {
        (left, right)
    } else {
        (right, left)
    }
}
