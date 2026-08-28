use std::{ops::Deref, sync::Arc};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
    subscriptions::{RpcSubscription, SubscriptionId, WebSocketJsonRpcTransport},
};

/// Ethereum JSON-RPC methods represented by this release.
pub const ETHEREUM_RPC_METHODS: &[&str] = &[
    "eth_accounts",
    "eth_baseFee",
    "eth_blobBaseFee",
    "eth_blockNumber",
    "eth_call",
    "eth_callMany",
    "eth_capabilities",
    "eth_chainId",
    "eth_createAccessList",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_gasPrice",
    "eth_getAccount",
    "eth_getBalance",
    "eth_getBlockByHash",
    "eth_getBlockByNumber",
    "eth_getBlockReceipts",
    "eth_getBlockTransactionCountByHash",
    "eth_getBlockTransactionCountByNumber",
    "eth_getCode",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
    "eth_getLogs",
    "eth_getProof",
    "eth_getRawTransactionByHash",
    "eth_getStorageAt",
    "eth_getTransactionByBlockHashAndIndex",
    "eth_getTransactionByBlockNumberAndIndex",
    "eth_getTransactionByHash",
    "eth_getTransactionBySenderAndNonce",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_getUncleCountByBlockHash",
    "eth_getUncleCountByBlockNumber",
    "eth_maxPriorityFeePerGas",
    "eth_newBlockFilter",
    "eth_newFilter",
    "eth_newPendingTransactionFilter",
    "eth_sendRawTransaction",
    "eth_signTransaction",
    "eth_simulateV1",
    "eth_submitWork",
    "eth_syncing",
    "eth_uninstallFilter",
    "net_listening",
    "net_peerCount",
    "net_version",
    "txpool_content",
    "txpool_contentFrom",
    "txpool_inspect",
    "txpool_status",
    "web3_clientVersion",
    "web3_sha3",
];

/// Ethereum WebSocket subscription methods represented by this release.
pub const ETHEREUM_SUBSCRIPTION_METHODS: &[&str] = &["eth_subscribe", "eth_unsubscribe"];

/// Standard Ethereum JSON-RPC namespace.
#[derive(Clone)]
pub struct EthereumRpcClient {
    namespace: RpcNamespace,
}

impl EthereumRpcClient {
    const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Any),
        }
    }
}

impl Deref for EthereumRpcClient {
    type Target = RpcNamespace;

    fn deref(&self) -> &Self::Target {
        &self.namespace
    }
}

macro_rules! ethereum_no_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl EthereumRpcClient {
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

macro_rules! ethereum_with_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl EthereumRpcClient {
            $(
                #[doc = concat!("Creates a pending `", $wire, "` request from positional parameters.")]
                pub fn $name<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<$result>> {
                    self.namespace.request($wire, params)
                }
            )*
        }
    };
}

ethereum_no_params!(
    (eth_accounts, "eth_accounts", Vec<String>),
    (eth_base_fee, "eth_baseFee", String),
    (eth_blob_base_fee, "eth_blobBaseFee", String),
    (eth_block_number, "eth_blockNumber", String),
    (eth_capabilities, "eth_capabilities", Value),
    (eth_chain_id, "eth_chainId", String),
    (eth_gas_price, "eth_gasPrice", String),
    (eth_max_priority_fee_per_gas, "eth_maxPriorityFeePerGas", String),
    (eth_new_block_filter, "eth_newBlockFilter", String),
    (
        eth_new_pending_transaction_filter,
        "eth_newPendingTransactionFilter",
        String
    ),
    (eth_syncing, "eth_syncing", Value),
    (net_listening, "net_listening", bool),
    (net_peer_count, "net_peerCount", String),
    (net_version, "net_version", String),
    (txpool_content, "txpool_content", Value),
    (txpool_inspect, "txpool_inspect", Value),
    (txpool_status, "txpool_status", Value),
    (web3_client_version, "web3_clientVersion", String),
);

