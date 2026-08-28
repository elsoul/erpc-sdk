import { describe, expect, it } from 'vitest'
import {
  createErpcCloudClient,
  createErpcClient,
  ErpcAbortedError,
  ErpcTransportError,
} from '../src'

describe('REST APIs', () => {
  it('rejects plaintext remote Cloud endpoints', () => {
    expect(() => createErpcCloudClient({
      accessToken: 'oauth-access-token',
      endpoint: 'http://user.example',
    })).toThrow('must use HTTPS except on localhost')
  })

  it('uses an OAuth access token only for the Cloud client', async () => {
    let capturedAuthorization = ''
    const cloud = createErpcCloudClient({
      accessToken: 'oauth-access-token',
      fetch: async (_input, init) => {
        capturedAuthorization =
          new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify({
          success: true,
          message: {
            yearMonth: '2026-08',
            totalCount: 0,
            totalCredits: 0,
            updatedAt: null,
            keyCount: 0,
            hasStrandedUsage: false,
            chains: [],
            apiKeys: [],
          },
        }))
      },
    })

    await cloud.usage.getMonthlyApiKeyUsage()

    expect(capturedAuthorization).toBe('Bearer oauth-access-token')
    expect(Object.keys(cloud)).toEqual([
      'catalog',
      'credit',
      'resources',
      'usage',
    ])
  })

  it('reads only the credential-free Cloud resource projection', async () => {
    let capturedUrl = ''
    let capturedAuthorization = ''
    const cloud = createErpcCloudClient({
      accessToken: 'oauth-access-token',
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedAuthorization =
          new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify({
          success: true,
          message: {
            resources: [{
              id: 'vps_123',
              kind: 'vps',
              status: 'active',
              region: 'frankfurt',
              billing: { status: 'active', hourlyCredits: 10 },
              username: 'must-not-leave-the-client',
              password: 'must-not-leave-the-client',
            }],
          },
        }))
      },
    })

    await expect(cloud.resources.list()).resolves.toEqual([{
      id: 'vps_123',
      kind: 'vps',
      status: 'active',
      region: 'frankfurt',
    }])
    expect(capturedUrl).toBe(
      'https://user-api.erpc.global/v4/cloud/resources',
    )
    expect(capturedAuthorization).toBe('Bearer oauth-access-token')
  })

  it('encodes resource IDs and drops unexpected get-response fields', async () => {
    let capturedUrl = ''
    const cloud = createErpcCloudClient({
      accessToken: 'oauth-access-token',
      fetch: async (input) => {
        capturedUrl = String(input)
        return new Response(JSON.stringify({
          success: true,
          message: {
            resource: {
              id: 'vps/example',
              kind: 'vps',
              status: 'active',
              host: 'must-not-leave-the-client',
            },
          },
        }))
      },
    })

    await expect(cloud.resources.get(' vps/example ')).resolves.toEqual({
      id: 'vps/example',
      kind: 'vps',
      status: 'active',
    })
    expect(capturedUrl).toBe(
      'https://user-api.erpc.global/v4/cloud/resources/vps%2Fexample',
    )
  })

  it('projects the capability catalog without internal or pricing fields', async () => {
    const cloud = createErpcCloudClient({
      accessToken: 'oauth-access-token',
      fetch: async () => new Response(JSON.stringify({
        success: true,
        message: {
          offerings: [{
            id: 'vps',
            kind: 'vps',
            mode: 'shared',
            name: 'Virtual server',
            description: 'General compute',
            regions: [],
            capabilities: ['node', 'deno'],
            compute: { tenancy: 'virtual-machine' },
            provider: 'must-not-leave-the-client',
            priceCents: 100,
          }],
        },
      })),
    })

    await expect(cloud.catalog.list()).resolves.toEqual([{
      id: 'vps',
      kind: 'vps',
      mode: 'shared',
      name: 'Virtual server',
      description: 'General compute',
      regions: [],
      capabilities: ['node', 'deno'],
      compute: { tenancy: 'virtual-machine' },
    }])
  })

  it('projects credit and resource status snapshots', async () => {
    const cloud = createErpcCloudClient({
      accessToken: 'oauth-access-token',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/status')) {
          return new Response(JSON.stringify({
            success: true,
            message: {
              id: 'vps_123',
              status: 'active',
              billing: {
                status: 'active',
                hourlyCredits: 10,
                nextChargeAt: '2026-08-28T15:00:00.000Z',
                password: 'must-not-leave-the-client',
              },
              host: 'must-not-leave-the-client',
            },
          }))
        }
        return new Response(JSON.stringify({
          success: true,
          message: {
            balanceCents: 5000,
            burnRateCentsPerHour: 100,
            timeToZeroHours: 50,
            alertLevel: 'normal',
            quoteTimestamp: '2026-08-28T14:00:00.000Z',
            quoteExpiresAt: '2026-08-28T14:05:00.000Z',
            internalLedgerId: 'must-not-leave-the-client',
          },
        }))
      },
    })

    await expect(cloud.credit.get()).resolves.toEqual({
      balanceCents: 5000,
      burnRateCentsPerHour: 100,
      timeToZeroHours: 50,
      alertLevel: 'normal',
      quoteTimestamp: '2026-08-28T14:00:00.000Z',
      quoteExpiresAt: '2026-08-28T14:05:00.000Z',
    })
    await expect(cloud.resources.getStatus('vps_123')).resolves.toEqual({
      id: 'vps_123',
      status: 'active',
      billing: {
        status: 'active',
        hourlyCredits: 10,
        nextChargeAt: '2026-08-28T15:00:00.000Z',
      },
    })
  })

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

  it('reads masked monthly usage from the user API origin', async () => {
    let capturedUrl = ''
    let capturedAuthorization = ''
    const client = createErpcClient({
      apiKey: 'usage-secret',
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedAuthorization =
          new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify({
          success: true,
          message: {
            yearMonth: '2026-08',
            totalCount: 12,
            totalCredits: 3,
            updatedAt: '2026-08-28T00:00:00.000Z',
            keyCount: 1,
            hasStrandedUsage: false,
            chains: [],
            apiKeys: [{
              keyId: 7,
              apiKeyLast4: 'cdef',
              apiKeyLength: 32,
              count: 12,
              credits: 3,
              updatedAt: '2026-08-28T00:00:00.000Z',
              chains: [],
              apiKey: 'must-not-leave-the-client',
            }],
          },
        }))
      },
    })

    const usage = await client.usage.getMonthlyApiKeyUsage({
      yearMonth: '2026-08',
    })

    expect(usage.apiKeys[0]?.apiKeyLast4).toBe('cdef')
    expect(usage.apiKeys[0]).not.toHaveProperty('apiKey')
    expect(capturedUrl).toBe(
      'https://user-api.erpc.global/v3/user/api-keys/usage?yearMonth=2026-08',
    )
    expect(capturedAuthorization).toBe('Bearer usage-secret')
    expect(capturedUrl).not.toContain('usage-secret')
  })

  it('rejects an invalid monthly usage calendar month locally', async () => {
    const client = createErpcClient({
      apiKey: 'usage-secret',
      fetch: async () => new Response('{}'),
    })

    await expect(
      client.usage.getMonthlyApiKeyUsage({ yearMonth: '2026-13' }),
    ).rejects.toThrow('yearMonth must use YYYY-MM format')
  })
})
