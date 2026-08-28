use std::{collections::HashMap, fmt, time::Duration};

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{
    DEFAULT_TIMEOUT, DEFAULT_USER_ENDPOINT, ErpcError, Result, config::endpoint,
    rest::RestTransport, usage::UsageClient,
};

/// Configuration for an authenticated ERPC Cloud client.
#[derive(Clone)]
pub struct ErpcCloudClientConfig {
    access_token: String,
    /// Cloud API endpoint.
    pub endpoint: String,
    /// Extra request headers.
    pub headers: Vec<(String, String)>,
    /// Request timeout.
    pub timeout: Duration,
}

impl ErpcCloudClientConfig {
    /// Creates a configuration with the production endpoint.
    #[must_use]
    pub fn new(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            endpoint: DEFAULT_USER_ENDPOINT.to_owned(),
            headers: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// Overrides the Cloud API endpoint.
    #[must_use]
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    /// Adds a request header.
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

impl fmt::Debug for ErpcCloudClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ErpcCloudClientConfig")
            .field("access_token", &"[REDACTED]")
            .field("endpoint", &self.endpoint)
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

/// Authenticated Cloud catalog, credit, resources, and usage APIs.
#[derive(Clone)]
pub struct ErpcCloudClient {
    /// Available resource offerings.
    pub catalog: CloudCatalogClient,
    /// Credit and burn-rate snapshot.
    pub credit: CloudCreditClient,
    /// Provisioned resource inventory and status.
    pub resources: CloudResourcesClient,
    /// Monthly API key usage.
    pub usage: UsageClient,
}

impl ErpcCloudClient {
    /// Creates a Cloud client after validating its access token and endpoint.
    pub fn new(config: ErpcCloudClientConfig) -> Result<Self> {
        let access_token = config.access_token.trim().to_owned();
        if access_token.is_empty() {
            return Err(ErpcError::Config(
                "access_token must not be empty".to_owned(),
            ));
        }
        if config.timeout.is_zero() {
            return Err(ErpcError::Config("timeout must be positive".to_owned()));
        }
        let mut headers = HeaderMap::new();
        for (name, value) in config.headers {
            let name: HeaderName = name
                .parse()
                .map_err(|_| ErpcError::Config("header name is invalid".to_owned()))?;
            let value: HeaderValue = value
                .parse()
                .map_err(|_| ErpcError::Config("header value is invalid".to_owned()))?;
            headers.insert(name, value);
        }
        let client = reqwest::Client::builder()
            .build()
            .map_err(|_| ErpcError::Config("unable to create HTTP client".to_owned()))?;
        let transport = RestTransport::new(
            access_token,
            endpoint(&config.endpoint, true)?,
            headers,
            config.timeout,
            client,
        );
        Ok(Self {
            catalog: CloudCatalogClient::new(transport.clone()),
            credit: CloudCreditClient::new(transport.clone()),
            resources: CloudResourcesClient::new(transport.clone()),
            usage: UsageClient::new(transport),
        })
    }
}

/// Cloud resource kind.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudResourceKind {
    /// Dedicated bare-metal compute.
    BareMetal,
    /// Solana gRPC stream.
    SolanaGrpc,
    /// Solana shred stream.
    SolanaShredstream,
    /// Virtual private server.
    Vps,
}

/// Cloud resource delivery mode.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudResourceMode {
    /// Dedicated resource.
    Dedicated,
    /// Direct delivery.
    Direct,
    /// Shared resource.
    Shared,
}

/// Hourly catalog billing quote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOfferingBilling {
    /// Amount in cents.
    pub amount_cents: u64,
    /// Billing unit. Must be `cents-per-hour`.
    pub unit: String,
}

/// Compute metadata for an offering.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudOfferingComputeTenancy {
    /// Dedicated machine.
    BareMetal,
    /// Virtual machine.
    VirtualMachine,
}

/// Compute section of an offering.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudOfferingCompute {
    /// Compute tenancy.
    pub tenancy: CloudOfferingComputeTenancy,
}

/// Solana transport offered by a catalog item.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudOfferingSolanaTransport {
    /// gRPC transport.
    Grpc,
    /// Shred stream transport.
    Shredstream,
}

/// Solana section of an offering.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudOfferingSolana {
    /// Transport type.
    pub transport: CloudOfferingSolanaTransport,
}

