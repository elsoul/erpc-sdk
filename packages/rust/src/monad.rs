use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
};

/// Monad mainnet read-only JSON-RPC methods represented by this release.
pub const MONAD_RPC_METHODS: &[&str] = &["eth_call", "eth_chainId", "eth_getBalance"];

/// Monad mainnet read-only service client.
#[derive(Clone)]
pub struct MonadClient {
    /// Monad mainnet read-only JSON-RPC namespace.
    pub rpc: MonadRpcClient,
}

impl MonadClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            rpc: MonadRpcClient::new(transport),
        }
    }
}

/// Monad mainnet read-only JSON-RPC namespace.
///
/// The deliberately narrow surface has compile-fail coverage for forbidden
/// escape hatches and state-changing operations:
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.monad.rpc;
/// let _ = rpc.raw::<String>("eth_chainId", None);
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.monad.rpc;
/// let _ = rpc.request::<String>("eth_chainId", Vec::<serde_json::Value>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.monad.rpc;
/// let _ = rpc.batch(Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.monad.rpc;
/// let _ = rpc.subscribe("newHeads", Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.monad.rpc;
/// let _ = rpc.eth_send_raw_transaction(["0xdeadbeef"]);
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct MonadRpcClient {
    namespace: RpcNamespace,
}

impl MonadRpcClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Unsupported),
        }
    }

    /// Returns the credential-free Monad mainnet origin and root.
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

    /// Creates a pending `eth_chainId` read.
    ///
    /// # Panics
    ///
    /// The empty parameter array is infallible to serialize.
    #[must_use]
    pub fn eth_chain_id(&self) -> PendingRpcRequest<String> {
        self.namespace
            .request("eth_chainId", Vec::<Value>::new())
            .expect("empty parameters serialize")
    }

    /// Creates a pending positional `eth_getBalance` read.
    pub fn eth_get_balance<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_getBalance", params)
    }

    /// Creates a pending positional `eth_call` read simulation.
    pub fn eth_call<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_call", params)
    }
}