ethereum_with_params!(
    (eth_call, "eth_call", String),
    (eth_call_many, "eth_callMany", Value),
    (eth_create_access_list, "eth_createAccessList", Value),
    (eth_estimate_gas, "eth_estimateGas", String),
    (eth_fee_history, "eth_feeHistory", Value),
    (eth_get_account, "eth_getAccount", Value),
    (eth_get_balance, "eth_getBalance", String),
    (eth_get_block_by_hash, "eth_getBlockByHash", Option<Value>),
    (eth_get_block_by_number, "eth_getBlockByNumber", Option<Value>),
    (eth_get_block_receipts, "eth_getBlockReceipts", Option<Value>),
    (
        eth_get_block_transaction_count_by_hash,
        "eth_getBlockTransactionCountByHash",
        Option<String>
    ),
    (
        eth_get_block_transaction_count_by_number,
        "eth_getBlockTransactionCountByNumber",
        Option<String>
    ),
    (eth_get_code, "eth_getCode", String),
    (eth_get_filter_changes, "eth_getFilterChanges", Value),
    (eth_get_filter_logs, "eth_getFilterLogs", Value),
    (eth_get_logs, "eth_getLogs", Value),
    (eth_get_proof, "eth_getProof", Value),
    (
        eth_get_raw_transaction_by_hash,
        "eth_getRawTransactionByHash",
        Option<String>
    ),
    (eth_get_storage_at, "eth_getStorageAt", String),
    (
        eth_get_transaction_by_block_hash_and_index,
        "eth_getTransactionByBlockHashAndIndex",
        Option<Value>
    ),
    (
        eth_get_transaction_by_block_number_and_index,
        "eth_getTransactionByBlockNumberAndIndex",
        Option<Value>
    ),
    (
        eth_get_transaction_by_hash,
        "eth_getTransactionByHash",
        Option<Value>
    ),
    (
        eth_get_transaction_by_sender_and_nonce,
        "eth_getTransactionBySenderAndNonce",
        Option<Value>
    ),
    (eth_get_transaction_count, "eth_getTransactionCount", String),
    (
        eth_get_transaction_receipt,
        "eth_getTransactionReceipt",
        Option<Value>
    ),
    (
        eth_get_uncle_count_by_block_hash,
        "eth_getUncleCountByBlockHash",
        String
    ),
    (
        eth_get_uncle_count_by_block_number,
        "eth_getUncleCountByBlockNumber",
        String
    ),
    (eth_new_filter, "eth_newFilter", String),
    (eth_send_raw_transaction, "eth_sendRawTransaction", String),
    (eth_sign_transaction, "eth_signTransaction", String),
    (eth_simulate_v1, "eth_simulateV1", Value),
    (eth_submit_work, "eth_submitWork", bool),
    (eth_uninstall_filter, "eth_uninstallFilter", bool),
    (txpool_content_from, "txpool_contentFrom", Value),
    (web3_sha3, "web3_sha3", String),
);

/// Ethereum subscription client.
#[derive(Clone)]
pub struct EthereumSubscriptions {
    transport: Arc<WebSocketJsonRpcTransport>,
}

impl EthereumSubscriptions {
    pub(crate) const fn new(transport: Arc<WebSocketJsonRpcTransport>) -> Self {
        Self { transport }
    }

    /// Credential-free WebSocket endpoint.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        self.transport.endpoint()
    }

    /// Starts an `eth_subscribe` subscription.
    pub async fn subscribe(
        &self,
        subscription: &str,
        options: Vec<Value>,
    ) -> Result<RpcSubscription> {
        let mut params = vec![Value::String(subscription.to_owned())];
        params.extend(options);
        let receiver = self.transport.subscribe_notifications();
        let id: String = self
            .transport
            .request("eth_subscribe", Value::Array(params), None)
            .await?;
        Ok(RpcSubscription::new(
            SubscriptionId::String(id),
            Arc::clone(&self.transport),
            "eth_unsubscribe",
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

/// Standard Ethereum JSON-RPC and subscriptions.
#[derive(Clone)]
pub struct EthereumClient {
    /// Standard Ethereum JSON-RPC namespace.
    pub rpc: EthereumRpcClient,
    /// Ethereum WebSocket subscriptions.
    pub subscriptions: EthereumSubscriptions,
}

impl EthereumClient {
    pub(crate) const fn new(
        transport: Arc<HttpJsonRpcTransport>,
        websocket: Arc<WebSocketJsonRpcTransport>,
    ) -> Self {
        Self {
            rpc: EthereumRpcClient::new(transport),
            subscriptions: EthereumSubscriptions::new(websocket),
        }
    }
}
