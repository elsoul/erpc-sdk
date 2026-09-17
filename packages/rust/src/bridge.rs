//! Optional Mayan Swift v2 EURC bridge integration.
//!
//! This module is deliberately standalone from [`crate::ErpcClient`]. It
//! talks only to the explicitly configured Mayan builder and explorer
//! endpoints, keeps provider quote JSON byte-for-byte for a later build, and
//! never signs, submits, or broadcasts a transaction.

use std::{
    borrow::Borrow,
    collections::HashMap,
    error::Error,
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Response, header::HeaderValue, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    generated::bridge_capabilities::{
        BRIDGE_CAPABILITIES_AS_OF_DATE, BRIDGE_CAPABILITIES_CONTENT_DIGEST,
        BRIDGE_CAPABILITIES_JSON,
    },
    token_catalog::{TokenStandard, TokenStatus, get_token_deployment},
};

const DEFAULT_BUILDER_ENDPOINT: &str = "https://tx-builder.mayan.finance";
const DEFAULT_EXPLORER_ENDPOINT: &str = "https://explorer-api.mayan.finance/v3";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MINIMUM_QUOTE_VALIDITY_SECONDS: u64 = 60;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_RAW_QUOTE_BYTES: usize = 256 * 1024;
const MAX_JSON_DEPTH: usize = 32;
const MAX_QUOTES: usize = 16;
const UINT64_DECIMAL_MAX_LENGTH: usize = 20;
const UINT64_MAX: u128 = u64::MAX as u128;

const ETHEREUM_CHAIN_ID: &str = "eip155:1";
const SOLANA_CHAIN_ID: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ETHEREUM_NAME: &str = "ethereum";
const SOLANA_NAME: &str = "solana";
const ETHEREUM_EURC_DEPLOYMENT_ID: &str = "deployment-0011";
const SOLANA_EURC_DEPLOYMENT_ID: &str = "deployment-0013";
const ETHEREUM_USDC_DEPLOYMENT_ID: &str = "deployment-0008";
const SOLANA_USDC_DEPLOYMENT_ID: &str = "deployment-0010";
const ETHEREUM_EURC_ADDRESS: &str = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
const SOLANA_EURC_ADDRESS: &str = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const ETHEREUM_USDC_ADDRESS: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SOLANA_USDC_ADDRESS: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETHEREUM_SWIFT_CONTRACT: &str = "0x40ffe85a28dc9993541449464d7529a922142960";
const SOLANA_SWIFT_PROGRAM: &str = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny";
const ETHEREUM_FORWARDER: &str = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2";
const SOLANA_JUPITER_V6: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ETHEREUM_FORWARDER_SELECTOR: &str = "0x30dedc57";

const DEPENDENCIES: &[&str] = &[
    "mayan-hosted-quote-api",
    "mayan-hosted-transaction-builder",
    "mayan-hosted-source-swap-builder",
    "swift-auction-solvers",
    "relayers",
    "wormhole-guardian-messaging",
    "mayan-explorer-indexer",
];

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Stable error codes for the optional bridge client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BridgeErrorCode {
    /// The request or bridge configuration is invalid.
    InvalidArgument,
    /// The requested native EURC direction is outside the reviewed routes.
    UnsupportedRoute,
    /// The provider requires a builder key for this operation.
    ProviderAuthRequired,
    /// The provider could not be reached or returned a redirect.
    ProviderTransport,
    /// The provider returned a non-success HTTP status.
    ProviderHttp,
    /// The provider body or schema is invalid.
    ProviderInvalidResponse,
    /// No valid Swift v2 quote was returned.
    QuoteUnavailable,
    /// A quote is expired or too close to expiry.
    QuoteExpired,
    /// A supplied quote does not match its signed raw object or request.
    QuoteMismatch,
    /// The provider returned an invalid unsigned build.
    BuildInvalid,
    /// The explorer did not find the source transaction.
    StatusNotFound,
    /// The provider request exceeded the configured timeout.
    Timeout,
    /// The caller cancelled the provider request.
    Aborted,
}

impl BridgeErrorCode {
    /// Stable spelling for [`Self::InvalidArgument`].
    pub const BRIDGE_INVALID_ARGUMENT: Self = Self::InvalidArgument;
    /// Stable spelling for [`Self::UnsupportedRoute`].
    pub const BRIDGE_UNSUPPORTED_ROUTE: Self = Self::UnsupportedRoute;
    /// Stable spelling for [`Self::ProviderAuthRequired`].
    pub const BRIDGE_PROVIDER_AUTH_REQUIRED: Self = Self::ProviderAuthRequired;
    /// Stable spelling for [`Self::ProviderTransport`].
    pub const BRIDGE_PROVIDER_TRANSPORT: Self = Self::ProviderTransport;
    /// Stable spelling for [`Self::ProviderHttp`].
    pub const BRIDGE_PROVIDER_HTTP: Self = Self::ProviderHttp;
    /// Stable spelling for [`Self::ProviderInvalidResponse`].
    pub const BRIDGE_PROVIDER_INVALID_RESPONSE: Self = Self::ProviderInvalidResponse;
    /// Stable spelling for [`Self::QuoteUnavailable`].
    pub const BRIDGE_QUOTE_UNAVAILABLE: Self = Self::QuoteUnavailable;
    /// Stable spelling for [`Self::QuoteExpired`].
    pub const BRIDGE_QUOTE_EXPIRED: Self = Self::QuoteExpired;
    /// Stable spelling for [`Self::QuoteMismatch`].
    pub const BRIDGE_QUOTE_MISMATCH: Self = Self::QuoteMismatch;
    /// Stable spelling for [`Self::BuildInvalid`].
    pub const BRIDGE_BUILD_INVALID: Self = Self::BuildInvalid;
    /// Stable spelling for [`Self::StatusNotFound`].
    pub const BRIDGE_STATUS_NOT_FOUND: Self = Self::StatusNotFound;
    /// Stable spelling for [`Self::Timeout`].
    pub const BRIDGE_TIMEOUT: Self = Self::Timeout;
    /// Stable spelling for [`Self::Aborted`].
    pub const BRIDGE_ABORTED: Self = Self::Aborted;

    /// Returns the stable wire/error code string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "BRIDGE_INVALID_ARGUMENT",
            Self::UnsupportedRoute => "BRIDGE_UNSUPPORTED_ROUTE",
            Self::ProviderAuthRequired => "BRIDGE_PROVIDER_AUTH_REQUIRED",
            Self::ProviderTransport => "BRIDGE_PROVIDER_TRANSPORT",
            Self::ProviderHttp => "BRIDGE_PROVIDER_HTTP",
            Self::ProviderInvalidResponse => "BRIDGE_PROVIDER_INVALID_RESPONSE",
            Self::QuoteUnavailable => "BRIDGE_QUOTE_UNAVAILABLE",
            Self::QuoteExpired => "BRIDGE_QUOTE_EXPIRED",
            Self::QuoteMismatch => "BRIDGE_QUOTE_MISMATCH",
            Self::BuildInvalid => "BRIDGE_BUILD_INVALID",
            Self::StatusNotFound => "BRIDGE_STATUS_NOT_FOUND",
            Self::Timeout => "BRIDGE_TIMEOUT",
            Self::Aborted => "BRIDGE_ABORTED",
        }
    }

    const fn message(self) -> &'static str {
        match self {
            Self::InvalidArgument => "Bridge request is invalid",
            Self::UnsupportedRoute => "Bridge route is unsupported",
            Self::ProviderAuthRequired => "Bridge provider authentication is required",
            Self::ProviderTransport => "Bridge provider transport failed",
            Self::ProviderHttp => "Bridge provider HTTP request failed",
            Self::ProviderInvalidResponse => "Bridge provider response is invalid",
            Self::QuoteUnavailable => "Bridge quote is unavailable",
            Self::QuoteExpired => "Bridge quote is expired",
            Self::QuoteMismatch => "Bridge quote does not match the request",
            Self::BuildInvalid => "Bridge provider build is invalid",
            Self::StatusNotFound => "Bridge status was not found",
            Self::Timeout => "Bridge provider request timed out",
            Self::Aborted => "Bridge provider request was aborted",
        }
    }
}

impl fmt::Display for BridgeErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Secret-free error returned by the standalone bridge client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeError {
    code: BridgeErrorCode,
    status: Option<u16>,
}

impl BridgeError {
    /// Returns the stable bridge error code.
    #[must_use]
    pub const fn code(&self) -> BridgeErrorCode {
        self.code
    }

    /// Returns the stable bridge error code string.
    #[must_use]
    pub const fn code_string(&self) -> &'static str {
        self.code.as_str()
    }

    /// Returns an HTTP status when the provider supplied one.
    #[must_use]
    pub const fn status(&self) -> Option<u16> {
        self.status
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.message())
    }
}

impl Error for BridgeError {}

/// Result type used by the standalone Mayan bridge client.
pub type BridgeResult<T> = std::result::Result<T, BridgeError>;

fn bridge_error(code: BridgeErrorCode) -> BridgeError {
    BridgeError { code, status: None }
}

fn bridge_error_status(code: BridgeErrorCode, status: u16) -> BridgeError {
    BridgeError {
        code,
        status: Some(status),
    }
}

/// Configuration for [`MayanSwiftV2BridgeClient`].
#[derive(Clone)]
pub struct MayanSwiftV2BridgeConfig {
    builder_endpoint: String,
    explorer_endpoint: String,
    builder_api_key: Option<String>,
    allow_unauthenticated_build: bool,
    minimum_quote_validity_seconds: u64,
    timeout: Duration,
}

impl Default for MayanSwiftV2BridgeConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl MayanSwiftV2BridgeConfig {
    /// Creates a configuration using Mayan's documented hosted endpoints.
    #[must_use]
    pub fn new() -> Self {
        Self {
            builder_endpoint: DEFAULT_BUILDER_ENDPOINT.to_owned(),
            explorer_endpoint: DEFAULT_EXPLORER_ENDPOINT.to_owned(),
            builder_api_key: None,
            allow_unauthenticated_build: false,
            minimum_quote_validity_seconds: DEFAULT_MINIMUM_QUOTE_VALIDITY_SECONDS,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Overrides the builder endpoint, preserving any path prefix.
    #[must_use]
    pub fn with_builder_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.builder_endpoint = endpoint.into();
        self
    }

    /// Overrides the explorer endpoint, preserving any path prefix.
    #[must_use]
    pub fn with_explorer_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.explorer_endpoint = endpoint.into();
        self
    }

    /// Sets the provider-only builder API key.
    #[must_use]
    pub fn with_builder_api_key(mut self, key: impl Into<String>) -> Self {
        self.builder_api_key = Some(key.into());
        self
    }

    /// Allows an explicitly configured unauthenticated build endpoint.
    #[must_use]
    pub const fn with_allow_unauthenticated_build(mut self, allowed: bool) -> Self {
        self.allow_unauthenticated_build = allowed;
        self
    }

    /// Sets the minimum number of seconds a quote must remain valid.
    #[must_use]
    pub const fn with_minimum_quote_validity_seconds(mut self, seconds: u64) -> Self {
        self.minimum_quote_validity_seconds = seconds;
        self
    }

    /// Sets the provider request timeout.
    #[must_use]
    pub const fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl fmt::Debug for MayanSwiftV2BridgeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MayanSwiftV2BridgeConfig")
            .field("builder_endpoint", &self.builder_endpoint)
            .field("explorer_endpoint", &self.explorer_endpoint)
            .field(
                "builder_api_key",
                &self.builder_api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "allow_unauthenticated_build",
                &self.allow_unauthenticated_build,
            )
            .field(
                "minimum_quote_validity_seconds",
                &self.minimum_quote_validity_seconds,
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Exact native EURC bridge quote request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2QuoteRequest {
    /// Source CAIP-2 chain identifier.
    pub source_chain_id: String,
    /// Destination CAIP-2 chain identifier.
    pub destination_chain_id: String,
    /// Source EURC deployment identifier.
    pub source_token_deployment_id: String,
    /// Destination EURC deployment identifier.
    pub destination_token_deployment_id: String,
    /// Positive canonical decimal EURC amount in atomic units.
    pub amount_in: String,
    /// Slippage tolerance in basis points, from 0 through 500.
    pub slippage_bps: u64,
}

/// Provider-selected intermediate source swap.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2SourceSwap {
    /// Whether the provider requires the source-side swap.
    pub required: bool,
    /// Source token deployment identifier.
    pub input_token_deployment_id: String,
    /// Internal source USDC deployment identifier.
    pub intermediate_token_deployment_id: String,
    /// Internal source USDC address or mint.
    pub intermediate_token_address: String,
    /// Provider wire standard (`erc20` or `spl`).
    pub intermediate_token_standard: String,
    /// Internal source USDC decimals.
    pub intermediate_token_decimals: u8,
    /// Unchanged provider number lexeme for the middle amount.
    pub provider_minimum_amount: String,
    /// Provider-selected router kind.
    pub router_kind: String,
    /// Provider-selected router or Jupiter address.
    pub router_address: String,
}

/// Normalized provider-signed Mayan Swift v2 quote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2Quote {
    /// Quote discriminator.
    pub quote_kind: String,
    /// Provider discriminator.
    pub provider_id: String,
    /// Source CAIP-2 chain identifier.
    pub source_chain_id: String,
    /// Destination CAIP-2 chain identifier.
    pub destination_chain_id: String,
    /// Source EURC deployment identifier.
    pub source_token_deployment_id: String,
    /// Destination EURC deployment identifier.
    pub destination_token_deployment_id: String,
    /// Canonical decimal input amount.
    pub amount_in: String,
    /// Canonical decimal expected destination amount.
    pub expected_amount_out: String,
    /// Canonical decimal provider minimum amount.
    pub minimum_amount_out: String,
    /// Canonical decimal provider minimum received amount.
    pub minimum_received: String,
    /// Canonical decimal absolute deadline.
    pub deadline: String,
    /// Slippage tolerance in basis points.
    pub slippage_bps: u64,
    /// Lowercase 16-byte provider quote ID.
    pub quote_id: String,
    /// Lowercase provider signature.
    pub provider_signature: String,
    /// Internal source-swap dependency disclosure.
    pub source_swap: MayanSwiftV2SourceSwap,
    /// Ordered external dependencies used by the provider route.
    pub dependencies: Vec<String>,
    /// Signature verification disclosure.
    pub quote_verification: String,
    /// Exact selected provider object JSON.
    pub raw_signed_quote_json: String,
}

