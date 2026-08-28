import { ErpcBatchPolicyError } from '../errors'
import type { HttpJsonRpcTransport } from '../transport/http'
import { createRpcNamespace, type RpcNamespace } from './client'
import type {
  JsonObject,
  JsonValue,
  RpcBatchCall,
  RpcMethodSpec,
} from './types'

export type SolanaCommitment = 'confirmed' | 'finalized' | 'processed'
export type SolanaEncoding = 'base58' | 'base64' | 'base64+zstd' | 'jsonParsed'
export type SolanaConfig = Readonly<Record<string, unknown>>

export interface SolanaContext {
  readonly apiVersion?: string
  readonly slot: number
}

export interface SolanaContextResult<TValue> {
  readonly context: SolanaContext
  readonly value: TValue
}

export interface PriorityFeeEstimate {
  readonly priorityFeeEstimate: number
  readonly [key: string]: unknown
}

export interface SolanaRpcSchema {
  readonly getAccountInfo: RpcMethodSpec<
    readonly [address: string, config?: SolanaConfig],
    SolanaContextResult<JsonValue | null>
  >
  readonly getBalance: RpcMethodSpec<
    readonly [address: string, config?: SolanaConfig],
    SolanaContextResult<number>
  >
  readonly getBlock: RpcMethodSpec<
    readonly [slot: number, config?: SolanaConfig],
    JsonValue | null
  >
  readonly getBlockCommitment: RpcMethodSpec<
    readonly [slot: number],
    JsonValue
  >
  readonly getBlockHeight: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    number
  >
  readonly getBlockProduction: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getBlockTime: RpcMethodSpec<
    readonly [slot: number],
    number | null
  >
  readonly getBlocks: RpcMethodSpec<
    readonly [startSlot: number, endSlot?: number, commitment?: SolanaCommitment],
    readonly number[]
  >
  readonly getBlocksWithLimit: RpcMethodSpec<
    readonly [startSlot: number, limit: number, commitment?: SolanaCommitment],
    readonly number[]
  >
  readonly getClusterNodes: RpcMethodSpec<readonly [], JsonValue>
  readonly getEpochInfo: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getEpochSchedule: RpcMethodSpec<readonly [], JsonValue>
  readonly getFeeForMessage: RpcMethodSpec<
    readonly [message: string, config?: SolanaConfig],
    SolanaContextResult<number | null>
  >
  readonly getFirstAvailableBlock: RpcMethodSpec<readonly [], number>
  readonly getGenesisHash: RpcMethodSpec<readonly [], string>
  readonly getHealth: RpcMethodSpec<readonly [], string>
  readonly getHighestSnapshotSlot: RpcMethodSpec<readonly [], JsonValue>
  readonly getIdentity: RpcMethodSpec<readonly [], JsonValue>
  readonly getInflationGovernor: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getInflationRate: RpcMethodSpec<readonly [], JsonValue>
  readonly getInflationReward: RpcMethodSpec<
    readonly [addresses: readonly string[], config?: SolanaConfig],
    JsonValue
  >
  readonly getLargestAccounts: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getLatestBlockhash: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getLeaderSchedule: RpcMethodSpec<
    readonly [slot?: number | null, config?: SolanaConfig],
    JsonValue | null
  >
  readonly getMaxRetransmitSlot: RpcMethodSpec<readonly [], number>
  readonly getMaxShredInsertSlot: RpcMethodSpec<readonly [], number>
  readonly getMinimumBalanceForRentExemption: RpcMethodSpec<
    readonly [dataLength: number, config?: SolanaConfig],
    number
  >
  readonly getMultipleAccounts: RpcMethodSpec<
    readonly [addresses: readonly string[], config?: SolanaConfig],
    SolanaContextResult<JsonValue>
  >
  readonly getParsedTransaction: RpcMethodSpec<
    readonly [signature: string, config?: SolanaConfig],
    JsonValue | null
  >
  readonly getPriorityFeeEstimate: RpcMethodSpec<
    readonly [request: SolanaConfig],
    PriorityFeeEstimate
  >
  readonly getProgramAccounts: RpcMethodSpec<
    readonly [programAddress: string, config?: SolanaConfig],
    JsonValue
  >
  readonly getProgramAccountsV2: RpcMethodSpec<
    readonly [programAddress: string, config: SolanaConfig],
    JsonValue
  >
  readonly getRecentPerformanceSamples: RpcMethodSpec<
    readonly [limit?: number],
    JsonValue
  >
  readonly getRecentPrioritizationFees: RpcMethodSpec<
    readonly [addresses?: readonly string[]],
    JsonValue
  >
  readonly getSignatureStatuses: RpcMethodSpec<
    readonly [signatures: readonly string[], config?: SolanaConfig],
    JsonValue
  >
  readonly getSignaturesForAddress: RpcMethodSpec<
    readonly [address: string, config?: SolanaConfig],
    JsonValue
  >
  readonly getSlot: RpcMethodSpec<readonly [config?: SolanaConfig], number>
  readonly getSlotLeader: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    string
  >
  readonly getSlotLeaders: RpcMethodSpec<
    readonly [startSlot: number, limit: number],
    readonly string[]
  >
  readonly getStakeMinimumDelegation: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    SolanaContextResult<number>
  >
  readonly getSupply: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly getTokenAccountBalance: RpcMethodSpec<
    readonly [address: string, config?: SolanaConfig],
    JsonValue
  >
  readonly getTokenAccountsByDelegate: RpcMethodSpec<
    readonly [delegate: string, filter: SolanaConfig, config?: SolanaConfig],
    JsonValue
  >
  readonly getTokenAccountsByOwner: RpcMethodSpec<
    readonly [owner: string, filter: SolanaConfig, config?: SolanaConfig],
    JsonValue
  >
  readonly getTokenLargestAccounts: RpcMethodSpec<
    readonly [mint: string, config?: SolanaConfig],
    JsonValue
  >
  readonly getTokenSupply: RpcMethodSpec<
    readonly [mint: string, config?: SolanaConfig],
    JsonValue
  >
  readonly getTransaction: RpcMethodSpec<
    readonly [signature: string, config?: SolanaConfig],
    JsonValue | null
  >
  readonly getTransactionCount: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    number
  >
  readonly getVersion: RpcMethodSpec<readonly [], JsonObject>
  readonly getVoteAccounts: RpcMethodSpec<
    readonly [config?: SolanaConfig],
    JsonValue
  >
  readonly isBlockhashValid: RpcMethodSpec<
    readonly [blockhash: string, config?: SolanaConfig],
    SolanaContextResult<boolean>
  >
  readonly minimumLedgerSlot: RpcMethodSpec<readonly [], number>
  readonly requestAirdrop: RpcMethodSpec<
    readonly [address: string, lamports: number, config?: SolanaConfig],
    string
  >
  readonly sendTransaction: RpcMethodSpec<
    readonly [transaction: string, config?: SolanaConfig],
    string
  >
  readonly simulateTransaction: RpcMethodSpec<
    readonly [transaction: string, config?: SolanaConfig],
    JsonValue
  >
}

