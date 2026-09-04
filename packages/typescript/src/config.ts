import { ErpcConfigError } from './errors'

export const DEFAULT_ENDPOINT = 'https://edge.erpc.global'
export const DEFAULT_AVALANCHE_ENDPOINT = 'https://ava-rpc.erpc.global'
export const DEFAULT_ACCOUNT_ENDPOINT = 'https://solana-rpc.erpc.global'
export const DEFAULT_USER_ENDPOINT = 'https://user-api.erpc.global'
export const DEFAULT_TIMEOUT_MS = 30_000

export interface ErpcClientConfig {
  readonly accountEndpoint?: string
  readonly apiKey: string
  readonly avalancheEndpoint?: string
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly userEndpoint?: string
  readonly webSocket?: typeof globalThis.WebSocket
}

export interface ResolvedErpcClientConfig {
  readonly accountEndpoint: URL
  readonly apiKey: string
  readonly avalancheEndpoint: URL
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
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
  return implementation
}

export const resolveConfig = (
  config: ErpcClientConfig,
): ResolvedErpcClientConfig => {
  const apiKey = config.apiKey.trim()
  if (!apiKey) throw new ErpcConfigError('apiKey must not be empty')

  let endpoint: URL
  let avalancheEndpoint: URL
  let accountEndpoint: URL
  let userEndpoint: URL
  try {
    endpoint = new URL(config.endpoint ?? DEFAULT_ENDPOINT)
    avalancheEndpoint = new URL(
      config.avalancheEndpoint ?? DEFAULT_AVALANCHE_ENDPOINT,
    )
    accountEndpoint = new URL(
      config.accountEndpoint ?? DEFAULT_ACCOUNT_ENDPOINT,
    )
    userEndpoint = new URL(config.userEndpoint ?? DEFAULT_USER_ENDPOINT)
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

  endpoint.search = ''
  endpoint.hash = ''
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  avalancheEndpoint.search = ''
  avalancheEndpoint.hash = ''
  avalancheEndpoint.pathname =
    avalancheEndpoint.pathname.replace(/\/+$/, '') || '/'
  accountEndpoint.search = ''
  accountEndpoint.hash = ''
  accountEndpoint.pathname =
    accountEndpoint.pathname.replace(/\/+$/, '') || '/'
  userEndpoint.search = ''
  userEndpoint.hash = ''
  userEndpoint.pathname = userEndpoint.pathname.replace(/\/+$/, '') || '/'

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ErpcConfigError('timeoutMs must be a positive finite number')
  }

  return {
    accountEndpoint,
    apiKey,
    avalancheEndpoint,
    endpoint,
    fetch: requireFetch(config.fetch),
    headers: config.headers ?? {},
    timeoutMs,
    userEndpoint,
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
