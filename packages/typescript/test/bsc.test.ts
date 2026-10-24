import { describe, expect, it } from 'vitest'
import { createBscClient, BSC_RPC_METHODS } from '../src/rpc/bsc'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('BSC sealed read facade', () => {
  it('routes all three reads and has no generic escape hatch', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://bsc.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return '0x0' as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createBscClient(transport).rpc
    expect(BSC_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    expect(Object.keys(rpc).sort()).toEqual([
      'endpoint',
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect('raw' in rpc).toBe(false)
    expect('request' in rpc).toBe(false)
    await rpc.eth_chainId().send()
    await rpc.eth_getBalance('0xabc', 'finalized').send()
    await rpc.eth_call({ to: '0xabc' }).send()
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'finalized'] },
      { method: 'eth_call', params: [{ to: '0xabc' }] },
    ])
  })
})
