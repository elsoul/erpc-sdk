import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeError,
  createErpcCloudClient,
  createErpcClient,
  createMayanSwiftV2BridgeClient,
  ErpcConfigError,
} from '../src'

interface FetchCall {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

interface FetchInvocation {
  readonly path: string
  readonly receiver: unknown
}

type FetchMode = 'permissive' | 'strict'

const response = (body: unknown): Response => new Response(
  JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json' } },
)

const headersOf = (value: HeadersInit | undefined): Record<string, string> =>
  Object.fromEntries(
    [...new Headers(value).entries()].map(([name, header]) => [name.toLowerCase(), header]),
  )

const createFetch = (
  mode: FetchMode,
  calls: FetchCall[],
  invocations: FetchInvocation[],
): typeof globalThis.fetch => {
  const route = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({
      method,
      url: url.toString(),
      headers: headersOf(init?.headers),
      body,
    })

    if (method === 'POST' && ['/','/eth','/ava'].includes(url.pathname)) {
      const request = JSON.parse(body ?? '{}') as { id: number }
      return response({
        jsonrpc: '2.0',
        id: request.id,
        result: url.pathname === '/' ? 123 : '0x1',
      })
    }

    if (method === 'GET' && url.pathname === '/v3/erpc/token-balance') {
      return response({
        plan: 'developer',
        max_tokens: 100,
        remaining_tokens: 80,
        next_refill_at: null,
      })
    }

    if (method === 'GET' && url.pathname === '/v3/user/api-keys/usage') {
      return response({
        success: true,
        message: {
          yearMonth: '2026-09',
          totalCount: 3,
          totalCredits: 4,
          updatedAt: null,
          keyCount: 1,
          hasStrandedUsage: false,
          chains: [],
          apiKeys: [],
        },
      })
    }

    if (method === 'GET' && url.pathname.startsWith('/v3/swap/trx/')) {
      return response({ clientStatus: 'INPROGRESS', status: 'pending' })
    }

    throw new Error(`Unexpected test request: ${method} ${url.toString()}`)
  }

  if (mode === 'permissive') {
    return function permissiveFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      invocations.push({
        path: new URL(String(input)).pathname,
        receiver: this,
      })
      return Promise.resolve(route(input, init))
    }
  }

  return function strictFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const path = new URL(String(input)).pathname
    invocations.push({ path, receiver: this })
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('strict fetch receiver')
    }
    return Promise.resolve(route(input, init))
  }
}

const runMatrix = async (mode: FetchMode, explicit: boolean) => {
  const calls: FetchCall[] = []
  const invocations: FetchInvocation[] = []
  const fetch = createFetch(mode, calls, invocations)
  vi.stubGlobal('fetch', fetch)

  const coreConfig = {
    apiKey: 'core-secret',
    endpoint: 'https://rpc.example.test',
    avalancheEndpoint: 'https://ava.example.test',
    accountEndpoint: 'https://account.example.test',
    userEndpoint: 'https://user.example.test',
    ...(explicit ? { fetch: globalThis.fetch } : {}),
  }
  const client = createErpcClient(coreConfig)
  const cloud = createErpcCloudClient({
    accessToken: 'oauth-secret',
    endpoint: 'https://cloud.example.test',
    ...(explicit ? { fetch: globalThis.fetch } : {}),
  })
  const bridge = createMayanSwiftV2BridgeClient({
    explorerEndpoint: 'https://mayan.example.test/v3',
    ...(explicit ? { fetch: globalThis.fetch } : {}),
  })

  try {
    const outcomes = await Promise.allSettled([
      client.solana.rpc.getSlot().send(),
      client.ethereum.rpc.eth_chainId().send(),
      client.avalanche.rpc.eth_chainId().send(),
      client.account.getTokenBalance(),
      cloud.usage.getMonthlyApiKeyUsage(),
      bridge.getStatus({
        sourceChainId: 'eip155:1',
        sourceTransactionHash: `0x${'a'.repeat(64)}`,
      }),
    ])

    return { calls, invocations, outcomes }
  } finally {
    bridge.close()
    client.close()
  }
}

