use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Result type returned by this crate.
pub type Result<T> = std::result::Result<T, ErpcError>;

/// Stable category for an SDK error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErpcErrorCode {
    /// A caller-provided cancellation token was cancelled.
    Aborted,
    /// A locally enforced batch policy was violated.
    BatchPolicy,
    /// Client configuration was invalid.
    Config,
    /// A requested service has no configured transport.
    NotConfigured,
    /// An HTTP response had a non-success status.
    Http,
    /// A response did not satisfy the ERPC contract.
    InvalidResponse,
    /// A JSON-RPC error response was returned.
    Rpc,
    /// A request exceeded its timeout.
    Timeout,
    /// A transport could not reach ERPC.
    Transport,
}

/// Wire representation of a JSON-RPC error object.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct JsonRpcErrorObject {
    /// Numeric JSON-RPC error code.
    pub code: i64,
    /// Public error message, with the configured credential redacted.
    pub message: String,
    /// Optional structured error data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// All errors produced by the SDK.
#[derive(Debug, thiserror::Error)]
pub enum ErpcError {
    /// A caller cancelled the request.
    #[error("ERPC request was aborted")]
    Aborted,
    /// A batch violates a server boundary that must remain intact.
    #[error("{0}")]
    BatchPolicy(String),
    /// Invalid client configuration.
    #[error("{0}")]
    Config(String),
    /// A requested namespace has no configured transport.
    #[error("ERPC namespace '{0}' is not configured")]
    NotConfigured(String),
    /// Non-success HTTP response.
    #[error("ERPC request failed with HTTP {status}")]
    Http {
        /// HTTP status code.
        status: u16,
    },
    /// Malformed or contract-incompatible response.
    #[error("{0}")]
    InvalidResponse(String),
    /// JSON-RPC error returned by ERPC.
    #[error("{message}")]
    JsonRpc {
        /// Numeric JSON-RPC error code.
        code: i64,
        /// Redacted server message.
        message: String,
        /// Redacted optional server data.
        data: Option<Value>,
    },
    /// Request timeout.
    #[error("ERPC request timed out after {timeout_ms}ms")]
    Timeout {
        /// Configured timeout in milliseconds.
        timeout_ms: u64,
    },
    /// Sanitized network or WebSocket failure.
    #[error("{0}")]
    Transport(String),
}

impl ErpcError {
    /// Returns a stable error category.
    #[must_use]
    pub const fn code(&self) -> ErpcErrorCode {
        match self {
            Self::Aborted => ErpcErrorCode::Aborted,
            Self::BatchPolicy(_) => ErpcErrorCode::BatchPolicy,
            Self::Config(_) => ErpcErrorCode::Config,
            Self::NotConfigured(_) => ErpcErrorCode::NotConfigured,
            Self::Http { .. } => ErpcErrorCode::Http,
            Self::InvalidResponse(_) => ErpcErrorCode::InvalidResponse,
            Self::JsonRpc { .. } => ErpcErrorCode::Rpc,
            Self::Timeout { .. } => ErpcErrorCode::Timeout,
            Self::Transport(_) => ErpcErrorCode::Transport,
        }
    }
}

pub(crate) fn invalid_response(message: impl Into<String>) -> ErpcError {
    ErpcError::InvalidResponse(message.into())
}

pub(crate) fn timeout(duration: std::time::Duration) -> ErpcError {
    let millis = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
    ErpcError::Timeout { timeout_ms: millis }
}

