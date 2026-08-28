use std::{collections::HashMap, ops::Deref, sync::Arc};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
    subscriptions::{RpcSubscription, WebSocketJsonRpcTransport},
};

/// Solana commitment level.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SolanaCommitment {
    /// Confirmed by a supermajority of the cluster.
    Confirmed,
    /// Finalized by the cluster.
    Finalized,
    /// Processed by the connected node.
    Processed,
}

/// Solana account or transaction encoding.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum SolanaEncoding {
    /// Base58 encoding.
    #[serde(rename = "base58")]
    Base58,
    /// Base64 encoding.
    #[serde(rename = "base64")]
    Base64,
    /// Zstandard-compressed base64 encoding.
    #[serde(rename = "base64+zstd")]
    Base64Zstd,
    /// Parsed JSON encoding.
    #[serde(rename = "jsonParsed")]
    JsonParsed,
}

/// Standard Solana response context.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolanaContext {
    /// RPC software API version when supplied.
    pub api_version: Option<String>,
    /// Context slot.
    pub slot: u64,
}

/// Value wrapped with a Solana response context.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SolanaContextResult<T> {
    /// Response context.
    pub context: SolanaContext,
    /// Method result.
    pub value: T,
}

/// Priority fee estimate with forward-compatible additional fields.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityFeeEstimate {
    /// Estimated priority fee.
    pub priority_fee_estimate: f64,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Named request for one indexed asset or proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRequest {
    /// Asset identifier.
    pub id: String,
    /// Optional display flags.
    pub display_options: Option<HashMap<String, bool>>,
}

/// Named request for a batch of indexed assets or proofs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBatchRequest {
    /// Asset identifiers.
    pub ids: Vec<String>,
    /// Optional display flags.
    pub display_options: Option<HashMap<String, bool>>,
}

/// Shared indexed-asset pagination request.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetListRequest {
    /// Cursor pagination token.
    pub cursor: Option<String>,
    /// Maximum item count.
    pub limit: Option<u64>,
    /// Page number.
    pub page: Option<u64>,
    /// Method-specific named parameters.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Forward-compatible indexed asset object.
pub type IndexedAsset = HashMap<String, Value>;
/// Forward-compatible indexed asset proof object.
pub type IndexedAssetProof = HashMap<String, Value>;

/// Paginated indexed-asset list.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct IndexedAssetList<T = IndexedAsset> {
    /// Next cursor when available.
    pub cursor: Option<String>,
    /// Returned items.
    pub items: Vec<T>,
    /// Effective page limit.
    pub limit: Option<u64>,
    /// Effective page number.
    pub page: Option<u64>,
    /// Total item count when supplied.
    pub total: Option<u64>,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Numeric range filter for indexed history.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct NumericFilter {
    /// Equal to.
    pub eq: Option<f64>,
    /// Greater than.
    pub gt: Option<f64>,
    /// Greater than or equal to.
    pub gte: Option<f64>,
    /// Less than.
    pub lt: Option<f64>,
    /// Less than or equal to.
    pub lte: Option<f64>,
}

/// Options for indexed address transactions.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransactionsOptions {
    /// Return signatures before this signature.
    pub before: Option<String>,
    /// Requested commitment.
    pub commitment: Option<SolanaCommitment>,
    /// Transaction encoding.
    pub encoding: Option<String>,
    /// Additional indexed filters.
    pub filters: Option<HashMap<String, Value>>,
    /// Maximum item count.
    pub limit: Option<u64>,
    /// Maximum supported transaction version.
    pub max_supported_transaction_version: Option<u64>,
    /// Opaque pagination token.
    pub pagination_token: Option<String>,
    /// Sort order.
    pub sort_order: Option<String>,
    /// Transaction detail level.
    pub transaction_details: Option<String>,
    /// Return signatures up to this signature.
    pub until: Option<String>,
}

