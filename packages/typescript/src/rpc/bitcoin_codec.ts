import { parse } from 'lossless-json'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import {
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
} from '../errors'
import type { JsonRpcId, JsonRpcErrorObject } from './types'

interface GeneratedCapability {
  readonly wireOperation: string
}

interface GeneratedMethodSet {
  readonly methodSetId: string
  readonly capabilities?: readonly GeneratedCapability[]
}

interface GeneratedContract {
  readonly methodSets: readonly GeneratedMethodSet[]
}

const generatedContract = RPC_NETWORK_CONTRACT as unknown as GeneratedContract

const generatedWireMethods = (methodSetId: string): readonly string[] => {
  const methodSet = generatedContract.methodSets.find(
    (candidate) => candidate.methodSetId === methodSetId,
  )
  if (methodSet?.capabilities === undefined) {
    throw new Error(`Missing generated method set: ${methodSetId}`)
  }
  return Object.freeze(methodSet.capabilities.map(({ wireOperation }) => wireOperation))
}

export const BITCOIN_RPC_METHODS = generatedWireMethods('bitcoin-read12')

export const BITCOIN_RESPONSE_LIMITS = Object.freeze({
  maxBodyBytes: 67_108_864,
  maxDepth: 64,
  maxTokens: 1_000_000,
  maxLexemeBytes: 1_024,
  maxCoefficientDigits: 1_000,
  minExponent10: -10_000,
  maxExponent10: 10_000,
})

const NUMBER_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u
const INTEGER_PATTERN = /^(0|[1-9]\d*)$/u
const SIGNED_INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/u

export interface BitcoinNumberTuple {
  readonly sign: -1 | 0 | 1
  readonly coefficient: string
  readonly exponent10: string
}

export class BitcoinJsonNumber {
  readonly value: string

  constructor(value: string) {
    canonicalizeBitcoinNumber(value)
    this.value = value
    Object.freeze(this)
  }

  toString(): string {
    return this.value
  }
}

export type BitcoinJsonPrimitive =
  | boolean
  | null
  | string
  | BitcoinJsonNumber

export type BitcoinJsonValue =
  | BitcoinJsonPrimitive
  | readonly BitcoinJsonValue[]
  | { readonly [key: string]: BitcoinJsonValue }

type BitcoinJsonObject = { [key: string]: BitcoinJsonValue }

const invalidResponse = (): ErpcInvalidResponseError =>
  new ErpcInvalidResponseError()

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isDigit = (value: string | undefined): boolean =>
  value !== undefined && value >= '0' && value <= '9'

const checkedExponent = (value: string): number => {
  const sign = value.startsWith('-') ? -1 : 1
  const digits = value[0] === '-' || value[0] === '+' ? value.slice(1) : value
  const normalized = digits.replace(/^0+/u, '') || '0'
  if (normalized.length > 5 || Number(normalized) > 10_000) {
    throw invalidResponse()
  }
  return sign * Number(normalized)
}

export const canonicalizeBitcoinNumber = (
  value: string,
): BitcoinNumberTuple => {
  if (value.length > BITCOIN_RESPONSE_LIMITS.maxLexemeBytes) {
    throw invalidResponse()
  }
  const match = NUMBER_PATTERN.exec(value)
  if (match === null) throw invalidResponse()

  const signToken = match[1] ?? ''
  const integer = match[2] ?? ''
  const fraction = match[3] ?? ''
  const exponent = checkedExponent(match[4] ?? '0')
  const rawCoefficient = integer + fraction
  if (rawCoefficient.length > BITCOIN_RESPONSE_LIMITS.maxCoefficientDigits) {
    throw invalidResponse()
  }

  const withoutLeadingZeroes = rawCoefficient.replace(/^0+/u, '') || '0'
  if (withoutLeadingZeroes === '0') {
    return { sign: 0, coefficient: '0', exponent10: '0' }
  }

  const coefficient = withoutLeadingZeroes.replace(/0+$/u, '')
  const trailingZeroes = withoutLeadingZeroes.length - coefficient.length
  const exponent10 = exponent - fraction.length + trailingZeroes
  if (
    exponent10 < BITCOIN_RESPONSE_LIMITS.minExponent10 ||
    exponent10 > BITCOIN_RESPONSE_LIMITS.maxExponent10
  ) {
    throw invalidResponse()
  }

  return {
    sign: signToken === '-' ? -1 : 1,
    coefficient,
    exponent10: String(exponent10),
  }
}

export const bitcoinNumberTuple = (
  value: BitcoinJsonNumber,
): BitcoinNumberTuple => canonicalizeBitcoinNumber(value.value)

const tuplesEqual = (left: BitcoinNumberTuple, right: BitcoinNumberTuple): boolean =>
  left.sign === right.sign &&
  left.coefficient === right.coefficient &&
  left.exponent10 === right.exponent10

