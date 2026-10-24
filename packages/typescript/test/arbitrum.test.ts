import { describe, expect, it } from 'vitest'
import { createArbitrumClient, ARBITRUM_RPC_METHODS } from '../src/rpc/arbitrum'
import type { JsonRpcTransport } from '../src/rpc/client'

describe('Arbitrum sealed read facade', () => {
  it('uses the exact three read methods and no generic escape hatch', async () => {
    const calls: Array<{ readonly method: string; readonly params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://arbitrum.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return (method === 'eth_chainId' ? '0xa4b1' : '0x0') as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createArbitrumClient(transport).rpc

    expect(ARBITRUM_RPC_METHODS).toEqual([
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect(Object.keys(rpc).sort()).toEqual([
      'endpoint',
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect('raw' in rpc).toBe(false)
    expect('request' in rpc).toBe(false)
    expect('batch' in rpc).toBe(false)
    expect('subscribe' in rpc).toBe(false)

    await expect(rpc.eth_chainId().send()).resolves.toBe('0xa4b1')
    await expect(rpc.eth_getBalance('0xabc', 'latest').send()).resolves.toBe('0x0')
    await expect(rpc.eth_call({ to: '0xabc', data: '0x' }, 'latest').send()).resolves.toBe('0x0')
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'latest'] },
      { method: 'eth_call', params: [{ to: '0xabc', data: '0x' }, 'latest'] },
    ])
  })

  it('omits optional positional parameters instead of serializing undefined', async () => {
    const calls: Array<{ readonly method: string; readonly params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://arbitrum.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        return '0x0' as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createArbitrumClient(transport).rpc
    await rpc.eth_getBalance('0xabc').send()
    await rpc.eth_call({ to: '0xabc' }).send()
    expect(calls).toEqual([
      { method: 'eth_getBalance', params: ['0xabc'] },
      { method: 'eth_call', params: [{ to: '0xabc' }] },
    ])
  })
})
