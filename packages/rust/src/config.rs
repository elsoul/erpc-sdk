use std::{fmt, str::FromStr, time::Duration};

use percent_encoding::percent_decode_str;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use url::Url;

use crate::{ErpcError, Result};

/// Default JSON-RPC and price endpoint.
pub const DEFAULT_ENDPOINT: &str = "https://edge.erpc.global";
/// Default Avalanche JSON-RPC endpoint.
pub const DEFAULT_AVALANCHE_ENDPOINT: &str = "https://ava-rpc.erpc.global";
/// Default account endpoint.
pub const DEFAULT_ACCOUNT_ENDPOINT: &str = "https://solana-rpc.erpc.global";
/// Default user and Cloud endpoint.
pub const DEFAULT_USER_ENDPOINT: &str = "https://user-api.erpc.global";
/// Default Base JSON-RPC endpoint.
pub const DEFAULT_BASE_ENDPOINT: &str = "https://base.erpc.global";
/// Default Arbitrum One JSON-RPC endpoint.
pub const DEFAULT_ARBITRUM_ENDPOINT: &str = "https://arbitrum.erpc.global";
/// Default Polygon `PoS` mainnet JSON-RPC endpoint.
pub const DEFAULT_POLYGON_ENDPOINT: &str = "https://polygon.erpc.global";
/// Default BNB Smart Chain mainnet JSON-RPC endpoint.
pub const DEFAULT_BSC_ENDPOINT: &str = "https://bsc.erpc.global";
/// Default OP Mainnet JSON-RPC endpoint.
pub const DEFAULT_OPTIMISM_ENDPOINT: &str = "https://optimism.erpc.global";
/// Default Kaia mainnet JSON-RPC endpoint.
pub const DEFAULT_KAIA_ENDPOINT: &str = "https://kaia.erpc.global";
/// Default Soneium mainnet JSON-RPC endpoint.
pub const DEFAULT_SONEIUM_ENDPOINT: &str = "https://soneium.erpc.global";
/// Default Monad mainnet JSON-RPC endpoint.
pub const DEFAULT_MONAD_ENDPOINT: &str = "https://monad.erpc.global";
/// Default Hyperliquid `HyperEVM` mainnet JSON-RPC endpoint.
pub const DEFAULT_HYPERLIQUID_ENDPOINT: &str = "https://hyperliquid.erpc.global";
/// Default Arc mainnet JSON-RPC endpoint.
pub const DEFAULT_ARC_ENDPOINT: &str = "https://arc.erpc.global";
/// Default Robinhood Chain Public Mainnet JSON-RPC endpoint.
pub const DEFAULT_ROBINHOOD_ENDPOINT: &str = "https://robinhood.erpc.global";
/// Default NEAR mainnet JSON-RPC endpoint.
pub const DEFAULT_NEAR_ENDPOINT: &str = "https://near.erpc.global";
/// Default TRON mainnet JSON-RPC endpoint.
pub const DEFAULT_TRON_ENDPOINT: &str = "https://tron.erpc.global";
/// Default Sui mainnet binary gRPC-Web endpoint.
pub const DEFAULT_SUI_ENDPOINT: &str = "https://sui.erpc.global";
/// Default request and connection-establishment timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Configuration for one caller-owned JSON-RPC endpoint.
///
/// The HTTP URL is the complete request target. Its path and query are
/// preserved exactly and no eRPC route or API-key query parameter is added.
/// A WebSocket URL, when supplied, is independent from the HTTP URL.
#[derive(Clone)]
pub struct RpcEndpointConfig {
    /// Complete HTTP(S) JSON-RPC request target.
    pub http_url: String,
    /// Optional complete WS(S) subscription target.
    pub websocket_url: Option<String>,
    /// Headers scoped to this endpoint's HTTP JSON-RPC requests only.
    pub headers: Vec<(String, String)>,
}

