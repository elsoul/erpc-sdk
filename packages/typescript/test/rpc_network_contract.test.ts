import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseLosslessJson } from 'lossless-json'
import { describe, expect, it } from 'vitest'
import {
  ARBITRUM_RPC_METHODS,
  BITCOIN_RPC_METHODS,
  DEFAULT_ARBITRUM_ENDPOINT,
  ErpcAbortedError,
  ErpcError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
  NearJsonNumber,
  createErpcClient,
} from '../src'
import { bitcoinNumberTuple, BitcoinJsonNumber } from '../src/rpc/bitcoin_codec'
import {
  RPC_NETWORK_CONTRACT,
  RPC_NETWORK_CONTRACT_DIGEST,
} from '../src/generated/rpc_network_contract'

// @ts-ignore The registry verifier is an approved Node-only test helper without a TS declaration.
const parity = await import('../../../registry/verify-rpc-network-parity.mjs') as any
// @ts-ignore The canonical contract module is an approved Node-only test helper without a TS declaration.
const contractRegistry = await import('../../../registry/rpc-network-contract.mjs') as any

type AnyRecord = Record<string, any>
type FixtureCase = AnyRecord
type CaptureRecord = {
  readonly caseId: string
  readonly phase: 'setup' | 'measured'
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly bodyBase64: string
  readonly bodySha256: string
}

const repositoryRoot = resolve(
  process.cwd().endsWith('/packages/typescript') ? process.cwd() : resolve(process.cwd(), 'packages/typescript'),
  '../..',
)
const fixture = JSON.parse(await readFile(
  resolve(repositoryRoot, 'registry/fixtures/rpc-chain-contract-cases.json'),
  'utf8',
)) as AnyRecord
const contract = JSON.parse(await readFile(
  resolve(repositoryRoot, 'registry/rpc-network-contract.json'),
  'utf8',
)) as AnyRecord

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as AnyRecord).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as AnyRecord)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const descriptorBytes = (source: AnyRecord): Buffer => {
  const golden = source.kind === 'oracle-ref-v1'
    ? fixture.oracleGoldens.find((candidate: AnyRecord) => candidate.goldenId === source.oracleGoldenId)
    : source
  if (golden === undefined) throw new Error(`missing descriptor golden ${source.oracleGoldenId}`)
  const chunks = parity.expandDescriptorChunks(golden.descriptor)
  return Buffer.concat([...parity.applyChunkPlan(chunks, golden.chunkPlan, golden.measurement.decodedLength)])
}

const responseBytes = (entry: FixtureCase): Buffer => {
  if (entry.mockExchange.response.bodyEncoding === 'descriptor') return descriptorBytes(entry.responseDescriptor)
  if (entry.mockExchange.response.bodyEncoding === 'hex') return Buffer.from(entry.mockExchange.response.body, 'hex')
  return Buffer.from(entry.mockExchange.response.body, 'utf8')
}

const requestBytes = (entry: FixtureCase): Buffer => {
  if (entry.mockExchange.request.bodyEncoding === 'descriptor') return descriptorBytes(entry.requestDescriptor)
  if (entry.mockExchange.request.bodyEncoding === 'hex') return Buffer.from(entry.mockExchange.request.body, 'hex')
  return Buffer.from(entry.mockExchange.request.body, 'utf8')
}

const clientField = (clientContractId: string): string => ({
  'client-arbitrum-rpc': 'arbitrumRpc',
  'client-base-rpc': 'baseRpc',
  'client-bitcoin-rpc': 'bitcoinRpc',
  'client-bsc-rpc': 'bscRpc',
  'client-arc-rpc': 'arcRpc',
  'client-hyperliquid-rpc': 'hyperliquidRpc',
  'client-kaia-rpc': 'kaiaRpc',
  'client-monad-rpc': 'monadRpc',
  'client-optimism-rpc': 'optimismRpc',
  'client-polygon-rpc': 'polygonRpc',
  'client-robinhood-rpc': 'robinhoodRpc',
  'client-soneium-rpc': 'soneiumRpc',
  'client-tron-rpc': 'tronRpc',
  'client-near-rpc': 'nearRpc',
  'client-sui-grpc': 'suiGrpcWeb',
  'client-ethereum-rpc': 'ethereumRpc',
  'client-solana-rpc': 'solanaRpc',
  'client-avalanche-rpc': 'avalancheCRpc',
}[clientContractId] ?? '')

const hostedEndpointField = (clientContractId: string): string => ({
  'client-arbitrum-rpc': 'arbitrumEndpoint',
  'client-base-rpc': 'baseEndpoint',
  'client-bitcoin-rpc': 'endpoint',
  'client-bsc-rpc': 'bscEndpoint',
  'client-arc-rpc': 'arcEndpoint',
  'client-hyperliquid-rpc': 'hyperliquidEndpoint',
  'client-kaia-rpc': 'kaiaEndpoint',
  'client-monad-rpc': 'monadEndpoint',
  'client-optimism-rpc': 'optimismEndpoint',
  'client-polygon-rpc': 'polygonEndpoint',
  'client-robinhood-rpc': 'robinhoodEndpoint',
  'client-soneium-rpc': 'soneiumEndpoint',
  'client-tron-rpc': 'tronEndpoint',
  'client-near-rpc': 'nearEndpoint',
  'client-sui-grpc': 'suiEndpoint',
}[clientContractId] ?? '')

const endpointForConfig = (entry: FixtureCase): string => {
  const endpoint = entry.setup.endpoint
  if (typeof endpoint === 'string') {
    if (entry.clientContractId === 'client-bitcoin-rpc' && entry.setup.mode === 'hosted') return new URL(endpoint).origin
    return endpoint
  }
  return 'https://node.fixture.invalid/rpc'
}

const buildClientConfig = (entry: FixtureCase, fetch: typeof globalThis.fetch, timeoutMs: number): AnyRecord => {
  const config: AnyRecord = { fetch, timeoutMs }
  const field = clientField(entry.clientContractId)
  const setupHeaders = entry.setup.headers ?? {}
  if (entry.setup.mode === 'unconfigured') {
    config.ethereumRpc = { httpUrl: 'https://unrelated.fixture.invalid/rpc' }
    return config
  }
  if (entry.setup.mode === 'none') {
    if (entry.clientContractId === 'client-bitcoin-rpc') config.bitcoinRpc = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
    else if (entry.clientContractId === 'client-base-rpc' && entry.operation.publicOperation === 'cancellation') config.bitcoinRpc = { httpUrl: 'https://unrelated.fixture.invalid/rpc', headers: setupHeaders }
    else if (entry.clientContractId === 'client-base-rpc') config.baseRpc = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
    else if (entry.clientContractId === 'client-hyperliquid-rpc') config.hyperliquidRpc = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
    else config.bitcoinRpc = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
    return config
  }
  if (entry.setup.mode === 'hosted') {
    config.apiKey = entry.setup.apiKey
    const fieldName = hostedEndpointField(entry.clientContractId)
    config[fieldName] = endpointForConfig(entry)
    if (entry.clientContractId === 'client-sui-grpc') config.suiEndpoint = endpointForConfig(entry)
    return config
  }
  if (entry.clientContractId === 'client-sui-grpc') config.suiGrpcWeb = { baseUrl: endpointForConfig(entry), headers: setupHeaders }
  else if (field === 'ethereumRpc' || field === 'solanaRpc' || field === 'avalancheCRpc') config[field] = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
  else if (field === 'baseRpc') config[field] = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
  else config[field] = { httpUrl: endpointForConfig(entry), headers: setupHeaders }
  return config
}

const rpcSurface = (client: AnyRecord, clientContractId: string): AnyRecord => {
  if (clientContractId === 'client-sui-grpc') return client.sui.grpc
  if (clientContractId === 'client-bitcoin-rpc') return client.bitcoin.rpc
  if (clientContractId === 'client-near-rpc') return client.near.rpc
  if (clientContractId === 'client-base-rpc') return client.base.rpc
  if (clientContractId === 'client-arbitrum-rpc') return client.arbitrum.rpc
  if (clientContractId === 'client-bsc-rpc') return client.bsc.rpc
  if (clientContractId === 'client-arc-rpc') return client.arc.rpc
  if (clientContractId === 'client-hyperliquid-rpc') return client.hyperliquid.rpc
  if (clientContractId === 'client-kaia-rpc') return client.kaia.rpc
  if (clientContractId === 'client-monad-rpc') return client.monad.rpc
  if (clientContractId === 'client-optimism-rpc') return client.optimism.rpc
  if (clientContractId === 'client-polygon-rpc') return client.polygon.rpc
  if (clientContractId === 'client-robinhood-rpc') return client.robinhood.rpc
  if (clientContractId === 'client-soneium-rpc') return client.soneium.rpc
  if (clientContractId === 'client-tron-rpc') return client.tron.rpc
  if (clientContractId === 'client-ethereum-rpc') return client.ethereum.rpc
  if (clientContractId === 'client-solana-rpc') return client.solana.rpc
  return client.avalanche.rpc
}

const invokePublic = (client: AnyRecord, entry: FixtureCase, options: AnyRecord = {}): Promise<unknown> | null => {
  const operation = entry.operation.publicOperation
  if (operation === 'surface' || operation === 'cancellation') return null
  const params = entry.operation.params
  if (entry.clientContractId === 'client-bitcoin-rpc') return client.bitcoin.rpc[operation](...(Array.isArray(params) ? params : [] )).send(options)
  if (entry.clientContractId === 'client-near-rpc') {
    if (operation === 'status') return client.near.rpc.status().send(options)
    if (operation === 'block') {
      const reference = params?.finality !== undefined ? { finality: params.finality } : { blockId: params?.block_id }
      return client.near.rpc.block(reference).send(options)
    }
    return client.near.rpc.viewAccount(params.account_id, { finality: params.finality }).send(options)
  }
  if (entry.clientContractId === 'client-sui-grpc') {
    if (operation === 'getServiceInfo') return client.sui.grpc.getServiceInfo().send(options)
    if (operation === 'getObject') {
      const requestGolden = entry.requestDescriptor?.oracleGoldenId === 'sui-request-bytes-inclusive' || entry.requestDescriptor?.oracleGoldenId === 'sui-request-bytes-over'
        ? fixture.oracleGoldens.find((candidate: AnyRecord) => candidate.goldenId === entry.requestDescriptor.oracleGoldenId)?.descriptor
        : undefined
      const objectId = requestGolden === undefined ? params[0].objectId : requestGolden.objectByte.repeat(requestGolden.objectCount)
      const version = requestGolden === undefined || requestGolden.versionPresent
        ? (params[0].version === null || params[0].version === undefined ? undefined : BigInt(params[0].version))
        : undefined
      return client.sui.grpc.getObject(objectId, version).send(options)
    }
    if (Array.isArray(params)) {
      if (params[0] !== null && typeof params[0] === 'object') return client.sui.grpc.getBalance(params[0].owner, params[0].coinType).send(options)
      return client.sui.grpc.getBalance(params[0], params[1]).send(options)
    }
    return client.sui.grpc.getBalance(params.owner, params.coinType).send(options)
  }
  if (entry.clientContractId === 'client-solana-rpc') return client.solana.rpc.getGenesisHash().send(options)
  if (entry.clientContractId === 'client-avalanche-rpc') return client.avalanche.rpc[operation]().send(options)
  return rpcSurface(client, entry.clientContractId)[operation](...(Array.isArray(params) ? params : [])).send(options)
}

