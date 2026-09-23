//! Local Mayan Swift v2 source-swap preparation and unsigned construction.
//!
//! The local path is deliberately additive to the hosted bridge client. It
//! performs bounded, read-only source-swap and caller-configured RPC reads,
//! then constructs unsigned bytes without importing keys, signing, or
//! submitting transactions.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::ignored_unit_patterns,
    clippy::manual_ignore_case_cmp,
    clippy::map_unwrap_or,
    clippy::match_same_arms,
    clippy::needless_lifetimes,
    clippy::needless_pass_by_value,
    clippy::struct_excessive_bools,
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::unnecessary_wraps,
    clippy::vec_init_then_push
)]

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use curve25519_dalek::edwards::CompressedEdwardsY;
use reqwest::{Client, Response, header::HeaderValue, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest as Sha2Digest, Sha256};
use sha3::Keccak256;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    RpcEndpointConfig,
    bridge::{
        BridgeAsset, BridgeErrorCode, BridgeResult, DirectionFacts, MayanSwiftV2Allowance,
        MayanSwiftV2BridgeClient, MayanSwiftV2Quote, MayanSwiftV2QuoteRequest,
        MayanSwiftV2UnsignedTransaction, bridge_error, decode_base58, decode_base64, encode_base58,
        encode_base64, is_evm_address, normalize_evm_address, object_value,
        parse_provider_response, required_node, validate_normalized_quote_shape,
    },
};

const DEFAULT_SOURCE_SWAP_ENDPOINT: &str = "https://price-api.mayan.finance/v3";
const MAYAN_REFERENCE_COMMIT: &str = "c4c98031aaad9264d17630d7b4de0cb18688cf78";
const MAYAN_ORACLE_SDK_VERSION: &str = "15_2_2";
const ETHEREUM_CHAIN_ID: &str = "eip155:1";
const SOLANA_CHAIN_ID: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ETHEREUM_FORWARDER: &str = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2";
const ETHEREUM_FORWARDER_PROVIDER: &str = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2";
const SOLANA_SWIFT_PROGRAM: &str = "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny";
const SOLANA_JUPITER_V6: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SOLANA_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const SOLANA_SYSVAR_RENT: &str = "SysvarRent111111111111111111111111111111111";
const SOLANA_COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
const SOLANA_CPI_PROXY_PROGRAM: &str = "D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa";
const SOLANA_ANCHOR_EVENT_AUTHORITY: &str = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const SOLANA_FEE_MANAGER_PROGRAM: &str = "5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ";
const SOLANA_MAINNET_GENESIS_HASH: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SOLANA_MAYAN_LOOKUP_TABLE: &str = "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht";
const SOLANA_ADDRESS_LOOKUP_TABLE_OWNER: &str = "AddressLookupTab1e1111111111111111111111111";
const SOLANA_ROUTE_V2_DISCRIMINATOR: &str = "bb64facc31c4af14";
const SOLANA_ROUTE_V2_WHIRLPOOL_TAIL: &str = "000001000000110010270001";
const SOLANA_ROUTE_V2_RAYDIUM_TAIL: &str = "0000010000001a10270001";
const SOLANA_WHIRLPOOL_PROGRAM: &str = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SOLANA_WHIRLPOOL_POOL: &str = "ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i";
const SOLANA_RAYDIUM_CLMM_PROGRAM: &str = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SOLANA_RAYDIUM_CLMM_POOL: &str = "2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w";
const SOLANA_INIT_ORDER_DISCRIMINATOR: &str = "204c290c27a284db";
const EVM_SOURCE_SWAP_SELECTOR: &str = "0x3f0bde25";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_ROUTER_CALLDATA_BYTES: usize = 16_384;
const MAX_SOLANA_SWAP_ACCOUNTS: usize = 64;
const MAX_SOLANA_SWAP_DATA_BYTES: usize = 4096;
const MAX_LOOKUP_TABLES: usize = 8;
const MAX_LOOKUP_TABLE_ADDRESSES: usize = 256;
const MAX_SOLANA_TRANSACTION_BYTES: usize = 1232;
const UINT64_MAX: u128 = u64::MAX as u128;

/// Local source-swap preparation context.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalContext {
    /// Previously validated hosted quote.
    pub quote: MayanSwiftV2Quote,
    /// Public source-chain swapper address.
    pub swapper_address: String,
    /// Public destination-chain recipient address.
    pub destination_address: String,
    /// Fresh caller-supplied 16-byte order nonce.
    pub order_nonce: String,
}

/// Account metadata in a source-swap instruction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalSourceSwapInstructionAccount {
    /// Account public key.
    pub pubkey: String,
    /// Whether the account is a signer.
    pub is_signer: bool,
    /// Whether the account is writable.
    pub is_writable: bool,
}

/// A validated source-swap instruction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalSourceSwapInstruction {
    /// Program public key.
    pub program_id: String,
    /// Ordered account metadata.
    pub accounts: Vec<MayanSwiftV2LocalSourceSwapInstructionAccount>,
    /// Base64 instruction data.
    pub data_base64: String,
}

/// Direct source-swap plan variant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MayanSwiftV2LocalSourceSwapPlan {
    /// No source-side conversion is required.
    None {},
    /// Ethereum EURC source conversion.
    EvmRouter {
        /// Validated router address.
        #[serde(rename = "routerAddress")]
        router_address: String,
        /// Validated router calldata.
        #[serde(rename = "calldata")]
        calldata: String,
        /// SHA-256 of the exact provider response body.
        #[serde(rename = "rawResponseSha256")]
        raw_response_sha256: String,
        /// Exact provider response body.
        #[serde(rename = "rawProviderSourceSwapJson")]
        raw_provider_source_swap_json: String,
    },
    /// Solana EURC source conversion.
    SolanaJupiterV6 {
        /// Ordered provider instructions before Swift initialization.
        #[serde(rename = "instructions")]
        instructions: Vec<MayanSwiftV2LocalSourceSwapInstruction>,
        /// Provider address lookup table addresses.
        #[serde(rename = "addressLookupTableAddresses")]
        address_lookup_table_addresses: Vec<String>,
        /// SHA-256 of the exact provider response body.
        #[serde(rename = "rawResponseSha256")]
        raw_response_sha256: String,
        /// Exact provider response body.
        #[serde(rename = "rawProviderSourceSwapJson")]
        raw_provider_source_swap_json: String,
    },
}

/// Prepared local source-swap plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2SourceSwapPlan {
    /// Plan discriminator.
    pub plan_kind: String,
    /// Provider discriminator.
    pub provider_id: String,
    /// Canonical bridge capability identifier.
    pub capability_id: String,
    /// Source chain identifier.
    pub source_chain_id: String,
    /// Destination chain identifier.
    pub destination_chain_id: String,
    /// Source token deployment identifier.
    pub source_token_deployment_id: String,
    /// Destination token deployment identifier.
    pub destination_token_deployment_id: String,
    /// Provider quote identifier.
    pub quote_id: String,
    /// SHA-256 of the exact hosted quote JSON.
    pub raw_quote_sha256: String,
    /// Caller-supplied order nonce.
    pub order_nonce: String,
    /// Normalized public source address.
    pub swapper_address: String,
    /// Normalized public destination address.
    pub destination_address: String,
    /// Keccak-256 Swift order hash.
    pub order_hash: String,
    /// SHA-256 quote/context binding hash.
    pub quote_binding_hash: String,
    /// Exact six-decimal intermediate minimum.
    pub minimum_intermediate_amount: String,
    /// Closed source-swap union.
    pub source_swap: MayanSwiftV2LocalSourceSwapPlan,
    /// SHA-256 plan binding hash.
    pub plan_hash: String,
}

/// Local build request containing a previously prepared plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalBuildRequest {
    /// Hosted normalized quote.
    pub quote: MayanSwiftV2Quote,
    /// Public source-chain swapper address.
    pub swapper_address: String,
    /// Public destination-chain recipient address.
    pub destination_address: String,
    /// Fresh caller-supplied order nonce.
    pub order_nonce: String,
    /// Prepared source-swap plan.
    pub source_swap_plan: MayanSwiftV2SourceSwapPlan,
}

/// EVM source RPC code evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalEvmCodeEvidence {
    /// Contract address.
    pub address: String,
    /// Keccak-256 of bytecode.
    pub keccak256: String,
}

/// EVM source RPC evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalEvmRpcEvidence {
    /// Evidence discriminator.
    pub kind: String,
    /// Confirmed Ethereum chain ID.
    pub rpc_chain_id: String,
    /// Ordered target code observations.
    pub code: Vec<MayanSwiftV2LocalEvmCodeEvidence>,
}

/// Solana lookup-table evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalSolanaRpcLookupTableEvidence {
    /// Lookup table address.
    pub address: String,
    /// SHA-256 of the exact account data.
    pub data_sha256: String,
}

/// Solana source RPC evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalSolanaRpcEvidence {
    /// Evidence discriminator.
    pub kind: String,
    /// Confirmed Solana mainnet genesis hash.
    pub genesis_hash: String,
    /// Blockhash context slot.
    pub blockhash_context_slot: String,
    /// Lookup-table account context slot.
    pub account_context_slot: String,
    /// Recent blockhash.
    pub recent_blockhash: String,
    /// Last valid block height.
    pub last_valid_block_height: String,
    /// Ordered lookup-table evidence.
    pub lookup_tables: Vec<MayanSwiftV2LocalSolanaRpcLookupTableEvidence>,
}

/// Source RPC evidence for either source chain.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum MayanSwiftV2LocalSourceRpcEvidence {
    /// Ethereum evidence.
    Evm(MayanSwiftV2LocalEvmRpcEvidence),
    /// Solana evidence.
    Solana(MayanSwiftV2LocalSolanaRpcEvidence),
}

/// Local construction metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalConstruction {
    /// Construction mode.
    pub mode: String,
    /// Pinned reference source commit.
    pub reference_commit: String,
    /// Caller-supplied order nonce.
    pub order_nonce: String,
    /// Keccak-256 order hash.
    pub order_hash: String,
    /// Exact six-decimal intermediate minimum.
    pub minimum_intermediate_amount: String,
    /// Local effective dependencies.
    pub effective_dependencies: Vec<String>,
    /// Sanitized source RPC evidence.
    pub source_rpc_evidence: MayanSwiftV2LocalSourceRpcEvidence,
}

/// Local build validation disclosure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MayanSwiftV2LocalBuildValidation {
    /// Validation level.
    pub level: String,
    /// Provider quote signature remains unverified.
    pub quote_signature_locally_verified: bool,
    /// Local plan/hash binding was checked.
    pub plan_binding_locally_verified: bool,
    /// Transaction bytes were constructed locally.
    pub transaction_bytes_locally_constructed: bool,
    /// Settlement remains unverified.
    pub settlement_locally_verified: bool,
}

/// Locally constructed unsigned build.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MayanSwiftV2LocalBuild {
    /// Build discriminator.
    pub build_kind: String,
    /// Provider discriminator.
    pub provider_id: String,
    /// Canonical capability identifier.
    pub capability_id: String,
    /// Original hosted quote, unchanged.
    pub quote: MayanSwiftV2Quote,
    /// Source chain identifier.
    pub source_chain_id: String,
    /// Destination chain identifier.
    pub destination_chain_id: String,
    /// Validated source-swap plan.
    pub source_swap_plan: MayanSwiftV2SourceSwapPlan,
    /// Locally constructed unsigned transaction.
    pub transaction: MayanSwiftV2UnsignedTransaction,
    /// Source-token allowance requirement for EVM sources.
    pub allowance: Option<MayanSwiftV2Allowance>,
    /// Local construction metadata.
    pub construction: MayanSwiftV2LocalConstruction,
    /// Local validation disclosure.
    pub validation: MayanSwiftV2LocalBuildValidation,
}

#[derive(Clone, Debug)]
struct ParsedLocalQuote {
    raw: Value,
    minimum_intermediate_amount: String,
    mode: u8,
    cancel_fee: u64,
    refund_fee: u64,
    submit_fee: u64,
    suggested_priority_fee: Option<u64>,
}

#[derive(Clone, Debug)]
struct LocalLookupTable {
    address: String,
    addresses: Vec<String>,
}

fn local_error(code: BridgeErrorCode) -> crate::bridge::BridgeError {
    bridge_error(code)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>, ()> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() % 2 != 0 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(());
    }
    let mut output = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let high = (chunk[0] as char).to_digit(16).ok_or(())?;
        let low = (chunk[1] as char).to_digit(16).ok_or(())?;
        output.push(u8::try_from((high << 4) | low).map_err(|_| ())?);
    }
    Ok(output)
}

fn sha256_hex(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    bytes_to_hex(&hasher.finalize())
}

fn keccak_hex(value: &[u8]) -> String {
    let mut hasher = Keccak256::new();
    hasher.update(value);
    bytes_to_hex(&hasher.finalize())
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string serializes"),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serializes"),
                        stable_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_solana_address(value: &str, code: BridgeErrorCode) -> BridgeResult<String> {
    let bytes = decode_base58(value, 32).map_err(|_| local_error(code))?;
    if encode_base58(&bytes) != value {
        return Err(local_error(code));
    }
    Ok(value.to_owned())
}

fn local_uint64(value: &str, positive: bool, code: BridgeErrorCode) -> BridgeResult<u64> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.as_bytes()[0] == b'0')
    {
        return Err(local_error(code));
    }
    let parsed = value.parse::<u128>().map_err(|_| local_error(code))?;
    if parsed > UINT64_MAX || (positive && parsed == 0) {
        return Err(local_error(code));
    }
    u64::try_from(parsed).map_err(|_| local_error(code))
}

fn local_value_string(
    value: Option<&Value>,
    code: BridgeErrorCode,
    allow_empty: bool,
) -> BridgeResult<String> {
    let Some(Value::String(value)) = value else {
        return Err(local_error(code));
    };
    if !allow_empty && value.is_empty() {
        return Err(local_error(code));
    }
    Ok(value.clone())
}

fn local_required_value<'a>(
    root: &'a Value,
    key: &str,
    code: BridgeErrorCode,
) -> BridgeResult<&'a Value> {
    root.as_object()
        .and_then(|object| object.get(key))
        .ok_or_else(|| local_error(code))
}

fn local_address_equals(value: Option<&Value>, expected: &str) -> bool {
    let Some(Value::String(value)) = value else {
        return false;
    };
    if is_evm_address(expected) {
        is_evm_address(value) && value.eq_ignore_ascii_case(expected)
    } else {
        value == expected
    }
}

fn local_native_address_bytes(
    value: &str,
    chain_id: &str,
    code: BridgeErrorCode,
) -> BridgeResult<Vec<u8>> {
    if chain_id == ETHEREUM_CHAIN_ID {
        let address = normalize_evm_address(value, code)?;
        let bytes = hex_to_bytes(&address).map_err(|_| local_error(code))?;
        let mut output = vec![0_u8; 12];
        output.extend(bytes);
        Ok(output)
    } else {
        Ok(decode_base58(&canonical_solana_address(value, code)?, 32)
            .map_err(|_| local_error(code))?)
    }
}

fn local_word_uint(value: u64) -> Vec<u8> {
    let mut output = vec![0_u8; 32];
    output[24..].copy_from_slice(&value.to_be_bytes());
    output
}

fn local_word_bytes32(value: &[u8], code: BridgeErrorCode) -> BridgeResult<Vec<u8>> {
    if value.len() != 32 {
        return Err(local_error(code));
    }
    Ok(value.to_vec())
}

fn local_word_address(value: &str, code: BridgeErrorCode) -> BridgeResult<Vec<u8>> {
    let address = normalize_evm_address(value, code)?;
    let bytes = hex_to_bytes(&address).map_err(|_| local_error(code))?;
    let mut output = vec![0_u8; 12];
    output.extend(bytes);
    Ok(output)
}

fn local_pad32(value: &[u8]) -> Vec<u8> {
    let mut output = vec![0_u8; value.len().div_ceil(32) * 32];
    output[..value.len()].copy_from_slice(value);
    output
}

fn local_abi_bytes(value: &[u8]) -> Vec<u8> {
    let mut output = local_word_uint(u64::try_from(value.len()).expect("ABI bytes fit u64"));
    output.extend(local_pad32(value));
    output
}

fn local_abi_with_dynamics(head: &[Vec<u8>], dynamics: &[Vec<u8>]) -> Vec<u8> {
    let head_size = (head.len() + dynamics.len()) * 32;
    let mut offset = head_size;
    let offsets = dynamics
        .iter()
        .map(|value| {
            let current = offset;
            offset += 32 + value.len().div_ceil(32) * 32;
            current
        })
        .collect::<Vec<_>>();
    let mut output = Vec::new();
    for word in head {
        output.extend(word);
    }
    for value in offsets {
        output.extend(local_word_uint(
            u64::try_from(value).expect("ABI offset fits u64"),
        ));
    }
    for value in dynamics {
        output.extend(local_abi_bytes(value));
    }
    output
}

fn write_u16_be(value: u16) -> [u8; 2] {
    value.to_be_bytes()
}

fn write_u16_le(value: u16) -> [u8; 2] {
    value.to_le_bytes()
}

fn write_u64_be(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

fn write_u64_le(value: u64) -> [u8; 8] {
    value.to_le_bytes()
}

fn is_on_curve_zip215(bytes: &[u8]) -> bool {
    let Ok(bytes) = <[u8; 32]>::try_from(bytes) else {
        return false;
    };
    CompressedEdwardsY(bytes).decompress().is_some()
}

fn find_program_address(
    seeds: &[&[u8]],
    program_id: &str,
    code: BridgeErrorCode,
) -> BridgeResult<String> {
    if seeds.len() > 16 || seeds.iter().any(|seed| seed.len() > 32) {
        return Err(local_error(code));
    }
    let program = decode_base58(program_id, 32).map_err(|_| local_error(code))?;
    let suffix = b"ProgramDerivedAddress";
    for bump in (0_u8..=u8::MAX).rev() {
        let mut preimage = Vec::new();
        for seed in seeds {
            preimage.extend(*seed);
        }
        preimage.push(bump);
        preimage.extend(&program);
        preimage.extend(suffix);
        let mut hasher = Sha256::new();
        hasher.update(preimage);
        let digest = hasher.finalize();
        if !is_on_curve_zip215(&digest) {
            return Ok(encode_base58(&digest));
        }
    }
    Err(local_error(code))
}

fn associated_token_address(
    owner: &str,
    mint: &str,
    allow_owner_off_curve: bool,
    code: BridgeErrorCode,
) -> BridgeResult<String> {
    let owner = decode_base58(owner, 32).map_err(|_| local_error(code))?;
    let mint = decode_base58(mint, 32).map_err(|_| local_error(code))?;
    let token_program = decode_base58(SOLANA_TOKEN_PROGRAM, 32).map_err(|_| local_error(code))?;
    if !allow_owner_off_curve && !is_on_curve_zip215(&owner) {
        return Err(local_error(code));
    }
    find_program_address(
        &[&owner, &token_program, &mint],
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        code,
    )
}

fn local_route(quote: &MayanSwiftV2Quote) -> BridgeResult<DirectionFacts> {
    validate_normalized_quote_shape(quote)
        .map(|(_, facts)| facts)
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))
}

