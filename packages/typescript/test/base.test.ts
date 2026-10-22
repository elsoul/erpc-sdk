import { describe, expect, it } from 'vitest'
import {
  createErpcClient,
  ErpcJsonRpcError,
  ErpcNotConfiguredError,
  getTokenDeployment,
  tokens,
} from '../src'

interface CapturedCall {
  readonly body: {
    readonly id: number
    readonly method: string
    readonly params?: unknown
  }
  readonly headers: Headers
  readonly url: string
}

const createRpcFetch = (
  calls: CapturedCall[],
  result: unknown = '0x2105',
): typeof globalThis.fetch => async (input, init) => {
  const body = JSON.parse(String(init?.body)) as CapturedCall['body']
  calls.push({
    body,
    headers: new Headers(init?.headers),
    url: String(input),
  })
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: body.id,
    result:
      body.method === 'eth_chainId'
        ? result
        : body.method === 'eth_getBalance'
          ? '0x0'
          : '0x53ec60',
  }), { headers: { 'content-type': 'application/json' } })
}

const BASE_WALLET = '0x7A5837f5bB52C53e08fcFf214c2Cd11daa8EF9EE'
const BASE_EURC = '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'
const BASE_PINNED_BLOCK = '0x3167564'
const ERC20_BALANCE_OF = '0x70a08231'
const BALANCE_OF_CALLDATA = `${ERC20_BALANCE_OF}${BASE_WALLET.slice(2).padStart(64, '0')}`

