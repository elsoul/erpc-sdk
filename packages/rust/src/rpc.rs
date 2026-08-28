use std::{
    collections::{HashMap, HashSet},
    marker::PhantomData,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use reqwest::{Client, header::HeaderMap};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ErpcError, JsonRpcErrorObject, Result,
    error::{invalid_response, rpc_error, timeout},
};

/// JSON-RPC request or response identifier.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    /// Numeric identifier used by the built-in transports.
    Number(u64),
    /// String identifier accepted from compatible servers.
    String(String),
}

/// One call in an unsplit JSON-RPC batch.
#[derive(Clone, Debug, Serialize)]
pub struct RpcBatchCall {
    /// Wire-compatible JSON-RPC method name.
    pub method: String,
    /// Positional array or named object parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl RpcBatchCall {
    /// Creates a call and serializes its parameters.
    pub fn new(method: impl Into<String>, params: impl Serialize) -> Result<Self> {
        Ok(Self {
            method: method.into(),
            params: Some(serde_json::to_value(params).map_err(|_| {
                ErpcError::Config("RPC parameters could not be serialized".to_owned())
            })?),
        })
    }

    /// Creates a parameterless call.
    #[must_use]
    pub fn without_params(method: impl Into<String>) -> Self {
        Self {
            method: method.into(),
            params: None,
        }
    }
}

/// Per-request cancellation options.
#[derive(Clone, Debug, Default)]
pub struct RequestOptions {
    /// Cancellation token observed while connecting and awaiting a response.
    pub cancellation: Option<CancellationToken>,
}

/// Configuration for the HTTP JSON-RPC transport.
#[derive(Clone)]
pub struct HttpTransportConfig {
    /// ERPC API key.
    pub api_key: String,
    /// HTTP endpoint, without the API key query parameter.
    pub endpoint: Url,
    /// Extra request headers.
    pub headers: HeaderMap,
    /// Maximum accepted caller batch size.
    pub max_batch_size: usize,
    /// Request timeout.
    pub timeout: Duration,
    /// Configured HTTP client.
    pub client: Client,
}

/// Credential-safe HTTP JSON-RPC transport.
pub struct HttpJsonRpcTransport {
    api_key: String,
    endpoint: Url,
    headers: HeaderMap,
    max_batch_size: usize,
    timeout: Duration,
    client: Client,
    next_id: AtomicU64,
}

impl HttpJsonRpcTransport {
    /// Creates a transport. Prefer [`crate::ErpcClient`] for normal use.
    #[must_use]
    pub fn new(config: HttpTransportConfig) -> Self {
        let mut endpoint = config.endpoint;
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        Self {
            api_key: config.api_key,
            endpoint,
            headers: config.headers,
            max_batch_size: config.max_batch_size,
            timeout: config.timeout,
            client: config.client,
            next_id: AtomicU64::new(1),
        }
    }

    /// Public endpoint without credentials, query, or fragment.
    #[must_use]
    pub fn endpoint(&self) -> String {
        self.endpoint.to_string()
    }

    /// Maximum number of calls in one server batch.
    #[must_use]
    pub const fn max_batch_size(&self) -> usize {
        self.max_batch_size
    }

