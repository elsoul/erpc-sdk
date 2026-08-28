import {
  ErpcAbortedError,
  ErpcConfigError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcTimeoutError,
  ErpcTransportError,
  redactJsonRpcError,
} from '../errors'
import type { JsonRpcTransport } from '../rpc/client'
import type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcParams,
  RpcBatchCall,
  RpcSendOptions,
} from '../rpc/types'

export interface RpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params: unknown
}

export type RpcNotificationListener = (notification: RpcNotification) => void

export interface WebSocketTransportConfig {
  readonly endpoint: URL
  readonly maxBatchSize?: number
  readonly timeoutMs: number
  readonly webSocket?: typeof globalThis.WebSocket
}

interface PendingResponse {
  readonly cleanup: () => void
  readonly reject: (reason: unknown) => void
  readonly resolve: (value: unknown) => void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRpcError = (value: unknown): value is JsonRpcErrorObject =>
  isObject(value) &&
  typeof value.code === 'number' &&
  typeof value.message === 'string'

const publicEndpoint = (endpoint: URL): string => {
  const url = new URL(endpoint)
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class WebSocketJsonRpcTransport implements JsonRpcTransport {
  readonly endpoint: string
  readonly maxBatchSize: number

  readonly #connectionUrl: string
  readonly #credential: string | undefined
  readonly #listeners = new Set<RpcNotificationListener>()
  readonly #pending = new Map<JsonRpcId, PendingResponse>()
  readonly #timeoutMs: number
  readonly #webSocket?: typeof globalThis.WebSocket
  #connectPromise: Promise<void> | undefined
  #nextId = 1
  #socket: WebSocket | undefined

  constructor(config: WebSocketTransportConfig) {
    const implementation = config.webSocket ?? globalThis.WebSocket
    if (typeof implementation === 'function') this.#webSocket = implementation
    this.#credential = config.endpoint.searchParams.get('api-key') ?? undefined
    this.#connectionUrl = config.endpoint.toString()
    this.endpoint = publicEndpoint(config.endpoint)
    this.maxBatchSize = config.maxBatchSize ?? 256
    this.#timeoutMs = config.timeoutMs
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === 1) return
    if (this.#connectPromise) return this.#connectPromise
    if (!this.#webSocket) {
      throw new ErpcConfigError(
        'A WebSocket implementation is required for subscriptions',
      )
    }

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new this.#webSocket!(this.#connectionUrl)
      this.#socket = socket

      const timeout = setTimeout(() => {
        socket.close()
        reject(new ErpcTimeoutError(this.#timeoutMs))
      }, this.#timeoutMs)

      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout)
          reject(new ErpcTransportError('Unable to connect to ERPC WebSocket'))
        },
        { once: true },
      )
      socket.addEventListener('message', (event: MessageEvent<unknown>) => {
        void this.#onMessage(event.data)
      })
      socket.addEventListener('close', () => {
        this.#socket = undefined
        this.#connectPromise = undefined
        const error = new ErpcTransportError('ERPC WebSocket connection closed')
        for (const pending of this.#pending.values()) pending.reject(error)
        this.#pending.clear()
      })
    }).catch((error: unknown) => {
      this.#connectPromise = undefined
      throw error
    })

    return this.#connectPromise
  }

  close(code = 1000, reason = 'Client closed connection'): void {
    this.#socket?.close(code, reason)
    this.#socket = undefined
    this.#connectPromise = undefined
  }

  onNotification(listener: RpcNotificationListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async request<TResult>(
    method: string,
    params?: JsonRpcParams,
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    await this.connect()
    const id = this.#id()
    const promise = this.#waitFor<TResult>(id, options)
    const request: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) request.params = params
    this.#send(request, id)
    return promise
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

    await this.connect()
    const requests = calls.map((call) => {
      const id = this.#id()
      const request: Record<string, unknown> = {
        jsonrpc: '2.0',
        id,
        method: call.method,
      }
      if (call.params !== undefined) request.params = call.params
      return { id, request, response: this.#waitFor(id, options) }
    })

    try {
      this.#socket?.send(JSON.stringify(requests.map(({ request }) => request)))
    } catch (error) {
      for (const { id } of requests) this.#reject(id, error)
    }
    return Promise.all(requests.map(({ response }) => response)) as unknown as Promise<TResult>
  }

  #id(): number {
    const id = this.#nextId
    this.#nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1
    return id
  }

  #send(request: unknown, id: JsonRpcId): void {
    try {
      this.#socket?.send(JSON.stringify(request))
    } catch (error) {
      this.#reject(id, error)
    }
  }

  #waitFor<TResult>(
    id: JsonRpcId,
    options: RpcSendOptions,
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ErpcTimeoutError(this.#timeoutMs))
      }, this.#timeoutMs)

      const abort = () => {
        clearTimeout(timeout)
        this.#pending.delete(id)
        reject(new ErpcAbortedError())
      }
      options.signal?.addEventListener('abort', abort, { once: true })

      const cleanup = () => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
      }
      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        cleanup,
      })
      if (options.signal?.aborted) abort()
    })
  }

  #reject(id: JsonRpcId, _reason: unknown): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    pending.cleanup()
    this.#pending.delete(id)
    // A custom WebSocket implementation may include its connection URL in a
    // thrown error, so never retain the original error as a public cause.
    pending.reject(
      new ErpcTransportError('Unable to send ERPC WebSocket request'),
    )
  }

  async #onMessage(data: unknown): Promise<void> {
    const text = await this.#messageText(data)
    if (text === null) return

    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) this.#dispatch(item)
    } else {
      this.#dispatch(parsed)
    }
  }

  async #messageText(data: unknown): Promise<string | null> {
    if (typeof data === 'string') return data
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text()
    return null
  }

  #dispatch(message: unknown): void {
    if (!isObject(message)) return
    const id = message.id
    if (typeof id === 'number' || typeof id === 'string') {
      const pending = this.#pending.get(id)
      if (!pending) return
      pending.cleanup()
      this.#pending.delete(id)
      if (isRpcError(message.error)) {
        pending.reject(
          new ErpcJsonRpcError(
            redactJsonRpcError(message.error, this.#credential),
          ),
        )
      }
      else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new ErpcInvalidResponseError())
      return
    }

    if (
      message.jsonrpc === '2.0' &&
      typeof message.method === 'string' &&
      'params' in message
    ) {
      const notification: RpcNotification = {
        jsonrpc: '2.0',
        method: message.method,
        params: message.params,
      }
      for (const listener of this.#listeners) listener(notification)
    }
  }
}