impl fmt::Debug for RpcEndpointConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RpcEndpointConfig")
            .field("http_url", &debug_endpoint(&self.http_url))
            .field(
                "websocket_url",
                &self.websocket_url.as_deref().map(debug_endpoint),
            )
            .field(
                "header_names",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl RpcEndpointConfig {
    /// Starts an endpoint configuration with a complete HTTP(S) URL.
    #[must_use]
    pub fn new(http_url: impl Into<String>) -> Self {
        Self {
            http_url: http_url.into(),
            websocket_url: None,
            headers: Vec::new(),
        }
    }

    /// Replaces the complete HTTP(S) request target.
    #[must_use]
    pub fn with_http_url(mut self, http_url: impl Into<String>) -> Self {
        self.http_url = http_url.into();
        self
    }

    /// Sets the independent complete WS(S) subscription target.
    #[must_use]
    pub fn with_websocket_url(mut self, websocket_url: impl Into<String>) -> Self {
        self.websocket_url = Some(websocket_url.into());
        self
    }

    /// Sets the independent complete WS(S) subscription target.
    #[must_use]
    pub fn with_websocket(self, websocket_url: impl Into<String>) -> Self {
        self.with_websocket_url(websocket_url)
    }

    /// Adds an HTTP header scoped to this endpoint.
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Replaces the endpoint-scoped headers.
    #[must_use]
    pub fn with_headers<I, N, V>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = (N, V)>,
        N: Into<String>,
        V: Into<String>,
    {
        self.headers = headers
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect();
        self
    }
}

impl From<&str> for RpcEndpointConfig {
    fn from(http_url: &str) -> Self {
        Self::new(http_url)
    }
}

impl From<String> for RpcEndpointConfig {
    fn from(http_url: String) -> Self {
        Self::new(http_url)
    }
}

impl Default for RpcEndpointConfig {
    fn default() -> Self {
        Self::new("")
    }
}

/// Configuration for one caller-owned binary Sui gRPC-Web endpoint.
///
/// The URL is a base prefix. Each supported Sui method is appended to it at
/// request time while preserving its encoded path and query string.
#[derive(Clone)]
pub struct SuiGrpcWebEndpointConfig {
    /// Base HTTP(S) URL for the caller-owned binary gRPC-Web service.
    pub base_url: String,
    /// Headers scoped to this Sui endpoint only.
    pub headers: Vec<(String, String)>,
}

impl fmt::Debug for SuiGrpcWebEndpointConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SuiGrpcWebEndpointConfig")
            .field("origin", &debug_origin(&self.base_url))
            .field(
                "header_names",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl SuiGrpcWebEndpointConfig {
    /// Starts a Sui configuration with a base HTTP(S) URL.
    #[must_use]
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            headers: Vec::new(),
        }
    }

    /// Replaces the base HTTP(S) URL.
    #[must_use]
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Adds a header scoped to this Sui endpoint.
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Replaces the endpoint-scoped headers.
    #[must_use]
    pub fn with_headers<I, N, V>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = (N, V)>,
        N: Into<String>,
        V: Into<String>,
    {
        self.headers = headers
            .into_iter()
            .map(|(name, value)| (name.into(), value.into()))
            .collect();
        self
    }
}

impl From<&str> for SuiGrpcWebEndpointConfig {
    fn from(base_url: &str) -> Self {
        Self::new(base_url)
    }
}

impl From<String> for SuiGrpcWebEndpointConfig {
    fn from(base_url: String) -> Self {
        Self::new(base_url)
    }
}

/// Configuration used to create an [`crate::ErpcClient`].
#[derive(Clone)]
pub struct ErpcClientConfig {
    /// ERPC API key. It is held in memory and omitted from debug output.
    api_key: String,
    /// Optional JSON-RPC and price endpoint override.
    pub endpoint: String,
    /// Optional Avalanche endpoint override.
    pub avalanche_endpoint: String,
    /// Optional account endpoint override.
    pub account_endpoint: String,
    /// Optional user endpoint override.
    pub user_endpoint: String,
    /// Extra request headers.
    pub headers: Vec<(String, String)>,
    /// Request timeout.
    pub timeout: Duration,
    /// Optional caller-owned Solana JSON-RPC endpoint.
    pub solana_rpc: Option<RpcEndpointConfig>,
    /// Optional caller-owned Ethereum JSON-RPC endpoint.
    pub ethereum_rpc: Option<RpcEndpointConfig>,
    /// Optional caller-owned Avalanche C-Chain JSON-RPC endpoint.
    pub avalanche_c_rpc: Option<RpcEndpointConfig>,
    /// Optional caller-owned Bitcoin JSON-RPC endpoint.
    pub bitcoin_rpc: Option<RpcEndpointConfig>,
    /// Hosted Base JSON-RPC endpoint override.
    pub base_endpoint: String,
    /// Optional caller-owned Base JSON-RPC endpoint.
    pub base_rpc: Option<RpcEndpointConfig>,
    /// Hosted Arbitrum One JSON-RPC endpoint override.
    pub arbitrum_endpoint: String,
    /// Optional caller-owned Arbitrum One JSON-RPC endpoint.
    pub arbitrum_rpc: Option<RpcEndpointConfig>,
    /// Hosted Polygon `PoS` mainnet JSON-RPC endpoint override.
    pub polygon_endpoint: String,
    /// Optional caller-owned Polygon `PoS` mainnet JSON-RPC endpoint.
    pub polygon_rpc: Option<RpcEndpointConfig>,
    /// Hosted BNB Smart Chain mainnet JSON-RPC endpoint override.
    pub bsc_endpoint: String,
    /// Optional caller-owned BNB Smart Chain mainnet JSON-RPC endpoint.
    pub bsc_rpc: Option<RpcEndpointConfig>,
    /// Hosted OP Mainnet JSON-RPC endpoint override.
    pub optimism_endpoint: String,
    /// Optional caller-owned OP Mainnet JSON-RPC endpoint.
    pub optimism_rpc: Option<RpcEndpointConfig>,
    /// Hosted Kaia mainnet JSON-RPC endpoint override.
    pub kaia_endpoint: String,
    /// Optional caller-owned Kaia mainnet JSON-RPC endpoint.
    pub kaia_rpc: Option<RpcEndpointConfig>,
    /// Hosted Soneium mainnet JSON-RPC endpoint override.
    pub soneium_endpoint: String,
    /// Optional caller-owned Soneium mainnet JSON-RPC endpoint.
    pub soneium_rpc: Option<RpcEndpointConfig>,
    /// Hosted Monad mainnet JSON-RPC endpoint override.
    pub monad_endpoint: String,
    /// Optional caller-owned Monad mainnet JSON-RPC endpoint.
    pub monad_rpc: Option<RpcEndpointConfig>,
    /// Hosted Hyperliquid `HyperEVM` mainnet JSON-RPC endpoint override.
    pub hyperliquid_endpoint: String,
    /// Optional caller-owned Hyperliquid `HyperEVM` mainnet JSON-RPC endpoint.
    pub hyperliquid_rpc: Option<RpcEndpointConfig>,
    /// Hosted Arc mainnet JSON-RPC endpoint override.
    pub arc_endpoint: String,
    /// Optional caller-owned Arc mainnet JSON-RPC endpoint.
    pub arc_rpc: Option<RpcEndpointConfig>,
    /// Hosted Robinhood Chain Public Mainnet JSON-RPC endpoint override.
    pub robinhood_endpoint: String,
    /// Optional caller-owned Robinhood Chain Public Mainnet JSON-RPC endpoint.
    pub robinhood_rpc: Option<RpcEndpointConfig>,
    /// Hosted NEAR mainnet endpoint override.
    pub near_endpoint: String,
    /// Optional caller-owned NEAR JSON-RPC endpoint.
    pub near_rpc: Option<RpcEndpointConfig>,
    /// Hosted TRON mainnet endpoint override.
    pub tron_endpoint: String,
    /// Optional caller-owned TRON JSON-RPC endpoint.
    pub tron_rpc: Option<RpcEndpointConfig>,
    /// Hosted Sui binary gRPC-Web endpoint override.
    pub sui_endpoint: String,
    /// Optional caller-owned Sui binary gRPC-Web endpoint.
    pub sui_grpc_web: Option<SuiGrpcWebEndpointConfig>,
}

