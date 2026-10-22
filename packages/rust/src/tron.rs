use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    rpc::{BatchPolicy, HttpJsonRpcTransport},
};

/// TRON Mainnet read-only JSON-RPC methods represented by this release.
pub const TRON_RPC_METHODS: &[&str] = &["eth_call", "eth_chainId", "eth_getBalance"];

/// TRON Mainnet read-only JSON-RPC service client.
///
/// TRON Mainnet uses chain ID `728126428` (`0x2b6653dc`). The native balance
/// returned by `eth_getBalance` is a raw JSON-RPC quantity in lowercase `sun`
/// units (`1 TRX = 1,000,000 sun`); this client does not parse or convert it.
#[derive(Clone)]
pub struct TronClient {
    /// TRON Mainnet read-only JSON-RPC namespace.
    pub rpc: TronRpcClient,
}

impl TronClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            rpc: TronRpcClient::new(transport),
        }
    }
}

/// TRON Mainnet read-only JSON-RPC namespace.
///
/// The namespace deliberately exposes only the three read methods represented
/// by [`TRON_RPC_METHODS`]. JSON-RPC quantities and results remain raw strings;
/// in particular, no `41` prefix or `Base58Check` address conversion is applied.
/// Callers should use the documented interoperable 20-byte `0x` hexadecimal
/// address form and the `latest` state selector.
///
/// A hosted root target is posted to `/`; the provider owns its upstream
/// `/jsonrpc` route. A caller-owned direct endpoint is the complete request
/// target, so a direct `/jsonrpc` suffix, encoded path, and query are retained
/// unchanged. The client is HTTP-only and has no REST, generic raw/request,
/// batch, subscription, transaction, signing, broadcast, swap, or bridge API.
///
/// The intentionally narrow surface has compile-fail coverage for forbidden
/// escape hatches and state-changing operations:
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.tron.rpc;
/// let _ = rpc.raw::<String>("eth_chainId", None);
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.tron.rpc;
/// let _ = rpc.request::<String>("eth_chainId", Vec::<serde_json::Value>::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.tron.rpc;
/// let _ = rpc.batch(Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.tron.rpc;
/// let _ = rpc.subscribe("newHeads", Vec::new());
/// # Ok(())
/// # }
/// ```
///
/// ```compile_fail
/// # use erpc_sdk::{ErpcClient, ErpcClientConfig};
/// # async fn forbidden() -> erpc_sdk::Result<()> {
/// let rpc = ErpcClient::new(ErpcClientConfig::new("key"))?.tron.rpc;
/// let _ = rpc.eth_send_raw_transaction(["0xdeadbeef"]);
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct TronRpcClient {
    namespace: RpcNamespace,
}

impl TronRpcClient {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
        Self {
            namespace: RpcNamespace::new(transport, BatchPolicy::Unsupported),
        }
    }

    /// Returns the credential-free TRON Mainnet JSON-RPC origin and root.
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

    /// Creates a pending TRON Mainnet `eth_chainId` read.
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

    /// Creates a pending positional TRON native balance read.
    ///
    /// The raw JSON-RPC quantity is returned unchanged. TRON uses lowercase
    /// `sun` as the native base unit; no TRX/sun scaling or conversion occurs.
    pub fn eth_get_balance<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_getBalance", params)
    }

    /// Creates a pending read-only TRON `eth_call` simulation.
    ///
    /// The caller's 20-byte `0x` hexadecimal address and `latest` selector are
    /// serialized unchanged. This helper does not construct, sign, or submit
    /// a transaction and does not promise archive-state support.
    pub fn eth_call<P: Serialize>(&self, params: P) -> Result<PendingRpcRequest<String>> {
        self.namespace.request("eth_call", params)
    }
}