/// One available Cloud offering.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOffering {
    /// Optional hourly quote.
    pub billing: Option<CloudOfferingBilling>,
    /// Neutral capability names.
    pub capabilities: Vec<String>,
    /// Optional compute metadata.
    pub compute: Option<CloudOfferingCompute>,
    /// Human-readable description.
    pub description: String,
    /// Stable offering identifier.
    pub id: String,
    /// Resource kind.
    pub kind: CloudResourceKind,
    /// Optional delivery mode.
    pub mode: Option<CloudResourceMode>,
    /// Human-readable name.
    pub name: String,
    /// Available regions.
    pub regions: Vec<String>,
    /// Optional Solana transport metadata.
    pub solana: Option<CloudOfferingSolana>,
}

/// Public Cloud catalog API.
#[derive(Clone)]
pub struct CloudCatalogClient {
    transport: RestTransport,
}

impl CloudCatalogClient {
    const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Lists available offerings.
    pub async fn list(&self) -> Result<Vec<CloudOffering>> {
        self.list_with(None).await
    }

    /// Lists available offerings with cancellation.
    pub async fn list_with(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Vec<CloudOffering>> {
        let envelope: Envelope<CatalogMessage> = self
            .transport
            .get("/v4/cloud/catalog", Vec::new(), cancellation)
            .await?;
        if !envelope.success
            || envelope.message.offerings.iter().any(|offering| {
                offering
                    .billing
                    .as_ref()
                    .is_some_and(|billing| billing.unit != "cents-per-hour")
            })
        {
            return Err(invalid_cloud("catalog"));
        }
        Ok(envelope.message.offerings)
    }
}

#[derive(Deserialize)]
struct CatalogMessage {
    offerings: Vec<CloudOffering>,
}

/// Credit alert level.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudCreditAlertLevel {
    /// Balance is critically low.
    Critical,
    /// Balance is healthy.
    Normal,
    /// Resource charging is suspended.
    Suspended,
    /// Balance warning threshold.
    Warning,
}

/// Point-in-time Cloud credit and burn-rate quote.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredit {
    /// Alert level derived by the service.
    pub alert_level: CloudCreditAlertLevel,
    /// Current balance in cents.
    pub balance_cents: i64,
    /// Current hourly burn rate in cents.
    pub burn_rate_cents_per_hour: u64,
    /// Quote expiration timestamp.
    pub quote_expires_at: String,
    /// Quote timestamp.
    pub quote_timestamp: String,
    /// Estimated hours until zero, when applicable.
    pub time_to_zero_hours: Option<f64>,
}

/// Cloud credit API.
#[derive(Clone)]
pub struct CloudCreditClient {
    transport: RestTransport,
}

impl CloudCreditClient {
    const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Gets the current credit snapshot.
    pub async fn get(&self) -> Result<CloudCredit> {
        self.get_with(None).await
    }

    /// Gets the current credit snapshot with cancellation.
    pub async fn get_with(&self, cancellation: Option<&CancellationToken>) -> Result<CloudCredit> {
        let envelope: Envelope<CloudCredit> = self
            .transport
            .get("/v4/cloud/credit", Vec::new(), cancellation)
            .await?;
        let credit = envelope.message;
        if !envelope.success
            || credit
                .time_to_zero_hours
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || !likely_datetime(&credit.quote_timestamp)
            || !likely_datetime(&credit.quote_expires_at)
        {
            return Err(invalid_cloud("credit snapshot"));
        }
        Ok(credit)
    }
}

/// Credential-free Cloud resource projection.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResource {
    /// Creation timestamp, when available.
    pub created_at: Option<String>,
    /// Stable resource identifier.
    pub id: String,
    /// Resource kind.
    pub kind: CloudResourceKind,
    /// Optional delivery mode.
    pub mode: Option<CloudResourceMode>,
    /// Optional display name.
    pub name: Option<String>,
    /// Optional deployment region.
    pub region: Option<String>,
    /// Service-defined lifecycle status.
    pub status: String,
}

/// Billing state attached to a resource status response.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceStatusBilling {
    /// End of the current grace period.
    pub grace_ends_at: Option<String>,
    /// Hourly credits charged.
    pub hourly_credits: Option<f64>,
    /// Next charge timestamp.
    pub next_charge_at: Option<String>,
    /// Current billing state.
    pub status: CloudResourceBillingStatus,
}

