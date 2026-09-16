//! RPC-backed exact-input quotes for the catalogued EVM constant-product pools.
//!
//! The quote path owns request and response validation while delegating HTTP,
//! timeout, cancellation, and JSON-RPC error handling to the configured
//! [`crate::HttpJsonRpcTransport`]. Catalog records remain immutable and the
//! quote result contains only public, decimal-string quantities.

use std::{
    borrow::Borrow,
    error::Error,
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use num_bigint::BigUint;
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    ErpcError, HttpJsonRpcTransport, RequestOptions,
    dex_catalog::{
        DEX_CATALOG_CONTENT_DIGEST, DEX_CHAIN_IDS, DexDeployment, PoolDefinition,
        get_dex_deployment, get_pool_definition,
    },
    token_catalog::{
        TOKEN_CATALOG_CONTENT_DIGEST, TokenDeployment, TokenStandard, TokenStatus,
        get_token_deployment,
    },
};

const SUPPORTED_QUOTE_ADAPTER: &str = "evm-constant-product-v2";
const UINT256_DECIMAL_MAX_LENGTH: usize = 78;
const UINT112_MAX_BITS: u64 = 112;
const UINT32_MAX_BITS: u64 = 32;

const FACTORY_GET_PAIR_SELECTOR: &str = "0xe6a43905";
const PAIR_FACTORY_SELECTOR: &str = "0xc45a0155";
const PAIR_TOKEN0_SELECTOR: &str = "0x0dfe1681";
const PAIR_TOKEN1_SELECTOR: &str = "0xd21220a7";
const PAIR_GET_RESERVES_SELECTOR: &str = "0x0902f1ac";

#[derive(Clone, Copy)]
struct SupportedQuoteCapability {
    chain_id: &'static str,
    dex_deployment_id: &'static str,
    factory_address: &'static str,
    pool_definition_id: &'static str,
    pool_address: &'static str,
    token0_deployment_id: &'static str,
    token0_address: &'static str,
    token0_decimals: u8,
    token0_standard: TokenStandard,
    token1_deployment_id: &'static str,
    token1_address: &'static str,
    token1_decimals: u8,
    token1_standard: TokenStandard,
    adapter_kind: &'static str,
    fee_numerator: &'static str,
    fee_denominator: &'static str,
}

// Quote eligibility is a handwritten review boundary. Catalog growth may add
// lookup, monitoring, or ranking records without granting them RPC quote
// access.
const SUPPORTED_QUOTE_CAPABILITIES: &[SupportedQuoteCapability] = &[
    SupportedQuoteCapability {
        chain_id: "eip155:1",
        dex_deployment_id: "dex-deployment-0001",
        factory_address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
        pool_definition_id: "pool-0001",
        pool_address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
        token0_deployment_id: "deployment-0008",
        token0_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        token0_decimals: 6,
        token0_standard: TokenStandard::Erc20,
        token1_deployment_id: "deployment-0002",
        token1_address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        token1_decimals: 18,
        token1_standard: TokenStandard::Erc20,
        adapter_kind: SUPPORTED_QUOTE_ADAPTER,
        fee_numerator: "3",
        fee_denominator: "1000",
    },
    SupportedQuoteCapability {
        chain_id: "eip155:43114",
        dex_deployment_id: "dex-deployment-0002",
        factory_address: "0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
        pool_definition_id: "pool-0002",
        pool_address: "0xf4003f4efbe8691b60249e6afbd307abe7758adb",
        token0_deployment_id: "deployment-0004",
        token0_address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
        token0_decimals: 18,
        token0_standard: TokenStandard::Erc20,
        token1_deployment_id: "deployment-0009",
        token1_address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
        token1_decimals: 6,
        token1_standard: TokenStandard::Erc20,
        adapter_kind: SUPPORTED_QUOTE_ADAPTER,
        fee_numerator: "3",
        fee_denominator: "1000",
    },
];

/// Fixed domain error codes for exact-input quote validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwapQuoteErrorCode {
    /// The request shape, identifiers, amount, or freshness values are invalid.
    InvalidArgument,
    /// The requested chain is not represented by the DEX catalog.
    UnsupportedChain,
    /// The requested pool identifier is unknown.
    UnknownPool,
    /// The selected pool or token record is on another chain.
    ChainMismatch,
    /// A selected pool or DEX record is not active or otherwise valid.
    InvalidPoolState,
    /// An input or output token identifier is unknown.
    UnknownToken,
    /// A selected token record is not active.
    TokenNotActive,
    /// A selected token standard is outside the quote adapter boundary.
    UnsupportedTokenStandard,
    /// The selected token or pool is outside the reviewed quote capability.
    UnsupportedToken,
    /// The requested pair is not the selected pool pair.
    PoolTokenMismatch,
    /// The selected pool adapter cannot produce this quote.
    UnsupportedAdapter,
    /// The on-chain factory or pool program identity does not match the catalog.
    ProgramMismatch,
    /// The block snapshot is stale, inconsistent, or reorged.
    StateStale,
    /// The pool has no usable liquidity for the requested direction.
    InsufficientLiquidity,
    /// A checked uint256 calculation or fee configuration is invalid.
    Arithmetic,
}

impl SwapQuoteErrorCode {
    /// Stable spelling for [`Self::InvalidArgument`].
    pub const SWAP_INVALID_ARGUMENT: Self = Self::InvalidArgument;
    /// Stable spelling for [`Self::UnsupportedChain`].
    pub const SWAP_UNSUPPORTED_CHAIN: Self = Self::UnsupportedChain;
    /// Stable spelling for [`Self::UnknownPool`].
    pub const SWAP_UNKNOWN_POOL: Self = Self::UnknownPool;
    /// Stable spelling for [`Self::ChainMismatch`].
    pub const SWAP_CHAIN_MISMATCH: Self = Self::ChainMismatch;
    /// Stable spelling for [`Self::InvalidPoolState`].
    pub const SWAP_INVALID_POOL_STATE: Self = Self::InvalidPoolState;
    /// Stable spelling for [`Self::UnknownToken`].
    pub const SWAP_UNKNOWN_TOKEN: Self = Self::UnknownToken;
    /// Stable spelling for [`Self::TokenNotActive`].
    pub const SWAP_TOKEN_NOT_ACTIVE: Self = Self::TokenNotActive;
    /// Stable spelling for [`Self::UnsupportedTokenStandard`].
    pub const SWAP_UNSUPPORTED_TOKEN_STANDARD: Self = Self::UnsupportedTokenStandard;
    /// Stable spelling for [`Self::UnsupportedToken`].
    pub const SWAP_UNSUPPORTED_TOKEN: Self = Self::UnsupportedToken;
    /// Stable spelling for [`Self::PoolTokenMismatch`].
    pub const SWAP_POOL_TOKEN_MISMATCH: Self = Self::PoolTokenMismatch;
    /// Stable spelling for [`Self::UnsupportedAdapter`].
    pub const SWAP_UNSUPPORTED_ADAPTER: Self = Self::UnsupportedAdapter;
    /// Stable spelling for [`Self::ProgramMismatch`].
    pub const SWAP_PROGRAM_MISMATCH: Self = Self::ProgramMismatch;
    /// Stable spelling for [`Self::StateStale`].
    pub const SWAP_STATE_STALE: Self = Self::StateStale;
    /// Stable spelling for [`Self::InsufficientLiquidity`].
    pub const SWAP_INSUFFICIENT_LIQUIDITY: Self = Self::InsufficientLiquidity;
    /// Stable spelling for [`Self::Arithmetic`].
    pub const SWAP_ARITHMETIC: Self = Self::Arithmetic;

