//! Async Rust client for ERPC JSON-RPC, subscriptions, price, account, usage,
//! and Cloud APIs.

mod account;
mod cloud;
mod config;
mod error;
mod ethereum;
mod price;
mod rest;
mod rpc;
mod solana;
mod subscriptions;
mod usage;

pub use account::{AccountClient, ErpcPlan, TokenBalance};
pub use cloud::{
    CloudCatalogClient, CloudCredit, CloudCreditAlertLevel, CloudCreditClient, CloudOffering,
    CloudOfferingBilling, CloudOfferingCompute, CloudOfferingComputeTenancy, CloudOfferingSolana,
    CloudOfferingSolanaTransport, CloudResource, CloudResourceBillingStatus, CloudResourceKind,
    CloudResourceMode, CloudResourceStatus, CloudResourceStatusBilling, CloudResourcesClient,
    ErpcCloudClient, ErpcCloudClientConfig,
};
pub use config::{
    DEFAULT_ACCOUNT_ENDPOINT, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT, DEFAULT_USER_ENDPOINT,
    ErpcClientConfig,
};
pub use error::{ErpcError, ErpcErrorCode, JsonRpcErrorObject, Result};
pub use ethereum::{
    ETHEREUM_RPC_METHODS, ETHEREUM_SUBSCRIPTION_METHODS, EthereumClient, EthereumRpcClient,
    EthereumSubscriptions,
};
pub use price::{
    BinaryUpdate, ParsedPriceMetadata, ParsedPriceUpdate, ParsedPublisherStakeCaps, PriceAssetType,
    PriceClient, PriceEncoding, PriceFeedMetadata, PricePoint, PriceStream, PriceStreamEvent,
    PriceStreamOptions, PriceUpdateOptions, PriceUpdateResponse, PublisherStakeCap,
    PublisherStakeCapsResponse,
};
pub use rpc::{
    HttpJsonRpcTransport, HttpTransportConfig, JsonRpcId, PendingRpcBatchRequest,
    PendingRpcRequest, RequestOptions, RpcBatchCall, RpcNamespace,
};
pub use solana::{
    AddressTransaction, AddressTransactionPage, AddressTransactionsOptions, AddressTransfer,
    AddressTransferDirection, AddressTransferFilters, AddressTransferPage, AddressTransferType,
    AddressTransfersOptions, AnalyticsTimeBound, AssetBatchRequest, AssetListRequest, AssetRequest,
    EpochSummary, IndexedAsset, IndexedAssetList, IndexedAssetProof, LeaderSlot, LeaderSlotsResult,
    NumericFilter, PingMeasurement, PriorityFeeEstimate, ProgramStatsBucket, ProgramStatsOptions,
    SOLANA_ANALYTICS_METHODS, SOLANA_DAS_METHODS, SOLANA_ENHANCED_SUBSCRIPTION_METHODS,
    SOLANA_HISTORY_METHODS, SOLANA_LEADER_METHODS, SOLANA_RPC_METHODS, SlotStatsOptions,
    SlotStatsRow, SolanaAnalyticsClient, SolanaClient, SolanaCommitment, SolanaContext,
    SolanaContextResult, SolanaDasClient, SolanaEncoding, SolanaHistoryClient, SolanaLeaderClient,
    SolanaRpcClient, SolanaSubscriptions, TopProgramRow, TopProgramsOptions, TpsBucket,
    TpsTimeseriesOptions, ValidatorInformation, ValidatorsInformationOptions,
    ValidatorsInformationResult,
};
pub use subscriptions::{RpcNotification, RpcSubscription, SubscriptionId};
pub use tokio_util::sync::CancellationToken;
pub use usage::{
    MonthlyApiKeyChainUsage, MonthlyApiKeyMethodUsage, MonthlyApiKeyUsage, MonthlyApiKeyUsageEntry,
    MonthlyApiKeyUsageParams, UsageClient,
};

use std::sync::Arc;

use config::{ResolvedErpcClientConfig, endpoint_with_path, websocket_url};
use rest::RestTransport;
use subscriptions::WebSocketJsonRpcTransport;

/// A configured ERPC client containing all public service clients.
#[derive(Clone)]
pub struct ErpcClient {
    /// Account and token balance API.
    pub account: AccountClient,
    /// Standard Ethereum JSON-RPC and subscriptions.
    pub ethereum: EthereumClient,
    /// Price feed REST and streaming API.
    pub price: PriceClient,
    /// Standard and extended Solana JSON-RPC and subscriptions.
    pub solana: SolanaClient,
    /// Monthly API key usage API.
    pub usage: UsageClient,
}

impl ErpcClient {
    /// Creates a client after validating all configuration.
    pub fn new(config: ErpcClientConfig) -> Result<Self> {
        let resolved = ResolvedErpcClientConfig::try_from(config)?;
        let http = ResolvedErpcClientConfig::http_client()?;
        let solana_transport = Arc::new(HttpJsonRpcTransport::new(HttpTransportConfig {
            api_key: resolved.api_key.clone(),
            endpoint: resolved.endpoint.clone(),
            headers: resolved.headers.clone(),
            max_batch_size: 256,
            timeout: resolved.timeout,
            client: http.clone(),
        }));
        let ethereum_transport = Arc::new(HttpJsonRpcTransport::new(HttpTransportConfig {
            api_key: resolved.api_key.clone(),
            endpoint: endpoint_with_path(&resolved.endpoint, "/eth"),
            headers: resolved.headers.clone(),
            max_batch_size: 256,
            timeout: resolved.timeout,
            client: http.clone(),
        }));
        let solana_ws = Arc::new(WebSocketJsonRpcTransport::new(
            websocket_url(&resolved.endpoint, &resolved.api_key, "")?,
            resolved.timeout,
        ));
        let ethereum_ws = Arc::new(WebSocketJsonRpcTransport::new(
            websocket_url(&resolved.endpoint, &resolved.api_key, "/eth")?,
            resolved.timeout,
        ));
        let shared_rest = RestTransport::new(
            resolved.api_key.clone(),
            resolved.endpoint,
            resolved.headers.clone(),
            resolved.timeout,
            http.clone(),
        );
        let account_rest = RestTransport::new(
            resolved.api_key.clone(),
            resolved.account_endpoint,
            resolved.headers.clone(),
            resolved.timeout,
            http.clone(),
        );
        let user_rest = RestTransport::new(
            resolved.api_key,
            resolved.user_endpoint,
            resolved.headers,
            resolved.timeout,
            http,
        );

        Ok(Self {
            account: AccountClient::new(account_rest),
            ethereum: EthereumClient::new(ethereum_transport, ethereum_ws),
            price: PriceClient::new(shared_rest),
            solana: SolanaClient::new(solana_transport, solana_ws),
            usage: UsageClient::new(user_rest),
        })
    }

    /// Closes both subscription connections. HTTP clients need no explicit close.
    pub async fn close(&self) {
        self.solana.subscriptions.close().await;
        self.ethereum.subscriptions.close().await;
    }
}
