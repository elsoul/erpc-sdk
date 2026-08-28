import {
  ErpcAbortedError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcTimeoutError,
  ErpcTransportError,
  redactJsonRpcError,
} from '../errors'
import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcResponse,
  RpcBatchCall,
  RpcSendOptions,
} from '../rpc/types'

export interface HttpTransportConfig {
  readonly apiKey: string
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly maxBatchSize?: number
  readonly timeoutMs: number
}

interface ControlledSignal {
  readonly cleanup: () => void
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
}

const controlledSignal = (
  timeoutMs: number,
  external?: AbortSignal,
): ControlledSignal => {
  const controller = new AbortController()
  let didTimeOut = false

  const timeout = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)

  const abort = () => controller.abort()
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', abort, { once: true })

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout)
      external?.removeEventListener('abort', abort)
    },
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFailure = (value: unknown): value is JsonRpcFailure =>
  isObject(value) &&
  isObject(value.error) &&
  typeof value.error.code === 'number' &&
  typeof value.error.message === 'string'

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ErpcInvalidResponseError('ERPC returned malformed JSON')
  }
}

export class HttpJsonRpcTransport {
  readonly endpoint: string
  readonly maxBatchSize: number

  readonly #apiKey: string
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeoutMs: number
  #nextId = 1

  constructor(config: HttpTransportConfig) {
    this.#apiKey = config.apiKey
    this.#fetch = config.fetch
    this.#headers = config.headers
    this.#timeoutMs = config.timeoutMs
    this.maxBatchSize = config.maxBatchSize ?? 256

    const endpoint = new URL(config.endpoint)
    endpoint.search = ''
    endpoint.hash = ''
    this.endpoint = endpoint.toString()
  }

  async request<TResult>(
    method: string,
    params?: JsonRpcParams,
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    const id = this.#id()
    const request = this.#request(id, method, params)
    const response = await this.#post(request, options)
    return this.#unwrap<TResult>(response, id)
  }

  async batch<TResult extends readonly unknown[]>(
    calls: readonly RpcBatchCall[],
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    if (calls.length === 0) return [] as unknown as TResult
    if (calls.length > this.maxBatchSize) {
      throw new ErpcInvalidResponseError(
        `A batch may contain at most ${this.maxBatchSize} calls`,
      )
    }

    const requests = calls.map((call) => {
      const id = this.#id()
      return this.#request(id, call.method, call.params)
    })
    const raw = await this.#post(requests, options)
    if (!Array.isArray(raw)) {
      if (isFailure(raw)) {
        throw new ErpcJsonRpcError(redactJsonRpcError(raw.error, this.#apiKey))
      }
      throw new ErpcInvalidResponseError('ERPC returned a non-array batch response')
    }

    const byId = new Map<JsonRpcId, unknown>()
    for (const response of raw) {
      if (!isObject(response) || !('id' in response)) {
        throw new ErpcInvalidResponseError('ERPC returned an invalid batch item')
      }
      const id = response.id
      if (typeof id !== 'number' && typeof id !== 'string') {
        throw new ErpcInvalidResponseError('ERPC returned an invalid batch id')
      }
      byId.set(id, response)
    }

    const results = requests.map((request) => {
      const response = byId.get(request.id)
      if (response === undefined) {
        throw new ErpcInvalidResponseError(
          `ERPC omitted batch response id ${String(request.id)}`,
        )
      }
      return this.#unwrap(response, request.id)
    })
    return results as unknown as TResult
  }

  #id(): number {
    const id = this.#nextId
    this.#nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1
    return id
  }

  #request(
    id: JsonRpcId,
    method: string,
    params?: JsonRpcParams,
  ): JsonRpcRequest<JsonRpcParams> {
    const request: {
      jsonrpc: '2.0'
      id: JsonRpcId
      method: string
      params?: JsonRpcParams
    } = { jsonrpc: '2.0', id, method }
    if (params !== undefined) request.params = params
    return request
  }

  async #post(
    body: unknown,
    options: RpcSendOptions,
  ): Promise<unknown> {
    const url = new URL(this.endpoint)
    url.searchParams.set('api-key', this.#apiKey)
    const controlled = controlledSignal(this.#timeoutMs, options.signal)

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          ...this.#headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controlled.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new ErpcHttpError(response.status)
      return parseJson(text)
    } catch (error) {
      if (error instanceof ErpcHttpError || error instanceof ErpcInvalidResponseError) {
        throw error
      }
      if (controlled.timedOut()) throw new ErpcTimeoutError(this.#timeoutMs)
      if (options.signal?.aborted) throw new ErpcAbortedError()
      // Do not retain the underlying fetch error: custom runtimes may include
      // the credential-bearing request URL or headers in its message.
      throw new ErpcTransportError('Unable to reach ERPC')
    } finally {
      controlled.cleanup()
    }
  }

  #unwrap<TResult>(response: unknown, expectedId: JsonRpcId): TResult {
    if (!isObject(response)) throw new ErpcInvalidResponseError()
    if (response.id !== expectedId) {
      throw new ErpcInvalidResponseError('ERPC returned an unexpected response id')
    }
    if (isFailure(response)) {
      throw new ErpcJsonRpcError(
        redactJsonRpcError(response.error, this.#apiKey),
      )
    }
    if (!('result' in response)) throw new ErpcInvalidResponseError()
    return (response as unknown as JsonRpcResponse<TResult> & { result: TResult })
      .result
  }
}
