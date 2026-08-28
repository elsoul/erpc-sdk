import { ErpcConfigError } from './errors'
import { CloudCatalogClient } from './catalog'
import { CloudCreditClient } from './credit'
import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'
import { UsageClient } from './usage'
import { CloudResourcesClient } from './resources'
import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_ENDPOINT } from './config'

export interface ErpcCloudClientConfig {
  readonly accessToken: string
  readonly endpoint?: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface ErpcCloudClient {
  readonly catalog: CloudCatalogClient
  readonly credit: CloudCreditClient
  readonly resources: CloudResourcesClient
  readonly usage: UsageClient
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

const cloudEndpoint = (value?: string): URL => {
  let endpoint: URL
  try {
    endpoint = new URL(value ?? DEFAULT_USER_ENDPOINT)
  } catch {
    throw new ErpcConfigError('endpoint must be an absolute HTTP(S) URL')
  }
  const isLocalHttp = endpoint.protocol === 'http:' &&
    ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !isLocalHttp) {
    throw new ErpcConfigError('endpoint must use HTTPS except on localhost')
  }
  endpoint.search = ''
  endpoint.hash = ''
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  return endpoint
}

export const createErpcCloudClient = (
  config: ErpcCloudClientConfig,
): ErpcCloudClient => {
  const accessToken = config.accessToken.trim()
  if (!accessToken) {
    throw new ErpcConfigError('accessToken must not be empty')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ErpcConfigError('timeoutMs must be a positive finite number')
  }

  const transport = new RestTransport({
    apiKey: accessToken,
    endpoint: cloudEndpoint(config.endpoint),
    fetch: requireFetch(config.fetch),
    headers: config.headers ?? {},
    timeoutMs,
  })

  return {
    catalog: new CloudCatalogClient(transport),
    credit: new CloudCreditClient(transport),
    resources: new CloudResourcesClient(transport),
    usage: new UsageClient(transport),
  }
}

export type ErpcCloudRequestOptions = RpcSendOptions
