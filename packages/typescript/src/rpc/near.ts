import { PendingRpcRequest, type JsonRpcTransport } from './client'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import { ErpcConfigError, ErpcInvalidResponseError } from '../errors'
import type { RpcSendOptions } from './types'

interface GeneratedCapability { readonly wireOperation: string }
interface GeneratedMethodSet {
  readonly methodSetId: string
  readonly capabilities?: readonly GeneratedCapability[]
}
interface GeneratedContract { readonly methodSets: readonly GeneratedMethodSet[] }

const methodSet = (RPC_NETWORK_CONTRACT as unknown as GeneratedContract).methodSets
  .find((candidate) => candidate.methodSetId === 'near-read3')
if (methodSet?.capabilities === undefined) throw new Error('Missing generated NEAR method set')

export const NEAR_RPC_METHODS = Object.freeze(
  methodSet.capabilities.map(({ wireOperation }) => wireOperation),
)

const U64_MAX = 18_446_744_073_709_551_615n

export class NearJsonNumber {
  readonly value: string

  constructor(value: string) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
      throw new ErpcInvalidResponseError()
    }
    this.value = value
    Object.freeze(this)
  }

  toString(): string { return this.value }
}

export type NearJsonPrimitive = boolean | null | string | NearJsonNumber
export type NearJsonValue =
  | NearJsonPrimitive
  | readonly NearJsonValue[]
  | { readonly [key: string]: NearJsonValue }

export type NearFinality = 'final' | 'optimistic'
export type NearBlockId = string | bigint
export type NearBlockReference =
  | { readonly finality: NearFinality }
  | { readonly blockId: NearBlockId }