/// Re-run the hosted quote parser against the exact raw bytes before local
/// construction.  Local DTO fields are caller supplied, so accepting a
/// normalized field without proving that it still corresponds to the raw
/// provider object would permit a quote-binding substitution.
fn trim_local_raw_trailing_json_whitespace(value: &str) -> &str {
    let mut end = value.len();
    while end > 0 && matches!(value.as_bytes()[end - 1], b' ' | b'\t' | b'\r' | b'\n') {
        end -= 1;
    }
    &value[..end]
}

fn validate_local_raw_quote(
    client: &MayanSwiftV2BridgeClient,
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
) -> BridgeResult<()> {
    let request = MayanSwiftV2QuoteRequest {
        source_chain_id: quote.source_chain_id.clone(),
        destination_chain_id: quote.destination_chain_id.clone(),
        source_token_deployment_id: quote.source_token_deployment_id.clone(),
        destination_token_deployment_id: quote.destination_token_deployment_id.clone(),
        amount_in: quote.amount_in.clone(),
        slippage_bps: quote.slippage_bps,
    };
    let mut hosted_quote = quote.clone();
    trim_local_raw_trailing_json_whitespace(&quote.raw_signed_quote_json)
        .clone_into(&mut hosted_quote.raw_signed_quote_json);
    crate::bridge::validate_raw_quote_for_build(&hosted_quote, &request, facts, client).map_or_else(
        |error| {
            if error.code() == BridgeErrorCode::QuoteExpired {
                Err(error)
            } else {
                Err(local_error(BridgeErrorCode::LocalPlanInvalid))
            }
        },
        |_| {
            let response = parse_provider_response(quote.raw_signed_quote_json.clone())
                .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
            validate_raw_router_fields(&response, quote, facts)?;
            local_raw_decimal_matches_base(
                &response,
                "expectedAmountOut",
                &quote.expected_amount_out,
            )?;
            local_raw_decimal_matches_base(&response, "minAmountOut", &quote.minimum_amount_out)?;
            local_raw_decimal_matches_base(&response, "minReceived", &quote.minimum_received)?;
            Ok(())
        },
    )
}

fn local_raw_string(root: &Value, key: &str, allow_empty: bool) -> BridgeResult<String> {
    local_value_string(
        root.as_object().and_then(|object| object.get(key)),
        BridgeErrorCode::LocalPlanInvalid,
        allow_empty,
    )
}

fn local_raw_u64(root: &Value, key: &str, positive: bool) -> BridgeResult<u64> {
    let value = local_raw_string(root, key, false)?;
    local_uint64(&value, positive, BridgeErrorCode::LocalPlanInvalid)
}

fn local_parse_integer_number(
    value: Option<&Value>,
    code: BridgeErrorCode,
) -> BridgeResult<Option<u64>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parsed = match value {
        Value::Number(value) => value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                .map(|value| value as u64)
        }),
        Value::String(value) => Some(local_uint64(value, false, code)?),
        _ => None,
    };
    let Some(parsed) = parsed else {
        return Err(local_error(code));
    };
    Ok(Some(parsed))
}

fn parse_plain_decimal(value: &str, code: BridgeErrorCode) -> BridgeResult<u64> {
    if value.is_empty() {
        return Err(local_error(code));
    }
    let (integer_part, fractional_part) = value.split_once('.').unwrap_or((value, ""));
    if integer_part.is_empty()
        || !integer_part.bytes().all(|byte| byte.is_ascii_digit())
        || (integer_part.len() > 1 && integer_part.as_bytes()[0] == b'0')
        || (!fractional_part.is_empty()
            && !fractional_part.bytes().all(|byte| byte.is_ascii_digit()))
        || (value.contains('.') && fractional_part.is_empty())
    {
        return Err(local_error(code));
    }
    let integer = integer_part
        .parse::<u128>()
        .map_err(|_| local_error(code))?;
    let kept = &fractional_part[..fractional_part.len().min(6)];
    let mut fraction = kept.to_owned();
    while fraction.len() < 6 {
        fraction.push('0');
    }
    let fraction = if fraction.is_empty() {
        0_u128
    } else {
        fraction.parse::<u128>().map_err(|_| local_error(code))?
    };
    let units = integer
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_add(fraction))
        .ok_or_else(|| local_error(code))?;
    if units == 0 || units > UINT64_MAX {
        return Err(local_error(code));
    }
    u64::try_from(units).map_err(|_| local_error(code))
}

fn binary64_rounded_decimal_units(value: &str, code: BridgeErrorCode) -> BridgeResult<u64> {
    let parsed = value.parse::<f64>().map_err(|_| local_error(code))?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(local_error(code));
    }
    let bits = parsed.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let mantissa = if exponent == 0 {
        u128::from(fraction)
    } else {
        u128::from((1_u64 << 52) | fraction)
    };
    let binary_exponent = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let mut numerator = mantissa
        .checked_mul(10_000_000)
        .ok_or_else(|| local_error(code))?;
    let mut denominator = 1_u128;
    if binary_exponent >= 0 {
        numerator = numerator
            .checked_shl(u32::try_from(binary_exponent).map_err(|_| local_error(code))?)
            .ok_or_else(|| local_error(code))?;
    } else {
        denominator = denominator
            .checked_shl(u32::try_from(-binary_exponent).map_err(|_| local_error(code))?)
            .ok_or_else(|| local_error(code))?;
    }
    let mut rounded = numerator / denominator;
    if numerator % denominator * 2 >= denominator {
        rounded = rounded.checked_add(1).ok_or_else(|| local_error(code))?;
    }
    let result = rounded / 10;
    if result == 0 || result > UINT64_MAX {
        return Err(local_error(code));
    }
    u64::try_from(result).map_err(|_| local_error(code))
}

fn local_intermediate_amount(
    lexeme: &str,
    direct_usdc: bool,
    amount_in: &str,
) -> BridgeResult<String> {
    let exact = parse_plain_decimal(lexeme, BridgeErrorCode::LocalPlanInvalid)?;
    if direct_usdc {
        let amount = local_uint64(amount_in, true, BridgeErrorCode::LocalPlanInvalid)?;
        if exact != amount {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
    } else if binary64_rounded_decimal_units(lexeme, BridgeErrorCode::LocalPlanInvalid)? != exact {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(exact.to_string())
}

fn local_destination_minimum_compatibility(value: &str) -> BridgeResult<()> {
    let units = local_uint64(value, true, BridgeErrorCode::LocalPlanInvalid)?;
    let whole = units / 1_000_000;
    let fraction = format!("{:06}", units % 1_000_000);
    let decimal = format!("{whole}.{fraction}");
    if binary64_rounded_decimal_units(&decimal, BridgeErrorCode::LocalPlanInvalid)? != units {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(())
}

fn local_raw_decimal_matches_base(
    response: &crate::bridge::ProviderResponse,
    key: &str,
    expected: &str,
) -> BridgeResult<()> {
    let node = required_node(&response.root, key)
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let lexeme = node
        .raw_number
        .as_deref()
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let exact = parse_plain_decimal(lexeme, BridgeErrorCode::LocalPlanInvalid)?;
    let binary = binary64_rounded_decimal_units(lexeme, BridgeErrorCode::LocalPlanInvalid)?;
    let canonical = local_uint64(expected, true, BridgeErrorCode::LocalPlanInvalid)?;
    if exact != canonical || binary != canonical {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(())
}

fn validate_raw_router_fields(
    response: &crate::bridge::ProviderResponse,
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
) -> BridgeResult<()> {
    if !facts.source_swap_required {
        return Ok(());
    }
    let root = &response.root.value;
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        let router = local_raw_string(root, "evmSwapRouterAddress", false)?;
        let expected_router = quote
            .source_swap
            .router_address
            .as_deref()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        let calldata = local_raw_string(root, "evmSwapRouterCalldata", false)?;
        let calldata_bytes =
            hex_to_bytes(&calldata).map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        if !local_address_equals(Some(&Value::String(router)), expected_router)
            || calldata_bytes.is_empty()
            || calldata_bytes.len() > MAX_ROUTER_CALLDATA_BYTES
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
    } else if root
        .as_object()
        .and_then(|object| object.get("evmSwapRouterAddress"))
        .is_some_and(|value| !value.is_null())
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(())
}

fn parse_local_quote(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
) -> BridgeResult<ParsedLocalQuote> {
    let response = parse_provider_response(quote.raw_signed_quote_json.clone())
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if !matches!(response.root.value, Value::Object(_)) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let root = response.root.value.clone();
    let middle_node = required_node(&response.root, "minMiddleAmount")
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let middle_lexeme = middle_node
        .raw_number
        .as_deref()
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let mode = local_required_value(&root, "swiftAuctionMode", BridgeErrorCode::LocalPlanInvalid)?
        .as_u64()
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if mode != 2 && mode != 3 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let expected_mode = if facts.asset == BridgeAsset::Usdc {
        3
    } else {
        2
    };
    if mode != expected_mode {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    if mode == 3
        && (local_raw_string(&root, "expectedAmountOutBaseUnits", false)?
            != local_raw_string(&root, "minAmountOutBaseUnits", false)?
            || local_raw_string(&root, "minAmountOutBaseUnits", false)?
                != local_raw_string(&root, "minReceivedBaseUnits", false)?)
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    for key in [
        "customPayload",
        "memoHex",
        "referrer",
        "referrerAddress",
        "swiftRefundAddress",
        "permit",
        "approval",
        "approvalBatch",
        "separateSwapTx",
        "jito",
        "extraInstructions",
    ] {
        if let Some(value) = object_value(&response.root, key) {
            if !value.is_null()
                && value != &Value::Bool(false)
                && value != &Value::String(String::new())
            {
                return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
            }
        }
    }
    let minimum_intermediate_amount = local_intermediate_amount(
        middle_lexeme,
        facts.asset == BridgeAsset::Usdc,
        &quote.amount_in,
    )?;
    let suggested_priority_fee = local_parse_integer_number(
        object_value(&response.root, "suggestedPriorityFee"),
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    if suggested_priority_fee.is_some_and(|value| value > 100_000) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(ParsedLocalQuote {
        raw: root.clone(),
        minimum_intermediate_amount,
        mode,
        cancel_fee: local_raw_u64(&root, "cancelRelayerFee64", false)?,
        refund_fee: local_raw_u64(&root, "refundRelayerFee64", false)?,
        submit_fee: local_raw_u64(&root, "submitRelayerFee64", false)?,
        suggested_priority_fee,
    })
}

fn exact_object_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    actual == expected
}

fn parse_instruction(value: &Value) -> BridgeResult<MayanSwiftV2LocalSourceSwapInstruction> {
    if !exact_object_keys(value, &["programId", "accounts", "data"]) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let object = value
        .as_object()
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let program_id = canonical_solana_address(
        object
            .get("programId")
            .and_then(Value::as_str)
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    let accounts = object
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if accounts.len() > MAX_SOLANA_SWAP_ACCOUNTS {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let mut parsed_accounts = Vec::with_capacity(accounts.len());
    for account in accounts {
        if !exact_object_keys(account, &["pubkey", "isSigner", "isWritable"]) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let account = account
            .as_object()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        parsed_accounts.push(MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: canonical_solana_address(
                account
                    .get("pubkey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
                BridgeErrorCode::LocalPlanInvalid,
            )?,
            is_signer: account
                .get("isSigner")
                .and_then(Value::as_bool)
                .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
            is_writable: account
                .get("isWritable")
                .and_then(Value::as_bool)
                .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
        });
    }
    let data_base64 = object
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let data = if data_base64.is_empty() {
        Vec::new()
    } else {
        decode_base64(data_base64).map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?
    };
    if data.len() > MAX_SOLANA_SWAP_DATA_BYTES || encode_base64(&data) != data_base64 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(MayanSwiftV2LocalSourceSwapInstruction {
        program_id,
        accounts: parsed_accounts,
        data_base64: data_base64.to_owned(),
    })
}

fn instruction_data(instruction: &MayanSwiftV2LocalSourceSwapInstruction) -> BridgeResult<Vec<u8>> {
    if instruction.data_base64.is_empty() {
        Ok(Vec::new())
    } else {
        decode_base64(&instruction.data_base64)
            .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))
    }
}

fn account_at<'a>(
    instruction: &'a MayanSwiftV2LocalSourceSwapInstruction,
    index: usize,
) -> BridgeResult<&'a MayanSwiftV2LocalSourceSwapInstructionAccount> {
    instruction
        .accounts
        .get(index)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))
}

fn assert_account(
    account: &MayanSwiftV2LocalSourceSwapInstructionAccount,
    pubkey: &str,
    is_signer: bool,
    is_writable: bool,
) -> BridgeResult<()> {
    if account.pubkey != pubkey
        || account.is_signer != is_signer
        || account.is_writable != is_writable
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(())
}

fn validate_compute_instructions(
    instructions: &[MayanSwiftV2LocalSourceSwapInstruction],
) -> BridgeResult<()> {
    if instructions.len() > 2 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let mut tags = HashSet::new();
    for instruction in instructions {
        if instruction.program_id != SOLANA_COMPUTE_BUDGET_PROGRAM
            || !instruction.accounts.is_empty()
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let data = instruction_data(instruction)?;
        let tag = *data
            .first()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        if (tag != 2 && tag != 3) || !tags.insert(tag) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        if tag == 2 {
            if data.len() != 5 {
                return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
            }
            let value = u32::from_le_bytes(data[1..5].try_into().expect("compute bytes"));
            if value > 1_400_000 {
                return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
            }
        } else {
            if data.len() != 9 {
                return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
            }
            let value = u64::from_le_bytes(data[1..9].try_into().expect("compute bytes"));
            if value > 100_000 {
                return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
            }
        }
    }
    Ok(())
}