    /// Returns the stable wire/error code string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "SWAP_INVALID_ARGUMENT",
            Self::UnsupportedChain => "SWAP_UNSUPPORTED_CHAIN",
            Self::UnknownPool => "SWAP_UNKNOWN_POOL",
            Self::ChainMismatch => "SWAP_CHAIN_MISMATCH",
            Self::InvalidPoolState => "SWAP_INVALID_POOL_STATE",
            Self::UnknownToken => "SWAP_UNKNOWN_TOKEN",
            Self::TokenNotActive => "SWAP_TOKEN_NOT_ACTIVE",
            Self::UnsupportedTokenStandard => "SWAP_UNSUPPORTED_TOKEN_STANDARD",
            Self::UnsupportedToken => "SWAP_UNSUPPORTED_TOKEN",
            Self::PoolTokenMismatch => "SWAP_POOL_TOKEN_MISMATCH",
            Self::UnsupportedAdapter => "SWAP_UNSUPPORTED_ADAPTER",
            Self::ProgramMismatch => "SWAP_PROGRAM_MISMATCH",
            Self::StateStale => "SWAP_STATE_STALE",
            Self::InsufficientLiquidity => "SWAP_INSUFFICIENT_LIQUIDITY",
            Self::Arithmetic => "SWAP_ARITHMETIC",
        }
    }

    const fn message(self) -> &'static str {
        match self {
            Self::InvalidArgument => "Swap request is invalid",
            Self::UnsupportedChain => "Swap chain is unsupported",
            Self::UnknownPool => "Swap pool is unknown",
            Self::ChainMismatch => "Swap chain does not match the selected records",
            Self::InvalidPoolState => "Swap pool state is invalid",
            Self::UnknownToken => "Swap token is unknown",
            Self::TokenNotActive => "Swap token is not active",
            Self::UnsupportedTokenStandard => "Swap token standard is unsupported",
            Self::UnsupportedToken => "Swap token is unsupported for the selected pool",
            Self::PoolTokenMismatch => "Swap pool tokens do not match the request",
            Self::UnsupportedAdapter => "Swap adapter is unsupported",
            Self::ProgramMismatch => "Swap program does not match the selected records",
            Self::StateStale => "Swap pool state is stale",
            Self::InsufficientLiquidity => "Swap pool liquidity is insufficient",
            Self::Arithmetic => "Swap arithmetic overflowed or produced an invalid result",
        }
    }
}

impl fmt::Display for SwapQuoteErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Domain errors produced by quote validation, with upstream errors preserved.
#[derive(Debug)]
pub enum SwapQuoteError {
    /// A deterministic local quote-domain failure.
    Domain(SwapQuoteErrorCode),
    /// An existing transport, timeout, cancellation, or JSON-RPC error.
    Upstream(ErpcError),
}

impl SwapQuoteError {
    /// Returns the domain code, or `None` when an upstream error was preserved.
    #[must_use]
    pub const fn code(&self) -> Option<SwapQuoteErrorCode> {
        match self {
            Self::Domain(code) => Some(*code),
            Self::Upstream(_) => None,
        }
    }

    /// Returns the preserved upstream error when the quote failed in transport.
    #[must_use]
    pub const fn upstream(&self) -> Option<&ErpcError> {
        match self {
            Self::Domain(_) => None,
            Self::Upstream(error) => Some(error),
        }
    }

    /// Returns the stable code string for a domain error.
    #[must_use]
    pub const fn code_string(&self) -> Option<&'static str> {
        match self {
            Self::Domain(code) => Some(code.as_str()),
            Self::Upstream(_) => None,
        }
    }
}

impl fmt::Display for SwapQuoteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Domain(code) => formatter.write_str(code.message()),
            Self::Upstream(error) => error.fmt(formatter),
        }
    }
}

impl Error for SwapQuoteError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Domain(_) => None,
            Self::Upstream(error) => Some(error),
        }
    }
}

impl From<ErpcError> for SwapQuoteError {
    fn from(error: ErpcError) -> Self {
        Self::Upstream(error)
    }
}

/// Result type for the public swap quote client.
pub type SwapResult<T> = std::result::Result<T, SwapQuoteError>;

/// Freshness limits for an exact-input quote. Omitted fields use SDK defaults.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SwapFreshness {
    /// Maximum age of the snapshot and final latest block, in seconds (0–86400).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_block_age_seconds: Option<u64>,
    /// Maximum block distance between the initial and final latest headers (0–1024).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_block_lag: Option<u64>,
    /// Maximum tolerated future clock skew, in seconds (0–300).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_clock_skew_seconds: Option<u64>,
}

fn deserialize_non_null_u64<'de, D>(deserializer: D) -> std::result::Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<u64>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| D::Error::custom("freshness values must be integers when present"))
}

/// Exact-input quote request with the six contract fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExactInputQuoteRequest {
    /// Chain-qualified catalog identifier.
    pub chain_id: String,
    /// Opaque catalog pool identifier.
    pub pool_definition_id: String,
    /// Opaque input token deployment identifier.
    pub input_token_deployment_id: String,
    /// Opaque output token deployment identifier.
    pub output_token_deployment_id: String,
    /// Positive canonical decimal amount in base units.
    pub amount_in: String,
    /// Optional block freshness limits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<SwapFreshness>,
}

/// Alias for callers that prefer the swap-specific request name.
pub type SwapQuoteRequest = ExactInputQuoteRequest;

/// Exact-input quote result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExactInputQuoteResult {
    /// Quote contract discriminator.
    pub quote_kind: &'static str,
    /// Chain-qualified catalog identifier.
    pub chain_id: String,
    /// Opaque catalog pool identifier.
    pub pool_definition_id: String,
    /// Opaque catalog DEX identifier.
    pub dex_deployment_id: String,
    /// Catalog adapter kind.
    pub adapter_kind: String,
    /// Opaque input token deployment identifier.
    pub input_token_deployment_id: String,
    /// Opaque output token deployment identifier.
    pub output_token_deployment_id: String,
    /// Canonical decimal input amount.
    pub amount_in: String,
    /// Canonical decimal output amount.
    pub amount_out: String,
    /// Applied fee fraction.
    pub fee: QuoteFee,
    /// Block snapshot used for every pool read.
    pub snapshot: EvmBlockSnapshot,
    /// Token catalog content digest.
    pub token_catalog_digest: &'static str,
    /// DEX catalog content digest.
    pub dex_catalog_digest: &'static str,
}

/// Fee fraction included in an exact-input quote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct QuoteFee {
    /// Fee numerator.
    pub numerator: String,
    /// Fee denominator.
    pub denominator: String,
}

/// EVM block snapshot included in an exact-input quote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmBlockSnapshot {
    /// Snapshot kind discriminator.
    pub kind: &'static str,
    /// Decimal block number.
    pub block_number: String,
    /// Lowercase 32-byte block hash.
    pub block_hash: String,
    /// Decimal block timestamp.
    pub block_timestamp: String,
}

/// Configured RPC-backed swap client.
#[derive(Clone)]
pub struct SwapClient {
    ethereum: Arc<HttpJsonRpcTransport>,
    avalanche: Arc<HttpJsonRpcTransport>,
    #[cfg(test)]
    clock: Option<fn() -> u64>,
}

impl SwapClient {
    pub(crate) fn new(
        ethereum: Arc<HttpJsonRpcTransport>,
        avalanche: Arc<HttpJsonRpcTransport>,
    ) -> Self {
        Self {
            ethereum,
            avalanche,
            #[cfg(test)]
            clock: None,
        }
    }

    /// Executes an exact-input quote through the configured EVM transport.
    pub async fn quote_exact_input<R>(&self, request: R) -> SwapResult<ExactInputQuoteResult>
    where
        R: Borrow<ExactInputQuoteRequest>,
    {
        self.quote_exact_input_with(request.borrow(), None).await
    }

    /// Executes an exact-input quote while observing an optional cancellation token.
    pub async fn quote_exact_input_with<R>(
        &self,
        request: R,
        cancellation: Option<&CancellationToken>,
    ) -> SwapResult<ExactInputQuoteResult>
    where
        R: Borrow<ExactInputQuoteRequest>,
    {
        let request = request.borrow();
        let normalized = normalize_request(request)?;
        if normalized.pool.adapter.kind != SUPPORTED_QUOTE_ADAPTER
            || normalized.dex.adapter_kind != SUPPORTED_QUOTE_ADAPTER
        {
            return domain_error(SwapQuoteErrorCode::UnsupportedAdapter);
        }

        let transport = if normalized.pool.chain_id == chain_id("ethereum") {
            &self.ethereum
        } else if normalized.pool.chain_id == chain_id("avalancheC") {
            &self.avalanche
        } else {
            return domain_error(SwapQuoteErrorCode::UnsupportedAdapter);
        };
        let options = RequestOptions {
            cancellation: cancellation.cloned(),
        };
        let state = read_evm_state(transport, &normalized, &options, self).await?;
        assert_freshness(
            &state.initial,
            &state.latest_after_reads,
            &normalized.freshness,
            self,
        )?;
        let calculated = calculate_quote(&normalized, &state)?;
        Ok(quote_result(&normalized, &state, &calculated))
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = Some(clock);
        self
    }
}