impl fmt::Debug for ErpcClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ErpcClientConfig")
            .field("api_key", &"[REDACTED]")
            .field("endpoint", &debug_endpoint(&self.endpoint))
            .field(
                "avalanche_endpoint",
                &debug_endpoint(&self.avalanche_endpoint),
            )
            .field("account_endpoint", &debug_endpoint(&self.account_endpoint))
            .field("user_endpoint", &debug_endpoint(&self.user_endpoint))
            .field("solana_rpc", &self.solana_rpc)
            .field("ethereum_rpc", &self.ethereum_rpc)
            .field("avalanche_c_rpc", &self.avalanche_c_rpc)
            .field("bitcoin_rpc", &self.bitcoin_rpc)
            .field("base_endpoint", &debug_origin(&self.base_endpoint))
            .field("base_rpc", &self.base_rpc.as_ref().map(BaseRpcDebug))
            .field("arbitrum_endpoint", &debug_origin(&self.arbitrum_endpoint))
            .field(
                "arbitrum_rpc",
                &self.arbitrum_rpc.as_ref().map(ArbitrumRpcDebug),
            )
            .field("polygon_endpoint", &debug_origin(&self.polygon_endpoint))
            .field(
                "polygon_rpc",
                &self.polygon_rpc.as_ref().map(PolygonRpcDebug),
            )
            .field("bsc_endpoint", &debug_origin(&self.bsc_endpoint))
            .field("bsc_rpc", &self.bsc_rpc.as_ref().map(BscRpcDebug))
            .field("optimism_endpoint", &debug_origin(&self.optimism_endpoint))
            .field(
                "optimism_rpc",
                &self.optimism_rpc.as_ref().map(OptimismRpcDebug),
            )
            .field("kaia_endpoint", &debug_origin(&self.kaia_endpoint))
            .field("kaia_rpc", &self.kaia_rpc.as_ref().map(KaiaRpcDebug))
            .field("soneium_endpoint", &debug_origin(&self.soneium_endpoint))
            .field(
                "soneium_rpc",
                &self.soneium_rpc.as_ref().map(SoneiumRpcDebug),
            )
            .field("monad_endpoint", &debug_origin(&self.monad_endpoint))
            .field("monad_rpc", &self.monad_rpc.as_ref().map(MonadRpcDebug))
            .field(
                "hyperliquid_endpoint",
                &debug_origin(&self.hyperliquid_endpoint),
            )
            .field(
                "hyperliquid_rpc",
                &self.hyperliquid_rpc.as_ref().map(HyperliquidRpcDebug),
            )
            .field("arc_endpoint", &debug_origin(&self.arc_endpoint))
            .field("arc_rpc", &self.arc_rpc.as_ref().map(ArcRpcDebug))
            .field(
                "robinhood_endpoint",
                &debug_origin(&self.robinhood_endpoint),
            )
            .field(
                "robinhood_rpc",
                &self.robinhood_rpc.as_ref().map(RobinhoodRpcDebug),
            )
            .field("near_endpoint", &debug_origin(&self.near_endpoint))
            .field("near_rpc", &self.near_rpc.as_ref().map(NearRpcDebug))
            .field("tron_endpoint", &debug_origin(&self.tron_endpoint))
            .field("tron_rpc", &self.tron_rpc.as_ref().map(TronRpcDebug))
            .field("sui_endpoint", &debug_origin(&self.sui_endpoint))
            .field("sui_grpc_web", &self.sui_grpc_web)
            .field(
                "header_names",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl ErpcClientConfig {
    /// Starts a configuration with production endpoints and a 30-second timeout.
    #[must_use]
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            endpoint: DEFAULT_ENDPOINT.to_owned(),
            avalanche_endpoint: DEFAULT_AVALANCHE_ENDPOINT.to_owned(),
            account_endpoint: DEFAULT_ACCOUNT_ENDPOINT.to_owned(),
            user_endpoint: DEFAULT_USER_ENDPOINT.to_owned(),
            headers: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
            solana_rpc: None,
            ethereum_rpc: None,
            avalanche_c_rpc: None,
            bitcoin_rpc: None,
            base_endpoint: DEFAULT_BASE_ENDPOINT.to_owned(),
            base_rpc: None,
            arbitrum_endpoint: DEFAULT_ARBITRUM_ENDPOINT.to_owned(),
            arbitrum_rpc: None,
            polygon_endpoint: DEFAULT_POLYGON_ENDPOINT.to_owned(),
            polygon_rpc: None,
            bsc_endpoint: DEFAULT_BSC_ENDPOINT.to_owned(),
            bsc_rpc: None,
            optimism_endpoint: DEFAULT_OPTIMISM_ENDPOINT.to_owned(),
            optimism_rpc: None,
            kaia_endpoint: DEFAULT_KAIA_ENDPOINT.to_owned(),
            kaia_rpc: None,
            soneium_endpoint: DEFAULT_SONEIUM_ENDPOINT.to_owned(),
            soneium_rpc: None,
            monad_endpoint: DEFAULT_MONAD_ENDPOINT.to_owned(),
            monad_rpc: None,
            hyperliquid_endpoint: DEFAULT_HYPERLIQUID_ENDPOINT.to_owned(),
            hyperliquid_rpc: None,
            arc_endpoint: DEFAULT_ARC_ENDPOINT.to_owned(),
            arc_rpc: None,
            robinhood_endpoint: DEFAULT_ROBINHOOD_ENDPOINT.to_owned(),
            robinhood_rpc: None,
            near_endpoint: DEFAULT_NEAR_ENDPOINT.to_owned(),
            near_rpc: None,
            tron_endpoint: DEFAULT_TRON_ENDPOINT.to_owned(),
            tron_rpc: None,
            sui_endpoint: DEFAULT_SUI_ENDPOINT.to_owned(),
            sui_grpc_web: None,
        }
    }

    /// Starts a keyless configuration for one or more direct RPC endpoints.
    ///
    /// Construction succeeds before an override is attached so callers can
    /// build a configuration fluently. [`crate::ErpcClient::new`] rejects it
    /// when no valid direct endpoint is configured.
    #[must_use]
    pub fn for_rpc() -> Self {
        Self::new(String::new())
    }

    /// Returns the API key without placing it in debug output.
    #[must_use]
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Overrides the JSON-RPC and price endpoint.
    #[must_use]
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    /// Overrides the Avalanche endpoint.
    #[must_use]
    pub fn with_avalanche_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.avalanche_endpoint = endpoint.into();
        self
    }

    /// Overrides the account endpoint.
    #[must_use]
    pub fn with_account_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.account_endpoint = endpoint.into();
        self
    }

    /// Overrides the user endpoint.
    #[must_use]
    pub fn with_user_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.user_endpoint = endpoint.into();
        self
    }

    /// Adds an HTTP header after construction-time validation.
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Overrides the request timeout.
    #[must_use]
    pub const fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Selects a caller-owned Solana JSON-RPC endpoint.
    #[must_use]
    pub fn with_solana_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.solana_rpc = Some(endpoint.into());
        self
    }

    /// Selects a caller-owned Ethereum JSON-RPC endpoint.
    #[must_use]
    pub fn with_ethereum_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.ethereum_rpc = Some(endpoint.into());
        self
    }

    /// Selects a caller-owned Avalanche C-Chain JSON-RPC endpoint.
    #[must_use]
    pub fn with_avalanche_c_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.avalanche_c_rpc = Some(endpoint.into());
        self
    }

    /// Selects a caller-owned Avalanche C-Chain JSON-RPC endpoint.
    #[must_use]
    pub fn with_avalanche_rpc(self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.with_avalanche_c_rpc(endpoint)
    }

    /// Selects a caller-owned Bitcoin JSON-RPC endpoint.
    #[must_use]
    pub fn with_bitcoin_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.bitcoin_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Base JSON-RPC endpoint.
    #[must_use]
    pub fn with_base_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.base_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Base JSON-RPC endpoint.
    #[must_use]
    pub fn with_base_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.base_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Arbitrum One JSON-RPC endpoint.
    #[must_use]
    pub fn with_arbitrum_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.arbitrum_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Arbitrum One JSON-RPC endpoint.
    #[must_use]
    pub fn with_arbitrum_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.arbitrum_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Polygon `PoS` mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_polygon_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.polygon_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Polygon `PoS` mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_polygon_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.polygon_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted BNB Smart Chain mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_bsc_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.bsc_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned BNB Smart Chain mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_bsc_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.bsc_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted OP Mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_optimism_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.optimism_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned OP Mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_optimism_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.optimism_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Kaia mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_kaia_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.kaia_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Kaia mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_kaia_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.kaia_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Soneium mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_soneium_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.soneium_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Soneium mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_soneium_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.soneium_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Monad mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_monad_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.monad_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Monad mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_monad_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.monad_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Hyperliquid `HyperEVM` mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_hyperliquid_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.hyperliquid_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Hyperliquid `HyperEVM` mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_hyperliquid_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.hyperliquid_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Arc mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_arc_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.arc_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Arc mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_arc_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.arc_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Robinhood Chain Public Mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_robinhood_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.robinhood_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Robinhood Chain Public Mainnet JSON-RPC endpoint.
    #[must_use]
    pub fn with_robinhood_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.robinhood_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted NEAR endpoint.
    #[must_use]
    pub fn with_near_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.near_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned NEAR JSON-RPC endpoint.
    #[must_use]
    pub fn with_near_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.near_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted TRON endpoint.
    #[must_use]
    pub fn with_tron_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.tron_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned TRON JSON-RPC endpoint.
    #[must_use]
    pub fn with_tron_rpc(mut self, endpoint: impl Into<RpcEndpointConfig>) -> Self {
        self.tron_rpc = Some(endpoint.into());
        self
    }

    /// Overrides the hosted Sui binary gRPC-Web endpoint.
    #[must_use]
    pub fn with_sui_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.sui_endpoint = endpoint.into();
        self
    }

    /// Selects a caller-owned Sui binary gRPC-Web endpoint.
    #[must_use]
    pub fn with_sui_grpc_web(mut self, endpoint: impl Into<SuiGrpcWebEndpointConfig>) -> Self {
        self.sui_grpc_web = Some(endpoint.into());
        self
    }
}