    /// Sends one JSON-RPC request.
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Option<Value>,
        options: &RequestOptions,
    ) -> Result<T> {
        let id = self.id();
        let request = WireRequest {
            jsonrpc: "2.0",
            id: id.clone(),
            method,
            params,
        };
        let response = self.post(&request, options).await?;
        self.unwrap(&response, &id)
    }

    /// Sends one intact JSON-RPC batch and returns results in caller order.
    pub async fn batch(
        &self,
        calls: &[RpcBatchCall],
        options: &RequestOptions,
    ) -> Result<Vec<Value>> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        if calls.len() > self.max_batch_size {
            return Err(invalid_response(format!(
                "A batch may contain at most {} calls",
                self.max_batch_size
            )));
        }
        let requests: Vec<_> = calls
            .iter()
            .map(|call| WireRequest {
                jsonrpc: "2.0",
                id: self.id(),
                method: call.method.as_str(),
                params: call.params.clone(),
            })
            .collect();
        let response = self.post(&requests, options).await?;
        let Value::Array(responses) = response else {
            if let Ok(failure) = serde_json::from_value::<WireFailure>(response) {
                return Err(rpc_error(failure.error, &self.api_key));
            }
            return Err(invalid_response("ERPC returned a non-array batch response"));
        };
        let mut by_id = HashMap::new();
        for response in responses {
            let id = response
                .get("id")
                .cloned()
                .ok_or_else(|| invalid_response("ERPC returned an invalid batch item"))?;
            let id: JsonRpcId = serde_json::from_value(id)
                .map_err(|_| invalid_response("ERPC returned an invalid batch id"))?;
            if by_id.insert(id, response).is_some() {
                return Err(invalid_response("ERPC returned a duplicate batch id"));
            }
        }
        requests
            .iter()
            .map(|request| {
                let response = by_id.remove(&request.id).ok_or_else(|| {
                    invalid_response(format!("ERPC omitted batch response id {}", request.id))
                })?;
                self.unwrap(&response, &request.id)
            })
            .collect()
    }

    fn id(&self) -> JsonRpcId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if id == u64::MAX {
            self.next_id.store(1, Ordering::Relaxed);
        }
        JsonRpcId::Number(id)
    }

    async fn post(&self, body: &impl Serialize, options: &RequestOptions) -> Result<Value> {
        let mut url = self.endpoint.clone();
        url.query_pairs_mut().append_pair("api-key", &self.api_key);
        let request = self
            .client
            .post(url)
            .headers(self.headers.clone())
            .json(body)
            .send();
        let result = if let Some(cancellation) = &options.cancellation {
            tokio::select! {
                () = cancellation.cancelled() => return Err(ErpcError::Aborted),
                result = tokio::time::timeout(self.timeout, request) => result,
            }
        } else {
            tokio::time::timeout(self.timeout, request).await
        };
        let response = result
            .map_err(|_| timeout(self.timeout))?
            .map_err(|_| ErpcError::Transport("Unable to reach ERPC".to_owned()))?;
        if !response.status().is_success() {
            return Err(ErpcError::Http {
                status: response.status().as_u16(),
            });
        }
        let text = response
            .text()
            .await
            .map_err(|_| ErpcError::Transport("Unable to read ERPC response".to_owned()))?;
        serde_json::from_str(&text).map_err(|_| invalid_response("ERPC returned malformed JSON"))
    }

    fn unwrap<T: DeserializeOwned>(&self, response: &Value, expected: &JsonRpcId) -> Result<T> {
        let object = response
            .as_object()
            .ok_or_else(|| invalid_response("ERPC returned an invalid response"))?;
        let id: JsonRpcId = serde_json::from_value(
            object
                .get("id")
                .cloned()
                .ok_or_else(|| invalid_response("ERPC returned an invalid response"))?,
        )
        .map_err(|_| invalid_response("ERPC returned an invalid response id"))?;
        if &id != expected {
            return Err(invalid_response("ERPC returned an unexpected response id"));
        }
        if let Some(error) = object.get("error") {
            let error: JsonRpcErrorObject = serde_json::from_value(error.clone())
                .map_err(|_| invalid_response("ERPC returned an invalid RPC error"))?;
            return Err(rpc_error(error, &self.api_key));
        }
        let result = object
            .get("result")
            .cloned()
            .ok_or_else(|| invalid_response("ERPC returned an invalid response"))?;
        serde_json::from_value(result)
            .map_err(|_| invalid_response("ERPC returned an unexpected result shape"))
    }
}

impl std::fmt::Display for JsonRpcId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(id) => id.fmt(formatter),
            Self::String(id) => id.fmt(formatter),
        }
    }
}

#[derive(Serialize)]
struct WireRequest<'a> {
    jsonrpc: &'static str,
    id: JsonRpcId,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct WireFailure {
    error: JsonRpcErrorObject,
}

/// An inert typed request. Network I/O begins only when `send` is awaited.
pub struct PendingRpcRequest<T> {
    transport: Arc<HttpJsonRpcTransport>,
    method: String,
    params: Option<Value>,
    marker: PhantomData<fn() -> T>,
}

impl<T: DeserializeOwned> PendingRpcRequest<T> {
    /// Sends with default options.
    pub async fn send(self) -> Result<T> {
        self.send_with(RequestOptions::default()).await
    }

