use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{ErpcError, Result, rest::RestTransport};

/// Usage for one method within a chain.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyApiKeyMethodUsage {
    /// Request count.
    pub count: f64,
    /// Credits charged per request.
    pub credit_cost: f64,
    /// Total credits charged.
    pub credits: f64,
    /// Wire-compatible RPC method.
    pub method: String,
    /// Last aggregation update.
    pub updated_at: Option<String>,
}

/// Monthly usage aggregated by chain.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyApiKeyChainUsage {
    /// Chain name.
    pub chain: String,
    /// Request count.
    pub count: f64,
    /// Total credits charged.
    pub credits: f64,
    /// Per-method usage.
    pub methods: Vec<MonthlyApiKeyMethodUsage>,
    /// Last aggregation update.
    pub updated_at: Option<String>,
}

/// Credential-safe usage for one API key.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyApiKeyUsageEntry {
    /// Last four characters only.
    pub api_key_last4: String,
    /// Total API key length.
    pub api_key_length: f64,
    /// Per-chain usage.
    pub chains: Vec<MonthlyApiKeyChainUsage>,
    /// Request count.
    pub count: f64,
    /// Total credits charged.
    pub credits: f64,
    /// Internal public key identifier when available.
    pub key_id: Option<f64>,
    /// Last aggregation update.
    pub updated_at: Option<String>,
}

/// Monthly API key usage response.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyApiKeyUsage {
    /// Usage grouped by API key.
    pub api_keys: Vec<MonthlyApiKeyUsageEntry>,
    /// Usage grouped by chain.
    pub chains: Vec<MonthlyApiKeyChainUsage>,
    /// Whether usage exists without a currently known key.
    pub has_stranded_usage: bool,
    /// Number of keys.
    pub key_count: f64,
    /// Total request count.
    pub total_count: f64,
    /// Total credits charged.
    pub total_credits: f64,
    /// Last aggregation update.
    pub updated_at: Option<String>,
    /// Calendar month in `YYYY-MM` form.
    pub year_month: String,
}

/// Parameters for monthly usage retrieval.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MonthlyApiKeyUsageParams {
    /// Calendar month in `YYYY-MM` form. Current month when omitted.
    pub year_month: Option<String>,
}

/// Monthly usage API.
#[derive(Clone)]
pub struct UsageClient {
    transport: RestTransport,
}

impl UsageClient {
    pub(crate) const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Gets monthly API key usage.
    pub async fn get_monthly_api_key_usage(
        &self,
        params: MonthlyApiKeyUsageParams,
    ) -> Result<MonthlyApiKeyUsage> {
        self.get_monthly_api_key_usage_with(params, None).await
    }

    /// Gets monthly API key usage with cancellation.
    pub async fn get_monthly_api_key_usage_with(
        &self,
        params: MonthlyApiKeyUsageParams,
        cancellation: Option<&CancellationToken>,
    ) -> Result<MonthlyApiKeyUsage> {
        if let Some(year_month) = &params.year_month {
            if !valid_year_month(year_month) {
                return Err(ErpcError::Config(
                    "year_month must use YYYY-MM format".to_owned(),
                ));
            }
        }
        let query = params
            .year_month
            .map(|value| vec![("yearMonth".to_owned(), value)])
            .unwrap_or_default();
        let envelope: Envelope<MonthlyApiKeyUsage> = self
            .transport
            .get("/v3/user/api-keys/usage", query, cancellation)
            .await?;
        if !envelope.success || !valid_year_month(&envelope.message.year_month) {
            return Err(ErpcError::InvalidResponse(
                "ERPC returned an invalid monthly API key usage response".to_owned(),
            ));
        }
        Ok(envelope.message)
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    message: T,
}

fn valid_year_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && matches!(
            &bytes[5..7],
            b"01"
                | b"02"
                | b"03"
                | b"04"
                | b"05"
                | b"06"
                | b"07"
                | b"08"
                | b"09"
                | b"10"
                | b"11"
                | b"12"
        )
}