pub(crate) struct ResolvedRpcEndpoint {
    pub http_url: Url,
    pub websocket_url: Option<Url>,
    pub headers: HeaderMap,
    pub redaction_secrets: Vec<String>,
}

pub(crate) struct ResolvedErpcClientConfig {
    pub api_key: Option<String>,
    pub endpoint: Url,
    pub avalanche_endpoint: Url,
    pub account_endpoint: Url,
    pub user_endpoint: Url,
    pub headers: HeaderMap,
    pub timeout: Duration,
    pub solana_rpc: Option<ResolvedRpcEndpoint>,
    pub ethereum_rpc: Option<ResolvedRpcEndpoint>,
    pub avalanche_c_rpc: Option<ResolvedRpcEndpoint>,
    pub bitcoin_rpc: Option<ResolvedRpcEndpoint>,
    pub base_endpoint: Url,
    pub base_rpc: Option<ResolvedRpcEndpoint>,
    pub arbitrum_endpoint: Url,
    pub arbitrum_rpc: Option<ResolvedRpcEndpoint>,
    pub polygon_endpoint: Url,
    pub polygon_rpc: Option<ResolvedRpcEndpoint>,
    pub bsc_endpoint: Url,
    pub bsc_rpc: Option<ResolvedRpcEndpoint>,
    pub optimism_endpoint: Url,
    pub optimism_rpc: Option<ResolvedRpcEndpoint>,
    pub kaia_endpoint: Url,
    pub kaia_rpc: Option<ResolvedRpcEndpoint>,
    pub soneium_endpoint: Url,
    pub soneium_rpc: Option<ResolvedRpcEndpoint>,
    pub monad_endpoint: Url,
    pub monad_rpc: Option<ResolvedRpcEndpoint>,
    pub hyperliquid_endpoint: Url,
    pub hyperliquid_rpc: Option<ResolvedRpcEndpoint>,
    pub arc_endpoint: Url,
    pub arc_rpc: Option<ResolvedRpcEndpoint>,
    pub robinhood_endpoint: Url,
    pub robinhood_rpc: Option<ResolvedRpcEndpoint>,
    pub near_endpoint: Url,
    pub near_rpc: Option<ResolvedRpcEndpoint>,
    pub tron_endpoint: Url,
    pub tron_rpc: Option<ResolvedRpcEndpoint>,
    pub sui_endpoint: Url,
    pub sui_grpc_web: Option<ResolvedSuiGrpcWebEndpoint>,
}

