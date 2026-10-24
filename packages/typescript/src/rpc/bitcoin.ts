import { PendingRpcRequest } from './client'
import {
  BITCOIN_RPC_METHODS,
  asBitcoinBlockCount,
  asBitcoinString,
  BitcoinJsonNumber,
  type BitcoinJsonValue,
} from './bitcoin_codec'
import type { JsonRpcParams, RpcSendOptions } from './types'
import { ErpcInvalidResponseError } from '../errors'

export { BITCOIN_RPC_METHODS, BitcoinJsonNumber } from './bitcoin_codec'
export type { BitcoinJsonValue } from './bitcoin_codec'

export interface BitcoinRpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
}

export interface BitcoinRpcTransport {
  readonly endpoint: string

  request<TResult extends BitcoinJsonValue>(
    method: string,
    params?: JsonRpcParams,
    options?: RpcSendOptions,
  ): Promise<TResult>
}

export type BitcoinJsonParams = readonly unknown[]

export interface BitcoinRpcClient {
  readonly endpoint: string
  estimateSmartFee(
    ...params: readonly [confTarget?: number, estimateMode?: string]
  ): PendingRpcRequest<BitcoinJsonValue>
  getBestBlockHash(): PendingRpcRequest<string>
  getBlock(
    blockHash: string,
    verbosity?: boolean | number,
  ): PendingRpcRequest<BitcoinJsonValue>
  getBlockchainInfo(): PendingRpcRequest<BitcoinJsonValue>
  getBlockCount(): PendingRpcRequest<bigint>
  getBlockHash(height: number): PendingRpcRequest<string>
  getBlockHeader(
    blockHash: string,
    verbose?: boolean,
  ): PendingRpcRequest<BitcoinJsonValue>
  getMempoolInfo(): PendingRpcRequest<BitcoinJsonValue>
  getNetworkInfo(): PendingRpcRequest<BitcoinJsonValue>
  getRawMempool(
    verbose?: boolean,
  ): PendingRpcRequest<BitcoinJsonValue>
  getRawTransaction(
    transactionId: string,
    verbose?: boolean | number,
    blockHash?: string,
  ): PendingRpcRequest<BitcoinJsonValue>
  getTxOut(
    transactionId: string,
    outputIndex: number,
    includeMempool?: boolean,
  ): PendingRpcRequest<BitcoinJsonValue | null>
}

export interface ErpcBitcoinClient {
  readonly rpc: BitcoinRpcClient
}

const project = <TResult>(
  transport: BitcoinRpcTransport,
  method: string,
  params: BitcoinJsonParams,
  transform: (value: BitcoinJsonValue) => TResult = (value) => value as TResult,
): PendingRpcRequest<TResult> =>
  new PendingRpcRequest((options) =>
    transport.request<BitcoinJsonValue>(method, params, options).then(transform),
  )

const bitcoinMethod = (index: number): string => {
  const method = BITCOIN_RPC_METHODS[index]
  if (method === undefined) throw new Error('Missing generated Bitcoin method')
  return method
}

const asNullableObject = (value: BitcoinJsonValue): BitcoinJsonValue | null => {
  if (value === null) return null
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof BitcoinJsonNumber
  ) {
    throw new ErpcInvalidResponseError()
  }
  return value
}

export const createBitcoinClient = (
  transport: BitcoinRpcTransport,
): ErpcBitcoinClient => ({
  rpc: {
    endpoint: transport.endpoint,
    estimateSmartFee: (...params) =>
      project(transport, bitcoinMethod(0), params),
    getBestBlockHash: () =>
      project(transport, bitcoinMethod(1), [], asBitcoinString),
    getBlock: (blockHash, verbosity) =>
      project(transport, bitcoinMethod(2), [
        blockHash,
        ...(verbosity === undefined ? [] : [verbosity]),
      ]),
    getBlockchainInfo: () =>
      project(transport, bitcoinMethod(3), []),
    getBlockCount: () =>
      project(transport, bitcoinMethod(4), [], asBitcoinBlockCount),
    getBlockHash: (height) =>
      project(transport, bitcoinMethod(5), [height], asBitcoinString),
    getBlockHeader: (blockHash, verbose) =>
      project(transport, bitcoinMethod(6), [
        blockHash,
        ...(verbose === undefined ? [] : [verbose]),
      ]),
    getMempoolInfo: () =>
      project(transport, bitcoinMethod(7), []),
    getNetworkInfo: () =>
      project(transport, bitcoinMethod(8), []),
    getRawMempool: (verbose) =>
      project(transport, bitcoinMethod(9), [
        ...(verbose === undefined ? [] : [verbose]),
      ]),
    getRawTransaction: (transactionId, verbose, blockHash) =>
      project(transport, bitcoinMethod(10), [
        transactionId,
        ...(verbose === undefined ? [] : [verbose]),
        ...(blockHash === undefined ? [] : [blockHash]),
      ]),
    getTxOut: (transactionId, outputIndex, includeMempool) =>
      project(
        transport,
        bitcoinMethod(11),
        [
          transactionId,
          outputIndex,
          ...(includeMempool === undefined ? [] : [includeMempool]),
        ],
        asNullableObject,
      ),
  },
})
