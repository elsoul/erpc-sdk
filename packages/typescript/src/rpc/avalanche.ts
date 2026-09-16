import { ErpcBatchPolicyError } from '../errors'
import type { HttpJsonRpcTransport } from '../transport/http'
import { createRpcNamespace, type RpcNamespace } from './client'
import {
  createEthereumClient,
  type EthereumClient,
} from './ethereum'
import type { JsonValue, RpcBatchCall, RpcMethodSpec } from './types'

export interface AvalancheEncodingParams {
  readonly encoding?: string
}

export interface AvalancheUtxoParams extends AvalancheEncodingParams {
  readonly addresses: readonly string[]
  readonly limit?: number | string
  readonly sourceChain?: string
  readonly startIndex?: Readonly<Record<string, JsonValue>>
}

export interface AvalancheAvaxSchema {
  readonly getAtomicTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly txID: string },
    JsonValue
  >
  readonly getAtomicTxStatus: RpcMethodSpec<
    { readonly txID: string },
    JsonValue
  >
  readonly getUTXOs: RpcMethodSpec<
    AvalancheUtxoParams & { readonly sourceChain: string },
    JsonValue
  >
  readonly issueTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly tx: string },
    JsonValue
  >
}

export interface AvalancheXChainSchema {
  readonly buildGenesis: RpcMethodSpec<
    AvalancheEncodingParams & {
      readonly genesisData: Readonly<Record<string, JsonValue>>
      readonly networkId: number | string
    },
    JsonValue
  >
  readonly getAllBalances: RpcMethodSpec<{ readonly address: string }, JsonValue>
  readonly getAssetDescription: RpcMethodSpec<
    { readonly assetID: string },
    JsonValue
  >
  readonly getBalance: RpcMethodSpec<
    { readonly address: string; readonly assetID: string },
    JsonValue
  >
  readonly getBlockByHeight: RpcMethodSpec<
    AvalancheEncodingParams & { readonly height: number | string },
    JsonValue
  >
  readonly getHeight: RpcMethodSpec<undefined, JsonValue>
  readonly getTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly txID: string },
    JsonValue
  >
  readonly getTxFee: RpcMethodSpec<undefined, JsonValue>
  readonly getTxStatus: RpcMethodSpec<{ readonly txID: string }, JsonValue>
  readonly getUTXOs: RpcMethodSpec<AvalancheUtxoParams, JsonValue>
  readonly issueTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly tx: string },
    JsonValue
  >
}

export interface AvalanchePChainSchema {
  readonly getAllValidatorsAt: RpcMethodSpec<
    { readonly height: number | string },
    JsonValue
  >
  readonly getBalance: RpcMethodSpec<
    { readonly addresses?: readonly string[] },
    JsonValue
  >
  readonly getBlockchainStatus: RpcMethodSpec<
    { readonly blockchainID?: string },
    JsonValue
  >
  readonly getBlockchains: RpcMethodSpec<undefined, JsonValue>
  readonly getCurrentSupply: RpcMethodSpec<undefined, JsonValue>
  readonly getCurrentValidators: RpcMethodSpec<
    { readonly nodeIDs?: readonly string[]; readonly subnetID?: string },
    JsonValue
  >
  readonly getFeeConfig: RpcMethodSpec<undefined, JsonValue>
  readonly getFeeState: RpcMethodSpec<undefined, JsonValue>
  readonly getHeight: RpcMethodSpec<undefined, JsonValue>
  readonly getMinStake: RpcMethodSpec<undefined, JsonValue>
  readonly getRewardUTXOs: RpcMethodSpec<
    AvalancheEncodingParams & { readonly txID?: string },
    JsonValue
  >
  readonly getStake: RpcMethodSpec<
    AvalancheEncodingParams & {
      readonly addresses?: readonly string[]
      readonly validatorsOnly?: boolean
    },
    JsonValue
  >
  readonly getStakingAssetID: RpcMethodSpec<
    { readonly subnetID?: string },
    JsonValue
  >
  readonly getSubnets: RpcMethodSpec<
    { readonly ids?: readonly string[] },
    JsonValue
  >
  readonly getTimestamp: RpcMethodSpec<undefined, JsonValue>
  readonly getTotalStake: RpcMethodSpec<
    { readonly subnetID?: string },
    JsonValue
  >
  readonly getTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly txID: string },
    JsonValue
  >
  readonly getTxStatus: RpcMethodSpec<{ readonly txID: string }, JsonValue>
  readonly getUTXOs: RpcMethodSpec<AvalancheUtxoParams, JsonValue>
  readonly getValidatorFeeConfig: RpcMethodSpec<undefined, JsonValue>
  readonly getValidatorFeeState: RpcMethodSpec<undefined, JsonValue>
  readonly getValidatorsAt: RpcMethodSpec<
    { readonly height: number | string; readonly subnetID?: string },
    JsonValue
  >
  readonly issueTx: RpcMethodSpec<
    AvalancheEncodingParams & { readonly tx: string },
    JsonValue
  >
  readonly sampleValidators: RpcMethodSpec<
    { readonly size: number | string; readonly subnetID?: string },
    JsonValue
  >
  readonly validatedBy: RpcMethodSpec<
    { readonly blockchainID: string },
    JsonValue
  >
  readonly validates: RpcMethodSpec<{ readonly subnetID: string }, JsonValue>
}