/// One indexed address transaction.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransaction {
    /// Block time.
    pub block_time: Option<i64>,
    /// Confirmation status.
    pub confirmation_status: SolanaCommitment,
    /// Transaction error.
    pub err: Value,
    /// Memo when present.
    pub memo: Option<String>,
    /// Transaction metadata when requested.
    pub meta: Option<Value>,
    /// Transaction signature.
    pub signature: String,
    /// Slot.
    pub slot: u64,
    /// Transaction body when requested.
    pub transaction: Option<Value>,
    /// Index within the block.
    pub transaction_index: u64,
    /// Transaction version when supplied.
    pub version: Option<Value>,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Paginated indexed address transactions.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransactionPage {
    /// Transactions.
    pub data: Vec<AddressTransaction>,
    /// Next pagination token.
    pub pagination_token: Option<String>,
    /// Earliest slot or time in the current window.
    pub window_start: Option<i64>,
}

/// Direction for an indexed transfer query.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressTransferDirection {
    /// Transfers in either direction.
    Any,
    /// Incoming transfers.
    In,
    /// Outgoing transfers.
    Out,
}

/// Numeric filters for indexed transfers.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransferFilters {
    /// Amount filter.
    pub amount: Option<NumericFilter>,
    /// Block-time filter.
    pub block_time: Option<NumericFilter>,
    /// Slot filter.
    pub slot: Option<NumericFilter>,
}

/// Options for indexed address transfers.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransfersOptions {
    /// Requested commitment.
    pub commitment: Option<SolanaCommitment>,
    /// Transfer direction.
    pub direction: Option<AddressTransferDirection>,
    /// Numeric filters.
    pub filters: Option<AddressTransferFilters>,
    /// Maximum item count.
    pub limit: Option<u64>,
    /// Optional mint filter.
    pub mint: Option<String>,
    /// Opaque pagination token.
    pub pagination_token: Option<String>,
    /// Native transfer projection mode.
    pub sol_mode: Option<String>,
    /// Sort order.
    pub sort_order: Option<String>,
    /// Counterparty filter.
    pub with: Option<String>,
}

/// Indexed transfer operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AddressTransferType {
    /// Token burn.
    #[serde(rename = "burn")]
    Burn,
    /// Account owner change.
    #[serde(rename = "changeOwner")]
    ChangeOwner,
    /// Token mint.
    #[serde(rename = "mint")]
    Mint,
    /// Token or native transfer.
    #[serde(rename = "transfer")]
    Transfer,
    /// Native token unwrap.
    #[serde(rename = "unwrap")]
    Unwrap,
    /// Withheld fee withdrawal.
    #[serde(rename = "withdrawWithheldFee")]
    WithdrawWithheldFee,
    /// Native token wrap.
    #[serde(rename = "wrap")]
    Wrap,
}

/// One indexed address transfer.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransfer {
    /// Integer amount string.
    pub amount: String,
    /// Block time.
    pub block_time: Option<i64>,
    /// Confirmation status.
    pub confirmation_status: SolanaCommitment,
    /// Mint decimals.
    pub decimals: u8,
    /// Integer fee amount.
    pub fee_amount: Option<String>,
    /// Display fee amount.
    pub fee_ui_amount: Option<String>,
    /// Source token account.
    pub from_token_account: Option<String>,
    /// Source user account.
    pub from_user_account: Option<String>,
    /// Inner instruction index.
    pub inner_instruction_idx: u64,
    /// Instruction index.
    pub instruction_idx: u64,
    /// Mint address for token transfers.
    pub mint: Option<String>,
    /// Transaction signature.
    pub signature: String,
    /// Slot.
    pub slot: u64,
    /// Destination token account.
    pub to_token_account: Option<String>,
    /// Destination user account.
    pub to_user_account: Option<String>,
    /// Transaction index.
    pub transaction_idx: u64,
    /// Transfer operation.
    #[serde(rename = "type")]
    pub transfer_type: AddressTransferType,
    /// Display amount.
    pub ui_amount: String,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Paginated indexed address transfers.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressTransferPage {
    /// Transfers.
    pub data: Vec<AddressTransfer>,
    /// Next pagination token.
    pub pagination_token: Option<String>,
    /// Earliest slot or time in the current window.
    pub window_start: Option<i64>,
}