fn validate_ata_setup(
    instructions: &[MayanSwiftV2LocalSourceSwapInstruction],
    swapper_address: &str,
    state_address: &str,
    source_usdc_address: &str,
) -> BridgeResult<()> {
    if instructions.is_empty() || instructions.len() > 2 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let mut owners = HashSet::new();
    for instruction in instructions {
        if instruction.program_id != SOLANA_ASSOCIATED_TOKEN_PROGRAM
            || instruction.accounts.len() != 6
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        assert_account(account_at(instruction, 0)?, swapper_address, true, true)?;
        let owner = &account_at(instruction, 2)?.pubkey;
        if owner != swapper_address && owner != state_address {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        // The ATA owner is data, not an additional signer or writable account.
        // A provider response that upgrades either flag could make a caller
        // sign for, or mutate, an arbitrary account during setup.
        assert_account(account_at(instruction, 2)?, owner, false, false)?;
        if !owners.insert(owner.clone()) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let expected_ata = associated_token_address(
            owner,
            source_usdc_address,
            owner == state_address,
            BridgeErrorCode::LocalPlanInvalid,
        )?;
        assert_account(account_at(instruction, 1)?, &expected_ata, false, true)?;
        assert_account(
            account_at(instruction, 3)?,
            source_usdc_address,
            false,
            false,
        )?;
        assert_account(
            account_at(instruction, 4)?,
            SOLANA_SYSTEM_PROGRAM,
            false,
            false,
        )?;
        assert_account(
            account_at(instruction, 5)?,
            SOLANA_TOKEN_PROGRAM,
            false,
            false,
        )?;
        let data = instruction_data(instruction)?;
        if !(data.is_empty() || data == [1]) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
    }
    if !owners.contains(state_address) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(())
}

fn read_u64_le(data: &[u8], start: usize) -> BridgeResult<u64> {
    let bytes = data
        .get(start..start + 8)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    Ok(u64::from_le_bytes(bytes.try_into().expect("u64 bytes")))
}

fn read_u16_le(data: &[u8], start: usize) -> BridgeResult<u16> {
    let bytes = data
        .get(start..start + 2)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    Ok(u16::from_le_bytes(bytes.try_into().expect("u16 bytes")))
}

fn validate_jupiter_instruction(
    instruction: &MayanSwiftV2LocalSourceSwapInstruction,
    facts: &DirectionFacts,
    quote: &MayanSwiftV2Quote,
    state_token_account: &str,
    swapper_address: &str,
    minimum_intermediate_amount: &str,
    source_swap_raw: &Value,
) -> BridgeResult<()> {
    if instruction.program_id != SOLANA_JUPITER_V6
        || instruction.accounts.len() < 8
        || instruction.accounts.len() > MAX_SOLANA_SWAP_ACCOUNTS
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let data = instruction_data(instruction)?;
    if data.len() < 28 || bytes_to_hex(&data[..8]) != SOLANA_ROUTE_V2_DISCRIMINATOR {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let quote_response = source_swap_raw
        .as_object()
        .and_then(|value| value.get("quoteResponse"))
        .and_then(Value::as_object)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let quote_response_raw = quote_response
        .get("raw")
        .and_then(Value::as_object)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let route_plan = quote_response_raw
        .get("routePlan")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if route_plan.len() != 1 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let swap_info = route_plan[0]
        .as_object()
        .and_then(|value| value.get("swapInfo"))
        .and_then(Value::as_object)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    for (object, key, expected) in [
        (quote_response, "inputMint", facts.source_token_address),
        (quote_response, "outputMint", facts.source_usdc_address),
        (quote_response_raw, "inputMint", facts.source_token_address),
        (quote_response_raw, "outputMint", facts.source_usdc_address),
        (swap_info, "inputMint", facts.source_token_address),
        (swap_info, "outputMint", facts.source_usdc_address),
    ] {
        if !local_address_equals(object.get(key), expected) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
    }
    let in_amount = swap_info
        .get("inAmount")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let out_amount = swap_info
        .get("outAmount")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if local_uint64(in_amount, true, BridgeErrorCode::LocalPlanInvalid)?
        != local_uint64(&quote.amount_in, true, BridgeErrorCode::LocalPlanInvalid)?
        || local_uint64(out_amount, true, BridgeErrorCode::LocalPlanInvalid)?
            < local_uint64(
                minimum_intermediate_amount,
                true,
                BridgeErrorCode::LocalPlanInvalid,
            )?
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let label = swap_info
        .get("label")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let (expected_tail, expected_count, expected_dex, expected_pool) = match label {
        "Whirlpool" => (
            SOLANA_ROUTE_V2_WHIRLPOOL_TAIL,
            22,
            SOLANA_WHIRLPOOL_PROGRAM,
            SOLANA_WHIRLPOOL_POOL,
        ),
        "Raydium CLMM" => (
            SOLANA_ROUTE_V2_RAYDIUM_TAIL,
            25,
            SOLANA_RAYDIUM_CLMM_PROGRAM,
            SOLANA_RAYDIUM_CLMM_POOL,
        ),
        _ => return Err(local_error(BridgeErrorCode::LocalPlanInvalid)),
    };
    if data.len() != 28 + expected_tail.len() / 2
        || bytes_to_hex(&data[28..]) != expected_tail
        || instruction.accounts.len() != expected_count
        || swap_info.get("ammKey").and_then(Value::as_str) != Some(expected_pool)
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    assert_account(account_at(instruction, 10)?, expected_dex, false, false)?;
    assert_account(account_at(instruction, 13)?, expected_pool, false, true)?;
    if read_u64_le(&data, 8)?
        != local_uint64(&quote.amount_in, true, BridgeErrorCode::LocalPlanInvalid)?
        || read_u64_le(&data, 16)?
            < local_uint64(
                minimum_intermediate_amount,
                true,
                BridgeErrorCode::LocalPlanInvalid,
            )?
        || read_u16_le(&data, 26)? != 0
        || read_u16_le(&data, 24)? > 10_000
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let trader_eurc = associated_token_address(
        swapper_address,
        facts.source_token_address,
        false,
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    let trader_usdc = associated_token_address(
        swapper_address,
        facts.source_usdc_address,
        false,
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    for (index, expected, signer, writable) in [
        (0, swapper_address, true, false),
        (1, trader_eurc.as_str(), false, true),
        (2, trader_usdc.as_str(), false, true),
        (3, facts.source_token_address, false, false),
        (4, facts.source_usdc_address, false, false),
        (5, SOLANA_TOKEN_PROGRAM, false, false),
        (6, SOLANA_TOKEN_PROGRAM, false, false),
        (7, state_token_account, false, true),
        (8, SOLANA_ANCHOR_EVENT_AUTHORITY, false, false),
        (9, SOLANA_JUPITER_V6, false, false),
    ] {
        assert_account(account_at(instruction, index)?, expected, signer, writable)?;
    }
    if instruction
        .accounts
        .iter()
        .any(|account| account.pubkey == swapper_address && account.is_writable)
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    validate_reviewed_route_tuple(
        instruction,
        label,
        facts,
        swapper_address,
        state_token_account,
    )?;
    Ok(())
}

/// Validate the complete reviewed Jupiter route frame.  The common prefix is
/// checked above because it carries dynamic mints and ATAs; this helper closes
/// the remaining DEX-specific positions over both public keys and flags.
fn validate_reviewed_route_tuple(
    instruction: &MayanSwiftV2LocalSourceSwapInstruction,
    label: &str,
    facts: &DirectionFacts,
    swapper_address: &str,
    state_token_account: &str,
) -> BridgeResult<()> {
    let trader_eurc = associated_token_address(
        swapper_address,
        facts.source_token_address,
        false,
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    let trader_usdc = associated_token_address(
        swapper_address,
        facts.source_usdc_address,
        false,
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    let common = [
        (0, swapper_address, true, false),
        (1, trader_eurc.as_str(), false, true),
        (2, trader_usdc.as_str(), false, true),
        (3, facts.source_token_address, false, false),
        (4, facts.source_usdc_address, false, false),
        (5, SOLANA_TOKEN_PROGRAM, false, false),
        (6, SOLANA_TOKEN_PROGRAM, false, false),
        (7, state_token_account, false, true),
        (8, SOLANA_ANCHOR_EVENT_AUTHORITY, false, false),
        (9, SOLANA_JUPITER_V6, false, false),
    ];
    for (index, pubkey, signer, writable) in common {
        assert_account(account_at(instruction, index)?, pubkey, signer, writable)?;
    }

    match label {
        "Whirlpool" => {
            let expected = [
                (10, SOLANA_WHIRLPOOL_PROGRAM, false, false),
                (11, SOLANA_TOKEN_PROGRAM, false, false),
                (12, swapper_address, false, false),
                (13, SOLANA_WHIRLPOOL_POOL, false, true),
                (14, trader_usdc.as_str(), false, true),
                (
                    15,
                    "6i68TM44UYSawGAS4Bx1vX31Af7QNZaRNBLUbc4r8exB",
                    false,
                    true,
                ),
                (16, trader_eurc.as_str(), false, true),
                (
                    17,
                    "8aq9zUXe37KLtXSaEYt7oq65oNAJiu1my2kRNMRPhTD5",
                    false,
                    true,
                ),
                (
                    18,
                    "7qscKXFXCd1WQinZJvSDLsGLTTEwjmd88a871pz2V3Ja",
                    false,
                    true,
                ),
                (
                    19,
                    "CaohZGaBaLmXyFQ4cLc83wGZTET7Mt9xMtUqR9EGaMHF",
                    false,
                    true,
                ),
                (
                    20,
                    "7Mr4WYMiGPAXkyt9ePsHHmV6ust3U6dHwBmyfMRiHPA7",
                    false,
                    true,
                ),
                (
                    21,
                    "9BjNZYSCZ3ac3XUYVKte4YYtmBGd7ATKfRshTGN99NxQ",
                    false,
                    false,
                ),
            ];
            for (index, pubkey, signer, writable) in expected {
                assert_account(account_at(instruction, index)?, pubkey, signer, writable)?;
            }
        }
        "Raydium CLMM" => {
            let expected = [
                (10, SOLANA_RAYDIUM_CLMM_PROGRAM, false, false),
                (11, swapper_address, false, false),
                (
                    12,
                    "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x",
                    false,
                    false,
                ),
                (13, SOLANA_RAYDIUM_CLMM_POOL, false, true),
                (14, trader_eurc.as_str(), false, true),
                (15, trader_usdc.as_str(), false, true),
                (
                    16,
                    "GFwsANMCPK8W3WhqTnwVP8JiwHaAr3cNDe5TJqgHHSPe",
                    false,
                    true,
                ),
                (
                    17,
                    "ECw2X1TYbsrqFgdiYApNpn2ggznbj8pL5tREpY9Fb8jY",
                    false,
                    true,
                ),
                (
                    18,
                    "2UQncszfVU7igwDiGN3jq2sUKzziLxDZqNsJEXzEob5x",
                    false,
                    true,
                ),
                (19, SOLANA_TOKEN_PROGRAM, false, false),
                (
                    20,
                    "BVvv13QAQjPYKTWrpX7wQbhBAu3pbWwTb8P9SAqgRNKQ",
                    false,
                    true,
                ),
                (
                    21,
                    "4HSR9WBSHgw7n5V8WGYYhLW8g92RPSrgnf2CHzbeQrrr",
                    false,
                    true,
                ),
                (
                    22,
                    "HssFpWsQcNbJXBro1NVWCFAYEh8jp6NJV2nyFhE1zMGj",
                    false,
                    true,
                ),
                (
                    23,
                    "DKcmVcrXuiF5FZre6h8GqurR2sKChUGBakxdTX7dSDw9",
                    false,
                    true,
                ),
                (24, SOLANA_JUPITER_V6, false, false),
            ];
            for (index, pubkey, signer, writable) in expected {
                assert_account(account_at(instruction, index)?, pubkey, signer, writable)?;
            }
        }
        _ => return Err(local_error(BridgeErrorCode::LocalPlanInvalid)),
    }
    Ok(())
}

fn wrap_in_cpi_proxy(
    instruction: MayanSwiftV2LocalSourceSwapInstruction,
) -> MayanSwiftV2LocalSourceSwapInstruction {
    let mut accounts = Vec::with_capacity(instruction.accounts.len() + 1);
    accounts.push(MayanSwiftV2LocalSourceSwapInstructionAccount {
        pubkey: instruction.program_id.clone(),
        is_signer: false,
        is_writable: false,
    });
    accounts.extend(instruction.accounts);
    MayanSwiftV2LocalSourceSwapInstruction {
        program_id: SOLANA_CPI_PROXY_PROGRAM.to_owned(),
        accounts,
        data_base64: instruction.data_base64,
    }
}

fn swift_random(quote_id: &str, order_nonce: &str, code: BridgeErrorCode) -> BridgeResult<Vec<u8>> {
    let quote_id = hex_to_bytes(quote_id).map_err(|_| local_error(code))?;
    let order_nonce = hex_to_bytes(order_nonce).map_err(|_| local_error(code))?;
    if quote_id.len() != 16 || order_nonce.len() != 16 {
        return Err(local_error(code));
    }
    let mut random = quote_id;
    random.extend(order_nonce);
    Ok(random)
}

fn order_preimage(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    swapper_address: &str,
    destination_address: &str,
    order_nonce: &str,
    cancel_fee: u64,
    refund_fee: u64,
    mode: u8,
) -> BridgeResult<Vec<u8>> {
    let mut preimage = Vec::with_capacity(272);
    preimage.push(1);
    preimage.extend(local_native_address_bytes(
        swapper_address,
        facts.source_chain_id,
        BridgeErrorCode::LocalPlanInvalid,
    )?);
    preimage.extend(write_u16_be(u16::from(facts.source_wormhole_chain_id)));
    preimage.extend(local_native_address_bytes(
        facts.source_usdc_address,
        facts.source_chain_id,
        BridgeErrorCode::LocalPlanInvalid,
    )?);
    preimage.extend(local_native_address_bytes(
        destination_address,
        facts.destination_chain_id,
        BridgeErrorCode::LocalPlanInvalid,
    )?);
    preimage.extend(write_u16_be(u16::from(facts.destination_wormhole_chain_id)));
    preimage.extend(local_native_address_bytes(
        facts.destination_token_address,
        facts.destination_chain_id,
        BridgeErrorCode::LocalPlanInvalid,
    )?);
    preimage.extend(write_u64_be(local_uint64(
        &quote.minimum_amount_out,
        true,
        BridgeErrorCode::LocalPlanInvalid,
    )?));
    preimage.extend(write_u64_be(0));
    preimage.extend(write_u64_be(cancel_fee));
    preimage.extend(write_u64_be(refund_fee));
    preimage.extend(write_u64_be(local_uint64(
        &quote.deadline,
        true,
        BridgeErrorCode::LocalPlanInvalid,
    )?));
    preimage.extend([0_u8; 32]);
    preimage.extend([0_u8, 0_u8, mode]);
    preimage.extend(swift_random(
        &quote.quote_id,
        order_nonce,
        BridgeErrorCode::LocalPlanInvalid,
    )?);
    preimage.extend([0_u8; 32]);
    if preimage.len() != 272 {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    Ok(preimage)
}

fn hash_order(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    swapper_address: &str,
    destination_address: &str,
    order_nonce: &str,
    cancel_fee: u64,
    refund_fee: u64,
    mode: u8,
) -> BridgeResult<String> {
    Ok(format!(
        "0x{}",
        keccak_hex(&order_preimage(
            quote,
            facts,
            swapper_address,
            destination_address,
            order_nonce,
            cancel_fee,
            refund_fee,
            mode,
        )?)
    ))
}

fn quote_binding_hash(
    facts: &DirectionFacts,
    quote: &MayanSwiftV2Quote,
    raw_quote_sha256: &str,
    order_nonce: &str,
    swapper_address: &str,
    destination_address: &str,
) -> String {
    let value = json!({
        "capabilityId": facts.bridge_capability_id,
        "destinationAddress": destination_address,
        "destinationChainId": facts.destination_chain_id,
        "destinationTokenDeploymentId": facts.destination_token_deployment_id,
        "orderNonce": order_nonce,
        "quoteId": quote.quote_id,
        "rawQuoteSha256": raw_quote_sha256,
        "sourceChainId": facts.source_chain_id,
        "sourceTokenDeploymentId": facts.source_token_deployment_id,
        "swapperAddress": swapper_address,
    });
    sha256_hex(stable_json(&value).as_bytes())
}

fn source_swap_hash_projection(
    source_swap: &MayanSwiftV2LocalSourceSwapPlan,
) -> BridgeResult<Value> {
    let mut value = serde_json::to_value(source_swap)
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if !matches!(source_swap, MayanSwiftV2LocalSourceSwapPlan::None {}) {
        value
            .as_object_mut()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?
            .remove("rawProviderSourceSwapJson");
    }
    Ok(value)
}

fn plan_hash(
    quote_binding_hash: &str,
    source_swap: &MayanSwiftV2LocalSourceSwapPlan,
) -> BridgeResult<String> {
    let value = json!({
        "quoteBindingHash": quote_binding_hash,
        "sourceSwap": source_swap_hash_projection(source_swap)?,
    });
    Ok(sha256_hex(stable_json(&value).as_bytes()))
}

fn local_endpoint(value: &str, code: BridgeErrorCode) -> BridgeResult<Url> {
    if value.is_empty() || value.trim() != value || value.contains('#') {
        return Err(local_error(code));
    }
    let endpoint = Url::parse(value).map_err(|_| local_error(code))?;
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err(local_error(code));
    }
    if endpoint.query().is_some() || endpoint.fragment().is_some() {
        return Err(local_error(code));
    }
    let host = endpoint.host_str().unwrap_or_default();
    if endpoint.scheme() != "https"
        && !(endpoint.scheme() == "http"
            && matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
    {
        return Err(local_error(code));
    }
    if host.is_empty() || endpoint.port().is_some_and(|port| port == 0) {
        return Err(local_error(code));
    }
    let mut endpoint = endpoint;
    let path = endpoint.path().trim_end_matches('/').to_owned();
    endpoint.set_path(if path.is_empty() { "/" } else { &path });
    Ok(endpoint)
}

fn source_swap_url(endpoint: &Url, chain: &str, params: &[(&str, String)]) -> BridgeResult<Url> {
    let mut url = endpoint.clone();
    let prefix = url.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/get-swap/{chain}"));
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    Ok(url)
}

async fn read_local_response_body(mut response: Response) -> BridgeResult<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| local_error(BridgeErrorCode::ProviderTransport))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(local_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| local_error(BridgeErrorCode::ProviderInvalidResponse))
}

async fn fetch_source_swap(
    endpoint: Url,
    client_timeout: Duration,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<(String, Value)> {
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    let request = client.get(endpoint).header(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/json"),
    );
    let operation = async {
        let response = request
            .send()
            .await
            .map_err(|_| local_error(BridgeErrorCode::ProviderTransport))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(crate::bridge::bridge_error_status(
                BridgeErrorCode::ProviderHttp,
                status,
            ));
        }
        let text = read_local_response_body(response).await?;
        let parsed = parse_provider_response(text.clone())
            .map_err(|_| local_error(BridgeErrorCode::ProviderInvalidResponse))?;
        if !matches!(parsed.root.value, Value::Object(_)) {
            return Err(local_error(BridgeErrorCode::ProviderInvalidResponse));
        }
        Ok((text, parsed.root.value))
    };
    let timed = tokio::time::timeout(client_timeout, operation);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(local_error(BridgeErrorCode::Aborted)),
            result = timed => result.map_err(|_| local_error(BridgeErrorCode::Timeout))?,
        }
    } else {
        timed
            .await
            .map_err(|_| local_error(BridgeErrorCode::Timeout))?
    }
}

fn validate_source_swap(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    raw: &Value,
    state_address: Option<&str>,
    state_token_account: Option<&str>,
    swapper_address: &str,
    minimum_intermediate_amount: &str,
) -> BridgeResult<MayanSwiftV2LocalSourceSwapPlan> {
    if facts.asset == BridgeAsset::Usdc {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        if !exact_object_keys(raw, &["swapRouterAddress", "swapRouterCalldata"]) {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let router_address = normalize_evm_address(
            raw.as_object()
                .and_then(|value| value.get("swapRouterAddress"))
                .and_then(Value::as_str)
                .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
            BridgeErrorCode::LocalPlanInvalid,
        )?;
        if quote.source_swap.router_kind.as_deref() != Some("provider-selected-evm")
            || quote.source_swap.router_address.as_deref() != Some(router_address.as_str())
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let calldata = raw
            .as_object()
            .and_then(|value| value.get("swapRouterCalldata"))
            .and_then(Value::as_str)
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        let calldata_bytes =
            hex_to_bytes(calldata).map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        if calldata_bytes.is_empty()
            || !calldata
                .to_ascii_lowercase()
                .starts_with(EVM_SOURCE_SWAP_SELECTOR)
            || calldata_bytes.len() > MAX_ROUTER_CALLDATA_BYTES
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        return Ok(MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
            router_address,
            calldata: format!("0x{}", bytes_to_hex(&calldata_bytes)),
            raw_response_sha256: String::new(),
            raw_provider_source_swap_json: String::new(),
        });
    }
    let root = raw
        .as_object()
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if root
        .get("tokenLedgerInstruction")
        .is_some_and(|value| !value.is_null())
        || root
            .get("cleanupInstruction")
            .is_some_and(|value| !value.is_null())
        || root
            .get("simulationError")
            .is_some_and(|value| !value.is_null())
        || root
            .get("separateSwapTx")
            .is_some_and(|value| value != &Value::Bool(false) && !value.is_null())
        || root
            .get("jito")
            .is_some_and(|value| value != &Value::Bool(false) && !value.is_null())
    {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let other = root
        .get("otherInstructions")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if !other.is_empty() {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let compute = root
        .get("computeBudgetInstructions")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?
        .iter()
        .map(parse_instruction)
        .collect::<BridgeResult<Vec<_>>>()?;
    let setup = root
        .get("setupInstructions")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?
        .iter()
        .map(parse_instruction)
        .collect::<BridgeResult<Vec<_>>>()?;
    let swap = parse_instruction(
        root.get("swapInstruction")
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
    )?;
    validate_compute_instructions(&compute)?;
    validate_ata_setup(
        &setup,
        swapper_address,
        state_address.ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
        facts.source_usdc_address,
    )?;
    validate_jupiter_instruction(
        &swap,
        facts,
        quote,
        state_token_account.ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
        swapper_address,
        minimum_intermediate_amount,
        raw,
    )?;
    let mut signer_keys = HashSet::new();
    for instruction in compute
        .iter()
        .chain(setup.iter())
        .chain(std::iter::once(&swap))
    {
        for account in &instruction.accounts {
            if account.is_signer {
                signer_keys.insert(account.pubkey.as_str());
            }
        }
    }
    if signer_keys.len() != 1 || !signer_keys.contains(swapper_address) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let provider_alts = root
        .get("addressLookupTableAddresses")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if provider_alts.len() > MAX_LOOKUP_TABLES {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let mut address_lookup_table_addresses = Vec::with_capacity(provider_alts.len());
    for address in provider_alts {
        let address = canonical_solana_address(
            address
                .as_str()
                .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?,
            BridgeErrorCode::LocalPlanInvalid,
        )?;
        address_lookup_table_addresses.push(address);
    }
    let prioritization_fee = local_parse_integer_number(
        root.get("prioritizationFeeLamports"),
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    if prioritization_fee.is_some_and(|value| value > UINT64_MAX as u64) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let compute_unit_limit = local_parse_integer_number(
        root.get("computeUnitLimit"),
        BridgeErrorCode::LocalPlanInvalid,
    )?;
    if compute_unit_limit.is_some_and(|value| value > 1_400_000) {
        return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
    }
    let mut instructions = compute;
    instructions.extend(setup);
    instructions.push(swap);
    Ok(MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
        instructions,
        address_lookup_table_addresses,
        raw_response_sha256: String::new(),
        raw_provider_source_swap_json: String::new(),
    })
}

fn local_quote_deadline_check(
    client: &MayanSwiftV2BridgeClient,
    quote: &MayanSwiftV2Quote,
) -> BridgeResult<()> {
    let deadline = local_uint64(&quote.deadline, true, BridgeErrorCode::QuoteExpired)?;
    let now = client
        .now_seconds()
        .map_err(|_| local_error(BridgeErrorCode::QuoteExpired))?;
    let minimum = now
        .checked_add(client.local_minimum_quote_validity_seconds())
        .ok_or_else(|| local_error(BridgeErrorCode::QuoteExpired))?;
    if deadline < minimum {
        return Err(local_error(BridgeErrorCode::QuoteExpired));
    }
    Ok(())
}

fn local_normalized_addresses(
    facts: &DirectionFacts,
    swapper_address: &str,
    destination_address: &str,
) -> BridgeResult<(String, String)> {
    let swapper_address = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        normalize_evm_address(swapper_address, BridgeErrorCode::LocalPlanInvalid)?
    } else {
        canonical_solana_address(swapper_address, BridgeErrorCode::LocalPlanInvalid)?
    };
    let destination_address = if facts.destination_chain_id == ETHEREUM_CHAIN_ID {
        normalize_evm_address(destination_address, BridgeErrorCode::LocalPlanInvalid)?
    } else {
        canonical_solana_address(destination_address, BridgeErrorCode::LocalPlanInvalid)?
    };
    Ok((swapper_address, destination_address))
}

fn build_source_swap_url(
    config: Option<&crate::bridge::MayanSwiftV2LocalBuildConfig>,
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    parsed: &ParsedLocalQuote,
    swapper_address: &str,
    order_hash: &str,
) -> BridgeResult<Url> {
    let endpoint = config
        .map(|config| config.source_swap_endpoint.as_str())
        .unwrap_or(DEFAULT_SOURCE_SWAP_ENDPOINT);
    let endpoint = local_endpoint(endpoint, BridgeErrorCode::LocalPlanInvalid)?;
    let raw_from_token = parsed
        .raw
        .as_object()
        .and_then(|value| value.get("fromToken"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("contract"))
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        source_swap_url(
            &endpoint,
            "evm",
            &[
                ("forwarderAddress", ETHEREUM_FORWARDER_PROVIDER.to_owned()),
                ("slippageBps", quote.slippage_bps.to_string()),
                ("fromToken", raw_from_token.to_owned()),
                ("middleToken", facts.source_usdc_address.to_owned()),
                ("chainName", facts.source_provider_chain_name.to_owned()),
                ("amountIn64", quote.amount_in.clone()),
                ("sdkVersion", MAYAN_ORACLE_SDK_VERSION.to_owned()),
            ],
        )
    } else {
        let order_hash_bytes =
            hex_to_bytes(order_hash).map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        let state = find_program_address(
            &[b"STATE_SOURCE", &order_hash_bytes, &write_u16_le(2)],
            SOLANA_SWIFT_PROGRAM,
            BridgeErrorCode::LocalPlanInvalid,
        )?;
        let min_middle = parsed
            .raw
            .as_object()
            .and_then(|value| value.get("minMiddleAmount"));
        let min_middle = min_middle
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(|value| value.to_string())
            .ok_or_else(|| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        source_swap_url(
            &endpoint,
            "solana",
            &[
                ("minMiddleAmount", min_middle),
                ("middleToken", facts.source_usdc_address.to_owned()),
                ("userWallet", swapper_address.to_owned()),
                ("slippageBps", quote.slippage_bps.to_string()),
                ("fromToken", facts.source_token_address.to_owned()),
                ("amountIn64", quote.amount_in.clone()),
                ("depositMode", "SWIFT".to_owned()),
                ("fillMaxAccounts", "false".to_owned()),
                ("chainName", facts.source_provider_chain_name.to_owned()),
                ("userLedger", state),
                ("sdkVersion", MAYAN_ORACLE_SDK_VERSION.to_owned()),
            ],
        )
    }
}

/// Prepares a local source-swap plan without source-chain RPC access for direct
/// USDC, and with one anonymous Mayan source-swap request for EURC.
pub(crate) async fn prepare_source_swap(
    client: &MayanSwiftV2BridgeClient,
    context: MayanSwiftV2LocalContext,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<MayanSwiftV2SourceSwapPlan> {
    let result = async {
        let facts = local_route(&context.quote)?;
        validate_local_raw_quote(client, &context.quote, &facts)?;
        let parsed = parse_local_quote(&context.quote, &facts)?;
        let (swapper_address, destination_address) = local_normalized_addresses(
            &facts,
            &context.swapper_address,
            &context.destination_address,
        )?;
        if context.order_nonce.len() != 34
            || !context.order_nonce.starts_with("0x")
            || !context.order_nonce[2..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        let nonce = hex_to_bytes(&context.order_nonce)
            .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
        if nonce.len() != 16 {
            return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
        }
        local_destination_minimum_compatibility(&context.quote.minimum_amount_out)?;
        local_quote_deadline_check(client, &context.quote)?;
        let raw_quote_sha256 = sha256_hex(context.quote.raw_signed_quote_json.as_bytes());
        let order_hash = hash_order(
            &context.quote,
            &facts,
            &swapper_address,
            &destination_address,
            &context.order_nonce,
            parsed.cancel_fee,
            parsed.refund_fee,
            parsed.mode,
        )?;
        let binding = quote_binding_hash(
            &facts,
            &context.quote,
            &raw_quote_sha256,
            &context.order_nonce,
            &swapper_address,
            &destination_address,
        );
        let source_swap = if facts.asset == BridgeAsset::Usdc {
            MayanSwiftV2LocalSourceSwapPlan::None {}
        } else {
            let endpoint = build_source_swap_url(
                client.local_build_config(),
                &context.quote,
                &facts,
                &parsed,
                &swapper_address,
                &order_hash,
            )?;
            let (response_text, response_root) =
                fetch_source_swap(endpoint, client.local_timeout(), cancellation).await?;
            let (state_address, state_token_account) = if facts.source_chain_id == SOLANA_CHAIN_ID {
                let order_hash_bytes = hex_to_bytes(&order_hash)
                    .map_err(|_| local_error(BridgeErrorCode::LocalPlanInvalid))?;
                let state = find_program_address(
                    &[b"STATE_SOURCE", &order_hash_bytes, &write_u16_le(2)],
                    SOLANA_SWIFT_PROGRAM,
                    BridgeErrorCode::LocalPlanInvalid,
                )?;
                let state_token = associated_token_address(
                    &state,
                    facts.source_usdc_address,
                    true,
                    BridgeErrorCode::LocalPlanInvalid,
                )?;
                (Some(state), Some(state_token))
            } else {
                (None, None)
            };
            let mut source_swap = validate_source_swap(
                &context.quote,
                &facts,
                &response_root,
                state_address.as_deref(),
                state_token_account.as_deref(),
                &swapper_address,
                &parsed.minimum_intermediate_amount,
            )?;
            let response_sha256 = sha256_hex(response_text.as_bytes());
            match &mut source_swap {
                MayanSwiftV2LocalSourceSwapPlan::None {} => {
                    return Err(local_error(BridgeErrorCode::LocalPlanInvalid));
                }
                MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
                    raw_response_sha256,
                    raw_provider_source_swap_json,
                    ..
                }
                | MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
                    raw_response_sha256,
                    raw_provider_source_swap_json,
                    ..
                } => {
                    *raw_response_sha256 = response_sha256;
                    *raw_provider_source_swap_json = response_text;
                }
            }
            source_swap
        };
        Ok(MayanSwiftV2SourceSwapPlan {
            plan_kind: "mayan-swift-v2-local-source-swap".to_owned(),
            provider_id: "mayan-swift-v2".to_owned(),
            capability_id: facts.bridge_capability_id.to_owned(),
            source_chain_id: facts.source_chain_id.to_owned(),
            destination_chain_id: facts.destination_chain_id.to_owned(),
            source_token_deployment_id: facts.source_token_deployment_id.to_owned(),
            destination_token_deployment_id: facts.destination_token_deployment_id.to_owned(),
            quote_id: context.quote.quote_id.clone(),
            raw_quote_sha256,
            order_nonce: context.order_nonce.clone(),
            swapper_address,
            destination_address,
            order_hash,
            quote_binding_hash: binding.clone(),
            minimum_intermediate_amount: parsed.minimum_intermediate_amount,
            plan_hash: plan_hash(&binding, &source_swap)?,
            source_swap,
        })
    }
    .await;
    match result {
        Ok(plan) => Ok(plan),
        Err(error)
            if matches!(
                error.code(),
                BridgeErrorCode::ProviderHttp
                    | BridgeErrorCode::ProviderTransport
                    | BridgeErrorCode::ProviderInvalidResponse
                    | BridgeErrorCode::Timeout
                    | BridgeErrorCode::Aborted
                    | BridgeErrorCode::QuoteExpired
            ) =>
        {
            Err(error)
        }
        Err(_) => Err(local_error(BridgeErrorCode::LocalPlanInvalid)),
    }
}

fn source_rpc_endpoint_config(
    client: &MayanSwiftV2BridgeClient,
    facts: &DirectionFacts,
) -> BridgeResult<RpcEndpointConfig> {
    let Some(local_build) = client.local_build_config() else {
        return Err(local_error(BridgeErrorCode::LocalRpcRequired));
    };
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        local_build
            .ethereum_rpc
            .clone()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalRpcRequired))
    } else {
        local_build
            .solana_rpc
            .clone()
            .ok_or_else(|| local_error(BridgeErrorCode::LocalRpcRequired))
    }
}

#[derive(Clone, Debug)]
struct SourceRpcResult {
    evidence: MayanSwiftV2LocalSourceRpcEvidence,
    lookup_tables: Vec<LocalLookupTable>,
    recent_blockhash: Option<String>,
}

fn rpc_endpoint_url(endpoint: &RpcEndpointConfig) -> BridgeResult<Url> {
    let mut url = Url::parse(&endpoint.http_url)
        .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    if url.path().is_empty() {
        url.set_path("/");
    }
    Ok(url)
}

async fn read_source_rpc_body(mut response: Response) -> BridgeResult<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| local_error(BridgeErrorCode::SourceRpcTransport))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))
}

