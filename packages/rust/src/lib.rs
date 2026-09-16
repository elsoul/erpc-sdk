//! Async Rust client for ERPC JSON-RPC, subscriptions, price, account, usage,
//! and Cloud APIs.

mod account;
mod avalanche;
mod cloud;
mod config;
pub mod dex_catalog;
mod error;
mod ethereum;
mod generated;
mod price;
mod rest;
mod rpc;
mod solana;
mod subscriptions;
mod swap;
pub mod token_catalog;
pub mod token_rankings;
mod usage;

pub use account::{AccountClient, ErpcPlan, TokenBalance};
pub use avalanche::{
    AVALANCHE_AVAX_METHODS, AVALANCHE_INDEX_METHODS, AVALANCHE_INFO_METHODS,
    AVALANCHE_P_CHAIN_METHODS, AVALANCHE_PROPOSER_VM_METHODS, AVALANCHE_X_CHAIN_METHODS,
    AvalancheAvaxClient, AvalancheClient, AvalancheIndexClient, AvalancheIndexRpcClient,
    AvalancheInfoClient, AvalanchePChainClient, AvalancheProposerVmClient, AvalancheXChainClient,
};
pub use cloud::{
    CloudCatalogClient, CloudCredit, CloudCreditAlertLevel, CloudCreditClient, CloudOffering,
    CloudOfferingBilling, CloudOfferingCompute, CloudOfferingComputeTenancy, CloudOfferingSolana,
    CloudOfferingSolanaTransport, CloudResource, CloudResourceBillingStatus, CloudResourceKind,
    CloudResourceMode, CloudResourceStatus, CloudResourceStatusBilling, CloudResourcesClient,
    ErpcCloudClient, ErpcCloudClientConfig,
};
pub use config::{
    DEFAULT_ACCOUNT_ENDPOINT, DEFAULT_AVALANCHE_ENDPOINT, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT,
    DEFAULT_USER_ENDPOINT, ErpcClientConfig, RpcEndpointConfig,
};
pub use dex_catalog::{
    DEX_ALIASES, DEX_CATALOG_AS_OF_DATE, DEX_CATALOG_CONTENT_DIGEST, DEX_CATALOG_VERSION,
    DEX_CHAIN_IDS, DEX_DEPLOYMENTS, DexAlias, DexChainId, DexDeployment,
    ListPoolDefinitionsOptions, NATIVE_WRAP_DEFINITIONS, NativeWrapDefinition, POOL_DEFINITIONS,
    PoolAdapter, PoolDefinition, dexes, find_pool_definition_by_address,
    find_pool_definitions_by_pair, get_dex_deployment, get_native_wrap_definition,
    get_pool_definition, list_pool_definitions, pools,
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
pub use swap::{
    EvmBlockSnapshot, ExactInputQuoteRequest, ExactInputQuoteResult, QuoteFee, SwapClient,
    SwapFreshness, SwapQuoteError, SwapQuoteErrorCode, SwapQuoteRequest, SwapResult,
};
pub use token_catalog::{
    TOKEN_ALIASES, TOKEN_ASSETS, TOKEN_CATALOG_AS_OF_DATE, TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION, TOKEN_CHAIN_IDS, TOKEN_DEPLOYMENTS, TokenAlias, TokenAsset,
    TokenChainId, TokenDeployment, TokenRepresentationKind, TokenStandard, TokenStatus,
    find_token_deployment_by_address, find_token_deployments_by_symbol,
    get_native_token_deployment, get_token_asset, get_token_deployment, list_token_deployments,
    token_chain_ids, tokens,
};
pub use token_rankings::{
    TOKEN_RANKINGS, TOKEN_RANKINGS_AS_OF, TOKEN_RANKINGS_CONTENT_DIGEST, TOKEN_RANKINGS_COVERAGE,
    TOKEN_RANKINGS_METADATA, TOKEN_RANKINGS_METRIC, TOKEN_RANKINGS_SCHEMA_VERSION,
    TOKEN_RANKINGS_SOURCE_IDS, TOKEN_RANKINGS_STATUS, TokenRanking, TokenRankingCoverage,
    TokenRankingMetadata, list_token_rankings,
};
pub use tokio_util::sync::CancellationToken;
pub use usage::{
    MonthlyApiKeyChainUsage, MonthlyApiKeyMethodUsage, MonthlyApiKeyUsage, MonthlyApiKeyUsageEntry,
    MonthlyApiKeyUsageParams, UsageClient,
};

use std::sync::Arc;

use config::{ResolvedErpcClientConfig, ResolvedRpcEndpoint, endpoint_with_path, websocket_url};
use rest::RestTransport;
use subscriptions::WebSocketJsonRpcTransport;

fn legacy_rpc_transport(
    resolved: &ResolvedErpcClientConfig,
    endpoint: url::Url,
    client: &reqwest::Client,
    namespace: &str,
) -> Arc<HttpJsonRpcTransport> {
    if let Some(api_key) = &resolved.api_key {
        Arc::new(HttpJsonRpcTransport::new(HttpTransportConfig {
            api_key: api_key.clone(),
            endpoint,
            headers: resolved.headers.clone(),
            max_batch_size: 256,
            timeout: resolved.timeout,
            client: client.clone(),
        }))
    } else {
        Arc::new(HttpJsonRpcTransport::unavailable(
            namespace,
            resolved.timeout,
            client.clone(),
        ))
    }
}

fn direct_rpc_transport(
    endpoint: &ResolvedRpcEndpoint,
    client: &reqwest::Client,
    namespace: &str,
    timeout: std::time::Duration,
) -> Arc<HttpJsonRpcTransport> {
    Arc::new(HttpJsonRpcTransport::new_direct(
        endpoint.http_url.clone(),
        endpoint.headers.clone(),
        endpoint.redaction_secrets.clone(),
        256,
        timeout,
        client.clone(),
        namespace,
    ))
}

fn websocket_transport(
    resolved: &ResolvedErpcClientConfig,
    direct: Option<&ResolvedRpcEndpoint>,
    legacy_endpoint: &url::Url,
    legacy_path: &str,
    namespace: &str,
) -> Result<Arc<WebSocketJsonRpcTransport>> {
    if let Some(endpoint) = direct {
        return Ok(if let Some(websocket_url) = &endpoint.websocket_url {
            Arc::new(WebSocketJsonRpcTransport::new_direct(
                websocket_url.clone(),
                endpoint.redaction_secrets.clone(),
                resolved.timeout,
                namespace,
            ))
        } else {
            Arc::new(WebSocketJsonRpcTransport::unavailable(
                namespace,
                resolved.timeout,
            ))
        });
    }
    if let Some(api_key) = &resolved.api_key {
        return Ok(Arc::new(WebSocketJsonRpcTransport::new(
            websocket_url(legacy_endpoint, api_key, legacy_path)?,
            resolved.timeout,
        )));
    }
    Ok(Arc::new(WebSocketJsonRpcTransport::unavailable(
        namespace,
        resolved.timeout,
    )))
}

fn avalanche_index_transports(
    resolved: &ResolvedErpcClientConfig,
    client: &reqwest::Client,
) -> avalanche::AvalancheIndexTransports {
    let index_transport = |path| {
        legacy_rpc_transport(
            resolved,
            endpoint_with_path(&resolved.avalanche_endpoint, path),
            client,
            "avalanche.index",
        )
    };
    avalanche::AvalancheIndexTransports {
        c_chain_blocks: index_transport("/ava/ext/index/C/block"),
        p_chain_blocks: index_transport("/ava/ext/index/P/block"),
        x_chain_blocks: index_transport("/ava/ext/index/X/block"),
        x_chain_transactions: index_transport("/ava/ext/index/X/tx"),
    }
}

/// A configured ERPC client containing all public service clients.
#[derive(Clone)]
pub struct ErpcClient {
    /// Account and token balance API.
    pub account: AccountClient,
    /// Avalanche C-Chain, native-chain, Index API, and subscriptions.
    pub avalanche: AvalancheClient,
    /// Standard Ethereum JSON-RPC and subscriptions.
    pub ethereum: EthereumClient,
    /// Price feed REST and streaming API.
    pub price: PriceClient,
    /// Standard and extended Solana JSON-RPC and subscriptions.
    pub solana: SolanaClient,
    /// RPC-backed exact-input DEX quote client.
    pub swap: SwapClient,
    /// Monthly API key usage API.
    pub usage: UsageClient,
}

impl ErpcClient {
    /// Creates a client after validating all configuration.
    #[allow(clippy::too_many_lines)]
    pub fn new(config: ErpcClientConfig) -> Result<Self> {
        let resolved = ResolvedErpcClientConfig::try_from(config)?;
        let http = ResolvedErpcClientConfig::http_client()?;
        let direct_http = ResolvedErpcClientConfig::direct_http_client()?;
        let solana_transport = resolved.solana_rpc.as_ref().map_or_else(
            || legacy_rpc_transport(&resolved, resolved.endpoint.clone(), &http, "solana.rpc"),
            |endpoint| direct_rpc_transport(endpoint, &direct_http, "solana.rpc", resolved.timeout),
        );
        let ethereum_transport = resolved.ethereum_rpc.as_ref().map_or_else(
            || {
                legacy_rpc_transport(
                    &resolved,
                    endpoint_with_path(&resolved.endpoint, "/eth"),
                    &http,
                    "ethereum.rpc",
                )
            },
            |endpoint| {
                direct_rpc_transport(endpoint, &direct_http, "ethereum.rpc", resolved.timeout)
            },
        );
        let avalanche_c_transport = resolved.avalanche_c_rpc.as_ref().map_or_else(
            || {
                legacy_rpc_transport(
                    &resolved,
                    endpoint_with_path(&resolved.avalanche_endpoint, "/ava"),
                    &http,
                    "avalanche.rpc",
                )
            },
            |endpoint| {
                direct_rpc_transport(endpoint, &direct_http, "avalanche.rpc", resolved.timeout)
            },
        );
        let avalanche_native_transport = legacy_rpc_transport(
            &resolved,
            endpoint_with_path(&resolved.avalanche_endpoint, "/ava"),
            &http,
            "avalanche.native",
        );
        let avalanche_index = avalanche_index_transports(&resolved, &http);
        let solana_ws = websocket_transport(
            &resolved,
            resolved.solana_rpc.as_ref(),
            &resolved.endpoint,
            "",
            "solana.subscriptions",
        )?;
        let ethereum_ws = websocket_transport(
            &resolved,
            resolved.ethereum_rpc.as_ref(),
            &resolved.endpoint,
            "/eth",
            "ethereum.subscriptions",
        )?;
        let avalanche_ws = websocket_transport(
            &resolved,
            resolved.avalanche_c_rpc.as_ref(),
            &resolved.avalanche_endpoint,
            "/ava-ws",
            "avalanche.subscriptions",
        )?;
        let (shared_rest, account_rest, user_rest) = if let Some(api_key) = &resolved.api_key {
            (
                RestTransport::new(
                    api_key.clone(),
                    resolved.endpoint.clone(),
                    resolved.headers.clone(),
                    resolved.timeout,
                    http.clone(),
                ),
                RestTransport::new(
                    api_key.clone(),
                    resolved.account_endpoint.clone(),
                    resolved.headers.clone(),
                    resolved.timeout,
                    http.clone(),
                ),
                RestTransport::new(
                    api_key.clone(),
                    resolved.user_endpoint.clone(),
                    resolved.headers.clone(),
                    resolved.timeout,
                    http.clone(),
                ),
            )
        } else {
            (
                RestTransport::unavailable("price", resolved.timeout, http.clone()),
                RestTransport::unavailable("account", resolved.timeout, http.clone()),
                RestTransport::unavailable("usage", resolved.timeout, http.clone()),
            )
        };
        let swap = SwapClient::new(
            Arc::clone(&ethereum_transport),
            Arc::clone(&avalanche_c_transport),
        );

        Ok(Self {
            account: AccountClient::new(account_rest),
            avalanche: AvalancheClient::new(
                &avalanche_c_transport,
                avalanche_native_transport,
                avalanche_ws,
                avalanche_index,
            ),
            ethereum: EthereumClient::new(ethereum_transport, ethereum_ws),
            price: PriceClient::new(shared_rest),
            solana: SolanaClient::new(solana_transport, solana_ws),
            swap,
            usage: UsageClient::new(user_rest),
        })
    }

    /// Builds a test client with a private deterministic swap clock.
    #[cfg(test)]
    pub(crate) fn new_with_swap_clock(
        config: ErpcClientConfig,
        clock: fn() -> u64,
    ) -> Result<Self> {
        let mut client = Self::new(config)?;
        client.swap = client.swap.with_clock(clock);
        Ok(client)
    }

    /// Closes all subscription connections. HTTP clients need no explicit close.
    pub async fn close(&self) {
        self.solana.subscriptions.close().await;
        self.ethereum.subscriptions.close().await;
        self.avalanche.subscriptions.close().await;
    }
}