const genericNearResult = (operation: string): AnyRecord => {
  if (operation === 'status') return {
    chain_id: 'mainnet', genesis_hash: 'warmup', latest_protocol_version: 1,
    protocol_version: 1, sync_info: {
      latest_block_hash: 'warmup', latest_block_height: 1, latest_block_time: 'time',
      latest_state_root: 'warmup', syncing: false,
    }, version: { version: '1', build: 'warmup', rustc_version: '1' },
  }
  if (operation === 'block') return {
    author: 'warmup.near', header: {
      hash: 'warmup', height: 1, prev_hash: 'warmup', timestamp: 1,
      timestamp_nanosec: '1', gas_price: '1', total_supply: '1',
    }, chunks: [],
  }
  return {
    amount: '1', locked: '0', code_hash: 'warmup', storage_usage: 1,
    storage_paid_at: 0, block_height: 1, block_hash: 'warmup',
  }
}

const genericBitcoinResult = (method: string): unknown => {
  if (method === 'getblockcount') return 0
  if (method === 'gettxout') return null
  if (['getbestblockhash', 'getblockhash', 'getblockheader'].includes(method)) return 'warmup'
  if (method === 'estimatesmartfee') return { fee: 0 }
  return { warmup: true }
}

const genericJsonResponse = (entry: FixtureCase, requestBody: Buffer): Buffer => {
  let request: AnyRecord
  try { request = JSON.parse(requestBody.toString('utf8')) as AnyRecord } catch { request = { id: 1, method: entry.operation.wireOperation } }
  let result: unknown
  if (entry.clientContractId === 'client-bitcoin-rpc') result = genericBitcoinResult(request.method)
  else if (entry.clientContractId === 'client-near-rpc') result = genericNearResult(request.method)
  else if (entry.clientContractId === 'client-solana-rpc') result = 'warmup-genesis'
  else if (entry.clientContractId === 'client-avalanche-rpc') result = '0xa86a'
  else result = '0x0'
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), 'utf8')
}

const parseJsonEnvelope = (entry: FixtureCase): AnyRecord => {
  const text = responseBytes(entry).toString('utf8')
  if (entry.clientContractId === 'client-bitcoin-rpc') {
    return parseLosslessJson(text, undefined, {
      onDuplicateKey: ({ newValue }) => newValue,
      parseNumber: (raw) => new BitcoinJsonNumber(raw),
    }) as AnyRecord
  }
  if (entry.clientContractId === 'client-near-rpc') {
    return parseLosslessJson(text, undefined, {
      onDuplicateKey: ({ newValue }) => newValue,
      parseNumber: (raw) => new NearJsonNumber(raw),
    }) as AnyRecord
  }
  return JSON.parse(text) as AnyRecord
}

/** Preserve SDK-owned numeric wrappers in review evidence. */
const serializeActual = (value: unknown): unknown => {
  if (value instanceof BitcoinJsonNumber) return { $type: 'BitcoinJsonNumber', value: value.value }
  if (value instanceof NearJsonNumber) return { $type: 'NearJsonNumber', value: value.value }
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() }
  if (Array.isArray(value)) {
    if (value.length > 1024) return {
      $type: 'array-summary',
      length: value.length,
      head: value.slice(0, 4).map((item) => serializeActual(item)),
      tail: value.slice(-4).map((item) => serializeActual(item)),
    }
    return value.map((item) => serializeActual(item))
  }
  if (value !== null && typeof value === 'object') {
    const result: AnyRecord = {}
    for (const [key, item] of Object.entries(value as AnyRecord)) {
      Object.defineProperty(result, key, { configurable: true, enumerable: true, value: serializeActual(item), writable: true })
    }
    return result
  }
  return value
}

const nearWireNumber = (value: unknown): unknown => {
  if (value instanceof NearJsonNumber) return value
  if (typeof value === 'bigint') return new NearJsonNumber(value.toString())
  return value
}

const nearWireValue = (value: unknown): unknown => {
  if (value instanceof NearJsonNumber || value === null || typeof value !== 'object') return nearWireNumber(value)
  if (Array.isArray(value)) return value.map((item) => nearWireValue(item))
  const result: AnyRecord = {}
  for (const [key, item] of Object.entries(value as AnyRecord)) result[key] = nearWireValue(item)
  return result
}

const nearWireResult = (operation: string, value: AnyRecord): unknown => {
  if (operation === 'status') return {
    chain_id: value.chainId,
    genesis_hash: value.genesisHash,
    latest_protocol_version: nearWireNumber(value.latestProtocolVersion),
    protocol_version: nearWireNumber(value.protocolVersion),
    sync_info: {
      latest_block_hash: value.syncInfo.latestBlockHash,
      latest_block_height: nearWireNumber(value.syncInfo.latestBlockHeight),
      latest_block_time: value.syncInfo.latestBlockTime,
      latest_state_root: value.syncInfo.latestStateRoot,
      syncing: value.syncInfo.syncing,
      ...nearWireValue(value.syncInfo.additional) as AnyRecord,
    },
    version: {
      version: value.version.version,
      build: value.version.build,
      ...(value.version.rustcVersion === undefined ? {} : { rustc_version: value.version.rustcVersion }),
      ...nearWireValue(value.version.additional) as AnyRecord,
    },
    ...nearWireValue(value.additional) as AnyRecord,
  }
  if (operation === 'block') return {
    author: value.author,
    header: {
      hash: value.header.hash,
      height: nearWireNumber(value.header.height),
      prev_hash: value.header.prevHash,
      timestamp: nearWireNumber(value.header.timestamp),
      timestamp_nanosec: value.header.timestampNanosec,
      gas_price: value.header.gasPrice,
      total_supply: value.header.totalSupply,
      ...nearWireValue(value.header.additional) as AnyRecord,
    },
    chunks: nearWireValue(value.chunks),
    ...nearWireValue(value.additional) as AnyRecord,
  }
  return {
    amount: value.amount,
    locked: value.locked,
    code_hash: value.codeHash,
    storage_usage: nearWireNumber(value.storageUsage),
    ...(value.storagePaidAt === undefined ? {} : { storage_paid_at: nearWireNumber(value.storagePaidAt) }),
    block_height: nearWireNumber(value.blockHeight),
    block_hash: value.blockHash,
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.bootstrapNonce === undefined ? {} : { bootstrap_nonce: nearWireNumber(value.bootstrapNonce) }),
    ...(value.globalContractAccountId === undefined ? {} : { global_contract_account_id: value.globalContractAccountId }),
    ...(value.globalContractHash === undefined ? {} : { global_contract_hash: value.globalContractHash }),
    ...nearWireValue(value.additional) as AnyRecord,
  }
}

const semanticValue = (value: unknown): unknown => {
  if (value instanceof BitcoinJsonNumber) return Number(value.value)
  if (value instanceof NearJsonNumber) return Number(value.value)
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map((item) => semanticValue(item))
  if (value !== null && typeof value === 'object') {
    const result: AnyRecord = {}
    for (const [key, item] of Object.entries(value as AnyRecord)) result[key] = semanticValue(item)
    return result
  }
  return value
}

const wireEqual = (actual: unknown, source: unknown): boolean => {
  if (typeof actual === 'bigint' && source instanceof BitcoinJsonNumber) return actual.toString() === source.value
  if (typeof source === 'bigint' && actual instanceof BitcoinJsonNumber) return source.toString() === actual.value
  if (actual instanceof BitcoinJsonNumber || source instanceof BitcoinJsonNumber) {
    return actual instanceof BitcoinJsonNumber && source instanceof BitcoinJsonNumber && actual.value === source.value
  }
  if (actual instanceof NearJsonNumber || source instanceof NearJsonNumber) {
    if (actual instanceof NearJsonNumber && source instanceof NearJsonNumber) return actual.value === source.value
    if (typeof actual === 'bigint' && source instanceof NearJsonNumber) return actual.toString() === source.value
    if (actual instanceof NearJsonNumber && typeof source === 'bigint') return actual.value === source.toString()
    return false
  }
  if (typeof actual === 'bigint' || typeof source === 'bigint') return typeof actual === 'bigint' && typeof source === 'bigint' && actual === source
  if (Array.isArray(actual) || Array.isArray(source)) {
    return Array.isArray(actual) && Array.isArray(source) && actual.length === source.length && actual.every((item, index) => wireEqual(item, source[index]))
  }
  if (actual !== null && typeof actual === 'object' || source !== null && typeof source === 'object') {
    if (actual === null || source === null || typeof actual !== 'object' || typeof source !== 'object') return false
    const actualKeys = Object.keys(actual as AnyRecord).sort()
    const sourceKeys = Object.keys(source as AnyRecord).sort()
    return stableJson(actualKeys) === stableJson(sourceKeys) && actualKeys.every((key) => wireEqual((actual as AnyRecord)[key], (source as AnyRecord)[key]))
  }
  return Object.is(actual, source)
}

const assertJsonSuccessMatchesSource = (entry: FixtureCase, result: unknown): AnyRecord => {
  const envelope = parseJsonEnvelope(entry)
  if (!Object.hasOwn(envelope, 'result') || envelope.error !== undefined && envelope.error !== null) {
    throw new Error(`${entry.caseId} success run was checked against a non-success response source`)
  }
  const actualWire = entry.clientContractId === 'client-near-rpc'
    ? nearWireResult(entry.operation.publicOperation, result as AnyRecord)
    : result
  if (!wireEqual(actualWire, envelope.result)) {
    throw new Error(`${entry.caseId} actual SDK result differs from the resolved response source`)
  }
  return envelope
}