async fn fetch_rpc_result(
    endpoint: &RpcEndpointConfig,
    method: &str,
    params: &str,
    timeout: Duration,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<Value> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err(local_error(BridgeErrorCode::Aborted));
    }
    let endpoint_url = rpc_endpoint_url(endpoint)?;
    let body = format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":{method},\"params\":{params}}}",
        method = serde_json::to_string(method)
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?,
    );
    let http = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    let mut request = http
        .post(endpoint_url)
        .header(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json"),
        )
        .header(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )
        .body(body);
    for (name, value) in &endpoint.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        request = request.header(name, value);
    }
    let operation = async {
        let response = request
            .send()
            .await
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcTransport))?;
        if !(200..300).contains(&response.status().as_u16()) {
            return Err(local_error(BridgeErrorCode::SourceRpcTransport));
        }
        let body = read_source_rpc_body(response).await?;
        let parsed = parse_provider_response(body)
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        if object_value(&parsed.root, "jsonrpc") != Some(&Value::String("2.0".to_owned()))
            || object_value(&parsed.root, "id") != Some(&Value::Number(1.into()))
            || object_value(&parsed.root, "version").is_some()
            || object_value(&parsed.root, "error").is_some()
        {
            return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
        }
        object_value(&parsed.root, "result")
            .cloned()
            .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))
    };
    let timed = tokio::time::timeout(timeout, operation);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(local_error(BridgeErrorCode::Aborted)),
            result = timed => result.map_err(|_| local_error(BridgeErrorCode::Timeout))?,
        }
    } else {
        timed
            .await
            .map_err(|_| local_error(BridgeErrorCode::Timeout))?
    }
}

fn safe_json_u64(value: Option<&Value>) -> BridgeResult<u64> {
    let number = value
        .and_then(Value::as_u64)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    if number > 9_007_199_254_740_991 {
        return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
    }
    Ok(number)
}

async fn fetch_solana_multiple_accounts(
    endpoint: &RpcEndpointConfig,
    addresses: &[String],
    min_context_slot: u64,
    timeout: Duration,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<Value> {
    let address_json = serde_json::to_string(addresses)
        .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    let params = format!(
        "[{address_json},{{\"encoding\":\"base64\",\"commitment\":\"confirmed\",\"minContextSlot\":{min_context_slot}}}]"
    );
    fetch_rpc_result(
        endpoint,
        "getMultipleAccounts",
        &params,
        timeout,
        cancellation,
    )
    .await
}

fn local_hex_bytes(value: &str, code: BridgeErrorCode) -> BridgeResult<Vec<u8>> {
    let bytes = hex_to_bytes(value).map_err(|_| local_error(code))?;
    if !value.starts_with("0x") {
        return Err(local_error(code));
    }
    Ok(bytes)
}

async fn fetch_source_rpc(
    client: &MayanSwiftV2BridgeClient,
    facts: &DirectionFacts,
    source_swap: &MayanSwiftV2LocalSourceSwapPlan,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<SourceRpcResult> {
    let endpoint = source_rpc_endpoint_config(client, facts)?;
    if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        let chain_id = fetch_rpc_result(
            &endpoint,
            "eth_chainId",
            "[]",
            client.local_timeout(),
            cancellation,
        )
        .await?
        .as_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        if chain_id != "0x1" {
            return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
        }
        let mut addresses = vec![
            ETHEREUM_FORWARDER.to_owned(),
            facts.swift_contract.to_owned(),
        ];
        if let MayanSwiftV2LocalSourceSwapPlan::EvmRouter { router_address, .. } = source_swap {
            addresses.push(router_address.clone());
        }
        let mut code = Vec::with_capacity(addresses.len());
        for address in addresses {
            let params = format!(
                "[{},\"latest\"]",
                serde_json::to_string(&address)
                    .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?
            );
            let bytecode = fetch_rpc_result(
                &endpoint,
                "eth_getCode",
                &params,
                client.local_timeout(),
                cancellation,
            )
            .await?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
            let bytes = local_hex_bytes(&bytecode, BridgeErrorCode::SourceRpcInvalidResponse)?;
            if bytes.is_empty() {
                return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
            }
            let normalized =
                normalize_evm_address(&address, BridgeErrorCode::SourceRpcInvalidResponse)?;
            code.push(MayanSwiftV2LocalEvmCodeEvidence {
                address: normalized,
                keccak256: format!("0x{}", keccak_hex(&bytes)),
            });
        }
        return Ok(SourceRpcResult {
            evidence: MayanSwiftV2LocalSourceRpcEvidence::Evm(MayanSwiftV2LocalEvmRpcEvidence {
                kind: "evm".to_owned(),
                rpc_chain_id: "0x1".to_owned(),
                code,
            }),
            lookup_tables: Vec::new(),
            recent_blockhash: None,
        });
    }

    let genesis_hash = fetch_rpc_result(
        &endpoint,
        "getGenesisHash",
        "[]",
        client.local_timeout(),
        cancellation,
    )
    .await?
    .as_str()
    .map(str::to_owned)
    .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    if genesis_hash != SOLANA_MAINNET_GENESIS_HASH {
        return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
    }
    let blockhash_result = fetch_rpc_result(
        &endpoint,
        "getLatestBlockhash",
        "[{\"commitment\":\"confirmed\"}]",
        client.local_timeout(),
        cancellation,
    )
    .await?;
    let blockhash_context = blockhash_result
        .get("context")
        .and_then(Value::as_object)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    let blockhash_value = blockhash_result
        .get("value")
        .and_then(Value::as_object)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    let blockhash_slot = safe_json_u64(blockhash_context.get("slot"))?;
    let recent_blockhash = blockhash_value
        .get("blockhash")
        .and_then(Value::as_str)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    canonical_solana_address(recent_blockhash, BridgeErrorCode::SourceRpcInvalidResponse)?;
    let last_valid_block_height = safe_json_u64(blockhash_value.get("lastValidBlockHeight"))?;
    let provider_alts = match source_swap {
        MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
            address_lookup_table_addresses,
            ..
        } => address_lookup_table_addresses.clone(),
        _ => Vec::new(),
    };
    let mut alt_addresses = vec![SOLANA_MAYAN_LOOKUP_TABLE.to_owned()];
    for address in provider_alts {
        if !alt_addresses.contains(&address) {
            alt_addresses.push(address);
        }
    }
    if alt_addresses.len() > MAX_LOOKUP_TABLES {
        return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
    }
    let accounts = fetch_solana_multiple_accounts(
        &endpoint,
        &alt_addresses,
        blockhash_slot,
        client.local_timeout(),
        cancellation,
    )
    .await?;
    let account_obj = accounts
        .as_object()
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    let account_slot = safe_json_u64(
        account_obj
            .get("context")
            .and_then(Value::as_object)
            .and_then(|context| context.get("slot")),
    )?;
    if account_slot < blockhash_slot {
        return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
    }
    let values = account_obj
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
    if values.len() != alt_addresses.len() {
        return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
    }
    let mut lookup_tables = Vec::with_capacity(values.len());
    let mut lookup_evidence = Vec::with_capacity(values.len());
    for (address, value) in alt_addresses.into_iter().zip(values) {
        let account = value
            .as_object()
            .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        if account.get("executable") != Some(&Value::Bool(false)) {
            return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
        }
        let data = account
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        if data.len() != 2 || data[1].as_str() != Some("base64") {
            return Err(local_error(BridgeErrorCode::SourceRpcInvalidResponse));
        }
        let data_text = data[0]
            .as_str()
            .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        let data = decode_base64(data_text)
            .map_err(|_| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?;
        let owner = canonical_solana_address(
            account
                .get("owner")
                .and_then(Value::as_str)
                .ok_or_else(|| local_error(BridgeErrorCode::SourceRpcInvalidResponse))?,
            BridgeErrorCode::SourceRpcInvalidResponse,
        )?;
        let table = decode_lookup_table(
            address.clone(),
            &data,
            &owner,
            account_slot,
            BridgeErrorCode::SourceRpcInvalidResponse,
        )?;
        lookup_evidence.push(MayanSwiftV2LocalSolanaRpcLookupTableEvidence {
            address: address.clone(),
            data_sha256: sha256_hex(&data),
        });
        lookup_tables.push(table);
    }
    Ok(SourceRpcResult {
        evidence: MayanSwiftV2LocalSourceRpcEvidence::Solana(MayanSwiftV2LocalSolanaRpcEvidence {
            kind: "solana".to_owned(),
            genesis_hash,
            blockhash_context_slot: blockhash_slot.to_string(),
            account_context_slot: account_slot.to_string(),
            recent_blockhash: recent_blockhash.to_owned(),
            last_valid_block_height: last_valid_block_height.to_string(),
            lookup_tables: lookup_evidence,
        }),
        lookup_tables,
        recent_blockhash: Some(recent_blockhash.to_owned()),
    })
}

fn decode_lookup_table(
    address: String,
    data: &[u8],
    owner: &str,
    account_context_slot: u64,
    code: BridgeErrorCode,
) -> BridgeResult<LocalLookupTable> {
    if owner != SOLANA_ADDRESS_LOOKUP_TABLE_OWNER
        || data.len() < 56
        || (data.len() - 56) % 32 != 0
        || data[0..4] != [1, 0, 0, 0]
    {
        return Err(local_error(code));
    }
    let deactivation_slot =
        u64::from_le_bytes(data[4..12].try_into().map_err(|_| local_error(code))?);
    if deactivation_slot != u64::MAX {
        return Err(local_error(code));
    }
    let last_extended_slot =
        u64::from_le_bytes(data[12..20].try_into().map_err(|_| local_error(code))?);
    let last_extended_start_index = data[20];
    let authority_option = data[21];
    if authority_option > 1
        || data[54..56].iter().any(|byte| *byte != 0)
        || (authority_option == 0 && data[22..54].iter().any(|byte| *byte != 0))
    {
        return Err(local_error(code));
    }
    if last_extended_slot > account_context_slot {
        return Err(local_error(code));
    }
    let count = (data.len() - 56) / 32;
    if count > MAX_LOOKUP_TABLE_ADDRESSES {
        return Err(local_error(code));
    }
    if usize::from(last_extended_start_index) > count {
        return Err(local_error(code));
    }
    let active_count = if last_extended_slot == account_context_slot {
        usize::from(last_extended_start_index)
    } else {
        count
    };
    if active_count > count {
        return Err(local_error(code));
    }
    let addresses = data[56..]
        .chunks_exact(32)
        .take(active_count)
        .map(encode_base58)
        .collect::<Vec<_>>();
    Ok(LocalLookupTable { address, addresses })
}

fn validate_plan(
    request: &MayanSwiftV2LocalBuildRequest,
    facts: &DirectionFacts,
    parsed_quote: &ParsedLocalQuote,
    plan: &MayanSwiftV2SourceSwapPlan,
    raw_quote_sha256: &str,
    order_hash: &str,
    binding: &str,
    swapper_address: &str,
    destination_address: &str,
) -> BridgeResult<()> {
    if plan.plan_kind != "mayan-swift-v2-local-source-swap"
        || plan.provider_id != "mayan-swift-v2"
        || plan.capability_id != facts.bridge_capability_id
        || plan.source_chain_id != facts.source_chain_id
        || plan.destination_chain_id != facts.destination_chain_id
        || plan.source_token_deployment_id != facts.source_token_deployment_id
        || plan.destination_token_deployment_id != facts.destination_token_deployment_id
        || plan.quote_id != request.quote.quote_id
        || plan.raw_quote_sha256 != raw_quote_sha256
        || plan.order_nonce != request.order_nonce
        || plan.swapper_address != swapper_address
        || plan.destination_address != destination_address
        || plan.order_hash != order_hash
        || plan.quote_binding_hash != binding
        || plan.minimum_intermediate_amount != parsed_quote.minimum_intermediate_amount
    {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    let normalized_source_swap = if facts.asset == BridgeAsset::Usdc {
        if !matches!(plan.source_swap, MayanSwiftV2LocalSourceSwapPlan::None {}) {
            return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
        }
        MayanSwiftV2LocalSourceSwapPlan::None {}
    } else {
        let (state_address, state_token_account) = if facts.source_chain_id == SOLANA_CHAIN_ID {
            let order_hash_bytes = hex_to_bytes(order_hash)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
            let state = find_program_address(
                &[b"STATE_SOURCE", &order_hash_bytes, &write_u16_le(2)],
                SOLANA_SWIFT_PROGRAM,
                BridgeErrorCode::LocalBuildInvalid,
            )?;
            let state_token = associated_token_address(
                &state,
                facts.source_usdc_address,
                true,
                BridgeErrorCode::LocalBuildInvalid,
            )?;
            (Some(state), Some(state_token))
        } else {
            (None, None)
        };
        let (raw_response, source_swap_without_raw) = match &plan.source_swap {
            MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
                raw_provider_source_swap_json,
                ..
            }
            | MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
                raw_provider_source_swap_json,
                ..
            } => (raw_provider_source_swap_json, &plan.source_swap),
            MayanSwiftV2LocalSourceSwapPlan::None {} => {
                return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
            }
        };
        let parsed = parse_provider_response(raw_response.clone())
            .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
        let expected = validate_source_swap(
            &request.quote,
            facts,
            &parsed.root.value,
            state_address.as_deref(),
            state_token_account.as_deref(),
            swapper_address,
            &parsed_quote.minimum_intermediate_amount,
        )?;
        let expected = match expected {
            MayanSwiftV2LocalSourceSwapPlan::EvmRouter { .. }
            | MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 { .. } => expected,
            MayanSwiftV2LocalSourceSwapPlan::None {} => {
                return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
            }
        };
        if !source_swap_matches_without_raw(source_swap_without_raw, &expected)
            || match source_swap_without_raw {
                MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
                    raw_response_sha256,
                    ..
                }
                | MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
                    raw_response_sha256,
                    ..
                } => raw_response_sha256 != &sha256_hex(raw_response.as_bytes()),
                MayanSwiftV2LocalSourceSwapPlan::None {} => true,
            }
        {
            return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
        }
        plan.source_swap.clone()
    };
    let calculated_plan_hash = plan_hash(binding, &normalized_source_swap)?;
    if plan.plan_hash != calculated_plan_hash {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    Ok(())
}