pub(crate) struct ResolvedSuiGrpcWebEndpoint {
    pub base_url: Url,
    pub headers: HeaderMap,
}

impl TryFrom<ErpcClientConfig> for ResolvedErpcClientConfig {
    type Error = ErpcError;

    #[allow(clippy::too_many_lines)]
    fn try_from(config: ErpcClientConfig) -> Result<Self> {
        let api_key = config.api_key.trim().to_owned();
        if api_key.is_empty()
            && config.solana_rpc.is_none()
            && config.ethereum_rpc.is_none()
            && config.avalanche_c_rpc.is_none()
            && config.bitcoin_rpc.is_none()
            && config.base_rpc.is_none()
            && config.arbitrum_rpc.is_none()
            && config.polygon_rpc.is_none()
            && config.bsc_rpc.is_none()
            && config.optimism_rpc.is_none()
            && config.kaia_rpc.is_none()
            && config.soneium_rpc.is_none()
            && config.monad_rpc.is_none()
            && config.hyperliquid_rpc.is_none()
            && config.arc_rpc.is_none()
            && config.robinhood_rpc.is_none()
            && config.near_rpc.is_none()
            && config.tron_rpc.is_none()
            && config.sui_grpc_web.is_none()
        {
            return Err(ErpcError::Config("api_key must not be empty".to_owned()));
        }
        if config.timeout.is_zero() {
            return Err(ErpcError::Config("timeout must be positive".to_owned()));
        }
        let headers = parse_headers(&config.headers)?;
        let solana_rpc = config
            .solana_rpc
            .as_ref()
            .map(resolve_rpc_endpoint)
            .transpose()?;
        let ethereum_rpc = config
            .ethereum_rpc
            .as_ref()
            .map(resolve_rpc_endpoint)
            .transpose()?;
        let avalanche_rpc = config
            .avalanche_c_rpc
            .as_ref()
            .map(resolve_rpc_endpoint)
            .transpose()?;
        let bitcoin_rpc = config
            .bitcoin_rpc
            .as_ref()
            .map(resolve_bitcoin_rpc_endpoint)
            .transpose()?;
        let base_rpc = config
            .base_rpc
            .as_ref()
            .map(resolve_base_rpc_endpoint)
            .transpose()?;
        let arbitrum_rpc = config
            .arbitrum_rpc
            .as_ref()
            .map(resolve_arbitrum_rpc_endpoint)
            .transpose()?;
        let polygon_rpc = config
            .polygon_rpc
            .as_ref()
            .map(resolve_polygon_rpc_endpoint)
            .transpose()?;
        let bsc_rpc = config
            .bsc_rpc
            .as_ref()
            .map(resolve_bsc_rpc_endpoint)
            .transpose()?;
        let optimism_rpc = config
            .optimism_rpc
            .as_ref()
            .map(resolve_optimism_rpc_endpoint)
            .transpose()?;
        let kaia_rpc = config
            .kaia_rpc
            .as_ref()
            .map(resolve_kaia_rpc_endpoint)
            .transpose()?;
        let soneium_rpc = config
            .soneium_rpc
            .as_ref()
            .map(resolve_soneium_rpc_endpoint)
            .transpose()?;
        let monad_rpc = config
            .monad_rpc
            .as_ref()
            .map(resolve_monad_rpc_endpoint)
            .transpose()?;
        let hyperliquid_rpc = config
            .hyperliquid_rpc
            .as_ref()
            .map(resolve_hyperliquid_rpc_endpoint)
            .transpose()?;
        let arc_rpc = config
            .arc_rpc
            .as_ref()
            .map(resolve_arc_rpc_endpoint)
            .transpose()?;
        let robinhood_rpc = config
            .robinhood_rpc
            .as_ref()
            .map(resolve_robinhood_rpc_endpoint)
            .transpose()?;
        let near_rpc = config
            .near_rpc
            .as_ref()
            .map(resolve_near_rpc_endpoint)
            .transpose()?;
        let tron_rpc = config
            .tron_rpc
            .as_ref()
            .map(resolve_tron_rpc_endpoint)
            .transpose()?;
        let sui_grpc_web = config
            .sui_grpc_web
            .as_ref()
            .map(resolve_sui_grpc_web_endpoint)
            .transpose()?;
        Ok(Self {
            api_key: (!api_key.is_empty()).then_some(api_key),
            endpoint: endpoint(&config.endpoint, false)?,
            avalanche_endpoint: endpoint(&config.avalanche_endpoint, false)?,
            account_endpoint: endpoint(&config.account_endpoint, false)?,
            user_endpoint: endpoint(&config.user_endpoint, false)?,
            headers,
            timeout: config.timeout,
            solana_rpc,
            ethereum_rpc,
            avalanche_c_rpc: avalanche_rpc,
            bitcoin_rpc,
            base_endpoint: endpoint(&config.base_endpoint, false)?,
            base_rpc,
            arbitrum_endpoint: endpoint(&config.arbitrum_endpoint, false)?,
            arbitrum_rpc,
            polygon_endpoint: endpoint(&config.polygon_endpoint, false)?,
            polygon_rpc,
            bsc_endpoint: endpoint(&config.bsc_endpoint, false)?,
            bsc_rpc,
            optimism_endpoint: endpoint(&config.optimism_endpoint, false)?,
            optimism_rpc,
            kaia_endpoint: endpoint(&config.kaia_endpoint, false)?,
            kaia_rpc,
            soneium_endpoint: endpoint(&config.soneium_endpoint, false)?,
            soneium_rpc,
            monad_endpoint: endpoint(&config.monad_endpoint, false)?,
            monad_rpc,
            hyperliquid_endpoint: endpoint(&config.hyperliquid_endpoint, false)?,
            hyperliquid_rpc,
            arc_endpoint: endpoint(&config.arc_endpoint, false)?,
            arc_rpc,
            robinhood_endpoint: endpoint(&config.robinhood_endpoint, false)?,
            robinhood_rpc,
            near_endpoint: endpoint(&config.near_endpoint, false)?,
            near_rpc,
            tron_endpoint: endpoint(&config.tron_endpoint, false)?,
            tron_rpc,
            sui_endpoint: resolve_sui_hosted_endpoint(&config.sui_endpoint)?,
            sui_grpc_web,
        })
    }
}