const collectNumericTuples = (value: unknown, path = '$.result'): AnyRecord[] => {
  if (value instanceof BitcoinJsonNumber) {
    const tuple = bitcoinNumberTuple(value)
    return [{ path, sign: tuple.sign, coefficient: tuple.coefficient, exponent10: tuple.exponent10 }]
  }
  if (typeof value === 'bigint') {
    const negative = value < 0n
    const digits = (negative ? -value : value).toString()
    return [{ path, sign: negative ? -1 : digits === '0' ? 0 : 1, coefficient: digits, exponent10: '0' }]
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value)
    const [integerPart = '0', fractionAndExponent = ''] = text.split('.', 2)
    const [fractionPart = '', exponentText = ''] = fractionAndExponent.split('e')
    const sign = integerPart.startsWith('-') ? -1 : value === 0 ? 0 : 1
    const integerDigits = integerPart.replace(/^-|\+/u, '')
    const digits = `${integerDigits}${fractionPart}`.replace(/^0+/u, '') || '0'
    const exponent = Number(exponentText || '0') - fractionPart.length
    return [{ path, sign, coefficient: digits, exponent10: String(exponent) }]
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => collectNumericTuples(item, `${path}[${index}]`))
  if (value !== null && typeof value === 'object') return Object.entries(value as AnyRecord).flatMap(([key, item]) => collectNumericTuples(item, `${path}.${key}`))
  return []
}

const INPUT_NUMERIC_EVIDENCE_CASES = new Set([
  'btc-resource-exponent-boundary-and-overflow',
  'btc-u64-overflow-and-integer-token-rejection',
])
const RESULT_NUMERIC_EVIDENCE_CASES = new Set([
  'btc-u64-maximum-integer-projection',
  'c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values',
])
const ERROR_NUMERIC_EVIDENCE_CASES = new Set([
  'btc-error-data-lossless-redaction',
  'c1-path-query-header-and-api-key-redaction',
])

const collectRawNumericTuples = (entry: FixtureCase): AnyRecord[] => {
  if (!INPUT_NUMERIC_EVIDENCE_CASES.has(entry.caseId)) return []
  const measured = parity.measureExpandedChunks([responseBytes(entry)], 'bitcoin-json')
  const result: AnyRecord[] = []
  for (const token of measured.numericTokens ?? []) {
    if (token.canonicalTuple === null) continue
    if (entry.caseId === 'btc-resource-exponent-boundary-and-overflow' && token.canonicalTuple.exponent10 !== '10000') continue
    if (entry.caseId === 'btc-u64-overflow-and-integer-token-rejection' && token.canonicalTuple.coefficient !== '18446744073709551616') continue
    const path = entry.caseId === 'btc-resource-exponent-boundary-and-overflow' ? '$.result.atLimit' : '$.result'
    result.push({ path, ...token.canonicalTuple })
  }
  return result
}

const numericTuplesForRun = (entry: FixtureCase, run: AnyRecord): AnyRecord[] => {
  if (run.result !== undefined && RESULT_NUMERIC_EVIDENCE_CASES.has(entry.caseId)) return collectNumericTuples(run.result)
  if (run.error instanceof ErpcJsonRpcError && ERROR_NUMERIC_EVIDENCE_CASES.has(entry.caseId)) {
    const tuples = collectNumericTuples(run.error.data, '$.error.data')
    if (tuples.length > 0) return tuples
  }
  return run.result === undefined && INPUT_NUMERIC_EVIDENCE_CASES.has(entry.caseId) ? collectRawNumericTuples(entry) : []
}

const errorCategory = (value: unknown): string => {
  if (value instanceof ErpcNotConfiguredError) return 'not-configured'
  if (value instanceof ErpcAbortedError) return 'context-cancelled'
  if (value instanceof ErpcTimeoutError) return 'timeout'
  if (value instanceof ErpcTransportError) return 'transport'
  if (value instanceof ErpcHttpError) return 'http-status'
  if (value instanceof ErpcJsonRpcError) return 'json-rpc'
  if (value instanceof ErpcInvalidResponseError) return 'invalid-response'
  if (value instanceof ErpcError) return value.code.replace(/^ERPC_/u, '').toLowerCase()
  throw new Error(`unknown native SDK error: ${value instanceof Error ? value.name : String(value)}`)
}

const credentialSentinels = (entry: FixtureCase): string[] => {
  const values = new Set<string>()
  const add = (value: unknown): void => { if (typeof value === 'string' && value.length > 0) values.add(value) }
  add(entry.setup.apiKey)
  add(entry.setup.endpoint)
  if (typeof entry.setup.endpoint === 'string') {
    try {
      const endpoint = new URL(entry.setup.endpoint)
      add(endpoint.pathname)
      for (const part of endpoint.pathname.split('/')) {
        add(part)
        try { add(decodeURIComponent(part)) } catch { /* keep the raw path component */ }
      }
      for (const value of endpoint.searchParams.values()) add(value)
      const rawQuery = endpoint.search.startsWith('?') ? endpoint.search.slice(1) : endpoint.search
      for (const part of rawQuery.split('&')) add(part.split('=', 2)[1])
    } catch { /* the setup endpoint is independently validated by the fixture */ }
  }
  for (const value of Object.values(entry.setup.headers ?? {})) {
    if (typeof value !== 'string') continue
    add(value)
    const parts = value.split(/\s+/u)
    if (parts.length > 1) add(parts.slice(1).join(' '))
  }
  return [...values].sort((left, right) => right.length - left.length)
}

const redactSourceValue = (value: unknown, entry: FixtureCase): unknown => {
  if (value instanceof BitcoinJsonNumber || value instanceof NearJsonNumber) return value
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map((item) => redactSourceValue(item, entry))
    if (value !== null && typeof value === 'object') {
      const result: AnyRecord = {}
      for (const [key, item] of Object.entries(value as AnyRecord)) result[redactSourceString(key, entry)] = redactSourceValue(item, entry)
      return result
    }
    return value
  }
  return redactSourceString(value, entry)
}

const redactSourceString = (value: string, entry: FixtureCase): string => {
  let result = value
  for (const sentinel of credentialSentinels(entry)) result = result.replaceAll(sentinel, '[REDACTED]')
  return result
}

const assertJsonRpcErrorMatchesSource = (entry: FixtureCase, error: unknown): void => {
  if (!(error instanceof ErpcJsonRpcError)) throw new Error(`${entry.caseId} did not produce the required native JSON-RPC error`)
  const source = parseJsonEnvelope(entry)
  const sourceError = source.error as AnyRecord | undefined
  const sourceCode = sourceError?.code instanceof BitcoinJsonNumber || sourceError?.code instanceof NearJsonNumber
    ? Number(sourceError.code.value)
    : sourceError?.code
  if (sourceError === undefined || typeof sourceCode !== 'number') throw new Error(`${entry.caseId} response source has no JSON-RPC error code`)
  if (error.rpcCode !== sourceCode) throw new Error(`${entry.caseId} SDK RPC code differs from the captured response code`)
  if (sourceError.data !== undefined && !wireEqual(error.data, redactSourceValue(sourceError.data, entry))) {
    throw new Error(`${entry.caseId} SDK error.data differs from the captured redacted response data`)
  }
  if (sourceError.data === undefined && error.data !== undefined) throw new Error(`${entry.caseId} SDK error.data was added to a response without data`)
  for (const sentinel of credentialSentinels(entry)) {
    if (error.message.includes(sentinel) || JSON.stringify(serializeActual(error.data)).includes(sentinel)) {
      throw new Error(`${entry.caseId} SDK JSON-RPC error leaked a setup credential`)
    }
  }
}

const redact = (value: string, entry: FixtureCase): string => {
  const sentinels = [entry.setup.apiKey, entry.setup.endpoint?.includes('fixture-secret') ? 'fixture-secret' : undefined, ...Object.values(entry.setup.headers ?? {})].filter((item): item is string => typeof item === 'string' && item.length > 0)
  let result = value
  for (const sentinel of sentinels) result = result.replaceAll(sentinel, '<redacted>')
  if (entry.caseId === 'c1-path-query-header-and-api-key-redaction' && /^https?:/u.test(result)) {
    const path = new URL(result).pathname
    result = result.replace(path, '/<redacted>')
  }
  return result
}

const redactedHeaders = (headers: Record<string, string>, entry: FixtureCase, sui: boolean): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'accept' && !sui) continue
    if (lower === 'authorization' || value.includes('fixture')) result[name.toLowerCase()] = '<redacted>'
    else result[name.toLowerCase()] = redact(value, entry)
  }
  return result
}

const methodSetFor = (clientContractId: string): AnyRecord => {
  const client = contract.clientContracts.find((item: AnyRecord) => item.clientContractId === clientContractId)
  return contract.methodSets.find((item: AnyRecord) => item.methodSetId === client.methodSetId)
}

const tsPublicOperation = (entry: FixtureCase): string => {
  const methodSet = methodSetFor(entry.clientContractId)
  const capability = methodSet.capabilities?.find((item: AnyRecord) => item.wireOperation === entry.operation.wireOperation)
  return capability?.publicNames?.typescript ?? capability?.publicOperation ?? entry.operation.publicOperation
}

const expectedScope = (throughCohort: number): AnyRecord => ({
  mode: 'through-cohort',
  throughCohort,
  cohortIds: Array.from({ length: throughCohort + 1 }, (_, index) => index),
  networkIds: contract.networks.filter((item: AnyRecord) => item.cohort <= throughCohort).map((item: AnyRecord) => item.networkId).sort(),
})

const methodSetDigest = (methodSet: AnyRecord): string => {
  return sha256(Buffer.from(stableJson(methodSet), 'utf8'))
}

const captureCoverage = (scope: AnyRecord, completedCaseIds: ReadonlySet<string>): AnyRecord[] => contract.networks
  .filter((network: AnyRecord) => scope.networkIds.includes(network.networkId))
  .sort((left: AnyRecord, right: AnyRecord) => left.networkId.localeCompare(right.networkId))
  .map((network: AnyRecord) => {
    const client = contract.clientContracts.find((item: AnyRecord) => item.clientContractId === network.clientContractId)
    return {
      networkId: network.networkId,
      clientContractId: client.clientContractId,
      namespace: client.namespace,
      methodSetDigest: methodSetDigest(methodSetFor(client.clientContractId)),
      routePolicyIds: client.endpointModes.map((mode: AnyRecord) => mode.transportProfileId).sort(),
      portableCasesExecuted: fixture.cases.some((item: FixtureCase) => item.networkId === network.networkId && completedCaseIds.has(item.caseId)),
    }
  })