describe('Base read-only facade', () => {
  it('routes API-key calls to the default Base root endpoint', async () => {
    const calls: CapturedCall[] = []
    const client = createErpcClient({
      apiKey: 'base-api-key',
      headers: { 'x-global': 'legacy-header' },
      fetch: createRpcFetch(calls),
    })

    expect(Object.keys(client.base)).toEqual(['rpc'])
    expect(Object.keys(client.base.rpc).sort()).toEqual([
      'endpoint',
      'eth_call',
      'eth_chainId',
      'eth_getBalance',
    ])
    expect(client.base.rpc.endpoint).toBe('https://base.erpc.global/')
    await expect(client.base.rpc.eth_chainId().send()).resolves.toBe('0x2105')
    await expect(
      client.base.rpc.eth_getBalance(
        BASE_WALLET,
        BASE_PINNED_BLOCK,
      ).send(),
    ).resolves.toBe('0x0')
    await expect(client.base.rpc.eth_call(
      {
        to: BASE_EURC,
        data: BALANCE_OF_CALLDATA,
      },
      BASE_PINNED_BLOCK,
    ).send()).resolves.toBe('0x53ec60')

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.url).toBe('https://base.erpc.global/?api-key=base-api-key')
      expect(call.headers.get('x-global')).toBe('legacy-header')
      expect(call.headers.get('content-type')).toBe('application/json')
    }
    expect(calls.map(({ body }) => body.method)).toEqual([
      'eth_chainId',
      'eth_getBalance',
      'eth_call',
    ])
    expect(calls[1]?.body.params).toEqual([
      BASE_WALLET,
      BASE_PINNED_BLOCK,
    ])
    expect(calls[2]?.body.params).toEqual([
      {
        to: BASE_EURC,
        data: BALANCE_OF_CALLDATA,
      },
      BASE_PINNED_BLOCK,
    ])

    const eurcDeployment = getTokenDeployment(tokens.base.EURC)
    expect(eurcDeployment).toMatchObject({
      symbol: 'EURC',
      decimals: 6,
      address: BASE_EURC,
    })
    const rawBalance = BigInt('0x53ec60')
    expect(rawBalance).toBe(5_500_000n)
    expect(Number(rawBalance) / 10 ** (eurcDeployment?.decimals ?? 0)).toBe(5.5)
    client.close()
  })

  it('supports an authenticated baseEndpoint override without adding /base', async () => {
    const calls: CapturedCall[] = []
    const client = createErpcClient({
      apiKey: 'override-key',
      baseEndpoint: 'https://customer.example/rpc/base/?region=eu#ignored',
      fetch: createRpcFetch(calls),
    })

    await expect(client.base.rpc.eth_chainId().send()).resolves.toBe('0x2105')
    expect(calls[0]?.url).toBe(
      'https://customer.example/rpc/base?api-key=override-key',
    )
    client.close()
  })

  it('gives a direct Base RPC URL and headers precedence over legacy credentials', async () => {
    const calls: CapturedCall[] = []
    const directUrl =
      'https://node.example/customer/path?token=a%2Fb&region=eu'
    const client = createErpcClient({
      apiKey: 'legacy-key',
      baseEndpoint: 'https://legacy.example/should-not-be-used',
      baseRpc: {
        httpUrl: directUrl,
        headers: {
          authorization: 'Bearer direct-secret',
          'x-base-scope': 'base-only',
        },
      },
      headers: {
        authorization: 'Bearer global-secret',
        'x-global': 'must-not-be-forwarded',
      },
      fetch: createRpcFetch(calls),
    })

    await expect(client.base.rpc.eth_chainId().send()).resolves.toBe('0x2105')
    expect(calls[0]?.url).toBe(directUrl)
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer direct-secret')
    expect(calls[0]?.headers.get('x-base-scope')).toBe('base-only')
    expect(calls[0]?.headers.get('x-global')).toBeNull()
    client.close()
  })

  it('keeps direct legacy chains usable and fails an unconfigured Base call before fetch', async () => {
    let fetchCount = 0
    const client = createErpcClient({
      ethereumRpc: { httpUrl: 'https://ethereum.example/rpc' },
      fetch: async () => {
        fetchCount += 1
        return new Response('{}')
      },
    })

    const error = await client.base.rpc.eth_chainId().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcNotConfiguredError)
    expect(error).toMatchObject({
      code: 'ERPC_NOT_CONFIGURED',
      namespace: 'base',
    })
    expect(fetchCount).toBe(0)
    client.close()
  })

  it('redacts direct Base URL and header credentials from JSON-RPC errors', async () => {
    const client = createErpcClient({
      baseRpc: {
        httpUrl: 'https://node.example/rpc?token=base%2Fsecret',
        headers: { authorization: 'Bearer base-header-secret' },
      },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { readonly id: number }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32000,
            message: 'base%2fsecret base-header-secret',
            data: {
              url: 'https://node.example/rpc?token=base%2Fsecret',
              authorization: 'Bearer base-header-secret',
            },
          },
        }))
      },
    })

    const error = await client.base.rpc.eth_chainId().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(String(error)).not.toContain('base%2fsecret')
    expect(String(error)).not.toContain('base-header-secret')
    expect(JSON.stringify(error)).not.toContain('base-header-secret')
    client.close()
  })

  it('redacts encoded, decoded, and mixed-escape path credentials while preserving the request URL', async () => {
    const encodedPath = 'gate%2Ffake-path-key'
    const decodedPath = 'gate/fake-path-key'
    const mixedEscapePath = 'gate%2ffake-path-key'
    const directUrl = `https://node.example/customer/${encodedPath}?region=eu`
    let capturedUrl = ''
    const client = createErpcClient({
      baseRpc: { httpUrl: directUrl },
      fetch: async (input, init) => {
        capturedUrl = String(input)
        const body = JSON.parse(String(init?.body)) as { readonly id: number }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32000,
            message: [encodedPath, decodedPath, mixedEscapePath].join(' | '),
            data: {
              url: directUrl,
              [encodedPath]: decodedPath,
              nested: { [decodedPath]: mixedEscapePath },
            },
          },
        }))
      },
    })

    const error = await client.base.rpc.eth_chainId().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(capturedUrl).toBe(directUrl)
    expect(client.base.rpc.endpoint).toBe('https://node.example/')
    expect(client.base.rpc.endpoint).not.toContain(encodedPath)
    expect(String(error)).not.toContain(encodedPath)
    expect(String(error)).not.toContain(decodedPath)
    expect(String(error)).not.toContain(mixedEscapePath)
    expect((error as ErpcJsonRpcError).message).not.toContain(encodedPath)
    expect((error as ErpcJsonRpcError).message).not.toContain(decodedPath)
    expect((error as ErpcJsonRpcError).message).not.toContain(mixedEscapePath)
    const data = JSON.stringify((error as ErpcJsonRpcError).data)
    expect(data).not.toContain(encodedPath)
    expect(data).not.toContain(decodedPath)
    expect(data).not.toContain(mixedEscapePath)
    client.close()
  })
})