impl ResolvedErpcClientConfig {
    pub fn http_client() -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .build()
            .map_err(|_| ErpcError::Config("unable to create HTTP client".to_owned()))
    }

    pub fn direct_http_client() -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ErpcError::Config("unable to create direct HTTP client".to_owned()))
    }
}

pub(crate) fn endpoint(value: &str, local_http_only: bool) -> Result<Url> {
    let mut url = Url::parse(value)
        .map_err(|_| ErpcError::Config("endpoint must be an absolute HTTP(S) URL".to_owned()))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    let allowed =
        url.scheme() == "https" || (url.scheme() == "http" && (!local_http_only || local));
    if !allowed {
        let message = if local_http_only {
            "endpoint must use HTTPS except on localhost"
        } else {
            "endpoint must use HTTP or HTTPS"
        };
        return Err(ErpcError::Config(message.to_owned()));
    }
    url.set_query(None);
    url.set_fragment(None);
    let normalized = url.path().trim_end_matches('/').to_owned();
    url.set_path(if normalized.is_empty() {
        "/"
    } else {
        &normalized
    });
    Ok(url)
}

fn resolve_sui_hosted_endpoint(value: &str) -> Result<Url> {
    let parsed = Url::parse(value).map_err(|_| {
        ErpcError::Config("Sui hosted endpoint must be an absolute HTTP(S) URL".to_owned())
    })?;
    let authority_has_userinfo = value.trim().find("://").is_some_and(|scheme_end| {
        let authority = &value.trim()[scheme_end + 3..];
        let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
        authority[..authority_end].contains('@')
    });
    if authority_has_userinfo || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ErpcError::Config(
            "Sui hosted endpoint must not contain userinfo".to_owned(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(ErpcError::Config(
            "Sui hosted endpoint must not contain a fragment".to_owned(),
        ));
    }
    endpoint(value, false)
}

fn resolve_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    let http_url = direct_http_endpoint(&config.http_url)?;
    let websocket_url = config
        .websocket_url
        .as_deref()
        .map(direct_websocket_endpoint)
        .transpose()?;
    let headers = parse_headers(&config.headers)?;
    let mut redaction_secrets = redaction_secrets_for_raw_headers(&config.headers);
    collect_query_values(&http_url, &mut redaction_secrets);
    if let Some(websocket_url) = &websocket_url {
        collect_query_values(websocket_url, &mut redaction_secrets);
    }
    Ok(ResolvedRpcEndpoint {
        http_url,
        websocket_url,
        headers,
        redaction_secrets,
    })
}