/// One network measurement to a scheduled leader.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingMeasurement {
    /// City inferred from the target address.
    pub city: Option<String>,
    /// Country inferred from the target address.
    pub country: Option<String>,
    /// Measurement source address.
    pub from_ip: Option<String>,
    /// Whether ICMP replied.
    pub icmp_replied: bool,
    /// Latitude.
    pub lat: Option<f64>,
    /// Longitude.
    pub lon: Option<f64>,
    /// Measurement timestamp.
    pub measured_at: Option<String>,
    /// Round-trip milliseconds.
    pub ms: Option<f64>,
    /// Network organization.
    pub org: Option<String>,
    /// Postal code.
    pub postal: Option<String>,
    /// Region.
    pub region: Option<String>,
    /// Time zone.
    pub timezone: Option<String>,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Scheduled leader and public network metadata.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderSlot {
    /// Epoch.
    pub epoch: u64,
    /// Feature-set identifier.
    pub feature_set: Option<String>,
    /// Gossip port.
    pub gossip_port: Option<u16>,
    /// Gossip observation timestamp.
    pub gossip_updated_at: Option<String>,
    /// Validator identity.
    pub identity: String,
    /// Public IP address.
    pub ip_address: Option<String>,
    /// Leader city.
    pub leader_city: Option<String>,
    /// Leader country.
    pub leader_country: Option<String>,
    /// Leader latitude.
    pub leader_lat: Option<f64>,
    /// Leader longitude.
    pub leader_lon: Option<f64>,
    /// Leader network organization.
    pub leader_org: Option<String>,
    /// Leader region.
    pub leader_region: Option<String>,
    /// Leader time zone.
    pub leader_timezone: Option<String>,
    /// Measurements to scheduled leaders.
    pub ping_to_leaders: Vec<PingMeasurement>,
    /// Public RPC address.
    pub rpc_address: Option<String>,
    /// Slot represented as a decimal string.
    pub slot: String,
    /// Stake weight.
    pub stake_weight: f64,
    /// TPU port.
    pub tpu_port: Option<u16>,
    /// QUIC TPU port.
    pub tpu_quic_port: Option<u16>,
    /// Validator software version.
    pub version: Option<String>,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Leader slot response envelope.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LeaderSlotsResult {
    /// Leader slots.
    pub data: Vec<LeaderSlot>,
    /// Service message.
    pub message: String,
    /// Success flag.
    pub success: bool,
    /// Returned row count.
    pub total: u64,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Validator information query.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ValidatorsInformationOptions {
    /// Country filter.
    pub country: Option<String>,
    /// Maximum validator count.
    pub limit: Option<u64>,
    /// Region filter.
    pub region: Option<String>,
}

/// Validator information and public network metadata.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorInformation {
    /// Feature-set identifier.
    pub feature_set: Option<String>,
    /// Gossip database row identifier.
    pub gossip_node_id: Option<u64>,
    /// Gossip port.
    pub gossip_port: Option<u16>,
    /// Gossip observation timestamp.
    pub gossip_updated_at: Option<String>,
    /// Validator identity.
    pub identity: String,
    /// Public IP address.
    pub ip_address: Option<String>,
    /// Validator city.
    pub leader_city: Option<String>,
    /// Validator country.
    pub leader_country: Option<String>,
    /// Validator latitude.
    pub leader_lat: Option<f64>,
    /// Validator longitude.
    pub leader_lon: Option<f64>,
    /// Validator network organization.
    pub leader_org: Option<String>,
    /// Validator region.
    pub leader_region: Option<String>,
    /// Validator time zone.
    pub leader_timezone: Option<String>,
    /// Measurements to scheduled leaders.
    pub ping_to_leaders: Vec<PingMeasurement>,
    /// Public RPC address.
    pub rpc_address: Option<String>,
    /// Scheduled slot count.
    pub slot_count: u64,
    /// Stake weight.
    pub stake_weight: f64,
    /// TPU port.
    pub tpu_port: Option<u16>,
    /// QUIC TPU port.
    pub tpu_quic_port: Option<u16>,
    /// Validator software version.
    pub version: Option<String>,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Validator information response envelope.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorsInformationResult {
    /// Validators.
    pub data: Vec<ValidatorInformation>,
    /// Epoch.
    pub epoch: u64,
    /// Service message.
    pub message: String,
    /// Success flag.
    pub success: bool,
    /// Returned row count.
    pub total: u64,
    /// Total validator count before limiting.
    pub total_validators: u64,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Number or timestamp string accepted by analytics time bounds.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AnalyticsTimeBound {
    /// Numeric Unix timestamp.
    Number(i64),
    /// Server-supported timestamp string.
    String(String),
}

/// Top-program analytics options.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProgramsOptions {
    /// Include vote transactions.
    pub include_votes: Option<bool>,
    /// Maximum row count.
    pub limit: Option<u64>,
    /// Inclusive lower time bound.
    pub since: Option<AnalyticsTimeBound>,
    /// Exclusive upper time bound.
    pub until: Option<AnalyticsTimeBound>,
}

/// One top-program analytics row.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TopProgramRow {
    /// Error count as a decimal string.
    pub errors: String,
    /// Invocation count as a decimal string.
    pub invocations: String,
    /// Program address.
    pub program: String,
    /// Total compute units as a decimal string.
    pub total_cus: String,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Slot statistics query by one slot or inclusive range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SlotStatsOptions {
    /// One slot.
    Slot {
        /// Slot number.
        slot: u64,
    },
    /// Slot range.
    Range {
        /// First slot.
        #[serde(rename = "fromSlot")]
        from_slot: u64,
        /// Last slot.
        #[serde(rename = "toSlot")]
        to_slot: u64,
    },
}

/// One slot statistics row.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SlotStatsRow {
    /// Block time.
    pub block_time: i64,
    /// Non-vote transaction count.
    pub non_vote_transaction_count: u64,
    /// Slot.
    pub slot: u64,
    /// Total transaction count.
    pub transaction_count: u64,
    /// Vote transaction count.
    pub vote_transaction_count: u64,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// TPS time-series options.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TpsTimeseriesOptions {
    /// Bucket width in seconds.
    pub bucket_sec: Option<u64>,
    /// Inclusive lower time bound.
    pub from: AnalyticsTimeBound,
    /// Exclusive upper time bound.
    pub to: AnalyticsTimeBound,
}

/// One TPS time bucket.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TpsBucket {
    /// Bucket timestamp.
    pub bucket: i64,
    /// Non-vote TPS.
    pub non_vote_tps: f64,
    /// Total TPS.
    pub total_tps: f64,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Epoch analytics summary.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EpochSummary {
    /// Distinct invoked programs.
    pub distinct_programs: String,
    /// Epoch.
    pub epoch: u64,
    /// First block time.
    pub first_block_time: i64,
    /// Last block time.
    pub last_block_time: i64,
    /// Non-vote transaction count.
    pub non_vote_txs: String,
    /// Program invocation count.
    pub program_invocations: String,
    /// Slot count.
    pub slots: String,
    /// Total transaction count.
    pub total_txs: String,
    /// Vote transaction count.
    pub vote_txs: String,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Program statistics options.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramStatsOptions {
    /// Bucket width in seconds.
    pub bucket_sec: Option<u64>,
    /// Program address.
    pub program_id_base58: String,
    /// Inclusive lower time bound.
    pub since: Option<AnalyticsTimeBound>,
    /// Exclusive upper time bound.
    pub until: Option<AnalyticsTimeBound>,
}

/// One program statistics time bucket.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProgramStatsBucket {
    /// Bucket timestamp.
    pub bucket: i64,
    /// Error count as a decimal string.
    pub errors: String,
    /// Invocation count as a decimal string.
    pub invocations: String,
    /// Total compute units as a decimal string.
    pub total_cus: String,
    /// Forward-compatible response fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Standard Solana JSON-RPC methods represented by this release.
pub const SOLANA_RPC_METHODS: &[&str] = &[
    "getAccountInfo",
    "getBalance",
    "getBlock",
    "getBlockCommitment",
    "getBlockHeight",
    "getBlockProduction",
    "getBlockTime",
    "getBlocks",
    "getBlocksWithLimit",
    "getClusterNodes",
    "getEpochInfo",
    "getEpochSchedule",
    "getFeeForMessage",
    "getFirstAvailableBlock",
    "getGenesisHash",
    "getHealth",
    "getHighestSnapshotSlot",
    "getIdentity",
    "getInflationGovernor",
    "getInflationRate",
    "getInflationReward",
    "getLargestAccounts",
    "getLatestBlockhash",
    "getLeaderSchedule",
    "getMaxRetransmitSlot",
    "getMaxShredInsertSlot",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    "getParsedTransaction",
    "getPriorityFeeEstimate",
    "getProgramAccounts",
    "getProgramAccountsV2",
    "getRecentPerformanceSamples",
    "getRecentPrioritizationFees",
    "getSignatureStatuses",
    "getSignaturesForAddress",
    "getSlot",
    "getSlotLeader",
    "getSlotLeaders",
    "getStakeMinimumDelegation",
    "getSupply",
    "getTokenAccountBalance",
    "getTokenAccountsByDelegate",
    "getTokenAccountsByOwner",
    "getTokenLargestAccounts",
    "getTokenSupply",
    "getTransaction",
    "getTransactionCount",
    "getVersion",
    "getVoteAccounts",
    "isBlockhashValid",
    "minimumLedgerSlot",
    "requestAirdrop",
    "sendTransaction",
    "simulateTransaction",
];

/// Indexed asset RPC methods represented by this release.
pub const SOLANA_DAS_METHODS: &[&str] = &[
    "getAsset",
    "getAssetBatch",
    "getAssetProof",
    "getAssetProofBatch",
    "getAssetsByAuthority",
    "getAssetsByCreator",
    "getAssetsByGroup",
    "getAssetsByOwner",
    "getNftEditions",
    "getSignaturesForAsset",
    "getTokenAccounts",
    "getTokensByDelegate",
    "getTokensByOwner",
    "searchAssets",
];

/// Indexed address history RPC methods represented by this release.
pub const SOLANA_HISTORY_METHODS: &[&str] = &["getTransactionsForAddress", "getTransfersByAddress"];

/// Leader information RPC methods represented by this release.
pub const SOLANA_LEADER_METHODS: &[&str] = &["getLeaderSlots", "getValidatorsInformation"];

/// Analytics RPC methods represented by this release.
pub const SOLANA_ANALYTICS_METHODS: &[&str] = &[
    "jetEpochSummary",
    "jetProgramStats",
    "jetSlotStats",
    "jetTopPrograms",
    "jetTpsTimeseries",
];

/// Standard Solana JSON-RPC namespace.
#[derive(Clone)]
pub struct SolanaRpcClient {
    namespace: RpcNamespace,
}

impl SolanaRpcClient {
    const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::SolanaStandard),
        }
    }
}

