import { describe, expect, it } from 'vitest'
import { createRobinhoodClient, ROBINHOOD_RPC_METHODS } from '../src/rpc/robinhood'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Robinhood Chain Public Mainnet sealed read facade', () => {
  it('keeps the public chain root limited to three reads', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://robinhood.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0x1237' : '0x0') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createRobinhoodClient(transport).rpc
    expect(ROBINHOOD_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    expect(Object.keys(rpc).sort()).toEqual([
      'endpoint',
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    await rpc.eth_chainId().send()
    await rpc.eth_getBalance('0xabc', 'latest').send()
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'latest'] },
    ])
  })
})