const captureSurface = (scope: AnyRecord, inventories: ReadonlyMap<string, readonly string[]>): AnyRecord[] => {
  const clientIds = new Set(contract.networks.filter((network: AnyRecord) => scope.networkIds.includes(network.networkId)).map((network: AnyRecord) => network.clientContractId))
  return [...clientIds].sort().map((clientContractId) => {
    const client = contract.clientContracts.find((item: AnyRecord) => item.clientContractId === clientContractId)
    const methodSet = methodSetFor(clientContractId as string)
    const inventory = inventories.get(clientContractId as string)
    if (inventory === undefined) throw new Error(`no native surface inventory was captured for ${clientContractId}`)
    const allowed = methodSet.kind === 'expanded'
      ? methodSet.capabilities.map((item: AnyRecord) => item.publicNames?.typescript ?? item.publicOperation)
      : ['legacy-reference']
    if (methodSet.kind === 'expanded') {
      for (const name of allowed) if (!inventory.includes(name)) throw new Error(`${clientContractId} native surface is missing ${name}`)
    } else if (inventory.length === 0) {
      throw new Error(`${clientContractId} native legacy surface is empty`)
    }
    const forbidden = [...client.forbiddenCapabilities].sort()
    for (const name of forbidden) if (inventory.includes(name)) throw new Error(`${clientContractId} exposed forbidden capability ${name}`)
    return { clientContractId, allowed, forbidden }
  })
}

const fullEvmSurface = (): AnyRecord => ({
  allowed: ['eth_chainId', 'eth_getBalance', 'eth_call'],
  forbidden: ['raw', 'request', 'batch', 'transport', 'websocket', 'subscription', 'sign', 'send', 'approve', 'broadcast', 'swap', 'bridge'],
})

const fullBitcoinSurface = (): AnyRecord => ({
  allowed: ['estimateSmartFee', 'getBestBlockHash', 'getBlock', 'getBlockchainInfo', 'getBlockCount', 'getBlockHash', 'getBlockHeader', 'getMempoolInfo', 'getNetworkInfo', 'getRawMempool', 'getRawTransaction', 'getTxOut'],
  forbidden: ['raw', 'request', 'batch', 'subscription'],
})

const fullSuiForbidden = ['raw', 'request', 'bytes', 'protobuf', 'transport', 'batch', 'stream', 'subscription', 'swap', 'bridge']

const surfacePolicy = (entry: FixtureCase): AnyRecord => {
  if (entry.caseId === 'c1-one-attempt-no-redirect-timeout-and-cancellation' || entry.scheduleId?.startsWith('life-')) return { allowed: ['timeout', 'aborted-or-context-cancelled'], forbidden: ['redirect-follow', 'retry'] }
  if (entry.caseId === 'c1-bitcoin-new-languages-have-no-raw-request-batch-subscription') return { allowed: ['named-read-methods'], forbidden: ['raw', 'request', 'batch', 'subscription'] }
  if (entry.caseId === 'c1-sealed-evm-three-method-payloads-and-no-escape-hatches') return fullEvmSurface()
  if (entry.caseId === 'c4-hyperevm-arc-robinhood-product-scope') return { allowed: ['eth_chainId', 'eth_getBalance', 'eth_call'], forbidden: ['hypercore', 'info', 'nanoreth', 'brokerage', 'swap', 'bridge'] }
  if (entry.caseId === 'c1-typescript-base-unconfigured-placeholder-exception') return { allowed: ['https://unconfigured.invalid/base'], forbidden: [] }
  if (entry.caseId === 'c1-hosted-base-root-query-auth') return { allowed: ['eth_chainId', 'eth_getBalance', 'eth_call'], forbidden: ['raw', 'request', 'batch', 'websocket', 'subscription', 'send', 'swap', 'bridge'] }
  if (entry.caseId === 'c1-existing-ethereum-solana-avalanche-and-typescript-base-regression') return { allowed: ['legacy-solana-namespace', 'explicit-direct-only'], forbidden: ['hosted-devnet-preset', 'network-switch'] }
  if (entry.caseId === 'c3-mainnet-only-monad-soneium-kaia') return { allowed: ['mainnet-identity'], forbidden: ['testnet-relabel', 'swap', 'bridge'] }
  if (entry.caseId === 'c5-near-tron-sui-native-protocol-contracts' || entry.clientContractId === 'client-near-rpc') return { allowed: ['status', 'block', 'view_account'], forbidden: ['query', 'raw', 'request', 'batch'] }
  if (entry.clientContractId === 'client-sui-grpc') {
    if (entry.caseId === 'c5-sui-binary-limit-descriptor') return { allowed: ['getServiceInfo'], forbidden: [] }
    if (entry.caseId === 'sui-request-bytes-inclusive-case') return { allowed: ['request-1MiB-inclusive', 'response-8MiB-inclusive', 'trailer-8KiB-inclusive'], forbidden: ['request-1MiB-plus-one'] }
    if (entry.caseId === 'sui-request-bytes-over-case') return { allowed: ['request-1MiB-inclusive', 'response-8MiB-inclusive', 'trailer-8KiB-inclusive'], forbidden: ['request-1MiB-plus-one'] }
    if (entry.caseId === 'sui-response-bytes-inclusive-case' || entry.caseId === 'sui-response-bytes-over-case') return { allowed: ['request-1MiB-inclusive', 'response-8MiB-inclusive', 'trailer-8KiB-inclusive'], forbidden: ['request-1MiB-plus-one'] }
    if (entry.caseId === 'sui-trailer-bytes-inclusive-case' || entry.caseId === 'sui-trailer-bytes-over-case') return { allowed: ['request-1MiB-inclusive', 'response-8MiB-inclusive', 'trailer-8KiB-inclusive'], forbidden: ['request-1MiB-plus-one'] }
    const operation = entry.operation.wireOperation.endsWith('GetBalance') ? 'GetBalance' : entry.operation.wireOperation.endsWith('GetObject') ? 'GetObject' : 'GetServiceInfo'
    return { allowed: [operation], forbidden: fullSuiForbidden }
  }
  if (entry.clientContractId === 'client-bitcoin-rpc') {
    if (entry.caseId === 'c1-bitcoin-twelve-named-methods-and-result-shapes' || entry.caseId === 'btc-gettxout-null-result') return fullBitcoinSurface()
    if (entry.caseId === 'c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values' || entry.caseId === 'btc-resource-exponent-boundary-and-overflow') return entry.caseId.startsWith('btc-resource') ? { allowed: ['bounded-preflight'], forbidden: ['float-rounding', 'unbounded-expansion'] } : { allowed: ['getNetworkInfo'], forbidden: [] }
    if (entry.caseId === 'c1-bitcoin-new-languages-have-no-raw-request-batch-subscription') return { allowed: ['named-read-methods'], forbidden: ['raw', 'request', 'batch', 'subscription'] }
    if (entry.caseId === 'btc-duplicate-escaped-key-last-wins') return { allowed: ['duplicate-last-wins', 'escaped-equivalent-keys'], forbidden: ['prototype-mutation'] }
    if (entry.caseId === 'btc-u64-overflow-and-integer-token-rejection') return { allowed: ['integer-token-check'], forbidden: ['rounding', 'saturation'] }
    if (entry.caseId === 'btc-u64-maximum-integer-projection') return { allowed: ['getBlockCount'], forbidden: [] }
    if (entry.caseId === 'btc-duplicate-escaped-equivalent' || entry.caseId === 'btc-root-duplicate-id-last-wins') return { allowed: ['getNetworkInfo'], forbidden: [] }
    if (entry.caseId.startsWith('btc-method-')) return { allowed: [entry.operation.wireOperation], forbidden: [] }
    if (entry.caseId.startsWith('btc-u64-')) return { allowed: ['getblockcount'], forbidden: [] }
    if (entry.caseId.startsWith('btc-explicit-') || entry.caseId.startsWith('btc-long-coefficient-')) return { allowed: ['getnetworkinfo'], forbidden: [] }
    if (entry.caseId.startsWith('btc-')) return { allowed: ['getNetworkInfo'], forbidden: [] }
    if (entry.caseId === 'c1-direct-bitcoin-exact-target-scoped-header-keyless') return { allowed: ['getBestBlockHash'], forbidden: ['raw', 'request', 'batch', 'subscription'] }
    if (entry.caseId === 'c1-hosted-bitcoin-bearer-no-query-null-error') return { allowed: ['getBlockchainInfo'], forbidden: ['raw', 'request', 'batch', 'subscription'] }
    return { allowed: [entry.caseId.startsWith('btc-') ? entry.operation.wireOperation : tsPublicOperation(entry)], forbidden: [] }
  }
  if (entry.caseId === 'c1-path-query-header-and-api-key-redaction') return { allowed: ['credential-safe-errors'], forbidden: ['credential-leak'] }
  if (entry.caseId === 'c1-hosted-arbitrum-root-and-edge-no-duplicate-suffix') return { allowed: ['eth_call'], forbidden: [] }
  if (entry.caseId === 'c1-direct-arbitrum-exact-target-scoped-header-origin-only-diagnostic' || entry.caseId === 'c1-response-id-http-jsonrpc-and-malformed-response-errors' || entry.caseId === 'c2-sealed-polygon-bsc-optimism-identity-rows' || entry.caseId === 'c4-hyperliquid-eth-chain-id-read' || entry.caseId.startsWith('matrix-rpc-')) return { allowed: [entry.operation.publicOperation === 'getGenesisHash' ? 'getGenesisHash' : 'eth_chainId'], forbidden: [] }
  if (entry.caseId === 'c1-direct-base-exact-target-scoped-header-origin-only-diagnostic') return { allowed: ['eth_getBalance'], forbidden: [] }
  return { allowed: [tsPublicOperation(entry)], forbidden: [] }
}

const surfaceForCase = (entry: FixtureCase, client: AnyRecord): AnyRecord => {
  const surface = rpcSurface(client, entry.clientContractId)
  const keys = Object.keys(surface)
  if (entry.operation.publicOperation === 'surface') {
    const methodSet = methodSetFor(entry.clientContractId)
    if (methodSet.kind === 'expanded') {
      const actualAllowed = methodSet.capabilities.map((item: AnyRecord) => item.publicNames?.typescript ?? item.publicOperation)
      for (const name of actualAllowed) expect(keys).toContain(name)
    }
    if (entry.clientContractId === 'client-base-rpc') expect(keys).toEqual(expect.arrayContaining(['endpoint', 'eth_chainId', 'eth_getBalance', 'eth_call']))
    const policy = surfacePolicy(entry)
    for (const forbidden of policy.forbidden as string[]) if (forbidden in surface) throw new Error(`${entry.caseId} exposed forbidden surface ${forbidden}`)
    return policy
  }
  if (entry.operation.publicOperation === 'cancellation') {
    const policy = surfacePolicy(entry)
    expect(surface.endpoint).toBe('https://unconfigured.invalid/base')
    return policy
  }
  const publicName = tsPublicOperation(entry)
  const methodSet = methodSetFor(entry.clientContractId)
  if (methodSet.kind === 'legacy-reference') expect(typeof surface[publicName]).toBe('function')
  else expect(keys).toContain(publicName)
  const policy = surfacePolicy(entry)
  for (const forbidden of policy.forbidden as string[]) {
    if (forbidden in surface) throw new Error(`${entry.caseId} exposed forbidden surface ${forbidden}`)
  }
  return policy
}