fn resolve_bitcoin_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "bitcoin RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    resolve_rpc_endpoint(config)
}

fn resolve_base_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "base RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_arbitrum_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Arbitrum RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_polygon_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Polygon RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_bsc_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "BSC RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_optimism_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Optimism RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_kaia_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Kaia RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_soneium_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Soneium RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_monad_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Monad RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_hyperliquid_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Hyperliquid RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_arc_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Arc RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_robinhood_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "Robinhood RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_near_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "NEAR RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_tron_rpc_endpoint(config: &RpcEndpointConfig) -> Result<ResolvedRpcEndpoint> {
    if config.websocket_url.is_some() {
        return Err(ErpcError::Config(
            "TRON RPC is HTTP-only; websocket_url is not supported".to_owned(),
        ));
    }
    let mut endpoint = resolve_rpc_endpoint(config)?;
    collect_path_values(&endpoint.http_url, &mut endpoint.redaction_secrets);
    Ok(endpoint)
}

fn resolve_sui_grpc_web_endpoint(
    config: &SuiGrpcWebEndpointConfig,
) -> Result<ResolvedSuiGrpcWebEndpoint> {
    let base_url = direct_sui_endpoint(&config.base_url)?;
    let headers = parse_headers(&config.headers)?;
    Ok(ResolvedSuiGrpcWebEndpoint { base_url, headers })
}

fn parse_headers(values: &[(String, String)]) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = HeaderName::from_str(name)
            .map_err(|_| ErpcError::Config("header name is invalid".to_owned()))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| ErpcError::Config("header value is invalid".to_owned()))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn direct_http_endpoint(value: &str) -> Result<Url> {
    direct_endpoint(value, false)
        .map_err(|_| ErpcError::Config("rpc http_url must be an absolute HTTP(S) URL".to_owned()))
}

fn direct_sui_endpoint(value: &str) -> Result<Url> {
    direct_endpoint(value, false).map_err(|_| {
        ErpcError::Config("Sui gRPC-Web base_url must be an absolute HTTP(S) URL".to_owned())
    })
}

fn direct_websocket_endpoint(value: &str) -> Result<Url> {
    direct_endpoint(value, true).map_err(|_| {
        ErpcError::Config("rpc websocket_url must be an absolute WS(S) URL".to_owned())
    })
}

fn direct_endpoint(value: &str, websocket: bool) -> Result<Url> {
    let value = value.trim();
    let Some(scheme_end) = value.find("://") else {
        return Err(ErpcError::Config(
            "direct endpoint is missing an authority".to_owned(),
        ));
    };
    let authority = &value[scheme_end + 3..];
    let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    let authority = &authority[..authority_end];
    if authority.is_empty() || authority.contains('@') || value.contains('#') {
        return Err(ErpcError::Config(
            "direct endpoint authority is invalid".to_owned(),
        ));
    }
    let url = Url::parse(value)
        .map_err(|_| ErpcError::Config("direct endpoint is invalid".to_owned()))?;
    let allowed = if websocket {
        matches!(url.scheme(), "ws" | "wss")
    } else {
        matches!(url.scheme(), "http" | "https")
    };
    if !allowed || url.host_str().is_none() {
        return Err(ErpcError::Config(
            "direct endpoint scheme or authority is invalid".to_owned(),
        ));
    }
    Ok(url)
}

fn collect_query_values(url: &Url, secrets: &mut Vec<String>) {
    if let Some(query) = url.query() {
        for component in query.split('&') {
            let raw_value = component
                .split_once('=')
                .map_or(component, |(_, value)| value);
            if !raw_value.is_empty() && !secrets.contains(&raw_value.to_owned()) {
                secrets.push(raw_value.to_owned());
            }
        }
    }
    for (_, value) in url.query_pairs() {
        let value = value.into_owned();
        if !value.is_empty() && !secrets.contains(&value) {
            secrets.push(value);
        }
    }
}