/// Unsigned EVM transaction returned by Mayan's builder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanEvmUnsignedTransaction {
    /// Transaction discriminator.
    pub kind: String,
    /// Canonical CAIP-2 Ethereum identifier.
    pub chain_id: String,
    /// Lowercase swapper address.
    pub from: String,
    /// Lowercase provider forwarder.
    pub to: String,
    /// Lowercase provider calldata.
    pub data: String,
    /// Canonical decimal zero value.
    pub value: String,
}

/// Unsigned Solana v0 transaction returned by Mayan's builder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSolanaUnsignedTransaction {
    /// Transaction discriminator.
    pub kind: String,
    /// Canonical Solana CAIP-2 identifier.
    pub chain_id: String,
    /// Canonical base58 fee payer.
    pub fee_payer: String,
    /// Canonical base64 serialized transaction.
    pub transaction_base64: String,
}

/// Unsigned provider transaction for either reviewed source chain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MayanSwiftV2UnsignedTransaction {
    /// Ethereum transaction.
    Evm(MayanEvmUnsignedTransaction),
    /// Solana transaction.
    Solana(MayanSolanaUnsignedTransaction),
}

/// Structural validation disclosure for a provider build.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2BuildValidation {
    /// Validation level.
    pub level: String,
    /// The provider signature was not verified locally.
    pub quote_signature_locally_verified: bool,
    /// Full transaction semantics were not verified locally.
    pub transaction_semantics_locally_verified: bool,
    /// Settlement was not verified locally.
    pub settlement_locally_verified: bool,
}

/// Unsigned provider build result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MayanSwiftV2Build {
    /// Build discriminator.
    pub build_kind: String,
    /// Provider discriminator.
    pub provider_id: String,
    /// Quote embedded in the build.
    pub quote: MayanSwiftV2Quote,
    /// Source CAIP-2 chain identifier.
    pub source_chain_id: String,
    /// Destination CAIP-2 chain identifier.
    pub destination_chain_id: String,
    /// Provider unsigned transaction.
    pub transaction: MayanSwiftV2UnsignedTransaction,
    /// ERC20 allowance requirement for Ethereum source, otherwise `None`.
    pub allowance: Option<MayanSwiftV2Allowance>,
    /// Structural validation disclosure.
    pub validation: MayanSwiftV2BuildValidation,
    /// Exact provider build response JSON.
    pub raw_provider_build_json: String,
}

/// ERC20 allowance requirement for an Ethereum-source build.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2Allowance {
    /// EURC deployment identifier.
    pub token_deployment_id: String,
    /// Lowercase EURC token address.
    pub token_address: String,
    /// Lowercase swapper address.
    pub owner: String,
    /// Lowercase Mayan Forwarder spender.
    pub spender: String,
    /// Canonical decimal required amount.
    pub required_amount: String,
}

/// Build request containing a previously returned quote.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2BuildRequest {
    /// Provider-signed normalized quote.
    pub quote: MayanSwiftV2Quote,
    /// Source-chain swapper address.
    pub swapper_address: String,
    /// Destination-chain recipient address.
    pub destination_address: String,
    /// Optional source-chain refund address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_address: Option<String>,
}

/// Alias for callers that include `unsigned` in the method name.
pub type MayanSwiftV2BuildUnsignedRequest = MayanSwiftV2BuildRequest;

/// Explorer status request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2StatusRequest {
    /// Source CAIP-2 chain identifier.
    pub source_chain_id: String,
    /// Source transaction hash or Solana signature.
    pub source_transaction_hash: String,
}

/// Read-only indexed explorer status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2Status {
    /// Status discriminator.
    pub status_kind: String,
    /// Provider discriminator.
    pub provider_id: String,
    /// Source CAIP-2 chain identifier.
    pub source_chain_id: String,
    /// Normalized source transaction hash or signature.
    pub source_transaction_hash: String,
    /// Coarse mapped status.
    pub state: String,
    /// Provider client status string.
    pub provider_client_status: String,
    /// Optional provider status string.
    pub provider_status: Option<String>,
    /// Indexed-status disclosure.
    pub status_verification: String,
    /// Exact provider status response JSON.
    pub raw_provider_status_json: String,
}

/// Alias for callers that use a result suffix.
pub type MayanSwiftV2QuoteResult = Vec<MayanSwiftV2Quote>;
/// Alias for callers that use a result suffix.
pub type MayanSwiftV2BuildResult = MayanSwiftV2Build;
/// Alias for callers that use a result suffix.
pub type MayanSwiftV2StatusResult = MayanSwiftV2Status;
/// Alias for the standalone bridge client.
pub type BridgeClient = MayanSwiftV2BridgeClient;

#[derive(Clone, Debug)]
struct JsonNode {
    value: Value,
    start: usize,
    end: usize,
    object_entries: Option<HashMap<String, JsonNode>>,
    array_items: Option<Vec<JsonNode>>,
    raw_number: Option<String>,
}

struct ProviderResponse {
    text: String,
    root: JsonNode,
}

struct StrictJsonParser<'a> {
    source: &'a str,
    index: usize,
}

impl<'a> StrictJsonParser<'a> {
    fn new(source: &'a str) -> Self {
        Self { source, index: 0 }
    }

    fn parse(mut self) -> BridgeResult<JsonNode> {
        self.skip_whitespace();
        let value = self.value(0)?;
        self.skip_whitespace();
        if self.index != self.source.len() {
            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        Ok(value)
    }

    fn value(&mut self, depth: usize) -> BridgeResult<JsonNode> {
        if depth > MAX_JSON_DEPTH {
            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        let start = self.index;
        let Some(character) = self.source.as_bytes().get(self.index).copied() else {
            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
        };
        match character {
            b'{' => self.object(start, depth),
            b'[' => self.array(start, depth),
            b'"' => {
                let value = self.string()?;
                Ok(JsonNode {
                    value: Value::String(value),
                    start,
                    end: self.index,
                    object_entries: None,
                    array_items: None,
                    raw_number: None,
                })
            }
            b't' if self.source[self.index..].starts_with("true") => {
                self.index += 4;
                Ok(self.scalar(start, Value::Bool(true)))
            }
            b'f' if self.source[self.index..].starts_with("false") => {
                self.index += 5;
                Ok(self.scalar(start, Value::Bool(false)))
            }
            b'n' if self.source[self.index..].starts_with("null") => {
                self.index += 4;
                Ok(self.scalar(start, Value::Null))
            }
            b'-' | b'0'..=b'9' => self.number(start),
            _ => Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse)),
        }
    }

    fn scalar(&self, start: usize, value: Value) -> JsonNode {
        JsonNode {
            value,
            start,
            end: self.index,
            object_entries: None,
            array_items: None,
            raw_number: None,
        }
    }

    fn object(&mut self, start: usize, depth: usize) -> BridgeResult<JsonNode> {
        self.index += 1;
        self.skip_whitespace();
        let mut entries = HashMap::new();
        let mut values = Map::new();
        if self.peek() == Some(b'}') {
            self.index += 1;
            return Ok(JsonNode {
                value: Value::Object(values),
                start,
                end: self.index,
                object_entries: Some(entries),
                array_items: None,
                raw_number: None,
            });
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
            }
            let key = self.string()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
            }
            self.index += 1;
            self.skip_whitespace();
            let child = self.value(depth + 1)?;
            if entries.insert(key.clone(), child.clone()).is_some() {
                return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
            }
            values.insert(key, child.value.clone());
            self.skip_whitespace();
            match self.peek() {
                Some(b'}') => {
                    self.index += 1;
                    break;
                }
                Some(b',') => {
                    self.index += 1;
                    self.skip_whitespace();
                }
                _ => return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse)),
            }
        }
        Ok(JsonNode {
            value: Value::Object(values),
            start,
            end: self.index,
            object_entries: Some(entries),
            array_items: None,
            raw_number: None,
        })
    }

    fn array(&mut self, start: usize, depth: usize) -> BridgeResult<JsonNode> {
        self.index += 1;
        self.skip_whitespace();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.index += 1;
            return Ok(JsonNode {
                value: Value::Array(Vec::new()),
                start,
                end: self.index,
                object_entries: None,
                array_items: Some(items),
                raw_number: None,
            });
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b']') => {
                    self.index += 1;
                    break;
                }
                Some(b',') => {
                    self.index += 1;
                    self.skip_whitespace();
                }
                _ => return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse)),
            }
        }
        let values = items.iter().map(|item| item.value.clone()).collect();
        Ok(JsonNode {
            value: Value::Array(values),
            start,
            end: self.index,
            object_entries: None,
            array_items: Some(items),
            raw_number: None,
        })
    }

    fn string(&mut self) -> BridgeResult<String> {
        let start = self.index;
        self.index += 1;
        while self.index < self.source.len() {
            let character = self.source.as_bytes()[self.index];
            match character {
                b'"' => {
                    self.index += 1;
                    let raw = &self.source[start..self.index];
                    return serde_json::from_str(raw)
                        .map_err(|_| bridge_error(BridgeErrorCode::ProviderInvalidResponse));
                }
                b'\\' => {
                    self.index += 1;
                    let Some(escape) = self.source.as_bytes().get(self.index).copied() else {
                        return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
                    };
                    if escape == b'u' {
                        if self.index + 4 >= self.source.len()
                            || !self.source.as_bytes()[self.index + 1..self.index + 5]
                                .iter()
                                .all(u8::is_ascii_hexdigit)
                        {
                            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
                        }
                        self.index += 5;
                    } else if b"\"\\/bfnrt".contains(&escape) {
                        self.index += 1;
                    } else {
                        return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
                    }
                }
                0..=0x1f => {
                    return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
                }
                _ => self.index += 1,
            }
        }
        Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse))
    }

    fn number(&mut self, start: usize) -> BridgeResult<JsonNode> {
        if self.peek() == Some(b'-') {
            self.index += 1;
        }
        match self.peek() {
            Some(b'0') => self.index += 1,
            Some(b'1'..=b'9') => {
                self.index += 1;
                while self.peek().is_some_and(|value| value.is_ascii_digit()) {
                    self.index += 1;
                }
            }
            _ => return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse)),
        }
        if self.peek() == Some(b'.') {
            self.index += 1;
            let fraction_start = self.index;
            while self.peek().is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
            if self.index == fraction_start {
                return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
            }
        }
        if self
            .peek()
            .is_some_and(|value| value == b'e' || value == b'E')
        {
            self.index += 1;
            if self
                .peek()
                .is_some_and(|value| value == b'+' || value == b'-')
            {
                self.index += 1;
            }
            let exponent_start = self.index;
            while self.peek().is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
            if self.index == exponent_start {
                return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
            }
        }
        let raw = self.source[start..self.index].to_owned();
        let value = serde_json::from_str::<Value>(&raw)
            .map_err(|_| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;
        if !value.is_number() {
            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        Ok(JsonNode {
            value,
            start,
            end: self.index,
            object_entries: None,
            array_items: None,
            raw_number: Some(raw),
        })
    }

    fn peek(&self) -> Option<u8> {
        self.source.as_bytes().get(self.index).copied()
    }

    fn skip_whitespace(&mut self) {
        while self
            .peek()
            .is_some_and(|value| matches!(value, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.index += 1;
        }
    }
}

fn object_entry<'a>(node: &'a JsonNode, key: &str) -> Option<&'a JsonNode> {
    node.object_entries.as_ref()?.get(key)
}

