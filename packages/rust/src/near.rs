//! Sealed, read-only NEAR JSON-RPC helpers.
//!
//! This module intentionally reuses [`crate::HttpJsonRpcTransport`] without a
//! NEAR-specific response policy.  Consequently it inherits the transport's
//! compatibility behavior: response IDs are checked for the same numeric type
//! and value as the request, a present `error` (including `null`) is decoded by
//! the existing strict policy, and a valid non-null error takes precedence over
//! a simultaneous result.  The transport does not independently validate the
//! response `jsonrpc` version.  These are compatibility details of the shared
//! transport, rather than a promise of full JSON-RPC envelope validation.
//!
//! The namespace exposes only typed status, block, and fixed `view_account`
//! reads.  It deliberately has no generic request/raw/batch/subscription or
//! transaction surface.

use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as DeError};
use serde_json::Value;
use url::Url;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
};

/// NEAR JSON-RPC methods represented by this release.
pub const NEAR_RPC_METHODS: &[&str] = &["block", "query", "status"];

/// A named NEAR block finality selector.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NearFinality {
    /// A finalized block.
    Final,
    /// The latest block observed by the node.
    Optimistic,
}

/// A height or opaque hash identifying a NEAR block.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum NearBlockId {
    /// A block height.  The value remains an integer on the wire.
    Height(u64),
    /// A block hash.  The value is passed through without local validation.
    Hash(String),
}

/// One mutually exclusive selector for a NEAR block or account read.
///
/// An explicit block ID identifies the requested data; it does not imply that
/// the block is finalized or that the provider retains archival history.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NearBlockReference {
    /// Select by the node's finality view.
    Finality {
        /// The finality mode requested from NEAR.
        finality: NearFinality,
    },
    /// Select one explicit height or hash.
    BlockId {
        /// The explicit block identifier.
        block_id: NearBlockId,
    },
}

impl Serialize for NearBlockReference {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;

        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            Self::Finality { finality } => map.serialize_entry("finality", finality)?,
            Self::BlockId { block_id } => map.serialize_entry("block_id", block_id)?,
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for NearBlockReference {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireReference {
            finality: Option<NearFinality>,
            block_id: Option<NearBlockId>,
        }

        let reference = WireReference::deserialize(deserializer)?;
        match (reference.finality, reference.block_id) {
            (Some(finality), None) => Ok(Self::Finality { finality }),
            (None, Some(block_id)) => Ok(Self::BlockId { block_id }),
            (Some(_), Some(_)) => Err(D::Error::custom(
                "NEAR block reference cannot contain both finality and block_id",
            )),
            (None, None) => Err(D::Error::custom(
                "NEAR block reference requires finality or block_id",
            )),
        }
    }
}