#[derive(Clone)]
struct NormalizedFreshness {
    block_age_seconds: u64,
    block_lag: u64,
    clock_skew_seconds: u64,
}

struct NormalizedRequest {
    request: ExactInputQuoteRequest,
    amount_in: BigUint,
    pool: &'static PoolDefinition,
    dex: &'static DexDeployment,
    input: &'static TokenDeployment,
    output: &'static TokenDeployment,
    freshness: NormalizedFreshness,
}

#[derive(Clone)]
struct BlockHeader {
    number: BigUint,
    hash: String,
    timestamp: BigUint,
}

struct EvmState {
    initial: BlockHeader,
    latest_after_reads: BlockHeader,
    reserve0: BigUint,
    reserve1: BigUint,
}

#[derive(Debug)]
struct CalculatedQuote {
    amount_out: BigUint,
    fee_numerator: BigUint,
    fee_denominator: BigUint,
}

fn domain_error<T>(code: SwapQuoteErrorCode) -> SwapResult<T> {
    Err(SwapQuoteError::Domain(code))
}

fn normalize_request(request: &ExactInputQuoteRequest) -> SwapResult<NormalizedRequest> {
    for value in [
        request.chain_id.as_str(),
        request.pool_definition_id.as_str(),
        request.input_token_deployment_id.as_str(),
        request.output_token_deployment_id.as_str(),
        request.amount_in.as_str(),
    ] {
        if value.is_empty() || value.trim() != value {
            return domain_error(SwapQuoteErrorCode::InvalidArgument);
        }
    }
    for value in [
        request.pool_definition_id.as_str(),
        request.input_token_deployment_id.as_str(),
        request.output_token_deployment_id.as_str(),
    ] {
        if !is_opaque_id(value) {
            return domain_error(SwapQuoteErrorCode::InvalidArgument);
        }
    }
    let freshness = normalize_freshness(request.freshness.as_ref())?;
    let amount_in = parse_canonical_decimal(&request.amount_in, true)?;

    if !is_known_chain(&request.chain_id) {
        return domain_error(SwapQuoteErrorCode::UnsupportedChain);
    }
    let Some(pool) = get_pool_definition(&request.pool_definition_id) else {
        return domain_error(SwapQuoteErrorCode::UnknownPool);
    };
    if pool.chain_id != request.chain_id {
        return domain_error(SwapQuoteErrorCode::ChainMismatch);
    }
    if pool.status != "active" {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    let Some(dex) = get_dex_deployment(pool.dex_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    if dex.status != "active" {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }

    let Some(input) = get_token_deployment(&request.input_token_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::UnknownToken);
    };
    let Some(output) = get_token_deployment(&request.output_token_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::UnknownToken);
    };
    if input.chain_id != request.chain_id || output.chain_id != request.chain_id {
        return domain_error(SwapQuoteErrorCode::ChainMismatch);
    }
    for token in [input, output] {
        if token.status != TokenStatus::Active {
            return domain_error(SwapQuoteErrorCode::TokenNotActive);
        }
    }
    // Classic SPL records remain eligible for pair matching so lookup-only
    // Solana pools fail at the adapter gate without performing RPC.
    for token in [input, output] {
        if token.standard != TokenStandard::Erc20 && token.standard != TokenStandard::SplToken {
            return domain_error(SwapQuoteErrorCode::UnsupportedTokenStandard);
        }
    }
    if request.input_token_deployment_id == request.output_token_deployment_id {
        return domain_error(SwapQuoteErrorCode::PoolTokenMismatch);
    }
    let (wanted_left, wanted_right) = ordered_pair(
        &request.input_token_deployment_id,
        &request.output_token_deployment_id,
    );
    let (actual_left, actual_right) =
        ordered_pair(pool.token0_deployment_id, pool.token1_deployment_id);
    if wanted_left != actual_left || wanted_right != actual_right {
        return domain_error(SwapQuoteErrorCode::PoolTokenMismatch);
    }
    if pool.adapter.kind != SUPPORTED_QUOTE_ADAPTER || dex.adapter_kind != SUPPORTED_QUOTE_ADAPTER {
        return domain_error(SwapQuoteErrorCode::UnsupportedAdapter);
    }
    if input.standard != TokenStandard::Erc20 || output.standard != TokenStandard::Erc20 {
        return domain_error(SwapQuoteErrorCode::UnsupportedTokenStandard);
    }
    if !matches_supported_quote_capability(pool, dex, input, output) {
        return domain_error(SwapQuoteErrorCode::UnsupportedToken);
    }

    Ok(NormalizedRequest {
        request: request.clone(),
        amount_in,
        pool,
        dex,
        input,
        output,
        freshness,
    })
}

fn matches_supported_quote_capability(
    pool: &PoolDefinition,
    dex: &DexDeployment,
    input: &TokenDeployment,
    output: &TokenDeployment,
) -> bool {
    fn matches_token(
        token: &TokenDeployment,
        chain_id: &str,
        deployment_id: &str,
        address: &str,
        decimals: u8,
        standard: TokenStandard,
    ) -> bool {
        token.chain_id == chain_id
            && token.deployment_id == deployment_id
            && token.address == Some(address)
            && token.decimals == decimals
            && token.standard == standard
    }

    let Some(capability) = SUPPORTED_QUOTE_CAPABILITIES
        .iter()
        .find(|entry| entry.pool_definition_id == pool.pool_definition_id)
    else {
        return false;
    };

    if input.representation_kind == crate::token_catalog::TokenRepresentationKind::Unclassified
        || output.representation_kind == crate::token_catalog::TokenRepresentationKind::Unclassified
    {
        return false;
    }

    let matches_input = matches_token(
        input,
        capability.chain_id,
        capability.token0_deployment_id,
        capability.token0_address,
        capability.token0_decimals,
        capability.token0_standard,
    ) || matches_token(
        input,
        capability.chain_id,
        capability.token1_deployment_id,
        capability.token1_address,
        capability.token1_decimals,
        capability.token1_standard,
    );
    let matches_output = matches_token(
        output,
        capability.chain_id,
        capability.token0_deployment_id,
        capability.token0_address,
        capability.token0_decimals,
        capability.token0_standard,
    ) || matches_token(
        output,
        capability.chain_id,
        capability.token1_deployment_id,
        capability.token1_address,
        capability.token1_decimals,
        capability.token1_standard,
    );

    pool.chain_id == capability.chain_id
        && pool.dex_deployment_id == capability.dex_deployment_id
        && pool.address == capability.pool_address
        && pool.token0_deployment_id == capability.token0_deployment_id
        && pool.token1_deployment_id == capability.token1_deployment_id
        && pool.adapter.kind == capability.adapter_kind
        && pool.adapter.fee_numerator == Some(capability.fee_numerator)
        && pool.adapter.fee_denominator == Some(capability.fee_denominator)
        && dex.dex_deployment_id == capability.dex_deployment_id
        && dex.chain_id == capability.chain_id
        && dex.program_address == capability.factory_address
        && dex.adapter_kind == capability.adapter_kind
        && matches_input
        && matches_output
}

fn normalize_freshness(value: Option<&SwapFreshness>) -> SwapResult<NormalizedFreshness> {
    let defaults = (120, 3, 5);
    let values = (
        value
            .and_then(|freshness| freshness.max_block_age_seconds)
            .unwrap_or(defaults.0),
        value
            .and_then(|freshness| freshness.max_block_lag)
            .unwrap_or(defaults.1),
        value
            .and_then(|freshness| freshness.max_clock_skew_seconds)
            .unwrap_or(defaults.2),
    );
    if values.0 > 86_400 || values.1 > 1_024 || values.2 > 300 {
        return domain_error(SwapQuoteErrorCode::InvalidArgument);
    }
    Ok(NormalizedFreshness {
        block_age_seconds: values.0,
        block_lag: values.1,
        clock_skew_seconds: values.2,
    })
}