fn object_value<'a>(node: &'a JsonNode, key: &str) -> Option<&'a Value> {
    Some(&object_entry(node, key)?.value)
}

fn required_node<'a>(node: &'a JsonNode, key: &str) -> BridgeResult<&'a JsonNode> {
    object_entry(node, key).ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))
}

fn parse_provider_response(text: String) -> BridgeResult<ProviderResponse> {
    let root = StrictJsonParser::new(&text).parse()?;
    Ok(ProviderResponse { text, root })
}

#[allow(clippy::struct_field_names)]
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BridgeCapability {
    bridge_capability_id: String,
    provider_id: String,
    capability_kind: String,
    source_chain_id: String,
    destination_chain_id: String,
    source_token_deployment_id: String,
    destination_token_deployment_id: String,
    source_token_address: String,
    destination_token_address: String,
    source_token_standard: String,
    destination_token_standard: String,
    source_token_decimals: u8,
    destination_token_decimals: u8,
    source_provider_chain_name: String,
    destination_provider_chain_name: String,
    source_provider_chain_id: u8,
    destination_provider_chain_id: u8,
    source_wormhole_chain_id: u8,
    destination_wormhole_chain_id: u8,
    source_usdc_deployment_id: String,
    source_usdc_address: String,
    source_usdc_standard: String,
    source_usdc_decimals: u8,
    swift_contract: String,
    forwarder_address: Option<String>,
    forwarder_function_selector: Option<String>,
    jupiter_program_address: Option<String>,
    builder_endpoint: String,
    explorer_endpoint: String,
    dependencies: Vec<String>,
    status: String,
}

#[derive(Clone, Debug)]
struct DirectionFacts {
    bridge_capability_id: &'static str,
    source_chain_id: &'static str,
    destination_chain_id: &'static str,
    source_token_deployment_id: &'static str,
    destination_token_deployment_id: &'static str,
    source_token_address: &'static str,
    destination_token_address: &'static str,
    source_token_standard: &'static str,
    destination_token_standard: &'static str,
    source_provider_chain_name: &'static str,
    destination_provider_chain_name: &'static str,
    source_provider_chain_id: u8,
    destination_provider_chain_id: u8,
    source_wormhole_chain_id: u8,
    destination_wormhole_chain_id: u8,
    source_usdc_deployment_id: &'static str,
    source_usdc_address: &'static str,
    source_usdc_standard: &'static str,
    swift_contract: &'static str,
}

fn direction_facts(
    source_chain_id: &str,
    destination_chain_id: &str,
) -> BridgeResult<DirectionFacts> {
    if source_chain_id == ETHEREUM_CHAIN_ID && destination_chain_id == SOLANA_CHAIN_ID {
        return Ok(DirectionFacts {
            bridge_capability_id: "bridge-mayan-swift-v2-eurc-eth-sol",
            source_chain_id: ETHEREUM_CHAIN_ID,
            destination_chain_id: SOLANA_CHAIN_ID,
            source_token_deployment_id: ETHEREUM_EURC_DEPLOYMENT_ID,
            destination_token_deployment_id: SOLANA_EURC_DEPLOYMENT_ID,
            source_token_address: ETHEREUM_EURC_ADDRESS,
            destination_token_address: SOLANA_EURC_ADDRESS,
            source_token_standard: "erc20",
            destination_token_standard: "spl-token",
            source_provider_chain_name: ETHEREUM_NAME,
            destination_provider_chain_name: SOLANA_NAME,
            source_provider_chain_id: 1,
            destination_provider_chain_id: 0,
            source_wormhole_chain_id: 2,
            destination_wormhole_chain_id: 1,
            source_usdc_deployment_id: ETHEREUM_USDC_DEPLOYMENT_ID,
            source_usdc_address: ETHEREUM_USDC_ADDRESS,
            source_usdc_standard: "erc20",
            swift_contract: ETHEREUM_SWIFT_CONTRACT,
        });
    }
    if source_chain_id == SOLANA_CHAIN_ID && destination_chain_id == ETHEREUM_CHAIN_ID {
        return Ok(DirectionFacts {
            bridge_capability_id: "bridge-mayan-swift-v2-eurc-sol-eth",
            source_chain_id: SOLANA_CHAIN_ID,
            destination_chain_id: ETHEREUM_CHAIN_ID,
            source_token_deployment_id: SOLANA_EURC_DEPLOYMENT_ID,
            destination_token_deployment_id: ETHEREUM_EURC_DEPLOYMENT_ID,
            source_token_address: SOLANA_EURC_ADDRESS,
            destination_token_address: ETHEREUM_EURC_ADDRESS,
            source_token_standard: "spl-token",
            destination_token_standard: "erc20",
            source_provider_chain_name: SOLANA_NAME,
            destination_provider_chain_name: ETHEREUM_NAME,
            source_provider_chain_id: 0,
            destination_provider_chain_id: 1,
            source_wormhole_chain_id: 1,
            destination_wormhole_chain_id: 2,
            source_usdc_deployment_id: SOLANA_USDC_DEPLOYMENT_ID,
            source_usdc_address: SOLANA_USDC_ADDRESS,
            source_usdc_standard: "spl-token",
            swift_contract: SOLANA_SWIFT_PROGRAM,
        });
    }
    Err(bridge_error(BridgeErrorCode::UnsupportedRoute))
}

fn catalog_token_matches(
    deployment_id: &str,
    chain_id: &str,
    address: &str,
    standard: &str,
) -> bool {
    let Some(token) = get_token_deployment(deployment_id) else {
        return false;
    };
    token.chain_id == chain_id
        && token.address.is_some_and(|candidate| {
            if chain_id == ETHEREUM_CHAIN_ID {
                candidate.eq_ignore_ascii_case(address)
            } else {
                candidate == address
            }
        })
        && token.decimals == 6
        && token.status == TokenStatus::Active
        && match standard {
            "erc20" => token.standard == TokenStandard::Erc20,
            "spl-token" => token.standard == TokenStandard::SplToken,
            _ => false,
        }
}

fn validate_catalog_direction(facts: &DirectionFacts) -> BridgeResult<()> {
    if !catalog_token_matches(
        facts.source_token_deployment_id,
        facts.source_chain_id,
        facts.source_token_address,
        facts.source_token_standard,
    ) || !catalog_token_matches(
        facts.destination_token_deployment_id,
        facts.destination_chain_id,
        facts.destination_token_address,
        facts.destination_token_standard,
    ) || !catalog_token_matches(
        facts.source_usdc_deployment_id,
        facts.source_chain_id,
        facts.source_usdc_address,
        facts.source_usdc_standard,
    ) {
        return Err(bridge_error(BridgeErrorCode::UnsupportedRoute));
    }
    Ok(())
}

fn expected_dependencies(source_chain_id: &str) -> Vec<String> {
    let mut dependencies = DEPENDENCIES
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    if source_chain_id == SOLANA_CHAIN_ID {
        dependencies.push("jupiter-v6-source-swap".to_owned());
    }
    dependencies
}

fn find_capability(facts: &DirectionFacts) -> BridgeResult<BridgeCapability> {
    if BRIDGE_CAPABILITIES_CONTENT_DIGEST.len() != 64 || BRIDGE_CAPABILITIES_AS_OF_DATE.len() != 10
    {
        return Err(bridge_error(BridgeErrorCode::UnsupportedRoute));
    }
    let capabilities: Vec<BridgeCapability> = serde_json::from_str(BRIDGE_CAPABILITIES_JSON)
        .map_err(|_| bridge_error(BridgeErrorCode::UnsupportedRoute))?;
    let Some(capability) = capabilities.into_iter().find(|entry| {
        entry.bridge_capability_id == facts.bridge_capability_id
            && entry.source_chain_id == facts.source_chain_id
            && entry.destination_chain_id == facts.destination_chain_id
            && entry.source_token_deployment_id == facts.source_token_deployment_id
            && entry.destination_token_deployment_id == facts.destination_token_deployment_id
    }) else {
        return Err(bridge_error(BridgeErrorCode::UnsupportedRoute));
    };
    let eth_source = facts.source_chain_id == ETHEREUM_CHAIN_ID;
    let expected_forwarder = eth_source.then(|| ETHEREUM_FORWARDER.to_owned());
    let expected_forwarder_selector = eth_source.then(|| ETHEREUM_FORWARDER_SELECTOR.to_owned());
    let expected_jupiter = (!eth_source).then(|| SOLANA_JUPITER_V6.to_owned());
    let matches = capability.provider_id == "mayan-swift-v2"
        && capability.capability_kind == "external-provider-dynamic"
        && capability
            .source_token_address
            .eq_ignore_ascii_case(facts.source_token_address)
        && (facts.destination_chain_id != ETHEREUM_CHAIN_ID
            || capability
                .destination_token_address
                .eq_ignore_ascii_case(facts.destination_token_address))
        && capability.destination_token_address == facts.destination_token_address
        && capability.source_token_standard == facts.source_token_standard
        && capability.destination_token_standard == facts.destination_token_standard
        && capability.source_token_decimals == 6
        && capability.destination_token_decimals == 6
        && capability.source_provider_chain_name == facts.source_provider_chain_name
        && capability.destination_provider_chain_name == facts.destination_provider_chain_name
        && capability.source_provider_chain_id == facts.source_provider_chain_id
        && capability.destination_provider_chain_id == facts.destination_provider_chain_id
        && capability.source_wormhole_chain_id == facts.source_wormhole_chain_id
        && capability.destination_wormhole_chain_id == facts.destination_wormhole_chain_id
        && capability.source_usdc_deployment_id == facts.source_usdc_deployment_id
        && capability
            .source_usdc_address
            .eq_ignore_ascii_case(facts.source_usdc_address)
        && capability.source_usdc_standard == facts.source_usdc_standard
        && capability.source_usdc_decimals == 6
        && capability.swift_contract == facts.swift_contract
        && capability.forwarder_address == expected_forwarder
        && capability.forwarder_function_selector == expected_forwarder_selector
        && capability.jupiter_program_address == expected_jupiter
        && capability.builder_endpoint == DEFAULT_BUILDER_ENDPOINT
        && capability.explorer_endpoint == DEFAULT_EXPLORER_ENDPOINT
        && capability.dependencies == expected_dependencies(facts.source_chain_id)
        && capability.status == "active";
    if !matches {
        return Err(bridge_error(BridgeErrorCode::UnsupportedRoute));
    }
    Ok(capability)
}

