import { describe, expect, it } from 'vitest'
import { createOptimismClient, OPTIMISM_RPC_METHODS } from '../src/rpc/optimism'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Optimism sealed read facade', () => {
  it('keeps raw wire values and forwards the exact call shape', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://optimism.example/rpc?region=eu',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0xa' : '0x123456789abcdef') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createOptimismClient(transport).rpc
    expect(OPTIMISM_RPC_METHODS).toEqual([
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0xa')
    await expect(rpc.eth_getBalance('0xabc').send()).resolves.toBe('0x123456789abcdef')
    await expect(rpc.eth_call({ to: '0xabc', data: '0xdeadbeef' }, 'safe', { state: '0x1' }).send())
      .resolves.toBe('0x123456789abcdef')
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc'] },
      {
        method: 'eth_call',
        params: [{ to: '0xabc', data: '0xdeadbeef' }, 'safe', { state: '0x1' }],
      },
    ])
  })
})
