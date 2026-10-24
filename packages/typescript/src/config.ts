import { ErpcConfigError } from './errors'
import { RPC_NETWORK_CONTRACT } from './generated/rpc_network_contract'
import type { ArbitrumRpcEndpointConfig } from './rpc/arbitrum'
import type { BitcoinRpcEndpointConfig } from './rpc/bitcoin'
import type { BscRpcEndpointConfig } from './rpc/bsc'
import type { ArcRpcEndpointConfig } from './rpc/arc'
import type { HyperliquidRpcEndpointConfig } from './rpc/hyperliquid'
import type { KaiaRpcEndpointConfig } from './rpc/kaia'
import type { MonadRpcEndpointConfig } from './rpc/monad'
import type { NearRpcEndpointConfig } from './rpc/near'
import type { OptimismRpcEndpointConfig } from './rpc/optimism'
import type { PolygonRpcEndpointConfig } from './rpc/polygon'
import type { SoneiumRpcEndpointConfig } from './rpc/soneium'
import type { RobinhoodRpcEndpointConfig } from './rpc/robinhood'
import type { SuiGrpcWebEndpointConfig } from './rpc/sui'
import type { TronRpcEndpointConfig } from './rpc/tron'
import { wrapFetch } from './transport/fetch'

interface GeneratedEndpointMode {
  readonly mode: string
  readonly publicDefault: string | null
}

interface GeneratedClientContract {
  readonly clientContractId: string
  readonly endpointModes: readonly GeneratedEndpointMode[]
}

interface GeneratedContract {
  readonly clientContracts: readonly GeneratedClientContract[]
}

const generatedContract = RPC_NETWORK_CONTRACT as unknown as GeneratedContract

const generatedPublicDefault = (clientContractId: string): string => {
  const client = generatedContract.clientContracts.find(
    (candidate) => candidate.clientContractId === clientContractId,
  )
  const value = client?.endpointModes.find((mode) => mode.mode === 'hosted')?.publicDefault
  if (value === null || value === undefined) {
    throw new Error(`Missing generated public endpoint: ${clientContractId}`)
  }
  return value
}

export const DEFAULT_ENDPOINT = 'https://edge.erpc.global'
export const DEFAULT_AVALANCHE_ENDPOINT = 'https://ava-rpc.erpc.global'
export const DEFAULT_BASE_ENDPOINT = generatedPublicDefault('client-base-rpc')
export const DEFAULT_ARBITRUM_ENDPOINT = generatedPublicDefault('client-arbitrum-rpc')
export const DEFAULT_POLYGON_ENDPOINT = generatedPublicDefault('client-polygon-rpc')
export const DEFAULT_BSC_ENDPOINT = generatedPublicDefault('client-bsc-rpc')
export const DEFAULT_OPTIMISM_ENDPOINT = generatedPublicDefault('client-optimism-rpc')
export const DEFAULT_KAIA_ENDPOINT = generatedPublicDefault('client-kaia-rpc')
export const DEFAULT_SONEIUM_ENDPOINT = generatedPublicDefault('client-soneium-rpc')
export const DEFAULT_MONAD_ENDPOINT = generatedPublicDefault('client-monad-rpc')
export const DEFAULT_HYPERLIQUID_ENDPOINT = generatedPublicDefault('client-hyperliquid-rpc')
export const DEFAULT_ARC_ENDPOINT = generatedPublicDefault('client-arc-rpc')
export const DEFAULT_ROBINHOOD_ENDPOINT = generatedPublicDefault('client-robinhood-rpc')
export const DEFAULT_NEAR_ENDPOINT = generatedPublicDefault('client-near-rpc')
export const DEFAULT_TRON_ENDPOINT = generatedPublicDefault('client-tron-rpc')
export const DEFAULT_SUI_ENDPOINT = generatedPublicDefault('client-sui-grpc')
export const DEFAULT_ACCOUNT_ENDPOINT = 'https://solana-rpc.erpc.global'
export const DEFAULT_USER_ENDPOINT = 'https://user-api.erpc.global'
export const DEFAULT_TIMEOUT_MS = 30_000

export interface RpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
  readonly webSocketUrl?: string
}

/** Caller-owned Base HTTP JSON-RPC endpoint. Base has no WebSocket facade. */
export interface BaseRpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
}

export interface ResolvedRpcEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly httpUrl: URL
  readonly webSocketUrl?: URL
}

interface ResolvedBaseRpcEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly httpUrl: URL
}

export interface ResolvedBitcoinRpcEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly httpUrl: URL
}

export interface ResolvedArbitrumRpcEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly httpUrl: URL
}

export interface ResolvedSuiGrpcWebEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly baseUrl: URL
}

export interface ErpcClientConfig {
  readonly accountEndpoint?: string
  readonly apiKey?: string
  readonly avalancheEndpoint?: string
  readonly avalancheCRpc?: RpcEndpointConfig
  readonly arbitrumEndpoint?: string
  readonly arbitrumRpc?: ArbitrumRpcEndpointConfig
  readonly baseEndpoint?: string
  readonly baseRpc?: BaseRpcEndpointConfig
  readonly bitcoinRpc?: BitcoinRpcEndpointConfig
  readonly bscEndpoint?: string
  readonly bscRpc?: BscRpcEndpointConfig
  readonly arcEndpoint?: string
  readonly arcRpc?: ArcRpcEndpointConfig
  readonly endpoint?: string
  readonly ethereumRpc?: RpcEndpointConfig
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly hyperliquidEndpoint?: string
  readonly hyperliquidRpc?: HyperliquidRpcEndpointConfig
  readonly kaiaEndpoint?: string
  readonly kaiaRpc?: KaiaRpcEndpointConfig
  readonly monadEndpoint?: string
  readonly monadRpc?: MonadRpcEndpointConfig
  readonly nearEndpoint?: string
  readonly nearRpc?: NearRpcEndpointConfig
  readonly optimismEndpoint?: string
  readonly optimismRpc?: OptimismRpcEndpointConfig
  readonly polygonEndpoint?: string
  readonly polygonRpc?: PolygonRpcEndpointConfig
  readonly robinhoodEndpoint?: string
  readonly robinhoodRpc?: RobinhoodRpcEndpointConfig
  readonly tronEndpoint?: string
  readonly tronRpc?: TronRpcEndpointConfig
  readonly suiEndpoint?: string
  readonly suiGrpcWeb?: SuiGrpcWebEndpointConfig
  readonly soneiumEndpoint?: string
  readonly soneiumRpc?: SoneiumRpcEndpointConfig
  readonly solanaRpc?: RpcEndpointConfig
  readonly timeoutMs?: number
  readonly userEndpoint?: string
  readonly webSocket?: typeof globalThis.WebSocket
}

export interface ResolvedErpcClientConfig {
  readonly accountEndpoint: URL
  readonly apiKey?: string
  readonly avalancheEndpoint: URL
  readonly avalancheCRpc?: ResolvedRpcEndpointConfig
  readonly arbitrumEndpoint: URL
  readonly arbitrumRpc?: ResolvedArbitrumRpcEndpointConfig
  readonly baseEndpoint: URL
  readonly baseRpc?: ResolvedBaseRpcEndpointConfig
  readonly bitcoinRpc?: ResolvedBitcoinRpcEndpointConfig
  readonly bscEndpoint: URL
  readonly bscRpc?: ResolvedRpcEndpointConfig
  readonly arcEndpoint: URL
  readonly arcRpc?: ResolvedRpcEndpointConfig
  readonly endpoint: URL
  readonly ethereumRpc?: ResolvedRpcEndpointConfig
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly optimismEndpoint: URL
  readonly optimismRpc?: ResolvedRpcEndpointConfig
  readonly polygonEndpoint: URL
  readonly polygonRpc?: ResolvedRpcEndpointConfig
  readonly kaiaEndpoint: URL
  readonly kaiaRpc?: ResolvedRpcEndpointConfig
  readonly hyperliquidEndpoint: URL
  readonly hyperliquidRpc?: ResolvedRpcEndpointConfig
  readonly monadEndpoint: URL
  readonly monadRpc?: ResolvedRpcEndpointConfig
  readonly nearEndpoint: URL
  readonly nearRpc?: ResolvedRpcEndpointConfig
  readonly soneiumEndpoint: URL
  readonly soneiumRpc?: ResolvedRpcEndpointConfig
  readonly robinhoodEndpoint: URL
  readonly robinhoodRpc?: ResolvedRpcEndpointConfig
  readonly tronEndpoint: URL
  readonly tronRpc?: ResolvedRpcEndpointConfig
  readonly suiEndpoint: URL
  readonly suiGrpcWeb?: ResolvedSuiGrpcWebEndpointConfig
  readonly solanaRpc?: ResolvedRpcEndpointConfig
  readonly timeoutMs: number
  readonly userEndpoint: URL
  readonly webSocket?: typeof globalThis.WebSocket
}

