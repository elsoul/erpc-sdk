import { ErpcConfigError } from '../errors'
import type { RpcSendOptions } from './types'
import {
  decodeBalanceResponse,
  decodeObjectResponse,
  decodeServiceInfoResponse,
  encodeGetBalanceRequest,
  encodeGetObjectRequest,
  encodeGetServiceInfoRequest,
  type SuiBalanceWire,
  type SuiObjectSummaryWire,
  type SuiServiceInfoWire,
} from '../transport/sui-proto'
import {
  SUI_GRPC_WEB_CONTENT_TYPE,
  SUI_GRPC_WEB_METHODS,
  SuiGrpcWebTransport,
} from '../transport/sui-grpc-web'

export { SUI_GRPC_WEB_CONTENT_TYPE, SUI_GRPC_WEB_METHODS }

export interface SuiGrpcWebEndpointConfig {
  readonly baseUrl: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface SuiServiceInfo {
  readonly chainId: string
  readonly chain: string
  readonly epoch: bigint
  readonly checkpointHeight: bigint
  readonly timestampSeconds: bigint
  readonly timestampNanos: number
  readonly lowestAvailableCheckpoint: bigint
  readonly lowestAvailableCheckpointObjects: bigint
  readonly server?: string
}

export interface SuiObjectSummary {
  readonly objectId: string
  readonly version: bigint
  readonly digest: string
}

export interface SuiBalance {
  readonly coinType: string
  readonly balance: bigint
  readonly addressBalance: bigint
  readonly coinBalance: bigint
}

export class PendingSuiGrpcWebRequest<TResult> {
  readonly #transport: SuiGrpcWebTransport
  readonly #method: string
  readonly #body: Uint8Array
  readonly #decode: (payload: Uint8Array) => TResult

  constructor(
    transport: SuiGrpcWebTransport,
    method: string,
    body: Uint8Array,
    decode: (payload: Uint8Array) => TResult,
  ) {
    this.#transport = transport
    this.#method = method
    this.#body = body
    this.#decode = decode
  }

  send(options?: RpcSendOptions): Promise<TResult> {
    return this.#transport.execute(this.#method, this.#body, options).then(this.#decode)
  }
}

export interface SuiGrpcWebClient {
  readonly endpoint: string
  getServiceInfo(): PendingSuiGrpcWebRequest<SuiServiceInfo>
  getObject(objectId: string, version?: bigint): PendingSuiGrpcWebRequest<SuiObjectSummary>
  getBalance(owner: string, coinType: string): PendingSuiGrpcWebRequest<SuiBalance>
}

export interface ErpcSuiClient { readonly grpc: SuiGrpcWebClient }

const serviceInfo = (value: SuiServiceInfoWire): SuiServiceInfo => Object.freeze({
  chainId: value.chainId,
  chain: value.chain,
  epoch: value.epoch,
  checkpointHeight: value.checkpointHeight,
  timestampSeconds: value.timestamp.seconds,
  timestampNanos: value.timestamp.nanos,
  lowestAvailableCheckpoint: value.lowestAvailableCheckpoint,
  lowestAvailableCheckpointObjects: value.lowestAvailableCheckpointObjects,
  ...(value.server === undefined ? {} : { server: value.server }),
})

const objectSummary = (value: SuiObjectSummaryWire): SuiObjectSummary => Object.freeze({
  objectId: value.objectId,
  version: value.version,
  digest: value.digest,
})

const balance = (value: SuiBalanceWire): SuiBalance => Object.freeze({
  coinType: value.coinType,
  balance: value.balance,
  addressBalance: value.addressBalance,
  coinBalance: value.coinBalance,
})

export const createSuiClient = (transport: SuiGrpcWebTransport): ErpcSuiClient => ({
  grpc: {
    endpoint: transport.endpoint,
    getServiceInfo: () => new PendingSuiGrpcWebRequest(
      transport,
      SUI_GRPC_WEB_METHODS[0],
      encodeGetServiceInfoRequest(),
      (payload) => serviceInfo(decodeServiceInfoResponse(payload)),
    ),
    getObject: (objectId, version) => {
      if (typeof objectId !== 'string') throw new ErpcConfigError('Sui object ID is invalid')
      if (version !== undefined && (typeof version !== 'bigint' || version < 0n || version > 18_446_744_073_709_551_615n)) {
        throw new ErpcConfigError('Sui object version is invalid')
      }
      return new PendingSuiGrpcWebRequest(
        transport,
        SUI_GRPC_WEB_METHODS[1],
        encodeGetObjectRequest(objectId, version),
        (payload) => objectSummary(decodeObjectResponse(payload)),
      )
    },
    getBalance: (owner, coinType) => new PendingSuiGrpcWebRequest(
      transport,
      SUI_GRPC_WEB_METHODS[2],
      encodeGetBalanceRequest(owner, coinType),
      (payload) => balance(decodeBalanceResponse(payload)),
    ),
  },
})
