import { describe, expect, it } from 'vitest'
import { createErpcClient, ErpcAbortedError, ErpcJsonRpcError } from '../src'
import { createNearClient, NearJsonNumber } from '../src/rpc/near'
import { NearHttpTransport } from '../src/transport/near_http'
import type { JsonRpcTransport } from '../src/rpc/client'

const statusResult = {
  chain_id: 'mainnet',
  genesis_hash: 'genesis',
  latest_protocol_version: new NearJsonNumber('18446744073709551615'),
  protocol_version: new NearJsonNumber('1'),
  sync_info: {
    latest_block_hash: 'block',
    latest_block_height: new NearJsonNumber('42'),
    latest_block_time: '2026-01-01T00:00:00Z',
    latest_state_root: 'state',
    syncing: false,
    unknown_height: new NearJsonNumber('9007199254740993'),
  },
  version: { version: '1', build: 'build', unknown: new NearJsonNumber('7') },
}

describe('NEAR sealed read facade', () => {
  it('uses one named selector object and preserves exact numeric data', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const transport: JsonRpcTransport = {
      endpoint: 'https://near.example/',
      maxBatchSize: 0,
      request: async <TResult>(method: string, params?: unknown) => {
        calls.push({ method, params })
        if (method === 'status') return statusResult as TResult
        if (method === 'block') return {
          author: 'alice',
          header: {
            hash: 'h', height: new NearJsonNumber('2'), prev_hash: 'p',
            timestamp: new NearJsonNumber('3'), timestamp_nanosec: '3',
            gas_price: '4', total_supply: '5',
          },
          chunks: [],
        } as TResult
        return {
          amount: '10', locked: '0', code_hash: 'hash',
          storage_usage: new NearJsonNumber('1'), block_height: new NearJsonNumber('2'),
          block_hash: 'h',
        } as TResult
      },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createNearClient(transport).rpc
    const status = await rpc.status().send()
    expect(status.latestProtocolVersion).toBe(18_446_744_073_709_551_615n)
    expect(status.syncInfo.additional.unknown_height).toBeInstanceOf(NearJsonNumber)
    await rpc.block({ blockId: 18_446_744_073_709_551_615n }).send()
    await rpc.viewAccount('alice.near', { finality: 'final' }).send()
    expect(calls).toEqual([
      { method: 'status', params: [] },
      { method: 'block', params: { block_id: 18_446_744_073_709_551_615n } },
      {
        method: 'query',
        params: {
          request_type: 'view_account',
          account_id: 'alice.near',
          finality: 'final',
        },
      },
    ])
    expect('raw' in rpc).toBe(false)
    expect('request' in rpc).toBe(false)
    expect('batch' in rpc).toBe(false)
  })

  it('serializes a bigint block height as a raw JSON integer before fetch', async () => {
    const bodies: string[] = []
    const targets: string[] = []
    const transport = new NearHttpTransport({
      direct: true,
      endpoint: new URL('https://near.example/rpc?token=a%2Fb'),
      headers: { authorization: 'Bearer secret' },
      timeoutMs: 1000,
      fetch: async (input, init) => {
        targets.push(String(input))
        bodies.push(String(init?.body))
        const request = JSON.parse(String(init?.body)) as { id: number }
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id, result: { ok: true },
        }), { headers: { 'content-type': 'application/json' } })
      },
    })
    await transport.request('block', { block_id: 18_446_744_073_709_551_615n })
    expect(bodies[0]).toContain('"block_id":18446744073709551615')
    expect(bodies[0]).not.toContain('"block_id":"18446744073709551615"')
    expect(targets[0]).toBe('https://near.example/rpc?token=a%2Fb')
  })

  it('rejects a selector containing both finality and block ID locally', () => {
    let calls = 0
    const transport: JsonRpcTransport = {
      endpoint: 'https://near.example/',
      maxBatchSize: 0,
      request: async <TResult>() => { calls += 1; return statusResult as TResult },
      batch: async <TResult extends readonly unknown[]>() => [] as unknown as TResult,
    }
    const rpc = createNearClient(transport).rpc
    expect(() => rpc.block({ finality: 'final', blockId: 'hash' } as never)).toThrow()
    expect(calls).toBe(0)
  })

  it('keeps exact numeric error data while redacting direct credentials', async () => {
    const transport = new NearHttpTransport({
      direct: true,
      endpoint: new URL('https://near.example/rpc?token=secret%2Fpath'),
      headers: { authorization: 'Bearer header-secret' },
      timeoutMs: 1000,
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number }
        return new Response(`{"jsonrpc":"2.0","id":${request.id},"error":{"code":-32000,"message":"secret%2fpath header-secret","data":{"height":18446744073709551615,"token":"secret/path"}}}`)
      },
    })
    const error = await transport.request('status').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect((error as ErpcJsonRpcError).data).toMatchObject({ height: expect.any(NearJsonNumber) })
    expect(JSON.stringify(error)).not.toContain('secret/path')
    expect(JSON.stringify(error)).not.toContain('header-secret')
  })

  it('treats null optionals as absent and keeps __proto__ additional data own', async () => {
    let result = `{"chain_id":"mainnet","genesis_hash":"genesis","latest_protocol_version":1,"protocol_version":1,"sync_info":{"latest_block_hash":"block","latest_block_height":42,"latest_block_time":"time","latest_state_root":"state","syncing":false},"version":{"version":"1","build":"build","rustc_version":null,"__proto__":{"review":7}}}`
    const client = createErpcClient({
      nearRpc: { httpUrl: 'https://near.example/' },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly method: string; readonly id: number }
        if (request.method === 'query') {
          result = `{"amount":"1","locked":"0","code_hash":"hash","storage_usage":1,"storage_paid_at":null,"block_height":2,"block_hash":"block"}`
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: JSON.parse(result) }))
      },
    })

    const status = await client.near.rpc.status().send()
    expect(status.version.rustcVersion).toBeUndefined()
    expect(Object.hasOwn(status.version.additional, '__proto__')).toBe(true)
    expect(status.version.additional.__proto__).toMatchObject({
      review: expect.objectContaining({ value: '7' }),
    })
    expect(Object.getPrototypeOf(status.version.additional)).toBe(Object.prototype)
    const account = await client.near.rpc.viewAccount('alice.near', { finality: 'final' }).send()
    expect(account.storagePaidAt).toBeUndefined()
    client.close()
  })

  it('rejects a pre-aborted public request before invoking fetch', async () => {
    let calls = 0
    const client = createErpcClient({
      nearRpc: { httpUrl: 'https://near.example/' },
      fetch: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(client.near.rpc.status().send({ signal: controller.signal }))
      .rejects.toBeInstanceOf(ErpcAbortedError)
    expect(calls).toBe(0)
    client.close()
  })
})