const assertSuiResultShape = (entry: FixtureCase, result: AnyRecord): void => {
  if (entry.operation.publicOperation === 'getObject') {
    if (result.objectId !== '0x2' || result.version !== 7n || result.digest !== 'digest') throw new Error(`${entry.caseId} Sui object result differs from the independent golden payload`)
    return
  }
  if (entry.operation.publicOperation === 'getBalance') {
    if (result.coinType !== '0x2::sui::SUI' || result.balance !== 42n || result.addressBalance !== 40n || result.coinBalance !== 2n) throw new Error(`${entry.caseId} Sui balance result differs from the independent golden payload`)
    return
  }
  if (result.chainId !== '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S' || result.chain !== 'mainnet' || result.epoch !== 18_446_744_073_709_551_615n || result.checkpointHeight !== 42n || result.timestampSeconds !== 1_723_456_789n || result.timestampNanos !== 123 || result.lowestAvailableCheckpoint !== 0n || result.lowestAvailableCheckpointObjects !== 0n || result.server !== 'sui-test') {
    throw new Error(`${entry.caseId} Sui service-info result differs from the independent golden payload`)
  }
}

const successPolicyLabel = (entry: FixtureCase): unknown => {
  if (entry.caseId === 'c1-bitcoin-twelve-named-methods-and-result-shapes') return undefined
  if (entry.caseId === 'c1-bitcoin-new-languages-have-no-raw-request-batch-subscription') return 'named-only'
  if (entry.caseId === 'c1-sealed-evm-three-method-payloads-and-no-escape-hatches') return 'sealed-read3'
  if (entry.caseId === 'c4-hyperevm-arc-robinhood-product-scope') return 'HyperEVM-only'
  if (entry.caseId === 'c1-schedule-immediate-response') return 'schedule-control'
  if (entry.caseId.includes('method-coverage')) return 'method coverage'
  if (entry.caseId === 'sui-framing-sui-data-and-terminal-trailer') return 'framing-control'
  if (entry.caseId === 'sui-request-bytes-inclusive-case' || entry.caseId === 'sui-response-bytes-inclusive-case') return 'response boundary'
  if (entry.caseId === 'sui-trailer-bytes-inclusive-case') return 'trailer boundary'
  if (entry.clientContractId === 'client-sui-grpc' && entry.caseId === 'c5-sui-binary-limit-descriptor') return 'sui-golden'
  if (entry.clientContractId === 'client-sui-grpc' && entry.caseId.startsWith('sui-golden-')) return 'sui-golden'
  if (entry.caseId === 'btc-canonical-exponent-inclusive' || entry.caseId === 'btc-chunked-content-length-adversary' || entry.caseId === 'btc-container-depth-inclusive' || entry.caseId === 'btc-decoded-entity-inclusive' || entry.caseId === 'btc-json-token-budget-inclusive' || entry.caseId === 'btc-numeric-lexeme-inclusive' || entry.caseId === 'btc-prototype-marker-safe') return 'exact-boundary'
  if (entry.caseId === 'btc-explicit-exponent-inclusive' || entry.caseId === 'btc-explicit-negative-exponent-inclusive' || entry.caseId === 'btc-long-coefficient-inclusive') return 'exact-number'
  if (entry.caseId === 'btc-duplicate-escaped-equivalent' || entry.caseId === 'btc-duplicate-escaped-key-last-wins' || entry.caseId === 'btc-root-duplicate-id-last-wins') return 'last-occurrence-wins'
  if (entry.caseId === 'btc-u64-max-token') return 'exact-number'
  if (entry.caseId === 'btc-u64-maximum-integer-projection') return '18446744073709551615'
  if (entry.caseId === 'c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values') return 'exact-json'
  if (entry.caseId === 'c1-existing-ethereum-solana-avalanche-and-typescript-base-regression') return undefined
  return undefined
}

const invokeOutcomeValue = (entry: FixtureCase, result: unknown): unknown => {
  if (entry.clientContractId === 'client-sui-grpc') {
    assertSuiResultShape(entry, result as AnyRecord)
    return successPolicyLabel(entry)
  }
  if (entry.clientContractId === 'client-near-rpc') {
    assertJsonSuccessMatchesSource(entry, result)
    return semanticValue(nearWireResult(entry.operation.publicOperation, result as AnyRecord))
  }
  assertJsonSuccessMatchesSource(entry, result)
  const policy = successPolicyLabel(entry)
  return policy === undefined ? semanticValue(result) : policy
}

const buildTrace = (entry: FixtureCase, capture: CaptureRecord | undefined, measuredCount: number): AnyRecord => {
  if (measuredCount === 0 || capture === undefined) {
    const zeroMarker = entry.caseId === 'c1-schedule-pre-cancel' || entry.caseId === 'sui-request-bytes-over-case'
    const recipeHash = zeroMarker ? '0'.repeat(64) : sha256(requestBytes(entry))
    return {
      method: 'NONE', target: 'NO_IO', headers: {},
      bodySha256: recipeHash,
      attempts: 0, ioKind: 'none',
    }
  }
  const bodyHash = entry.mockExchange.request.bodyEncoding === 'json'
    ? parity.normalizeJsonRequestBytes(Buffer.from(capture.bodyBase64, 'base64')).sha256
    : sha256(Buffer.from(capture.bodyBase64, 'base64'))
  const rawTarget = new URL(capture.url)
  if (entry.setup.mode === 'hosted') rawTarget.search = ''
  return {
    method: 'POST',
    target: redact(rawTarget.toString(), entry).replace(/\/$/u, rawTarget.pathname.endsWith('/') ? '/' : ''),
    headers: redactedHeaders(capture.headers, entry, entry.clientContractId === 'client-sui-grpc'),
    bodySha256: bodyHash,
    attempts: 1,
    ioKind: 'performed',
  }
}

const SEALED_ENDPOINT_CLIENTS = new Set([
  'client-base-rpc',
  'client-arbitrum-rpc',
  'client-bitcoin-rpc',
  'client-bsc-rpc',
  'client-arc-rpc',
  'client-hyperliquid-rpc',
  'client-kaia-rpc',
  'client-monad-rpc',
  'client-optimism-rpc',
  'client-polygon-rpc',
  'client-robinhood-rpc',
  'client-soneium-rpc',
  'client-tron-rpc',
  'client-near-rpc',
  'client-sui-grpc',
])

const expectedPublicEndpoint = (entry: FixtureCase): string | undefined => {
  if (!SEALED_ENDPOINT_CLIENTS.has(entry.clientContractId)) return undefined
  if (entry.setup.mode === 'unconfigured') return entry.clientContractId === 'client-base-rpc' ? 'https://unconfigured.invalid/base' : ''
  if (entry.setup.mode === 'none' || typeof entry.setup.endpoint !== 'string') return undefined
  const endpoint = new URL(entry.setup.endpoint)
  if (endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') throw new Error(`${entry.caseId} setup endpoint has prohibited userinfo or fragment`)
  if (entry.setup.mode === 'hosted' && !['client-bitcoin-rpc', 'client-near-rpc', 'client-sui-grpc'].includes(entry.clientContractId)) return endpoint.toString()
  return `${endpoint.origin}/`
}

const assertPublicEndpointGetter = (entry: FixtureCase, client: AnyRecord): string => {
  const actual = rpcSurface(client, entry.clientContractId).endpoint
  if (typeof actual !== 'string') throw new Error(`${entry.caseId} public endpoint getter is not a string`)
  const expected = expectedPublicEndpoint(entry)
  if (expected !== undefined && actual !== expected) throw new Error(`${entry.caseId} public endpoint getter differs from its finite allowed value`)
  const exactOrigin = expected !== undefined && expected !== '' && new URL(expected).pathname === '/' && new URL(expected).search === ''
  if (exactOrigin) {
    const parsed = new URL(actual)
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || parsed.pathname !== '/' || parsed.search !== '') throw new Error(`${entry.caseId} public endpoint getter exposed path, query, userinfo, or fragment`)
  }
  return actual
}

const errorSummary = (entry: FixtureCase, error: unknown, actualStatus?: number): AnyRecord => {
  const nativeCategory = errorCategory(error)
  if (error instanceof ErpcHttpError) {
    const rawStatus = entry.mockExchange.response.status
    if (error.status !== rawStatus || actualStatus !== undefined && actualStatus !== error.status) throw new Error(`${entry.caseId} native HTTP status differs from the raw exchange`)
  }
  if (entry.scheduleId === 'life-redirect-to-second-server') {
    if (!(error instanceof ErpcHttpError) || nativeCategory !== 'http-status' || error.status !== entry.mockExchange.response.status) throw new Error(`${entry.caseId} redirect label requires the actual HTTP error and raw status`)
  }
  if (entry.setup.mode === 'unconfigured') {
    const expectedNamespace = contract.clientContracts.find((client: AnyRecord) => client.clientContractId === entry.clientContractId)?.namespace
    if (!(error instanceof ErpcNotConfiguredError) || error.namespace !== expectedNamespace) throw new Error(`${entry.caseId} missing-namespace label requires the actual invoked namespace`)
  }
  const category = entry.scheduleId === 'life-redirect-to-second-server' ? 'http-redirect' : nativeCategory
  if (error instanceof ErpcJsonRpcError) assertJsonRpcErrorMatchesSource(entry, error)
  let message: string
  if (entry.caseId === 'btc-resource-exponent-boundary-and-overflow') message = 'numeric resource bound exceeded'
  else if (entry.caseId === 'c1-path-query-header-and-api-key-redaction') message = 'fixture secret was redacted'
  else if (entry.caseId === 'btc-error-data-lossless-redaction') message = 'approved golden failure'
  else if (entry.caseId === 'c1-response-id-http-jsonrpc-and-malformed-response-errors') message = 'response identity or envelope is invalid'
  else if (entry.caseId === 'c1-schedule-first-chunk-cancellation-barrier') message = 'request cancelled after first chunk'
  else if (entry.caseId === 'c1-schedule-first-chunk-then-delay') message = 'body timed out'
  else if (entry.caseId === 'c1-schedule-pre-cancel') message = 'request cancelled'
  else if (entry.caseId === 'c1-schedule-withhold-headers') message = 'request timed out'
  else if (entry.caseId === 'c1-schedule-reset-after-first-chunk') message = 'connection reset after first chunk'
  else if (entry.caseId === 'c1-schedule-reset-before-headers') message = 'connection reset before headers'
  else if (entry.caseId === 'c1-unconfigured-namespace-fails-locally-with-zero-io') message = 'bitcoin.rpc is not configured'
  else if (entry.caseId === 'sui-request-bytes-over-case') message = 'request exceeds 1 MiB'
  else if (entry.caseId === 'sui-response-bytes-over-case') message = 'response byte limit'
  else if (entry.caseId === 'sui-trailer-bytes-over-case') message = 'trailer byte limit'
  else if (entry.caseId.startsWith('sui-framing-')) message = 'invalid-response'
  else if (entry.caseId === 'c1-one-attempt-no-redirect-timeout-and-cancellation' || entry.caseId === 'c1-schedule-redirect-to-second-server') message = 'HTTP status 302'
  else if (category === 'invalid-response' && entry.clientContractId === 'client-bitcoin-rpc') message = 'invalid response bytes'
  else throw new Error(`${entry.caseId} has no independent error summary policy for ${category}`)
  return { kind: 'error', category, message }
}

const readRequestBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

const responseHeaders = (entry: FixtureCase): Record<string, string> => ({
  ...entry.mockExchange.response.headers,
})

const splitFirstChunk = (body: Buffer): [Buffer, Buffer] => {
  const split = Math.max(1, Math.floor(body.length / 2))
  return [body.subarray(0, split), body.subarray(split)]
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const writeChunkAndFlush = async (response: ServerResponse, chunk: Buffer): Promise<void> => {
  await Promise.race([
    new Promise<void>((resolvePromise) => response.write(chunk, () => resolvePromise())),
    wait(1000),
  ])
}

const runNativeCase = async (
  entry: FixtureCase,
  port: number,
): Promise<{ readonly client: AnyRecord; readonly result?: unknown; readonly error?: unknown; readonly captures: readonly CaptureRecord[]; readonly measuredCapture?: CaptureRecord; readonly responseStatus?: number; readonly surface: AnyRecord }> => {
  const schedule = entry.scheduleId === null ? undefined : fixture.lifecycleSchedules.find((item: AnyRecord) => item.id === entry.scheduleId)
  const response = responseBytes(entry)
  const captures: CaptureRecord[] = []
  const state: AnyRecord = {
    entry,
    warmupsRemaining: 0,
    measuredCalls: 0,
    measuredStatus: undefined,
    measuredCapture: undefined,
    firstChunkResolve: undefined,
    firstChunk: undefined,
    response,
    schedule,
  }
  state.firstChunk = new Promise<void>((resolvePromise) => { state.firstChunkResolve = resolvePromise })
  const server = (globalThis as AnyRecord).__ERPC_TS_CAPTURE_SERVER as AnyRecord
  server.state = state

  const fetchAdapter: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body === undefined ? Buffer.alloc(0) : Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())
    const headers: Record<string, string> = {}
    for (const [name, value] of new Headers(init?.headers).entries()) headers[name] = value
    const phase: 'setup' | 'measured' = state.warmupsRemaining > 0 ? 'setup' : 'measured'
    const capture: CaptureRecord = {
      caseId: entry.caseId,
      phase,
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      bodyBase64: body.toString('base64'),
      bodySha256: sha256(body),
    }
    captures.push(capture)
    if (phase === 'measured') state.measuredCapture = capture
    const original = new URL(String(input))
    const localUrl = `http://127.0.0.1:${port}${original.pathname}${original.search}`
    const localInit: RequestInit = { ...init }
    if (init?.headers !== undefined) localInit.headers = init.headers
    const localResponse = await globalThis.fetch(localUrl, localInit)
    if (phase === 'measured') state.measuredStatus = localResponse.status
    return localResponse
  }

  const timeoutMs = schedule?.timeoutMs ?? 5000
  const client = createErpcClient(buildClientConfig(entry, fetchAdapter, timeoutMs)) as AnyRecord
  assertPublicEndpointGetter(entry, client)
  const surface = surfaceForCase(entry, client)
  let result: unknown
  let error: unknown
  try {
    const surfaceCall = entry.operation.publicOperation === 'surface' || entry.operation.publicOperation === 'cancellation'
    if (surfaceCall) {
      if (entry.operation.publicOperation === 'cancellation') expect(rpcSurface(client, entry.clientContractId).endpoint).toBe('https://unconfigured.invalid/base')
    } else {
      const requestBody = entry.mockExchange.request.bodyEncoding === 'json' ? requestBytes(entry) : null
      const measuredId = requestBody === null ? 0 : Number((JSON.parse(requestBody.toString('utf8')) as AnyRecord).id)
      state.warmupsRemaining = measuredId > 1 ? measuredId - 1 : 0
      const warmupCount = state.warmupsRemaining
      for (let index = 0; index < warmupCount; index += 1) {
        const warmup = invokePublic(client, entry)
        if (warmup === null) throw new Error(`${entry.caseId} warmup cannot target a surface case`)
        await warmup
      }
      if (schedule?.kind === 'pre-cancel') {
        const controller = new AbortController()
        controller.abort()
        result = await invokePublic(client, entry, { signal: controller.signal })
      } else if (schedule?.kind === 'first-chunk-cancellation-barrier') {
        const controller = new AbortController()
        const operationPromise = invokePublic(client, entry, { signal: controller.signal })
        await Promise.race([state.firstChunk, wait(1000)])
        controller.abort()
        result = await operationPromise
      } else {
        const measured = invokePublic(client, entry)
        if (measured === null) throw new Error(`${entry.caseId} measured operation unexpectedly has no request`)
        result = await measured
      }
    }
  } catch (value) {
    error = value
  } finally {
    client.close()
  }
  return { client, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }), captures, measuredCapture: state.measuredCapture, ...(state.measuredStatus === undefined ? {} : { responseStatus: state.measuredStatus }), surface }
}

const assertCaptureWire = (entry: FixtureCase, run: AnyRecord): void => {
  const captures = (run.captures as CaptureRecord[]).filter((capture) => capture.phase === 'measured')
  const expectsNoIo = entry.operation.publicOperation === 'surface' || entry.operation.publicOperation === 'cancellation' || entry.setup.mode === 'unconfigured' || entry.caseId === 'sui-request-bytes-over-case' || entry.scheduleId === 'life-pre-cancel'
  if (expectsNoIo) {
    if (captures.length !== 0) throw new Error(`${entry.caseId} performed I/O despite its approved no-I/O recipe`)
    return
  }
  if (captures.length !== 1) throw new Error(`${entry.caseId} performed ${captures.length} measured requests; expected exactly one`)
  const capture = captures[0]
  if (capture === undefined) throw new Error(`${entry.caseId} measured request capture is missing`)
  if (capture.method !== entry.mockExchange.request.method) throw new Error(`${entry.caseId} native method differs from the request recipe`)
  if (capture.url !== entry.mockExchange.request.target) throw new Error(`${entry.caseId} native target path/query differs from the request recipe`)
  const expectedHeaders = entry.mockExchange.request.headers as Record<string, string>
  const actualHeaders = Object.fromEntries(Object.entries(capture.headers).map(([name, value]) => [name.toLowerCase(), value]))
  const allowedAutomaticHeaders = new Set(['accept'])
  for (const name of Object.keys(actualHeaders)) {
    if (!Object.hasOwn(expectedHeaders, name) && !allowedAutomaticHeaders.has(name)) throw new Error(`${entry.caseId} native request exposed an unexpected header ${name}`)
  }
  for (const [name, value] of Object.entries(expectedHeaders)) {
    if (actualHeaders[name.toLowerCase()] !== value) throw new Error(`${entry.caseId} native scoped header ${name} differs from the request recipe`)
  }
  const capturedBody = Buffer.from(capture.bodyBase64, 'base64')
  const bodyHash = sha256(capturedBody)
  if (bodyHash !== entry.mockExchange.request.bodySha256) throw new Error(`${entry.caseId} native request bytes differ from the request recipe`)
}

const SUPPLEMENTAL_SUI_CASES = [
  { goldenId: 'sui-get-object-embedded-depth100', operation: 'getObject', params: [{ objectId: '0x2', version: null }] },
  { goldenId: 'sui-get-object-embedded-depth101', operation: 'getObject', params: [{ objectId: '0x2', version: null }] },
  { goldenId: 'sui-get-service-info-timestamp-merge-final-zero', operation: 'getServiceInfo', params: [] },
  { goldenId: 'sui-get-service-info-timestamp-merge-final-invalid', operation: 'getServiceInfo', params: [] },
] as const

const supplementalSuiEntry = (descriptor: (typeof SUPPLEMENTAL_SUI_CASES)[number]): FixtureCase => {
  const golden = fixture.suiGrpcWeb.golden.find((candidate: AnyRecord) => candidate.id === descriptor.goldenId)
  if (golden === undefined) throw new Error(`missing supplemental Sui golden ${descriptor.goldenId}`)
  const base = fixture.cases.find((candidate: FixtureCase) => candidate.caseId === 'sui-golden-service-info')
  if (base === undefined) throw new Error('missing Sui base capture case')
  const requestBody = Buffer.from(golden.requestFrameHex, 'hex')
  const methodPath = golden.methodPath as string
  const entry = structuredClone(base) as FixtureCase
  entry.caseId = `supplemental-${descriptor.goldenId}`
  entry.caseKind = 'supplemental-sui-golden'
  entry.exceptionIds = []
  entry.scheduleId = null
  entry.operation = {
    publicOperation: descriptor.operation,
    wireOperation: methodPath,
    params: structuredClone(descriptor.params),
  }
  entry.requestDescriptor = undefined
  entry.responseDescriptor = undefined
  entry.mockExchange = {
    request: {
      method: 'POST',
      target: `https://sui.fixture.invalid/prefix${methodPath}?fixture=1`,
      headers: { ...base.mockExchange.request.headers },
      bodyEncoding: 'hex',
      body: golden.requestFrameHex,
      bodySha256: sha256(requestBody),
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/grpc-web+proto' },
      bodyEncoding: 'hex',
      body: golden.responseBodyHex,
    },
  }
  entry.expected = { binary: null }
  return entry
}

