use std::{
    collections::{HashMap, HashSet},
    marker::PhantomData,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    ErpcError, JsonRpcErrorObject, Result,
    config::redaction_secrets_for_headers,
    error::{invalid_response, rpc_error_with_secrets, timeout},
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
    api_key: Option<String>,
    endpoint: Url,
    headers: HeaderMap,
    redaction_secrets: Vec<String>,
    max_batch_size: usize,
    timeout: Duration,
    client: Client,
    next_id: AtomicU64,
    configured: bool,
    namespace: String,
    response_policy: ResponsePolicy,
    api_key_query: bool,
}

#[derive(Clone, Copy)]
enum ResponsePolicy {
    Strict,
    Bitcoin,
}

impl HttpJsonRpcTransport {
    /// Creates a transport. Prefer [`crate::ErpcClient`] for normal use.
    #[must_use]
    pub fn new(config: HttpTransportConfig) -> Self {
        let mut endpoint = config.endpoint;
        let api_key = (!config.api_key.is_empty()).then_some(config.api_key);
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        let mut redaction_secrets = Vec::new();
        if let Some(api_key) = &api_key {
            redaction_secrets.push(api_key.clone());
        }
        Self::from_parts(
            api_key,
            endpoint,
            config.headers,
            redaction_secrets,
            config.max_batch_size,
            config.timeout,
            config.client,
            "RPC",
            true,
            ResponsePolicy::Strict,
            true,
        )
    }

    pub(crate) fn new_direct(
        endpoint: Url,
        headers: HeaderMap,
        redaction_secrets: Vec<String>,
        max_batch_size: usize,
        timeout: Duration,
        client: Client,
        namespace: impl Into<String>,
    ) -> Self {
        let redaction_secrets = merge_secrets(redaction_secrets, &headers);
        Self::from_parts(
            None,
            endpoint,
            headers,
            redaction_secrets,
            max_batch_size,
            timeout,
            client,
            namespace,
            true,
            ResponsePolicy::Strict,
            false,
        )
    }

    pub(crate) fn new_direct_bitcoin(
        endpoint: Url,
        headers: HeaderMap,
        redaction_secrets: Vec<String>,
        timeout: Duration,
        client: Client,
        namespace: impl Into<String>,
    ) -> Self {
        let redaction_secrets = merge_secrets(redaction_secrets, &headers);
        Self::from_parts(
            None,
            endpoint,
            headers,
            redaction_secrets,
            100,
            timeout,
            client,
            namespace,
            true,
            ResponsePolicy::Bitcoin,
            false,
        )
    }

    pub(crate) fn new_bitcoin(
        api_key: String,
        endpoint: Url,
        mut headers: HeaderMap,
        timeout: Duration,
        client: Client,
    ) -> Result<Self> {
        let bearer = format!("Bearer {api_key}");
        let bearer = HeaderValue::from_str(&bearer)
            .map_err(|_| ErpcError::Config("invalid Bitcoin authorization header".to_owned()))?;
        headers.remove(AUTHORIZATION);
        headers.insert(AUTHORIZATION, bearer);
        let mut redaction_secrets = vec![api_key.clone()];
        redaction_secrets = merge_secrets(redaction_secrets, &headers);
        Ok(Self::from_parts(
            Some(api_key),
            endpoint,
            headers,
            redaction_secrets,
            100,
            timeout,
            client,
            "bitcoin.rpc",
            true,
            ResponsePolicy::Bitcoin,
            false,
        ))
    }

