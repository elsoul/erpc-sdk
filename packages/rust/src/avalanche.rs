use std::{ops::Deref, sync::Arc};

use serde::Serialize;
use serde_json::Value;

use crate::{
    PendingRpcRequest, Result, RpcNamespace,
    ethereum::{EthereumRpcClient, EthereumSubscriptions},
    rpc::{BatchPolicy, HttpJsonRpcTransport},
    subscriptions::WebSocketJsonRpcTransport,
};

/// C-Chain AVAX API methods represented by this release.
pub const AVALANCHE_AVAX_METHODS: &[&str] = &[
    "avax.getAtomicTx",
    "avax.getAtomicTxStatus",
    "avax.getUTXOs",
    "avax.issueTx",
];

/// X-Chain API methods represented by this release.
pub const AVALANCHE_X_CHAIN_METHODS: &[&str] = &[
    "avm.buildGenesis",
    "avm.getAllBalances",
    "avm.getAssetDescription",
    "avm.getBalance",
    "avm.getBlockByHeight",
    "avm.getHeight",
    "avm.getTx",
    "avm.getTxFee",
    "avm.getTxStatus",
    "avm.getUTXOs",
    "avm.issueTx",
];

/// P-Chain API methods represented by this release.
pub const AVALANCHE_P_CHAIN_METHODS: &[&str] = &[
    "platform.getAllValidatorsAt",
    "platform.getBalance",
    "platform.getBlockchainStatus",
    "platform.getBlockchains",
    "platform.getCurrentSupply",
    "platform.getCurrentValidators",
    "platform.getFeeConfig",
    "platform.getFeeState",
    "platform.getHeight",
    "platform.getMinStake",
    "platform.getRewardUTXOs",
    "platform.getStake",
    "platform.getStakingAssetID",
    "platform.getSubnets",
    "platform.getTimestamp",
    "platform.getTotalStake",
    "platform.getTx",
    "platform.getTxStatus",
    "platform.getUTXOs",
    "platform.getValidatorFeeConfig",
    "platform.getValidatorFeeState",
    "platform.getValidatorsAt",
    "platform.issueTx",
    "platform.sampleValidators",
    "platform.validatedBy",
    "platform.validates",
];

/// P-Chain proposer VM API methods represented by this release.
pub const AVALANCHE_PROPOSER_VM_METHODS: &[&str] =
    &["proposervm.getCurrentEpoch", "proposervm.getProposedHeight"];

/// Node information API methods represented by this release.
pub const AVALANCHE_INFO_METHODS: &[&str] = &["info.upgrades"];

/// Index API methods represented by this release.
pub const AVALANCHE_INDEX_METHODS: &[&str] = &[
    "index.getContainerByID",
    "index.getContainerByIndex",
    "index.getContainerRange",
    "index.getIndex",
    "index.getLastAccepted",
    "index.isAccepted",
];

macro_rules! avalanche_namespace {
    (
        $name:ident,
        $prefix:literal,
        no_params: [$(($no_name:ident, $no_wire:literal)),* $(,)?],
        with_params: [$(($with_name:ident, $with_wire:literal)),* $(,)?]
    ) => {
        #[doc = concat!(stringify!($name), " JSON-RPC namespace.")]
        #[derive(Clone)]
        pub struct $name {
            namespace: RpcNamespace,
        }

        impl $name {
            const fn new(transport: Arc<HttpJsonRpcTransport>) -> Self {
                Self {
                    namespace: RpcNamespace::new(transport, BatchPolicy::Unsupported),
                }
            }

            /// Creates a request from a prefix-free catalog method name.
            pub fn request<T: serde::de::DeserializeOwned, P: Serialize>(
                &self,
                method: &str,
                params: P,
            ) -> Result<PendingRpcRequest<T>> {
                self.namespace.request(format!("{}.{method}", $prefix), params)
            }

            /// Creates a parameterless request from a prefix-free catalog method name.
            #[must_use]
            pub fn request_without_params<T: serde::de::DeserializeOwned>(
                &self,
                method: &str,
            ) -> PendingRpcRequest<T> {
                self.namespace
                    .request_without_params(format!("{}.{method}", $prefix))
            }

            $(
                #[doc = concat!("Creates a pending `", $no_wire, "` request.")]
                #[must_use]
                pub fn $no_name(&self) -> PendingRpcRequest<Value> {
                    self.namespace.request_without_params($no_wire)
                }
            )*

            $(
                #[doc = concat!("Creates a pending `", $with_wire, "` request.")]
                pub fn $with_name<P: Serialize>(
                    &self,
                    params: P,
                ) -> Result<PendingRpcRequest<Value>> {
                    self.namespace.request($with_wire, params)
                }
            )*
        }

        impl Deref for $name {
            type Target = RpcNamespace;

            fn deref(&self) -> &Self::Target {
                &self.namespace
            }
        }
    };
}

avalanche_namespace!(
    AvalancheAvaxClient,
    "avax",
    no_params: [],
    with_params: [
        (get_atomic_tx, "avax.getAtomicTx"),
        (get_atomic_tx_status, "avax.getAtomicTxStatus"),
        (get_utxos, "avax.getUTXOs"),
        (issue_tx, "avax.issueTx"),
    ]
);

avalanche_namespace!(
    AvalancheXChainClient,
    "avm",
    no_params: [
        (get_height, "avm.getHeight"),
        (get_tx_fee, "avm.getTxFee"),
    ],
    with_params: [
        (build_genesis, "avm.buildGenesis"),
        (get_all_balances, "avm.getAllBalances"),
        (get_asset_description, "avm.getAssetDescription"),
        (get_balance, "avm.getBalance"),
        (get_block_by_height, "avm.getBlockByHeight"),
        (get_tx, "avm.getTx"),
        (get_tx_status, "avm.getTxStatus"),
        (get_utxos, "avm.getUTXOs"),
        (issue_tx, "avm.issueTx"),
    ]
);