export interface AssetRequest {
  readonly id: string
  readonly displayOptions?: Readonly<Record<string, boolean>>
}

export interface AssetBatchRequest {
  readonly ids: readonly string[]
  readonly displayOptions?: Readonly<Record<string, boolean>>
}

export interface AssetListRequest {
  readonly cursor?: string
  readonly limit?: number
  readonly page?: number
  readonly [key: string]: unknown
}

export type IndexedAsset = Readonly<Record<string, unknown>>
export type IndexedAssetProof = Readonly<Record<string, unknown>>

export interface IndexedAssetList<TItem = IndexedAsset> {
  readonly cursor?: string
  readonly items: readonly TItem[]
  readonly limit?: number
  readonly page?: number
  readonly total?: number
  readonly [key: string]: unknown
}

export interface SolanaDasSchema {
  readonly getAsset: RpcMethodSpec<AssetRequest, IndexedAsset | null>
  readonly getAssetBatch: RpcMethodSpec<
    AssetBatchRequest,
    readonly (IndexedAsset | null)[]
  >
  readonly getAssetProof: RpcMethodSpec<AssetRequest, IndexedAssetProof | null>
  readonly getAssetProofBatch: RpcMethodSpec<
    AssetBatchRequest,
    readonly (IndexedAssetProof | null)[]
  >
  readonly getAssetsByAuthority: RpcMethodSpec<
    AssetListRequest & { readonly authorityAddress: string },
    IndexedAssetList
  >
  readonly getAssetsByCreator: RpcMethodSpec<
    AssetListRequest & {
      readonly creatorAddress: string
      readonly onlyVerified?: boolean
    },
    IndexedAssetList
  >
  readonly getAssetsByGroup: RpcMethodSpec<
    AssetListRequest & {
      readonly groupKey: string
      readonly groupValue: string
    },
    IndexedAssetList
  >
  readonly getAssetsByOwner: RpcMethodSpec<
    AssetListRequest & { readonly ownerAddress: string },
    IndexedAssetList
  >
  readonly getNftEditions: RpcMethodSpec<
    AssetListRequest & { readonly mint: string },
    Readonly<Record<string, unknown>>
  >
  readonly getSignaturesForAsset: RpcMethodSpec<
    AssetListRequest & { readonly id: string },
    Readonly<Record<string, unknown>>
  >
  readonly getTokenAccounts: RpcMethodSpec<
    AssetListRequest,
    Readonly<Record<string, unknown>>
  >
  readonly getTokensByDelegate: RpcMethodSpec<
    AssetListRequest & { readonly delegate: string },
    Readonly<Record<string, unknown>>
  >
  readonly getTokensByOwner: RpcMethodSpec<
    AssetListRequest & { readonly owner: string },
    Readonly<Record<string, unknown>>
  >
  readonly searchAssets: RpcMethodSpec<AssetListRequest, IndexedAssetList>
}

