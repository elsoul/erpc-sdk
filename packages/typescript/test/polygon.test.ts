import { describe, expect, it } from 'vitest'
import { createPolygonClient, POLYGON_RPC_METHODS } from '../src/rpc/polygon'
import type { JsonRpcTransport } from '../src/rpc/client'

const transportFor = (calls: Array<{ method: string; params?: unknown }>): JsonRpcTransport => ({
  endpoint: 'https://polygon.example/rpc?tenant=one',
  maxBatchSize: 0,
  request: async <TResult>(method: string, params?: unknown) => {
    calls.push({ method, params })
    return (method === 'eth_chainId' ? '0x89' : '0x0') as TResult
  },
  batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
})

describe('Polygon sealed read facade', () => {
  it('uses generated methods and only exposes the three reads', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const rpc = createPolygonClient(transportFor(calls)).rpc
    expect(POLYGON_RPC_METHODS).toEqual([
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
    await expect(rpc.eth_chainId().send()).resolves.toBe('0x89')
    await rpc.eth_getBalance('0xabc', 'latest').send()
    await rpc.eth_call({ to: '0xabc', data: '0x' }, 'latest').send()
    expect(calls).toEqual([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBalance', params: ['0xabc', 'latest'] },
      { method: 'eth_call', params: [{ to: '0xabc', data: '0x' }, 'latest'] },
    ])
  })

  it('omits undefined optional positional values', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const rpc = createPolygonClient(transportFor(calls)).rpc
    await rpc.eth_getBalance('0xabc').send()
    await rpc.eth_call({ to: '0xabc' }).send()
    expect(calls).toEqual([
      { method: 'eth_getBalance', params: ['0xabc'] },
      { method: 'eth_call', params: [{ to: '0xabc' }] },
    ])
  })
})