export interface AvalancheProposerVmSchema {
  readonly getCurrentEpoch: RpcMethodSpec<undefined, JsonValue>
  readonly getProposedHeight: RpcMethodSpec<undefined, JsonValue>
}

export interface AvalancheInfoSchema {
  readonly upgrades: RpcMethodSpec<undefined, JsonValue>
}

export interface AvalancheIndexSchema {
  readonly getContainerByID: RpcMethodSpec<
    AvalancheEncodingParams & { readonly id: string },
    JsonValue
  >
  readonly getContainerByIndex: RpcMethodSpec<
    AvalancheEncodingParams & { readonly index: number | string },
    JsonValue
  >
  readonly getContainerRange: RpcMethodSpec<
    AvalancheEncodingParams & {
      readonly numToFetch: number | string
      readonly startIndex: number | string
    },
    JsonValue
  >
  readonly getIndex: RpcMethodSpec<
    AvalancheEncodingParams & { readonly containerID: string },
    JsonValue
  >
  readonly getLastAccepted: RpcMethodSpec<AvalancheEncodingParams, JsonValue>
  readonly isAccepted: RpcMethodSpec<
    AvalancheEncodingParams & { readonly containerID: string },
    JsonValue
  >
}

export const AVALANCHE_AVAX_METHODS = [
  'avax.getAtomicTx',
  'avax.getAtomicTxStatus',
  'avax.getUTXOs',
  'avax.issueTx',
] as const

export const AVALANCHE_X_CHAIN_METHODS = [
  'avm.buildGenesis',
  'avm.getAllBalances',
  'avm.getAssetDescription',
  'avm.getBalance',
  'avm.getBlockByHeight',
  'avm.getHeight',
  'avm.getTx',
  'avm.getTxFee',
  'avm.getTxStatus',
  'avm.getUTXOs',
  'avm.issueTx',
] as const

export const AVALANCHE_P_CHAIN_METHODS = [
  'platform.getAllValidatorsAt',
  'platform.getBalance',
  'platform.getBlockchainStatus',
  'platform.getBlockchains',
  'platform.getCurrentSupply',
  'platform.getCurrentValidators',
  'platform.getFeeConfig',
  'platform.getFeeState',
  'platform.getHeight',
  'platform.getMinStake',
  'platform.getRewardUTXOs',
  'platform.getStake',
  'platform.getStakingAssetID',
  'platform.getSubnets',
  'platform.getTimestamp',
  'platform.getTotalStake',
  'platform.getTx',
  'platform.getTxStatus',
  'platform.getUTXOs',
  'platform.getValidatorFeeConfig',
  'platform.getValidatorFeeState',
  'platform.getValidatorsAt',
  'platform.issueTx',
  'platform.sampleValidators',
  'platform.validatedBy',
  'platform.validates',
] as const

