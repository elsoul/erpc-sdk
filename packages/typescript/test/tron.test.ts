import { describe, expect, it } from 'vitest'
import { createTronClient, TRON_RPC_METHODS } from '../src/rpc/tron'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('TRON sealed read facade', () => {
  it('keeps raw hexadecimal values and performs no address conversion', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://tron.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0x2b6653dc' : '0x0') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createTronClient(transport).rpc
    expect(TRON_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x2b6653dc')
    await rpc.eth_getBalance('0x41abcdef', 'latest').send()
    await rpc.eth_call({ to: '0x41abcdef', data: '0x' }, 'latest').send()
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0x41abcdef', 'latest'] },
      { method: 'eth_call', params: [{ to: '0x41abcdef', data: '0x' }, 'latest'] },
    ])
  })
})