const requireFetch = (provided?: typeof globalThis.fetch) => {
  const implementation = provided ?? globalThis.fetch
  if (typeof implementation !== 'function') {
    throw new ErpcConfigError(
      'A Fetch API implementation is required in this runtime',
    )
  }
  return wrapFetch(implementation)
}

const normalizeLegacyEndpoint = (endpoint: URL): URL => {
  endpoint.search = ''
  endpoint.hash = ''
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  return endpoint
}

const normalizeHostedEndpoint = (value: unknown, namespace: string): URL => {
  if (typeof value !== 'string') {
    throw new ErpcConfigError(`${namespace} must be an absolute HTTP(S) URL`)
  }
  const input = value.trim()
  if (!input || !explicitAuthority(input) || input.includes('#') || hasUserInfo(input)) {
    throw new ErpcConfigError(`${namespace} must be an absolute HTTP(S) URL`)
  }
  let endpoint: URL
  try {
    endpoint = new URL(input)
  } catch {
    throw new ErpcConfigError(`${namespace} must be an absolute HTTP(S) URL`)
  }
  if (
    (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new ErpcConfigError(`${namespace} must be an absolute HTTP(S) URL`)
  }
  return normalizeLegacyEndpoint(endpoint)
}

const explicitAuthority = (value: string): boolean =>
  /^[a-z][a-z\d+.-]*:\/\//iu.test(value)

const hasUserInfo = (value: string): boolean => {
  const separator = value.indexOf('://')
  if (separator === -1) return false
  const authorityAndPath = value.slice(separator + 3)
  const authority = authorityAndPath.split(/[/?#]/u, 1)[0] ?? ''
  return authority.length === 0 || authority.includes('@')
}

const parseDirectUrl = (
  value: unknown,
  namespace: string,
  kind: 'HTTP(S)' | 'WS(S)',
): URL => {
  if (typeof value !== 'string') {
    throw new ErpcConfigError(`${namespace} URL must be an absolute ${kind} URL`)
  }
  const input = value.trim()
  if (!input || !explicitAuthority(input) || input.includes('#') || hasUserInfo(input)) {
    throw new ErpcConfigError(`${namespace} URL must be an absolute ${kind} URL`)
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ErpcConfigError(`${namespace} URL must be an absolute ${kind} URL`)
  }

  const allowed = kind === 'HTTP(S)'
    ? url.protocol === 'http:' || url.protocol === 'https:'
    : url.protocol === 'ws:' || url.protocol === 'wss:'
  if (!allowed || !url.hostname || url.username || url.password) {
    throw new ErpcConfigError(`${namespace} URL must be an absolute ${kind} URL`)
  }
  return url
}

const directHeaders = (
  value: unknown,
  namespace: string,
): Readonly<Record<string, string>> => {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpcConfigError(`${namespace} headers must be string values`)
  }
  const result: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') {
      throw new ErpcConfigError(`${namespace} headers must be string values`)
    }
    result[name] = header
  }
  return Object.freeze(result)
}

const resolveRpcEndpoint = (
  value: unknown,
  namespace: string,
): ResolvedRpcEndpointConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpcConfigError(`${namespace} must define an HTTP(S) URL`)
  }
  const config = value as Record<string, unknown>
  const httpUrl = parseDirectUrl(config.httpUrl, `${namespace}.httpUrl`, 'HTTP(S)')
  const webSocketUrl = config.webSocketUrl === undefined
    ? undefined
    : parseDirectUrl(
      config.webSocketUrl,
      `${namespace}.webSocketUrl`,
      'WS(S)',
    )
  const headers = directHeaders(config.headers, namespace)
  return {
    headers,
    httpUrl,
    ...(webSocketUrl === undefined ? {} : { webSocketUrl }),
  }
}

const resolveBaseRpcEndpoint = (
  value: unknown,
): ResolvedBaseRpcEndpointConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpcConfigError('baseRpc must define an HTTP(S) URL')
  }
  const config = value as Record<string, unknown>
  const httpUrl = parseDirectUrl(config.httpUrl, 'baseRpc.httpUrl', 'HTTP(S)')
  const headers = directHeaders(config.headers, 'baseRpc')
  return { headers, httpUrl }
}

