import { describe, expect, it } from 'vitest'
import {
  createErpcClient,
  ErpcAbortedError,
  ErpcTransportError,
} from '../src'

describe('REST APIs', () => {
  it('uses bearer authentication and the correct Price API query shape', async () => {
    let capturedUrl = ''
    let capturedAuthorization = ''
    const client = createErpcClient({
      apiKey: 'price-secret',
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(
          JSON.stringify({
            binary: { encoding: 'hex', data: [] },
            parsed: [],
          }),
        )
      },
    })

    await client.price.getLatestPriceUpdates({
      ids: ['feed-a', 'feed-b'],
      encoding: 'hex',
      parsed: true,
    })

    const url = new URL(capturedUrl)
    expect(url.pathname).toBe('/v2/updates/price/latest')
    expect(url.searchParams.getAll('ids[]')).toEqual(['feed-a', 'feed-b'])
    expect(url.searchParams.get('parsed')).toBe('true')
    expect(capturedAuthorization).toBe('Bearer price-secret')
    expect(capturedUrl).not.toContain('price-secret')
  })

  it('parses server-sent price events', async () => {
    const stream = [
      ': keepalive',
      'event: price_update',
      'id: 7',
      'data: {"binary":{"encoding":"hex","data":["abc"]}}',
      '',
      '',
    ].join('\n')
    const client = createErpcClient({
      apiKey: 'stream-secret',
      fetch: async () =>
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    })

    const events = []
    for await (const event of client.price.streamPriceUpdates({
      ids: ['feed-a'],
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        event: 'price_update',
        id: '7',
        data: { binary: { encoding: 'hex', data: ['abc'] } },
      },
    ])
  })

  it('cancels the response body when a stream consumer stops early', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const client = createErpcClient({
      apiKey: 'stream-secret',
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"binary":{"encoding":"hex","data":[]}}\n\n',
                ),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })

    for await (const _event of client.price.streamPriceUpdates({
      ids: ['feed-a'],
    })) {
      break
    }

    expect(cancelled).toBe(true)
  })

  it('keeps the abort signal attached while reading a REST body', async () => {
    const controller = new AbortController()
    let responseStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve
    })
    const client = createErpcClient({
      apiKey: 'abort-secret',
      fetch: async (_input, init) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream({
            start(streamController) {
              const fallback = setTimeout(() => streamController.close(), 100)
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(fallback)
                  streamController.error(new DOMException('Aborted', 'AbortError'))
                },
                { once: true },
              )
              responseStarted?.()
            },
          }),
        )
      },
    })

    const request = client.price.getPriceFeeds({}, { signal: controller.signal })
    await started
    controller.abort()

    await expect(request).rejects.toBeInstanceOf(ErpcAbortedError)
  })

  it('does not retain authorization headers in REST transport errors', async () => {
    const client = createErpcClient({
      apiKey: 'never-retain-this',
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get('authorization')
        throw new Error(`Request failed with ${authorization}`)
      },
    })

    const error = await client.price.getPriceFeeds().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcTransportError)
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('never-retain-this')
  })

  it('uses the account API origin for token balance', async () => {
    let capturedUrl = ''
    const client = createErpcClient({
      apiKey: 'account-secret',
      fetch: async (input) => {
        capturedUrl = String(input)
        return new Response(
          JSON.stringify({
            plan: 'developer',
            max_tokens: 100,
            remaining_tokens: 80,
            next_refill_at: null,
          }),
        )
      },
    })

    await expect(client.account.getTokenBalance()).resolves.toMatchObject({
      remaining_tokens: 80,
    })
    expect(capturedUrl).toBe(
      'https://solana-rpc.erpc.global/v3/erpc/token-balance',
    )
  })
})
