use std::{ops::Deref, sync::Arc};

use serde::Serialize;
use serde_json::Value;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
};

/// Bitcoin Core JSON-RPC methods represented by this release.
pub const BITCOIN_RPC_METHODS: &[&str] = &[
    "estimatesmartfee",
    "getbestblockhash",
    "getblock",
    "getblockchaininfo",
    "getblockcount",
    "getblockhash",
    "getblockheader",
    "getmempoolinfo",
    "getnetworkinfo",
    "getrawmempool",
    "getrawtransaction",
    "gettxout",
];

/// Bitcoin service client.
#[derive(Clone)]
pub struct BitcoinClient {
    /// Bitcoin Core JSON-RPC namespace.
    pub rpc: BitcoinRpcClient,
}

impl BitcoinClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            rpc: BitcoinRpcClient::new(transport),
        }
    }
}

/// Bitcoin Core JSON-RPC namespace.
#[derive(Clone)]
pub struct BitcoinRpcClient {
    namespace: RpcNamespace,
}

impl BitcoinRpcClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Any),
        }
    }
}

impl Deref for BitcoinRpcClient {
    type Target = RpcNamespace;

    fn deref(&self) -> &Self::Target {
        &self.namespace
    }
}

macro_rules! bitcoin_no_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl BitcoinRpcClient {
            $(
                #[doc = concat!("Creates a pending `", $wire, "` request.")]
                #[must_use]
                pub fn $name(&self) -> PendingRpcRequest<$result> {
                    self.namespace
                        .request($wire, Vec::<Value>::new())
                        .expect("empty parameters serialize")
                }
            )*
        }
    };
}

macro_rules! bitcoin_with_params {
    ($(($name:ident, $wire:literal, $result:ty)),* $(,)?) => {
        impl BitcoinRpcClient {
            $(
                #[doc = concat!("Creates a pending `", $wire, "` request from positional parameters.")]
                pub fn $name<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<$result>> {
                    self.namespace.request($wire, params)
                }
            )*
        }
    };
}

bitcoin_no_params!(
    (get_best_block_hash, "getbestblockhash", String),
    (get_blockchain_info, "getblockchaininfo", Value),
    (get_block_count, "getblockcount", u64),
    (get_mempool_info, "getmempoolinfo", Value),
    (get_network_info, "getnetworkinfo", Value),
);

bitcoin_with_params!(
    (estimate_smart_fee, "estimatesmartfee", Value),
    (get_block, "getblock", Value),
    (get_block_hash, "getblockhash", String),
    (get_block_header, "getblockheader", Value),
    (get_raw_mempool, "getrawmempool", Value),
    (get_raw_transaction, "getrawtransaction", Value),
    (get_tx_out, "gettxout", Option<Value>),
);
