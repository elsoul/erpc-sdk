import { describe, expect, it } from 'vitest'
import {
  ErpcAbortedError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
} from '../src'
import {
  BITCOIN_RESPONSE_LIMITS,
  BitcoinJsonNumber,
  type BitcoinJsonValue,
} from '../src/rpc/bitcoin_codec'
import {
  createBitcoinClient,
  type BitcoinRpcTransport,
} from '../src/rpc/bitcoin'
import { BitcoinHttpTransport } from '../src/transport/bitcoin_http'

interface CapturedRequest {
  readonly body: {
    readonly id: number
    readonly method: string
    readonly params?: unknown
  }
  readonly headers: Headers
  readonly init: RequestInit
  readonly url: string
}

const responseFor = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })

const streamResponse = (chunks: readonly Uint8Array[]): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), { headers: { 'content-type': 'application/json' } })

const capturedFetch = (
  calls: CapturedRequest[],
  response: (request: CapturedRequest['body']) => Response,
): typeof globalThis.fetch => async (input, init) => {
  const body = JSON.parse(String(init?.body)) as CapturedRequest['body']
  const request: CapturedRequest = {
    body,
    headers: new Headers(init?.headers),
    init: init ?? {},
    url: String(input),
  }
  calls.push(request)
  return response(body)
}