const scanNumber = (
  text: string,
  start: number,
): { readonly end: number; readonly lexeme: string } => {
  let index = start
  if (text[index] === '-') index += 1

  if (text[index] === '0') {
    index += 1
  } else if (isDigit(text[index]) && text[index] !== '0') {
    index += 1
    while (isDigit(text[index])) index += 1
  } else {
    throw invalidResponse()
  }

  if (text[index] === '.') {
    index += 1
    if (!isDigit(text[index])) throw invalidResponse()
    while (isDigit(text[index])) index += 1
  }

  if (text[index] === 'e' || text[index] === 'E') {
    index += 1
    if (text[index] === '+' || text[index] === '-') index += 1
    if (!isDigit(text[index])) throw invalidResponse()
    while (isDigit(text[index])) index += 1
  }

  const lexeme = text.slice(start, index)
  canonicalizeBitcoinNumber(lexeme)
  return { end: index, lexeme }
}

const skipString = (text: string, start: number): number => {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '"') return index + 1
    index += 1
  }
  throw invalidResponse()
}

const isWhitespace = (value: string | undefined): boolean =>
  value === ' ' || value === '\n' || value === '\r' || value === '\t'

const scanLiteral = (text: string, start: number, literal: string): number => {
  if (text.slice(start, start + literal.length) !== literal) {
    throw invalidResponse()
  }
  return start + literal.length
}

/**
 * Runs the bounded, non-recursive resource and number preflight. The native
 * parser remains responsible for JSON syntax and object construction.
 */
export const preflightBitcoinJson = (text: string): void => {
  let index = 0
  let depth = 0
  let tokens = 0

  const addToken = (): void => {
    tokens += 1
    if (tokens > BITCOIN_RESPONSE_LIMITS.maxTokens) throw invalidResponse()
  }

  while (index < text.length) {
    const character = text[index]
    if (isWhitespace(character) || character === ',' || character === ':') {
      index += 1
      continue
    }

    if (character === '"') {
      addToken()
      index = skipString(text, index)
      continue
    }

    if (character === '{' || character === '[') {
      addToken()
      depth += 1
      if (depth > BITCOIN_RESPONSE_LIMITS.maxDepth) throw invalidResponse()
      index += 1
      continue
    }

    if (character === '}' || character === ']') {
      if (depth === 0) throw invalidResponse()
      depth -= 1
      index += 1
      continue
    }

    if (character === '-' || isDigit(character)) {
      const number = scanNumber(text, index)
      addToken()
      index = number.end
      continue
    }

    if (character === 't') {
      index = scanLiteral(text, index, 'true')
      addToken()
      continue
    }
    if (character === 'f') {
      index = scanLiteral(text, index, 'false')
      addToken()
      continue
    }
    if (character === 'n') {
      index = scanLiteral(text, index, 'null')
      addToken()
      continue
    }

    // Leave punctuation and any other malformed character for the native
    // parser. This preflight must not become a second JSON implementation.
    index += 1
  }

  if (depth !== 0) throw invalidResponse()
}

const isBitcoinJsonObject = (value: unknown): value is BitcoinJsonObject =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof BitcoinJsonNumber)

const isBitcoinJsonValue = (value: unknown, depth = 0): value is BitcoinJsonValue => {
  if (value instanceof BitcoinJsonNumber) return true
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true
  }
  if (depth > BITCOIN_RESPONSE_LIMITS.maxDepth) return false
  if (Array.isArray(value)) return value.every((item) => isBitcoinJsonValue(item, depth + 1))
  if (!isBitcoinJsonObject(value)) return false
  return Object.values(value).every((item) => isBitcoinJsonValue(item, depth + 1))
}

export const decodeBitcoinJson = (text: string): BitcoinJsonValue => {
  preflightBitcoinJson(text)
  try {
    const value = parse(text, undefined, {
      onDuplicateKey: ({ newValue }) => newValue,
      parseNumber: (raw) => new BitcoinJsonNumber(raw),
    })
    if (!isBitcoinJsonValue(value)) throw invalidResponse()
    return value
  } catch (error) {
    if (error instanceof ErpcInvalidResponseError) throw error
    throw invalidResponse()
  }
}

const numericIdMatches = (
  actual: BitcoinJsonNumber,
  expected: number,
): boolean => {
  try {
    return tuplesEqual(
      bitcoinNumberTuple(actual),
      canonicalizeBitcoinNumber(String(expected)),
    )
  } catch {
    return false
  }
}

const responseIdMatches = (actual: unknown, expected: JsonRpcId): boolean => {
  if (typeof expected === 'string') return actual === expected
  return actual instanceof BitcoinJsonNumber && numericIdMatches(actual, expected)
}