fn collect_path_values(url: &Url, secrets: &mut Vec<String>) {
    for component in url
        .path()
        .split('/')
        .filter(|component| !component.is_empty())
    {
        if !secrets.contains(&component.to_owned()) {
            secrets.push(component.to_owned());
        }
        if let Ok(decoded) = percent_decode_str(component).decode_utf8() {
            let decoded = decoded.into_owned();
            if !decoded.is_empty() && !secrets.contains(&decoded) {
                secrets.push(decoded);
            }
        }
    }
}

pub(crate) fn redaction_secrets_for_headers(headers: &HeaderMap) -> Vec<String> {
    let mut secrets = Vec::new();
    for (name, value) in headers {
        let Ok(value) = value.to_str() else { continue };
        add_header_redaction_secrets(&mut secrets, name.as_str(), value);
    }
    secrets
}

fn redaction_secrets_for_raw_headers(headers: &[(String, String)]) -> Vec<String> {
    let mut secrets = Vec::new();
    for (name, value) in headers {
        add_header_redaction_secrets(&mut secrets, name, value);
    }
    secrets
}

fn add_header_redaction_secrets(secrets: &mut Vec<String>, name: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    for candidate in [
        value.to_owned(),
        format!("{name}: {value}"),
        format!("{name}:{value}"),
        format!("{name}={value}"),
    ] {
        if !secrets.contains(&candidate) {
            secrets.push(candidate);
        }
    }
    let mut parts = value.splitn(2, char::is_whitespace);
    let scheme = parts.next().unwrap_or_default();
    if !matches!(scheme.to_ascii_lowercase().as_str(), "bearer" | "basic") {
        return;
    }
    let Some(component) = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if !secrets.iter().any(|secret| secret == component) {
        secrets.push(component.to_owned());
    }
    if !scheme.eq_ignore_ascii_case("basic") {
        return;
    }
    let Some(decoded) = decode_base64(component).and_then(|bytes| String::from_utf8(bytes).ok())
    else {
        return;
    };
    if !secrets.iter().any(|secret| secret == &decoded) {
        secrets.push(decoded.clone());
    }
    if let Some((username, password)) = decoded.split_once(':') {
        for value in [username, password] {
            if !value.is_empty() && !secrets.iter().any(|secret| secret == value) {
                secrets.push(value.to_owned());
            }
        }
    }
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() {
        return None;
    }
    let mut output = Vec::new();
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    let mut padding = false;
    let mut padding_count = 0_usize;
    let mut data_count = 0_usize;
    for byte in value.bytes() {
        if byte == b'=' {
            padding = true;
            padding_count += 1;
            if padding_count > 2 {
                return None;
            }
            continue;
        }
        if padding {
            return None;
        }
        data_count += 1;
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(digit);
        bits += 6;
        while bits >= 8 {
            bits -= 8;
            let byte = (accumulator >> bits) & 0xff;
            output.push(u8::try_from(byte).ok()?);
            if bits == 0 {
                accumulator = 0;
            } else {
                accumulator &= (1_u32 << bits) - 1;
            }
        }
    }
    if data_count == 0 || data_count % 4 == 1 {
        return None;
    }
    if padding_count > 0
        && ((data_count + padding_count) % 4 != 0 || 4 - (data_count % 4) != padding_count)
    {
        return None;
    }
    if bits > 0 && accumulator & ((1_u32 << bits) - 1) != 0 {
        return None;
    }
    Some(output)
}

fn debug_endpoint(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return "[REDACTED]".to_owned();
    };
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string()
}

fn debug_origin(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return "[REDACTED]".to_owned();
    };
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string()
}

struct BaseRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for BaseRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BaseRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct ArbitrumRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for ArbitrumRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ArbitrumRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct PolygonRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for PolygonRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PolygonRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct BscRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for BscRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BscRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct OptimismRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for OptimismRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OptimismRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct KaiaRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for KaiaRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KaiaRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct SoneiumRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for SoneiumRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SoneiumRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct MonadRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for MonadRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MonadRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct HyperliquidRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for HyperliquidRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HyperliquidRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct ArcRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for ArcRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ArcRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct RobinhoodRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for RobinhoodRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RobinhoodRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct NearRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for NearRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NearRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

struct TronRpcDebug<'a>(&'a RpcEndpointConfig);

impl fmt::Debug for TronRpcDebug<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TronRpcEndpointConfig")
            .field("origin", &debug_origin(&self.0.http_url))
            .field("has_websocket_url", &self.0.websocket_url.is_some())
            .field(
                "header_names",
                &self
                    .0
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

pub(crate) fn endpoint_with_path(endpoint: &Url, path: &str) -> Url {
    let mut url = endpoint.clone();
    let base = endpoint.path().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    url.set_path(&format!("{base}/{path}"));
    url
}

pub(crate) fn websocket_url(endpoint: &Url, api_key: &str, path: &str) -> Result<Url> {
    let mut url = endpoint_with_path(endpoint, path);
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|()| ErpcError::Config("unable to create WebSocket URL".to_owned()))?;
    url.query_pairs_mut().append_pair("api-key", api_key);
    Ok(url)
}
