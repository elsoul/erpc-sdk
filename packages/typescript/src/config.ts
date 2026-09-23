import { ErpcConfigError } from './errors'
import { wrapFetch } from './transport/fetch'

export const DEFAULT_ENDPOINT = 'https://edge.erpc.global'
export const DEFAULT_AVALANCHE_ENDPOINT = 'https://ava-rpc.erpc.global'
export const DEFAULT_ACCOUNT_ENDPOINT = 'https://solana-rpc.erpc.global'
export const DEFAULT_USER_ENDPOINT = 'https://user-api.erpc.global'
export const DEFAULT_TIMEOUT_MS = 30_000

export interface RpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
  readonly webSocketUrl?: string
}

export interface ResolvedRpcEndpointConfig {
  readonly headers: Readonly<Record<string, string>>
  readonly httpUrl: URL
  readonly webSocketUrl?: URL
}

export interface ErpcClientConfig {
  readonly accountEndpoint?: string
  readonly apiKey?: string
  readonly avalancheEndpoint?: string
  readonly avalancheCRpc?: RpcEndpointConfig
  readonly endpoint?: string
  readonly ethereumRpc?: RpcEndpointConfig
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
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
  readonly endpoint: URL
  readonly ethereumRpc?: ResolvedRpcEndpointConfig
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
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
  const hasDirectRpc =
    solanaRpc !== undefined || ethereumRpc !== undefined || avalancheCRpc !== undefined
  if (!configuredApiKey && !hasDirectRpc) {
    throw new ErpcConfigError('apiKey must not be empty')
  }
  const apiKey = configuredApiKey || undefined

  let endpoint: URL
  let avalancheEndpoint: URL
  let accountEndpoint: URL
  let userEndpoint: URL
  try {
    endpoint = normalizeLegacyEndpoint(new URL(config.endpoint ?? DEFAULT_ENDPOINT))
    avalancheEndpoint = normalizeLegacyEndpoint(new URL(
      config.avalancheEndpoint ?? DEFAULT_AVALANCHE_ENDPOINT,
    ))
    accountEndpoint = normalizeLegacyEndpoint(new URL(
      config.accountEndpoint ?? DEFAULT_ACCOUNT_ENDPOINT,
    ))
    userEndpoint = normalizeLegacyEndpoint(new URL(config.userEndpoint ?? DEFAULT_USER_ENDPOINT))
  } catch {
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
    endpoint,
    fetch: requireFetch(config.fetch),
    headers: config.headers ?? {},
    timeoutMs,
    userEndpoint,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(avalancheCRpc === undefined ? {} : { avalancheCRpc }),
    ...(ethereumRpc === undefined ? {} : { ethereumRpc }),
    ...(solanaRpc === undefined ? {} : { solanaRpc }),
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
