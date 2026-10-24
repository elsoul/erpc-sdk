import { describe, expect, it } from 'vitest'
import { createSoneiumClient, SONEIUM_RPC_METHODS } from '../src/rpc/soneium'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Soneium sealed read facade', () => {
  it('does not expose generic or write methods', async () => {
    const transport: JsonRpcTransport = {
      endpoint: 'https://soneium.example/',
      maxBatchSize: 0,
      request: async <TResult>() => '0x0' as TResult,
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createSoneiumClient(transport).rpc
    expect(SONEIUM_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    expect(Object.keys(rpc).sort()).toEqual([
      'endpoint',
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect('raw' in rpc).toBe(false)
    expect('request' in rpc).toBe(false)
    expect('sendRawTransaction' in rpc).toBe(false)
    await rpc.eth_getBalance('0xabc').send()
  })
})
