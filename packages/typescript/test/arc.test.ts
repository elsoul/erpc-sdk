import { describe, expect, it } from 'vitest'
import { createArcClient, ARC_RPC_METHODS } from '../src/rpc/arc'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Arc sealed read facade', () => {
  it('preserves raw balance units and call results', async () => {
    const transport: JsonRpcTransport = {
      endpoint: 'https://arc.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string) =>
        (method === 'eth_chainId' ? '0x13b2' : '0x1234567890abcdef') as TResult,
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createArcClient(transport).rpc
    expect(ARC_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x13b2')
    await expect(rpc.eth_getBalance('0xabc').send()).resolves.toBe('0x1234567890abcdef')
    await expect(rpc.eth_call({ to: '0xabc', data: '0x' }).send()).resolves.toBe('0x1234567890abcdef')
    expect('raw' in rpc).toBe(false)
    expect('sendRawTransaction' in rpc).toBe(false)
  })
})