    pub(crate) fn unavailable(
        namespace: impl Into<String>,
        timeout: Duration,
        client: Client,
    ) -> Self {
        let endpoint = Url::parse("http://127.0.0.1/").expect("static unavailable endpoint");
        Self::from_parts(
            None,
            endpoint,
            HeaderMap::new(),
            Vec::new(),
            256,
            timeout,
            client,
            namespace,
            false,
            ResponsePolicy::Strict,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn from_parts(
        api_key: Option<String>,
        endpoint: Url,
        headers: HeaderMap,
        redaction_secrets: Vec<String>,
        max_batch_size: usize,
        timeout: Duration,
        client: Client,
        namespace: impl Into<String>,
        configured: bool,
        response_policy: ResponsePolicy,
        api_key_query: bool,
    ) -> Self {
        Self {
            api_key,
            endpoint,
            headers,
            redaction_secrets,
            max_batch_size,
            timeout,
            client,
            next_id: AtomicU64::new(1),
            configured,
            namespace: namespace.into(),
            response_policy,
            api_key_query,
        }
    }

    /// Public endpoint without credentials, query, or fragment.
    #[must_use]
    pub fn endpoint(&self) -> String {
        if self.configured {
            let mut endpoint = self.endpoint.clone();
            endpoint.set_query(None);
            endpoint.set_fragment(None);
            endpoint.to_string()
        } else {
            String::new()
        }
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
        self.ensure_configured()?;
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
        self.ensure_configured()?;
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
                return Err(rpc_error_with_secrets(
                    failure.error,
                    &self.redaction_secrets,
                ));
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
        let results = requests
            .iter()
            .map(|request| {
                let response = by_id.remove(&request.id).ok_or_else(|| {
                    invalid_response(format!("ERPC omitted batch response id {}", request.id))
                })?;
                self.unwrap(&response, &request.id)
            })
            .collect::<Result<Vec<_>>>()?;
        if !by_id.is_empty() {
            return Err(invalid_response(
                "ERPC returned an unexpected batch response id",
            ));
        }
        Ok(results)
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
        if self.api_key_query {
            if let Some(api_key) = &self.api_key {
                url.query_pairs_mut().append_pair("api-key", api_key);
            }
        }
        let operation = async {
            let response = self
                .client
                .post(url)
                .headers(self.headers.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(body)
                .send()
                .await
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
            parse_json_response(&text)
        };
        let timed = tokio::time::timeout(self.timeout, operation);
        let result = if let Some(cancellation) = &options.cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(ErpcError::Aborted),
                result = timed => result,
            }
        } else {
            timed.await
        };
        result.map_err(|_| timeout(self.timeout))?
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
            if !matches!(self.response_policy, ResponsePolicy::Bitcoin) || !error.is_null() {
                let error: JsonRpcErrorObject = serde_json::from_value(error.clone())
                    .map_err(|_| invalid_response("ERPC returned an invalid RPC error"))?;
                return Err(rpc_error_with_secrets(error, &self.redaction_secrets));
            }
        }
        let result = object
            .get("result")
            .cloned()
            .ok_or_else(|| invalid_response("ERPC returned an invalid response"))?;
        decode_result(result)
            .map_err(|()| invalid_response("ERPC returned an unexpected result shape"))
    }

    pub(crate) fn ensure_configured(&self) -> Result<()> {
        if self.configured {
            Ok(())
        } else {
            Err(ErpcError::NotConfigured(self.namespace.clone()))
        }
    }
}

fn merge_secrets(mut secrets: Vec<String>, headers: &HeaderMap) -> Vec<String> {
    for secret in redaction_secrets_for_headers(headers) {
        if !secrets.contains(&secret) {
            secrets.push(secret);
        }
    }
    secrets
}

const PRESERVED_NUMBER_MARKER: &str = "__erpc_sdk_number__";

fn parse_json_response(text: &str) -> Result<Value> {
    serde_json::from_str::<Value>(text)
        .map_err(|_| invalid_response("ERPC returned malformed JSON"))?;
    let protected = protect_json_numbers(text);
    let value = serde_json::from_str::<Value>(&protected)
        .map_err(|_| invalid_response("ERPC returned malformed JSON"))?;
    restore_json_numbers(value)
}

fn protect_json_numbers(text: &str) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    let mut protected = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if in_string {
            protected.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            protected.push(character);
            index += 1;
            continue;
        }
        if character == '-' || character.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < characters.len() && is_json_number_character(characters[index]) {
                index += 1;
            }
            let number = characters[start..index].iter().collect::<String>();
            protected.push_str("{\"");
            protected.push_str(PRESERVED_NUMBER_MARKER);
            protected.push_str("\":\"");
            protected.push_str(&number);
            protected.push_str("\"}");
            continue;
        }
        protected.push(character);
        index += 1;
    }
    protected
}

fn is_json_number_character(character: char) -> bool {
    character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-')
}

fn restore_json_numbers(value: Value) -> Result<Value> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .map(restore_json_numbers)
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(mut object) => {
            if object.len() == 1 {
                if let Some(Value::String(number)) = object.get(PRESERVED_NUMBER_MARKER) {
                    return Ok(Value::Number(serde_json::Number::from_string_unchecked(
                        number.clone(),
                    )));
                }
            }
            for value in object.values_mut() {
                *value = restore_json_numbers(std::mem::take(value))?;
            }
            Ok(Value::Object(object))
        }
        value => Ok(value),
    }
}

fn decode_result<T: DeserializeOwned>(value: Value) -> std::result::Result<T, ()> {
    let type_name = std::any::type_name::<T>();
    if type_name == "serde_json::value::Value"
        || type_name == "core::option::Option<serde_json::value::Value>"
    {
        return serde_json::from_value(mark_numbers_for_deserialize(value)).map_err(|_| ());
    }
    serde_json::from_value(value).map_err(|_| ())
}

fn mark_numbers_for_deserialize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(mark_numbers_for_deserialize)
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, mark_numbers_for_deserialize(value)))
                .collect(),
        ),
        Value::Number(number) => Value::Object(
            [(
                "$serde_json::private::Number".to_owned(),
                Value::String(number.as_str().to_owned()),
            )]
            .into_iter()
            .collect(),
        ),
        value => value,
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
        self.transport.ensure_configured()?;
        if matches!(self.policy, BatchPolicy::Unsupported) {
            if !calls.is_empty() {
                return Err(ErpcError::BatchPolicy(
                    "This RPC namespace does not support batching".to_owned(),
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
