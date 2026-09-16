//! Offline token ranking snapshot lookups.
//!
//! Ranking rows are generated from the canonical registry and exposed as
//! immutable static values. Lookups never access the network, client
//! configuration, API keys, or the current clock.

use crate::generated::token_rankings as generated;

pub use generated::{
    TOKEN_RANKINGS, TOKEN_RANKINGS_AS_OF, TOKEN_RANKINGS_CONTENT_DIGEST, TOKEN_RANKINGS_COVERAGE,
    TOKEN_RANKINGS_METADATA, TOKEN_RANKINGS_METRIC, TOKEN_RANKINGS_SCHEMA_VERSION,
    TOKEN_RANKINGS_SOURCE_IDS, TOKEN_RANKINGS_STATUS, TokenRanking, TokenRankingCoverage,
    TokenRankingMetadata,
};

/// Returns the bundled rankings for an exact chain identifier.
///
/// Rankings are an offline snapshot. Empty, unknown, and special string
/// inputs are safe immutable empty results; no aliases or network lookups are
/// inferred.
#[must_use]
pub fn list_token_rankings(chain_id: &str) -> Vec<&'static TokenRanking> {
    if chain_id.is_empty() {
        return Vec::new();
    }

    TOKEN_RANKINGS
        .iter()
        .filter(|ranking| ranking.chain_id == chain_id)
        .collect()
}