impl Deref for SolanaRpcClient {
    type Target = RpcNamespace;

    fn deref(&self) -> &Self::Target {
        &self.namespace
    }
}

macro_rules! solana_no_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl SolanaRpcClient {
            $(
                #[doc = concat!("Creates a pending `", $wire, "` request.")]
                #[must_use]
                pub fn $name(&self) -> PendingRpcRequest<$result> {
                    self.namespace.request($wire, Vec::<Value>::new()).expect("empty parameters serialize")
                }
            )*
        }
    };
}

macro_rules! solana_with_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl SolanaRpcClient {
            $(
                #[doc = concat!("Creates a pending `", $wire, "` request from positional parameters.")]
                pub fn $name<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<$result>> {
                    self.namespace.request($wire, params)
                }
            )*
        }
    };
}

solana_no_params!(
    (get_cluster_nodes, "getClusterNodes", Value),
    (get_epoch_schedule, "getEpochSchedule", Value),
    (get_first_available_block, "getFirstAvailableBlock", u64),
    (get_genesis_hash, "getGenesisHash", String),
    (get_health, "getHealth", String),
    (get_highest_snapshot_slot, "getHighestSnapshotSlot", Value),
    (get_identity, "getIdentity", Value),
    (get_inflation_rate, "getInflationRate", Value),
    (get_max_retransmit_slot, "getMaxRetransmitSlot", u64),
    (get_max_shred_insert_slot, "getMaxShredInsertSlot", u64),
    (get_version, "getVersion", Value),
    (minimum_ledger_slot, "minimumLedgerSlot", u64),
);

