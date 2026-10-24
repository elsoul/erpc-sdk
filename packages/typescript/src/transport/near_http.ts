import { parse } from 'lossless-json'
import {
  directRedactionVariants,
  ErpcAbortedError,
  ErpcBatchPolicyError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
  redactJsonRpcError,
} from '../errors'
import {
  NearJsonNumber,
  type NearJsonValue,
} from '../rpc/near'
import type {
  JsonRpcParams,
  JsonRpcResponse,
  RpcBatchCall,
  RpcSendOptions,
} from '../rpc/types'
import { wrapFetch } from './fetch'

export interface NearHttpTransportConfig {
  readonly apiKey?: string
  readonly direct?: boolean
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly unavailableNamespace?: string
}

const U64_MAX = 18_446_744_073_709_551_615n

const controlledSignal = (timeoutMs: number, external?: AbortSignal) => {
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

const requestHeaders = (
  headers: Readonly<Record<string, string>>,
): Headers => {
  const result = { ...headers }
  const normalized = new Headers(result)
  normalized.set('accept', 'application/json')
  normalized.set('content-type', 'application/json')
  return normalized
}

const defineOwn = <T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

const isNearJsonNumber = (value: unknown): value is NearJsonNumber =>
  value instanceof NearJsonNumber

const encodeString = (value: string): string => JSON.stringify(value)

const encodeNearJson = (value: unknown, seen = new WeakSet<object>()): string => {
  if (isNearJsonNumber(value)) return value.value
  if (typeof value === 'bigint') {
    if (value < 0n || value > U64_MAX) throw new ErpcInvalidResponseError('Invalid NEAR integer')
    return value.toString()
  }
  if (value === null) return 'null'
  if (typeof value === 'string') return encodeString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ErpcInvalidResponseError('Invalid NEAR number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new ErpcInvalidResponseError('Invalid NEAR JSON value')
  if (seen.has(value)) throw new ErpcInvalidResponseError('Invalid NEAR JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encodeNearJson(item, seen)).join(',')}]`
    const entries = Object.entries(value)
    return `{${entries.map(([key, item]) => `${encodeString(key)}:${encodeNearJson(item, seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

const parseNearJson = (text: string): NearJsonValue => {
  try {
    const value = parse(text, undefined, {
      onDuplicateKey: ({ newValue }) => newValue,
      parseNumber: (raw) => new NearJsonNumber(raw),
    })
    return value as NearJsonValue
  } catch {
    throw new ErpcInvalidResponseError('ERPC returned malformed JSON')
  }
}

const numericIdMatches = (actual: unknown, expected: number): boolean => {
  if (!isNearJsonNumber(actual) || !Number.isSafeInteger(expected)) return false
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(actual.value)
  if (match === null) return false
  const sign = match[1] ?? ''
  const integer = match[2] ?? ''
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return false
  let digits = `${integer}${fraction}`.replace(/^0+/u, '') || '0'
  const scale = exponent - fraction.length
  if (scale >= 0) digits += '0'.repeat(scale)
  else {
    const decimalDigits = -scale
    if (decimalDigits >= digits.length) {
      if (/[^0]/u.test(digits)) return false
      digits = '0'
    } else if (/[^0]/u.test(digits.slice(-decimalDigits))) {
      return false
    } else {
      digits = digits.slice(0, -decimalDigits)
    }
  }
  digits = digits.replace(/^0+/u, '') || '0'
  return (sign === '-' && digits !== '0' ? '-' : '') + digits === String(expected)
}

const redactNearValue = (
  value: unknown,
  credential: string | undefined,
  additionalCredentials: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (value instanceof NearJsonNumber) return value
  if (typeof value === 'string') {
    return redactJsonRpcError(
      { code: 0, message: value },
      credential,
      additionalCredentials,
    ).message
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth >= 32 || seen.has(value)) return '[REDACTED]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactNearValue(item, credential, additionalCredentials, seen, depth + 1))
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const safeKey = redactJsonRpcError({ code: 0, message: key }, credential, additionalCredentials).message
      defineOwn(result, safeKey, redactNearValue(item, credential, additionalCredentials, seen, depth + 1))
    }
    return result
  } finally { seen.delete(value) }
}

const redactNearError = (
  error: { readonly code: number; readonly message: string; readonly data?: unknown },
  credential: string | undefined,
  additionalCredentials: readonly string[],
): { readonly code: number; readonly message: string; readonly data?: unknown } => {
  const message = redactJsonRpcError(error, credential, additionalCredentials).message
  return {
    code: error.code,
    message,
    ...(error.data === undefined
      ? {}
      : { data: redactNearValue(error.data, credential, additionalCredentials, new WeakSet(), 0) }),
  }
}

const unwrap = <TResult>(
  value: NearJsonValue,
  expectedId: number,
  credential: string | undefined,
  additionalCredentials: readonly string[],
): TResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isNearJsonNumber(value)) {
    throw new ErpcInvalidResponseError()
  }
  const object = value as { readonly [key: string]: NearJsonValue }
  if (!numericIdMatches(object.id, expectedId)) {
    throw new ErpcInvalidResponseError('ERPC returned an unexpected response id')
  }
  if (object.error !== undefined) {
    const error = object.error
    if (typeof error !== 'object' || error === null || Array.isArray(error) || isNearJsonNumber(error)) {
      throw new ErpcInvalidResponseError()
    }
    const errorObject = error as { readonly [key: string]: NearJsonValue }
    const code = errorObject.code
    const message = errorObject.message
    if (!isNearJsonNumber(code) || !/^-?\d+$/u.test(code.value) || typeof message !== 'string') {
      throw new ErpcInvalidResponseError()
    }
    const numericCode = Number(code.value)
    if (!Number.isSafeInteger(numericCode)) throw new ErpcInvalidResponseError()
    throw new ErpcJsonRpcError(redactNearError({
      code: numericCode,
      message,
      ...(errorObject.data === undefined ? {} : { data: errorObject.data }),
    }, credential, additionalCredentials))
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
    throw new ErpcInvalidResponseError()
  }
  return (value as unknown as JsonRpcResponse<TResult> & { result: TResult }).result
}

export class NearHttpTransport {
  readonly endpoint: string
  readonly maxBatchSize = 0

  readonly #apiKey: string
  readonly #direct: boolean
  readonly #requestEndpoint: URL
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeoutMs: number
  readonly #unavailableNamespace: string | undefined
  readonly #redactionVariants: readonly string[]
  #nextId = 1

  constructor(config: NearHttpTransportConfig) {
    this.#apiKey = config.apiKey ?? ''
    this.#direct = config.direct ?? false
    this.#requestEndpoint = new URL(config.endpoint)
    this.#fetch = wrapFetch(config.fetch)
    this.#headers = config.headers
    this.#timeoutMs = config.timeoutMs
    this.#unavailableNamespace = config.unavailableNamespace
    const diagnostic = new URL(config.endpoint)
    diagnostic.pathname = '/'
    diagnostic.search = ''
    diagnostic.hash = ''
    this.endpoint = config.unavailableNamespace === undefined ? diagnostic.toString() : ''
    this.#redactionVariants = this.#direct
      ? directRedactionVariants(this.#requestEndpoint, this.#headers)
      : []
  }

  async request<TResult>(
    method: string,
    params?: JsonRpcParams,
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    this.#ensureConfigured()
    const id = this.#nextId
    this.#nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1
    const body = `{"jsonrpc":"2.0","id":${id},"method":${encodeString(method)}${params === undefined ? '' : `,"params":${encodeNearJson(params)}`}}`
    const response = await this.#post(body, options)
    return unwrap<TResult>(
      response,
      id,
      this.#direct ? undefined : this.#apiKey,
      this.#direct ? this.#redactionVariants : [],
    )
  }

  async batch<TResult extends readonly unknown[]>(
    _calls: readonly RpcBatchCall[],
    _options: RpcSendOptions = {},
  ): Promise<TResult> {
    throw new ErpcBatchPolicyError('NEAR RPC does not support batch calls')
  }

  async #post(body: string, options: RpcSendOptions): Promise<NearJsonValue> {
    this.#ensureConfigured()
    if (options.signal?.aborted) throw new ErpcAbortedError()
    const controlled = controlledSignal(this.#timeoutMs, options.signal)
    const url = new URL(this.#requestEndpoint)
    if (!this.#direct) url.searchParams.set('api-key', this.#apiKey)
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: requestHeaders(this.#headers),
        body,
        signal: controlled.signal,
        credentials: 'omit',
        redirect: 'manual',
      })
      const text = await response.text()
      if (!response.ok) throw new ErpcHttpError(response.status)
      return parseNearJson(text)
    } catch (error) {
      if (error instanceof ErpcHttpError || error instanceof ErpcInvalidResponseError || error instanceof ErpcJsonRpcError) throw error
      if (controlled.timedOut()) throw new ErpcTimeoutError(this.#timeoutMs)
      if (options.signal?.aborted) throw new ErpcAbortedError()
      throw new ErpcTransportError('Unable to reach ERPC')
    } finally {
      controlled.cleanup()
    }
  }

  #ensureConfigured(): void {
    if (this.#unavailableNamespace !== undefined) throw new ErpcNotConfiguredError(this.#unavailableNamespace)
  }
}