export interface NumericFilter {
  readonly eq?: number
  readonly gt?: number
  readonly gte?: number
  readonly lt?: number
  readonly lte?: number
}

export interface AddressTransactionsOptions {
  readonly before?: string
  readonly commitment?: SolanaCommitment
  readonly encoding?: 'base58' | 'base64' | 'json'
  readonly filters?: Readonly<Record<string, unknown>>
  readonly limit?: number
  readonly maxSupportedTransactionVersion?: number
  readonly paginationToken?: string
  readonly sortOrder?: 'asc' | 'desc'
  readonly transactionDetails?: 'full' | 'signatures'
  readonly until?: string
}

export interface AddressTransaction {
  readonly blockTime: number | null
  readonly confirmationStatus: SolanaCommitment
  readonly err: unknown
  readonly memo: string | null
  readonly meta?: unknown
  readonly signature: string
  readonly slot: number
  readonly transaction?: unknown
  readonly transactionIndex: number
  readonly version?: unknown
  readonly [key: string]: unknown
}

export interface AddressTransactionPage {
  readonly data: readonly AddressTransaction[]
  readonly paginationToken: string | null
  readonly windowStart: number | null
}

export interface AddressTransfersOptions {
  readonly commitment?: SolanaCommitment
  readonly direction?: 'any' | 'in' | 'out'
  readonly filters?: {
    readonly amount?: NumericFilter
    readonly blockTime?: NumericFilter
    readonly slot?: NumericFilter
  }
  readonly limit?: number
  readonly mint?: string
  readonly paginationToken?: string
  readonly solMode?: 'merged' | 'separate'
  readonly sortOrder?: 'asc' | 'desc'
  readonly with?: string
}

export interface AddressTransfer {
  readonly amount: string
  readonly blockTime: number | null
  readonly confirmationStatus: 'finalized'
  readonly decimals: number
  readonly feeAmount: string | null
  readonly feeUiAmount: string | null
  readonly fromTokenAccount: string | null
  readonly fromUserAccount: string | null
  readonly innerInstructionIdx: number
  readonly instructionIdx: number
  readonly mint: string | null
  readonly signature: string
  readonly slot: number
  readonly toTokenAccount: string | null
  readonly toUserAccount: string | null
  readonly transactionIdx: number
  readonly type:
    | 'burn'
    | 'changeOwner'
    | 'mint'
    | 'transfer'
    | 'unwrap'
    | 'withdrawWithheldFee'
    | 'wrap'
  readonly uiAmount: string
  readonly [key: string]: unknown
}

export interface AddressTransferPage {
  readonly data: readonly AddressTransfer[]
  readonly paginationToken: string | null
  readonly windowStart: number | null
}

export interface SolanaHistorySchema {
  readonly getTransactionsForAddress: RpcMethodSpec<
    readonly [address: string, options?: AddressTransactionsOptions],
    AddressTransactionPage | null
  >
  readonly getTransfersByAddress: RpcMethodSpec<
    readonly [address: string, options?: AddressTransfersOptions],
    AddressTransferPage
  >
}

export interface PingMeasurement {
  readonly city: string | null
  readonly country: string | null
  readonly fromIp: string | null
  readonly icmpReplied: boolean
  readonly lat: number | null
  readonly lon: number | null
  readonly measuredAt: string | null
  readonly ms: number | null
  readonly org: string | null
  readonly postal: string | null
  readonly region: string | null
  readonly timezone: string | null
  readonly [key: string]: unknown
}