fn normalize_provider_endpoint(source: &str) -> BridgeResult<Url> {
    if source.is_empty() || source.trim() != source || !source.contains("://") {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    let endpoint =
        Url::parse(source).map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?;
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    if endpoint.query().is_some() || endpoint.fragment().is_some() {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    let hostname = endpoint.host_str().unwrap_or_default();
    if endpoint.scheme() != "https"
        && !(endpoint.scheme() == "http"
            && matches!(hostname, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
    {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    if hostname.is_empty() || endpoint.port().is_some_and(|port| port == 0) {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    let mut endpoint = endpoint;
    let path = endpoint.path().trim_end_matches('/').to_owned();
    endpoint.set_path(if path.is_empty() { "/" } else { &path });
    Ok(endpoint)
}

fn endpoint_with_path(base: &Url, path: &str) -> Url {
    let mut endpoint = base.clone();
    let prefix = endpoint.path().trim_end_matches('/');
    endpoint.set_path(&format!("{prefix}/{}", path.trim_start_matches('/')));
    endpoint
}

fn normalize_bridge_config(
    config: MayanSwiftV2BridgeConfig,
) -> BridgeResult<NormalizedBridgeConfig> {
    if config.timeout.is_zero() || config.minimum_quote_validity_seconds > 300 {
        return Err(bridge_error(BridgeErrorCode::InvalidArgument));
    }
    let builder_endpoint = normalize_provider_endpoint(&config.builder_endpoint)?;
    let explorer_endpoint = normalize_provider_endpoint(&config.explorer_endpoint)?;
    let builder_api_key = config
        .builder_api_key
        .and_then(|value| if value.is_empty() { None } else { Some(value) });
    if let Some(key) = &builder_api_key {
        HeaderValue::from_str(key).map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?;
    }
    let http_client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?;
    Ok(NormalizedBridgeConfig {
        builder_endpoint,
        explorer_endpoint,
        builder_api_key,
        allow_unauthenticated_build: config.allow_unauthenticated_build,
        minimum_quote_validity_seconds: config.minimum_quote_validity_seconds,
        timeout: config.timeout,
        http_client,
    })
}

struct NormalizedBridgeConfig {
    builder_endpoint: Url,
    explorer_endpoint: Url,
    builder_api_key: Option<String>,
    allow_unauthenticated_build: bool,
    minimum_quote_validity_seconds: u64,
    timeout: Duration,
    http_client: Client,
}

#[derive(Clone, Copy)]
enum ProviderOperation {
    Quote,
    Build,
    Status,
}

/// Standalone optional Mayan Swift v2 bridge client.
#[derive(Clone)]
pub struct MayanSwiftV2BridgeClient {
    config: Arc<NormalizedBridgeConfig>,
    #[cfg(test)]
    clock: Option<fn() -> u64>,
}

impl MayanSwiftV2BridgeClient {
    /// Creates a client after validating endpoints and provider settings.
    pub fn new(config: MayanSwiftV2BridgeConfig) -> BridgeResult<Self> {
        Ok(Self {
            config: Arc::new(normalize_bridge_config(config)?),
            #[cfg(test)]
            clock: None,
        })
    }

    /// Creates a client with the default Mayan endpoints.
    pub fn default_client() -> BridgeResult<Self> {
        Self::new(MayanSwiftV2BridgeConfig::default())
    }

    /// Returns an immutable copy of the configured builder endpoint.
    #[must_use]
    pub fn builder_endpoint(&self) -> String {
        self.config.builder_endpoint.to_string()
    }

    /// Returns an immutable copy of the configured explorer endpoint.
    #[must_use]
    pub fn explorer_endpoint(&self) -> String {
        self.config.explorer_endpoint.to_string()
    }

    /// Quotes native issued EURC in one of the two reviewed directions.
    pub async fn quote_exact_input<R>(&self, request: R) -> BridgeResult<Vec<MayanSwiftV2Quote>>
    where
        R: Borrow<MayanSwiftV2QuoteRequest>,
    {
        self.quote_exact_input_with(request.borrow(), None).await
    }

    /// Quotes native issued EURC with optional cancellation.
    pub async fn quote_exact_input_with<R>(
        &self,
        request: R,
        cancellation: Option<&CancellationToken>,
    ) -> BridgeResult<Vec<MayanSwiftV2Quote>>
    where
        R: Borrow<MayanSwiftV2QuoteRequest>,
    {
        let request = request.borrow().clone();
        let (request, facts, capability) = normalize_quote_request(&request, self)?;
        let body = quote_request_body(&request, &facts);
        let endpoint = endpoint_with_path(&self.config.builder_endpoint, "/quote");
        let response = self
            .provider_json(
                endpoint,
                reqwest::Method::POST,
                Some(body),
                false,
                ProviderOperation::Quote,
                cancellation,
            )
            .await?;
        quote_from_response(&response, &request, &facts, &capability, self)
    }

    /// Builds a provider unsigned source transaction from a signed quote.
    pub async fn build_unsigned<R>(&self, request: R) -> BridgeResult<MayanSwiftV2Build>
    where
        R: Borrow<MayanSwiftV2BuildRequest>,
    {
        self.build_unsigned_with(request.borrow(), None).await
    }

    /// Builds a provider unsigned source transaction with optional cancellation.
    pub async fn build_unsigned_with<R>(
        &self,
        request: R,
        cancellation: Option<&CancellationToken>,
    ) -> BridgeResult<MayanSwiftV2Build>
    where
        R: Borrow<MayanSwiftV2BuildRequest>,
    {
        let request = request.borrow().clone();
        let (route_request, facts, _capability) = normalize_quote_request(
            &MayanSwiftV2QuoteRequest {
                source_chain_id: request.quote.source_chain_id.clone(),
                destination_chain_id: request.quote.destination_chain_id.clone(),
                source_token_deployment_id: request.quote.source_token_deployment_id.clone(),
                destination_token_deployment_id: request
                    .quote
                    .destination_token_deployment_id
                    .clone(),
                amount_in: request.quote.amount_in.clone(),
                slippage_bps: request.quote.slippage_bps,
            },
            self,
        )
        .map_err(|_| bridge_error(BridgeErrorCode::QuoteMismatch))?;
        let swapper_address = normalize_chain_address(
            &request.swapper_address,
            facts.source_chain_id,
            BridgeErrorCode::InvalidArgument,
        )?;
        let destination_address = normalize_chain_address(
            &request.destination_address,
            facts.destination_chain_id,
            BridgeErrorCode::InvalidArgument,
        )?;
        let refund_address = request
            .refund_address
            .as_deref()
            .map(|address| {
                normalize_chain_address(
                    address,
                    facts.source_chain_id,
                    BridgeErrorCode::InvalidArgument,
                )
            })
            .transpose()?;
        if self.config.builder_api_key.is_none() && !self.config.allow_unauthenticated_build {
            return Err(bridge_error(BridgeErrorCode::ProviderAuthRequired));
        }
        let quote = validate_raw_quote_for_build(&request.quote, &route_request, &facts, self)?;
        let body = build_request_body(
            &quote,
            facts.source_chain_id,
            &swapper_address,
            &destination_address,
            refund_address.as_deref(),
        )?;
        let endpoint = endpoint_with_path(&self.config.builder_endpoint, "/build");
        let response = self
            .provider_json(
                endpoint,
                reqwest::Method::POST,
                Some(body),
                true,
                ProviderOperation::Build,
                cancellation,
            )
            .await?;
        ensure_quote_deadline(
            &quote.deadline,
            self.config.minimum_quote_validity_seconds,
            self,
        )?;
        validate_build_response(&response, &quote, &facts, &swapper_address).map_err(|error| {
            if error.code() == BridgeErrorCode::ProviderInvalidResponse {
                bridge_error(BridgeErrorCode::BuildInvalid)
            } else {
                error
            }
        })
    }

    /// Reads one indexed source transaction status from Mayan Explorer.
    pub async fn get_status<R>(&self, request: R) -> BridgeResult<MayanSwiftV2Status>
    where
        R: Borrow<MayanSwiftV2StatusRequest>,
    {
        self.get_status_with(request.borrow(), None).await
    }

    /// Reads indexed status with optional cancellation.
    pub async fn get_status_with<R>(
        &self,
        request: R,
        cancellation: Option<&CancellationToken>,
    ) -> BridgeResult<MayanSwiftV2Status>
    where
        R: Borrow<MayanSwiftV2StatusRequest>,
    {
        let request = request.borrow().clone();
        let normalized = normalize_status_request(&request)?;
        let endpoint = endpoint_with_path(
            &self.config.explorer_endpoint,
            &format!("/swap/trx/{}", percent_encode_path_segment(&normalized.1)),
        );
        let response = self
            .provider_json(
                endpoint,
                reqwest::Method::GET,
                None,
                false,
                ProviderOperation::Status,
                cancellation,
            )
            .await?;
        status_from_response(&response, &normalized)
    }

    /// Closes no external resources; this client owns no caller HTTP client.
    pub fn close(&self) {}

    #[cfg(test)]
    #[allow(dead_code)]
    fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = Some(clock);
        self
    }

    #[cfg(test)]
    fn now_seconds(&self) -> BridgeResult<u64> {
        if let Some(clock) = self.clock {
            return Ok(clock());
        }
        current_wall_clock()
    }

    #[cfg(not(test))]
    #[allow(clippy::unused_self)]
    fn now_seconds(&self) -> BridgeResult<u64> {
        current_wall_clock()
    }

    async fn provider_json(
        &self,
        endpoint: Url,
        method: reqwest::Method,
        body: Option<String>,
        include_builder_key: bool,
        operation: ProviderOperation,
        cancellation: Option<&CancellationToken>,
    ) -> BridgeResult<ProviderResponse> {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(bridge_error(BridgeErrorCode::Aborted));
        }
        let mut request = self
            .config
            .http_client
            .request(method, endpoint)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        if include_builder_key {
            if let Some(key) = &self.config.builder_api_key {
                let key = HeaderValue::from_str(key)
                    .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?;
                request = request.header("x-api-key", key);
            }
        }
        let operation = async {
            let response = request
                .send()
                .await
                .map_err(|_| bridge_error(BridgeErrorCode::ProviderTransport))?;
            let status = response.status().as_u16();
            if matches!(operation, ProviderOperation::Status) && status == 404 {
                return Err(bridge_error_status(BridgeErrorCode::StatusNotFound, status));
            }
            if (300..400).contains(&status) {
                return Err(bridge_error_status(
                    BridgeErrorCode::ProviderTransport,
                    status,
                ));
            }
            if matches!(operation, ProviderOperation::Build) && (status == 401 || status == 403) {
                return Err(bridge_error_status(
                    BridgeErrorCode::ProviderAuthRequired,
                    status,
                ));
            }
            if status != 200 && status != 201 {
                return Err(bridge_error_status(BridgeErrorCode::ProviderHttp, status));
            }
            let body = read_response_body(response).await?;
            parse_provider_response(body)
        };
        let timed = tokio::time::timeout(self.config.timeout, operation);
        if let Some(cancellation) = cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => Err(bridge_error(BridgeErrorCode::Aborted)),
                result = timed => result.map_err(|_| bridge_error(BridgeErrorCode::Timeout))?,
            }
        } else {
            timed
                .await
                .map_err(|_| bridge_error(BridgeErrorCode::Timeout))?
        }
    }
}

/// Creates a standalone Mayan Swift v2 bridge client.
pub fn create_mayan_swift_v2_bridge_client(
    config: MayanSwiftV2BridgeConfig,
) -> BridgeResult<MayanSwiftV2BridgeClient> {
    MayanSwiftV2BridgeClient::new(config)
}

fn current_wall_clock() -> BridgeResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))
}

async fn read_response_body(mut response: Response) -> BridgeResult<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| bridge_error(BridgeErrorCode::ProviderTransport))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| bridge_error(BridgeErrorCode::ProviderInvalidResponse))
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn is_evm_address(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(u8::is_ascii_hexdigit)
}

fn is_zero_evm_address(value: &str) -> bool {
    is_evm_address(value) && value[2..].bytes().all(|byte| byte == b'0')
}

fn normalize_evm_address(value: &str, code: BridgeErrorCode) -> BridgeResult<String> {
    if !is_evm_address(value) || is_zero_evm_address(value) {
        return Err(bridge_error(code));
    }
    Ok(format!("0x{}", value[2..].to_ascii_lowercase()))
}

fn normalize_positive_uint64(value: &str, code: BridgeErrorCode) -> BridgeResult<(String, u64)> {
    if value.is_empty()
        || value.len() > UINT64_DECIMAL_MAX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.as_bytes()[0] == b'0')
    {
        return Err(bridge_error(code));
    }
    let parsed = value.parse::<u128>().map_err(|_| bridge_error(code))?;
    if parsed == 0 || parsed > UINT64_MAX {
        return Err(bridge_error(code));
    }
    Ok((
        value.to_owned(),
        u64::try_from(parsed).map_err(|_| bridge_error(code))?,
    ))
}

fn normalize_canonical_uint64(value: &str, code: BridgeErrorCode) -> BridgeResult<(String, u64)> {
    if value.is_empty()
        || value.len() > UINT64_DECIMAL_MAX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.as_bytes()[0] == b'0')
    {
        return Err(bridge_error(code));
    }
    let parsed = value.parse::<u128>().map_err(|_| bridge_error(code))?;
    if parsed > UINT64_MAX {
        return Err(bridge_error(code));
    }
    Ok((
        value.to_owned(),
        u64::try_from(parsed).map_err(|_| bridge_error(code))?,
    ))
}

fn normalize_slippage(value: u64, code: BridgeErrorCode) -> BridgeResult<u64> {
    if value > 500 {
        return Err(bridge_error(code));
    }
    Ok(value)
}

fn normalize_quote_request(
    request: &MayanSwiftV2QuoteRequest,
    _client: &MayanSwiftV2BridgeClient,
) -> BridgeResult<(MayanSwiftV2QuoteRequest, DirectionFacts, BridgeCapability)> {
    let (amount_in, _) =
        normalize_positive_uint64(&request.amount_in, BridgeErrorCode::InvalidArgument)?;
    let slippage_bps = normalize_slippage(request.slippage_bps, BridgeErrorCode::InvalidArgument)?;
    let facts = direction_facts(&request.source_chain_id, &request.destination_chain_id)?;
    if request.source_token_deployment_id != facts.source_token_deployment_id
        || request.destination_token_deployment_id != facts.destination_token_deployment_id
    {
        return Err(bridge_error(BridgeErrorCode::UnsupportedRoute));
    }
    validate_catalog_direction(&facts)?;
    let capability = find_capability(&facts)?;
    Ok((
        MayanSwiftV2QuoteRequest {
            source_chain_id: request.source_chain_id.clone(),
            destination_chain_id: request.destination_chain_id.clone(),
            source_token_deployment_id: request.source_token_deployment_id.clone(),
            destination_token_deployment_id: request.destination_token_deployment_id.clone(),
            amount_in,
            slippage_bps,
        },
        facts,
        capability,
    ))
}

