import { describe, expect, it } from 'vitest'
import { createHyperliquidClient, HYPERLIQUID_RPC_METHODS } from '../src/rpc/hyperliquid'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Hyperliquid HyperEVM sealed read facade', () => {
  it('uses HyperEVM root-compatible reads without network relabeling', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://hyperliquid.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0x3e7' : '0x1') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createHyperliquidClient(transport).rpc
    expect(HYPERLIQUID_RPC_METHODS).toEqual(['eth_call', 'eth_chainId', 'eth_getBalance'])
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x3e7')
    await expect(rpc.eth_getBalance('0xabc', 'latest').send()).resolves.toBe('0x1')
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'latest'] },
    ])
  })
})