    /// Sends with cancellation options.
    pub async fn send_with(self, options: RequestOptions) -> Result<T> {
        self.transport
            .request(&self.method, self.params, &options)
            .await
    }
}

/// An inert batch request that preserves one caller batch on the wire.
pub struct PendingRpcBatchRequest {
    transport: Arc<HttpJsonRpcTransport>,
    calls: Vec<RpcBatchCall>,
}

impl PendingRpcBatchRequest {
    /// Sends with default options.
    pub async fn send(self) -> Result<Vec<Value>> {
        self.send_with(RequestOptions::default()).await
    }

    /// Sends with cancellation options.
    pub async fn send_with(self, options: RequestOptions) -> Result<Vec<Value>> {
        self.transport.batch(&self.calls, &options).await
    }
}

#[derive(Clone, Copy)]
pub(crate) enum BatchPolicy {
    Any,
    SolanaStandard,
    Unsupported,
}

/// Typed request builder over one JSON-RPC endpoint and parameter mode.
#[derive(Clone)]
pub struct RpcNamespace {
    transport: Arc<HttpJsonRpcTransport>,
    policy: BatchPolicy,
}

impl RpcNamespace {
    pub(crate) const fn new(transport: Arc<HttpJsonRpcTransport>, policy: BatchPolicy) -> Self {
        Self { transport, policy }
    }

    /// Public endpoint without credentials.
    #[must_use]
    pub fn endpoint(&self) -> String {
        self.transport.endpoint()
    }

    /// Creates a typed request using wire-compatible method and parameters.
    pub fn request<T: DeserializeOwned>(
        &self,
        method: impl Into<String>,
        params: impl Serialize,
    ) -> Result<PendingRpcRequest<T>> {
        Ok(PendingRpcRequest {
            transport: Arc::clone(&self.transport),
            method: method.into(),
            params: Some(serde_json::to_value(params).map_err(|_| {
                ErpcError::Config("RPC parameters could not be serialized".to_owned())
            })?),
            marker: PhantomData,
        })
    }

    /// Creates a typed parameterless request.
    #[must_use]
    pub fn request_without_params<T: DeserializeOwned>(
        &self,
        method: impl Into<String>,
    ) -> PendingRpcRequest<T> {
        PendingRpcRequest {
            transport: Arc::clone(&self.transport),
            method: method.into(),
            params: None,
            marker: PhantomData,
        }
    }

    /// Alias for arbitrary methods not yet represented by a convenience method.
    pub fn raw<T: DeserializeOwned>(
        &self,
        method: impl Into<String>,
        params: Option<Value>,
    ) -> PendingRpcRequest<T> {
        PendingRpcRequest {
            transport: Arc::clone(&self.transport),
            method: method.into(),
            params,
            marker: PhantomData,
        }
    }

    /// Validates and creates one unsplit batch request.
    pub fn batch(&self, calls: Vec<RpcBatchCall>) -> Result<PendingRpcBatchRequest> {
        if matches!(self.policy, BatchPolicy::Unsupported) {
            if !calls.is_empty() {
                return Err(ErpcError::BatchPolicy(
                    "Leader RPC methods do not support batching".to_owned(),
                ));
            }
        } else if matches!(self.policy, BatchPolicy::SolanaStandard) {
            validate_solana_standard_batch(&calls)?;
        }
        Ok(PendingRpcBatchRequest {
            transport: Arc::clone(&self.transport),
            calls,
        })
    }
}

fn validate_solana_standard_batch(calls: &[RpcBatchCall]) -> Result<()> {
    let heavy: HashSet<&str> = [
        "getPriorityFeeEstimate",
        "getProgramAccounts",
        "getProgramAccountsV2",
        "getTokenLargestAccounts",
    ]
    .into_iter()
    .collect();
    let contains_heavy = calls
        .iter()
        .any(|call| heavy.contains(call.method.as_str()));
    let contains_standard = calls
        .iter()
        .any(|call| !heavy.contains(call.method.as_str()));
    if contains_heavy && contains_standard {
        return Err(ErpcError::BatchPolicy(
            "Solana indexed and standard RPC methods cannot share a batch".to_owned(),
        ));
    }
    Ok(())
}