const resolveSealedRpcEndpoint = (
  value: unknown,
  namespace: string,
): { readonly headers: Readonly<Record<string, string>>; readonly httpUrl: URL } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpcConfigError(`${namespace} must define an HTTP(S) URL`)
  }
  const config = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(config, 'webSocketUrl')) {
    throw new ErpcConfigError(`${namespace} does not support WebSocket URLs`)
  }
  const httpUrl = parseDirectUrl(config.httpUrl, `${namespace}.httpUrl`, 'HTTP(S)')
  const headers = directHeaders(config.headers, namespace)
  return { headers, httpUrl }
}

const resolveSuiGrpcWebEndpoint = (
  value: unknown,
): ResolvedSuiGrpcWebEndpointConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpcConfigError('suiGrpcWeb must define a base HTTP(S) URL')
  }
  const config = value as Record<string, unknown>
  const baseUrl = parseDirectUrl(config.baseUrl, 'suiGrpcWeb.baseUrl', 'HTTP(S)')
  const headers = directHeaders(config.headers, 'suiGrpcWeb')
  return { headers, baseUrl }
}

export const resolveConfig = (
  config: ErpcClientConfig,
): ResolvedErpcClientConfig => {
  const configuredApiKey = config.apiKey === undefined
    ? undefined
    : typeof config.apiKey === 'string'
      ? config.apiKey.trim()
      : (() => {
          throw new ErpcConfigError('apiKey must be a string')
        })()

  const solanaRpc = config.solanaRpc === undefined
    ? undefined
    : resolveRpcEndpoint(config.solanaRpc, 'solanaRpc')
  const ethereumRpc = config.ethereumRpc === undefined
    ? undefined
    : resolveRpcEndpoint(config.ethereumRpc, 'ethereumRpc')
  const avalancheCRpc = config.avalancheCRpc === undefined
    ? undefined
    : resolveRpcEndpoint(config.avalancheCRpc, 'avalancheCRpc')
  const arbitrumRpc = config.arbitrumRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.arbitrumRpc, 'arbitrumRpc')
  const baseRpc = config.baseRpc === undefined
    ? undefined
    : resolveBaseRpcEndpoint(config.baseRpc)
  const bitcoinRpc = config.bitcoinRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.bitcoinRpc, 'bitcoinRpc')
  const bscRpc = config.bscRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.bscRpc, 'bscRpc')
  const arcRpc = config.arcRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.arcRpc, 'arcRpc')
  const hyperliquidRpc = config.hyperliquidRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.hyperliquidRpc, 'hyperliquidRpc')
  const kaiaRpc = config.kaiaRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.kaiaRpc, 'kaiaRpc')
  const monadRpc = config.monadRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.monadRpc, 'monadRpc')
  const optimismRpc = config.optimismRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.optimismRpc, 'optimismRpc')
  const polygonRpc = config.polygonRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.polygonRpc, 'polygonRpc')
  const soneiumRpc = config.soneiumRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.soneiumRpc, 'soneiumRpc')
  const robinhoodRpc = config.robinhoodRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.robinhoodRpc, 'robinhoodRpc')
  const nearRpc = config.nearRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.nearRpc, 'nearRpc')
  const tronRpc = config.tronRpc === undefined
    ? undefined
    : resolveSealedRpcEndpoint(config.tronRpc, 'tronRpc')
  const suiGrpcWeb = config.suiGrpcWeb === undefined
    ? undefined
    : resolveSuiGrpcWebEndpoint(config.suiGrpcWeb)
  const hasDirectRpc =
    solanaRpc !== undefined ||
    ethereumRpc !== undefined ||
    avalancheCRpc !== undefined ||
    baseRpc !== undefined ||
    arbitrumRpc !== undefined ||
    bitcoinRpc !== undefined ||
    bscRpc !== undefined ||
    arcRpc !== undefined ||
    hyperliquidRpc !== undefined ||
    kaiaRpc !== undefined ||
    monadRpc !== undefined ||
    optimismRpc !== undefined ||
    polygonRpc !== undefined ||
    soneiumRpc !== undefined ||
    robinhoodRpc !== undefined ||
    nearRpc !== undefined ||
    tronRpc !== undefined ||
    suiGrpcWeb !== undefined
  if (!configuredApiKey && !hasDirectRpc) {
    throw new ErpcConfigError('apiKey must not be empty')
  }
  const apiKey = configuredApiKey || undefined

  let endpoint: URL
  let avalancheEndpoint: URL
  let arbitrumEndpoint: URL
  let baseEndpoint: URL
  let bscEndpoint: URL
  let arcEndpoint: URL
  let hyperliquidEndpoint: URL
  let kaiaEndpoint: URL
  let monadEndpoint: URL
  let optimismEndpoint: URL
  let polygonEndpoint: URL
  let soneiumEndpoint: URL
  let robinhoodEndpoint: URL
  let nearEndpoint: URL
  let tronEndpoint: URL
  let suiEndpoint: URL
  let accountEndpoint: URL
  let userEndpoint: URL
  try {
    endpoint = normalizeLegacyEndpoint(new URL(config.endpoint ?? DEFAULT_ENDPOINT))
    avalancheEndpoint = normalizeLegacyEndpoint(new URL(
      config.avalancheEndpoint ?? DEFAULT_AVALANCHE_ENDPOINT,
    ))
    arbitrumEndpoint = normalizeHostedEndpoint(
      config.arbitrumEndpoint ?? DEFAULT_ARBITRUM_ENDPOINT,
      'arbitrumEndpoint',
    )
    baseEndpoint = normalizeLegacyEndpoint(new URL(
      config.baseEndpoint ?? DEFAULT_BASE_ENDPOINT,
    ))
    bscEndpoint = normalizeHostedEndpoint(
      config.bscEndpoint ?? DEFAULT_BSC_ENDPOINT,
      'bscEndpoint',
    )
    arcEndpoint = normalizeHostedEndpoint(
      config.arcEndpoint ?? DEFAULT_ARC_ENDPOINT,
      'arcEndpoint',
    )
    hyperliquidEndpoint = normalizeHostedEndpoint(
      config.hyperliquidEndpoint ?? DEFAULT_HYPERLIQUID_ENDPOINT,
      'hyperliquidEndpoint',
    )
    kaiaEndpoint = normalizeHostedEndpoint(
      config.kaiaEndpoint ?? DEFAULT_KAIA_ENDPOINT,
      'kaiaEndpoint',
    )
    monadEndpoint = normalizeHostedEndpoint(
      config.monadEndpoint ?? DEFAULT_MONAD_ENDPOINT,
      'monadEndpoint',
    )
    optimismEndpoint = normalizeHostedEndpoint(
      config.optimismEndpoint ?? DEFAULT_OPTIMISM_ENDPOINT,
      'optimismEndpoint',
    )
    polygonEndpoint = normalizeHostedEndpoint(
      config.polygonEndpoint ?? DEFAULT_POLYGON_ENDPOINT,
      'polygonEndpoint',
    )
    soneiumEndpoint = normalizeHostedEndpoint(
      config.soneiumEndpoint ?? DEFAULT_SONEIUM_ENDPOINT,
      'soneiumEndpoint',
    )
    robinhoodEndpoint = normalizeHostedEndpoint(
      config.robinhoodEndpoint ?? DEFAULT_ROBINHOOD_ENDPOINT,
      'robinhoodEndpoint',
    )
    nearEndpoint = normalizeHostedEndpoint(
      config.nearEndpoint ?? DEFAULT_NEAR_ENDPOINT,
      'nearEndpoint',
    )
    tronEndpoint = normalizeHostedEndpoint(
      config.tronEndpoint ?? DEFAULT_TRON_ENDPOINT,
      'tronEndpoint',
    )
    suiEndpoint = normalizeHostedEndpoint(
      config.suiEndpoint ?? DEFAULT_SUI_ENDPOINT,
      'suiEndpoint',
    )
    accountEndpoint = normalizeLegacyEndpoint(new URL(
      config.accountEndpoint ?? DEFAULT_ACCOUNT_ENDPOINT,
    ))
    userEndpoint = normalizeLegacyEndpoint(new URL(config.userEndpoint ?? DEFAULT_USER_ENDPOINT))
  } catch (error) {
    if (error instanceof ErpcConfigError) throw error
    throw new ErpcConfigError('endpoint must be an absolute HTTP(S) URL')
  }

  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new ErpcConfigError('endpoint must use HTTP or HTTPS')
  }
  if (
    avalancheEndpoint.protocol !== 'https:' &&
    avalancheEndpoint.protocol !== 'http:'
  ) {
    throw new ErpcConfigError('avalancheEndpoint must use HTTP or HTTPS')
  }
  if (baseEndpoint.protocol !== 'https:' && baseEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('baseEndpoint must use HTTP or HTTPS')
  }
  if (arbitrumEndpoint.protocol !== 'https:' && arbitrumEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('arbitrumEndpoint must use HTTP or HTTPS')
  }
  if (bscEndpoint.protocol !== 'https:' && bscEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('bscEndpoint must use HTTP or HTTPS')
  }
  if (arcEndpoint.protocol !== 'https:' && arcEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('arcEndpoint must use HTTP or HTTPS')
  }
  if (hyperliquidEndpoint.protocol !== 'https:' && hyperliquidEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('hyperliquidEndpoint must use HTTP or HTTPS')
  }
  if (kaiaEndpoint.protocol !== 'https:' && kaiaEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('kaiaEndpoint must use HTTP or HTTPS')
  }
  if (monadEndpoint.protocol !== 'https:' && monadEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('monadEndpoint must use HTTP or HTTPS')
  }
  if (optimismEndpoint.protocol !== 'https:' && optimismEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('optimismEndpoint must use HTTP or HTTPS')
  }
  if (polygonEndpoint.protocol !== 'https:' && polygonEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('polygonEndpoint must use HTTP or HTTPS')
  }
  if (soneiumEndpoint.protocol !== 'https:' && soneiumEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('soneiumEndpoint must use HTTP or HTTPS')
  }
  if (robinhoodEndpoint.protocol !== 'https:' && robinhoodEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('robinhoodEndpoint must use HTTP or HTTPS')
  }
  if (nearEndpoint.protocol !== 'https:' && nearEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('nearEndpoint must use HTTP or HTTPS')
  }
  if (tronEndpoint.protocol !== 'https:' && tronEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('tronEndpoint must use HTTP or HTTPS')
  }
  if (suiEndpoint.protocol !== 'https:' && suiEndpoint.protocol !== 'http:') {
    throw new ErpcConfigError('suiEndpoint must use HTTP or HTTPS')
  }
  if (
    accountEndpoint.protocol !== 'https:' &&
    accountEndpoint.protocol !== 'http:'
  ) {
    throw new ErpcConfigError('accountEndpoint must use HTTP or HTTPS')
  }
  if (
    userEndpoint.protocol !== 'https:' &&
    userEndpoint.protocol !== 'http:'
  ) {
    throw new ErpcConfigError('userEndpoint must use HTTP or HTTPS')
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ErpcConfigError('timeoutMs must be a positive finite number')
  }

  return {
    accountEndpoint,
    avalancheEndpoint,
    arbitrumEndpoint,
    baseEndpoint,
    endpoint,
    fetch: requireFetch(config.fetch),
    headers: config.headers ?? {},
    timeoutMs,
    userEndpoint,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(avalancheCRpc === undefined ? {} : { avalancheCRpc }),
    ...(arbitrumRpc === undefined ? {} : { arbitrumRpc }),
    ...(baseRpc === undefined ? {} : { baseRpc }),
    ...(bitcoinRpc === undefined ? {} : { bitcoinRpc }),
    bscEndpoint,
    ...(bscRpc === undefined ? {} : { bscRpc }),
    arcEndpoint,
    ...(arcRpc === undefined ? {} : { arcRpc }),
    hyperliquidEndpoint,
    ...(hyperliquidRpc === undefined ? {} : { hyperliquidRpc }),
    kaiaEndpoint,
    ...(kaiaRpc === undefined ? {} : { kaiaRpc }),
    monadEndpoint,
    ...(monadRpc === undefined ? {} : { monadRpc }),
    ...(ethereumRpc === undefined ? {} : { ethereumRpc }),
    ...(solanaRpc === undefined ? {} : { solanaRpc }),
    optimismEndpoint,
    ...(optimismRpc === undefined ? {} : { optimismRpc }),
    polygonEndpoint,
    ...(polygonRpc === undefined ? {} : { polygonRpc }),
    soneiumEndpoint,
    ...(soneiumRpc === undefined ? {} : { soneiumRpc }),
    robinhoodEndpoint,
    ...(robinhoodRpc === undefined ? {} : { robinhoodRpc }),
    nearEndpoint,
    ...(nearRpc === undefined ? {} : { nearRpc }),
    tronEndpoint,
    ...(tronRpc === undefined ? {} : { tronRpc }),
    suiEndpoint,
    ...(suiGrpcWeb === undefined ? {} : { suiGrpcWeb }),
    ...(config.webSocket === undefined
      ? {}
      : { webSocket: config.webSocket }),
  }
}

export const endpointWithPath = (endpoint: URL, path: string): URL => {
  const url = new URL(endpoint)
  const base = endpoint.pathname === '/' ? '' : endpoint.pathname
  url.pathname = `${base}/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
  return url
}

export const websocketUrl = (
  endpoint: URL,
  apiKey: string,
  path = '',
): URL => {
  const url = endpointWithPath(endpoint, path)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('api-key', apiKey)
  return url
}