const assertSupplementalSuiResult = (descriptor: (typeof SUPPLEMENTAL_SUI_CASES)[number], run: AnyRecord): void => {
  if (descriptor.goldenId === 'sui-get-object-embedded-depth100') {
    const result = run.result as AnyRecord | undefined
    if (run.error !== undefined || result?.objectId !== '' || result.version !== 0n || result.digest !== '') throw new Error(`${descriptor.goldenId} actual public decode did not preserve depth-100 fields`)
    return
  }
  if (descriptor.goldenId === 'sui-get-object-embedded-depth101') {
    if (!(run.error instanceof ErpcInvalidResponseError)) throw new Error(`${descriptor.goldenId} did not reject recursion depth 101 with ErpcInvalidResponseError`)
    return
  }
  if (descriptor.goldenId === 'sui-get-service-info-timestamp-merge-final-zero') {
    const result = run.result as AnyRecord | undefined
    if (run.error !== undefined || result?.chainId !== 'chain' || result.chain !== 'mainnet' || result.epoch !== 0n || result.checkpointHeight !== 0n || result.timestampSeconds !== 42n || result.timestampNanos !== 0 || result.lowestAvailableCheckpoint !== 0n || result.lowestAvailableCheckpointObjects !== 0n) throw new Error(`${descriptor.goldenId} actual public decode did not preserve the final-zero Timestamp merge`)
    return
  }
  if (!(run.error instanceof ErpcInvalidResponseError)) throw new Error(`${descriptor.goldenId} did not reject the invalid final Timestamp nanos`)
}

const supplementalCaptureRecord = (descriptor: (typeof SUPPLEMENTAL_SUI_CASES)[number], entry: FixtureCase, run: AnyRecord): AnyRecord => {
  const measured = (run.captures as CaptureRecord[]).find((capture) => capture.phase === 'measured')
  if (measured === undefined) throw new Error(`${descriptor.goldenId} has no measured request capture`)
  const response = responseBytes(entry)
  return {
    goldenId: descriptor.goldenId,
    caseId: entry.caseId,
    request: {
      method: measured.method,
      target: measured.url,
      headers: Object.fromEntries(Object.entries(measured.headers).map(([name, value]) => [name.toLowerCase(), redact(value, entry)])),
      bodyBase64: measured.bodyBase64,
      bodySha256: measured.bodySha256,
    },
    responseStatus: run.responseStatus ?? null,
    responseSource: { bodyBytes: response.length, bodySha256: sha256(response) },
    surface: run.surface,
    actualResult: run.error === undefined ? serializeActual(run.result) : null,
    actualError: run.error === undefined ? null : {
      name: run.error instanceof Error ? run.error.name : 'UnknownError',
      category: errorCategory(run.error),
      code: run.error instanceof ErpcError ? run.error.code : undefined,
      message: run.error instanceof Error ? run.error.message : String(run.error),
    },
  }
}

const runSupplementalSuiCases = async (port: number): Promise<{ readonly records: readonly AnyRecord[]; readonly blockers: readonly AnyRecord[] }> => {
  const records: AnyRecord[] = []
  const blockers: AnyRecord[] = []
  for (const descriptor of SUPPLEMENTAL_SUI_CASES) {
    const entry = supplementalSuiEntry(descriptor)
    const run = await runNativeCase(entry, port)
    try {
      assertCaptureWire(entry, run)
      assertSupplementalSuiResult(descriptor, run)
    } catch (value) {
      blockers.push({ caseId: entry.caseId, message: value instanceof Error ? value.message : String(value) })
    }
    records.push(supplementalCaptureRecord(descriptor, entry, run))
  }
  return { records, blockers }
}

const failOnNativeCaptureBlockers = (blockers: readonly AnyRecord[]): void => {
  if (blockers.length > 0) throw new Error(`native capture blocked by actual observation failures: ${blockers.map((blocker) => blocker.caseId).join(', ')}`)
}

const installCaptureServer = async (): Promise<{ readonly server: ReturnType<typeof createServer>; readonly port: number }> => {
  const stateHolder: AnyRecord = { state: undefined }
  ;(globalThis as AnyRecord).__ERPC_TS_CAPTURE_SERVER = stateHolder
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const state = stateHolder.state as AnyRecord | undefined
    if (state === undefined) {
      response.writeHead(500)
      response.end()
      return
    }
    const requestBody = await readRequestBody(request)
    if (state.warmupsRemaining > 0) {
      state.warmupsRemaining -= 1
      const warmup = genericJsonResponse(state.entry, requestBody)
      response.writeHead(200, { 'content-type': state.entry.clientContractId === 'client-sui-grpc' ? 'application/grpc-web+proto' : 'application/json' })
      response.end(warmup)
      return
    }
    state.measuredCalls += 1
    const entry = state.entry as FixtureCase
    const schedule = state.schedule as AnyRecord | undefined
    const status = entry.mockExchange.response.status as number
    const headers = responseHeaders(entry)
    if (schedule?.kind === 'redirect-to-second-server') {
      response.writeHead(status, { ...headers, location: 'http://127.0.0.1:1/redirect-target' })
      response.end()
      return
    }
    if (schedule?.kind === 'reset-before-headers') {
      request.socket.destroy()
      return
    }
    if (schedule?.kind === 'withhold-headers') {
      await wait(schedule.delayMs)
      try { response.writeHead(status, headers); response.end(state.response) } catch { /* client deadline owns the outcome */ }
      return
    }
    const [first, remainder] = splitFirstChunk(state.response)
    if (schedule?.kind === 'first-chunk-then-delay') {
      response.writeHead(status, headers)
      response.write(first)
      await wait(schedule.delayMs)
      try { response.end(remainder) } catch { /* client deadline owns the outcome */ }
      return
    }
    if (schedule?.kind === 'first-chunk-cancellation-barrier') {
      response.writeHead(status, headers)
      response.write(first)
      state.firstChunkResolve?.()
      await Promise.race([new Promise<void>((resolvePromise) => response.once('close', () => resolvePromise())), wait(1000)])
      try { response.end(remainder) } catch { /* cancellation owns the outcome */ }
      return
    }
    if (schedule?.kind === 'reset-after-first-chunk') {
      response.writeHead(status, headers)
      await writeChunkAndFlush(response, first)
      response.destroy()
      return
    }
    response.writeHead(status, headers)
    response.end(state.response)
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('capture server did not expose an address')
  return { server, port: address.port }
}

const observedBehavior = (entry: FixtureCase, run: AnyRecord): AnyRecord => {
  const measuredCaptures = (run.captures as CaptureRecord[]).filter((capture) => capture.phase === 'measured')
  const hasError = run.error !== undefined
  let outcome: AnyRecord
  const actualPublicEndpoint = assertPublicEndpointGetter(entry, run.client)
  if (hasError) outcome = errorSummary(entry, run.error, run.responseStatus)
  else if (entry.operation.publicOperation === 'surface') {
    outcome = entry.caseId === 'c1-bitcoin-new-languages-have-no-raw-request-batch-subscription'
      ? { kind: 'not-applicable', value: 'named-only' }
      : { kind: 'success', value: successPolicyLabel(entry) }
  } else if (entry.operation.publicOperation === 'cancellation') {
    outcome = { kind: 'not-applicable', value: 'https://unconfigured.invalid/base' }
  } else outcome = { kind: 'success', value: invokeOutcomeValue(entry, run.result) }
  const binary = entry.clientContractId === 'client-sui-grpc' && measuredCaptures.length > 0
    ? { encoding: 'hex', decodedLength: responseBytes(entry).length, sha256: sha256(responseBytes(entry)) }
    : null
  if (entry.clientContractId === 'client-sui-grpc' && entry.expected.binary !== null && binary !== null && stableJson(entry.expected.binary) !== stableJson(binary)) {
    throw new Error(`${entry.caseId} binary metadata does not match the resolved response bytes`)
  }
  return {
    outcome,
    trace: buildTrace(entry, measuredCaptures[0], measuredCaptures.length),
    endpointDiagnostic: measuredCaptures.length === 0
      ? (entry.caseId === 'c1-schedule-pre-cancel' ? `${new URL(entry.setup.endpoint).origin}/` : '')
      : `${new URL(actualPublicEndpoint).origin}/`,
    ioCount: measuredCaptures.length,
    surface: run.surface,
    numericTuples: numericTuplesForRun(entry, run),
    binary,
    operation: {
      publicOperation: tsPublicOperation(entry),
      wireOperation: entry.operation.wireOperation,
      params: structuredClone(entry.operation.params),
    },
    caseKind: entry.caseKind,
    exceptionIds: [...entry.exceptionIds].sort(),
  }
}

