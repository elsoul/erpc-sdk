package erpc

// Method catalogs mirror the wire-compatible method names exposed by ERPC.
var SolanaRPCMethods = []string{
	"getAccountInfo", "getBalance", "getBlock", "getBlockCommitment", "getBlockHeight",
	"getBlockProduction", "getBlockTime", "getBlocks", "getBlocksWithLimit", "getClusterNodes",
	"getEpochInfo", "getEpochSchedule", "getFeeForMessage", "getFirstAvailableBlock", "getGenesisHash",
	"getHealth", "getHighestSnapshotSlot", "getIdentity", "getInflationGovernor", "getInflationRate",
	"getInflationReward", "getLargestAccounts", "getLatestBlockhash", "getLeaderSchedule", "getMaxRetransmitSlot",
	"getMaxShredInsertSlot", "getMinimumBalanceForRentExemption", "getMultipleAccounts", "getParsedTransaction",
	"getPriorityFeeEstimate", "getProgramAccounts", "getProgramAccountsV2", "getRecentPerformanceSamples",
	"getRecentPrioritizationFees", "getSignatureStatuses", "getSignaturesForAddress", "getSlot", "getSlotLeader",
	"getSlotLeaders", "getStakeMinimumDelegation", "getSupply", "getTokenAccountBalance",
	"getTokenAccountsByDelegate", "getTokenAccountsByOwner", "getTokenLargestAccounts", "getTokenSupply",
	"getTransaction", "getTransactionCount", "getVersion", "getVoteAccounts", "isBlockhashValid",
	"minimumLedgerSlot", "requestAirdrop", "sendTransaction", "simulateTransaction",
}

var SolanaDASMethods = []string{
	"getAsset", "getAssetBatch", "getAssetProof", "getAssetProofBatch", "getAssetsByAuthority",
	"getAssetsByCreator", "getAssetsByGroup", "getAssetsByOwner", "getNftEditions", "getSignaturesForAsset",
	"getTokenAccounts", "getTokensByDelegate", "getTokensByOwner", "searchAssets",
}

var SolanaHistoryMethods = []string{"getTransactionsForAddress", "getTransfersByAddress"}
var SolanaLeaderMethods = []string{"getLeaderSlots", "getValidatorsInformation"}
var SolanaAnalyticsMethods = []string{"jetEpochSummary", "jetProgramStats", "jetSlotStats", "jetTopPrograms", "jetTpsTimeseries"}
var SolanaEnhancedSubscriptionMethods = []string{"accountSubscribe", "accountUnsubscribe", "transactionSubscribe", "transactionUnsubscribe"}

var EthereumRPCMethods = []string{
	"eth_accounts", "eth_baseFee", "eth_blobBaseFee", "eth_blockNumber", "eth_call", "eth_callMany",
	"eth_capabilities", "eth_chainId", "eth_createAccessList", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice",
	"eth_getAccount", "eth_getBalance", "eth_getBlockByHash", "eth_getBlockByNumber", "eth_getBlockReceipts",
	"eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber", "eth_getCode",
	"eth_getFilterChanges", "eth_getFilterLogs", "eth_getLogs", "eth_getProof", "eth_getRawTransactionByHash",
	"eth_getStorageAt", "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex",
	"eth_getTransactionByHash", "eth_getTransactionBySenderAndNonce", "eth_getTransactionCount",
	"eth_getTransactionReceipt", "eth_getUncleCountByBlockHash", "eth_getUncleCountByBlockNumber",
	"eth_maxPriorityFeePerGas", "eth_newBlockFilter", "eth_newFilter", "eth_newPendingTransactionFilter",
	"eth_sendRawTransaction", "eth_signTransaction", "eth_simulateV1", "eth_submitWork", "eth_syncing",
	"eth_uninstallFilter", "net_listening", "net_peerCount", "net_version", "txpool_content", "txpool_contentFrom",
	"txpool_inspect", "txpool_status", "web3_clientVersion", "web3_sha3",
}

var EthereumSubscriptionMethods = []string{"eth_subscribe", "eth_unsubscribe"}

var AvalancheAVAXMethods = []string{
	"avax.getAtomicTx", "avax.getAtomicTxStatus", "avax.getUTXOs", "avax.issueTx",
}

var AvalancheXChainMethods = []string{
	"avm.buildGenesis", "avm.getAllBalances", "avm.getAssetDescription", "avm.getBalance",
	"avm.getBlockByHeight", "avm.getHeight", "avm.getTx", "avm.getTxFee", "avm.getTxStatus",
	"avm.getUTXOs", "avm.issueTx",
}

var AvalanchePChainMethods = []string{
	"platform.getAllValidatorsAt", "platform.getBalance", "platform.getBlockchainStatus",
	"platform.getBlockchains", "platform.getCurrentSupply", "platform.getCurrentValidators",
	"platform.getFeeConfig", "platform.getFeeState", "platform.getHeight", "platform.getMinStake",
	"platform.getRewardUTXOs", "platform.getStake", "platform.getStakingAssetID", "platform.getSubnets",
	"platform.getTimestamp", "platform.getTotalStake", "platform.getTx", "platform.getTxStatus",
	"platform.getUTXOs", "platform.getValidatorFeeConfig", "platform.getValidatorFeeState",
	"platform.getValidatorsAt", "platform.issueTx", "platform.sampleValidators", "platform.validatedBy",
	"platform.validates",
}

var AvalancheProposerVMMethods = []string{
	"proposervm.getCurrentEpoch", "proposervm.getProposedHeight",
}

var AvalancheInfoMethods = []string{"info.upgrades"}

var AvalancheIndexMethods = []string{
	"index.getContainerByID", "index.getContainerByIndex", "index.getContainerRange",
	"index.getIndex", "index.getLastAccepted", "index.isAccepted",
}