fn normalize_chain_address(
    value: &str,
    chain_id: &str,
    code: BridgeErrorCode,
) -> BridgeResult<String> {
    if chain_id == ETHEREUM_CHAIN_ID {
        return normalize_evm_address(value, code);
    }
    decode_base58(value, 32).map_err(|()| bridge_error(code))?;
    Ok(value.to_owned())
}

fn normalize_status_request(
    request: &MayanSwiftV2StatusRequest,
) -> BridgeResult<(MayanSwiftV2StatusRequest, String)> {
    if request.source_chain_id == ETHEREUM_CHAIN_ID {
        let source_transaction_hash = request.source_transaction_hash.as_str();
        if !is_evm_hash(source_transaction_hash) {
            return Err(bridge_error(BridgeErrorCode::InvalidArgument));
        }
        return Ok((
            request.clone(),
            format!("0x{}", source_transaction_hash[2..].to_ascii_lowercase()),
        ));
    }
    if request.source_chain_id == SOLANA_CHAIN_ID {
        decode_base58(&request.source_transaction_hash, 64)
            .map_err(|()| bridge_error(BridgeErrorCode::InvalidArgument))?;
        return Ok((request.clone(), request.source_transaction_hash.clone()));
    }
    Err(bridge_error(BridgeErrorCode::UnsupportedRoute))
}

fn is_evm_hash(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 66
        && bytes[0] == b'0'
        && bytes[1] == b'x'
        && bytes[2..].iter().all(u8::is_ascii_hexdigit)
}

fn quote_request_body(request: &MayanSwiftV2QuoteRequest, facts: &DirectionFacts) -> String {
    format!(
        "{{\"fromToken\":{},\"fromChain\":{},\"toToken\":{},\"toChain\":{},\"amountIn64\":{},\"slippageBps\":{},\"swift\":true,\"mctp\":false,\"fastMctp\":false,\"wormhole\":false,\"monoChain\":false,\"gasless\":false,\"fullList\":true,\"guaranteedOutput\":true,\"gasDrop\":0}}",
        serde_json::to_string(facts.source_token_address).expect("address serializes"),
        serde_json::to_string(facts.source_provider_chain_name).expect("chain serializes"),
        serde_json::to_string(facts.destination_token_address).expect("address serializes"),
        serde_json::to_string(facts.destination_provider_chain_name).expect("chain serializes"),
        serde_json::to_string(&request.amount_in).expect("amount serializes"),
        request.slippage_bps,
    )
}

fn build_request_body(
    quote: &MayanSwiftV2Quote,
    source_chain_id: &str,
    swapper_address: &str,
    destination_address: &str,
    refund_address: Option<&str>,
) -> BridgeResult<String> {
    let mut params = format!(
        "{{\"swapperAddress\":{},\"destinationAddress\":{}",
        serde_json::to_string(swapper_address)
            .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?,
        serde_json::to_string(destination_address)
            .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?,
    );
    if source_chain_id == ETHEREUM_CHAIN_ID {
        params.push_str(",\"signerChainId\":1");
    }
    if let Some(refund_address) = refund_address {
        params.push_str(",\"swiftRefundAddress\":");
        params.push_str(
            &serde_json::to_string(refund_address)
                .map_err(|_| bridge_error(BridgeErrorCode::InvalidArgument))?,
        );
    }
    params.push('}');
    Ok(format!(
        "{{\"quote\":{},\"params\":{}}}",
        quote.raw_signed_quote_json, params
    ))
}

fn encode_base58(bytes: &[u8]) -> String {
    let zeroes = bytes.iter().take_while(|byte| **byte == 0).count();
    if zeroes == bytes.len() {
        return "1".repeat(zeroes);
    }
    let mut digits = vec![0_u8];
    for byte in bytes {
        let mut carry = u32::from(*byte);
        for digit in &mut digits {
            let value = u32::from(*digit) * 256 + carry;
            *digit = u8::try_from(value % 58).expect("base58 digit is bounded");
            carry = value / 58;
        }
        while carry > 0 {
            digits.push(u8::try_from(carry % 58).expect("base58 digit is bounded"));
            carry /= 58;
        }
    }
    let mut result = "1".repeat(zeroes);
    for digit in digits.iter().rev() {
        result.push(BASE58_ALPHABET[usize::from(*digit)] as char);
    }
    result
}

fn decode_base58(value: &str, expected_bytes: usize) -> Result<Vec<u8>, ()> {
    if value.is_empty() || value.len() > expected_bytes.saturating_mul(2) {
        return Err(());
    }
    let mut bytes = vec![0_u8];
    for character in value.bytes() {
        let Some(digit) = BASE58_ALPHABET.iter().position(|entry| *entry == character) else {
            return Err(());
        };
        let mut carry = u32::try_from(digit).expect("base58 digit index is bounded");
        for byte in &mut bytes {
            let current = u32::from(*byte) * 58 + carry;
            *byte = u8::try_from(current % 256).expect("base58 byte is bounded");
            carry = current / 256;
        }
        while carry > 0 {
            bytes.push(u8::try_from(carry % 256).expect("base58 byte is bounded"));
            carry /= 256;
        }
    }
    let zeroes = value.bytes().take_while(|byte| *byte == b'1').count();
    let body_len = usize::from(!(bytes.len() == 1 && bytes[0] == 0)) * bytes.len();
    let mut result = vec![0_u8; zeroes + body_len];
    if body_len > 0 {
        for (index, byte) in bytes.iter().enumerate() {
            let destination = result.len() - 1 - index;
            result[destination] = *byte;
        }
    }
    if result.len() != expected_bytes || encode_base58(&result) != value {
        return Err(());
    }
    Ok(result)
}

const BASE64_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_digit(value: u8) -> Option<u8> {
    BASE64_ALPHABET
        .iter()
        .position(|entry| *entry == value)
        .and_then(|value| u8::try_from(value).ok())
}