fn source_swap_matches_without_raw(
    actual: &MayanSwiftV2LocalSourceSwapPlan,
    expected: &MayanSwiftV2LocalSourceSwapPlan,
) -> bool {
    match (actual, expected) {
        (
            MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
                router_address: actual_router,
                calldata: actual_calldata,
                ..
            },
            MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
                router_address: expected_router,
                calldata: expected_calldata,
                ..
            },
        ) => actual_router == expected_router && actual_calldata == expected_calldata,
        (
            MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
                instructions: actual_instructions,
                address_lookup_table_addresses: actual_alts,
                ..
            },
            MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
                instructions: expected_instructions,
                address_lookup_table_addresses: expected_alts,
                ..
            },
        ) => actual_instructions == expected_instructions && actual_alts == expected_alts,
        (MayanSwiftV2LocalSourceSwapPlan::None {}, MayanSwiftV2LocalSourceSwapPlan::None {}) => {
            true
        }
        _ => false,
    }
}

fn local_build_dependencies(facts: &DirectionFacts) -> Vec<String> {
    let mut dependencies = match facts.asset {
        BridgeAsset::Eurc => {
            let mut values = vec![
                "mayan-hosted-quote-api",
                "mayan-hosted-source-swap-builder",
                "swift-auction-solvers",
                "relayers",
                "wormhole-guardian-messaging",
                "mayan-explorer-indexer",
            ];
            if facts.source_chain_id == SOLANA_CHAIN_ID {
                values.push("jupiter-v6-source-swap");
            }
            values
        }
        BridgeAsset::Usdc => vec![
            "mayan-hosted-quote-api",
            "swift-auction-solvers",
            "relayers",
            "wormhole-guardian-messaging",
            "mayan-explorer-indexer",
        ],
    }
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    dependencies.push(if facts.source_chain_id == ETHEREUM_CHAIN_ID {
        "configured-ethereum-rpc".to_owned()
    } else {
        "configured-solana-rpc".to_owned()
    });
    dependencies
}

