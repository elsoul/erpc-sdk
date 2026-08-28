import type { HttpJsonRpcTransport } from '../transport/http'
import { createRpcNamespace, type RpcNamespace } from './client'
import type { JsonValue, RpcMethodSpec } from './types'

export type Hex = `0x${string}`
export type EthereumAddress = Hex
export type EthereumBlockTag =
  | 'earliest'
  | 'finalized'
  | 'latest'
  | 'pending'
  | 'safe'
  | Hex

export type EthereumObject = Readonly<Record<string, unknown>>
export type EthereumTransactionRequest = EthereumObject
export type EthereumFilter = EthereumObject

export interface EthereumRpcSchema {
  readonly eth_accounts: RpcMethodSpec<readonly [], readonly EthereumAddress[]>
  readonly eth_baseFee: RpcMethodSpec<readonly [], Hex>
  readonly eth_blobBaseFee: RpcMethodSpec<readonly [], Hex>
  readonly eth_blockNumber: RpcMethodSpec<readonly [], Hex>
  readonly eth_call: RpcMethodSpec<
    readonly [
      transaction: EthereumTransactionRequest,
      block?: EthereumBlockTag,
      stateOverride?: EthereumObject,
    ],
    Hex
  >
  readonly eth_callMany: RpcMethodSpec<
    readonly [
      calls: readonly EthereumObject[],
      simulationContext?: EthereumObject,
      stateOverride?: EthereumObject,
      timeout?: number,
    ],
    JsonValue
  >
  readonly eth_capabilities: RpcMethodSpec<readonly [], JsonValue>
  readonly eth_chainId: RpcMethodSpec<readonly [], Hex>
  readonly eth_createAccessList: RpcMethodSpec<
    readonly [
      transaction: EthereumTransactionRequest,
      block?: EthereumBlockTag,
    ],
    JsonValue
  >
  readonly eth_estimateGas: RpcMethodSpec<
    readonly [
      transaction: EthereumTransactionRequest,
      block?: EthereumBlockTag,
      stateOverride?: EthereumObject,
    ],
    Hex
  >
  readonly eth_feeHistory: RpcMethodSpec<
    readonly [
      blockCount: Hex,
      newestBlock: EthereumBlockTag,
      rewardPercentiles: readonly number[],
    ],
    JsonValue
  >
  readonly eth_gasPrice: RpcMethodSpec<readonly [], Hex>
  readonly eth_getAccount: RpcMethodSpec<
    readonly [address: EthereumAddress, block: EthereumBlockTag],
    JsonValue
  >
  readonly eth_getBalance: RpcMethodSpec<
    readonly [address: EthereumAddress, block?: EthereumBlockTag],
    Hex
  >
  readonly eth_getBlockByHash: RpcMethodSpec<
    readonly [hash: Hex, includeTransactions: boolean],
    JsonValue | null
  >
  readonly eth_getBlockByNumber: RpcMethodSpec<
    readonly [block: EthereumBlockTag, includeTransactions: boolean],
    JsonValue | null
  >
  readonly eth_getBlockReceipts: RpcMethodSpec<
    readonly [block: EthereumBlockTag],
    JsonValue | null
  >
  readonly eth_getBlockTransactionCountByHash: RpcMethodSpec<
    readonly [hash: Hex],
    Hex | null
  >
  readonly eth_getBlockTransactionCountByNumber: RpcMethodSpec<
    readonly [block: EthereumBlockTag],
    Hex | null
  >
  readonly eth_getCode: RpcMethodSpec<
    readonly [address: EthereumAddress, block?: EthereumBlockTag],
    Hex
  >
  readonly eth_getFilterChanges: RpcMethodSpec<readonly [filterId: Hex], JsonValue>
  readonly eth_getFilterLogs: RpcMethodSpec<readonly [filterId: Hex], JsonValue>
  readonly eth_getLogs: RpcMethodSpec<
    readonly [filter?: EthereumFilter],
    JsonValue
  >
  readonly eth_getProof: RpcMethodSpec<
    readonly [
      address: EthereumAddress,
      storageKeys: readonly Hex[],
      block: EthereumBlockTag,
    ],
    JsonValue
  >
  readonly eth_getRawTransactionByHash: RpcMethodSpec<
    readonly [hash: Hex],
    Hex | null
  >
  readonly eth_getStorageAt: RpcMethodSpec<
    readonly [
      address: EthereumAddress,
      position: Hex,
      block?: EthereumBlockTag,
    ],
    Hex
  >
  readonly eth_getTransactionByBlockHashAndIndex: RpcMethodSpec<
    readonly [blockHash: Hex, index: Hex],
    JsonValue | null
  >
  readonly eth_getTransactionByBlockNumberAndIndex: RpcMethodSpec<
    readonly [block: EthereumBlockTag, index: Hex],
    JsonValue | null
  >
  readonly eth_getTransactionByHash: RpcMethodSpec<
    readonly [hash: Hex],
    JsonValue | null
  >
  readonly eth_getTransactionBySenderAndNonce: RpcMethodSpec<
    readonly [sender: EthereumAddress, nonce: Hex],
    JsonValue | null
  >
  readonly eth_getTransactionCount: RpcMethodSpec<
    readonly [address: EthereumAddress, block?: EthereumBlockTag],
    Hex
  >
  readonly eth_getTransactionReceipt: RpcMethodSpec<
    readonly [hash: Hex],
    JsonValue | null
  >
  readonly eth_getUncleCountByBlockHash: RpcMethodSpec<
    readonly [hash: Hex],
    Hex
  >
  readonly eth_getUncleCountByBlockNumber: RpcMethodSpec<
    readonly [block: EthereumBlockTag],
    Hex
  >
  readonly eth_maxPriorityFeePerGas: RpcMethodSpec<readonly [], Hex>
  readonly eth_newBlockFilter: RpcMethodSpec<readonly [], Hex>
  readonly eth_newFilter: RpcMethodSpec<
    readonly [filter?: EthereumFilter],
    Hex
  >
  readonly eth_newPendingTransactionFilter: RpcMethodSpec<readonly [], Hex>
  readonly eth_sendRawTransaction: RpcMethodSpec<
    readonly [transaction: Hex],
    Hex
  >
  readonly eth_signTransaction: RpcMethodSpec<
    readonly [transaction: EthereumTransactionRequest],
    Hex
  >
  readonly eth_simulateV1: RpcMethodSpec<
    readonly [simulation: EthereumObject, block?: EthereumBlockTag],
    JsonValue
  >
  readonly eth_submitWork: RpcMethodSpec<
    readonly [nonce: Hex, proofOfWorkHash: Hex, digest: Hex],
    boolean
  >
  readonly eth_syncing: RpcMethodSpec<readonly [], boolean | JsonValue>
  readonly eth_uninstallFilter: RpcMethodSpec<readonly [filterId: Hex], boolean>
  readonly net_listening: RpcMethodSpec<readonly [], boolean>
  readonly net_peerCount: RpcMethodSpec<readonly [], Hex>
  readonly net_version: RpcMethodSpec<readonly [], string>
  readonly txpool_content: RpcMethodSpec<readonly [], JsonValue>
  readonly txpool_contentFrom: RpcMethodSpec<
    readonly [address: EthereumAddress],
    JsonValue
  >
  readonly txpool_inspect: RpcMethodSpec<readonly [], JsonValue>
  readonly txpool_status: RpcMethodSpec<readonly [], JsonValue>
  readonly web3_clientVersion: RpcMethodSpec<readonly [], string>
  readonly web3_sha3: RpcMethodSpec<readonly [data: Hex], Hex>
}