fn decode_base64(value: &str) -> Result<Vec<u8>, ()> {
    if value.is_empty() || value.len() % 4 != 0 {
        return Err(());
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(value.len() / 4 * 3);
    for (group_index, group) in bytes.chunks_exact(4).enumerate() {
        let last = group_index + 1 == bytes.len() / 4;
        let first = base64_digit(group[0]).ok_or(())?;
        let second = base64_digit(group[1]).ok_or(())?;
        let third = if group[2] == b'=' {
            if !last || group[3] != b'=' {
                return Err(());
            }
            None
        } else {
            Some(base64_digit(group[2]).ok_or(())?)
        };
        let fourth = if group[3] == b'=' {
            if !last {
                return Err(());
            }
            None
        } else {
            Some(base64_digit(group[3]).ok_or(())?)
        };
        decoded.push((first << 2) | (second >> 4));
        if let Some(third) = third {
            decoded.push((second << 4) | (third >> 2));
            if let Some(fourth) = fourth {
                decoded.push((third << 6) | fourth);
            } else if third & 0x03 != 0 {
                return Err(());
            }
        } else if second & 0x0f != 0 {
            return Err(());
        }
    }
    if encode_base64(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

fn encode_base64(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(BASE64_ALPHABET[usize::from(first >> 2)] as char);
        encoded.push(BASE64_ALPHABET[usize::from(((first << 4) | (second >> 4)) & 0x3f)] as char);
        if chunk.len() > 1 {
            encoded
                .push(BASE64_ALPHABET[usize::from(((second << 2) | (third >> 6)) & 0x3f)] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(BASE64_ALPHABET[usize::from(third & 0x3f)] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

struct ByteCursor<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, index: 0 }
    }

    fn read(&mut self, count: usize) -> Result<&'a [u8], ()> {
        let end = self.index.checked_add(count).ok_or(())?;
        if end > self.bytes.len() {
            return Err(());
        }
        let value = &self.bytes[self.index..end];
        self.index = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, ()> {
        Ok(self.read(1)?[0])
    }
}

fn read_short_vec(cursor: &mut ByteCursor<'_>, maximum: usize) -> Result<usize, ()> {
    let mut value = 0_usize;
    let mut shift = 0_u32;
    for count in 0..5 {
        let byte = cursor.byte()?;
        let payload = usize::from(byte & 0x7f);
        if shift >= usize::BITS || payload > (usize::MAX >> shift) {
            return Err(());
        }
        value |= payload << shift;
        if byte & 0x80 == 0 {
            if count > 0 && payload == 0 {
                return Err(());
            }
            if value > maximum {
                return Err(());
            }
            return Ok(value);
        }
        shift += 7;
    }
    Err(())
}

fn all_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}

#[allow(clippy::ignored_unit_patterns, clippy::too_many_lines)]
fn validate_solana_transaction(encoded: &str, fee_payer: &str) -> BridgeResult<String> {
    let bytes = decode_base64(encoded).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if bytes.is_empty() || bytes.len() > 1_232 {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let mut cursor = ByteCursor::new(&bytes);
    let signature_count =
        read_short_vec(&mut cursor, 1).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if signature_count != 1
        || !all_zero(
            cursor
                .read(64)
                .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?,
        )
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    if cursor
        .byte()
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?
        != 0x80
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let required_signatures = cursor
        .byte()
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let readonly_signed = cursor
        .byte()
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let readonly_unsigned = cursor
        .byte()
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if required_signatures != 1 || readonly_signed != 0 {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let static_key_count =
        read_short_vec(&mut cursor, 64).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if static_key_count == 0 || usize::from(readonly_unsigned) >= static_key_count {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let static_keys = cursor
        .read(static_key_count * 32)
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let payer_bytes =
        decode_base58(fee_payer, 32).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if static_keys[..32] != payer_bytes[..] {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    cursor
        .read(32)
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let instruction_count =
        read_short_vec(&mut cursor, 64).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let mut largest_account_index = None;
    for _ in 0..instruction_count {
        let program_index = cursor
            .byte()
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        largest_account_index =
            Some(largest_account_index.map_or(program_index, |value: u8| value.max(program_index)));
        let account_count = read_short_vec(&mut cursor, 64)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        for account_index in cursor
            .read(account_count)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?
        {
            largest_account_index = Some(
                largest_account_index.map_or(*account_index, |value| value.max(*account_index)),
            );
        }
        let data_length = read_short_vec(&mut cursor, 1_024)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        cursor
            .read(data_length)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    }
    let lookup_count =
        read_short_vec(&mut cursor, 32).map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    let mut loaded_address_count = 0_usize;
    for _ in 0..lookup_count {
        cursor
            .read(32)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        let writable_count = read_short_vec(&mut cursor, 64)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        cursor
            .read(writable_count)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        let readonly_count = read_short_vec(&mut cursor, 64)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        cursor
            .read(readonly_count)
            .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
        loaded_address_count = loaded_address_count
            .checked_add(writable_count + readonly_count)
            .ok_or_else(|| bridge_error(BridgeErrorCode::BuildInvalid))?;
        if loaded_address_count > 256 {
            return Err(bridge_error(BridgeErrorCode::BuildInvalid));
        }
    }
    if largest_account_index
        .is_some_and(|index| usize::from(index) >= static_key_count + loaded_address_count)
        || cursor.index != bytes.len()
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    Ok(encoded.to_owned())
}

fn provider_invalid<T>() -> BridgeResult<T> {
    Err(bridge_error(BridgeErrorCode::ProviderInvalidResponse))
}

fn provider_string(node: &JsonNode, key: &str, allow_empty: bool) -> BridgeResult<String> {
    let value = object_value(node, key)
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;
    let Some(value) = value.as_str() else {
        return provider_invalid();
    };
    if !allow_empty && value.is_empty() {
        return provider_invalid();
    }
    Ok(value.to_owned())
}

fn provider_bool(node: &JsonNode, key: &str) -> BridgeResult<bool> {
    let value = object_value(node, key)
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;
    value
        .as_bool()
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))
}

fn provider_number(node: &JsonNode, key: &str) -> BridgeResult<f64> {
    let value = object_value(node, key)
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;
    let Some(number) = value.as_number() else {
        return provider_invalid();
    };
    let Some(number) = number.as_f64() else {
        return provider_invalid();
    };
    if !number.is_finite() {
        return provider_invalid();
    }
    Ok(number)
}

fn provider_integer(node: &JsonNode, key: &str) -> BridgeResult<i64> {
    let number = provider_number(node, key)?;
    if let Some(value) = object_value(node, key)
        .and_then(Value::as_number)
        .and_then(serde_json::Number::as_i64)
    {
        return Ok(value);
    }
    if let Some(value) = object_value(node, key)
        .and_then(Value::as_number)
        .and_then(serde_json::Number::as_u64)
    {
        return i64::try_from(value)
            .map_err(|_| bridge_error(BridgeErrorCode::ProviderInvalidResponse));
    }
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    {
        if number.fract() != 0.0 || number < i64::MIN as f64 || number > i64::MAX as f64 {
            return provider_invalid();
        }
        Ok(number as i64)
    }
}

fn provider_address(node: &JsonNode, key: &str, expected: &str) -> BridgeResult<String> {
    let value = provider_string(node, key, false)?;
    let matches = if is_evm_address(expected) {
        is_evm_address(&value) && value.eq_ignore_ascii_case(expected)
    } else {
        value == expected
    };
    if !matches {
        return provider_invalid();
    }
    if is_evm_address(&value) {
        Ok(format!("0x{}", &value[2..].to_ascii_lowercase()))
    } else {
        Ok(value)
    }
}

fn provider_uint64(node: &JsonNode, key: &str, positive: bool) -> BridgeResult<(String, u64)> {
    let value = provider_string(node, key, false)?;
    if positive {
        normalize_positive_uint64(&value, BridgeErrorCode::ProviderInvalidResponse)
    } else {
        normalize_canonical_uint64(&value, BridgeErrorCode::ProviderInvalidResponse)
    }
}

fn provider_token(
    node: &JsonNode,
    expected_address: &str,
    expected_standard: &str,
    expected_chain_id: i64,
    expected_wormhole_chain_id: i64,
    expected_mint: &str,
) -> BridgeResult<()> {
    if !matches!(node.value, Value::Object(_)) {
        return provider_invalid();
    }
    provider_address(node, "contract", expected_address)?;
    let mint = provider_string(node, "mint", true)?;
    if mint != expected_mint {
        return provider_invalid();
    }
    provider_address(node, "realOriginContractAddress", expected_address)?;
    if provider_string(node, "name", false)? != "EuroC" {
        return provider_invalid();
    }
    if provider_string(node, "standard", false)? != expected_standard {
        return provider_invalid();
    }
    if provider_integer(node, "chainId")? != expected_chain_id
        || provider_integer(node, "wChainId")? != expected_wormhole_chain_id
        || provider_integer(node, "realOriginChainId")? != expected_wormhole_chain_id
        || provider_integer(node, "decimals")? != 6
    {
        return provider_invalid();
    }
    Ok(())
}

fn quote_provider_standard(facts: &DirectionFacts) -> &'static str {
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        "erc20"
    } else {
        "spl"
    }
}

fn ensure_quote_deadline(
    deadline: &str,
    margin: u64,
    client: &MayanSwiftV2BridgeClient,
) -> BridgeResult<()> {
    let (_, deadline) = normalize_positive_uint64(deadline, BridgeErrorCode::QuoteExpired)?;
    let now = client.now_seconds()?;
    let minimum = now
        .checked_add(margin)
        .ok_or_else(|| bridge_error(BridgeErrorCode::QuoteExpired))?;
    if deadline < minimum {
        return Err(bridge_error(BridgeErrorCode::QuoteExpired));
    }
    Ok(())
}

struct ValidatedProviderQuote {
    quote: MayanSwiftV2Quote,
}

#[allow(clippy::too_many_lines)]
fn validate_provider_quote(
    node: &JsonNode,
    response: &ProviderResponse,
    request: &MayanSwiftV2QuoteRequest,
    facts: &DirectionFacts,
    client: &MayanSwiftV2BridgeClient,
) -> BridgeResult<ValidatedProviderQuote> {
    if !matches!(node.value, Value::Object(_)) {
        return provider_invalid();
    }
    let raw = response
        .text
        .get(node.start..node.end)
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;
    if raw.len() > MAX_RAW_QUOTE_BYTES {
        return provider_invalid();
    }
    if provider_string(node, "type", false)? != "SWIFT"
        || provider_string(node, "swiftVersion", false)? != "V2"
        || provider_bool(node, "gasless")?
    {
        return provider_invalid();
    }
    if provider_string(node, "fromChain", false)? != facts.source_provider_chain_name
        || provider_string(node, "toChain", false)? != facts.destination_provider_chain_name
        || provider_integer(node, "slippageBps")?
            != i64::try_from(request.slippage_bps).expect("bridge slippage is bounded")
        || provider_bool(node, "onlyBridging")?
    {
        return provider_invalid();
    }
    let effective_amount = provider_uint64(node, "effectiveAmountIn64", true)?;
    if effective_amount.0 != request.amount_in {
        return provider_invalid();
    }
    let expected_amount_out = provider_uint64(node, "expectedAmountOutBaseUnits", true)?;
    let minimum_amount_out = provider_uint64(node, "minAmountOutBaseUnits", true)?;
    let minimum_received = provider_uint64(node, "minReceivedBaseUnits", true)?;
    if minimum_amount_out.1 > expected_amount_out.1 || minimum_received.1 > minimum_amount_out.1 {
        return provider_invalid();
    }
    let deadline = provider_uint64(node, "deadline64", true)?;
    ensure_quote_deadline(
        &deadline.0,
        client.config.minimum_quote_validity_seconds,
        client,
    )?;

    let source_token = required_node(node, "fromToken")?;
    let destination_token = required_node(node, "toToken")?;
    provider_token(
        source_token,
        facts.source_token_address,
        if facts.source_chain_id == ETHEREUM_CHAIN_ID {
            "erc20"
        } else {
            "spl"
        },
        i64::from(facts.source_provider_chain_id),
        i64::from(facts.source_wormhole_chain_id),
        if facts.source_chain_id == ETHEREUM_CHAIN_ID {
            ""
        } else {
            SOLANA_EURC_ADDRESS
        },
    )?;
    provider_token(
        destination_token,
        facts.destination_token_address,
        if facts.destination_chain_id == ETHEREUM_CHAIN_ID {
            "erc20"
        } else {
            "spl"
        },
        i64::from(facts.destination_provider_chain_id),
        i64::from(facts.destination_wormhole_chain_id),
        if facts.destination_chain_id == ETHEREUM_CHAIN_ID {
            ""
        } else {
            SOLANA_EURC_ADDRESS
        },
    )?;

    let provider_standard = quote_provider_standard(facts);
    provider_address(node, "swiftInputContract", facts.source_usdc_address)?;
    if provider_string(node, "swiftInputContractStandard", false)? != provider_standard
        || provider_integer(node, "swiftInputDecimals")? != 6
    {
        return provider_invalid();
    }
    provider_address(node, "swiftMayanContract", facts.swift_contract)?;

    let middle_node = required_node(node, "minMiddleAmount")?;
    if middle_node.raw_number.is_none()
        || !middle_node
            .value
            .as_number()
            .and_then(serde_json::Number::as_f64)
            .is_some_and(|value| value.is_finite() && value > 0.0)
    {
        return provider_invalid();
    }
    let provider_minimum_amount = middle_node
        .raw_number
        .clone()
        .ok_or_else(|| bridge_error(BridgeErrorCode::ProviderInvalidResponse))?;

    let (router_kind, router_address) = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        (
            "provider-selected-evm".to_owned(),
            normalize_evm_address(
                &provider_string(node, "evmSwapRouterAddress", false)?,
                BridgeErrorCode::ProviderInvalidResponse,
            )?,
        )
    } else {
        if let Some(value) = object_value(node, "evmSwapRouterAddress") {
            if !value.is_null() {
                return provider_invalid();
            }
        }
        ("jupiter-v6".to_owned(), SOLANA_JUPITER_V6.to_owned())
    };
    let quote_id = provider_string(node, "quoteId", false)?;
    if !is_hex_text(&quote_id, 32) {
        return provider_invalid();
    }
    let signature = provider_string(node, "signature", false)?;
    if !is_hex_text(&signature, 130) {
        return provider_invalid();
    }
    Ok(ValidatedProviderQuote {
        quote: MayanSwiftV2Quote {
            quote_kind: "mayan-swift-v2".to_owned(),
            provider_id: "mayan-swift-v2".to_owned(),
            source_chain_id: request.source_chain_id.clone(),
            destination_chain_id: request.destination_chain_id.clone(),
            source_token_deployment_id: facts.source_token_deployment_id.to_owned(),
            destination_token_deployment_id: facts.destination_token_deployment_id.to_owned(),
            amount_in: effective_amount.0,
            expected_amount_out: expected_amount_out.0,
            minimum_amount_out: minimum_amount_out.0,
            minimum_received: minimum_received.0,
            deadline: deadline.0,
            slippage_bps: request.slippage_bps,
            quote_id: quote_id.to_ascii_lowercase(),
            provider_signature: signature.to_ascii_lowercase(),
            source_swap: MayanSwiftV2SourceSwap {
                required: true,
                input_token_deployment_id: facts.source_token_deployment_id.to_owned(),
                intermediate_token_deployment_id: facts.source_usdc_deployment_id.to_owned(),
                intermediate_token_address: facts.source_usdc_address.to_owned(),
                intermediate_token_standard: provider_standard.to_owned(),
                intermediate_token_decimals: 6,
                provider_minimum_amount,
                router_kind,
                router_address,
            },
            dependencies: expected_dependencies(facts.source_chain_id),
            quote_verification: "provider-signed-not-locally-verified".to_owned(),
            raw_signed_quote_json: raw.to_owned(),
        },
    })
}

fn is_hex_text(value: &str, digits: usize) -> bool {
    value.len() == digits + 2
        && value.as_bytes().first() == Some(&b'0')
        && value.as_bytes().get(1) == Some(&b'x')
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

fn quote_from_response(
    response: &ProviderResponse,
    request: &MayanSwiftV2QuoteRequest,
    facts: &DirectionFacts,
    capability: &BridgeCapability,
    client: &MayanSwiftV2BridgeClient,
) -> BridgeResult<Vec<MayanSwiftV2Quote>> {
    if !matches!(response.root.value, Value::Object(_))
        || object_value(&response.root, "success") != Some(&Value::Bool(true))
    {
        return provider_invalid();
    }
    let quotes = required_node(&response.root, "quotes")?;
    let Some(quote_nodes) = quotes.array_items.as_ref() else {
        return provider_invalid();
    };
    if quote_nodes.len() > MAX_QUOTES {
        return provider_invalid();
    }
    let mut selected = Vec::new();
    for quote_node in quote_nodes {
        if !matches!(quote_node.value, Value::Object(_)) {
            continue;
        }
        if object_value(quote_node, "type").and_then(Value::as_str) != Some("SWIFT")
            || object_value(quote_node, "swiftVersion").and_then(Value::as_str) != Some("V2")
            || object_value(quote_node, "gasless") != Some(&Value::Bool(false))
        {
            continue;
        }
        selected.push(validate_provider_quote(quote_node, response, request, facts, client)?.quote);
    }
    if selected.is_empty() {
        return Err(bridge_error(BridgeErrorCode::QuoteUnavailable));
    }
    let _ = capability;
    Ok(selected)
}

fn validate_normalized_quote_shape(
    quote: &MayanSwiftV2Quote,
) -> BridgeResult<(MayanSwiftV2Quote, DirectionFacts)> {
    if quote.quote_kind != "mayan-swift-v2"
        || quote.provider_id != "mayan-swift-v2"
        || quote.quote_verification != "provider-signed-not-locally-verified"
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let facts = direction_facts(&quote.source_chain_id, &quote.destination_chain_id)
        .map_err(|_| bridge_error(BridgeErrorCode::QuoteMismatch))?;
    if quote.source_token_deployment_id != facts.source_token_deployment_id
        || quote.destination_token_deployment_id != facts.destination_token_deployment_id
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let (amount_in, _) =
        normalize_positive_uint64(&quote.amount_in, BridgeErrorCode::QuoteMismatch)?;
    let (expected_amount_out, expected_amount_out_value) =
        normalize_positive_uint64(&quote.expected_amount_out, BridgeErrorCode::QuoteMismatch)?;
    let (minimum_amount_out, minimum_amount_out_value) =
        normalize_positive_uint64(&quote.minimum_amount_out, BridgeErrorCode::QuoteMismatch)?;
    let (minimum_received, minimum_received_value) =
        normalize_positive_uint64(&quote.minimum_received, BridgeErrorCode::QuoteMismatch)?;
    if minimum_amount_out_value > expected_amount_out_value
        || minimum_received_value > minimum_amount_out_value
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let (deadline, _) = normalize_positive_uint64(&quote.deadline, BridgeErrorCode::QuoteMismatch)?;
    normalize_slippage(quote.slippage_bps, BridgeErrorCode::QuoteMismatch)?;
    if !is_hex_text(&quote.quote_id, 32) || !is_hex_text(&quote.provider_signature, 130) {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let source_swap = &quote.source_swap;
    if !source_swap.required
        || source_swap.input_token_deployment_id != facts.source_token_deployment_id
        || source_swap.intermediate_token_deployment_id != facts.source_usdc_deployment_id
        || source_swap.intermediate_token_address != facts.source_usdc_address
        || source_swap.intermediate_token_standard != quote_provider_standard(&facts)
        || source_swap.intermediate_token_decimals != 6
        || source_swap.provider_minimum_amount.is_empty()
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let (router_kind, router_address) = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        if source_swap.router_kind != "provider-selected-evm" {
            return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
        }
        (
            "provider-selected-evm".to_owned(),
            normalize_evm_address(&source_swap.router_address, BridgeErrorCode::QuoteMismatch)?,
        )
    } else {
        if source_swap.router_kind != "jupiter-v6"
            || source_swap.router_address != SOLANA_JUPITER_V6
        {
            return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
        }
        ("jupiter-v6".to_owned(), SOLANA_JUPITER_V6.to_owned())
    };
    if quote.dependencies != expected_dependencies(facts.source_chain_id) {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    if quote.raw_signed_quote_json.is_empty()
        || quote.raw_signed_quote_json.len() > MAX_RAW_QUOTE_BYTES
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let normalized = MayanSwiftV2Quote {
        quote_kind: "mayan-swift-v2".to_owned(),
        provider_id: "mayan-swift-v2".to_owned(),
        source_chain_id: quote.source_chain_id.clone(),
        destination_chain_id: quote.destination_chain_id.clone(),
        source_token_deployment_id: facts.source_token_deployment_id.to_owned(),
        destination_token_deployment_id: facts.destination_token_deployment_id.to_owned(),
        amount_in,
        expected_amount_out,
        minimum_amount_out,
        minimum_received,
        deadline,
        slippage_bps: quote.slippage_bps,
        quote_id: quote.quote_id.to_ascii_lowercase(),
        provider_signature: quote.provider_signature.to_ascii_lowercase(),
        source_swap: MayanSwiftV2SourceSwap {
            required: true,
            input_token_deployment_id: facts.source_token_deployment_id.to_owned(),
            intermediate_token_deployment_id: facts.source_usdc_deployment_id.to_owned(),
            intermediate_token_address: facts.source_usdc_address.to_owned(),
            intermediate_token_standard: quote_provider_standard(&facts).to_owned(),
            intermediate_token_decimals: 6,
            provider_minimum_amount: quote.source_swap.provider_minimum_amount.clone(),
            router_kind,
            router_address,
        },
        dependencies: expected_dependencies(facts.source_chain_id),
        quote_verification: "provider-signed-not-locally-verified".to_owned(),
        raw_signed_quote_json: quote.raw_signed_quote_json.clone(),
    };
    Ok((normalized, facts))
}

fn validate_raw_quote_for_build(
    quote: &MayanSwiftV2Quote,
    request: &MayanSwiftV2QuoteRequest,
    facts: &DirectionFacts,
    client: &MayanSwiftV2BridgeClient,
) -> BridgeResult<MayanSwiftV2Quote> {
    let (normalized, _) = validate_normalized_quote_shape(quote)?;
    if normalized.source_chain_id != request.source_chain_id
        || normalized.destination_chain_id != request.destination_chain_id
        || normalized.amount_in != request.amount_in
        || normalized.slippage_bps != request.slippage_bps
    {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let response = parse_provider_response(quote.raw_signed_quote_json.clone())
        .map_err(|_| bridge_error(BridgeErrorCode::QuoteMismatch))?;
    if response.root.start != 0 || response.root.end != response.text.len() {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    let validated = match validate_provider_quote(&response.root, &response, request, facts, client)
    {
        Ok(value) => value.quote,
        Err(error) if error.code() == BridgeErrorCode::QuoteExpired => return Err(error),
        Err(_) => return Err(bridge_error(BridgeErrorCode::QuoteMismatch)),
    };
    if validated != normalized {
        return Err(bridge_error(BridgeErrorCode::QuoteMismatch));
    }
    Ok(normalized)
}

fn numeric_zero(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number == 0.0),
        Some(Value::String(value)) if value == "0" => true,
        Some(Value::String(value)) => {
            let bytes = value.as_bytes();
            bytes.len() >= 3
                && bytes[0] == b'0'
                && bytes[1] == b'x'
                && bytes[2..].iter().all(|byte| *byte == b'0')
        }
        _ => false,
    }
}

fn hex_bytes(value: &str) -> bool {
    value.len() >= 2
        && value.as_bytes()[0] == b'0'
        && value.as_bytes()[1] == b'x'
        && (value.len() - 2) % 2 == 0
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

fn validate_evm_build_result(
    wrapper: &JsonNode,
    swapper_address: &str,
) -> BridgeResult<MayanSwiftV2UnsignedTransaction> {
    if provider_string(wrapper, "chainCategory", false)? != "evm"
        || provider_string(wrapper, "quoteType", false)? != "SWIFT"
        || provider_bool(wrapper, "gasless")?
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let transaction = required_node(wrapper, "transaction")?;
    if !matches!(transaction.value, Value::Object(_)) {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let to = provider_address(transaction, "to", ETHEREUM_FORWARDER)
        .map_err(|_| bridge_error(BridgeErrorCode::BuildInvalid))?;
    if provider_integer(transaction, "chainId")? != 1
        || !numeric_zero(object_value(transaction, "value"))
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let data = provider_string(transaction, "data", false)?.to_ascii_lowercase();
    if !hex_bytes(&data)
        || !data.starts_with(ETHEREUM_FORWARDER_SELECTOR)
        || data.len() < 2 + 8 + 13 * 64
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    Ok(MayanSwiftV2UnsignedTransaction::Evm(
        MayanEvmUnsignedTransaction {
            kind: "evm-unsigned-transaction".to_owned(),
            chain_id: ETHEREUM_CHAIN_ID.to_owned(),
            from: swapper_address.to_owned(),
            to,
            data,
            value: "0".to_owned(),
        },
    ))
}

fn validate_solana_build_result(
    wrapper: &JsonNode,
    swapper_address: &str,
) -> BridgeResult<MayanSwiftV2UnsignedTransaction> {
    if provider_string(wrapper, "chainCategory", false)? != "svm"
        || provider_string(wrapper, "quoteType", false)? != "SWIFT"
    {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    if let Some(gasless) = object_value(wrapper, "gasless") {
        if !gasless.is_null() && gasless != &Value::Bool(false) {
            return Err(bridge_error(BridgeErrorCode::BuildInvalid));
        }
    }
    let encoded = provider_string(wrapper, "transaction", false)?;
    let encoded = validate_solana_transaction(&encoded, swapper_address)?;
    Ok(MayanSwiftV2UnsignedTransaction::Solana(
        MayanSolanaUnsignedTransaction {
            kind: "solana-v0-unsigned-transaction".to_owned(),
            chain_id: SOLANA_CHAIN_ID.to_owned(),
            fee_payer: swapper_address.to_owned(),
            transaction_base64: encoded,
        },
    ))
}

fn validate_build_response(
    response: &ProviderResponse,
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    swapper_address: &str,
) -> BridgeResult<MayanSwiftV2Build> {
    if object_value(&response.root, "success") != Some(&Value::Bool(true)) {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    let wrapper = required_node(&response.root, "transaction")?;
    if !matches!(wrapper.value, Value::Object(_)) {
        return Err(bridge_error(BridgeErrorCode::BuildInvalid));
    }
    if let Some(signers) = object_value(wrapper, "signers") {
        if !signers.is_null() && (!signers.as_array().is_some_and(Vec::is_empty)) {
            return Err(bridge_error(BridgeErrorCode::BuildInvalid));
        }
    }
    if let Some(swap_message) = object_value(wrapper, "swapMessageV0Params") {
        if !swap_message.is_null() {
            return Err(bridge_error(BridgeErrorCode::BuildInvalid));
        }
    }
    let transaction = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        validate_evm_build_result(wrapper, swapper_address)?
    } else {
        validate_solana_build_result(wrapper, swapper_address)?
    };
    let allowance = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        Some(MayanSwiftV2Allowance {
            token_deployment_id: ETHEREUM_EURC_DEPLOYMENT_ID.to_owned(),
            token_address: ETHEREUM_EURC_ADDRESS.to_owned(),
            owner: swapper_address.to_owned(),
            spender: ETHEREUM_FORWARDER.to_owned(),
            required_amount: quote.amount_in.clone(),
        })
    } else {
        None
    };
    Ok(MayanSwiftV2Build {
        build_kind: "mayan-swift-v2-unsigned".to_owned(),
        provider_id: "mayan-swift-v2".to_owned(),
        quote: quote.clone(),
        source_chain_id: quote.source_chain_id.clone(),
        destination_chain_id: quote.destination_chain_id.clone(),
        transaction,
        allowance,
        validation: MayanSwiftV2BuildValidation {
            level: "structural".to_owned(),
            quote_signature_locally_verified: false,
            transaction_semantics_locally_verified: false,
            settlement_locally_verified: false,
        },
        raw_provider_build_json: response.text.clone(),
    })
}

fn status_from_response(
    response: &ProviderResponse,
    request: &(MayanSwiftV2StatusRequest, String),
) -> BridgeResult<MayanSwiftV2Status> {
    if !matches!(response.root.value, Value::Object(_)) {
        return provider_invalid();
    }
    let provider_client_status = provider_string(&response.root, "clientStatus", false)?;
    if provider_client_status.len() > 128 {
        return provider_invalid();
    }
    let provider_status = match object_value(&response.root, "status") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.len() <= 1024 => Some(value.clone()),
        _ => return provider_invalid(),
    };
    let state = match provider_client_status.as_str() {
        "INPROGRESS" => "in-progress",
        "COMPLETED" => "completed",
        "REFUNDED" => "refunded",
        _ => "unknown",
    };
    Ok(MayanSwiftV2Status {
        status_kind: "mayan-explorer-index".to_owned(),
        provider_id: "mayan-swift-v2".to_owned(),
        source_chain_id: request.0.source_chain_id.clone(),
        source_transaction_hash: request.1.clone(),
        state: state.to_owned(),
        provider_client_status,
        provider_status,
        status_verification: "provider-indexed-not-locally-verified".to_owned(),
        raw_provider_status_json: response.text.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::Path};

    use serde_json::{Map, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
    };

    const FIXTURE: &str = include_str!("../../../registry/fixtures/mayan-swift-v2-cases.json");
    const FIXED_CLOCK: u64 = 1_789_600_000;

    fn fixture_value() -> Value {
        serde_json::from_str(FIXTURE).expect("bridge fixture is valid JSON")
    }

    fn fixture_case<'a>(fixture: &'a Value, case_id: &str) -> &'a Value {
        fixture["cases"]
            .as_array()
            .expect("bridge fixture cases")
            .iter()
            .find(|case| case["caseId"].as_str() == Some(case_id))
            .expect("bridge fixture case")
    }

    fn fixed_clock() -> u64 {
        FIXED_CLOCK
    }

    async fn read_http_request(
        stream: &mut TcpStream,
    ) -> Option<(String, String, Map<String, Value>)> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..count]);
            let header_end = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
            let header_bytes = &bytes[..header_end];
            let header_text = String::from_utf8_lossy(header_bytes);
            let request_line = header_text.lines().next()?;
            let mut parts = request_line.split_whitespace();
            let method = parts.next()?.to_owned();
            let path = parts.next()?.to_owned();
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            let body_start = header_end + 4;
            if bytes.len() < body_start + content_length {
                continue;
            }
            let body = if content_length == 0 {
                Value::Null
            } else {
                String::from_utf8(bytes[body_start..body_start + content_length].to_vec())
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            };
            let mut headers = Map::new();
            for line in header_text.lines().skip(1) {
                let Some((name, value)) = line.split_once(':') else {
                    continue;
                };
                let name = name.to_ascii_lowercase();
                if matches!(
                    name.as_str(),
                    "accept" | "content-type" | "x-api-key" | "authorization" | "cookie"
                ) {
                    headers.insert(name, Value::String(value.trim().to_owned()));
                }
            }
            headers.insert("body".to_owned(), body);
            return Some((method, path, headers));
        }
    }

    async fn write_provider_response(stream: &mut TcpStream, status: u16, body: &str) {
        let reason = match status {
            200 => "OK",
            201 => "Created",
            302 => "Found",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            429 => "Too Many Requests",
            _ => "Error",
        };
        let body = body.as_bytes();
        let headers = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(headers.as_bytes()).await;
        let _ = stream.write_all(body).await;
    }

    async fn start_provider_server(
        case: &Value,
        expected_url: String,
    ) -> (String, JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bridge fixture listener");
        let address = listener
            .local_addr()
            .expect("bridge fixture listener address");
        let status = u16::try_from(case["providerStatus"].as_u64().unwrap_or(200))
            .expect("synthetic status fits u16");
        let body = case["providerBody"].as_str().map(str::to_owned);
        let case_id = case["caseId"].as_str().unwrap_or_default().to_owned();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("bridge fixture connection");
            let Some((method, path, headers)) = read_http_request(&mut stream).await else {
                return Vec::new();
            };
            let captured = vec![json!({
                "method": method,
                "url": expected_url,
                "headers": headers.iter()
                    .filter(|(key, _)| !matches!(key.as_str(), "body" | "authorization" | "cookie"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Map<_, _>>(),
                "path": path,
                "body": headers.get("body").cloned().unwrap_or(Value::Null),
                "forbiddenHeaders": headers.iter().filter_map(|(key, value)| {
                    matches!(key.as_str(), "authorization" | "cookie")
                        .then(|| (key.clone(), value.clone()))
                }).collect::<Map<_, _>>(),
            })];
            if case_id == "quote-timeout" || case_id == "quote-aborted" {
                tokio::time::sleep(Duration::from_millis(250)).await;
                return captured;
            }
            let response_body = if body.as_deref() == Some("__SYNTHETIC_BODY_EXCEEDS_1MIB__") {
                "x".repeat(MAX_RESPONSE_BYTES + 1)
            } else {
                body.unwrap_or_default()
            };
            write_provider_response(&mut stream, status, &response_body).await;
            captured
        });
        (format!("http://{address}"), handle)
    }

    fn bridge_config(
        builder_endpoint: &str,
        explorer_endpoint: &str,
        case: &Value,
    ) -> MayanSwiftV2BridgeConfig {
        let mut config = MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(builder_endpoint)
            .with_explorer_endpoint(explorer_endpoint);
        if case["config"]["allowUnauthenticatedBuild"] == Value::Bool(true) {
            config = config.with_allow_unauthenticated_build(true);
        }
        if let Some(key) = case["config"]["builderApiKey"].as_str() {
            config = config.with_builder_api_key(key);
        }
        if let Some(seconds) = case["config"]["minimumQuoteValiditySeconds"].as_u64() {
            config = config.with_minimum_quote_validity_seconds(seconds);
        }
        if case["caseId"] == "quote-timeout" {
            config = config.with_timeout(Duration::from_millis(20));
        }
        config
    }

    async fn capture_quote_for_build(fixture: &Value, quote_case_id: &str) -> MayanSwiftV2Quote {
        let quote_case = fixture_case(fixture, quote_case_id);
        let (endpoint, server) = start_provider_server(
            quote_case,
            quote_case["httpTrace"][0]["url"]
                .as_str()
                .unwrap_or("https://tx-builder.mayan.finance/quote")
                .to_owned(),
        )
        .await;
        let request: MayanSwiftV2QuoteRequest =
            serde_json::from_value(quote_case["request"].clone()).expect("quote request");
        let client = MayanSwiftV2BridgeClient::new(
            bridge_config(&endpoint, &endpoint, quote_case).with_allow_unauthenticated_build(true),
        )
        .expect("quote client")
        .with_clock(fixed_clock);
        let quote = client
            .quote_exact_input(request)
            .await
            .expect("quote")
            .into_iter()
            .next()
            .expect("selected quote");
        server.await.expect("quote server");
        quote
    }

    #[allow(clippy::manual_let_else, clippy::too_many_lines)]
    async fn execute_fixture_case(case: &Value, fixture: &Value) -> (Value, Vec<Value>) {
        let method = case["method"].as_str().expect("fixture method");
        let case_id = case["caseId"].as_str().expect("fixture case ID");
        match method {
            "quote" => {
                let request = match serde_json::from_value::<MayanSwiftV2QuoteRequest>(
                    case["request"].clone(),
                ) {
                    Ok(request) => request,
                    Err(_) => {
                        return (
                            json!({
                                "kind": "sdk-error",
                                "code": BridgeErrorCode::InvalidArgument.as_str(),
                                "message": BridgeErrorCode::InvalidArgument.message(),
                            }),
                            Vec::new(),
                        );
                    }
                };
                if case["httpTrace"].as_array().is_some_and(Vec::is_empty) {
                    let error = MayanSwiftV2BridgeClient::new(bridge_config(
                        "http://127.0.0.1:1",
                        "http://127.0.0.1:1",
                        case,
                    ))
                    .expect("local quote client")
                    .with_clock(fixed_clock)
                    .quote_exact_input(request)
                    .await
                    .expect_err("unsupported quote case");
                    return (
                        json!({"kind":"sdk-error","code":error.code_string(),"message":error.to_string()}),
                        Vec::new(),
                    );
                }
                let expected_url = case["httpTrace"][0]["url"]
                    .as_str()
                    .unwrap_or("https://tx-builder.mayan.finance/quote")
                    .to_owned();
                let (endpoint, server) = start_provider_server(case, expected_url).await;
                let client =
                    MayanSwiftV2BridgeClient::new(bridge_config(&endpoint, &endpoint, case))
                        .expect("quote client")
                        .with_clock(fixed_clock);
                let result = if case_id == "quote-aborted" {
                    let cancellation = CancellationToken::new();
                    let task_cancellation = cancellation.clone();
                    let task_client = client.clone();
                    let task = tokio::spawn(async move {
                        task_client
                            .quote_exact_input_with(request, Some(&task_cancellation))
                            .await
                    });
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    cancellation.cancel();
                    task.await.expect("aborted quote task")
                } else {
                    client.quote_exact_input(request).await
                };
                let captured = tokio::time::timeout(Duration::from_secs(2), server)
                    .await
                    .expect("quote server completed")
                    .expect("quote server joined");
                let trace = normalize_trace(captured);
                let outcome = match result {
                    Ok(value) => json!({
                        "kind": "success",
                        "value": serde_json::to_value(value).expect("quotes serialize"),
                    }),
                    Err(error) => {
                        let mut value = json!({
                            "kind": "sdk-error",
                            "code": error.code_string(),
                            "message": error.to_string(),
                        });
                        if error.code() == BridgeErrorCode::ProviderHttp {
                            let status = error.status().expect("HTTP error status");
                            value["status"] = json!(status);
                        }
                        value
                    }
                };
                (outcome, trace)
            }
            "build" => {
                let quote_case_id = if case_id == "build-quote-mismatch" {
                    "quote-eth-sol-synthetic"
                } else {
                    case["quoteCaseId"].as_str().expect("build quote case")
                };
                let mut quote = capture_quote_for_build(fixture, quote_case_id).await;
                if case_id == "build-quote-mismatch" {
                    quote.amount_in = "100000001".to_owned();
                }
                let request = MayanSwiftV2BuildRequest {
                    quote,
                    swapper_address: case["request"]["swapperAddress"]
                        .as_str()
                        .expect("swapper address")
                        .to_owned(),
                    destination_address: case["request"]["destinationAddress"]
                        .as_str()
                        .expect("destination address")
                        .to_owned(),
                    refund_address: case["request"]["refundAddress"].as_str().map(str::to_owned),
                };
                if case["httpTrace"].as_array().is_some_and(Vec::is_empty) {
                    let client = MayanSwiftV2BridgeClient::new(bridge_config(
                        "http://127.0.0.1:1",
                        "http://127.0.0.1:1",
                        case,
                    ))
                    .expect("local build client")
                    .with_clock(fixed_clock);
                    let result = client.build_unsigned(request).await;
                    let outcome = result.map_or_else(
                        |error| {
                            json!({"kind":"sdk-error","code":error.code_string(),"message":error.to_string()})
                        },
                        |value| json!({"kind":"success","value":serde_json::to_value(value).expect("build serialize")}),
                    );
                    return (outcome, Vec::new());
                }
                let expected_url = case["httpTrace"][0]["url"]
                    .as_str()
                    .unwrap_or("https://tx-builder.mayan.finance/build")
                    .to_owned();
                let (endpoint, server) = start_provider_server(case, expected_url).await;
                let client =
                    MayanSwiftV2BridgeClient::new(bridge_config(&endpoint, &endpoint, case))
                        .expect("build client")
                        .with_clock(fixed_clock);
                let result = client.build_unsigned(request).await;
                let captured = server.await.expect("build server joined");
                let outcome = result.map_or_else(
                    |error| {
                        let mut value = json!({
                            "kind": "sdk-error",
                            "code": error.code_string(),
                            "message": error.to_string(),
                        });
                        if error.code() == BridgeErrorCode::ProviderHttp {
                            let status = error.status().expect("HTTP error status");
                            value["status"] = json!(status);
                        }
                        value
                    },
                    |value| {
                        json!({
                            "kind": "success",
                            "value": serde_json::to_value(value).expect("build serialize"),
                        })
                    },
                );
                (outcome, normalize_trace(captured))
            }
            "status" => {
                let request: MayanSwiftV2StatusRequest =
                    serde_json::from_value(case["request"].clone()).expect("status request");
                if case["httpTrace"].as_array().is_some_and(Vec::is_empty) {
                    let error = MayanSwiftV2BridgeClient::new(bridge_config(
                        "http://127.0.0.1:1",
                        "http://127.0.0.1:1",
                        case,
                    ))
                    .expect("local status client")
                    .with_clock(fixed_clock)
                    .get_status(request)
                    .await
                    .expect_err("invalid status case");
                    return (
                        json!({"kind":"sdk-error","code":error.code_string(),"message":error.to_string()}),
                        Vec::new(),
                    );
                }
                let expected_url = case["httpTrace"][0]["url"]
                    .as_str()
                    .unwrap_or("https://explorer-api.mayan.finance/v3/swap/trx/hash")
                    .to_owned();
                let (endpoint, server) = start_provider_server(case, expected_url).await;
                let client =
                    MayanSwiftV2BridgeClient::new(bridge_config(&endpoint, &endpoint, case))
                        .expect("status client")
                        .with_clock(fixed_clock);
                let result = client.get_status(request).await;
                let captured = server.await.expect("status server joined");
                let outcome = result.map_or_else(
                    |error| {
                        let mut value = json!({
                            "kind": "sdk-error",
                            "code": error.code_string(),
                            "message": error.to_string(),
                        });
                        if error.code() == BridgeErrorCode::ProviderHttp {
                            let status = error.status().expect("HTTP error status");
                            value["status"] = json!(status);
                        }
                        value
                    },
                    |value| {
                        json!({
                            "kind": "success",
                            "value": serde_json::to_value(value).expect("status serialize"),
                        })
                    },
                );
                (outcome, normalize_trace(captured))
            }
            _ => panic!("unsupported fixture method"),
        }
    }

    fn normalize_trace(captured: Vec<Value>) -> Vec<Value> {
        captured
            .into_iter()
            .map(|entry| {
                let mut trace = Map::new();
                trace.insert("method".to_owned(), entry["method"].clone());
                trace.insert("url".to_owned(), entry["url"].clone());
                trace.insert("headers".to_owned(), entry["headers"].clone());
                trace.insert("body".to_owned(), entry["body"].clone());
                if entry["forbiddenHeaders"] != Value::Object(Map::new()) {
                    trace.insert(
                        "forbiddenHeaders".to_owned(),
                        entry["forbiddenHeaders"].clone(),
                    );
                }
                Value::Object(trace)
            })
            .collect()
    }

    fn expected_error(value: &Value) -> Value {
        value.clone()
    }

    #[tokio::test]
    async fn capture_native_bridge_snapshot_when_requested() {
        let Some(output) = env::var_os("ERPC_SDK_BRIDGE_PARITY_OUTPUT") else {
            return;
        };
        let fixture = fixture_value();
        let mut behavior = Map::from_iter([
            ("quote".to_owned(), Value::Array(Vec::new())),
            ("build".to_owned(), Value::Array(Vec::new())),
            ("status".to_owned(), Value::Array(Vec::new())),
        ]);
        for case in fixture["cases"].as_array().expect("fixture cases") {
            let case_id = case["caseId"].as_str().expect("case ID");
            let method = case["method"].as_str().expect("method");
            let (outcome, trace) = execute_fixture_case(case, &fixture).await;
            assert_eq!(
                outcome,
                expected_error(&case["expected"]),
                "bridge fixture outcome mismatch for {case_id}"
            );
            let expected_trace = case["httpTrace"]
                .as_array()
                .cloned()
                .expect("fixture trace");
            assert_eq!(
                trace, expected_trace,
                "bridge fixture HTTP trace mismatch for {case_id}"
            );
            behavior[method]
                .as_array_mut()
                .expect("behavior array")
                .push(json!({"caseId":case_id,"outcome":outcome,"httpTrace":trace}));
        }
        for value in behavior.values_mut() {
            value
                .as_array_mut()
                .expect("behavior array")
                .sort_by(|left, right| left["caseId"].as_str().cmp(&right["caseId"].as_str()));
        }
        let snapshot = json!({
            "snapshotVersion": 1,
            "snapshotKind": "bridge-native-runtime",
            "language": "rust",
            "runtime": concat!(
                "Rust compiled-library unit tests (erpc-sdk ",
                env!("CARGO_PKG_VERSION"),
                ")"
            ),
            "capabilityAsOfDate": BRIDGE_CAPABILITIES_AS_OF_DATE,
            "capabilityDigest": BRIDGE_CAPABILITIES_CONTENT_DIGEST,
            "behavior": behavior,
        });
        let output = Path::new(&output);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("bridge parity output directory");
        }
        let mut encoded = serde_json::to_vec_pretty(&snapshot).expect("bridge snapshot serializes");
        encoded.push(b'\n');
        fs::write(output, encoded).expect("bridge parity snapshot write");
    }
}