export interface LeaderSlot {
  readonly epoch: number
  readonly featureSet: string | null
  readonly gossipPort: number | null
  readonly gossipUpdatedAt: string | null
  readonly identity: string
  readonly ipAddress: string | null
  readonly leaderCity: string | null
  readonly leaderCountry: string | null
  readonly leaderLat: number | null
  readonly leaderLon: number | null
  readonly leaderOrg: string | null
  readonly leaderRegion: string | null
  readonly leaderTimezone: string | null
  readonly pingToLeaders: readonly PingMeasurement[]
  readonly rpcAddress: string | null
  readonly slot: string
  readonly stakeWeight: number
  readonly tpuPort: number | null
  readonly tpuQuicPort: number | null
  readonly version: string | null
  readonly [key: string]: unknown
}

export interface LeaderSlotsResult {
  readonly data: readonly LeaderSlot[]
  readonly message: string
  readonly success: boolean
  readonly total: number
  readonly [key: string]: unknown
}

export interface ValidatorInformation
  extends Omit<LeaderSlot, 'epoch' | 'slot'> {
  readonly gossipNodeId: number | null
  readonly slotCount: number
}

export interface ValidatorsInformationOptions {
  readonly country?: string
  readonly limit?: number
  readonly region?: string
}

export interface ValidatorsInformationResult {
  readonly data: readonly ValidatorInformation[]
  readonly epoch: number
  readonly message: string
  readonly success: boolean
  readonly total: number
  readonly totalValidators: number
  readonly [key: string]: unknown
}

export interface SolanaLeaderSchema {
  readonly getLeaderSlots: RpcMethodSpec<
    readonly [slot: number],
    LeaderSlotsResult
  >
  readonly getValidatorsInformation: RpcMethodSpec<
    readonly [options: ValidatorsInformationOptions],
    ValidatorsInformationResult
  >
}

export type AnalyticsTimeBound = number | string

export interface TopProgramsOptions {
  readonly includeVotes?: boolean
  readonly limit?: number
  readonly since?: AnalyticsTimeBound
  readonly until?: AnalyticsTimeBound
}

export interface TopProgramRow {
  readonly errors: string
  readonly invocations: string
  readonly program: string
  readonly total_cus: string
  readonly [key: string]: unknown
}

export type SlotStatsOptions =
  | { readonly slot: number }
  | { readonly fromSlot: number; readonly toSlot: number }

export interface SlotStatsRow {
  readonly block_time: number
  readonly non_vote_transaction_count: number
  readonly slot: number
  readonly transaction_count: number
  readonly vote_transaction_count: number
  readonly [key: string]: unknown
}

export interface TpsTimeseriesOptions {
  readonly bucketSec?: number
  readonly from: AnalyticsTimeBound
  readonly to: AnalyticsTimeBound
}

export interface TpsBucket {
  readonly bucket: number
  readonly non_vote_tps: number
  readonly total_tps: number
  readonly [key: string]: unknown
}

export interface EpochSummary {
  readonly distinct_programs: string
  readonly epoch: number
  readonly first_block_time: number
  readonly last_block_time: number
  readonly non_vote_txs: string
  readonly program_invocations: string
  readonly slots: string
  readonly total_txs: string
  readonly vote_txs: string
  readonly [key: string]: unknown
}

export interface ProgramStatsOptions {
  readonly bucketSec?: number
  readonly programIdBase58: string
  readonly since?: AnalyticsTimeBound
  readonly until?: AnalyticsTimeBound
}

export interface ProgramStatsBucket {
  readonly bucket: number
  readonly errors: string
  readonly invocations: string
  readonly total_cus: string
  readonly [key: string]: unknown
}

export interface SolanaAnalyticsSchema {
  readonly jetEpochSummary: RpcMethodSpec<
    readonly [options: { readonly epoch: number }],
    EpochSummary | null
  >
  readonly jetProgramStats: RpcMethodSpec<
    readonly [options: ProgramStatsOptions],
    readonly ProgramStatsBucket[]
  >
  readonly jetSlotStats: RpcMethodSpec<
    readonly [options: SlotStatsOptions],
    readonly SlotStatsRow[]
  >
  readonly jetTopPrograms: RpcMethodSpec<
    readonly [options: TopProgramsOptions],
    readonly TopProgramRow[]
  >
  readonly jetTpsTimeseries: RpcMethodSpec<
    readonly [options: TpsTimeseriesOptions],
    readonly TpsBucket[]
  >
}