fn encoded_variants(credential: &str) -> Vec<String> {
    if credential.is_empty() {
        return Vec::new();
    }
    let mut values = vec![credential.to_owned()];
    let query_encoded: String =
        url::form_urlencoded::byte_serialize(credential.as_bytes()).collect();
    let component_encoded = credential
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
                char::from(*byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    for encoded in [query_encoded, component_encoded] {
        if !encoded.is_empty() && !values.contains(&encoded) {
            values.push(encoded);
        }
    }
    values.sort_by_key(|right| std::cmp::Reverse(right.len()));
    values
}

fn redaction_variants(secrets: &[String]) -> Vec<String> {
    let mut variants = secrets
        .iter()
        .flat_map(|secret| encoded_variants(secret))
        .collect::<Vec<_>>();
    variants.sort_by_key(|value| std::cmp::Reverse(value.len()));
    variants.dedup();
    variants
}

fn redact_text_with_variants(value: &str, variants: &[String]) -> String {
    variants.iter().fold(value.to_owned(), |result, variant| {
        let result = result.replace(variant, "[REDACTED]");
        if has_percent_escape(variant) {
            redact_percent_escape_case_insensitive(&result, variant)
        } else {
            result
        }
    })
}

fn has_percent_escape(value: &str) -> bool {
    value.as_bytes().windows(3).any(is_percent_escape)
}

fn is_percent_escape(bytes: &[u8]) -> bool {
    bytes.len() == 3
        && bytes[0] == b'%'
        && bytes[1].is_ascii_hexdigit()
        && bytes[2].is_ascii_hexdigit()
}

fn redact_percent_escape_case_insensitive(value: &str, pattern: &str) -> String {
    let value_bytes = value.as_bytes();
    let pattern_bytes = pattern.as_bytes();
    if !pattern.is_ascii() || pattern_bytes.len() > value_bytes.len() {
        return value.to_owned();
    }
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor + pattern_bytes.len() <= value_bytes.len() {
        let Some(relative) = value_bytes[cursor..]
            .windows(pattern_bytes.len())
            .position(|candidate| percent_escape_pattern_matches(candidate, pattern_bytes))
        else {
            break;
        };
        let start = cursor + relative;
        let end = start + pattern_bytes.len();
        result.push_str(&value[cursor..start]);
        result.push_str("[REDACTED]");
        cursor = end;
    }
    if result.is_empty() {
        return value.to_owned();
    }
    result.push_str(&value[cursor..]);
    result
}

fn percent_escape_pattern_matches(candidate: &[u8], pattern: &[u8]) -> bool {
    let mut index = 0;
    while index < pattern.len() {
        if index + 2 < pattern.len()
            && pattern[index] == b'%'
            && pattern[index + 1].is_ascii_hexdigit()
            && pattern[index + 2].is_ascii_hexdigit()
        {
            if candidate[index] != b'%'
                || !candidate[index + 1].eq_ignore_ascii_case(&pattern[index + 1])
                || !candidate[index + 2].eq_ignore_ascii_case(&pattern[index + 2])
            {
                return false;
            }
            index += 3;
        } else {
            if candidate[index] != pattern[index] {
                return false;
            }
            index += 1;
        }
    }
    true
}

fn redact_value_with_variants(value: Value, variants: &[String], depth: usize) -> Value {
    if depth >= 32 {
        return Value::String("[REDACTED]".to_owned());
    }
    match value {
        Value::String(value) => Value::String(redact_text_with_variants(&value, variants)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_value_with_variants(value, variants, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    (
                        redact_text_with_variants(&key, variants),
                        redact_value_with_variants(value, variants, depth + 1),
                    )
                })
                .collect(),
        ),
        other => other,
    }
}

pub(crate) fn rpc_error_with_secrets(error: JsonRpcErrorObject, secrets: &[String]) -> ErpcError {
    let variants = redaction_variants(secrets);
    ErpcError::JsonRpc {
        code: error.code,
        message: redact_text_with_variants(&error.message, &variants),
        data: error
            .data
            .map(|value| redact_value_with_variants(value, &variants, 0)),
    }
}

impl fmt::Display for ErpcErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::Aborted => "ERPC_ABORTED",
            Self::BatchPolicy => "ERPC_BATCH_POLICY",
            Self::Config => "ERPC_CONFIG",
            Self::NotConfigured => "ERPC_NOT_CONFIGURED",
            Self::Http => "ERPC_HTTP",
            Self::InvalidResponse => "ERPC_INVALID_RESPONSE",
            Self::Rpc => "ERPC_RPC",
            Self::Timeout => "ERPC_TIMEOUT",
            Self::Transport => "ERPC_TRANSPORT",
        };
        formatter.write_str(code)
    }
}