avalanche_namespace!(
    AvalanchePChainClient,
    "platform",
    no_params: [
        (get_blockchains, "platform.getBlockchains"),
        (get_current_supply, "platform.getCurrentSupply"),
        (get_fee_config, "platform.getFeeConfig"),
        (get_fee_state, "platform.getFeeState"),
        (get_height, "platform.getHeight"),
        (get_min_stake, "platform.getMinStake"),
        (get_timestamp, "platform.getTimestamp"),
        (get_validator_fee_config, "platform.getValidatorFeeConfig"),
        (get_validator_fee_state, "platform.getValidatorFeeState"),
    ],
    with_params: [
        (get_all_validators_at, "platform.getAllValidatorsAt"),
        (get_balance, "platform.getBalance"),
        (get_blockchain_status, "platform.getBlockchainStatus"),
        (get_current_validators, "platform.getCurrentValidators"),
        (get_reward_utxos, "platform.getRewardUTXOs"),
        (get_stake, "platform.getStake"),
        (get_staking_asset_id, "platform.getStakingAssetID"),
        (get_subnets, "platform.getSubnets"),
        (get_total_stake, "platform.getTotalStake"),
        (get_tx, "platform.getTx"),
        (get_tx_status, "platform.getTxStatus"),
        (get_utxos, "platform.getUTXOs"),
        (get_validators_at, "platform.getValidatorsAt"),
        (issue_tx, "platform.issueTx"),
        (sample_validators, "platform.sampleValidators"),
        (validated_by, "platform.validatedBy"),
        (validates, "platform.validates"),
    ]
);

avalanche_namespace!(
    AvalancheProposerVmClient,
    "proposervm",
    no_params: [
        (get_current_epoch, "proposervm.getCurrentEpoch"),
        (get_proposed_height, "proposervm.getProposedHeight"),
    ],
    with_params: []
);

avalanche_namespace!(
    AvalancheInfoClient,
    "info",
    no_params: [(upgrades, "info.upgrades")],
    with_params: []
);

avalanche_namespace!(
    AvalancheIndexRpcClient,
    "index",
    no_params: [],
    with_params: [
        (get_container_by_id, "index.getContainerByID"),
        (get_container_by_index, "index.getContainerByIndex"),
        (get_container_range, "index.getContainerRange"),
        (get_index, "index.getIndex"),
        (get_last_accepted, "index.getLastAccepted"),
        (is_accepted, "index.isAccepted"),
    ]
);

/// Explicit chain/container routes exposed by the Avalanche Index API.
#[derive(Clone)]
pub struct AvalancheIndexClient {
    /// C-Chain block index.
    pub c_chain_blocks: AvalancheIndexRpcClient,
    /// P-Chain block index.
    pub p_chain_blocks: AvalancheIndexRpcClient,
    /// X-Chain block index.
    pub x_chain_blocks: AvalancheIndexRpcClient,
    /// X-Chain transaction index.
    pub x_chain_transactions: AvalancheIndexRpcClient,
}

pub(crate) struct AvalancheIndexTransports {
    pub c_chain_blocks: Arc<HttpJsonRpcTransport>,
    pub p_chain_blocks: Arc<HttpJsonRpcTransport>,
    pub x_chain_blocks: Arc<HttpJsonRpcTransport>,
    pub x_chain_transactions: Arc<HttpJsonRpcTransport>,
}

/// Avalanche C-Chain and native-chain RPC namespaces.
#[derive(Clone)]
pub struct AvalancheClient {
    /// C-Chain EVM-compatible JSON-RPC namespace.
    pub rpc: EthereumRpcClient,
    /// C-Chain AVAX API namespace.
    pub avax: AvalancheAvaxClient,
    /// X-Chain API namespace.
    pub x_chain: AvalancheXChainClient,
    /// P-Chain API namespace.
    pub p_chain: AvalanchePChainClient,
    /// P-Chain proposer VM namespace.
    pub proposer_vm: AvalancheProposerVmClient,
    /// Node information namespace.
    pub info: AvalancheInfoClient,
    /// Explicit Index API routes.
    pub index: AvalancheIndexClient,
    /// C-Chain WebSocket subscriptions.
    pub subscriptions: EthereumSubscriptions,
}

impl AvalancheClient {
    pub(crate) fn new(
        transport: Arc<HttpJsonRpcTransport>,
        websocket: Arc<WebSocketJsonRpcTransport>,
        index: AvalancheIndexTransports,
    ) -> Self {
        Self {
            rpc: EthereumRpcClient::new(Arc::clone(&transport)),
            avax: AvalancheAvaxClient::new(Arc::clone(&transport)),
            x_chain: AvalancheXChainClient::new(Arc::clone(&transport)),
            p_chain: AvalanchePChainClient::new(Arc::clone(&transport)),
            proposer_vm: AvalancheProposerVmClient::new(Arc::clone(&transport)),
            info: AvalancheInfoClient::new(transport),
            index: AvalancheIndexClient {
                c_chain_blocks: AvalancheIndexRpcClient::new(index.c_chain_blocks),
                p_chain_blocks: AvalancheIndexRpcClient::new(index.p_chain_blocks),
                x_chain_blocks: AvalancheIndexRpcClient::new(index.x_chain_blocks),
                x_chain_transactions: AvalancheIndexRpcClient::new(index.x_chain_transactions),
            },
            subscriptions: EthereumSubscriptions::new(websocket),
        }
    }
}