export const SOLANA_RPC_METHODS = [
  'getAccountInfo',
  'getBalance',
  'getBlock',
  'getBlockCommitment',
  'getBlockHeight',
  'getBlockProduction',
  'getBlockTime',
  'getBlocks',
  'getBlocksWithLimit',
  'getClusterNodes',
  'getEpochInfo',
  'getEpochSchedule',
  'getFeeForMessage',
  'getFirstAvailableBlock',
  'getGenesisHash',
  'getHealth',
  'getHighestSnapshotSlot',
  'getIdentity',
  'getInflationGovernor',
  'getInflationRate',
  'getInflationReward',
  'getLargestAccounts',
  'getLatestBlockhash',
  'getLeaderSchedule',
  'getMaxRetransmitSlot',
  'getMaxShredInsertSlot',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getParsedTransaction',
  'getPriorityFeeEstimate',
  'getProgramAccounts',
  'getProgramAccountsV2',
  'getRecentPerformanceSamples',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getSlotLeader',
  'getSlotLeaders',
  'getStakeMinimumDelegation',
  'getSupply',
  'getTokenAccountBalance',
  'getTokenAccountsByDelegate',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getTransaction',
  'getTransactionCount',
  'getVersion',
  'getVoteAccounts',
  'isBlockhashValid',
  'minimumLedgerSlot',
  'requestAirdrop',
  'sendTransaction',
  'simulateTransaction',
] as const satisfies readonly (keyof SolanaRpcSchema)[]

export const SOLANA_DAS_METHODS = [
  'getAsset',
  'getAssetBatch',
  'getAssetProof',
  'getAssetProofBatch',
  'getAssetsByAuthority',
  'getAssetsByCreator',
  'getAssetsByGroup',
  'getAssetsByOwner',
  'getNftEditions',
  'getSignaturesForAsset',
  'getTokenAccounts',
  'getTokensByDelegate',
  'getTokensByOwner',
  'searchAssets',
] as const satisfies readonly (keyof SolanaDasSchema)[]

export const SOLANA_HISTORY_METHODS = [
  'getTransactionsForAddress',
  'getTransfersByAddress',
] as const satisfies readonly (keyof SolanaHistorySchema)[]

export const SOLANA_LEADER_METHODS = [
  'getLeaderSlots',
  'getValidatorsInformation',
] as const satisfies readonly (keyof SolanaLeaderSchema)[]

export const SOLANA_ANALYTICS_METHODS = [
  'jetEpochSummary',
  'jetProgramStats',
  'jetSlotStats',
  'jetTopPrograms',
  'jetTpsTimeseries',
] as const satisfies readonly (keyof SolanaAnalyticsSchema)[]

const heavyRpcMethods = new Set<string>([
  'getPriorityFeeEstimate',
  'getProgramAccounts',
  'getProgramAccountsV2',
  'getTokenLargestAccounts',
])

const validateStandardBatch = (calls: readonly RpcBatchCall[]) => {
  let containsHeavy = false
  let containsStandard = false
  for (const call of calls) {
    if (heavyRpcMethods.has(call.method)) containsHeavy = true
    else containsStandard = true
  }
  if (containsHeavy && containsStandard) {
    throw new ErpcBatchPolicyError(
      'Solana indexed and standard RPC methods cannot share a batch',
    )
  }
}

const rejectLeaderBatch = (calls: readonly RpcBatchCall[]) => {
  if (calls.length > 0) {
    throw new ErpcBatchPolicyError('Leader RPC methods do not support batching')
  }
}

export interface SolanaClient {
  readonly analytics: RpcNamespace<SolanaAnalyticsSchema>
  readonly das: RpcNamespace<SolanaDasSchema>
  readonly history: RpcNamespace<SolanaHistorySchema>
  readonly leaders: RpcNamespace<SolanaLeaderSchema>
  readonly rpc: RpcNamespace<SolanaRpcSchema>
}

export const createSolanaClient = (
  transport: HttpJsonRpcTransport,
): SolanaClient => ({
  rpc: createRpcNamespace<SolanaRpcSchema>({
    transport,
    parameterMode: 'positional',
    validateBatch: validateStandardBatch,
  }),
  das: createRpcNamespace<SolanaDasSchema>({
    transport,
    parameterMode: 'named',
  }),
  history: createRpcNamespace<SolanaHistorySchema>({
    transport,
    parameterMode: 'positional',
  }),
  leaders: createRpcNamespace<SolanaLeaderSchema>({
    transport,
    parameterMode: 'positional',
    validateBatch: rejectLeaderBatch,
  }),
  analytics: createRpcNamespace<SolanaAnalyticsSchema>({
    transport,
    parameterMode: 'positional',
  }),
})