const expectSuccessfulMatrix = (
  result: Awaited<ReturnType<typeof runMatrix>>,
): void => {
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ])
  const values = result.outcomes.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value : undefined)
  expect(values).toEqual([
    123,
    '0x1',
    '0x1',
    expect.objectContaining({ remaining_tokens: 80 }),
    expect.objectContaining({ yearMonth: '2026-09', totalCount: 3 }),
    expect.objectContaining({
      state: 'in-progress',
      sourceChainId: 'eip155:1',
      sourceTransactionHash: `0x${'a'.repeat(64)}`,
    }),
  ])
}

const expectRequestMatrix = (
  result: Awaited<ReturnType<typeof runMatrix>>,
): void => {
  expect(result.invocations).toHaveLength(6)
  expect(result.calls).toHaveLength(6)
  expect(result.calls.map((call) => call.method)).toEqual([
    'POST',
    'POST',
    'POST',
    'GET',
    'GET',
    'GET',
  ])
  expect(result.calls.map((call) => call.url)).toEqual([
    'https://rpc.example.test/?api-key=core-secret',
    'https://rpc.example.test/eth?api-key=core-secret',
    'https://ava.example.test/ava?api-key=core-secret',
    'https://account.example.test/v3/erpc/token-balance',
    'https://cloud.example.test/v3/user/api-keys/usage',
    'https://mayan.example.test/v3/swap/trx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])
  expect(result.calls[0]?.headers.authorization).toBeUndefined()
  expect(result.calls[3]?.headers.authorization).toBe('Bearer core-secret')
  expect(result.calls[4]?.headers.authorization).toBe('Bearer oauth-secret')
  expect(result.calls[5]?.headers.authorization).toBeUndefined()
}

describe('receiver-neutral fetch invocation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('passes default fetch through every core, REST, Cloud, and Mayan path', async () => {
    const result = await runMatrix('strict', false)
    expectSuccessfulMatrix(result)
    expectRequestMatrix(result)
  })

  it('passes an exact explicit globalThis.fetch through every path', async () => {
    const result = await runMatrix('strict', true)
    expectSuccessfulMatrix(result)
    expectRequestMatrix(result)
  })

  it('keeps permissive default and explicit controls successful', async () => {
    const defaultResult = await runMatrix('permissive', false)
    const explicitResult = await runMatrix('permissive', true)
    expectSuccessfulMatrix(defaultResult)
    expectRequestMatrix(defaultResult)
    expectSuccessfulMatrix(explicitResult)
    expectRequestMatrix(explicitResult)
  })

  it('preserves missing and non-callable fetch validation', () => {
    vi.stubGlobal('fetch', undefined)
    expect(() => createErpcClient({ apiKey: 'core-secret' })).toThrow(
      new ErpcConfigError('A Fetch API implementation is required in this runtime'),
    )
    expect(() => createErpcCloudClient({
      accessToken: 'oauth-secret',
    })).toThrow(
      new ErpcConfigError('A Fetch API implementation is required in this runtime'),
    )
    expect(() => createMayanSwiftV2BridgeClient()).toThrow(
      expect.objectContaining({
        code: 'BRIDGE_INVALID_ARGUMENT',
        message: 'Bridge request is invalid',
      }) satisfies Partial<BridgeError>,
    )

    const invalidFetch = 0 as unknown as typeof globalThis.fetch
    expect(() => createErpcClient({ apiKey: 'core-secret', fetch: invalidFetch })).toThrow(
      new ErpcConfigError('A Fetch API implementation is required in this runtime'),
    )
    expect(() => createErpcCloudClient({
      accessToken: 'oauth-secret',
      fetch: invalidFetch,
    })).toThrow(
      new ErpcConfigError('A Fetch API implementation is required in this runtime'),
    )
    expect(() => createMayanSwiftV2BridgeClient({ fetch: invalidFetch })).toThrow(
      expect.objectContaining({
        code: 'BRIDGE_INVALID_ARGUMENT',
        message: 'Bridge request is invalid',
      }) satisfies Partial<BridgeError>,
    )
  })
})
