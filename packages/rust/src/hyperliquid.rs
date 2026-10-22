use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
};

/// Hyperliquid `HyperEVM` mainnet read-only JSON-RPC methods represented by this release.
pub const HYPERLIQUID_RPC_METHODS: &[&str] = &["eth_call", "eth_chainId", "eth_getBalance"];

/// Hyperliquid `HyperEVM` mainnet read-only JSON-RPC service client.
///
/// This client is `HyperEVM`-only (chain ID `999` / `0x3e7`) and treats HYPE as
/// the native gas balance.
#[derive(Clone)]
pub struct HyperliquidClient {
    /// Hyperliquid `HyperEVM` mainnet read-only JSON-RPC namespace.
    pub rpc: HyperliquidRpcClient,
}

impl HyperliquidClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            rpc: HyperliquidRpcClient::new(transport),
        }
    }
}

/// Hyperliquid `HyperEVM` mainnet read-only JSON-RPC namespace.
///
/// It targets `HyperEVM` mainnet chain ID `999` (`0x3e7`); HYPE is represented
/// only as the native balance in this read-only surface.
///
/// The deliberately narrow surface has compile-fail coverage for forbidden
/// escape hatches and state-changing operations:
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.hyperliquid.rpc;
/// let _ = rpc.raw::<String>("eth_chainId", None);
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.hyperliquid.rpc;
/// let _ = rpc.request::<String>("eth_chainId", Vec::<serde_json::Value>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.hyperliquid.rpc;
/// let _ = rpc.batch(Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.hyperliquid.rpc;
/// let _ = rpc.subscribe("newHeads", Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.hyperliquid.rpc;
/// let _ = rpc.eth_send_raw_transaction(["0xdeadbeef"]);
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct HyperliquidRpcClient {
    namespace: RpcNamespace,
}

impl HyperliquidRpcClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Unsupported),
        }
    }

    /// Returns the credential-free Hyperliquid `HyperEVM` mainnet read-only JSON-RPC origin and root.
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

    /// Creates a pending Hyperliquid `HyperEVM` mainnet read-only JSON-RPC `eth_chainId` read.
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

    /// Creates a pending positional Hyperliquid `HyperEVM` mainnet read-only JSON-RPC `eth_getBalance` read.
    pub fn eth_get_balance<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_getBalance", params)
    }

    /// Creates a pending positional Hyperliquid `HyperEVM` mainnet read-only JSON-RPC `eth_call` simulation.
    pub fn eth_call<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_call", params)
    }
}
