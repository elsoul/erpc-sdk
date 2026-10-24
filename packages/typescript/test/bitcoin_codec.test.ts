import { describe, expect, it } from 'vitest'
import {
  asBitcoinBlockCount,
  BITCOIN_RESPONSE_LIMITS,
  bitcoinNumberTuple,
  BitcoinJsonNumber,
  decodeBitcoinJson,
  preflightBitcoinJson,
} from '../src/rpc/bitcoin_codec'
import { ErpcInvalidResponseError } from '../src'
import { RPC_NETWORK_CONTRACT } from '../src/generated/rpc_network_contract'

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object')
  }
  return value as Record<string, unknown>
}

describe('Bitcoin exact JSON codec', () => {
  it('binds every production Bitcoin limit to the generated response policy', () => {
    const client = (RPC_NETWORK_CONTRACT as any).clientContracts.find(
      (entry: any) => entry.clientContractId === 'client-bitcoin-rpc',
    )
    const policy = client.responsePolicy
    expect(policy.policyId).toBe('bitcoin-exact-json-v1')
    expect(policy.limitApplicability).toContain('typescript')
    expect({
      decodedEntityBytes: BITCOIN_RESPONSE_LIMITS.maxBodyBytes,
      containerDepth: BITCOIN_RESPONSE_LIMITS.maxDepth,
      jsonTokens: BITCOIN_RESPONSE_LIMITS.maxTokens,
      numericLexemeBytes: BITCOIN_RESPONSE_LIMITS.maxLexemeBytes,
      coefficientDigits: BITCOIN_RESPONSE_LIMITS.maxCoefficientDigits,
      explicitExponentMin: BITCOIN_RESPONSE_LIMITS.minExponent10,
      explicitExponentMax: BITCOIN_RESPONSE_LIMITS.maxExponent10,
      canonicalExponentMin: BITCOIN_RESPONSE_LIMITS.minExponent10,
      canonicalExponentMax: BITCOIN_RESPONSE_LIMITS.maxExponent10,
    }).toEqual(policy.limits)
  })

  it('keeps exact numbers and applies escaped duplicate keys last', () => {
    const value = asObject(
      decodeBitcoinJson(
        '{"result":1.20,"\\u0072esult":3.40,"nested":[18446744073709551616,1e-1000]}',
      ),
    )

    expect(value.result).toBeInstanceOf(BitcoinJsonNumber)
    expect((value.result as BitcoinJsonNumber).value).toBe('3.40')
    expect(bitcoinNumberTuple(value.result as BitcoinJsonNumber)).toEqual({
      sign: 1,
      coefficient: '34',
      exponent10: '-1',
    })
    expect(value.nested).toEqual([
      expect.objectContaining({ value: '18446744073709551616' }),
      expect.objectContaining({ value: '1e-1000' }),
    ])
  })

  it('keeps own __proto__ data without changing the prototype', () => {
    const value = asObject(
      decodeBitcoinJson('{"__proto__":{"polluted":true}}'),
    )

    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true)
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('normalizes equal mathematical values without floating point conversion', () => {
    const decimal = decodeBitcoinJson('{"value":0.00000001}') as Record<
      string,
      BitcoinJsonNumber
    >
    const exponent = decodeBitcoinJson('{"value":1e-8}') as Record<
      string,
      BitcoinJsonNumber
    >
    expect(bitcoinNumberTuple(decimal.value as BitcoinJsonNumber)).toEqual(
      bitcoinNumberTuple(exponent.value as BitcoinJsonNumber),
    )
    expect(bitcoinNumberTuple(new BitcoinJsonNumber('-0'))).toEqual({
      sign: 0,
      coefficient: '0',
      exponent10: '0',
    })
  })

  it('accepts only unsigned integer tokens in the bounded block-count projection', () => {
    const accepted = (token: string): bigint =>
      asBitcoinBlockCount(
        asObject(decodeBitcoinJson(`{"result":${token}}`)).result as never,
      )

    expect(accepted('0')).toBe(0n)
    expect(accepted('18446744073709551615')).toBe(18_446_744_073_709_551_615n)
    for (const token of ['-0', '1.0', '1e0', '18446744073709551616']) {
      expect(() => accepted(token)).toThrow(ErpcInvalidResponseError)
    }
  })

  it('enforces numeric, depth, token, and overwritten-value limits before parsing', () => {
    expect(() => preflightBitcoinJson(`{"value":${'1'.repeat(1001)}}`)).toThrow(
      ErpcInvalidResponseError,
    )
    expect(() => preflightBitcoinJson('{"value":1e10001}')).toThrow(
      ErpcInvalidResponseError,
    )
    expect(() => preflightBitcoinJson(`{"value":${'1'.repeat(1025)}}`)).toThrow(
      ErpcInvalidResponseError,
    )
    expect(() =>
      preflightBitcoinJson(`${'['.repeat(BITCOIN_RESPONSE_LIMITS.maxDepth + 1)}0${']'.repeat(BITCOIN_RESPONSE_LIMITS.maxDepth + 1)}`),
    ).toThrow(ErpcInvalidResponseError)

    const tokens = Array.from({ length: BITCOIN_RESPONSE_LIMITS.maxTokens + 1 }, () => '0')
    expect(() => preflightBitcoinJson(`[${tokens.join(',')}]`)).toThrow(
      ErpcInvalidResponseError,
    )
    expect(() =>
      preflightBitcoinJson(`{"result":0,"result":${'1'.repeat(1001)}}`),
    ).toThrow(ErpcInvalidResponseError)
  })

  it('maps parser and scanner failures to a safe invalid-response error', () => {
    for (const text of ['{"result":', '{"result":1,}', '{"result":1e10001}']) {
      const error = (() => {
        try {
          decodeBitcoinJson(text)
          return undefined
        } catch (value) {
          return value
        }
      })()
      expect(error).toBeInstanceOf(ErpcInvalidResponseError)
      expect(String(error)).not.toContain('result')
      expect(String(error)).not.toContain('10001')
    }
  })
})