export interface EthereumSubscriptionSchema {
  readonly eth_subscribe: RpcMethodSpec<
    readonly [subscription: string, ...options: readonly unknown[]],
    string
  >
  readonly eth_unsubscribe: RpcMethodSpec<
    readonly [subscriptionId: string],
    boolean
  >
}

export const ETHEREUM_RPC_METHODS = [
  'eth_accounts',
  'eth_baseFee',
  'eth_blobBaseFee',
  'eth_blockNumber',
  'eth_call',
  'eth_callMany',
  'eth_capabilities',
  'eth_chainId',
  'eth_createAccessList',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getAccount',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_getLogs',
  'eth_getProof',
  'eth_getRawTransactionByHash',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionBySenderAndNonce',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getUncleCountByBlockHash',
  'eth_getUncleCountByBlockNumber',
  'eth_maxPriorityFeePerGas',
  'eth_newBlockFilter',
  'eth_newFilter',
  'eth_newPendingTransactionFilter',
  'eth_sendRawTransaction',
  'eth_signTransaction',
  'eth_simulateV1',
  'eth_submitWork',
  'eth_syncing',
  'eth_uninstallFilter',
  'net_listening',
  'net_peerCount',
  'net_version',
  'txpool_content',
  'txpool_contentFrom',
  'txpool_inspect',
  'txpool_status',
  'web3_clientVersion',
  'web3_sha3',
] as const satisfies readonly (keyof EthereumRpcSchema)[]

export const ETHEREUM_SUBSCRIPTION_METHODS = [
  'eth_subscribe',
  'eth_unsubscribe',
] as const satisfies readonly (keyof EthereumSubscriptionSchema)[]

export interface EthereumClient {
  readonly rpc: RpcNamespace<EthereumRpcSchema>
}

export const createEthereumClient = (
  transport: HttpJsonRpcTransport,
): EthereumClient => ({
  rpc: createRpcNamespace<EthereumRpcSchema>({
    transport,
    parameterMode: 'positional',
  }),
})