describe('Bitcoin streamed transport and named facade', () => {
  it('uses the hosted /bitcoin target and Bearer auth without an api-key query', async () => {
    const calls: CapturedRequest[] = []
    const transport = new BitcoinHttpTransport({
      apiKey: 'bitcoin-secret',
      endpoint: new URL('https://edge.erpc.global'),
      fetch: capturedFetch(calls, (request) =>
        responseFor({ jsonrpc: '2.0', id: request.id, error: null, result: 'hash' }),
      ),
      headers: {
        Authorization: 'Basic old-secret',
        'x-global': 'global-header',
      },
      timeoutMs: 1_000,
    })

    const client = createBitcoinClient(transport)
    await expect(client.rpc.getBestBlockHash().send()).resolves.toBe('hash')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://edge.erpc.global/bitcoin')
    expect(calls[0]?.url).not.toContain('api-key')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer bitcoin-secret')
    expect(calls[0]?.headers.get('x-global')).toBe('global-header')
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.credentials).toBe('omit')
    expect(calls[0]?.body).toMatchObject({
      method: 'getbestblockhash',
      params: [],
    })
  })

  it('preserves an exact direct target and sends only scoped headers', async () => {
    const calls: CapturedRequest[] = []
    const directUrl = 'https://node.example/rpc?token=a%2Fb&region=eu'
    const transport = new BitcoinHttpTransport({
      apiKey: 'legacy-secret',
      direct: true,
      endpoint: new URL(directUrl),
      fetch: capturedFetch(calls, (request) =>
        responseFor({ jsonrpc: '2.0', id: request.id, result: '0x01' }),
      ),
      headers: {
        authorization: 'Bearer direct-secret',
        'x-bitcoin-scope': 'bitcoin-only',
      },
      timeoutMs: 1_000,
    })

    await expect(transport.request('getbestblockhash', [])).resolves.toBe('0x01')
    expect(calls[0]?.url).toBe(directUrl)
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer direct-secret')
    expect(calls[0]?.headers.get('x-bitcoin-scope')).toBe('bitcoin-only')
    expect(calls[0]?.headers.get('x-global')).toBeNull()
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.credentials).toBe('omit')
    expect(transport.endpoint).toBe('https://node.example/')
  })

  it('reads chunked UTF-8 data and rejects a body over the bound before parsing', async () => {
    let cancelled = false
    const transport = new BitcoinHttpTransport({
      direct: true,
      endpoint: new URL('https://node.example/rpc'),
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly id: number }
        const body = new TextEncoder().encode(
          `{"jsonrpc":"2.0","id":${request.id},"result":"✓"}`,
        )
        return streamResponse([body.slice(0, 34), body.slice(34)])
      },
      headers: {},
      timeoutMs: 1_000,
    })
    await expect(transport.request('getblockchaininfo', [])).resolves.toBe('✓')

    let invalidUtf8Cancelled = 0
    const invalidUtf8Body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]))
      },
      cancel() {
        invalidUtf8Cancelled += 1
      },
    })
    const invalidUtf8Transport = new BitcoinHttpTransport({
      direct: true,
      endpoint: new URL('https://node.example/rpc'),
      fetch: async () => new Response(invalidUtf8Body),
      headers: {},
      timeoutMs: 1_000,
    })
    await expect(invalidUtf8Transport.request('getblockchaininfo', [])).rejects.toBeInstanceOf(
      ErpcInvalidResponseError,
    )
    expect(invalidUtf8Cancelled).toBe(1)

    const nativeFailure = new BitcoinHttpTransport({
      direct: true,
      endpoint: new URL('https://node.example/rpc'),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('native body read failed'))
        },
      })),
      headers: {},
      timeoutMs: 1_000,
    })
    await expect(nativeFailure.request('getblockchaininfo', [])).rejects.toBeInstanceOf(
      ErpcTransportError,
    )

    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue({
          byteLength: BITCOIN_RESPONSE_LIMITS.maxBodyBytes + 1,
        } as unknown as Uint8Array)
      },
      cancel() {
        cancelled = true
      },
    })
    const boundedTransport = new BitcoinHttpTransport({
      direct: true,
      endpoint: new URL('https://node.example/rpc'),
      fetch: async () => new Response(oversized),
      headers: {},
      timeoutMs: 1_000,
    })
    await expect(boundedTransport.request('getblockchaininfo', [])).rejects.toBeInstanceOf(
      ErpcInvalidResponseError,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
  })

  it('keeps one total deadline and caller cancellation active during body reads', async () => {
    const hangingBody = () => new ReadableStream<Uint8Array>({})
    const timeoutTransport = new BitcoinHttpTransport({
      apiKey: 'key',
      endpoint: new URL('https://edge.erpc.global'),
      fetch: async () => new Response(hangingBody()),
      headers: {},
      timeoutMs: 5,
    })
    await expect(timeoutTransport.request('getnetworkinfo', [])).rejects.toBeInstanceOf(
      ErpcTimeoutError,
    )

    const controller = new AbortController()
    const abortedTransport = new BitcoinHttpTransport({
      apiKey: 'key',
      endpoint: new URL('https://edge.erpc.global'),
      fetch: async () => new Response(hangingBody()),
      headers: {},
      timeoutMs: 1_000,
    })
    const pending = abortedTransport.request('getnetworkinfo', [], {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ErpcAbortedError)

    let preAbortedCalls = 0
    const preAbortedTransport = new BitcoinHttpTransport({
      direct: true,
      endpoint: new URL('https://node.example/rpc'),
      fetch: async () => {
        preAbortedCalls += 1
        return responseFor({ jsonrpc: '2.0', id: 1, result: 'hash' })
      },
      headers: {},
      timeoutMs: 1_000,
    })
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(preAbortedTransport.request('getbestblockhash', [], {
      signal: preAborted.signal,
    })).rejects.toBeInstanceOf(ErpcAbortedError)
    expect(preAbortedCalls).toBe(0)
  })

  it('retains exact numeric error data while redacting credentials', async () => {
    const transport = new BitcoinHttpTransport({
      apiKey: 'rpc-secret',
      endpoint: new URL('https://edge.erpc.global'),
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly id: number }
        return new Response(
          `{"jsonrpc":"2.0","id":${request.id},"error":{"code":-32000,"message":"rpc-secret failed","data":{"credential":"rpc-secret","precise":1e1000}}}`,
          { headers: { 'content-type': 'application/json' } },
        )
      },
      headers: {},
      timeoutMs: 1_000,
    })

    const error = await transport
      .request('getnetworkinfo', [])
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(error).toMatchObject({
      code: 'ERPC_RPC',
      rpcCode: -32000,
    })
    expect(String(error)).not.toContain('rpc-secret')
    expect(error).toMatchObject({
      data: {
        credential: '[REDACTED]',
        precise: expect.objectContaining({ value: '1e1000' }),
      },
    })
  })

  it('exposes only the twelve named reads and preserves wire params', async () => {
    const calls: Array<{ readonly method: string; readonly params: readonly unknown[] }> = []
    const transport: BitcoinRpcTransport = {
      endpoint: 'https://node.example/',
      request: async <TResult extends BitcoinJsonValue>(
        method: string,
        params?: readonly unknown[],
      ): Promise<TResult> => {
        calls.push({ method, params: params ?? [] })
        const value: BitcoinJsonValue =
          method === 'getbestblockhash' || method === 'getblockhash'
            ? 'hash'
            : method === 'getblockcount'
              ? new BitcoinJsonNumber('7')
              : method === 'gettxout'
                ? null
                : { method }
        return value as TResult
      },
    }
    const rpc = createBitcoinClient(transport).rpc

    expect(Object.keys(rpc).sort()).toEqual([
      'endpoint',
      'estimateSmartFee',
      'getBestBlockHash',
      'getBlock',
      'getBlockCount',
      'getBlockHash',
      'getBlockHeader',
      'getBlockchainInfo',
      'getMempoolInfo',
      'getNetworkInfo',
      'getRawMempool',
      'getRawTransaction',
      'getTxOut',
    ].sort())
    expect('raw' in rpc).toBe(false)
    expect('request' in rpc).toBe(false)
    expect('batch' in rpc).toBe(false)
    expect('subscribe' in rpc).toBe(false)

    await rpc.estimateSmartFee(6, 'ECONOMICAL').send()
    await rpc.getBestBlockHash().send()
    await rpc.getBlock('block-hash', 2).send()
    await rpc.getBlockchainInfo().send()
    await expect(rpc.getBlockCount().send()).resolves.toBe(7n)
    await rpc.getBlockHash(7).send()
    await rpc.getBlockHeader('block-hash', true).send()
    await rpc.getMempoolInfo().send()
    await rpc.getNetworkInfo().send()
    await rpc.getRawMempool(true).send()
    await rpc.getRawTransaction('tx-id', true, 'block-hash').send()
    await rpc.getTxOut('tx-id', 0, true).send()

    expect(calls).toEqual([
      { method: 'estimatesmartfee', params: [6, 'ECONOMICAL'] },
      { method: 'getbestblockhash', params: [] },
      { method: 'getblock', params: ['block-hash', 2] },
      { method: 'getblockchaininfo', params: [] },
      { method: 'getblockcount', params: [] },
      { method: 'getblockhash', params: [7] },
      { method: 'getblockheader', params: ['block-hash', true] },
      { method: 'getmempoolinfo', params: [] },
      { method: 'getnetworkinfo', params: [] },
      { method: 'getrawmempool', params: [true] },
      { method: 'getrawtransaction', params: ['tx-id', true, 'block-hash'] },
      { method: 'gettxout', params: ['tx-id', 0, true] },
    ])
  })

  it('maps HTTP and unconfigured failures to stable categories', async () => {
    const httpTransport = new BitcoinHttpTransport({
      apiKey: 'key',
      endpoint: new URL('https://edge.erpc.global'),
      fetch: async () => new Response('', { status: 503 }),
      headers: {},
      timeoutMs: 1_000,
    })
    await expect(httpTransport.request('getnetworkinfo', [])).rejects.toBeInstanceOf(
      ErpcHttpError,
    )

    const unavailable = new BitcoinHttpTransport({
      endpoint: new URL('https://unconfigured.invalid/bitcoin'),
      fetch: async () => {
        throw new Error('should not be called')
      },
      headers: {},
      timeoutMs: 1_000,
      unavailableNamespace: 'bitcoin.rpc',
    })
    await expect(unavailable.request('getnetworkinfo', [])).rejects.toBeInstanceOf(
      ErpcNotConfiguredError,
    )
  })
})
