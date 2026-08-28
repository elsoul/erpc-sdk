import type { JsonRpcErrorObject } from './rpc/types'

const REDACTED = '[REDACTED]'

const credentialVariants = (credential: string): readonly string[] => {
  const queryEncoded = new URLSearchParams({ value: credential })
    .toString()
    .slice('value='.length)
  let componentEncoded: string | undefined
  try {
    componentEncoded = encodeURIComponent(credential)
  } catch {
    // URLSearchParams still provides a safe encoded representation.
  }
  return [...new Set([credential, componentEncoded, queryEncoded])]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
}

const redactString = (value: string, variants: readonly string[]): string => {
  let redacted = value
  for (const variant of variants) redacted = redacted.replaceAll(variant, REDACTED)
  return redacted
}

const redactValue = (
  value: unknown,
  variants: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (typeof value === 'string') return redactString(value, variants)
  if (typeof value !== 'object' || value === null) return value
  if (depth >= 32 || seen.has(value)) return REDACTED

  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, variants, seen, depth + 1))
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: redactValue(item, variants, seen, depth + 1),
      writable: true,
    })
  }
  return result
}

export const redactJsonRpcError = (
  error: JsonRpcErrorObject,
  credential: string | undefined,
): JsonRpcErrorObject => {
  if (!credential) return error
  const variants = credentialVariants(credential)
  const result: {
    code: number
    data?: unknown
    message: string
  } = {
    code: error.code,
    message: redactString(error.message, variants),
  }
  if (error.data !== undefined) {
    result.data = redactValue(error.data, variants, new WeakSet(), 0)
  }
  return result
}

export type ErpcErrorCode =
  | 'ERPC_ABORTED'
  | 'ERPC_BATCH_POLICY'
  | 'ERPC_CONFIG'
  | 'ERPC_HTTP'
  | 'ERPC_INVALID_RESPONSE'
  | 'ERPC_RPC'
  | 'ERPC_TIMEOUT'
  | 'ERPC_TRANSPORT'

export class ErpcError extends Error {
  readonly code: ErpcErrorCode

  constructor(code: ErpcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ErpcError'
    this.code = code
  }
}

export class ErpcConfigError extends ErpcError {
  constructor(message: string) {
    super('ERPC_CONFIG', message)
    this.name = 'ErpcConfigError'
  }
}

export class ErpcTransportError extends ErpcError {
  constructor(message: string, options?: ErrorOptions) {
    super('ERPC_TRANSPORT', message, options)
    this.name = 'ErpcTransportError'
  }
}

export class ErpcHttpError extends ErpcError {
  readonly status: number

  constructor(status: number, message = `ERPC request failed with HTTP ${status}`) {
    super('ERPC_HTTP', message)
    this.name = 'ErpcHttpError'
    this.status = status
  }
}

export class ErpcTimeoutError extends ErpcError {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super('ERPC_TIMEOUT', `ERPC request timed out after ${timeoutMs}ms`)
    this.name = 'ErpcTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class ErpcAbortedError extends ErpcError {
  constructor() {
    super('ERPC_ABORTED', 'ERPC request was aborted')
    this.name = 'ErpcAbortedError'
  }
}

export class ErpcInvalidResponseError extends ErpcError {
  constructor(message = 'ERPC returned an invalid response') {
    super('ERPC_INVALID_RESPONSE', message)
    this.name = 'ErpcInvalidResponseError'
  }
}

export class ErpcJsonRpcError extends ErpcError {
  readonly rpcCode: number
  readonly data?: unknown

  constructor(error: JsonRpcErrorObject) {
    super('ERPC_RPC', error.message)
    this.name = 'ErpcJsonRpcError'
    this.rpcCode = error.code
    if (error.data !== undefined) this.data = error.data
  }
}

export class ErpcBatchPolicyError extends ErpcError {
  constructor(message: string) {
    super('ERPC_BATCH_POLICY', message)
    this.name = 'ErpcBatchPolicyError'
  }
}