const parseRpcCode = (value: unknown): number | undefined => {
  if (
    !(value instanceof BitcoinJsonNumber) ||
    !SIGNED_INTEGER_PATTERN.test(value.value)
  ) {
    return undefined
  }
  const result = Number(value.value)
  return Number.isSafeInteger(result) ? result : undefined
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const percentPattern = (value: string): string => {
  const pattern = /%([0-9a-f])([0-9a-f])/giu
  let result = ''
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    result += escapeRegex(value.slice(offset, index))
    const first = match[1] ?? ''
    const second = match[2] ?? ''
    result += `%[${first.toLowerCase()}${first.toUpperCase()}][${second.toLowerCase()}${second.toUpperCase()}]`
    offset = index + match[0].length
  }
  return result + escapeRegex(value.slice(offset))
}

const redactString = (value: string, variants: readonly string[]): string => {
  let result = value
  for (const variant of variants) {
    if (!variant) continue
    const pattern = percentPattern(variant)
    if (pattern === escapeRegex(variant)) result = result.replaceAll(variant, '[REDACTED]')
    else result = result.replace(new RegExp(pattern, 'gu'), '[REDACTED]')
  }
  return result
}

const credentialVariants = (credential: string): readonly string[] => {
  const queryEncoded = new URLSearchParams({ value: credential })
    .toString()
    .slice('value='.length)
  let componentEncoded: string | undefined
  try {
    componentEncoded = encodeURIComponent(credential)
  } catch {
    componentEncoded = undefined
  }
  return [...new Set([credential, queryEncoded, componentEncoded])]
    .filter((value): value is string => Boolean(value))
}

const redactionVariants = (config: BitcoinRedactionConfig): readonly string[] => {
  const values = [
    ...(config.credential === undefined ? [] : credentialVariants(config.credential)),
    ...(config.additionalCredentials ?? []),
  ]
  return [...new Set(values)].sort((left, right) => right.length - left.length)
}

const redactBitcoinValue = (
  value: unknown,
  variants: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (value instanceof BitcoinJsonNumber) return value
  if (typeof value === 'string') return redactString(value, variants)
  if (typeof value !== 'object' || value === null) return value
  if (depth >= 32 || seen.has(value)) return '[REDACTED]'

  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactBitcoinValue(item, variants, seen, depth + 1))
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, redactString(key, variants), {
      configurable: true,
      enumerable: true,
      value: redactBitcoinValue(item, variants, seen, depth + 1),
      writable: true,
    })
  }
  return result
}

export interface BitcoinRedactionConfig {
  readonly credential?: string
  readonly additionalCredentials?: readonly string[]
}

export const redactBitcoinRpcError = (
  error: JsonRpcErrorObject,
  config: BitcoinRedactionConfig = {},
): JsonRpcErrorObject => {
  const variants = redactionVariants(config)
  if (variants.length === 0) return error
  const result: JsonRpcErrorObject = {
    code: error.code,
    message: redactString(error.message, variants),
    ...(error.data === undefined
      ? {}
      : { data: redactBitcoinValue(error.data, variants, new WeakSet(), 0) }),
  }
  return result
}

export const unwrapBitcoinRpcResponse = <TResult extends BitcoinJsonValue>(
  response: BitcoinJsonValue,
  expectedId: JsonRpcId,
  redaction: BitcoinRedactionConfig = {},
): TResult => {
  if (!isBitcoinJsonObject(response) || !hasOwn(response, 'id')) {
    throw invalidResponse()
  }
  if (!responseIdMatches(response.id, expectedId)) throw invalidResponse()

  if (hasOwn(response, 'error') && response.error !== null) {
    if (!isBitcoinJsonObject(response.error)) throw invalidResponse()
    const code = parseRpcCode(response.error.code)
    if (code === undefined || typeof response.error.message !== 'string') {
      throw invalidResponse()
    }
    const error = redactBitcoinRpcError(
      {
        code,
        message: response.error.message,
        ...(hasOwn(response.error, 'data') ? { data: response.error.data } : {}),
      },
      redaction,
    )
    throw new ErpcJsonRpcError(error)
  }

  if (!hasOwn(response, 'result')) throw invalidResponse()
  return response.result as TResult
}

export const asBitcoinString = (value: BitcoinJsonValue): string => {
  if (typeof value !== 'string') throw invalidResponse()
  return value
}

export const asBitcoinBlockCount = (value: BitcoinJsonValue): bigint => {
  if (!(value instanceof BitcoinJsonNumber) || !INTEGER_PATTERN.test(value.value)) {
    throw invalidResponse()
  }
  try {
    const result = BigInt(value.value)
    if (result > 18_446_744_073_709_551_615n) throw invalidResponse()
    return result
  } catch (error) {
    if (error instanceof ErpcInvalidResponseError) throw error
    throw invalidResponse()
  }
}
