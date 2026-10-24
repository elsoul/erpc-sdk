import { describe, expect, it } from 'vitest'
import { createMonadClient, MONAD_RPC_METHODS } from '../src/rpc/monad'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Monad sealed read facade', () => {
  it('preserves raw hexadecimal values and optional omission', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://monad.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0x8f' : '0x1234') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createMonadClient(transport).rpc
    expect(MONAD_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x8f')
    await expect(rpc.eth_getBalance('0xabc').send()).resolves.toBe('0x1234')
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc'] },
    ])
  })
})