fn build_evm_order_call(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    plan: &MayanSwiftV2LocalSourceSwapPlan,
    swapper_address: &str,
    destination_address: &str,
    minimum_intermediate_amount: &str,
    cancel_fee: u64,
    refund_fee: u64,
    mode: u8,
    order_nonce: &str,
) -> BridgeResult<String> {
    let mut order_words = Vec::new();
    order_words.push(local_word_uint(1));
    order_words.push(local_word_bytes32(
        &local_native_address_bytes(
            swapper_address,
            facts.source_chain_id,
            BridgeErrorCode::LocalBuildInvalid,
        )?,
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    order_words.push(local_word_bytes32(
        &local_native_address_bytes(
            destination_address,
            facts.destination_chain_id,
            BridgeErrorCode::LocalBuildInvalid,
        )?,
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    order_words.push(local_word_uint(u64::from(
        facts.destination_wormhole_chain_id,
    )));
    order_words.push(local_word_bytes32(
        &[0_u8; 32],
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    order_words.push(local_word_bytes32(
        &local_native_address_bytes(
            facts.destination_token_address,
            facts.destination_chain_id,
            BridgeErrorCode::LocalBuildInvalid,
        )?,
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    order_words.push(local_word_uint(local_uint64(
        &quote.minimum_amount_out,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?));
    order_words.push(local_word_uint(0));
    order_words.push(local_word_uint(cancel_fee));
    order_words.push(local_word_uint(refund_fee));
    order_words.push(local_word_uint(local_uint64(
        &quote.deadline,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?));
    order_words.push(local_word_uint(0));
    order_words.push(local_word_uint(u64::from(mode)));
    order_words.push(local_word_bytes32(
        &swift_random(
            &quote.quote_id,
            order_nonce,
            BridgeErrorCode::LocalBuildInvalid,
        )?,
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    let mut inner_head = vec![
        local_word_address(
            facts.source_usdc_address,
            BridgeErrorCode::LocalBuildInvalid,
        )?,
        local_word_uint(local_uint64(
            &quote.amount_in,
            true,
            BridgeErrorCode::LocalBuildInvalid,
        )?),
    ];
    inner_head.extend(order_words);
    let swift_call = local_abi_with_dynamics(&inner_head, &[Vec::new()]);
    let mut swift_call_data = b"a3a30834".to_vec();
    swift_call_data.extend(bytes_to_hex(&swift_call).as_bytes());
    let swift_call_data = hex_to_bytes(&format!(
        "0x{}",
        String::from_utf8(swift_call_data).expect("hex UTF-8")
    ))
    .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
    match plan {
        MayanSwiftV2LocalSourceSwapPlan::None {} => {
            let head = vec![
                local_word_address(
                    facts.source_usdc_address,
                    BridgeErrorCode::LocalBuildInvalid,
                )?,
                local_word_uint(local_uint64(
                    &quote.amount_in,
                    true,
                    BridgeErrorCode::LocalBuildInvalid,
                )?),
                local_word_uint(0),
                local_word_uint(0),
                local_word_uint(0),
                local_word_bytes32(&[0_u8; 32], BridgeErrorCode::LocalBuildInvalid)?,
                local_word_bytes32(&[0_u8; 32], BridgeErrorCode::LocalBuildInvalid)?,
                local_word_address(facts.swift_contract, BridgeErrorCode::LocalBuildInvalid)?,
            ];
            let outer = local_abi_with_dynamics(&head, &[swift_call_data]);
            let mut output = String::from("0xe4269fc4");
            output.push_str(&bytes_to_hex(&outer));
            Ok(output)
        }
        MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
            router_address,
            calldata,
            ..
        } => {
            let router_data = hex_to_bytes(calldata)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
            let router_offset = 13 * 32;
            let swift_offset = router_offset + 32 + router_data.len().div_ceil(32) * 32;
            let head = vec![
                local_word_address(
                    facts.source_token_address,
                    BridgeErrorCode::LocalBuildInvalid,
                )?,
                local_word_uint(local_uint64(
                    &quote.amount_in,
                    true,
                    BridgeErrorCode::LocalBuildInvalid,
                )?),
                local_word_uint(0),
                local_word_uint(0),
                local_word_uint(0),
                local_word_bytes32(&[0_u8; 32], BridgeErrorCode::LocalBuildInvalid)?,
                local_word_bytes32(&[0_u8; 32], BridgeErrorCode::LocalBuildInvalid)?,
                local_word_address(router_address, BridgeErrorCode::LocalBuildInvalid)?,
                local_word_uint(u64::try_from(router_offset).expect("offset fits u64")),
                local_word_address(
                    facts.source_usdc_address,
                    BridgeErrorCode::LocalBuildInvalid,
                )?,
                local_word_uint(local_uint64(
                    minimum_intermediate_amount,
                    true,
                    BridgeErrorCode::LocalBuildInvalid,
                )?),
                local_word_address(facts.swift_contract, BridgeErrorCode::LocalBuildInvalid)?,
                local_word_uint(u64::try_from(swift_offset).expect("offset fits u64")),
            ];
            // The outer router tuple already carries both dynamic offsets in
            // its explicit 13-word head. Unlike the nested Swift call, its
            // ABI encoder appends the two byte tails directly after that
            // head, so no extra offset words are inserted here.
            let mut outer = head.into_iter().flatten().collect::<Vec<_>>();
            outer.extend(local_abi_bytes(&router_data));
            outer.extend(local_abi_bytes(&swift_call_data));
            let mut output = String::from("0x30dedc57");
            output.push_str(&bytes_to_hex(&outer));
            Ok(output)
        }
        MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 { .. } => {
            Err(local_error(BridgeErrorCode::LocalBuildInvalid))
        }
    }
}

fn make_ata_instruction(
    swapper_address: &str,
    owner: &str,
    mint: &str,
    allow_owner_off_curve: bool,
) -> BridgeResult<MayanSwiftV2LocalSourceSwapInstruction> {
    let associated = associated_token_address(
        owner,
        mint,
        allow_owner_off_curve,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    Ok(MayanSwiftV2LocalSourceSwapInstruction {
        program_id: SOLANA_ASSOCIATED_TOKEN_PROGRAM.to_owned(),
        accounts: vec![
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: swapper_address.to_owned(),
                is_signer: true,
                is_writable: true,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: associated,
                is_signer: false,
                is_writable: true,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: owner.to_owned(),
                is_signer: false,
                is_writable: false,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: mint.to_owned(),
                is_signer: false,
                is_writable: false,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: SOLANA_SYSTEM_PROGRAM.to_owned(),
                is_signer: false,
                is_writable: false,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: SOLANA_TOKEN_PROGRAM.to_owned(),
                is_signer: false,
                is_writable: false,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: SOLANA_SYSVAR_RENT.to_owned(),
                is_signer: false,
                is_writable: false,
            },
        ],
        data_base64: "AQ==".to_owned(),
    })
}

fn make_spl_transfer_instruction(
    source: &str,
    destination: &str,
    owner: &str,
    amount: u64,
) -> MayanSwiftV2LocalSourceSwapInstruction {
    let mut data = vec![3_u8];
    data.extend(write_u64_le(amount));
    MayanSwiftV2LocalSourceSwapInstruction {
        program_id: SOLANA_TOKEN_PROGRAM.to_owned(),
        accounts: vec![
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: source.to_owned(),
                is_signer: false,
                is_writable: true,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: destination.to_owned(),
                is_signer: false,
                is_writable: true,
            },
            MayanSwiftV2LocalSourceSwapInstructionAccount {
                pubkey: owner.to_owned(),
                is_signer: true,
                is_writable: false,
            },
        ],
        data_base64: encode_base64(&data),
    }
}

fn make_compute_unit_price_instruction(
    micro_lamports: u64,
) -> MayanSwiftV2LocalSourceSwapInstruction {
    let mut data = vec![3_u8];
    data.extend(write_u64_le(micro_lamports));
    MayanSwiftV2LocalSourceSwapInstruction {
        program_id: SOLANA_COMPUTE_BUDGET_PROGRAM.to_owned(),
        accounts: Vec::new(),
        data_base64: encode_base64(&data),
    }
}

fn make_swift_init_instruction(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    swapper_address: &str,
    destination_address: &str,
    state_address: &str,
    state_token_account: &str,
    minimum_intermediate_amount: &str,
    cancel_fee: u64,
    refund_fee: u64,
    submit_fee: u64,
    mode: u8,
    order_nonce: &str,
) -> BridgeResult<MayanSwiftV2LocalSourceSwapInstruction> {
    let mut data = vec![0_u8; 198];
    let discriminator = hex_to_bytes(SOLANA_INIT_ORDER_DISCRIMINATOR)
        .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
    data[..8].copy_from_slice(&discriminator);
    let minimum = local_uint64(
        minimum_intermediate_amount,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    data[8..16].copy_from_slice(&write_u64_le(minimum));
    data[16] = 0;
    data[17..25].copy_from_slice(&write_u64_le(submit_fee));
    let destination = local_native_address_bytes(
        destination_address,
        facts.destination_chain_id,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    data[25..57].copy_from_slice(&destination);
    data[57..59].copy_from_slice(&write_u16_le(u16::from(
        facts.destination_wormhole_chain_id,
    )));
    let destination_token = local_native_address_bytes(
        facts.destination_token_address,
        facts.destination_chain_id,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    data[59..91].copy_from_slice(&destination_token);
    data[91..99].copy_from_slice(&write_u64_le(local_uint64(
        &quote.minimum_amount_out,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?));
    data[99..107].copy_from_slice(&write_u64_le(0));
    data[107..115].copy_from_slice(&write_u64_le(cancel_fee));
    data[115..123].copy_from_slice(&write_u64_le(refund_fee));
    data[123..131].copy_from_slice(&write_u64_le(local_uint64(
        &quote.deadline,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?));
    data[131..163].fill(0);
    data[163] = 0;
    data[164] = 0;
    data[165] = mode;
    data[166..198].copy_from_slice(&swift_random(
        &quote.quote_id,
        order_nonce,
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    let relayer_account = associated_token_address(
        swapper_address,
        facts.source_usdc_address,
        false,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    let accounts = vec![
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: swapper_address.to_owned(),
            is_signer: false,
            is_writable: false,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: swapper_address.to_owned(),
            is_signer: true,
            is_writable: true,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: state_address.to_owned(),
            is_signer: false,
            is_writable: true,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: state_token_account.to_owned(),
            is_signer: false,
            is_writable: true,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: relayer_account,
            is_signer: false,
            is_writable: true,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: SOLANA_SWIFT_PROGRAM.to_owned(),
            is_signer: false,
            is_writable: false,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: facts.source_usdc_address.to_owned(),
            is_signer: false,
            is_writable: false,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: SOLANA_FEE_MANAGER_PROGRAM.to_owned(),
            is_signer: false,
            is_writable: false,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: SOLANA_TOKEN_PROGRAM.to_owned(),
            is_signer: false,
            is_writable: false,
        },
        MayanSwiftV2LocalSourceSwapInstructionAccount {
            pubkey: SOLANA_SYSTEM_PROGRAM.to_owned(),
            is_signer: false,
            is_writable: false,
        },
    ];
    Ok(MayanSwiftV2LocalSourceSwapInstruction {
        program_id: SOLANA_SWIFT_PROGRAM.to_owned(),
        accounts,
        data_base64: encode_base64(&data),
    })
}

fn build_solana_instructions(
    quote: &MayanSwiftV2Quote,
    facts: &DirectionFacts,
    plan: &MayanSwiftV2LocalSourceSwapPlan,
    swapper_address: &str,
    destination_address: &str,
    parsed: &ParsedLocalQuote,
    order_hash: &str,
    order_nonce: &str,
) -> BridgeResult<Vec<MayanSwiftV2LocalSourceSwapInstruction>> {
    let order_hash_bytes =
        hex_to_bytes(order_hash).map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
    let state = find_program_address(
        &[b"STATE_SOURCE", &order_hash_bytes, &write_u16_le(2)],
        SOLANA_SWIFT_PROGRAM,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    let state_token = associated_token_address(
        &state,
        facts.source_usdc_address,
        true,
        BridgeErrorCode::LocalBuildInvalid,
    )?;
    let init = make_swift_init_instruction(
        quote,
        facts,
        swapper_address,
        destination_address,
        &state,
        &state_token,
        &parsed.minimum_intermediate_amount,
        parsed.cancel_fee,
        parsed.refund_fee,
        parsed.submit_fee,
        parsed.mode,
        order_nonce,
    )?;
    if facts.asset == BridgeAsset::Usdc {
        let mut instructions = Vec::new();
        if let Some(fee) = parsed.suggested_priority_fee {
            if fee > 0 {
                instructions.push(make_compute_unit_price_instruction(fee));
            }
        }
        let state_ata =
            make_ata_instruction(swapper_address, &state, facts.source_usdc_address, true)?;
        let trader_ata = associated_token_address(
            swapper_address,
            facts.source_usdc_address,
            false,
            BridgeErrorCode::LocalBuildInvalid,
        )?;
        instructions.push(wrap_in_cpi_proxy(state_ata));
        instructions.push(wrap_in_cpi_proxy(make_spl_transfer_instruction(
            &trader_ata,
            &state_token,
            swapper_address,
            local_uint64(&quote.amount_in, true, BridgeErrorCode::LocalBuildInvalid)?,
        )));
        instructions.push(wrap_in_cpi_proxy(init));
        return Ok(instructions);
    }
    let MayanSwiftV2LocalSourceSwapPlan::SolanaJupiterV6 {
        instructions: source,
        ..
    } = plan
    else {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    };
    let compute_count = source
        .iter()
        .take_while(|instruction| instruction.program_id == SOLANA_COMPUTE_BUDGET_PROGRAM)
        .count();
    let swap_index = source
        .iter()
        .enumerate()
        .skip(compute_count)
        .find_map(|(index, instruction)| {
            (instruction.program_id == SOLANA_JUPITER_V6).then_some(index)
        })
        .ok_or_else(|| local_error(BridgeErrorCode::LocalBuildInvalid))?;
    if swap_index <= compute_count || source.len() != swap_index + 1 {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    let mut output = source[..compute_count].to_vec();
    output.extend(
        source[compute_count..swap_index]
            .iter()
            .cloned()
            .map(wrap_in_cpi_proxy),
    );
    output.push(source[swap_index].clone());
    output.push(wrap_in_cpi_proxy(init));
    Ok(output)
}

fn encode_short_vec(value: usize, code: BridgeErrorCode) -> BridgeResult<Vec<u8>> {
    if value > u16::MAX as usize {
        return Err(local_error(code));
    }
    let mut value = value;
    let mut output = Vec::new();
    loop {
        let mut byte = u8::try_from(value & 0x7f).map_err(|_| local_error(code))?;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        output.push(byte);
        if value == 0 {
            break;
        }
    }
    Ok(output)
}

#[derive(Clone, Copy, Debug)]
struct SolanaKeyMeta {
    signer: bool,
    writable: bool,
    invoked: bool,
}

#[derive(Clone, Debug)]
struct CompiledSolanaInstruction {
    program_id_index: u8,
    account_key_indexes: Vec<u8>,
    data: Vec<u8>,
}

#[derive(Clone, Debug)]
struct AddressTableLookup {
    account_key: String,
    writable_indexes: Vec<u8>,
    readonly_indexes: Vec<u8>,
}

fn insert_solana_key(
    key_order: &mut Vec<String>,
    key_meta: &mut HashMap<String, SolanaKeyMeta>,
    address: &str,
) {
    if key_meta.contains_key(address) {
        return;
    }
    key_order.push(address.to_owned());
    key_meta.insert(
        address.to_owned(),
        SolanaKeyMeta {
            signer: false,
            writable: false,
            invoked: false,
        },
    );
}

fn compile_solana_v0(
    payer: &str,
    recent_blockhash: &str,
    instructions: &[MayanSwiftV2LocalSourceSwapInstruction],
    lookup_tables: &[LocalLookupTable],
) -> BridgeResult<String> {
    let mut key_order = Vec::new();
    let mut key_meta = HashMap::new();
    insert_solana_key(&mut key_order, &mut key_meta, payer);
    if let Some(meta) = key_meta.get_mut(payer) {
        meta.signer = true;
        meta.writable = true;
    }
    for instruction in instructions {
        insert_solana_key(&mut key_order, &mut key_meta, &instruction.program_id);
        if let Some(meta) = key_meta.get_mut(&instruction.program_id) {
            meta.invoked = true;
        }
        for account in &instruction.accounts {
            insert_solana_key(&mut key_order, &mut key_meta, &account.pubkey);
            if let Some(meta) = key_meta.get_mut(&account.pubkey) {
                meta.signer |= account.is_signer;
                meta.writable |= account.is_writable;
            }
        }
    }
    let mut lookup_lookups = Vec::new();
    let mut writable_lookup_keys = Vec::new();
    let mut readonly_lookup_keys = Vec::new();
    for table in lookup_tables {
        let mut writable_indexes = Vec::new();
        let mut readonly_indexes = Vec::new();
        let active = key_order.clone();
        for address in active {
            let Some(meta) = key_meta.get(&address).copied() else {
                continue;
            };
            if meta.signer || meta.invoked || !meta.writable {
                continue;
            }
            let Some(index) = table.addresses.iter().position(|entry| entry == &address) else {
                continue;
            };
            if index > u8::MAX as usize {
                return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
            }
            writable_indexes.push(u8::try_from(index).expect("ALT index fits"));
            writable_lookup_keys.push(address.clone());
            key_order.retain(|entry| entry != &address);
        }
        let active = key_order.clone();
        for address in active {
            let Some(meta) = key_meta.get(&address).copied() else {
                continue;
            };
            if meta.signer || meta.invoked || meta.writable {
                continue;
            }
            let Some(index) = table.addresses.iter().position(|entry| entry == &address) else {
                continue;
            };
            if index > u8::MAX as usize {
                return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
            }
            readonly_indexes.push(u8::try_from(index).expect("ALT index fits"));
            readonly_lookup_keys.push(address.clone());
            key_order.retain(|entry| entry != &address);
        }
        if !writable_indexes.is_empty() || !readonly_indexes.is_empty() {
            lookup_lookups.push(AddressTableLookup {
                account_key: table.address.clone(),
                writable_indexes,
                readonly_indexes,
            });
        }
    }
    if lookup_lookups.len() > MAX_LOOKUP_TABLES {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    let writable_signers = key_order
        .iter()
        .filter(|address| {
            let meta = key_meta.get(*address).expect("key metadata");
            meta.signer && meta.writable
        })
        .cloned()
        .collect::<Vec<_>>();
    let readonly_signers = key_order
        .iter()
        .filter(|address| {
            let meta = key_meta.get(*address).expect("key metadata");
            meta.signer && !meta.writable
        })
        .cloned()
        .collect::<Vec<_>>();
    let writable_non_signers = key_order
        .iter()
        .filter(|address| {
            let meta = key_meta.get(*address).expect("key metadata");
            !meta.signer && meta.writable
        })
        .cloned()
        .collect::<Vec<_>>();
    let readonly_non_signers = key_order
        .iter()
        .filter(|address| {
            let meta = key_meta.get(*address).expect("key metadata");
            !meta.signer && !meta.writable
        })
        .cloned()
        .collect::<Vec<_>>();
    if writable_signers.len() != 1
        || !readonly_signers.is_empty()
        || writable_signers.first().map(String::as_str) != Some(payer)
    {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    let static_keys = writable_signers
        .into_iter()
        .chain(readonly_signers)
        .chain(writable_non_signers)
        .chain(readonly_non_signers)
        .collect::<Vec<_>>();
    let mut all_keys = static_keys.clone();
    all_keys.extend(writable_lookup_keys.clone());
    all_keys.extend(readonly_lookup_keys.clone());
    if static_keys.len() > 256 || all_keys.len() > 256 {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    let key_indexes = all_keys
        .iter()
        .enumerate()
        .map(|(index, address)| {
            (
                address.as_str(),
                u8::try_from(index).expect("key index fits"),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut compiled = Vec::with_capacity(instructions.len());
    for instruction in instructions {
        let program_id_index = *key_indexes
            .get(instruction.program_id.as_str())
            .ok_or_else(|| local_error(BridgeErrorCode::LocalBuildInvalid))?;
        let account_key_indexes = instruction
            .accounts
            .iter()
            .map(|account| {
                key_indexes
                    .get(account.pubkey.as_str())
                    .copied()
                    .ok_or_else(|| local_error(BridgeErrorCode::LocalBuildInvalid))
            })
            .collect::<BridgeResult<Vec<_>>>()?;
        let data = if instruction.data_base64.is_empty() {
            Vec::new()
        } else {
            decode_base64(&instruction.data_base64)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?
        };
        compiled.push(CompiledSolanaInstruction {
            program_id_index,
            account_key_indexes,
            data,
        });
    }
    let required_signatures = static_keys
        .iter()
        .filter(|address| key_meta.get(*address).is_some_and(|meta| meta.signer))
        .count();
    let readonly_signatures = static_keys
        .iter()
        .filter(|address| {
            key_meta
                .get(*address)
                .is_some_and(|meta| meta.signer && !meta.writable)
        })
        .count();
    let readonly_unsigned = static_keys
        .iter()
        .filter(|address| {
            key_meta
                .get(*address)
                .is_some_and(|meta| !meta.signer && !meta.writable)
        })
        .count();
    let mut message = vec![
        0x80,
        u8::try_from(required_signatures).expect("signature count fits"),
    ];
    message.push(u8::try_from(readonly_signatures).expect("readonly signer count fits"));
    message.push(u8::try_from(readonly_unsigned).expect("readonly unsigned count fits"));
    message.extend(encode_short_vec(
        static_keys.len(),
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    for address in &static_keys {
        message.extend(
            decode_base58(address, 32)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?,
        );
    }
    message.extend(
        decode_base58(
            &canonical_solana_address(recent_blockhash, BridgeErrorCode::LocalBuildInvalid)?,
            32,
        )
        .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?,
    );
    message.extend(encode_short_vec(
        compiled.len(),
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    for instruction in &compiled {
        message.push(instruction.program_id_index);
        message.extend(encode_short_vec(
            instruction.account_key_indexes.len(),
            BridgeErrorCode::LocalBuildInvalid,
        )?);
        message.extend(&instruction.account_key_indexes);
        message.extend(encode_short_vec(
            instruction.data.len(),
            BridgeErrorCode::LocalBuildInvalid,
        )?);
        message.extend(&instruction.data);
    }
    message.extend(encode_short_vec(
        lookup_lookups.len(),
        BridgeErrorCode::LocalBuildInvalid,
    )?);
    for lookup in &lookup_lookups {
        message.extend(
            decode_base58(&lookup.account_key, 32)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?,
        );
        message.extend(encode_short_vec(
            lookup.writable_indexes.len(),
            BridgeErrorCode::LocalBuildInvalid,
        )?);
        message.extend(&lookup.writable_indexes);
        message.extend(encode_short_vec(
            lookup.readonly_indexes.len(),
            BridgeErrorCode::LocalBuildInvalid,
        )?);
        message.extend(&lookup.readonly_indexes);
    }
    let mut transaction =
        encode_short_vec(required_signatures, BridgeErrorCode::LocalBuildInvalid)?;
    transaction.extend(vec![0_u8; required_signatures * 64]);
    transaction.extend(message);
    if transaction.len() > MAX_SOLANA_TRANSACTION_BYTES {
        return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
    }
    Ok(encode_base64(&transaction))
}

fn local_plan_error_passthrough(code: BridgeErrorCode) -> bool {
    matches!(
        code,
        BridgeErrorCode::ProviderHttp
            | BridgeErrorCode::ProviderTransport
            | BridgeErrorCode::ProviderInvalidResponse
            | BridgeErrorCode::Timeout
            | BridgeErrorCode::Aborted
            | BridgeErrorCode::QuoteExpired
    )
}

/// Builds a local unsigned transaction using the supplied source-swap plan
/// and matching caller-configured source RPC.
pub(crate) async fn build_local_unsigned(
    client: &MayanSwiftV2BridgeClient,
    request: MayanSwiftV2LocalBuildRequest,
    cancellation: Option<&CancellationToken>,
) -> BridgeResult<MayanSwiftV2LocalBuild> {
    let result = async {
        let facts = local_route(&request.quote)?;
        validate_local_raw_quote(client, &request.quote, &facts)?;
        let parsed = parse_local_quote(&request.quote, &facts)?;
        let (swapper_address, destination_address) = local_normalized_addresses(
            &facts,
            &request.swapper_address,
            &request.destination_address,
        )?;
        if request.order_nonce.len() != 34
            || !request.order_nonce.starts_with("0x")
            || !request.order_nonce[2..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || hex_to_bytes(&request.order_nonce)
                .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?
                .len()
                != 16
        {
            return Err(local_error(BridgeErrorCode::LocalBuildInvalid));
        }
        local_destination_minimum_compatibility(&request.quote.minimum_amount_out)
            .map_err(|_| local_error(BridgeErrorCode::LocalBuildInvalid))?;
        local_quote_deadline_check(client, &request.quote).map_err(|error| {
            if error.code() == BridgeErrorCode::QuoteExpired {
                error
            } else {
                local_error(BridgeErrorCode::LocalBuildInvalid)
            }
        })?;
        let raw_quote_sha256 = sha256_hex(request.quote.raw_signed_quote_json.as_bytes());
        let order_hash = hash_order(
            &request.quote,
            &facts,
            &swapper_address,
            &destination_address,
            &request.order_nonce,
            parsed.cancel_fee,
            parsed.refund_fee,
            parsed.mode,
        )?;
        let binding = quote_binding_hash(
            &facts,
            &request.quote,
            &raw_quote_sha256,
            &request.order_nonce,
            &swapper_address,
            &destination_address,
        );
        validate_plan(
            &request,
            &facts,
            &parsed,
            &request.source_swap_plan,
            &raw_quote_sha256,
            &order_hash,
            &binding,
            &swapper_address,
            &destination_address,
        )?;
        let rpc = fetch_source_rpc(
            client,
            &facts,
            &request.source_swap_plan.source_swap,
            cancellation,
        )
        .await?;
        let transaction = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
            MayanSwiftV2UnsignedTransaction::Evm(crate::bridge::MayanEvmUnsignedTransaction {
                kind: "evm-unsigned-transaction".to_owned(),
                chain_id: ETHEREUM_CHAIN_ID.to_owned(),
                from: swapper_address.clone(),
                to: ETHEREUM_FORWARDER.to_owned(),
                data: build_evm_order_call(
                    &request.quote,
                    &facts,
                    &request.source_swap_plan.source_swap,
                    &swapper_address,
                    &destination_address,
                    &parsed.minimum_intermediate_amount,
                    parsed.cancel_fee,
                    parsed.refund_fee,
                    parsed.mode,
                    &request.order_nonce,
                )?,
                value: "0".to_owned(),
            })
        } else {
            let instructions = build_solana_instructions(
                &request.quote,
                &facts,
                &request.source_swap_plan.source_swap,
                &swapper_address,
                &destination_address,
                &parsed,
                &order_hash,
                &request.order_nonce,
            )?;
            let recent_blockhash = rpc
                .recent_blockhash
                .as_deref()
                .ok_or_else(|| local_error(BridgeErrorCode::LocalBuildInvalid))?;
            let transaction_base64 = compile_solana_v0(
                &swapper_address,
                recent_blockhash,
                &instructions,
                &rpc.lookup_tables,
            )?;
            MayanSwiftV2UnsignedTransaction::Solana(crate::bridge::MayanSolanaUnsignedTransaction {
                kind: "solana-v0-unsigned-transaction".to_owned(),
                chain_id: SOLANA_CHAIN_ID.to_owned(),
                fee_payer: swapper_address.clone(),
                transaction_base64,
            })
        };
        let allowance = if facts.source_chain_id == ETHEREUM_CHAIN_ID {
            Some(MayanSwiftV2Allowance {
                token_deployment_id: facts.source_token_deployment_id.to_owned(),
                token_address: facts.source_token_address.to_owned(),
                owner: swapper_address.clone(),
                spender: ETHEREUM_FORWARDER.to_owned(),
                required_amount: request.quote.amount_in.clone(),
            })
        } else {
            None
        };
        Ok(MayanSwiftV2LocalBuild {
            build_kind: "mayan-swift-v2-local-unsigned".to_owned(),
            provider_id: "mayan-swift-v2".to_owned(),
            capability_id: facts.bridge_capability_id.to_owned(),
            quote: request.quote.clone(),
            source_chain_id: facts.source_chain_id.to_owned(),
            destination_chain_id: facts.destination_chain_id.to_owned(),
            source_swap_plan: request.source_swap_plan.clone(),
            transaction,
            allowance,
            construction: MayanSwiftV2LocalConstruction {
                mode: "local".to_owned(),
                reference_commit: MAYAN_REFERENCE_COMMIT.to_owned(),
                order_nonce: request.order_nonce.clone(),
                order_hash,
                minimum_intermediate_amount: parsed.minimum_intermediate_amount,
                effective_dependencies: local_build_dependencies(&facts),
                source_rpc_evidence: rpc.evidence,
            },
            validation: MayanSwiftV2LocalBuildValidation {
                level: "local-structural".to_owned(),
                quote_signature_locally_verified: false,
                plan_binding_locally_verified: true,
                transaction_bytes_locally_constructed: true,
                settlement_locally_verified: false,
            },
        })
    }
    .await;
    match result {
        Ok(build) => Ok(build),
        Err(error)
            if local_plan_error_passthrough(error.code())
                || matches!(
                    error.code(),
                    BridgeErrorCode::LocalRpcRequired
                        | BridgeErrorCode::SourceRpcTransport
                        | BridgeErrorCode::SourceRpcInvalidResponse
                ) =>
        {
            Err(error)
        }
        Err(_) => Err(local_error(BridgeErrorCode::LocalBuildInvalid)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RpcEndpointConfig;
    use wiremock::{
        Mock, MockServer, Request, Respond, ResponseTemplate,
        matchers::{body_string, method},
    };

    const LOCAL_FIXTURE: &str =
        include_str!("../../../registry/fixtures/mayan-swift-v2-local-build-cases.json");

    fn fixture() -> Value {
        serde_json::from_str(LOCAL_FIXTURE).expect("local fixture JSON")
    }

    struct RpcResponder {
        responses: HashMap<String, String>,
    }

    impl Respond for RpcResponder {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body = String::from_utf8(request.body.clone()).expect("RPC request UTF-8");
            let parsed = serde_json::from_str::<Value>(&body).expect("RPC request JSON");
            let method = parsed["method"].as_str().expect("RPC method");
            ResponseTemplate::new(200)
                .set_body_string(self.responses.get(method).expect("RPC response").clone())
        }
    }

    #[test]
    fn local_hash_vectors_match_the_frozen_contract() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][0]["normalizedQuote"].clone(),
        )
        .expect("EURC quote");
        let facts = local_route(&quote).expect("EURC route");
        let parsed = parse_local_quote(&quote, &facts).expect("EURC local quote");
        let swapper = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let destination = "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b";
        let nonce = "0x00112233445566778899aabbccddeeff";
        let order = hash_order(
            &quote,
            &facts,
            swapper,
            destination,
            nonce,
            parsed.cancel_fee,
            parsed.refund_fee,
            parsed.mode,
        )
        .expect("order hash");
        assert_eq!(
            order,
            "0x2b829e91e9aecd4a43d5c1345feda1bc4e6b6ecb538684ead21ce04d9e0f6cbc"
        );
        let raw_hash = sha256_hex(quote.raw_signed_quote_json.as_bytes());
        assert_eq!(
            raw_hash,
            "5e914957de7c12b0fa93e462ebe1ef1ca5875736915acdc63c98694c7c9c4189"
        );
        let binding = quote_binding_hash(&facts, &quote, &raw_hash, nonce, swapper, destination);
        assert_eq!(
            binding,
            "8307b90ff89eb633da5bc04ff4ee38344b431e4ebb8c3ee9b9e9fe2c0909ea5d"
        );
    }

    #[test]
    fn local_trailing_json_whitespace_preserves_raw_bytes_and_hosted_framing() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][0]["normalizedQuote"].clone(),
        )
        .expect("EURC quote");
        assert!(quote.raw_signed_quote_json.ends_with('\n'));
        let original_raw = quote.raw_signed_quote_json.clone();
        let facts = local_route(&quote).expect("EURC route");
        let client = MayanSwiftV2BridgeClient::new(crate::bridge::MayanSwiftV2BridgeConfig::new())
            .expect("local client")
            .with_clock(|| 1_789_600_000);
        let request = MayanSwiftV2QuoteRequest {
            source_chain_id: quote.source_chain_id.clone(),
            destination_chain_id: quote.destination_chain_id.clone(),
            source_token_deployment_id: quote.source_token_deployment_id.clone(),
            destination_token_deployment_id: quote.destination_token_deployment_id.clone(),
            amount_in: quote.amount_in.clone(),
            slippage_bps: quote.slippage_bps,
        };
        assert_eq!(
            crate::bridge::validate_raw_quote_for_build(&quote, &request, &facts, &client)
                .expect_err("hosted framing must remain strict")
                .code(),
            BridgeErrorCode::QuoteMismatch
        );
        validate_local_raw_quote(&client, &quote, &facts).expect("local trailing trim");
        assert_eq!(quote.raw_signed_quote_json, original_raw);
        assert!(
            !trim_local_raw_trailing_json_whitespace(&quote.raw_signed_quote_json).ends_with('\n')
        );
    }

    #[test]
    fn local_evm_source_swap_plan_hash_matches_the_frozen_vector() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][0]["normalizedQuote"].clone(),
        )
        .expect("EURC quote");
        let facts = local_route(&quote).expect("EURC route");
        let parsed = parse_local_quote(&quote, &facts).expect("EURC local quote");
        let body = fixture["sourceSwapMocks"][0]["response"]["body"]
            .as_str()
            .expect("source swap body");
        let response = parse_provider_response(body.to_owned()).expect("source swap JSON");
        let mut source_swap = validate_source_swap(
            &quote,
            &facts,
            &response.root.value,
            None,
            None,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &parsed.minimum_intermediate_amount,
        )
        .expect("source swap");
        if let MayanSwiftV2LocalSourceSwapPlan::EvmRouter {
            raw_response_sha256,
            raw_provider_source_swap_json,
            ..
        } = &mut source_swap
        {
            *raw_response_sha256 = sha256_hex(body.as_bytes());
            *raw_provider_source_swap_json = body.to_owned();
        }
        let hash = plan_hash(
            "8307b90ff89eb633da5bc04ff4ee38344b431e4ebb8c3ee9b9e9fe2c0909ea5d",
            &source_swap,
        )
        .expect("plan hash");
        assert_eq!(
            hash,
            "de31f6a691edaeab5a1c5dfa68ab6c9a88f98fefdfc1142f28d555d77258d473"
        );
    }

    #[tokio::test]
    async fn local_prepare_uses_the_anonymous_source_swap_endpoint() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][0]["normalizedQuote"].clone(),
        )
        .expect("EURC quote");
        let context = MayanSwiftV2LocalContext {
            quote,
            swapper_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            destination_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            order_nonce: "0x00112233445566778899aabbccddeeff".to_owned(),
        };
        let source_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    fixture["sourceSwapMocks"][0]["response"]["body"]
                        .as_str()
                        .expect("source swap body"),
                ),
            )
            .expect(1)
            .mount(&source_server)
            .await;
        let client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new().with_local_build(
                crate::bridge::MayanSwiftV2LocalBuildConfig::new()
                    .with_source_swap_endpoint(source_server.uri()),
            ),
        )
        .expect("local client")
        .with_clock(|| 1_789_600_000);
        let plan = prepare_source_swap(&client, context, None)
            .await
            .expect("local plan");
        let expected = fixture["cases"]
            .as_array()
            .and_then(|cases| {
                cases
                    .iter()
                    .find(|case| case["caseId"] == "prepare-eurc-ethereum-to-solana")
            })
            .and_then(|case| case["expected"]["value"].as_object())
            .cloned()
            .map(Value::Object)
            .expect("expected plan");
        assert_eq!(serde_json::to_value(plan).expect("plan JSON"), expected);
    }

    #[tokio::test]
    async fn local_usdc_evm_build_matches_the_frozen_transaction() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][2]["normalizedQuote"].clone(),
        )
        .expect("USDC quote");
        let client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new()
                .with_local_build(crate::bridge::MayanSwiftV2LocalBuildConfig::new()),
        )
        .expect("local client")
        .with_clock(|| 1_789_600_000);
        let context = MayanSwiftV2LocalContext {
            quote: quote.clone(),
            swapper_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            destination_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            order_nonce: "0x112233445566778899aabbccddeeff00".to_owned(),
        };
        let plan = prepare_source_swap(&client, context.clone(), None)
            .await
            .expect("USDC plan");
        let rpc_server = MockServer::start().await;
        for index in 0..3 {
            let mock = &fixture["rpcMocks"][index];
            Mock::given(method("POST"))
                .and(body_string(
                    mock["request"]["body"].as_str().expect("RPC request body"),
                ))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(
                        mock["response"]["body"]
                            .as_str()
                            .expect("RPC response body"),
                    ),
                )
                .expect(1)
                .mount(&rpc_server)
                .await;
        }
        let build_client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new().with_local_build(
                crate::bridge::MayanSwiftV2LocalBuildConfig::new()
                    .with_ethereum_rpc(RpcEndpointConfig::new(rpc_server.uri())),
            ),
        )
        .expect("local build client")
        .with_clock(|| 1_789_600_000);
        let build = build_client
            .build_local_unsigned(MayanSwiftV2LocalBuildRequest {
                quote,
                swapper_address: context.swapper_address,
                destination_address: context.destination_address,
                order_nonce: context.order_nonce,
                source_swap_plan: plan,
            })
            .await
            .expect("USDC local build");
        let expected = fixture["cases"]
            .as_array()
            .and_then(|cases| {
                cases
                    .iter()
                    .find(|case| case["caseId"] == "build-usdc-ethereum-to-solana")
            })
            .and_then(|case| case["expected"]["value"].as_object())
            .cloned()
            .map(Value::Object)
            .expect("expected USDC build");
        assert_eq!(serde_json::to_value(build).expect("build JSON"), expected);
    }

    #[tokio::test]
    async fn local_solana_prepare_matches_the_frozen_plan() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][1]["normalizedQuote"].clone(),
        )
        .expect("Solana EURC quote");
        let context = MayanSwiftV2LocalContext {
            quote,
            swapper_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            destination_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            order_nonce: "0x102132435465768798a9bacbdcedfe0f".to_owned(),
        };
        let source_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    fixture["sourceSwapMocks"][1]["response"]["body"]
                        .as_str()
                        .expect("source swap body"),
                ),
            )
            .expect(1)
            .mount(&source_server)
            .await;
        let client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new().with_local_build(
                crate::bridge::MayanSwiftV2LocalBuildConfig::new()
                    .with_source_swap_endpoint(source_server.uri()),
            ),
        )
        .expect("local client")
        .with_clock(|| 1_789_600_000);
        let plan = prepare_source_swap(&client, context, None)
            .await
            .expect("Solana plan");
        let expected = fixture["cases"]
            .as_array()
            .and_then(|cases| {
                cases
                    .iter()
                    .find(|case| case["caseId"] == "prepare-eurc-solana-to-ethereum")
            })
            .and_then(|case| case["expected"]["value"].as_object())
            .cloned()
            .map(Value::Object)
            .expect("expected Solana plan");
        assert_eq!(serde_json::to_value(plan).expect("plan JSON"), expected);
    }

    #[tokio::test]
    async fn local_solana_build_matches_the_frozen_transaction() {
        let fixture = fixture();
        let quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"][1]["normalizedQuote"].clone(),
        )
        .expect("Solana EURC quote");
        let context = MayanSwiftV2LocalContext {
            quote: quote.clone(),
            swapper_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            destination_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            order_nonce: "0x102132435465768798a9bacbdcedfe0f".to_owned(),
        };
        let source_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    fixture["sourceSwapMocks"][1]["response"]["body"]
                        .as_str()
                        .expect("source swap body"),
                ),
            )
            .expect(1)
            .mount(&source_server)
            .await;
        let prepare_client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new().with_local_build(
                crate::bridge::MayanSwiftV2LocalBuildConfig::new()
                    .with_source_swap_endpoint(source_server.uri()),
            ),
        )
        .expect("prepare client")
        .with_clock(|| 1_789_600_000);
        let plan = prepare_source_swap(&prepare_client, context.clone(), None)
            .await
            .expect("Solana plan");
        let rpc_server = MockServer::start().await;
        let responses = [4_usize, 5, 6]
            .into_iter()
            .map(|index| {
                let request = serde_json::from_str::<Value>(
                    fixture["rpcMocks"][index]["request"]["body"]
                        .as_str()
                        .expect("RPC request body"),
                )
                .expect("RPC request JSON");
                (
                    request["method"].as_str().expect("RPC method").to_owned(),
                    fixture["rpcMocks"][index]["response"]["body"]
                        .as_str()
                        .expect("RPC response body")
                        .to_owned(),
                )
            })
            .collect::<HashMap<_, _>>();
        Mock::given(method("POST"))
            .respond_with(RpcResponder { responses })
            .mount(&rpc_server)
            .await;
        let build_client = MayanSwiftV2BridgeClient::new(
            crate::bridge::MayanSwiftV2BridgeConfig::new().with_local_build(
                crate::bridge::MayanSwiftV2LocalBuildConfig::new()
                    .with_solana_rpc(RpcEndpointConfig::new(rpc_server.uri())),
            ),
        )
        .expect("build client")
        .with_clock(|| 1_789_600_000);
        let build = build_local_unsigned(
            &build_client,
            MayanSwiftV2LocalBuildRequest {
                quote,
                swapper_address: context.swapper_address,
                destination_address: context.destination_address,
                order_nonce: context.order_nonce,
                source_swap_plan: plan,
            },
            None,
        )
        .await
        .expect("Solana build");
        let expected = fixture["cases"]
            .as_array()
            .and_then(|cases| {
                cases
                    .iter()
                    .find(|case| case["caseId"] == "build-eurc-solana-to-ethereum")
            })
            .and_then(|case| case["expected"]["value"].as_object())
            .cloned()
            .map(Value::Object)
            .expect("expected Solana build");
        assert_eq!(serde_json::to_value(build).expect("build JSON"), expected);
    }

    #[test]
    fn edwards_zip215_private_vectors_cover_identity_sign_and_invalid_sqrt() {
        let mut identity = [0_u8; 32];
        identity[0] = 1;
        assert!(is_on_curve_zip215(&identity));
        let mut identity_sign_one = identity;
        identity_sign_one[31] |= 0x80;
        assert!(is_on_curve_zip215(&identity_sign_one));

        // p = 2^255 - 19, encoded little-endian. ZIP215 accepts this
        // non-canonical y encoding after field reduction.
        let mut noncanonical_y = [0xff_u8; 32];
        noncanonical_y[0] = 0xed;
        noncanonical_y[31] = 0x7f;
        assert!(is_on_curve_zip215(&noncanonical_y));

        let invalid_sqrt = [2_u8; 32].map(|value| if value == 2 { 2 } else { 0 });
        assert!(!is_on_curve_zip215(&invalid_sqrt));
    }

    #[test]
    fn pda_seed_and_bump_bounds_are_rejected_without_io() {
        let program = SOLANA_SWIFT_PROGRAM;
        let oversized_seed = [0_u8; 33];
        assert!(
            find_program_address(
                &[&oversized_seed],
                program,
                BridgeErrorCode::LocalPlanInvalid
            )
            .is_err()
        );
        let seeds = (0..17).map(|_| &[0_u8; 1][..]).collect::<Vec<_>>();
        assert!(find_program_address(&seeds, program, BridgeErrorCode::LocalPlanInvalid).is_err());
        assert!(
            find_program_address(
                &[b"STATE_SOURCE"],
                program,
                BridgeErrorCode::LocalPlanInvalid
            )
            .is_ok()
        );
    }

    #[test]
    fn lookup_table_private_vectors_enforce_layout_and_same_slot_prefix() {
        let context_slot = 42_u64;
        let mut data = vec![0_u8; 56 + 64];
        data[0..4].copy_from_slice(&1_u32.to_le_bytes());
        data[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
        data[12..20].copy_from_slice(&context_slot.to_le_bytes());
        data[20] = 1;
        data[21] = 0;
        let first = [7_u8; 32];
        let second = [8_u8; 32];
        data[56..88].copy_from_slice(&first);
        data[88..120].copy_from_slice(&second);
        let table = decode_lookup_table(
            "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht".to_owned(),
            &data,
            SOLANA_ADDRESS_LOOKUP_TABLE_OWNER,
            context_slot,
            BridgeErrorCode::SourceRpcInvalidResponse,
        )
        .expect("active prefix");
        assert_eq!(table.addresses, vec![encode_base58(&first)]);

        let mut wrong_kind = data.clone();
        wrong_kind[0] = 2;
        assert!(
            decode_lookup_table(
                "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht".to_owned(),
                &wrong_kind,
                SOLANA_ADDRESS_LOOKUP_TABLE_OWNER,
                context_slot,
                BridgeErrorCode::SourceRpcInvalidResponse,
            )
            .is_err()
        );
    }
}