/// Resource billing state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudResourceBillingStatus {
    /// Billing is active.
    Active,
    /// Resource is in a grace period.
    GracePeriod,
    /// Billing is inactive.
    Inactive,
    /// Billing is suspended.
    Suspended,
}

/// Cloud resource status response.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceStatus {
    /// Optional billing section.
    pub billing: Option<CloudResourceStatusBilling>,
    /// Stable resource identifier.
    pub id: String,
    /// Service-defined lifecycle status.
    pub status: String,
}

/// Cloud resource inventory and status API.
#[derive(Clone)]
pub struct CloudResourcesClient {
    transport: RestTransport,
}

impl CloudResourcesClient {
    const fn new(transport: RestTransport) -> Self {
        Self { transport }
    }

    /// Lists provisioned resources.
    pub async fn list(&self) -> Result<Vec<CloudResource>> {
        self.list_with(None).await
    }

    /// Lists provisioned resources with cancellation.
    pub async fn list_with(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Vec<CloudResource>> {
        let envelope: Envelope<ResourceListMessage> = self
            .transport
            .get("/v4/cloud/resources", Vec::new(), cancellation)
            .await?;
        if !envelope.success {
            return Err(invalid_cloud("resource list"));
        }
        Ok(envelope.message.resources)
    }

    /// Gets one resource by identifier.
    pub async fn get(&self, resource_id: &str) -> Result<CloudResource> {
        self.get_with(resource_id, None).await
    }

    /// Gets one resource by identifier with cancellation.
    pub async fn get_with(
        &self,
        resource_id: &str,
        cancellation: Option<&CancellationToken>,
    ) -> Result<CloudResource> {
        let id = resource_id.trim();
        if id.is_empty() {
            return Err(ErpcError::Config(
                "resource_id must not be empty".to_owned(),
            ));
        }
        let path = format!(
            "/v4/cloud/resources/{}",
            utf8_percent_encode(id, NON_ALPHANUMERIC)
        );
        let envelope: Envelope<ResourceMessage> =
            self.transport.get(&path, Vec::new(), cancellation).await?;
        if !envelope.success {
            return Err(invalid_cloud("resource"));
        }
        Ok(envelope.message.resource)
    }

    /// Gets lifecycle and billing status for one resource.
    pub async fn get_status(&self, resource_id: &str) -> Result<CloudResourceStatus> {
        self.get_status_with(resource_id, None).await
    }

    /// Gets lifecycle and billing status for one resource with cancellation.
    pub async fn get_status_with(
        &self,
        resource_id: &str,
        cancellation: Option<&CancellationToken>,
    ) -> Result<CloudResourceStatus> {
        let id = resource_id.trim();
        if id.is_empty() {
            return Err(ErpcError::Config(
                "resource_id must not be empty".to_owned(),
            ));
        }
        let path = format!(
            "/v4/cloud/resources/{}/status",
            utf8_percent_encode(id, NON_ALPHANUMERIC)
        );
        let envelope: Envelope<CloudResourceStatus> =
            self.transport.get(&path, Vec::new(), cancellation).await?;
        if !envelope.success || !valid_billing(envelope.message.billing.as_ref()) {
            return Err(invalid_cloud("resource status"));
        }
        Ok(envelope.message)
    }
}

#[derive(Deserialize)]
struct ResourceListMessage {
    resources: Vec<CloudResource>,
}

#[derive(Deserialize)]
struct ResourceMessage {
    resource: CloudResource,
}

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    message: T,
    #[serde(flatten)]
    _other: HashMap<String, Value>,
}

fn invalid_cloud(resource: &str) -> ErpcError {
    ErpcError::InvalidResponse(format!("ERPC returned an invalid Cloud {resource}"))
}

fn likely_datetime(value: &str) -> bool {
    value.len() >= 20 && value.contains('T') && (value.ends_with('Z') || value.contains('+'))
}

fn valid_billing(billing: Option<&CloudResourceStatusBilling>) -> bool {
    billing.is_none_or(|billing| {
        billing
            .hourly_credits
            .is_none_or(|value| value.is_finite() && value >= 0.0)
            && billing
                .next_charge_at
                .as_deref()
                .is_none_or(likely_datetime)
            && billing.grace_ends_at.as_deref().is_none_or(likely_datetime)
    })
}
