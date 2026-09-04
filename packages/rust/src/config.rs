use std::{fmt, str::FromStr, time::Duration};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use url::Url;

use crate::{ErpcError, Result};

/// Default JSON-RPC and price endpoint.
pub const DEFAULT_ENDPOINT: &str = "https://edge.erpc.global";
/// Default Avalanche C-Chain JSON-RPC endpoint.
pub const DEFAULT_AVALANCHE_ENDPOINT: &str = "https://ava-rpc.erpc.global";
/// Default account endpoint.
pub const DEFAULT_ACCOUNT_ENDPOINT: &str = "https://solana-rpc.erpc.global";
/// Default user and Cloud endpoint.
pub const DEFAULT_USER_ENDPOINT: &str = "https://user-api.erpc.global";
/// Default request and connection-establishment timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Configuration used to create an [`crate::ErpcClient`].
#[derive(Clone)]
pub struct ErpcClientConfig {
    /// ERPC API key. It is held in memory and omitted from debug output.
    api_key: String,
    /// Optional JSON-RPC and price endpoint override.
    pub endpoint: String,
    /// Optional Avalanche C-Chain endpoint override.
    pub avalanche_endpoint: String,
    /// Optional account endpoint override.
    pub account_endpoint: String,
    /// Optional user endpoint override.
    pub user_endpoint: String,
    /// Extra request headers.
    pub headers: Vec<(String, String)>,
    /// Request timeout.
    pub timeout: Duration,
}

impl fmt::Debug for ErpcClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ErpcClientConfig")
            .field("api_key", &"[REDACTED]")
            .field("endpoint", &self.endpoint)
            .field("avalanche_endpoint", &self.avalanche_endpoint)
            .field("account_endpoint", &self.account_endpoint)
            .field("user_endpoint", &self.user_endpoint)
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
        }
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

    /// Overrides the Avalanche C-Chain endpoint.
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
}

pub(crate) struct ResolvedErpcClientConfig {
    pub api_key: String,
    pub endpoint: Url,
    pub avalanche_endpoint: Url,
    pub account_endpoint: Url,
    pub user_endpoint: Url,
    pub headers: HeaderMap,
    pub timeout: Duration,
}

impl TryFrom<ErpcClientConfig> for ResolvedErpcClientConfig {
    type Error = ErpcError;

    fn try_from(config: ErpcClientConfig) -> Result<Self> {
        let api_key = config.api_key.trim().to_owned();
        if api_key.is_empty() {
            return Err(ErpcError::Config("api_key must not be empty".to_owned()));
        }
        if config.timeout.is_zero() {
            return Err(ErpcError::Config("timeout must be positive".to_owned()));
        }
        let mut headers = HeaderMap::new();
        for (name, value) in config.headers {
            let name = HeaderName::from_str(&name)
                .map_err(|_| ErpcError::Config("header name is invalid".to_owned()))?;
            let value = HeaderValue::from_str(&value)
                .map_err(|_| ErpcError::Config("header value is invalid".to_owned()))?;
            headers.insert(name, value);
        }
        Ok(Self {
            api_key,
            endpoint: endpoint(&config.endpoint, false)?,
            avalanche_endpoint: endpoint(&config.avalanche_endpoint, false)?,
            account_endpoint: endpoint(&config.account_endpoint, false)?,
            user_endpoint: endpoint(&config.user_endpoint, false)?,
            headers,
            timeout: config.timeout,
        })
    }
}

impl ResolvedErpcClientConfig {
    pub fn http_client() -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .build()
            .map_err(|_| ErpcError::Config("unable to create HTTP client".to_owned()))
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