solana_with_params!(
    (get_account_info, "getAccountInfo", SolanaContextResult<Option<Value>>),
    (get_balance, "getBalance", SolanaContextResult<u64>),
    (get_block, "getBlock", Option<Value>),
    (get_block_commitment, "getBlockCommitment", Value),
    (get_block_height, "getBlockHeight", u64),
    (get_block_production, "getBlockProduction", Value),
    (get_block_time, "getBlockTime", Option<i64>),
    (get_blocks, "getBlocks", Vec<u64>),
    (get_blocks_with_limit, "getBlocksWithLimit", Vec<u64>),
    (get_epoch_info, "getEpochInfo", Value),
    (get_fee_for_message, "getFeeForMessage", SolanaContextResult<Option<u64>>),
    (get_inflation_governor, "getInflationGovernor", Value),
    (get_inflation_reward, "getInflationReward", Value),
    (get_largest_accounts, "getLargestAccounts", Value),
    (get_latest_blockhash, "getLatestBlockhash", Value),
    (get_leader_schedule, "getLeaderSchedule", Option<Value>),
    (
        get_minimum_balance_for_rent_exemption,
        "getMinimumBalanceForRentExemption",
        u64
    ),
    (get_multiple_accounts, "getMultipleAccounts", SolanaContextResult<Value>),
    (get_parsed_transaction, "getParsedTransaction", Option<Value>),
    (
        get_priority_fee_estimate,
        "getPriorityFeeEstimate",
        PriorityFeeEstimate
    ),
    (get_program_accounts, "getProgramAccounts", Value),
    (get_program_accounts_v2, "getProgramAccountsV2", Value),
    (get_recent_performance_samples, "getRecentPerformanceSamples", Value),
    (
        get_recent_prioritization_fees,
        "getRecentPrioritizationFees",
        Value
    ),
    (get_signature_statuses, "getSignatureStatuses", Value),
    (get_signatures_for_address, "getSignaturesForAddress", Value),
    (get_slot, "getSlot", u64),
    (get_slot_leader, "getSlotLeader", String),
    (get_slot_leaders, "getSlotLeaders", Vec<String>),
    (
        get_stake_minimum_delegation,
        "getStakeMinimumDelegation",
        SolanaContextResult<u64>
    ),
    (get_supply, "getSupply", Value),
    (get_token_account_balance, "getTokenAccountBalance", Value),
    (
        get_token_accounts_by_delegate,
        "getTokenAccountsByDelegate",
        Value
    ),
    (get_token_accounts_by_owner, "getTokenAccountsByOwner", Value),
    (get_token_largest_accounts, "getTokenLargestAccounts", Value),
    (get_token_supply, "getTokenSupply", Value),
    (get_transaction, "getTransaction", Option<Value>),
    (get_transaction_count, "getTransactionCount", u64),
    (get_vote_accounts, "getVoteAccounts", Value),
    (
        is_blockhash_valid,
        "isBlockhashValid",
        SolanaContextResult<bool>
    ),
    (request_airdrop, "requestAirdrop", String),
    (send_transaction, "sendTransaction", String),
    (simulate_transaction, "simulateTransaction", Value),
);

