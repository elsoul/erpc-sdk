# Method availability

Last reviewed: 2026-09-04

“Available” means the method is exposed by the current ERPC service and has a
typed SDK entry point. The raw request API remains available for forward
compatibility.

The TypeScript, Rust, Python, Go, and Ruby packages share these ordered wire
catalogs. Each package exposes idiomatic helper names while preserving the
method strings shown below at the JSON-RPC boundary.

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

### Avalanche JSON-RPC

[Avalanche C-Chain](https://build.avax.network/docs/rpcs/c-chain/api)
(`erpc.avalanche.rpc`) exposes the same 53 typed EVM-compatible HTTP methods
listed for Ethereum above. Its WebSocket namespace
(`erpc.avalanche.subscriptions`) exposes `eth_subscribe` and `eth_unsubscribe`.
Avalanche-specific subscription names such as `newAcceptedTransactions` can be
passed to `subscribe`, and additional C-Chain methods remain available through
the namespace's raw request API.

The native-chain namespaces expose 44 methods through `/ava`; calls with
parameters use named objects. The SDK-facing method omits the prefix shown
below; for example,
`erpc.avalanche.pChain.getHeight()` sends `platform.getHeight`.

C-Chain AVAX API (`erpc.avalanche.avax`, 4):

```text
avax.getAtomicTx
avax.getAtomicTxStatus
avax.getUTXOs
avax.issueTx
```

X-Chain API (`erpc.avalanche.xChain`, 11):

```text
avm.buildGenesis
avm.getAllBalances
avm.getAssetDescription
avm.getBalance
avm.getBlockByHeight
avm.getHeight
avm.getTx
avm.getTxFee
avm.getTxStatus
avm.getUTXOs
avm.issueTx
```

P-Chain API (`erpc.avalanche.pChain`, 26):

```text
platform.getAllValidatorsAt
platform.getBalance
platform.getBlockchainStatus
platform.getBlockchains
platform.getCurrentSupply
platform.getCurrentValidators
platform.getFeeConfig
platform.getFeeState
platform.getHeight
platform.getMinStake
platform.getRewardUTXOs
platform.getStake
platform.getStakingAssetID
platform.getSubnets
platform.getTimestamp
platform.getTotalStake
platform.getTx
platform.getTxStatus
platform.getUTXOs
platform.getValidatorFeeConfig
platform.getValidatorFeeState
platform.getValidatorsAt
platform.issueTx
platform.sampleValidators
platform.validatedBy
platform.validates
```

P-Chain proposer VM and network information APIs (3):

```text
proposervm.getCurrentEpoch
proposervm.getProposedHeight
info.upgrades
```

The [Index API](https://build.avax.network/docs/rpcs/other/index-rpc) exposes the
same six methods on four explicit routes:

| SDK namespace | HTTP route |
| --- | --- |
| `erpc.avalanche.index.cChainBlocks` | `/ava/ext/index/C/block` |
| `erpc.avalanche.index.pChainBlocks` | `/ava/ext/index/P/block` |
| `erpc.avalanche.index.xChainBlocks` | `/ava/ext/index/X/block` |
| `erpc.avalanche.index.xChainTransactions` | `/ava/ext/index/X/tx` |

```text
index.getContainerByID
index.getContainerByIndex
index.getContainerRange
index.getIndex
index.getLastAccepted
index.isAccepted
```

Rust, Python, and Ruby use snake_case member names; Go uses exported PascalCase
members and `Request`. Native-chain and Index API batches are rejected locally.
The C-Chain EVM namespace continues to preserve and send valid batches intact.

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
getMonthlyApiKeyUsage
```

`getMonthlyApiKeyUsage` is exposed as `erpc.usage.getMonthlyApiKeyUsage` and
returns masked API-key identifiers.

## Planned after server availability

The SDK will add typed entries after ERPC exposes and verifies each capability:

- paginated token-account-by-owner V2 queries;
- compressed-state and zero-knowledge RPC namespaces;
- preconfirmation subscriptions;
- Ethereum debug and trace namespaces;
- Ethereum execution-client-specific namespaces;
- Ethereum consensus-layer APIs;
- optional add-on namespaces.

The planned protocol entries above are deliberately not represented as working
SDK methods today. This keeps compile-time availability aligned with production
behavior.

The scoped OAuth Cloud read client is already typed as
`createErpcCloudClient`. Its read-only entries are:

```text
cloud.catalog.list
cloud.credit.get
cloud.resources.list
cloud.resources.get
cloud.resources.getStatus
cloud.usage.getMonthlyApiKeyUsage
```

These entries become production-available with the coordinated Cloud OAuth and
user API rollout.