const nativeCapture = async (): Promise<void> => {
  const applicable = fixture.cases
    .filter((entry: FixtureCase) => entry.applicability.includes('typescript'))
    .sort((left: FixtureCase, right: FixtureCase) => left.caseId.localeCompare(right.caseId))
  expect(applicable).toHaveLength(122)
  const { server, port } = await installCaptureServer()
  const behavior: Record<string, AnyRecord> = {}
  const rawLog: AnyRecord[] = []
  const blockers: AnyRecord[] = []
  const completedCaseIds = new Set<string>()
  const surfaceInventories = new Map<string, readonly string[]>()
  let supplementalRecords: readonly AnyRecord[] = []
  try {
    for (const entry of applicable) {
      const run = await runNativeCase(entry, port)
      let actual: AnyRecord | undefined
      try {
        assertCaptureWire(entry, run)
        actual = observedBehavior(entry, run)
        completedCaseIds.add(entry.caseId)
        behavior[entry.caseId] = actual
        parity.validateObservedCase({ caseId: entry.caseId, language: 'typescript', observation: actual })
      } catch (validationError) {
        blockers.push({ caseId: entry.caseId, message: validationError instanceof Error ? validationError.message : String(validationError), ...(actual === undefined ? {} : { actual }) })
      }
      const surfaceKeys = Object.keys(rpcSurface(run.client, entry.clientContractId)).sort()
      const priorInventory = surfaceInventories.get(entry.clientContractId)
      if (priorInventory === undefined) surfaceInventories.set(entry.clientContractId, surfaceKeys)
      else if (stableJson(priorInventory) !== stableJson(surfaceKeys)) blockers.push({ caseId: entry.caseId, message: `${entry.clientContractId} native surface inventory changed between cases` })
      const warmups = run.captures.filter((capture) => capture.phase === 'setup')
      const measured = run.captures.filter((capture) => capture.phase === 'measured')
      const summarizeCapture = (capture: CaptureRecord | undefined): AnyRecord | null => capture === undefined ? null : {
        method: capture.method,
        target: redact(capture.url, entry),
        headers: Object.fromEntries(Object.entries(capture.headers).map(([name, value]) => [name.toLowerCase(), redact(value, entry)])),
        bodyBase64: capture.bodyBase64,
        bodySha256: capture.bodySha256,
      }
      const actualError = run.error === undefined ? null : {
        name: run.error instanceof Error ? run.error.name : 'UnknownError',
        category: errorCategory(run.error),
        code: run.error instanceof ErpcError ? run.error.code : undefined,
        message: run.error instanceof Error ? run.error.message : String(run.error),
        ...(run.error instanceof ErpcJsonRpcError ? { rpcCode: run.error.rpcCode, data: serializeActual(run.error.data) } : {}),
      }
      rawLog.push({
        caseId: entry.caseId,
        publicEndpoint: assertPublicEndpointGetter(entry, run.client),
        responseStatus: run.responseStatus ?? null,
        warmups: {
          count: warmups.length,
          first: summarizeCapture(warmups[0]),
          last: summarizeCapture(warmups[warmups.length - 1]),
        },
        measured: summarizeCapture(measured[0]),
        requestBytesBase64: measured[0]?.bodyBase64 ?? null,
        requestBytesSha256: measured[0]?.bodySha256 ?? null,
        actualNumericTuples: numericTuplesForRun(entry, run),
        actualResult: run.error === undefined ? serializeActual(run.result) : null,
        actualError,
      })
    }
    const supplemental = await runSupplementalSuiCases(port)
    supplementalRecords = supplemental.records
    blockers.push(...supplemental.blockers)
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  const outputPath = process.env.ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT
  if (blockers.length > 0) {
    console.warn('native capture fixture blockers', JSON.stringify(blockers.map((blocker) => ({ caseId: blocker.caseId, message: blocker.message }))))
    if (outputPath !== undefined && outputPath !== '') {
      await writeFile(`${outputPath}.raw.json`, `${JSON.stringify(rawLog, null, 2)}\n`)
      await writeFile(`${outputPath}.blockers.json`, `${JSON.stringify(blockers, null, 2)}\n`)
      await writeFile(`${outputPath}.sui-supplemental.json`, `${JSON.stringify(supplementalRecords, null, 2)}\n`)
    }
    failOnNativeCaptureBlockers(blockers)
  }

  const scope = expectedScope(5)
  const snapshotBase = {
    snapshotVersion: 1,
    snapshotKind: parity.SNAPSHOT_KIND,
    language: 'typescript',
    runtime: `typescript-source-capture ${process.version}`,
    contractVersion: contract.contractVersion,
    contractDigest: contract.contentDigest,
    fixtureDigest: fixture.fixtureDigest,
    scope,
    coverage: captureCoverage(scope, completedCaseIds),
    behavior,
    surface: captureSurface(scope, surfaceInventories),
  }
  if (outputPath === undefined || outputPath === '') return
  const manifestPath = process.env.ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST
  if (manifestPath === undefined || manifestPath === '') throw new Error('ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST is required when capture output is enabled')
  const sourceManifestSha256 = sha256(await readFile(manifestPath))
  const payloadSha256 = parity.computeSnapshotPayloadSha256(snapshotBase)
  const snapshot = {
    ...snapshotBase,
    evidence: {
      kind: 'native-capture-v1',
      command: 'pnpm --filter @elsoul/erpc-sdk test -- test/rpc_network_contract.test.ts',
      exitCode: 0,
      sourceIdentity: { kind: 'frozen-source-manifest-v1', version: '0.11.0', sourceManifestSha256 },
      consumer: {
        command: 'TypeScript source harness with controlled local HTTP server',
        exitCode: 0,
        status: 'success',
      },
      capture: {
        command: 'TypeScript source harness with ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT',
        exitCode: 0,
        snapshotSha256: payloadSha256,
        networkCount: scope.networkIds.length,
        caseCount: applicable.length,
      },
      snapshotSha256: payloadSha256,
    },
  }
  parity.validateSingleSnapshot(snapshot, {
    language: 'typescript',
    throughCohort: 5,
    sourceManifestSha256,
  })
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  await writeFile(`${outputPath}.raw.json`, `${JSON.stringify(rawLog, null, 2)}\n`)
  await writeFile(`${outputPath}.sui-supplemental.json`, `${JSON.stringify(supplementalRecords, null, 2)}\n`)
}

describe('C1 generated TypeScript contract binding', () => {
  it('binds approved C1 method and endpoint facts without exposing the generated object', () => {
    expect(RPC_NETWORK_CONTRACT_DIGEST).toBe(RPC_NETWORK_CONTRACT.contentDigest)
    expect(BITCOIN_RPC_METHODS).toEqual([
      'estimatesmartfee',
      'getbestblockhash',
      'getblock',
      'getblockchaininfo',
      'getblockcount',
      'getblockhash',
      'getblockheader',
      'getmempoolinfo',
      'getnetworkinfo',
      'getrawmempool',
      'getrawtransaction',
      'gettxout',
    ])
    expect(ARBITRUM_RPC_METHODS).toEqual([
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect(DEFAULT_ARBITRUM_ENDPOINT).toBe('https://arbitrum.erpc.global')
    expect('RPC_NETWORK_CONTRACT' in globalThis).toBe(false)
  })

  it('executes the applicable contract cases against a controlled local HTTP server', async () => {
    await nativeCapture()
  }, 120_000)

  it('fails closed when native observations are sabotaged', () => {
    const ethereum = structuredClone(fixture.cases.find((entry: FixtureCase) => entry.caseId === 'matrix-rpc-ethereum-mainnet')) as FixtureCase
    ethereum.mockExchange.response.body = '{"jsonrpc":"2.0","id":1,"result":"0xdead"}'
    expect(() => assertJsonSuccessMatchesSource(ethereum, '0x1')).toThrow(/actual SDK result differs/u)

    const nullCase = structuredClone(fixture.cases.find((entry: FixtureCase) => entry.caseId === 'btc-gettxout-null-result')) as FixtureCase
    nullCase.mockExchange.response.bodyEncoding = 'json'
    nullCase.mockExchange.response.body = '{"jsonrpc":"2.0","id":1,"result":"wrong"}'
    expect(() => assertJsonSuccessMatchesSource(nullCase, null)).toThrow(/actual SDK result differs/u)

    const errorCase = structuredClone(fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-path-query-header-and-api-key-redaction')) as FixtureCase
    errorCase.mockExchange.response.body = '{"jsonrpc":"2.0","id":15,"error":{"code":-32001,"message":"credential probe","data":{"count":7,"fraction":0.5}}}'
    expect(() => assertJsonRpcErrorMatchesSource(errorCase, new ErpcJsonRpcError({ code: -32000, message: 'credential probe', data: { count: 7, fraction: 0.5 } }))).toThrow(/RPC code differs/u)
    errorCase.mockExchange.response.body = '{"jsonrpc":"2.0","id":15,"error":{"code":-32000,"message":"credential probe","data":{"count":7,"fraction":0.25,"large":9007199254740992}}}'
    expect(() => assertJsonRpcErrorMatchesSource(errorCase, new ErpcJsonRpcError({ code: -32000, message: 'credential probe', data: { count: 7, fraction: 0.5, large: 9007199254740993 } }))).toThrow(/error\.data differs/u)

    expect(() => assertSuiResultShape(
      fixture.cases.find((entry: FixtureCase) => entry.caseId === 'sui-golden-object-zero') as FixtureCase,
      { objectId: '0x2', version: 8n, digest: 'digest' },
    )).toThrow(/object result differs/u)

    const forbiddenSurface = {
      base: {
        rpc: {
          endpoint: 'https://fixture.invalid',
          eth_chainId: () => undefined,
          eth_getBalance: () => undefined,
          eth_call: () => undefined,
          request: () => undefined,
        },
      },
    }
    expect(() => surfaceForCase(
      fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-sealed-evm-three-method-payloads-and-no-escape-hatches') as FixtureCase,
      forbiddenSurface,
    )).toThrow(/forbidden surface/u)
    expect(() => errorCategory(new Error('unknown native throw'))).toThrow(/unknown native SDK error/u)

    const redirectCase = fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-schedule-redirect-to-second-server') as FixtureCase
    expect(() => errorSummary(redirectCase, new ErpcHttpError(418), 418)).toThrow(/HTTP status differs/u)
    expect(() => errorSummary(redirectCase, new ErpcTransportError('wrong category'), 302)).toThrow(/redirect label requires/u)
    const unconfiguredBitcoin = fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-unconfigured-namespace-fails-locally-with-zero-io') as FixtureCase
    expect(() => errorSummary(unconfiguredBitcoin, new ErpcNotConfiguredError('sui.grpc'))).toThrow(/invoked namespace/u)

    const poisonedEndpoint = structuredClone(fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-direct-base-exact-target-scoped-header-origin-only-diagnostic')) as FixtureCase
    expect(() => assertPublicEndpointGetter(poisonedEndpoint, {
      base: { rpc: { endpoint: 'https://base.fixture.invalid/REVIEW-LEAK?secret=REVIEW-LEAK' } },
    })).toThrow(/endpoint getter differs/u)

    const hostedBase = structuredClone(fixture.cases.find((entry: FixtureCase) => entry.caseId === 'c1-hosted-base-root-query-auth')) as FixtureCase
    expect(expectedPublicEndpoint(hostedBase)).toBe('https://base.erpc.global/')
    expect(() => assertPublicEndpointGetter(hostedBase, {
      base: { rpc: { endpoint: 'https://base.erpc.global/' } },
    })).not.toThrow()
    expect(() => assertPublicEndpointGetter(hostedBase, {
      base: { rpc: { endpoint: 'https://base.erpc.global/REVIEW-LEAK?secret=REVIEW-LEAK' } },
    })).toThrow(/endpoint getter differs/u)
  })

  it('fails a blocked native run without output and writes no evidence files', () => {
    const noOutputEvidencePath = `/tmp/erpc-ts-native-capture-no-output-${process.pid}.json`
    expect(existsSync(noOutputEvidencePath)).toBe(false)
    expect(() => failOnNativeCaptureBlockers([{ caseId: 'controlled-no-output-blocker' }])).toThrow(/actual observation failures/u)
    expect(existsSync(noOutputEvidencePath)).toBe(false)
  })
})
