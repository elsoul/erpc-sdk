import {
  ErpcAbortedError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
} from '../errors'
import type { RpcSendOptions } from '../rpc/types'

export type QueryValue =
  | boolean
  | number
  | readonly string[]
  | string
  | undefined

export type Query = Readonly<Record<string, QueryValue>>

export interface RestTransportConfig {
  readonly apiKey?: string
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly unavailableNamespace?: string
}

export interface RestStreamResponse {
  readonly response: Response
  close(): void
  normalizeError(error: unknown): Error
}

interface ControlledSignal {
  readonly cleanup: () => void
  readonly signal: AbortSignal
  readonly stopTimeout: () => void
  readonly timeoutMs: number
  readonly timedOut: () => boolean
}

const controlledSignal = (
  timeoutMs: number,
  external?: AbortSignal,
): ControlledSignal => {
  const controller = new AbortController()
  let didTimeOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)

  const abort = () => controller.abort()
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', abort, { once: true })

  const stopTimeout = () => {
    if (timeout === undefined) return
    clearTimeout(timeout)
    timeout = undefined
  }

  return {
    signal: controller.signal,
    stopTimeout,
    timeoutMs,
    timedOut: () => didTimeOut,
    cleanup: () => {
      stopTimeout()
      external?.removeEventListener('abort', abort)
    },
  }
}

const normalizeError = (
  error: unknown,
  controlled: ControlledSignal,
  external?: AbortSignal,
): Error => {
  if (
    error instanceof ErpcAbortedError ||
    error instanceof ErpcHttpError ||
    error instanceof ErpcInvalidResponseError ||
    error instanceof ErpcTimeoutError ||
    error instanceof ErpcTransportError
  ) {
    return error
  }
  if (controlled.timedOut()) {
    return new ErpcTimeoutError(controlled.timeoutMs)
  }
  if (external?.aborted) return new ErpcAbortedError()
  return new ErpcTransportError('Unable to reach ERPC')
}

const applyQuery = (url: URL, query?: Query): void => {
  if (!query) return
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item)
    } else {
      url.searchParams.set(key, String(value))
    }
  }
}

export class RestTransport {
  readonly endpoint: string

  readonly #apiKey: string
  readonly #endpoint: URL
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeoutMs: number
  readonly #unavailableNamespace: string | undefined

  constructor(config: RestTransportConfig) {
    this.#apiKey = config.apiKey ?? ''
    this.#endpoint = new URL(config.endpoint)
    this.#fetch = config.fetch
    this.#headers = config.headers
    this.#timeoutMs = config.timeoutMs
    this.#unavailableNamespace = config.unavailableNamespace
    const endpoint = new URL(config.endpoint)
    endpoint.search = ''
    endpoint.hash = ''
    this.endpoint = endpoint.toString()
  }

  url(path: string, query?: Query): URL {
    const url = new URL(this.#endpoint)
    const base = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    url.pathname = `${base}/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
    applyQuery(url, query)
    return url
  }

  async get<TResult>(
    path: string,
    query?: Query,
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    if (this.#unavailableNamespace !== undefined) {
      throw new ErpcNotConfiguredError(this.#unavailableNamespace)
    }
    const controlled = controlledSignal(this.#timeoutMs, options.signal)
    try {
      const response = await this.#get(path, query, controlled.signal)
      if (!response.ok) throw new ErpcHttpError(response.status)
      const text = await response.text()
      try {
        return JSON.parse(text) as TResult
      } catch {
        throw new ErpcInvalidResponseError('ERPC returned malformed JSON')
      }
    } catch (error) {
      throw normalizeError(error, controlled, options.signal)
    } finally {
      controlled.cleanup()
    }
  }

  async stream(
    path: string,
    query?: Query,
    options: RpcSendOptions = {},
  ): Promise<RestStreamResponse> {
    if (this.#unavailableNamespace !== undefined) {
      throw new ErpcNotConfiguredError(this.#unavailableNamespace)
    }
    const controlled = controlledSignal(this.#timeoutMs, options.signal)
    try {
      const response = await this.#get(path, query, controlled.signal)
      if (!response.ok) throw new ErpcHttpError(response.status)

      // Long-lived streams use the timeout for connection establishment only.
      // The caller's AbortSignal remains attached until close() is called.
      controlled.stopTimeout()
      return {
        response,
        close: controlled.cleanup,
        normalizeError: (error) =>
          normalizeError(error, controlled, options.signal),
      }
    } catch (error) {
      controlled.cleanup()
      throw normalizeError(error, controlled, options.signal)
    }
  }

  #get(path: string, query: Query | undefined, signal: AbortSignal) {
    const headers: Record<string, string> = {
      ...this.#headers,
      accept: 'application/json',
    }
    if (this.#unavailableNamespace === undefined) {
      headers.authorization = `Bearer ${this.#apiKey}`
    }
    return this.#fetch(this.url(path, query), {
      method: 'GET',
      headers,
      signal,
    })
  }
}