export const AVALANCHE_PROPOSER_VM_METHODS = [
  'proposervm.getCurrentEpoch',
  'proposervm.getProposedHeight',
] as const

export const AVALANCHE_INFO_METHODS = ['info.upgrades'] as const

export const AVALANCHE_INDEX_METHODS = [
  'index.getContainerByID',
  'index.getContainerByIndex',
  'index.getContainerRange',
  'index.getIndex',
  'index.getLastAccepted',
  'index.isAccepted',
] as const

const rejectNativeBatch = (calls: readonly RpcBatchCall[]) => {
  if (calls.length > 0) {
    throw new ErpcBatchPolicyError(
      'Avalanche native RPC methods do not support batching',
    )
  }
}

const nativeNamespace = <
  TSchema extends {
    readonly [TMethod in keyof TSchema]: RpcMethodSpec<
      object | readonly unknown[] | undefined,
      unknown
    >
  },
>(transport: HttpJsonRpcTransport, methodPrefix: string) =>
  createRpcNamespace<TSchema>({
    methodPrefix,
    parameterMode: 'named',
    transport,
    validateBatch: rejectNativeBatch,
  })

export interface AvalancheIndexClient {
  readonly cChainBlocks: RpcNamespace<AvalancheIndexSchema>
  readonly pChainBlocks: RpcNamespace<AvalancheIndexSchema>
  readonly xChainBlocks: RpcNamespace<AvalancheIndexSchema>
  readonly xChainTransactions: RpcNamespace<AvalancheIndexSchema>
}

export interface AvalancheClient extends EthereumClient {
  readonly avax: RpcNamespace<AvalancheAvaxSchema>
  readonly index: AvalancheIndexClient
  readonly info: RpcNamespace<AvalancheInfoSchema>
  readonly pChain: RpcNamespace<AvalanchePChainSchema>
  readonly proposerVm: RpcNamespace<AvalancheProposerVmSchema>
  readonly xChain: RpcNamespace<AvalancheXChainSchema>
}

export interface AvalancheIndexTransports {
  readonly cChainBlocks: HttpJsonRpcTransport
  readonly pChainBlocks: HttpJsonRpcTransport
  readonly xChainBlocks: HttpJsonRpcTransport
  readonly xChainTransactions: HttpJsonRpcTransport
}

export const createAvalancheClient = (
  transport: HttpJsonRpcTransport,
  indexTransports: AvalancheIndexTransports,
  nativeTransport: HttpJsonRpcTransport = transport,
): AvalancheClient => ({
  ...createEthereumClient(transport),
  avax: nativeNamespace<AvalancheAvaxSchema>(nativeTransport, 'avax'),
  xChain: nativeNamespace<AvalancheXChainSchema>(nativeTransport, 'avm'),
  pChain: nativeNamespace<AvalanchePChainSchema>(nativeTransport, 'platform'),
  proposerVm: nativeNamespace<AvalancheProposerVmSchema>(
    nativeTransport,
    'proposervm',
  ),
  info: nativeNamespace<AvalancheInfoSchema>(nativeTransport, 'info'),
  index: {
    cChainBlocks: nativeNamespace<AvalancheIndexSchema>(
      indexTransports.cChainBlocks,
      'index',
    ),
    pChainBlocks: nativeNamespace<AvalancheIndexSchema>(
      indexTransports.pChainBlocks,
      'index',
    ),
    xChainBlocks: nativeNamespace<AvalancheIndexSchema>(
      indexTransports.xChainBlocks,
      'index',
    ),
    xChainTransactions: nativeNamespace<AvalancheIndexSchema>(
      indexTransports.xChainTransactions,
      'index',
    ),
  },
})
