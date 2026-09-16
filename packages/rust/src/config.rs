use std::{fmt, str::FromStr, time::Duration};

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
}

impl TryFrom<ErpcClientConfig> for ResolvedErpcClientConfig {
    type Error = ErpcError;

    fn try_from(config: ErpcClientConfig) -> Result<Self> {
        let api_key = config.api_key.trim().to_owned();
        if api_key.is_empty()
            && config.solana_rpc.is_none()
            && config.ethereum_rpc.is_none()
            && config.avalanche_c_rpc.is_none()
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
