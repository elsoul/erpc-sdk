"""Typed request builders and the supported JSON-RPC method catalogs."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Generic, Literal, TypeVar, cast

from .errors import ErpcBatchPolicyError, ErpcConfigError
from .transport import HttpJsonRpcTransport
from .types import (
    DEFAULT_REQUEST_OPTIONS,
    JsonRpcParams,
    JsonValue,
    RequestOptions,
    RpcBatchCall,
)

T = TypeVar("T")

SOLANA_RPC_METHODS = (
    "getAccountInfo",
    "getBalance",
    "getBlock",
    "getBlockCommitment",
    "getBlockHeight",
    "getBlockProduction",
    "getBlockTime",
    "getBlocks",
    "getBlocksWithLimit",
    "getClusterNodes",
    "getEpochInfo",
    "getEpochSchedule",
    "getFeeForMessage",
    "getFirstAvailableBlock",
    "getGenesisHash",
    "getHealth",
    "getHighestSnapshotSlot",
    "getIdentity",
    "getInflationGovernor",
    "getInflationRate",
    "getInflationReward",
    "getLargestAccounts",
    "getLatestBlockhash",
    "getLeaderSchedule",
    "getMaxRetransmitSlot",
    "getMaxShredInsertSlot",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    "getParsedTransaction",
    "getPriorityFeeEstimate",
    "getProgramAccounts",
    "getProgramAccountsV2",
    "getRecentPerformanceSamples",
    "getRecentPrioritizationFees",
    "getSignatureStatuses",
    "getSignaturesForAddress",
    "getSlot",
    "getSlotLeader",
    "getSlotLeaders",
    "getStakeMinimumDelegation",
    "getSupply",
    "getTokenAccountBalance",
    "getTokenAccountsByDelegate",
    "getTokenAccountsByOwner",
    "getTokenLargestAccounts",
    "getTokenSupply",
    "getTransaction",
    "getTransactionCount",
    "getVersion",
    "getVoteAccounts",
    "isBlockhashValid",
    "minimumLedgerSlot",
    "requestAirdrop",
    "sendTransaction",
    "simulateTransaction",
)

SOLANA_DAS_METHODS = (
    "getAsset",
    "getAssetBatch",
    "getAssetProof",
    "getAssetProofBatch",
    "getAssetsByAuthority",
    "getAssetsByCreator",
    "getAssetsByGroup",
    "getAssetsByOwner",
    "getNftEditions",
    "getSignaturesForAsset",
    "getTokenAccounts",
    "getTokensByDelegate",
    "getTokensByOwner",
    "searchAssets",
)

SOLANA_HISTORY_METHODS = ("getTransactionsForAddress", "getTransfersByAddress")
SOLANA_LEADER_METHODS = ("getLeaderSlots", "getValidatorsInformation")
SOLANA_ANALYTICS_METHODS = (
    "jetEpochSummary",
    "jetProgramStats",
    "jetSlotStats",
    "jetTopPrograms",
    "jetTpsTimeseries",
)
SOLANA_ENHANCED_SUBSCRIPTION_METHODS = (
    "accountSubscribe",
    "accountUnsubscribe",
    "transactionSubscribe",
    "transactionUnsubscribe",
)

ETHEREUM_RPC_METHODS = (
    "eth_accounts",
    "eth_baseFee",
    "eth_blobBaseFee",
    "eth_blockNumber",
    "eth_call",
    "eth_callMany",
    "eth_capabilities",
    "eth_chainId",
    "eth_createAccessList",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_gasPrice",
    "eth_getAccount",
    "eth_getBalance",
    "eth_getBlockByHash",
    "eth_getBlockByNumber",
    "eth_getBlockReceipts",
    "eth_getBlockTransactionCountByHash",
    "eth_getBlockTransactionCountByNumber",
    "eth_getCode",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
    "eth_getLogs",
    "eth_getProof",
    "eth_getRawTransactionByHash",
    "eth_getStorageAt",
    "eth_getTransactionByBlockHashAndIndex",
    "eth_getTransactionByBlockNumberAndIndex",
    "eth_getTransactionByHash",
    "eth_getTransactionBySenderAndNonce",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_getUncleCountByBlockHash",
    "eth_getUncleCountByBlockNumber",
    "eth_maxPriorityFeePerGas",
    "eth_newBlockFilter",
    "eth_newFilter",
    "eth_newPendingTransactionFilter",
    "eth_sendRawTransaction",
    "eth_signTransaction",
    "eth_simulateV1",
    "eth_submitWork",
    "eth_syncing",
    "eth_uninstallFilter",
    "net_listening",
    "net_peerCount",
    "net_version",
    "txpool_content",
    "txpool_contentFrom",
    "txpool_inspect",
    "txpool_status",
    "web3_clientVersion",
    "web3_sha3",
)
ETHEREUM_SUBSCRIPTION_METHODS = ("eth_subscribe", "eth_unsubscribe")

AVALANCHE_AVAX_METHODS = (
    "avax.getAtomicTx",
    "avax.getAtomicTxStatus",
    "avax.getUTXOs",
    "avax.issueTx",
)
AVALANCHE_X_CHAIN_METHODS = (
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
)
AVALANCHE_P_CHAIN_METHODS = (
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
)
AVALANCHE_PROPOSER_VM_METHODS = (
    "proposervm.getCurrentEpoch",
    "proposervm.getProposedHeight",
)
AVALANCHE_INFO_METHODS = ("info.upgrades",)
AVALANCHE_INDEX_METHODS = (
    "index.getContainerByID",
    "index.getContainerByIndex",
    "index.getContainerRange",
    "index.getIndex",
    "index.getLastAccepted",
    "index.isAccepted",
)

_HEAVY_SOLANA_METHODS = {
    "getPriorityFeeEstimate",
    "getProgramAccounts",
    "getProgramAccountsV2",
    "getTokenLargestAccounts",
}


def _snake_case(value: str) -> str:
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", value).lower()


class PendingRpcRequest(Generic[T]):
    """An inert request; network I/O starts only when ``send`` is awaited."""

    def __init__(
        self,
        transport: HttpJsonRpcTransport,
        method: str,
        params: JsonRpcParams | None,
        decoder: Callable[[JsonValue], T],
    ) -> None:
        self._transport = transport
        self._method = method
        self._params = params
        self._decoder = decoder

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> T:
        value = await self._transport.request(self._method, self._params, options)
        return self._decoder(value)


class PendingRpcBatchRequest:
    """An inert batch that remains one batch on the wire."""

    def __init__(self, transport: HttpJsonRpcTransport, calls: Sequence[RpcBatchCall]) -> None:
        self._transport = transport
        self._calls = tuple(calls)

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> list[JsonValue]:
        return await self._transport.batch(self._calls, options)


BatchPolicy = Literal["any", "solana-standard", "unsupported"]
ParameterMode = Literal["named", "positional"]


class RpcNamespace:
    """A method-catalog namespace with generic request, raw, and batch APIs."""

    def __init__(
        self,
        transport: HttpJsonRpcTransport,
        methods: Sequence[str],
        *,
        parameter_mode: ParameterMode,
        batch_policy: BatchPolicy = "any",
        method_prefix: str | None = None,
    ) -> None:
        self._transport = transport
        prefix = f"{method_prefix}." if method_prefix is not None else ""
        self._wire_methods = {
            method.removeprefix(prefix): method for method in methods
        }
        self._methods = frozenset(self._wire_methods)
        self._aliases = {_snake_case(method): method for method in self._methods}
        self._parameter_mode = parameter_mode
        self._batch_policy = batch_policy

    @property
    def endpoint(self) -> str:
        return self._transport.endpoint

    def request(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        *,
        decoder: Callable[[JsonValue], T] | None = None,
    ) -> PendingRpcRequest[T]:
        if method not in self._methods:
            raise ErpcConfigError(
                f"{method!r} is not in this namespace; use raw for forward-compatible methods"
            )
        selected = decoder or cast(Callable[[JsonValue], T], lambda value: value)
        return PendingRpcRequest(
            self._transport, self._wire_methods[method], params, selected
        )

    def raw(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        *,
        decoder: Callable[[JsonValue], T] | None = None,
    ) -> PendingRpcRequest[T]:
        if not method:
            raise ErpcConfigError("method must not be empty")
        selected = decoder or cast(Callable[[JsonValue], T], lambda value: value)
        return PendingRpcRequest(self._transport, method, params, selected)

    def batch(self, calls: Sequence[RpcBatchCall]) -> PendingRpcBatchRequest:
        if self._batch_policy == "unsupported" and calls:
            raise ErpcBatchPolicyError("This RPC namespace does not support batching")
        if self._batch_policy == "solana-standard":
            has_heavy = any(call["method"] in _HEAVY_SOLANA_METHODS for call in calls)
            has_standard = any(call["method"] not in _HEAVY_SOLANA_METHODS for call in calls)
            if has_heavy and has_standard:
                raise ErpcBatchPolicyError(
                    "Solana indexed and standard RPC methods cannot share a batch"
                )
        wire_calls: Sequence[RpcBatchCall] = calls
        if any(method != wire for method, wire in self._wire_methods.items()):
            mapped: list[RpcBatchCall] = []
            for call in calls:
                public_method = call["method"]
                if public_method not in self._wire_methods:
                    raise ErpcConfigError(
                        f"{public_method!r} is not in this namespace; "
                        "use raw for forward-compatible methods"
                    )
                wire_call: RpcBatchCall = {
                    "method": self._wire_methods[public_method]
                }
                if "params" in call:
                    wire_call["params"] = call["params"]
                mapped.append(wire_call)
            wire_calls = mapped
        return PendingRpcBatchRequest(self._transport, wire_calls)

    def __getattr__(self, name: str) -> Callable[..., PendingRpcRequest[JsonValue]]:
        method = name if name in self._methods else self._aliases.get(name)
        if method is None:
            raise AttributeError(name)

        def build(*args: JsonValue) -> PendingRpcRequest[JsonValue]:
            if self._parameter_mode == "positional":
                params: JsonRpcParams | None = list(args)
            elif not args:
                params = None
            elif len(args) == 1 and isinstance(args[0], dict):
                params = args[0]
            else:
                raise ErpcConfigError("named RPC methods require one mapping argument")
            return self.request(method, params)

        return build