/// NEAR node status.
#[derive(Clone, Debug, Deserialize)]
pub struct NearStatus {
    /// Network identity, such as `mainnet`.
    pub chain_id: String,
    /// Genesis block hash.
    pub genesis_hash: String,
    /// Latest protocol version supported by the node.
    pub latest_protocol_version: u64,
    /// Current protocol version used by the node.
    pub protocol_version: u64,
    /// Synchronization state and latest observed block.
    pub sync_info: NearSyncInfo,
    /// Node software version.
    pub version: NearNodeVersion,
    /// Forward-compatible status fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// NEAR node synchronization information.
#[derive(Clone, Debug, Deserialize)]
pub struct NearSyncInfo {
    /// Latest observed block hash.
    pub latest_block_hash: String,
    /// Latest observed block height.
    pub latest_block_height: u64,
    /// Latest observed block timestamp as the raw RFC3339 timestamp string.
    pub latest_block_time: String,
    /// Latest observed state-root hash.
    pub latest_state_root: String,
    /// Whether the node is still synchronizing.
    pub syncing: bool,
    /// Forward-compatible synchronization fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// NEAR node software version.
#[derive(Clone, Debug, Deserialize)]
pub struct NearNodeVersion {
    /// Human-readable node version.
    pub version: String,
    /// Build identifier.
    pub build: String,
    /// Optional Rust compiler version reported by the node.
    pub rustc_version: Option<String>,
    /// Forward-compatible version fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// A typed NEAR block response with a guarded chunk collection.
#[derive(Clone, Debug, Deserialize)]
pub struct NearBlockView {
    /// Account that authored the block.
    pub author: String,
    /// Stable block header projection.
    pub header: NearBlockHeader,
    /// Chunk records retained as JSON for forward compatibility.
    pub chunks: Vec<Value>,
    /// Forward-compatible block fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Stable fields from a NEAR block header.
#[derive(Clone, Debug, Deserialize)]
pub struct NearBlockHeader {
    /// Block hash.
    pub hash: String,
    /// Block height.
    pub height: u64,
    /// Parent block hash.
    pub prev_hash: String,
    /// Block timestamp in nanoseconds as a JSON integer.
    pub timestamp: u64,
    /// Exact nanosecond timestamp representation returned by NEAR.
    pub timestamp_nanosec: String,
    /// Exact gas-price decimal string.
    pub gas_price: String,
    /// Exact total-supply decimal string.
    pub total_supply: String,
    /// Forward-compatible header fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// Typed account state returned by the fixed NEAR `view_account` query.
#[derive(Clone, Debug, Deserialize)]
pub struct NearAccountView {
    /// Account balance in yoctoNEAR, preserved as an exact decimal string.
    pub amount: String,
    /// Locked balance in yoctoNEAR, preserved as an exact decimal string.
    pub locked: String,
    /// Contract code hash.
    pub code_hash: String,
    /// Account storage usage in bytes.
    pub storage_usage: u64,
    /// Optional storage payment height for uninitialized accounts.
    pub storage_paid_at: Option<u64>,
    /// Height of the block containing this account state.
    pub block_height: u64,
    /// Hash of the block containing this account state.
    pub block_hash: String,
    /// Optional account state marker.
    pub state: Option<String>,
    /// Optional bootstrap nonce.
    pub bootstrap_nonce: Option<u64>,
    /// Optional global-contract account ID.
    pub global_contract_account_id: Option<String>,
    /// Optional global-contract hash.
    pub global_contract_hash: Option<String>,
    /// Forward-compatible account fields.
    #[serde(flatten)]
    pub additional: HashMap<String, Value>,
}

/// NEAR service client.
#[derive(Clone)]
pub struct NearClient {
    /// Sealed NEAR JSON-RPC namespace.
    pub rpc: NearRpcClient,
}

impl NearClient {
    pub(crate) fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            rpc: NearRpcClient::new(transport),
        }
    }
}

/// Read-only NEAR JSON-RPC namespace.
///
/// Only the three typed reads below are available.  The private underlying
/// [`RpcNamespace`] is intentionally not exposed and this type does not
/// implement `Deref` or `AsRef`.
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.raw::<serde_json::Value>("query", None);
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.request::<serde_json::Value>("query", serde_json::Value::Null);
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.batch(Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.subscribe("heads", Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.call_function("account", "method", Vec::<u8>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.send_tx(Vec::<u8>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.broadcast_tx_async(Vec::<u8>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.near.rpc;
/// let _ = rpc.broadcast_tx_commit(Vec::<u8>::new());
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct NearRpcClient {
    namespace: RpcNamespace,
}

impl NearRpcClient {
    pub(crate) fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Unsupported),
        }
    }

    /// Returns only the configured origin and `/`, with credentials and route
    /// prefixes removed.  Empty string denotes an unavailable namespace.
    #[must_use]
    pub fn endpoint(&self) -> String {
        let endpoint = self.namespace.endpoint();
        if endpoint.is_empty() {
            return endpoint;
        }
        let Ok(mut url) = Url::parse(&endpoint) else {
            return String::new();
        };
        url.set_path("/");
        url.set_query(None);
        url.set_fragment(None);
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.to_string()
    }

    /// Creates a pending `status` read with exactly `params: []`.
    ///
    /// # Panics
    ///
    /// This method panics only if serializing the built-in empty parameter
    /// array fails; serialization of `Vec<Value>` is infallible for this
    /// value.
    #[must_use]
    pub fn status(&self) -> PendingRpcRequest<NearStatus> {
        self.namespace
            .request("status", Vec::<Value>::new())
            .expect("empty parameters serialize")
    }

    /// Creates a pending `block` read for exactly one selector.
    pub fn block(&self, reference: NearBlockReference) -> Result<PendingRpcRequest<NearBlockView>> {
        self.namespace.request("block", reference)
    }

    /// Creates the fixed `view_account` query for an opaque account ID.
    ///
    /// # Panics
    ///
    /// This method panics only if the internal one-key block selector cannot
    /// be serialized or does not serialize as an object.  The selector type's
    /// implementation guarantees both properties for its two variants.
    pub fn view_account(
        &self,
        account_id: impl Into<String>,
        reference: NearBlockReference,
    ) -> Result<PendingRpcRequest<NearAccountView>> {
        let selector = serde_json::to_value(reference)
            .expect("NEAR block reference serialization is infallible");
        let Some(selector) = selector.as_object() else {
            unreachable!("NEAR block references serialize as one-key objects");
        };
        let mut params = serde_json::Map::with_capacity(3);
        params.insert(
            "request_type".to_owned(),
            Value::String("view_account".to_owned()),
        );
        params.insert("account_id".to_owned(), Value::String(account_id.into()));
        params.extend(selector.clone());
        self.namespace.request("query", Value::Object(params))
    }
}
