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
  return [
    ...new Set([
      credential,
      componentEncoded,
      queryEncoded,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
}

const directEndpointVariants = (endpoint: URL): readonly string[] => {
  const values: string[] = []
  const add = (value: string | undefined): void => {
    if (value) values.push(value)
  }

  // Caller-owned direct paths can contain provider credentials. Keep each
  // non-empty component so an upstream error that echoes either the URL or an
  // individual path value is sanitized. The URL object preserves the
  // caller's percent-escape spelling in pathname.
  const addPathValue = (value: string): void => {
    add(value)
    try {
      add(decodeURIComponent(value))
    } catch {
      // Invalid escapes are retained as raw input and have no decoded form.
    }
  }
  for (const component of endpoint.pathname.split('/')) {
    if (component) addPathValue(component)
  }

  for (const value of endpoint.searchParams.values()) add(value)

  // URLSearchParams normalizes percent escapes. Preserve the raw query
  // components too, so an upstream error echoing a lower-case escape is still
  // safe to expose.
  const rawQuery = endpoint.search.startsWith('?')
    ? endpoint.search.slice(1)
    : endpoint.search
  for (const part of rawQuery.split('&')) {
    const separator = part.indexOf('=')
    const rawValue = separator === -1 ? '' : part.slice(separator + 1)
    add(rawValue)
    if (rawValue) {
      try {
        add(decodeURIComponent(rawValue.replaceAll('+', ' ')))
      } catch {
        // Invalid escapes are retained as raw input and have no decoded form.
      }
    }
  }

  return values
}

const headerVariants = (
  headers: Readonly<Record<string, string>>,
): readonly string[] => {
  const values: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    values.push(value)
    if (
      name.toLowerCase() !== 'authorization' &&
      name.toLowerCase() !== 'proxy-authorization'
    ) continue
    const match = /^\s*[^\s]+\s+(.+?)\s*$/u.exec(value)
    if (match?.[1]) values.push(match[1])
    if (match?.[1] && /^basic$/iu.test(value.trim().split(/\s+/u, 1)[0] ?? '')) {
      try {
        const decoded = globalThis.atob(match[1])
        values.push(decoded)
        const separator = decoded.indexOf(':')
        if (separator !== -1) {
          values.push(decoded.slice(0, separator), decoded.slice(separator + 1))
        }
      } catch {
        // Non-base64 Basic credentials remain covered by their raw forms.
      }
    }
  }
  return values
}

export const directRedactionVariants = (
  endpoint: URL,
  headers: Readonly<Record<string, string>> = {},
): readonly string[] =>
  [...new Set([...directEndpointVariants(endpoint), ...headerVariants(headers)])]
    .flatMap((value) => credentialVariants(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => right.length - left.length)

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const hexCharacterPattern = (value: string): string => {
  const lower = value.toLowerCase()
  const upper = value.toUpperCase()
  if (lower === upper) return escapeRegex(value)
  return `[${lower}${upper}]`
}

const percentTripletPattern = (value: string): string => {
  const pattern = /%([0-9a-f])([0-9a-f])/giu
  let result = ''
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    result += escapeRegex(value.slice(offset, index))
    result += `%${hexCharacterPattern(match[1] ?? '')}${hexCharacterPattern(
      match[2] ?? '',
    )}`
    offset = index + match[0].length
  }
  return result + escapeRegex(value.slice(offset))
}

const redactString = (value: string, variants: readonly string[]): string => {
  let redacted = value
  for (const variant of variants) {
    if (!variant) continue
    const pattern = percentTripletPattern(variant)
    if (pattern === escapeRegex(variant)) {
      redacted = redacted.replaceAll(variant, REDACTED)
    } else {
      redacted = redacted.replace(new RegExp(pattern, 'gu'), REDACTED)
    }
  }
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
    Object.defineProperty(result, redactString(key, variants), {
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
  additionalCredentials: readonly string[] = [],
): JsonRpcErrorObject => {
  const variants = [...new Set([
    ...(credential ? credentialVariants(credential) : []),
    ...additionalCredentials,
  ])].sort((left, right) => right.length - left.length)
  if (variants.length === 0) return error
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
  | 'ERPC_NOT_CONFIGURED'
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

export class ErpcNotConfiguredError extends ErpcError {
  readonly namespace: string

  constructor(namespace: string) {
    super('ERPC_NOT_CONFIGURED', `ERPC namespace '${namespace}' is not configured`)
    this.name = 'ErpcNotConfiguredError'
    this.namespace = namespace
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