/// Native local-fixture replay used by the bridge parity capture. Keeping the
/// runner in the Rust crate makes the capture exercise the public local
/// methods while still allowing the frozen fixture's clock and loopback
/// transports to be deterministic.
#[cfg(test)]
pub(crate) mod native_fixture {
    use super::*;
    use crate::{
        RpcEndpointConfig,
        bridge::{BridgeErrorCode, MayanSwiftV2BridgeConfig, MayanSwiftV2LocalBuildConfig},
    };
    use serde_json::{Map, json};
    use std::{collections::HashMap, time::Duration};
    use tokio::time::sleep;
    use url::Url;
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate, matchers::method};

    const FIXED_CLOCK: u64 = 1_789_600_000;

    #[derive(Clone, Debug)]
    struct RpcResponse {
        status: u16,
        body: String,
    }

    struct RpcResponder {
        responses: HashMap<String, RpcResponse>,
        delay: Option<Duration>,
    }

    impl Respond for RpcResponder {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            let body = String::from_utf8(request.body.clone()).expect("RPC request UTF-8");
            let response = self
                .responses
                .get(&body)
                .expect("RPC request is present in the fixture");
            let mut template =
                ResponseTemplate::new(response.status).set_body_string(response.body.clone());
            if let Some(delay) = self.delay {
                template = template.set_delay(delay);
            }
            template
        }
    }

    fn fixed_clock() -> u64 {
        FIXED_CLOCK
    }

    fn set_path(root: &mut Value, path: &str, value: Value) {
        let parts = path
            .split('.')
            .flat_map(|part| {
                let mut output = Vec::new();
                let mut start = 0;
                for (index, character) in part.char_indices() {
                    if character == '[' {
                        if start < index {
                            output.push(part[start..index].to_owned());
                        }
                        let end = part[index + 1..]
                            .find(']')
                            .map(|offset| index + 1 + offset)
                            .expect("fixture mutation index");
                        output.push(part[index + 1..end].to_owned());
                        start = end + 1;
                    }
                }
                if start < part.len() {
                    output.push(part[start..].to_owned());
                }
                output
            })
            .collect::<Vec<_>>();
        assert!(!parts.is_empty(), "fixture mutation path");
        let mut cursor = root;
        for part in &parts[..parts.len() - 1] {
            if let Ok(index) = part.parse::<usize>() {
                cursor = cursor
                    .as_array_mut()
                    .expect("fixture mutation array")
                    .get_mut(index)
                    .expect("fixture mutation index");
            } else {
                cursor = cursor
                    .as_object_mut()
                    .expect("fixture mutation object")
                    .get_mut(part)
                    .expect("fixture mutation key");
            }
        }
        let leaf = parts.last().expect("fixture mutation leaf");
        if let Ok(index) = leaf.parse::<usize>() {
            cursor.as_array_mut().expect("fixture mutation leaf array")[index] = value;
        } else {
            cursor
                .as_object_mut()
                .expect("fixture mutation leaf object")
                .insert(leaf.clone(), value);
        }
    }

    fn mutation<'a>(case: &'a Value, kind: &str) -> Option<&'a Map<String, Value>> {
        case.get("mutation")
            .and_then(Value::as_object)
            .filter(|value| value.get("kind").and_then(Value::as_str) == Some(kind))
    }

    fn quote_for_case(fixture: &Value, case: &Value) -> MayanSwiftV2Quote {
        let quote_id = case["quoteId"].as_str().expect("fixture quote ID");
        let mut quote = fixture["quotes"]
            .as_array()
            .expect("fixture quotes")
            .iter()
            .find(|entry| entry["quoteId"].as_str() == Some(quote_id))
            .and_then(|entry| entry.get("normalizedQuote"))
            .cloned()
            .map(|value| serde_json::from_value(value).expect("fixture normalized quote"))
            .expect("fixture quote");
        let Some(mutation) = case.get("mutation").and_then(Value::as_object) else {
            return quote;
        };
        match mutation.get("kind").and_then(Value::as_str) {
            Some("quote-normalized-set") => {
                let value = mutation
                    .get("value")
                    .cloned()
                    .expect("quote mutation value");
                match mutation.get("path").and_then(Value::as_str) {
                    Some("destinationTokenDeploymentId") => {
                        quote.destination_token_deployment_id = value
                            .as_str()
                            .expect("normalized quote mutation string")
                            .to_owned();
                    }
                    Some("sourceSwap.required") => {
                        quote.source_swap.required =
                            value.as_bool().expect("normalized quote mutation bool");
                    }
                    Some("providerSignature") => {
                        quote.provider_signature = value
                            .as_str()
                            .expect("normalized quote mutation signature")
                            .to_owned();
                    }
                    Some("sourceSwap.providerMinimumAmount") => {
                        quote.source_swap.provider_minimum_amount = value
                            .as_str()
                            .expect("normalized quote mutation provider minimum")
                            .to_owned();
                    }
                    Some("slippageBps") => {
                        quote.slippage_bps =
                            value.as_u64().expect("normalized quote mutation slippage");
                    }
                    Some("minimumAmountOut") => {
                        quote.minimum_amount_out = value
                            .as_str()
                            .expect("normalized quote mutation minimum")
                            .to_owned();
                    }
                    Some("rawSignedQuoteJson") => {
                        quote.raw_signed_quote_json = value
                            .as_str()
                            .expect("normalized quote mutation raw JSON")
                            .to_owned();
                    }
                    path => panic!("unsupported normalized quote mutation {path:?}"),
                }
            }
            Some("quote-raw-set") => {
                let mut raw: Value =
                    serde_json::from_str(&quote.raw_signed_quote_json).expect("raw quote JSON");
                set_path(
                    &mut raw,
                    mutation
                        .get("path")
                        .and_then(Value::as_str)
                        .expect("raw quote mutation path"),
                    mutation
                        .get("value")
                        .cloned()
                        .expect("raw quote mutation value"),
                );
                quote.raw_signed_quote_json =
                    serde_json::to_string(&raw).expect("raw quote mutation serializes");
            }
            Some(
                "plan-set"
                | "source-swap-response-set"
                | "rpc-response-set"
                | "rpc-envelope-set"
                | "config-set"
                | "boundary"
                | "transport",
            )
            | None => {}
            Some(kind) => panic!("unsupported quote mutation {kind}"),
        }
        quote
    }

    fn source_mock_for_case<'a>(fixture: &'a Value, case: &Value) -> Option<&'a Value> {
        let ids = case["sourceSwapMockIds"].as_array()?;
        let id = ids.first()?.as_str()?;
        fixture["sourceSwapMocks"]
            .as_array()?
            .iter()
            .find(|mock| mock["mockId"].as_str() == Some(id))
    }

    fn rpc_mocks_for_case(fixture: &Value, case: &Value) -> Vec<Value> {
        let ids = case["rpcMockIds"]
            .as_array()
            .expect("fixture RPC mock IDs")
            .iter()
            .map(|id| id.as_str().expect("RPC mock ID"))
            .collect::<Vec<_>>();
        fixture["rpcMocks"]
            .as_array()
            .expect("fixture RPC mocks")
            .iter()
            .filter(|mock| mock["mockId"].as_str().is_some_and(|id| ids.contains(&id)))
            .cloned()
            .collect()
    }

    fn mutate_source_body(mock: &Value, case: &Value) -> String {
        let Some(mutation) = mutation(case, "source-swap-response-set") else {
            return mock["response"]["body"]
                .as_str()
                .expect("source response body")
                .to_owned();
        };
        let mut body: Value = serde_json::from_str(
            mock["response"]["body"]
                .as_str()
                .expect("source response body"),
        )
        .expect("source response JSON");
        set_path(
            &mut body,
            mutation["path"].as_str().expect("source mutation path"),
            mutation["value"].clone(),
        );
        serde_json::to_string(&body).expect("source response mutation serializes")
    }

    fn empty_lookup_table_data() -> String {
        let mut data = vec![0_u8; 56];
        data[0] = 1;
        data[4..12].fill(0xff);
        encode_base64(&data)
    }

    fn mutate_rpc_body(mock: &Value, case: &Value) -> String {
        let original = mock["response"]["body"]
            .as_str()
            .expect("RPC response body");
        let Some(raw_mutation) = case.get("mutation").and_then(Value::as_object) else {
            return original.to_owned();
        };
        let Some(kind) = raw_mutation.get("kind").and_then(Value::as_str) else {
            return original.to_owned();
        };
        if kind != "rpc-response-set" && kind != "rpc-envelope-set" && kind != "boundary" {
            return original.to_owned();
        }
        let mut body: Value = serde_json::from_str(original).expect("RPC response JSON");
        if kind == "boundary" {
            let request: Value =
                serde_json::from_str(mock["request"]["body"].as_str().expect("RPC request body"))
                    .expect("RPC request JSON");
            if request["method"] != "getMultipleAccounts" {
                return original.to_owned();
            }
            let values = body["result"]["value"]
                .as_array_mut()
                .expect("boundary ALT values");
            let empty = empty_lookup_table_data();
            for value in values {
                if let Some(data) = value["data"].as_array_mut() {
                    if let Some(first) = data.first_mut() {
                        *first = Value::String(empty.clone());
                    }
                }
            }
            return serde_json::to_string(&body).expect("boundary response serializes");
        }
        let request: Value =
            serde_json::from_str(mock["request"]["body"].as_str().expect("RPC request body"))
                .expect("RPC request JSON");
        let method = request["method"].as_str().expect("RPC method");
        let raw_path = raw_mutation["path"].as_str().expect("RPC mutation path");
        let path = if kind == "rpc-envelope-set" {
            raw_path
        } else if let Some(path) = raw_path.strip_prefix(&format!("{method}.")) {
            path
        } else {
            return original.to_owned();
        };
        if kind == "rpc-envelope-set" {
            match path {
                "id" | "jsonrpc" | "version" => {
                    body[path] = raw_mutation["value"].clone();
                }
                "depth" => {
                    let depth = raw_mutation["value"]
                        .as_str()
                        .and_then(|value| value.parse::<usize>().ok())
                        .expect("RPC depth mutation");
                    let mut nested = body["result"].clone();
                    for _ in 0..depth {
                        nested = json!({"nested": nested});
                    }
                    body["result"] = nested;
                }
                "size" => {
                    let size = raw_mutation["value"]
                        .as_str()
                        .and_then(|value| value.parse::<usize>().ok())
                        .expect("RPC size mutation");
                    body["result"] = Value::String("x".repeat(size));
                }
                other => panic!("unsupported RPC envelope mutation {other}"),
            }
            return serde_json::to_string(&body).expect("RPC envelope mutation serializes");
        }
        if path == "result" {
            body["result"] = raw_mutation["value"].clone();
        } else {
            set_path(
                &mut body["result"],
                path.strip_prefix("result.").unwrap_or(path),
                raw_mutation["value"].clone(),
            );
        }
        serde_json::to_string(&body).expect("RPC response mutation serializes")
    }

    async fn start_source_server(fixture: &Value, case: &Value) -> Option<(MockServer, String)> {
        let source_mock = source_mock_for_case(fixture, case)?;
        let server = MockServer::start().await;
        let status = source_mock["response"]["status"]
            .as_u64()
            .expect("source response status") as u16;
        let body = mutate_source_body(source_mock, case);
        let mut response = ResponseTemplate::new(status).set_body_string(body);
        if matches!(
            mutation(case, "transport")
                .and_then(|value| value.get("event"))
                .and_then(Value::as_str),
            Some("source-swap-timeout" | "source-swap-abort")
        ) {
            response = response.set_delay(Duration::from_millis(250));
        }
        Mock::given(method("GET"))
            .respond_with(response)
            .mount(&server)
            .await;
        let endpoint = format!("{}/v3", server.uri());
        Some((server, endpoint))
    }

    async fn start_rpc_server(fixture: &Value, case: &Value) -> Option<MockServer> {
        let mocks = rpc_mocks_for_case(fixture, case);
        if mocks.is_empty() {
            return None;
        }
        let event = mutation(case, "transport")
            .and_then(|value| value.get("event"))
            .and_then(Value::as_str);
        let mut responses = HashMap::new();
        for mock in mocks {
            let request = mock["request"]["body"]
                .as_str()
                .expect("RPC request body")
                .to_owned();
            let mut status = mock["response"]["status"].as_u64().expect("RPC status") as u16;
            if event == Some("rpc-transport-error") {
                status = 500;
            }
            responses.insert(
                request,
                RpcResponse {
                    status,
                    body: mutate_rpc_body(&mock, case),
                },
            );
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(RpcResponder {
                responses,
                delay: (event == Some("rpc-timeout") || event == Some("rpc-abort"))
                    .then_some(Duration::from_millis(250)),
            })
            .mount(&server)
            .await;
        Some(server)
    }

    fn local_config(
        _fixture: &Value,
        case: &Value,
        source_endpoint: Option<&str>,
        rpc_server: Option<&MockServer>,
    ) -> MayanSwiftV2LocalBuildConfig {
        let local = case["config"]["localBuild"]
            .as_object()
            .expect("local build config");
        let source = source_endpoint
            .map(str::to_owned)
            .or_else(|| {
                local
                    .get("sourceSwapEndpoint")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "https://price-api.mayan.finance/v3".to_owned());
        let mut config = MayanSwiftV2LocalBuildConfig::new().with_source_swap_endpoint(source);
        for key in ["ethereumRpc", "solanaRpc"] {
            let Some(endpoint) = local.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            let _ = endpoint;
            if let Some(server) = rpc_server {
                let rpc = RpcEndpointConfig::new(server.uri());
                config = if key == "ethereumRpc" {
                    config.with_ethereum_rpc(rpc)
                } else {
                    config.with_solana_rpc(rpc)
                };
            }
        }
        config
    }

    fn plan_for_case(
        _fixture: &Value,
        case: &Value,
        plans: &HashMap<String, MayanSwiftV2SourceSwapPlan>,
    ) -> MayanSwiftV2SourceSwapPlan {
        let plan_id = case["sourceSwapPlanRef"]
            .as_str()
            .expect("build source plan reference");
        let mut value = serde_json::to_value(plans.get(plan_id).expect("prepared source plan"))
            .expect("plan serializes");
        if let Some(mutation) = mutation(case, "plan-set") {
            set_path(
                &mut value,
                mutation["path"].as_str().expect("plan mutation path"),
                mutation["value"].clone(),
            );
        }
        serde_json::from_value(value).expect("mutated source plan")
    }

    async fn wait_for_requests(server: &MockServer, expected: usize) -> Vec<Request> {
        for _ in 0..100 {
            if let Some(requests) = server.received_requests().await {
                if requests.len() >= expected {
                    return requests;
                }
            }
            sleep(Duration::from_millis(2)).await;
        }
        server.received_requests().await.unwrap_or_default()
    }

    fn assert_source_trace(requests: &[Request], expected: &Value) {
        let expected = expected.as_array().expect("source trace array");
        assert_eq!(requests.len(), expected.len(), "source request count");
        for (request, expected) in requests.iter().zip(expected) {
            assert_eq!(request.method.as_str(), expected["method"]);
            let expected_url = Url::parse(expected["url"].as_str().expect("source URL"))
                .expect("source expected URL");
            assert_eq!(request.url.path(), expected_url.path());
            assert_eq!(request.url.query(), expected_url.query());
            assert_eq!(
                request
                    .headers
                    .get("accept")
                    .and_then(|value| value.to_str().ok()),
                Some("application/json")
            );
            assert!(request.headers.get("authorization").is_none());
            assert!(request.headers.get("cookie").is_none());
            assert!(request.body.is_empty());
        }
    }

    fn assert_rpc_trace(requests: &[Request], expected: &Value) {
        let expected = expected.as_array().expect("RPC trace array");
        assert_eq!(requests.len(), expected.len(), "RPC request count");
        for (request, expected) in requests.iter().zip(expected) {
            assert_eq!(request.method.as_str(), expected["method"]);
            assert_eq!(request.url.path(), "/");
            let body = String::from_utf8(request.body.clone()).expect("RPC request UTF-8");
            assert_eq!(body, expected["body"]);
            assert_eq!(
                request
                    .headers
                    .get("accept")
                    .and_then(|value| value.to_str().ok()),
                Some("application/json")
            );
            assert_eq!(
                request
                    .headers
                    .get("content-type")
                    .and_then(|value| value.to_str().ok()),
                Some("application/json")
            );
            assert!(request.headers.get("authorization").is_none());
            assert!(request.headers.get("cookie").is_none());
        }
    }

    fn outcome<T: Serialize>(result: BridgeResult<T>) -> Value {
        result.map_or_else(
            |error| {
                let mut value = json!({
                    "kind": "sdk-error",
                    "code": error.code_string(),
                    "message": error.to_string(),
                });
                if let Some(status) = error.status() {
                    value["status"] = json!(status);
                }
                value
            },
            |value| json!({"kind": "success", "value": value}),
        )
    }

    fn first_difference(left: &Value, right: &Value, path: &str) -> Option<String> {
        match (left, right) {
            (Value::Object(left), Value::Object(right)) => {
                for key in left.keys().chain(right.keys()) {
                    if !left.contains_key(key) || !right.contains_key(key) {
                        return Some(format!("{path}.{key}: key presence differs"));
                    }
                    if let Some(difference) =
                        first_difference(&left[key], &right[key], &format!("{path}.{key}"))
                    {
                        return Some(difference);
                    }
                }
                None
            }
            (Value::Array(left), Value::Array(right)) => {
                if left.len() != right.len() {
                    return Some(format!("{path}: lengths {} != {}", left.len(), right.len()));
                }
                for (index, (left, right)) in left.iter().zip(right).enumerate() {
                    if let Some(difference) =
                        first_difference(left, right, &format!("{path}[{index}]"))
                    {
                        return Some(difference);
                    }
                }
                None
            }
            _ if left == right => None,
            (Value::String(left), Value::String(right)) => {
                let first = left
                    .bytes()
                    .zip(right.bytes())
                    .position(|(left, right)| left != right)
                    .unwrap_or(left.len().min(right.len()));
                Some(format!(
                    "{path}: string lengths {} != {}, first differing byte {} (left {:?}, right {:?})",
                    left.len(),
                    right.len(),
                    first,
                    &left[first.saturating_sub(16)..left.len().min(first + 32)],
                    &right[first.saturating_sub(16)..right.len().min(first + 32)]
                ))
            }
            _ => Some(format!("{path}: left={left} right={right}")),
        }
    }

    async fn run_case(
        fixture: &Value,
        case: &Value,
        plans: &HashMap<String, MayanSwiftV2SourceSwapPlan>,
    ) -> (Value, Vec<Value>, Vec<Value>) {
        let case_id = case["caseId"].as_str().expect("case ID");
        let method = case["method"].as_str().expect("case method");
        let quote = quote_for_case(fixture, case);
        let context = MayanSwiftV2LocalContext {
            quote: quote.clone(),
            swapper_address: case["context"]["swapperAddress"]
                .as_str()
                .expect("swapper address")
                .to_owned(),
            destination_address: case["context"]["destinationAddress"]
                .as_str()
                .expect("destination address")
                .to_owned(),
            order_nonce: case["context"]["orderNonce"]
                .as_str()
                .expect("order nonce")
                .to_owned(),
        };
        let source_server = start_source_server(fixture, case).await;
        let rpc_server = start_rpc_server(fixture, case).await;
        let event = mutation(case, "transport")
            .and_then(|value| value.get("event"))
            .and_then(Value::as_str);
        let invalid_transport_guard = matches!(
            event,
            Some("credential-forwarding" | "hosted-build-attempt")
        );
        let source_endpoint = if invalid_transport_guard {
            Some("invalid local source endpoint")
        } else {
            source_server
                .as_ref()
                .map(|(_, endpoint)| endpoint.as_str())
        };
        let config = local_config(fixture, case, source_endpoint, rpc_server.as_ref());
        let mut bridge_config = MayanSwiftV2BridgeConfig::new().with_local_build(config);
        if event == Some("source-swap-timeout") || event == Some("rpc-timeout") {
            bridge_config = bridge_config.with_timeout(Duration::from_millis(5));
        }
        let client = MayanSwiftV2BridgeClient::new(bridge_config)
            .expect("local fixture client")
            .with_clock(fixed_clock);
        let actual = if method == "prepareSourceSwap" {
            if event == Some("source-swap-abort") {
                let cancellation = CancellationToken::new();
                let task_cancellation = cancellation.clone();
                let task_client = client.clone();
                let task = tokio::spawn(async move {
                    task_client
                        .prepare_source_swap_with(context, Some(&task_cancellation))
                        .await
                });
                sleep(Duration::from_millis(20)).await;
                cancellation.cancel();
                outcome(task.await.expect("aborted local preparation"))
            } else {
                outcome(client.prepare_source_swap(context).await)
            }
        } else {
            let plan = plan_for_case(fixture, case, plans);
            let request = MayanSwiftV2LocalBuildRequest {
                quote,
                swapper_address: context.swapper_address,
                destination_address: context.destination_address,
                order_nonce: context.order_nonce,
                source_swap_plan: plan,
            };
            if event == Some("rpc-abort") {
                let cancellation = CancellationToken::new();
                let task_cancellation = cancellation.clone();
                let task_client = client.clone();
                let task = tokio::spawn(async move {
                    task_client
                        .build_local_unsigned_with(request, Some(&task_cancellation))
                        .await
                });
                sleep(Duration::from_millis(20)).await;
                cancellation.cancel();
                outcome(task.await.expect("aborted local build"))
            } else {
                outcome(client.build_local_unsigned(request).await)
            }
        };
        let expected_http = case["httpTrace"].as_array().cloned().unwrap_or_default();
        let expected_rpc = case["rpcTrace"].as_array().cloned().unwrap_or_default();
        let source_requests = if let Some((server, _)) = &source_server {
            wait_for_requests(server, expected_http.len()).await
        } else {
            Vec::new()
        };
        let rpc_requests = if let Some(server) = &rpc_server {
            wait_for_requests(server, expected_rpc.len()).await
        } else {
            Vec::new()
        };
        assert_source_trace(&source_requests, &Value::Array(expected_http.clone()));
        assert_rpc_trace(&rpc_requests, &Value::Array(expected_rpc.clone()));
        if case_id == "build-usdc-missing-source-rpc" {
            assert_eq!(actual["code"], BridgeErrorCode::LocalRpcRequired.as_str());
        }
        (actual, expected_http, expected_rpc)
    }

    /// Replays every local case and returns the behavior rows for the v2
    /// bridge-native snapshot. The caller compares all rows to fixture
    /// expectations before writing the artifact.
    pub(crate) async fn replay_local_fixture(fixture: &Value) -> Map<String, Value> {
        let mut plans = HashMap::new();
        let mut behavior = Map::from_iter([
            ("prepareSourceSwap".to_owned(), Value::Array(Vec::new())),
            ("buildLocalUnsigned".to_owned(), Value::Array(Vec::new())),
        ]);
        for case in fixture["cases"].as_array().expect("local fixture cases") {
            if case["method"] != "prepareSourceSwap" {
                continue;
            }
            let (actual, http_trace, rpc_trace) = run_case(fixture, case, &plans).await;
            assert_eq!(
                actual,
                case["expected"],
                "local case outcome {}{}",
                case["caseId"],
                first_difference(&actual, &case["expected"], "")
                    .map_or_else(String::new, |value| format!(": {value}"))
            );
            assert_eq!(
                Value::Array(http_trace.clone()),
                case["httpTrace"],
                "local HTTP trace"
            );
            assert_eq!(
                Value::Array(rpc_trace.clone()),
                case["rpcTrace"],
                "local RPC trace"
            );
            if actual["kind"] == "success" {
                let plan =
                    serde_json::from_value::<MayanSwiftV2SourceSwapPlan>(actual["value"].clone())
                        .expect("prepared local plan");
                plans.insert(case["caseId"].as_str().expect("case ID").to_owned(), plan);
            }
            behavior["prepareSourceSwap"]
                .as_array_mut()
                .expect("prepare behavior")
                .push(json!({
                    "caseId": case["caseId"],
                    "outcome": actual,
                    "httpTrace": http_trace,
                    "rpcTrace": rpc_trace,
                }));
        }
        for case in fixture["cases"].as_array().expect("local fixture cases") {
            if case["method"] != "buildLocalUnsigned" {
                continue;
            }
            let (actual, http_trace, rpc_trace) = run_case(fixture, case, &plans).await;
            assert_eq!(
                actual,
                case["expected"],
                "local case outcome {}{}",
                case["caseId"],
                first_difference(&actual, &case["expected"], "")
                    .map_or_else(String::new, |value| format!(": {value}"))
            );
            assert_eq!(
                Value::Array(http_trace.clone()),
                case["httpTrace"],
                "local HTTP trace"
            );
            assert_eq!(
                Value::Array(rpc_trace.clone()),
                case["rpcTrace"],
                "local RPC trace"
            );
            behavior["buildLocalUnsigned"]
                .as_array_mut()
                .expect("build behavior")
                .push(json!({
                    "caseId": case["caseId"],
                    "outcome": actual,
                    "httpTrace": http_trace,
                    "rpcTrace": rpc_trace,
                }));
        }
        for rows in behavior.values_mut() {
            rows.as_array_mut()
                .expect("behavior rows")
                .sort_by(|left, right| left["caseId"].as_str().cmp(&right["caseId"].as_str()));
        }
        behavior
    }
}