macro_rules! namespace_client {
    ($name:ident, $policy:expr, $(($method:ident, $wire:literal, $result:ty)),* $(,)?) => {
        #[doc = concat!(stringify!($name), " JSON-RPC namespace.")]
        #[derive(Clone)]
        pub struct $name {
            namespace: RpcNamespace,
        }

        impl $name {
            const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
                Self { namespace: RpcNamespace::new(transport, $policy) }
            }

            $(
                #[doc = concat!("Creates a pending `", $wire, "` request.")]
                pub fn $method<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<$result>> {
                    self.namespace.request($wire, params)
                }
            )*
        }

        impl Deref for $name {
            type Target = RpcNamespace;

            fn deref(&self) -> &Self::Target {
                &self.namespace
            }
        }
    };
}

namespace_client!(
    SolanaDasClient,
    BatchPolicy::Any,
    (get_asset, "getAsset", Option<IndexedAsset>),
    (
        get_asset_batch,
        "getAssetBatch",
        Vec<Option<IndexedAsset>>
    ),
    (get_asset_proof, "getAssetProof", Option<IndexedAssetProof>),
    (
        get_asset_proof_batch,
        "getAssetProofBatch",
        Vec<Option<IndexedAssetProof>>
    ),
    (
        get_assets_by_authority,
        "getAssetsByAuthority",
        IndexedAssetList
    ),
    (
        get_assets_by_creator,
        "getAssetsByCreator",
        IndexedAssetList
    ),
    (get_assets_by_group, "getAssetsByGroup", IndexedAssetList),
    (get_assets_by_owner, "getAssetsByOwner", IndexedAssetList),
    (get_nft_editions, "getNftEditions", HashMap<String, Value>),
    (
        get_signatures_for_asset,
        "getSignaturesForAsset",
        HashMap<String, Value>
    ),
    (
        get_token_accounts,
        "getTokenAccounts",
        HashMap<String, Value>
    ),
    (
        get_tokens_by_delegate,
        "getTokensByDelegate",
        HashMap<String, Value>
    ),
    (
        get_tokens_by_owner,
        "getTokensByOwner",
        HashMap<String, Value>
    ),
    (search_assets, "searchAssets", IndexedAssetList),
);