fn is_known_chain(chain_id: &str) -> bool {
    DEX_CHAIN_IDS
        .iter()
        .any(|(_, candidate)| *candidate == chain_id)
}

fn chain_id(name: &str) -> &'static str {
    DEX_CHAIN_IDS
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map_or("", |(_, value)| value)
}

fn is_opaque_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'))
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn ordered_pair<'a>(left: &'a str, right: &'a str) -> (&'a str, &'a str) {
    if left <= right {
        (left, right)
    } else {
        (right, left)
    }
}

fn ensure_uint256(value: BigUint, code: SwapQuoteErrorCode) -> SwapResult<BigUint> {
    if value.bits() > 256 {
        return domain_error(code);
    }
    Ok(value)
}

fn parse_canonical_decimal(value: &str, positive: bool) -> SwapResult<BigUint> {
    if value.is_empty()
        || value.len() > UINT256_DECIMAL_MAX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.as_bytes()[0] == b'0')
    {
        return domain_error(SwapQuoteErrorCode::InvalidArgument);
    }
    let Some(parsed) = BigUint::parse_bytes(value.as_bytes(), 10) else {
        return domain_error(SwapQuoteErrorCode::InvalidArgument);
    };
    if positive && parsed == BigUint::default() {
        return domain_error(SwapQuoteErrorCode::InvalidArgument);
    }
    ensure_uint256(parsed, SwapQuoteErrorCode::InvalidArgument)
}

fn parse_decimal_quantity(value: Option<&str>, code: SwapQuoteErrorCode) -> SwapResult<BigUint> {
    let Some(value) = value else {
        return domain_error(code);
    };
    if value.is_empty()
        || value.len() > UINT256_DECIMAL_MAX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.as_bytes()[0] == b'0')
    {
        return domain_error(code);
    }
    let Some(parsed) = BigUint::parse_bytes(value.as_bytes(), 10) else {
        return domain_error(code);
    };
    ensure_uint256(parsed, code)
}

fn parse_hex_quantity(value: &Value, code: SwapQuoteErrorCode) -> SwapResult<BigUint> {
    let Some(value) = value.as_str() else {
        return domain_error(code);
    };
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || bytes.len() > 66
        || bytes[0] != b'0'
        || bytes[1] != b'x'
        || !bytes[2..].iter().all(u8::is_ascii_hexdigit)
        || (bytes[2] == b'0' && bytes.len() > 3)
    {
        return domain_error(code);
    }
    let Some(parsed) = BigUint::parse_bytes(&bytes[2..], 16) else {
        return domain_error(code);
    };
    ensure_uint256(parsed, code)
}

fn parse_hex_bytes(
    value: &Value,
    expected_bytes: Option<usize>,
    code: SwapQuoteErrorCode,
) -> SwapResult<String> {
    let Some(value) = value.as_str() else {
        return domain_error(code);
    };
    let bytes = value.as_bytes();
    if bytes.len() < 2
        || bytes[0] != b'0'
        || bytes[1] != b'x'
        || !bytes[2..].iter().all(u8::is_ascii_hexdigit)
        || (bytes.len() - 2) % 2 != 0
        || expected_bytes.is_some_and(|expected| bytes.len() != expected * 2 + 2)
    {
        return domain_error(code);
    }
    Ok(value.to_ascii_lowercase())
}

fn parse_block_header(value: &Value) -> SwapResult<BlockHeader> {
    let Some(object) = value.as_object() else {
        return domain_error(SwapQuoteErrorCode::StateStale);
    };
    let number = parse_hex_quantity(
        object
            .get("number")
            .ok_or(SwapQuoteError::Domain(SwapQuoteErrorCode::StateStale))?,
        SwapQuoteErrorCode::StateStale,
    )?;
    let hash = parse_hex_bytes(
        object
            .get("hash")
            .ok_or(SwapQuoteError::Domain(SwapQuoteErrorCode::StateStale))?,
        Some(32),
        SwapQuoteErrorCode::StateStale,
    )?;
    let timestamp = parse_hex_quantity(
        object
            .get("timestamp")
            .ok_or(SwapQuoteError::Domain(SwapQuoteErrorCode::StateStale))?,
        SwapQuoteErrorCode::StateStale,
    )?;
    Ok(BlockHeader {
        number,
        hash,
        timestamp,
    })
}

