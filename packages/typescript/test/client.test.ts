import { describe, expect, it } from 'vitest'
import {
  createErpcClient,
  ErpcBatchPolicyError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcTransportError,
  ETHEREUM_RPC_METHODS,
  ETHEREUM_SUBSCRIPTION_METHODS,
  SOLANA_ANALYTICS_METHODS,
  SOLANA_DAS_METHODS,
  SOLANA_ENHANCED_SUBSCRIPTION_METHODS,
  SOLANA_HISTORY_METHODS,
  SOLANA_LEADER_METHODS,
  SOLANA_RPC_METHODS,
} from '../src'

const rpcFetch = (
  requests: Array<{ readonly body: unknown; readonly url: string }>,
): typeof globalThis.fetch =>
  async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as
      | Record<string, unknown>[]
      | Record<string, unknown>
    requests.push({ url, body })

    const respond = (request: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id: request.id,
      result:
        request.method === 'getSlot'
          ? 123
          : request.method === 'getHealth'
            ? 'ok'
            : request.method === 'eth_chainId'
              ? url.includes('ava-rpc')
                ? '0xa86a'
                : '0x1'
              : request.params,
    })
    const response = Array.isArray(body)
      ? [...body].reverse().map(respond)
      : respond(body)
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })
  }

describe('ERPC client', () => {
  it('routes Solana, Ethereum, and Avalanche calls from one client', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    await expect(client.solana.rpc.getSlot().send()).resolves.toBe(123)
    await expect(
      client.solana.das.getAsset({ id: 'asset-id' }).send(),
    ).resolves.toEqual({ id: 'asset-id' })
    await expect(client.ethereum.rpc.eth_chainId().send()).resolves.toBe('0x1')
    await expect(client.avalanche.rpc.eth_chainId().send()).resolves.toBe(
      '0xa86a',
    )

    expect(requests).toHaveLength(4)
    expect(requests[0]?.url).toBe(
      'https://edge.erpc.global/?api-key=test-secret',
    )
    expect(requests[1]?.body).toMatchObject({
      method: 'getAsset',
      params: { id: 'asset-id' },
    })
    expect(requests[2]?.url).toBe(
      'https://edge.erpc.global/eth?api-key=test-secret',
    )
    expect(requests[3]?.url).toBe(
      'https://ava-rpc.erpc.global/ava?api-key=test-secret',
    )
    expect(client.solana.rpc.endpoint).not.toContain('test-secret')
    expect(client.ethereum.rpc.endpoint).not.toContain('test-secret')
    expect(client.avalanche.rpc.endpoint).not.toContain('test-secret')
  })

  it('restores batch results to request order', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    const result = await client.solana.rpc
      .batch([
        { method: 'getSlot', params: [] },
        { method: 'getHealth', params: [] },
      ] as const)
      .send()

    expect(result).toEqual([123, 'ok'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toHaveLength(2)
  })

  it.each([
    {
      name: 'duplicate',
      alter: (responses: readonly Record<string, unknown>[]) => [
        responses[0],
        responses[0],
      ],
      message: 'ERPC returned duplicate batch response id',
    },
    {
      name: 'missing',
      alter: (responses: readonly Record<string, unknown>[]) => [responses[0]],
      message: 'ERPC omitted batch response id',
    },
    {
      name: 'unexpected',
      alter: (responses: readonly Record<string, unknown>[]) => [
        ...responses,
        { jsonrpc: '2.0', id: 'test-secret', result: null },
      ],
      message: 'ERPC returned an unexpected batch response id',
    },
  ])('rejects $name batch response ids', async ({ alter, message }) => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async (_input, init) => {
        fetchCount += 1
        const requests = JSON.parse(String(init?.body)) as readonly Record<
          string,
          unknown
        >[]
        const responses = requests.map((request) => ({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method,
        }))
        return new Response(JSON.stringify(alter(responses)))
      },
    })

    const error = await client.solana.rpc
      .batch([
        { method: 'getSlot', params: [] },
        { method: 'getHealth', params: [] },
      ] as const)
      .send()
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ErpcInvalidResponseError)
    expect(error).toMatchObject({ code: 'ERPC_INVALID_RESPONSE' })
    expect(String(error)).toContain(message)
    expect(String(error)).not.toContain('test-secret')
    expect(fetchCount).toBe(1)
  })

  it('returns an empty batch without making a request', async () => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async () => {
        fetchCount += 1
        return new Response('[]')
      },
    })

    await expect(client.solana.rpc.batch([]).send()).resolves.toEqual([])
    expect(fetchCount).toBe(0)
  })

  it('rejects batches larger than 256 calls without making a request', async () => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async () => {
        fetchCount += 1
        return new Response('[]')
      },
    })
    const calls = Array.from({ length: 257 }, () => ({
      method: 'getSlot' as const,
      params: [] as const,
    }))

    await expect(client.solana.rpc.batch(calls).send()).rejects.toBeInstanceOf(
      ErpcInvalidResponseError,
    )
    expect(fetchCount).toBe(0)
  })

  it('rejects mixed indexed and standard Solana batches locally', () => {
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch([]),
    })

    expect(() =>
      client.solana.rpc.batch([
        { method: 'getProgramAccounts', params: ['program'] },
        { method: 'getSlot', params: [] },
      ] as const),
    ).toThrow(ErpcBatchPolicyError)
  })

  it('rejects leader batches locally', () => {
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch([]),
    })

    expect(() =>
      client.solana.leaders.batch([
        { method: 'getLeaderSlots', params: [0] },
      ] as const),
    ).toThrow(ErpcBatchPolicyError)
  })

  it('surfaces JSON-RPC errors without exposing the credential', async () => {
    const client = createErpcClient({
      apiKey: 'never-show-this',
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly id: number }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: 'Method not found for never-show-this',
              data: {
                url: 'https://edge.erpc.global/?api-key=never-show-this',
              },
            },
          }),
        )
      },
    })

    const error = await client.solana.rpc.getSlot().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(String(error)).not.toContain('never-show-this')
    expect(JSON.stringify(error.data)).not.toContain('never-show-this')
  })

  it('does not retain credential-bearing fetch errors as a cause', async () => {
    const client = createErpcClient({
      apiKey: 'never-retain-this',
      fetch: async (input) => {
        throw new Error(`Unable to fetch ${String(input)}`)
      },
    })

    const error = await client.solana.rpc.getSlot().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcTransportError)
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('never-retain-this')
  })

  it('publishes the complete current method catalogs', () => {
    expect(SOLANA_RPC_METHODS).toHaveLength(55)
    expect(SOLANA_DAS_METHODS).toHaveLength(14)
    expect(SOLANA_HISTORY_METHODS).toHaveLength(2)
    expect(SOLANA_LEADER_METHODS).toHaveLength(2)
    expect(SOLANA_ANALYTICS_METHODS).toHaveLength(5)
    expect(SOLANA_ENHANCED_SUBSCRIPTION_METHODS).toHaveLength(4)
    expect(ETHEREUM_RPC_METHODS).toHaveLength(53)
    expect(ETHEREUM_SUBSCRIPTION_METHODS).toHaveLength(2)

    const all = [
      ...SOLANA_RPC_METHODS,
      ...SOLANA_DAS_METHODS,
      ...SOLANA_HISTORY_METHODS,
      ...SOLANA_LEADER_METHODS,
      ...SOLANA_ANALYTICS_METHODS,
    ]
    expect(new Set(all)).toHaveLength(all.length)
  })
})