namespace_client!(
    SolanaHistoryClient,
    BatchPolicy::Any,
    (
        get_transactions_for_address,
        "getTransactionsForAddress",
        Option<AddressTransactionPage>
    ),
    (
        get_transfers_by_address,
        "getTransfersByAddress",
        AddressTransferPage
    ),
);

namespace_client!(
    SolanaLeaderClient,
    BatchPolicy::Unsupported,
    (get_leader_slots, "getLeaderSlots", LeaderSlotsResult),
    (
        get_validators_information,
        "getValidatorsInformation",
        ValidatorsInformationResult
    ),
);

namespace_client!(
    SolanaAnalyticsClient,
    BatchPolicy::Any,
    (jet_epoch_summary, "jetEpochSummary", Option<EpochSummary>),
    (
        jet_program_stats,
        "jetProgramStats",
        Vec<ProgramStatsBucket>
    ),
    (jet_slot_stats, "jetSlotStats", Vec<SlotStatsRow>),
    (jet_top_programs, "jetTopPrograms", Vec<TopProgramRow>),
    (jet_tps_timeseries, "jetTpsTimeseries", Vec<TpsBucket>),
);

/// Solana enhanced WebSocket subscription methods.
pub const SOLANA_ENHANCED_SUBSCRIPTION_METHODS: &[&str] = &[
    "accountSubscribe",
    "accountUnsubscribe",
    "transactionSubscribe",
    "transactionUnsubscribe",
];