fn parse_address_word(value: &Value) -> SwapResult<String> {
    let value = parse_hex_bytes(value, Some(32), SwapQuoteErrorCode::InvalidPoolState)?;
    let word = &value[2..];
    if !word[..24].bytes().all(|byte| byte == b'0') {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    Ok(format!("0x{}", &word[24..]))
}

fn parse_uint_word(value: &str, maximum_bits: u64) -> SwapResult<BigUint> {
    let parsed = BigUint::parse_bytes(value.as_bytes(), 16)
        .ok_or(SwapQuoteError::Domain(SwapQuoteErrorCode::InvalidPoolState))?;
    if parsed.bits() > maximum_bits {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    Ok(parsed)
}

fn parse_reserves(value: &Value) -> SwapResult<(BigUint, BigUint)> {
    let value = parse_hex_bytes(value, Some(96), SwapQuoteErrorCode::InvalidPoolState)?;
    let payload = &value[2..];
    let reserve0 = parse_uint_word(&payload[..64], UINT112_MAX_BITS)?;
    let reserve1 = parse_uint_word(&payload[64..128], UINT112_MAX_BITS)?;
    let _timestamp = parse_uint_word(&payload[128..192], UINT32_MAX_BITS)?;
    Ok((reserve0, reserve1))
}

fn rpc_selector(hash: &str) -> Value {
    json!({ "blockHash": hash, "requireCanonical": true })
}

fn abi_call(to: &str, data: &str) -> Value {
    json!({ "to": to, "data": data })
}

fn encode_address_argument(address: &str) -> SwapResult<String> {
    if !is_evm_address(address) {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    Ok(format!(
        "{}{}",
        "0".repeat(24),
        &address[2..].to_ascii_lowercase()
    ))
}

fn is_evm_address(address: &str) -> bool {
    let bytes = address.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(u8::is_ascii_hexdigit)
}

async fn rpc_request(
    transport: &HttpJsonRpcTransport,
    method: &str,
    params: Value,
    options: &RequestOptions,
) -> SwapResult<Value> {
    transport
        .request(method, Some(params), options)
        .await
        .map_err(SwapQuoteError::Upstream)
}

#[allow(clippy::too_many_lines)]
async fn read_evm_state(
    transport: &HttpJsonRpcTransport,
    normalized: &NormalizedRequest,
    options: &RequestOptions,
    client: &SwapClient,
) -> SwapResult<EvmState> {
    let chain_value = rpc_request(transport, "eth_chainId", json!([]), options).await?;
    let network_chain_id = parse_hex_quantity(&chain_value, SwapQuoteErrorCode::ChainMismatch)?;
    let expected_chain = if normalized.pool.chain_id == chain_id("ethereum") {
        1_u32
    } else {
        43_114_u32
    };
    if network_chain_id != BigUint::from(expected_chain) {
        return domain_error(SwapQuoteErrorCode::ChainMismatch);
    }

    let initial_value = rpc_request(
        transport,
        "eth_getBlockByNumber",
        json!(["latest", false]),
        options,
    )
    .await?;
    let initial = parse_block_header(&initial_value)?;
    let selector = rpc_selector(&initial.hash);

    // Keep these seven responses opaque until both final headers and freshness
    // checks pass. This gives stale/reorg errors precedence over malformed ABI.
    let factory_code_raw = rpc_request(
        transport,
        "eth_getCode",
        json!([normalized.dex.program_address, selector.clone()]),
        options,
    )
    .await?;
    let pool_code_raw = rpc_request(
        transport,
        "eth_getCode",
        json!([normalized.pool.address, selector.clone()]),
        options,
    )
    .await?;
    let Some(token0) = get_token_deployment(normalized.pool.token0_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    let Some(token1) = get_token_deployment(normalized.pool.token1_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    let (Some(token0_address), Some(token1_address)) = (token0.address, token1.address) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    let pair_data = format!(
        "{}{}{}",
        FACTORY_GET_PAIR_SELECTOR,
        encode_address_argument(token0_address)?,
        encode_address_argument(token1_address)?,
    );
    let factory_pair_raw = rpc_request(
        transport,
        "eth_call",
        json!([
            abi_call(normalized.dex.program_address, &pair_data),
            selector.clone()
        ]),
        options,
    )
    .await?;
    let pair_factory_raw = rpc_request(
        transport,
        "eth_call",
        json!([
            abi_call(normalized.pool.address, PAIR_FACTORY_SELECTOR),
            selector.clone()
        ]),
        options,
    )
    .await?;
    let pair_token0_raw = rpc_request(
        transport,
        "eth_call",
        json!([
            abi_call(normalized.pool.address, PAIR_TOKEN0_SELECTOR),
            selector.clone()
        ]),
        options,
    )
    .await?;
    let pair_token1_raw = rpc_request(
        transport,
        "eth_call",
        json!([
            abi_call(normalized.pool.address, PAIR_TOKEN1_SELECTOR),
            selector.clone()
        ]),
        options,
    )
    .await?;
    let reserves_raw = rpc_request(
        transport,
        "eth_call",
        json!([
            abi_call(normalized.pool.address, PAIR_GET_RESERVES_SELECTOR),
            selector
        ]),
        options,
    )
    .await?;

    let latest_after_reads_value = rpc_request(
        transport,
        "eth_getBlockByNumber",
        json!(["latest", false]),
        options,
    )
    .await?;
    let latest_after_reads = parse_block_header(&latest_after_reads_value)?;
    let block_number = format!("0x{}", initial.number.to_str_radix(16));
    let reread_value = rpc_request(
        transport,
        "eth_getBlockByNumber",
        json!([block_number, false]),
        options,
    )
    .await?;
    let reread = parse_block_header(&reread_value)?;
    if reread.number != initial.number
        || reread.hash != initial.hash
        || reread.timestamp != initial.timestamp
    {
        return domain_error(SwapQuoteErrorCode::StateStale);
    }

    // Freshness and reorg checks run while all seven state responses are still
    // opaque. This preserves deterministic stale precedence over malformed ABI.
    assert_freshness(&initial, &latest_after_reads, &normalized.freshness, client)?;

    // ABI decoding deliberately starts only after the final header checks.
    let factory_code = parse_hex_bytes(
        &factory_code_raw,
        None,
        SwapQuoteErrorCode::InvalidPoolState,
    )?;
    if factory_code.len() <= 2 {
        return domain_error(SwapQuoteErrorCode::ProgramMismatch);
    }
    let pool_code = parse_hex_bytes(&pool_code_raw, None, SwapQuoteErrorCode::InvalidPoolState)?;
    if pool_code.len() <= 2 {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    let factory_pair = parse_address_word(&factory_pair_raw)?;
    if !factory_pair.eq_ignore_ascii_case(normalized.pool.address) {
        return domain_error(SwapQuoteErrorCode::ProgramMismatch);
    }
    let pair_factory = parse_address_word(&pair_factory_raw)?;
    if !pair_factory.eq_ignore_ascii_case(normalized.dex.program_address) {
        return domain_error(SwapQuoteErrorCode::ProgramMismatch);
    }
    let pair_token0 = parse_address_word(&pair_token0_raw)?;
    let pair_token1 = parse_address_word(&pair_token1_raw)?;
    if !pair_token0.eq_ignore_ascii_case(token0_address)
        || !pair_token1.eq_ignore_ascii_case(token1_address)
    {
        return domain_error(SwapQuoteErrorCode::PoolTokenMismatch);
    }
    let (reserve0, reserve1) = parse_reserves(&reserves_raw)?;
    Ok(EvmState {
        initial,
        latest_after_reads,
        reserve0,
        reserve1,
    })
}

#[cfg(test)]
fn now_seconds(client: &SwapClient) -> SwapResult<u64> {
    if let Some(clock) = client.clock {
        return Ok(clock());
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| SwapQuoteError::Domain(SwapQuoteErrorCode::InvalidArgument))
}

#[cfg(not(test))]
fn now_seconds(_client: &SwapClient) -> SwapResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| SwapQuoteError::Domain(SwapQuoteErrorCode::InvalidArgument))
}

fn assert_freshness(
    initial: &BlockHeader,
    latest_after_reads: &BlockHeader,
    freshness: &NormalizedFreshness,
    client: &SwapClient,
) -> SwapResult<()> {
    let now = BigUint::from(now_seconds(client)?);
    let skew = BigUint::from(freshness.clock_skew_seconds);
    let max_age = BigUint::from(freshness.block_age_seconds);
    for timestamp in [&initial.timestamp, &latest_after_reads.timestamp] {
        if *timestamp > now.clone() + skew.clone()
            || (now > *timestamp && now.clone() - timestamp > max_age)
        {
            return domain_error(SwapQuoteErrorCode::StateStale);
        }
    }
    let max_lag = BigUint::from(freshness.block_lag);
    if latest_after_reads.number < initial.number
        || latest_after_reads.number.clone() - &initial.number > max_lag
    {
        return domain_error(SwapQuoteErrorCode::StateStale);
    }
    if latest_after_reads.number == initial.number && latest_after_reads.hash != initial.hash {
        return domain_error(SwapQuoteErrorCode::StateStale);
    }
    if latest_after_reads.number > initial.number
        && latest_after_reads.timestamp < initial.timestamp
    {
        return domain_error(SwapQuoteErrorCode::StateStale);
    }
    if latest_after_reads.number == initial.number
        && latest_after_reads.hash == initial.hash
        && latest_after_reads.timestamp != initial.timestamp
    {
        return domain_error(SwapQuoteErrorCode::StateStale);
    }
    Ok(())
}

fn calculate_quote(
    normalized: &NormalizedRequest,
    state: &EvmState,
) -> SwapResult<CalculatedQuote> {
    let fee_numerator = parse_decimal_quantity(
        normalized.pool.adapter.fee_numerator,
        SwapQuoteErrorCode::Arithmetic,
    )?;
    let fee_denominator = parse_decimal_quantity(
        normalized.pool.adapter.fee_denominator,
        SwapQuoteErrorCode::Arithmetic,
    )?;
    if fee_denominator <= fee_numerator {
        return domain_error(SwapQuoteErrorCode::Arithmetic);
    }
    let Some(token0) = get_token_deployment(normalized.pool.token0_deployment_id) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    let (Some(token0_address), Some(input_address), Some(output_address)) = (
        token0.address,
        normalized.input.address,
        normalized.output.address,
    ) else {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    };
    let input_is_token0 = input_address.eq_ignore_ascii_case(token0_address);
    let output_is_token0 = output_address.eq_ignore_ascii_case(token0_address);
    if input_is_token0 == output_is_token0 {
        return domain_error(SwapQuoteErrorCode::InvalidPoolState);
    }
    let (reserve_in, reserve_out) = if input_is_token0 {
        (&state.reserve0, &state.reserve1)
    } else {
        (&state.reserve1, &state.reserve0)
    };
    if reserve_in == &BigUint::default() || reserve_out == &BigUint::default() {
        return domain_error(SwapQuoteErrorCode::InsufficientLiquidity);
    }

    let fee_factor = &fee_denominator - &fee_numerator;
    let adjusted = ensure_uint256(
        normalized.amount_in.clone() * &fee_factor,
        SwapQuoteErrorCode::Arithmetic,
    )?;
    let reserve_product = ensure_uint256(
        reserve_in.clone() * &fee_denominator,
        SwapQuoteErrorCode::Arithmetic,
    )?;
    let denominator = ensure_uint256(reserve_product + &adjusted, SwapQuoteErrorCode::Arithmetic)?;
    if denominator == BigUint::default() {
        return domain_error(SwapQuoteErrorCode::Arithmetic);
    }
    let numerator = ensure_uint256(
        adjusted.clone() * reserve_out,
        SwapQuoteErrorCode::Arithmetic,
    )?;
    let amount_out = ensure_uint256(numerator / denominator, SwapQuoteErrorCode::Arithmetic)?;
    if amount_out == BigUint::default() || amount_out > *reserve_out {
        return domain_error(SwapQuoteErrorCode::InsufficientLiquidity);
    }
    Ok(CalculatedQuote {
        amount_out,
        fee_numerator,
        fee_denominator,
    })
}

fn quote_result(
    normalized: &NormalizedRequest,
    state: &EvmState,
    calculated: &CalculatedQuote,
) -> ExactInputQuoteResult {
    ExactInputQuoteResult {
        quote_kind: "exact-input",
        chain_id: normalized.request.chain_id.clone(),
        pool_definition_id: normalized.request.pool_definition_id.clone(),
        dex_deployment_id: normalized.pool.dex_deployment_id.to_owned(),
        adapter_kind: normalized.pool.adapter.kind.to_owned(),
        input_token_deployment_id: normalized.request.input_token_deployment_id.clone(),
        output_token_deployment_id: normalized.request.output_token_deployment_id.clone(),
        amount_in: normalized.amount_in.to_str_radix(10),
        amount_out: calculated.amount_out.to_str_radix(10),
        fee: QuoteFee {
            numerator: calculated.fee_numerator.to_str_radix(10),
            denominator: calculated.fee_denominator.to_str_radix(10),
        },
        snapshot: EvmBlockSnapshot {
            kind: "evm-block",
            block_number: state.initial.number.to_str_radix(10),
            block_hash: state.initial.hash.clone(),
            block_timestamp: state.initial.timestamp.to_str_radix(10),
        },
        token_catalog_digest: TOKEN_CATALOG_CONTENT_DIGEST,
        dex_catalog_digest: DEX_CATALOG_CONTENT_DIGEST,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, env, fs, path::Path, time::Duration};

    use serde_json::{Map, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
    };

    use crate::{
        dex_catalog::{
            DEX_ALIASES, DEX_CATALOG_AS_OF_DATE, DEX_CATALOG_VERSION, DEX_DEPLOYMENTS, DexAlias,
            ListPoolDefinitionsOptions, NATIVE_WRAP_DEFINITIONS, NativeWrapDefinition,
            POOL_DEFINITIONS, find_pool_definition_by_address, find_pool_definitions_by_pair,
            get_dex_deployment, get_native_wrap_definition, get_pool_definition,
            list_pool_definitions,
        },
        token_catalog::{
            TOKEN_CHAIN_IDS, TOKEN_DEPLOYMENTS, TokenRepresentationKind, TokenStandard,
        },
    };

    #[test]
    fn canonical_amount_parser_accepts_large_uint256_text() {
        let value = parse_canonical_decimal("9007199254740993", true).expect("valid amount");
        assert_eq!(value.to_str_radix(10), "9007199254740993");
        assert!(
            parse_canonical_decimal(
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                true
            )
            .is_ok()
        );
        assert!(parse_canonical_decimal("01", true).is_err());
        assert!(parse_canonical_decimal("0", true).is_err());
    }

    #[test]
    fn freshness_deserialization_distinguishes_omitted_and_null_values() {
        let omitted: SwapFreshness = serde_json::from_str("{}").expect("omitted defaults");
        assert_eq!(omitted, SwapFreshness::default());
        assert!(serde_json::from_str::<SwapFreshness>(r#"{"maxBlockAgeSeconds":null}"#).is_err());
    }

    #[test]
    fn abi_words_require_exact_padding_and_width() {
        let address = json!(format!("0x{}", "00".repeat(12) + &"11".repeat(20)));
        assert_eq!(
            parse_address_word(&address).unwrap(),
            format!("0x{}", "11".repeat(20))
        );
        let malformed = json!(format!("0x{}01", "00".repeat(12) + &"11".repeat(20)));
        assert!(parse_address_word(&malformed).is_err());
    }

    #[test]
    fn quote_math_checks_each_uint256_intermediate() {
        let amount = BigUint::from(1_u32);
        let reserve = BigUint::from(1_u32);
        let normalized = NormalizedRequest {
            request: ExactInputQuoteRequest {
                chain_id: chain_id("ethereum").to_owned(),
                pool_definition_id: "pool-0001".to_owned(),
                input_token_deployment_id: "deployment-0002".to_owned(),
                output_token_deployment_id: "deployment-0008".to_owned(),
                amount_in: "1".to_owned(),
                freshness: None,
            },
            amount_in: amount.clone(),
            pool: get_pool_definition("pool-0001").unwrap(),
            dex: get_dex_deployment("dex-deployment-0001").unwrap(),
            input: get_token_deployment("deployment-0002").unwrap(),
            output: get_token_deployment("deployment-0008").unwrap(),
            freshness: NormalizedFreshness {
                block_age_seconds: 120,
                block_lag: 3,
                clock_skew_seconds: 5,
            },
        };
        let state = EvmState {
            initial: BlockHeader {
                number: BigUint::from(1_u32),
                hash: format!("0x{}", "11".repeat(32)),
                timestamp: BigUint::from(1_u32),
            },
            latest_after_reads: BlockHeader {
                number: BigUint::from(1_u32),
                hash: format!("0x{}", "11".repeat(32)),
                timestamp: BigUint::from(1_u32),
            },
            reserve0: reserve.clone(),
            reserve1: reserve,
        };
        assert_eq!(
            calculate_quote(&normalized, &state).unwrap_err().code(),
            Some(SwapQuoteErrorCode::InsufficientLiquidity)
        );
        let overflow = parse_canonical_decimal(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            true,
        )
        .unwrap();
        let mut overflow_normalized = normalized;
        overflow_normalized.amount_in = overflow;
        assert_eq!(
            calculate_quote(&overflow_normalized, &state)
                .unwrap_err()
                .code(),
            Some(SwapQuoteErrorCode::Arithmetic)
        );
    }

    #[test]
    fn quote_capability_requires_the_exact_reviewed_tuple() {
        let pool = get_pool_definition("pool-0001").expect("Ethereum seed pool");
        let dex = get_dex_deployment("dex-deployment-0001").expect("Ethereum seed DEX");
        let input = get_token_deployment("deployment-0002").expect("WETH");
        let output = get_token_deployment("deployment-0008").expect("USDC");
        assert!(matches_supported_quote_capability(pool, dex, input, output));

        let mut unclassified = *input;
        unclassified.representation_kind = TokenRepresentationKind::Unclassified;
        assert!(!matches_supported_quote_capability(
            pool,
            dex,
            &unclassified,
            output
        ));

        let mut rebound = *output;
        rebound.address = Some("0x0000000000000000000000000000000000000001");
        assert!(!matches_supported_quote_capability(
            pool, dex, input, &rebound
        ));
    }

    fn fixture_value(file_name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("registry/fixtures")
            .join(file_name);
        let source = fs::read_to_string(&path).expect("workspace fixture is readable");
        serde_json::from_str(&source).expect("workspace fixture is valid JSON")
    }

    fn fixed_fixture_clock() -> u64 {
        1_789_498_700
    }

    async fn read_http_json(stream: &mut TcpStream) -> Option<Value> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..count]);
            let header_end = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
            let body_start = header_end + 4;
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let body_length = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })?;
            if bytes.len() < body_start + body_length {
                continue;
            }
            return serde_json::from_slice(&bytes[body_start..body_start + body_length]).ok();
        }
    }

    async fn write_http_json(stream: &mut TcpStream, body: &Value) {
        let body = serde_json::to_vec(body).expect("fixture response serializes");
        let headers = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(headers.as_bytes())
            .await
            .expect("fixture response headers write");
        stream
            .write_all(&body)
            .await
            .expect("fixture response body write");
    }

    async fn start_fixture_server(responses: Vec<Value>) -> (String, JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture listener");
        let address = listener.local_addr().expect("fixture listener address");
        let expected_count = responses.len();
        let handle = tokio::spawn(async move {
            let mut captured = Vec::with_capacity(expected_count);
            while captured.len() < expected_count {
                let (mut stream, _) = listener.accept().await.expect("fixture connection");
                let Some(request) = read_http_json(&mut stream).await else {
                    continue;
                };
                let index = captured.len();
                let id = request.get("id").cloned().unwrap_or_else(|| json!(1));
                captured.push(request);
                write_http_json(
                    &mut stream,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": responses[index].clone(),
                    }),
                )
                .await;
            }
            captured
        });
        (format!("http://{address}"), handle)
    }

    fn runtime_dex(deployment: &DexDeployment) -> Value {
        json!({
            "dexDeploymentId": deployment.dex_deployment_id,
            "protocolId": deployment.protocol_id,
            "name": deployment.name,
            "chainId": deployment.chain_id,
            "programAddress": deployment.program_address,
            "adapterKind": deployment.adapter_kind,
            "status": deployment.status,
            "replacedByDexDeploymentId": deployment.replaced_by_dex_deployment_id,
        })
    }

    fn runtime_pool(pool: &PoolDefinition) -> Value {
        json!({
            "poolDefinitionId": pool.pool_definition_id,
            "dexDeploymentId": pool.dex_deployment_id,
            "chainId": pool.chain_id,
            "address": pool.address,
            "token0DeploymentId": pool.token0_deployment_id,
            "token1DeploymentId": pool.token1_deployment_id,
            "adapter": {
                "kind": pool.adapter.kind,
                "feeNumerator": pool.adapter.fee_numerator,
                "feeDenominator": pool.adapter.fee_denominator,
            },
            "status": pool.status,
            "replacedByPoolDefinitionId": pool.replaced_by_pool_definition_id,
        })
    }

    fn runtime_wrap(definition: &NativeWrapDefinition) -> Value {
        json!({
            "nativeWrapDefinitionId": definition.native_wrap_definition_id,
            "chainId": definition.chain_id,
            "nativeTokenDeploymentId": definition.native_token_deployment_id,
            "wrappedTokenDeploymentId": definition.wrapped_token_deployment_id,
            "status": definition.status,
        })
    }

    fn runtime_alias(alias: &DexAlias) -> Value {
        json!({
            "namespace": alias.namespace,
            "name": alias.name,
            "dexDeploymentId": alias.dex_deployment_id,
            "poolDefinitionId": alias.pool_definition_id,
        })
    }

    fn push_behavior(behavior: &mut Map<String, Value>, key: &str, row: Value) {
        behavior
            .get_mut(key)
            .and_then(Value::as_array_mut)
            .expect("behavior row array")
            .push(row);
    }

    fn ids(pools: Vec<&'static PoolDefinition>) -> Value {
        let mut ids: Vec<_> = pools
            .into_iter()
            .map(|pool| pool.pool_definition_id)
            .collect();
        ids.sort_unstable();
        json!(ids)
    }

    #[allow(clippy::too_many_lines)]
    fn lookup_behavior() -> Map<String, Value> {
        let mut behavior = Map::from_iter([
            ("getDexDeployment".to_owned(), json!([])),
            ("getPoolDefinition".to_owned(), json!([])),
            ("findPoolDefinitionByAddress".to_owned(), json!([])),
            ("findPoolDefinitionsByPair".to_owned(), json!([])),
            ("listPoolDefinitions".to_owned(), json!([])),
            ("getNativeWrapDefinition".to_owned(), json!([])),
            ("alias".to_owned(), json!([])),
            ("quote".to_owned(), json!([])),
        ]);

        for deployment in DEX_DEPLOYMENTS {
            push_behavior(
                &mut behavior,
                "getDexDeployment",
                json!({
                    "input": deployment.dex_deployment_id,
                    "result": get_dex_deployment(deployment.dex_deployment_id).map(|value| value.dex_deployment_id),
                }),
            );
        }
        push_behavior(
            &mut behavior,
            "getDexDeployment",
            json!({
                "input": "dex-unknown",
                "result": get_dex_deployment("dex-unknown").map(|value| value.dex_deployment_id),
            }),
        );

        for pool in POOL_DEFINITIONS {
            push_behavior(
                &mut behavior,
                "getPoolDefinition",
                json!({
                    "input": pool.pool_definition_id,
                    "result": get_pool_definition(pool.pool_definition_id).map(|value| value.pool_definition_id),
                }),
            );
        }
        push_behavior(
            &mut behavior,
            "getPoolDefinition",
            json!({
                "input": "pool-unknown",
                "result": get_pool_definition("pool-unknown").map(|value| value.pool_definition_id),
            }),
        );

        for pool in POOL_DEFINITIONS {
            push_behavior(
                &mut behavior,
                "findPoolDefinitionByAddress",
                json!({
                    "chainId": pool.chain_id,
                    "address": pool.address,
                    "result": find_pool_definition_by_address(pool.chain_id, pool.address).map(|value| value.pool_definition_id),
                }),
            );
            if pool.chain_id.starts_with("eip155:") {
                let uppercase = format!("0x{}", pool.address[2..].to_ascii_uppercase());
                push_behavior(
                    &mut behavior,
                    "findPoolDefinitionByAddress",
                    json!({
                        "chainId": pool.chain_id,
                        "address": uppercase,
                        "result": find_pool_definition_by_address(pool.chain_id, &uppercase).map(|value| value.pool_definition_id),
                    }),
                );
            }
        }
        push_behavior(
            &mut behavior,
            "findPoolDefinitionByAddress",
            json!({
                "chainId": chain_id("ethereum"),
                "address": "0x0000000000000000000000000000000000000000",
                "result": find_pool_definition_by_address(
                    chain_id("ethereum"),
                    "0x0000000000000000000000000000000000000000",
                )
                .map(|value| value.pool_definition_id),
            }),
        );
        push_behavior(
            &mut behavior,
            "findPoolDefinitionByAddress",
            json!({
                "chainId": chain_id("ethereum"),
                "address": "not-an-address",
                "result": find_pool_definition_by_address(chain_id("ethereum"), "not-an-address")
                    .map(|value| value.pool_definition_id),
            }),
        );
        push_behavior(
            &mut behavior,
            "findPoolDefinitionByAddress",
            json!({
                "chainId": "unknown:chain",
                "address": "0x0000000000000000000000000000000000000001",
                "result": find_pool_definition_by_address(
                    "unknown:chain",
                    "0x0000000000000000000000000000000000000001",
                )
                .map(|value| value.pool_definition_id),
            }),
        );

        for pool in POOL_DEFINITIONS {
            let forward = find_pool_definitions_by_pair(
                pool.chain_id,
                pool.token0_deployment_id,
                pool.token1_deployment_id,
            );
            let reverse = find_pool_definitions_by_pair(
                pool.chain_id,
                pool.token1_deployment_id,
                pool.token0_deployment_id,
            );
            push_behavior(
                &mut behavior,
                "findPoolDefinitionsByPair",
                json!({
                    "chainId": pool.chain_id,
                    "token0DeploymentId": pool.token0_deployment_id,
                    "token1DeploymentId": pool.token1_deployment_id,
                    "result": ids(forward),
                }),
            );
            push_behavior(
                &mut behavior,
                "findPoolDefinitionsByPair",
                json!({
                    "chainId": pool.chain_id,
                    "token0DeploymentId": pool.token1_deployment_id,
                    "token1DeploymentId": pool.token0_deployment_id,
                    "result": ids(reverse),
                }),
            );
        }
        push_behavior(
            &mut behavior,
            "findPoolDefinitionsByPair",
            json!({
                "chainId": chain_id("ethereum"),
                "token0DeploymentId": "deployment-0001",
                "token1DeploymentId": "deployment-0003",
                "result": ids(find_pool_definitions_by_pair(
                    chain_id("ethereum"),
                    "deployment-0001",
                    "deployment-0003",
                )),
            }),
        );
        push_behavior(
            &mut behavior,
            "findPoolDefinitionsByPair",
            json!({
                "chainId": "unknown:chain",
                "token0DeploymentId": "deployment-0002",
                "token1DeploymentId": "deployment-0008",
                "result": ids(find_pool_definitions_by_pair(
                    "unknown:chain",
                    "deployment-0002",
                    "deployment-0008",
                )),
            }),
        );

        let mut filters = vec![json!({})];
        for (_, chain) in DEX_CHAIN_IDS {
            filters.push(json!({ "chainId": chain }));
        }
        for pool in POOL_DEFINITIONS {
            filters.push(json!({ "tokenDeploymentId": pool.token0_deployment_id }));
            filters.push(json!({ "tokenDeploymentId": pool.token1_deployment_id }));
        }
        let adapters: BTreeSet<_> = POOL_DEFINITIONS
            .iter()
            .map(|pool| pool.adapter.kind)
            .collect();
        for adapter in adapters {
            filters.push(json!({ "adapterKind": adapter }));
        }
        for pool in POOL_DEFINITIONS {
            filters.push(json!({
                "chainId": pool.chain_id,
                "tokenDeploymentId": pool.token0_deployment_id,
                "adapterKind": pool.adapter.kind,
            }));
        }
        filters.extend([
            json!({ "chainId": "unknown:chain" }),
            json!({ "tokenDeploymentId": "deployment-unknown" }),
            json!({ "adapterKind": "unknown-adapter" }),
        ]);
        for filter in filters {
            let options = ListPoolDefinitionsOptions {
                chain_id: filter.get("chainId").and_then(Value::as_str),
                token_deployment_id: filter.get("tokenDeploymentId").and_then(Value::as_str),
                adapter_kind: filter.get("adapterKind").and_then(Value::as_str),
            };
            push_behavior(
                &mut behavior,
                "listPoolDefinitions",
                json!({ "filter": filter, "result": ids(list_pool_definitions(options)) }),
            );
        }

        for deployment in TOKEN_DEPLOYMENTS
            .iter()
            .filter(|deployment| deployment.standard == TokenStandard::Native)
        {
            push_behavior(
                &mut behavior,
                "getNativeWrapDefinition",
                json!({
                    "input": deployment.deployment_id,
                    "result": get_native_wrap_definition(deployment.deployment_id).map(|value| value.native_wrap_definition_id),
                }),
            );
        }
        for input in ["deployment-unknown", "native-wrap-0001"] {
            push_behavior(
                &mut behavior,
                "getNativeWrapDefinition",
                json!({
                    "input": input,
                    "result": get_native_wrap_definition(input)
                        .map(|value| value.native_wrap_definition_id),
                }),
            );
        }
        for alias in DEX_ALIASES {
            let (kind, result) = match (alias.dex_deployment_id, alias.pool_definition_id) {
                (Some(result), None) => ("dex", result),
                (None, Some(result)) => ("pool", result),
                _ => continue,
            };
            push_behavior(
                &mut behavior,
                "alias",
                json!({
                    "namespace": alias.namespace,
                    "name": alias.name,
                    "kind": kind,
                    "result": result,
                }),
            );
        }
        behavior
    }

    fn chain_id(name: &str) -> &'static str {
        DEX_CHAIN_IDS
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map_or("", |(_, value)| value)
    }

    fn request_from_fixture(value: &Value) -> ExactInputQuoteRequest {
        serde_json::from_value(value.clone()).expect("fixture request uses the Rust contract shape")
    }

    fn actual_outcome(result: SwapResult<ExactInputQuoteResult>) -> Value {
        match result {
            Ok(value) => json!({
                "kind": "success",
                "value": serde_json::to_value(value).expect("quote result serializes"),
            }),
            Err(error) => match error.code_string() {
                Some(code) => json!({ "kind": "sdk-error", "code": code }),
                None => json!({
                    "kind": "transport-error",
                    "sourcePreserved": error.upstream().is_some(),
                }),
            },
        }
    }

    fn expected_outcome(outcome: &Value) -> Value {
        let mut expected = outcome.clone();
        if expected.get("kind").and_then(Value::as_str) != Some("success") {
            return expected;
        }
        let Some(value) = expected.get_mut("value").and_then(Value::as_object_mut) else {
            return expected;
        };
        value.insert(
            "tokenCatalogDigest".to_owned(),
            json!(crate::TOKEN_CATALOG_CONTENT_DIGEST),
        );
        value.insert(
            "dexCatalogDigest".to_owned(),
            json!(DEX_CATALOG_CONTENT_DIGEST),
        );
        expected
    }

    async fn execute_fixture_case(case: &Value) -> (Value, Vec<Value>) {
        let responses = case
            .get("rpcResponses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (endpoint, server) = if responses.is_empty() {
            ("http://127.0.0.1:1".to_owned(), None)
        } else {
            let (endpoint, server) = start_fixture_server(responses).await;
            (endpoint, Some(server))
        };
        let client = crate::ErpcClient::new_with_swap_clock(
            crate::ErpcClientConfig::new("parity")
                .with_endpoint(&endpoint)
                .with_avalanche_endpoint(&endpoint)
                .with_account_endpoint(&endpoint)
                .with_user_endpoint(&endpoint),
            fixed_fixture_clock,
        )
        .expect("fixture client");
        let request = request_from_fixture(case.get("request").expect("fixture request"));
        let result = client.swap.quote_exact_input(request).await;
        let captured = if let Some(server) = server {
            tokio::time::timeout(Duration::from_secs(5), server)
                .await
                .expect("fixture server completed")
                .expect("fixture server task joined")
        } else {
            Vec::new()
        };
        let trace = captured
            .into_iter()
            .map(|request| {
                json!({
                    "method": request.get("method").cloned().unwrap_or(Value::Null),
                    "params": request.get("params").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        (actual_outcome(result), trace)
    }

    fn add_quote_row(
        behavior: &mut Map<String, Value>,
        case_id: &str,
        outcome: &Value,
        trace: &[Value],
    ) {
        push_behavior(
            behavior,
            "quote",
            json!({
                "caseId": case_id,
                "outcome": outcome,
                "rpcTrace": trace,
            }),
        );
    }

    fn build_snapshot(behavior: &Map<String, Value>) -> Value {
        let mut chain_ids = Map::new();
        for (name, chain) in TOKEN_CHAIN_IDS {
            chain_ids.insert((*name).to_owned(), json!(chain));
        }
        json!({
            "snapshotVersion": 1,
            "snapshotKind": "native-runtime",
            "language": "rust",
            "runtime": concat!(
                "Rust compiled-library unit tests (erpc-sdk ",
                env!("CARGO_PKG_VERSION"),
                ")"
            ),
            "metadata": {
                "version": crate::TOKEN_CATALOG_VERSION,
                "asOfDate": crate::TOKEN_CATALOG_AS_OF_DATE,
                "contentDigest": crate::TOKEN_CATALOG_CONTENT_DIGEST,
                "chainIds": chain_ids,
            },
            "dexMetadata": {
                "version": DEX_CATALOG_VERSION,
                "asOfDate": DEX_CATALOG_AS_OF_DATE,
                "contentDigest": DEX_CATALOG_CONTENT_DIGEST,
            },
            "dexDeployments": DEX_DEPLOYMENTS.iter().map(runtime_dex).collect::<Vec<_>>(),
            "poolDefinitions": POOL_DEFINITIONS.iter().map(runtime_pool).collect::<Vec<_>>(),
            "nativeWrapDefinitions": NATIVE_WRAP_DEFINITIONS.iter().map(runtime_wrap).collect::<Vec<_>>(),
            "aliases": DEX_ALIASES.iter().map(runtime_alias).collect::<Vec<_>>(),
            "behavior": behavior,
        })
    }

    #[tokio::test]
    async fn capture_native_dex_parity_snapshot_when_requested() {
        let Some(output) = env::var_os("ERPC_SDK_DEX_PARITY_OUTPUT") else {
            return;
        };
        let quote_cases = fixture_value("swap-quote-cases.json");
        let mut behavior = lookup_behavior();
        for section in ["validCases", "invalidCases", "rpcCases", "arithmeticCases"] {
            let cases = quote_cases
                .get(section)
                .and_then(Value::as_array)
                .expect("quote fixture section");
            for case in cases {
                if case
                    .get("applicability")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value == "language-local")
                {
                    continue;
                }
                let case_id = case
                    .get("caseId")
                    .and_then(Value::as_str)
                    .expect("quote case ID");
                let (actual, trace) = execute_fixture_case(case).await;
                let expected = expected_outcome(case.get("outcome").expect("fixture outcome"));
                assert_eq!(actual, expected, "native result mismatch for {case_id}");
                let expected_trace = case
                    .get("rpcTrace")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert_eq!(
                    trace, expected_trace,
                    "native RPC trace mismatch for {case_id}"
                );
                add_quote_row(&mut behavior, case_id, &actual, &trace);
            }
        }

        let snapshot = build_snapshot(&behavior);
        let output = Path::new(&output);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("parity output directory");
        }
        let mut encoded = serde_json::to_vec_pretty(&snapshot).expect("parity snapshot serializes");
        encoded.push(b'\n');
        fs::write(output, encoded).expect("parity snapshot write");
    }
}
