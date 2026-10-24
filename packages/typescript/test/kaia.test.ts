import { describe, expect, it } from 'vitest'
import { createKaiaClient, KAIA_RPC_METHODS } from '../src/rpc/kaia'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Kaia sealed read facade', () => {
  it('keeps the generated read set and forwards exact positional params', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://kaia.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0x2019' : '0x0') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createKaiaClient(transport).rpc
    expect(KAIA_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x2019')
    await rpc.eth_getBalance('0xabc', 'latest').send()
    await rpc.eth_call({ to: '0xabc' }, 'latest', { state: '0x1' }).send()
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'latest'] },
      { method: 'eth_call', params: [{ to: '0xabc' }, 'latest', { state: '0x1' }] },
    ])
  })
})