/// Solana WebSocket subscription client.
#[derive(Clone)]
pub struct SolanaSubscriptions {
    transport: Arc<WebSocketJsonRpcTransport>,
}

impl SolanaSubscriptions {
    pub(crate) const fn new(transport: Arc<WebSocketJsonRpcTransport>) -> Self {
        Self { transport }
    }

    /// Credential-free WebSocket endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        self.transport.endpoint()
    }

    /// Starts an `accountSubscribe` subscription.
    pub async fn account_subscribe(
        &self,
        address: &str,
        options: Option<Value>,
    ) -> Result<RpcSubscription> {
        let mut params = vec![Value::String(address.to_owned())];
        if let Some(options) = options {
            params.push(options);
        }
        self.raw_subscribe(
            "accountSubscribe",
            Value::Array(params),
            "accountUnsubscribe",
        )
        .await
    }

    /// Starts a `transactionSubscribe` subscription.
    pub async fn transaction_subscribe(
        &self,
        filter: Value,
        options: Option<Value>,
    ) -> Result<RpcSubscription> {
        let mut params = vec![filter];
        if let Some(options) = options {
            params.push(options);
        }
        self.raw_subscribe(
            "transactionSubscribe",
            Value::Array(params),
            "transactionUnsubscribe",
        )
        .await
    }

    /// Starts an arbitrary subscribe/unsubscribe method pair.
    pub async fn raw_subscribe(
        &self,
        subscribe_method: &str,
        params: Value,
        unsubscribe_method: &str,
    ) -> Result<RpcSubscription> {
        let receiver = self.transport.subscribe_notifications();
        let id: crate::SubscriptionId = self
            .transport
            .request(subscribe_method, params, None)
            .await?;
        Ok(RpcSubscription::new(
            id,
            Arc::clone(&self.transport),
            unsubscribe_method,
            receiver,
        ))
    }

    /// Sends an arbitrary request on the subscription connection.
    pub async fn raw<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        self.transport.request(method, params, None).await
    }

    /// Closes the WebSocket connection.
    pub async fn close(&self) {
        self.transport.close().await;
    }
}

/// Standard and extended Solana APIs.
#[derive(Clone)]
pub struct SolanaClient {
    /// Standard Solana JSON-RPC.
    pub rpc: SolanaRpcClient,
    /// Indexed asset RPC using named parameters.
    pub das: SolanaDasClient,
    /// Indexed address history RPC.
    pub history: SolanaHistoryClient,
    /// Leader information RPC. Batching is rejected locally.
    pub leaders: SolanaLeaderClient,
    /// Analytics RPC.
    pub analytics: SolanaAnalyticsClient,
    /// Enhanced WebSocket subscriptions.
    pub subscriptions: SolanaSubscriptions,
}

impl SolanaClient {
    pub(crate) fn new(
        transport: Arc<HttpJsonRpcTransport>,
        websocket: Arc<WebSocketJsonRpcTransport>,
    ) -> Self {
        Self {
            rpc: SolanaRpcClient::new(Arc::clone(&transport)),
            das: SolanaDasClient::new(Arc::clone(&transport)),
            history: SolanaHistoryClient::new(Arc::clone(&transport)),
            leaders: SolanaLeaderClient::new(Arc::clone(&transport)),
            analytics: SolanaAnalyticsClient::new(transport),
            subscriptions: SolanaSubscriptions::new(websocket),
        }
    }
}