export interface NearSyncInfo {
  readonly latestBlockHash: string
  readonly latestBlockHeight: bigint
  readonly latestBlockTime: string
  readonly latestStateRoot: string
  readonly syncing: boolean
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearNodeVersion {
  readonly version: string
  readonly build: string
  readonly rustcVersion?: string
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearStatus {
  readonly chainId: string
  readonly genesisHash: string
  readonly latestProtocolVersion: bigint
  readonly protocolVersion: bigint
  readonly syncInfo: NearSyncInfo
  readonly version: NearNodeVersion
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearBlockHeader {
  readonly hash: string
  readonly height: bigint
  readonly prevHash: string
  readonly timestamp: bigint
  readonly timestampNanosec: string
  readonly gasPrice: string
  readonly totalSupply: string
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearBlockView {
  readonly author: string
  readonly header: NearBlockHeader
  readonly chunks: readonly NearJsonValue[]
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearAccountView {
  readonly amount: string
  readonly locked: string
  readonly codeHash: string
  readonly storageUsage: bigint
  readonly storagePaidAt?: bigint
  readonly blockHeight: bigint
  readonly blockHash: string
  readonly state?: string
  readonly bootstrapNonce?: bigint
  readonly globalContractAccountId?: string
  readonly globalContractHash?: string
  readonly additional: Readonly<Record<string, NearJsonValue>>
}

export interface NearRpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
}

export interface NearReadRpcClient {
  readonly endpoint: string
  status(): PendingRpcRequest<NearStatus>
  block(reference: NearBlockReference): PendingRpcRequest<NearBlockView>
  viewAccount(accountId: string, reference: NearBlockReference): PendingRpcRequest<NearAccountView>
}

export interface ErpcNearClient { readonly rpc: NearReadRpcClient }

const invalid = (): ErpcInvalidResponseError => new ErpcInvalidResponseError()

const freezeValue = (value: NearJsonValue): NearJsonValue => {
  if (value instanceof NearJsonNumber || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    value.forEach((item) => freezeValue(item))
    return Object.freeze(value)
  }
  for (const item of Object.values(value)) freezeValue(item)
  return Object.freeze(value)
}

const objectValue = (value: NearJsonValue): Record<string, NearJsonValue> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof NearJsonNumber) throw invalid()
  return value as Record<string, NearJsonValue>
}

const stringValue = (value: NearJsonValue | undefined): string => {
  if (typeof value !== 'string') throw invalid()
  return value
}

const booleanValue = (value: NearJsonValue | undefined): boolean => {
  if (typeof value !== 'boolean') throw invalid()
  return value
}

const bigintValue = (value: NearJsonValue | undefined): bigint => {
  if (!(value instanceof NearJsonNumber) || !/^(?:0|[1-9]\d*)$/u.test(value.value)) throw invalid()
  const result = BigInt(value.value)
  if (result > U64_MAX) throw invalid()
  return result
}

const optionalBigint = (object: Record<string, NearJsonValue>, key: string): bigint | undefined =>
  Object.prototype.hasOwnProperty.call(object, key)
    ? object[key] === null ? undefined : bigintValue(object[key])
    : undefined

const optionalString = (object: Record<string, NearJsonValue>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(object, key)
    ? object[key] === null ? undefined : stringValue(object[key])
    : undefined

const requiredJson = (object: Record<string, NearJsonValue>, key: string): NearJsonValue => {
  const value = object[key]
  if (value === undefined) throw invalid()
  return value
}

const additional = (
  object: Record<string, NearJsonValue>,
  known: readonly string[],
): Readonly<Record<string, NearJsonValue>> => {
  const result: Record<string, NearJsonValue> = {}
  for (const [key, value] of Object.entries(object)) {
    if (known.includes(key)) continue
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: freezeValue(value),
      writable: true,
    })
  }
  return Object.freeze(result)
}

const decodeSyncInfo = (value: NearJsonValue): NearSyncInfo => {
  const object = objectValue(value)
  return Object.freeze({
    latestBlockHash: stringValue(object.latest_block_hash),
    latestBlockHeight: bigintValue(object.latest_block_height),
    latestBlockTime: stringValue(object.latest_block_time),
    latestStateRoot: stringValue(object.latest_state_root),
    syncing: booleanValue(object.syncing),
    additional: additional(object, [
      'latest_block_hash', 'latest_block_height', 'latest_block_time',
      'latest_state_root', 'syncing',
    ]),
  })
}

const decodeNodeVersion = (value: NearJsonValue): NearNodeVersion => {
  const object = objectValue(value)
  const rustcVersion = optionalString(object, 'rustc_version')
  return Object.freeze({
    version: stringValue(object.version),
    build: stringValue(object.build),
    ...(rustcVersion === undefined ? {} : { rustcVersion }),
    additional: additional(object, ['version', 'build', 'rustc_version']),
  })
}

const decodeStatus = (value: NearJsonValue): NearStatus => {
  const object = objectValue(value)
  return Object.freeze({
    chainId: stringValue(object.chain_id),
    genesisHash: stringValue(object.genesis_hash),
    latestProtocolVersion: bigintValue(object.latest_protocol_version),
    protocolVersion: bigintValue(object.protocol_version),
    syncInfo: decodeSyncInfo(requiredJson(object, 'sync_info')),
    version: decodeNodeVersion(requiredJson(object, 'version')),
    additional: additional(object, [
      'chain_id', 'genesis_hash', 'latest_protocol_version',
      'protocol_version', 'sync_info', 'version',
    ]),
  })
}

const decodeHeader = (value: NearJsonValue): NearBlockHeader => {
  const object = objectValue(value)
  return Object.freeze({
    hash: stringValue(object.hash),
    height: bigintValue(object.height),
    prevHash: stringValue(object.prev_hash),
    timestamp: bigintValue(object.timestamp),
    timestampNanosec: stringValue(object.timestamp_nanosec),
    gasPrice: stringValue(object.gas_price),
    totalSupply: stringValue(object.total_supply),
    additional: additional(object, [
      'hash', 'height', 'prev_hash', 'timestamp', 'timestamp_nanosec',
      'gas_price', 'total_supply',
    ]),
  })
}

const decodeBlock = (value: NearJsonValue): NearBlockView => {
  const object = objectValue(value)
  if (!Array.isArray(object.chunks)) throw invalid()
  return Object.freeze({
    author: stringValue(object.author),
    header: decodeHeader(requiredJson(object, 'header')),
    chunks: Object.freeze(object.chunks.map((item) => freezeValue(item))),
    additional: additional(object, ['author', 'header', 'chunks']),
  })
}

const decodeAccount = (value: NearJsonValue): NearAccountView => {
  const object = objectValue(value)
  const storagePaidAt = optionalBigint(object, 'storage_paid_at')
  const state = optionalString(object, 'state')
  const bootstrapNonce = optionalBigint(object, 'bootstrap_nonce')
  const globalContractAccountId = optionalString(object, 'global_contract_account_id')
  const globalContractHash = optionalString(object, 'global_contract_hash')
  return Object.freeze({
    amount: stringValue(object.amount),
    locked: stringValue(object.locked),
    codeHash: stringValue(object.code_hash),
    storageUsage: bigintValue(object.storage_usage),
    ...(storagePaidAt === undefined ? {} : { storagePaidAt }),
    blockHeight: bigintValue(object.block_height),
    blockHash: stringValue(object.block_hash),
    ...(state === undefined ? {} : { state }),
    ...(bootstrapNonce === undefined ? {} : { bootstrapNonce }),
    ...(globalContractAccountId === undefined ? {} : { globalContractAccountId }),
    ...(globalContractHash === undefined ? {} : { globalContractHash }),
    additional: additional(object, [
      'amount', 'locked', 'code_hash', 'storage_usage', 'storage_paid_at',
      'block_height', 'block_hash', 'state', 'bootstrap_nonce',
      'global_contract_account_id', 'global_contract_hash',
    ]),
  })
}

const selector = (reference: NearBlockReference): Record<string, string | bigint> => {
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) throw new ErpcConfigError('NEAR block reference is invalid')
  const keys = Object.keys(reference)
  if (keys.length !== 1) throw new ErpcConfigError('NEAR block reference requires exactly one selector')
  if (keys[0] === 'finality') {
    const finality = (reference as { readonly finality?: unknown }).finality
    if (finality !== 'final' && finality !== 'optimistic') throw new ErpcConfigError('NEAR finality is invalid')
    return { finality }
  }
  if (keys[0] === 'blockId') {
    const blockId = (reference as { readonly blockId?: unknown }).blockId
    if (typeof blockId === 'string') return { block_id: blockId }
    if (typeof blockId === 'bigint' && blockId >= 0n && blockId <= U64_MAX) return { block_id: blockId }
  }
  throw new ErpcConfigError('NEAR block reference is invalid')
}

const request = <TResult>(
  transport: JsonRpcTransport,
  method: string,
  params: unknown,
  decode: (value: NearJsonValue) => TResult,
): PendingRpcRequest<TResult> => new PendingRpcRequest((options: RpcSendOptions = {}) =>
  transport.request<NearJsonValue>(method, params as never, options).then(decode),
)

export const createNearClient = (transport: JsonRpcTransport): ErpcNearClient => ({
  rpc: {
    endpoint: transport.endpoint,
    status: () => request(transport, NEAR_RPC_METHODS[1] ?? 'status', [], decodeStatus),
    block: (reference) => request(transport, NEAR_RPC_METHODS[0] ?? 'block', selector(reference), decodeBlock),
    viewAccount: (accountId, reference) => {
      if (typeof accountId !== 'string' || accountId.length === 0) throw new ErpcConfigError('NEAR account ID is invalid')
      return request(transport, NEAR_RPC_METHODS[2] ?? 'query', {
        request_type: 'view_account',
        account_id: accountId,
        ...selector(reference),
      }, decodeAccount)
    },
  },
})
