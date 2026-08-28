# Method availability

Last reviewed: 2026-08-28

“Available” means the method is exposed by the current ERPC service and has a
typed SDK entry point. The raw request API remains available for forward
compatibility.

## Available now

### Solana JSON-RPC

Standard and edge-compatible methods (`erpc.solana.rpc`, 55):

```text
getAccountInfo
getBalance
getBlock
getBlockCommitment
getBlockHeight
getBlockProduction
getBlockTime
getBlocks
getBlocksWithLimit
getClusterNodes
getEpochInfo
getEpochSchedule
getFeeForMessage
getFirstAvailableBlock
getGenesisHash
getHealth
getHighestSnapshotSlot
getIdentity
getInflationGovernor
getInflationRate
getInflationReward
getLargestAccounts
getLatestBlockhash
getLeaderSchedule
getMaxRetransmitSlot
getMaxShredInsertSlot
getMinimumBalanceForRentExemption
getMultipleAccounts
getParsedTransaction
getPriorityFeeEstimate
getProgramAccounts
getProgramAccountsV2
getRecentPerformanceSamples
getRecentPrioritizationFees
getSignatureStatuses
getSignaturesForAddress
getSlot
getSlotLeader
getSlotLeaders
getStakeMinimumDelegation
getSupply
getTokenAccountBalance
getTokenAccountsByDelegate
getTokenAccountsByOwner
getTokenLargestAccounts
getTokenSupply
getTransaction
getTransactionCount
getVersion
getVoteAccounts
isBlockhashValid
minimumLedgerSlot
requestAirdrop
sendTransaction
simulateTransaction
```

Indexed asset methods (`erpc.solana.das`, 14):

```text
getAsset
getAssetBatch
getAssetProof
getAssetProofBatch
getAssetsByAuthority
getAssetsByCreator
getAssetsByGroup
getAssetsByOwner
getNftEditions
getSignaturesForAsset
getTokenAccounts
getTokensByDelegate
getTokensByOwner
searchAssets
```

Indexed history methods (`erpc.solana.history`, 2):

```text
getTransactionsForAddress
getTransfersByAddress
```

Leader and validator methods (`erpc.solana.leaders`, 2):

```text
getLeaderSlots
getValidatorsInformation
```

Analytics methods (`erpc.solana.analytics`, 5):

```text
jetEpochSummary
jetProgramStats
jetSlotStats
jetTopPrograms
jetTpsTimeseries
```

Enhanced subscription methods (`erpc.solana.subscriptions`, 4):

```text
accountSubscribe
accountUnsubscribe
transactionSubscribe
transactionUnsubscribe
```

### Ethereum JSON-RPC

HTTP methods (`erpc.ethereum.rpc`, 53):

```text
eth_accounts
eth_baseFee
eth_blobBaseFee
eth_blockNumber
eth_call
eth_callMany
eth_capabilities
eth_chainId
eth_createAccessList
eth_estimateGas
eth_feeHistory
eth_gasPrice
eth_getAccount
eth_getBalance
eth_getBlockByHash
eth_getBlockByNumber
eth_getBlockReceipts
eth_getBlockTransactionCountByHash
eth_getBlockTransactionCountByNumber
eth_getCode
eth_getFilterChanges
eth_getFilterLogs
eth_getLogs
eth_getProof
eth_getRawTransactionByHash
eth_getStorageAt
eth_getTransactionByBlockHashAndIndex
eth_getTransactionByBlockNumberAndIndex
eth_getTransactionByHash
eth_getTransactionBySenderAndNonce
eth_getTransactionCount
eth_getTransactionReceipt
eth_getUncleCountByBlockHash
eth_getUncleCountByBlockNumber
eth_maxPriorityFeePerGas
eth_newBlockFilter
eth_newFilter
eth_newPendingTransactionFilter
eth_sendRawTransaction
eth_signTransaction
eth_simulateV1
eth_submitWork
eth_syncing
eth_uninstallFilter
net_listening
net_peerCount
net_version
txpool_content
txpool_contentFrom
txpool_inspect
txpool_status
web3_clientVersion
web3_sha3
```

WebSocket methods (`erpc.ethereum.subscriptions`, 2):

```text
eth_subscribe
eth_unsubscribe
```

### Price API

REST and server-sent event methods (`erpc.price`, 5):

```text
getPriceFeeds
getLatestPriceUpdates
getPriceUpdatesAtTimestamp
getLatestPublisherStakeCaps
streamPriceUpdates
```

### ERPC account

```text
getTokenBalance
```

## Planned after server availability

The SDK will add typed entries after ERPC exposes and verifies each capability:

- paginated token-account-by-owner V2 queries;
- compressed-state and zero-knowledge RPC namespaces;
- preconfirmation subscriptions;
- Ethereum debug and trace namespaces;
- Ethereum execution-client-specific namespaces;
- Ethereum consensus-layer APIs;
- optional add-on namespaces.

These are deliberately not represented as working SDK methods today. This
keeps compile-time availability aligned with production behavior.
