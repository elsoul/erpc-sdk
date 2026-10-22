import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
type SwapSdk = typeof import('../src')

const swapSdk: SwapSdk = process.env.ERPC_SDK_SWAP_EXECUTION_PARITY_PACKAGE === 'dist'
  ? await import(new URL('../dist/index.js', import.meta.url).href) as SwapSdk
  : await import('../src')

const {
  SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
  SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
  SwapExecutionError,
  SwapQuoteError,
  createErpcClient,
  DEX_CATALOG_CONTENT_DIGEST,
  TOKEN_CATALOG_CONTENT_DIGEST,
} = swapSdk

interface RpcRequest {
  readonly id: number
  readonly method: string
  readonly params?: readonly unknown[]
}

interface FixtureCase {
  readonly caseId: string
  readonly method: 'prepare' | 'simulate'
  readonly quoteCaseId: string
  readonly request: Record<string, unknown>
  readonly nowSeconds: number
  readonly rpcResponses: readonly unknown[]
  readonly rpcTrace: readonly Record<string, unknown>[]
  readonly outcome: Record<string, unknown>
  readonly mutation?: string
}

interface Fixture {
  readonly schemaVersion: number
  readonly fixtureKind: string
  readonly capabilityAsOfDate: string
  readonly capabilityDigest: string
  readonly cases: readonly FixtureCase[]
}

const fixtureUrl = new URL(
  '../../../registry/fixtures/swap-execution-cases.json',
  import.meta.url,
)

const readFixture = async (): Promise<Fixture> =>
  JSON.parse(await readFile(fixtureUrl, 'utf8')) as Fixture

const rpcResult = (request: RpcRequest, result: unknown): Response =>
  new Response(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    { headers: { 'content-type': 'application/json' } },
  )

const rpcError = (
  request: RpcRequest,
  code: number,
  message: string,
): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code, message },
    }),
    { headers: { 'content-type': 'application/json' } },
  )

const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const expectedOutcome = (
  entry: FixtureCase,
): Record<string, unknown> => {
  const outcome = clone(entry.outcome)
  if (outcome.kind !== 'success' || !outcome.value) return outcome
  const value = outcome.value as Record<string, unknown>
  const preparation = (value.preparation ?? value) as Record<string, unknown>
  preparation.executionCapabilityDigest = SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST
  const quote = preparation.quote as Record<string, unknown> | undefined
  if (quote) {
    quote.tokenCatalogDigest = TOKEN_CATALOG_CONTENT_DIGEST
    quote.dexCatalogDigest = DEX_CATALOG_CONTENT_DIGEST
  }
  return outcome
}

const runFixtureCase = async (
  entry: FixtureCase,
): Promise<{ readonly outcome: Record<string, unknown>; readonly trace: readonly Record<string, unknown>[] }> => {
  const request = clone(entry.request)
  const trace: Record<string, unknown>[] = []
  let responseIndex = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const rpcRequestValue = JSON.parse(String(init?.body)) as RpcRequest
    trace.push({
      method: rpcRequestValue.method,
      params: rpcRequestValue.params ?? [],
    })
    if (entry.mutation === 'preflightProviderError') {
      throw new Error('upstream provider detail')
    }
    if (entry.mutation === 'changeRequestAfterAwait' && trace.length === 1) {
      request.sender = '0xcccccccccccccccccccccccccccccccccccccccc'
      request.recipient = '0xdddddddddddddddddddddddddddddddddddddd'
      request.slippageBps = 9999
      request.deadline = '1789498801'
      request.amountIn = '1'
    }

    const isFinalSimulation =
      rpcRequestValue.method === 'eth_call' &&
      typeof rpcRequestValue.params?.[0] === 'object' &&
      rpcRequestValue.params?.[0] !== null &&
      String((rpcRequestValue.params[0] as Record<string, unknown>).data ?? '')
        .startsWith('0x38ed1739')
    if (
      isFinalSimulation &&
      (entry.mutation === 'routerRevert' || entry.mutation === 'routerRevertCode3')
    ) {
      return rpcError(
        rpcRequestValue,
        entry.mutation === 'routerRevertCode3' ? 3 : -32000,
        entry.mutation === 'routerRevertCode3'
          ? 'execution reverted: ERC20: transfer amount exceeds balance'
          : 'execution reverted',
      )
    }
    if (
      isFinalSimulation &&
      (entry.mutation === 'routerProviderError' || entry.mutation === 'routerNonRevertCode3')
    ) {
      return rpcError(
        rpcRequestValue,
        entry.mutation === 'routerNonRevertCode3' ? 3 : -32000,
        entry.mutation === 'routerNonRevertCode3'
          ? 'invalid router request'
          : 'provider unavailable',
      )
    }

    const result = entry.rpcResponses[responseIndex]
    responseIndex += 1
    if (result === undefined) {
      throw new Error(`fixture has no response for ${rpcRequestValue.method}`)
    }
    return rpcResult(rpcRequestValue, result)
  }

  const client = createErpcClient({ apiKey: 'swap-execution-capture', fetch })
  let outcome: Record<string, unknown>
  vi.setSystemTime(entry.nowSeconds * 1000)
  try {
    if (entry.mutation === 'cancelBeforeFirstRpc') {
      const controller = new AbortController()
      controller.abort(new Error('caller cancelled'))
      if (entry.method === 'prepare') {
        await client.swap.prepareExactInputSwap(request as never, {
          signal: controller.signal,
        })
      } else {
        await client.swap.simulateExactInputSwap(request as never, {
          signal: controller.signal,
        })
      }
      throw new Error(`fixture ${entry.caseId} unexpectedly succeeded`)
    }
    const value =
      entry.method === 'prepare'
        ? await client.swap.prepareExactInputSwap(request as never)
        : await client.swap.simulateExactInputSwap(request as never)
    outcome = { kind: 'success', value: clone(value) }
  } catch (error) {
    if (
      (error instanceof SwapExecutionError || error instanceof SwapQuoteError) &&
      typeof error.code === 'string'
    ) {
      outcome = {
        kind: 'sdk-error',
        code: error.code,
      }
    } else {
      outcome = { kind: 'transport-error', sourcePreserved: true }
    }
  } finally {
    client.close()
  }
  return { outcome, trace }
}

describe('RPC-backed EVM swap execution', () => {
  it('replays every shared preparation and simulation fixture', async () => {
    const fixture = await readFixture()
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.fixtureKind).toBe('swap-execution-fixtures')
    expect(fixture.capabilityAsOfDate).toBe(SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE)
    expect(fixture.capabilityDigest).toBe(SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST)

    vi.useFakeTimers()
    try {
      for (const entry of fixture.cases) {
        const actual = await runFixtureCase(entry)
        expect(actual.outcome, entry.caseId).toEqual(expectedOutcome(entry))
        expect(actual.trace, entry.caseId).toEqual(entry.rpcTrace)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves exact calldata and rejects an insufficient allowance before router simulation', async () => {
    const fixture = await readFixture()
    const preparationCase = fixture.cases.find(
      (entry) => entry.caseId === 'prepare-ethereum-weth-usdc-forward',
    )
    const allowanceCase = fixture.cases.find(
      (entry) => entry.caseId === 'allowance-below-required',
    )
    expect(preparationCase).toBeDefined()
    expect(allowanceCase).toBeDefined()
    if (!preparationCase || !allowanceCase) return

    vi.useFakeTimers()
    try {
      const preparation = await runFixtureCase(preparationCase)
      expect(
        (preparation.outcome.value as Record<string, unknown>).transaction,
      ).toEqual((expectedOutcome(preparationCase).value as Record<string, unknown>).transaction)
      const allowance = await runFixtureCase(allowanceCase)
      expect(allowance.outcome).toEqual(expectedOutcome(allowanceCase))
      expect(allowance.trace).toHaveLength(17)
      expect(
        allowance.trace.some((entry) =>
          String(entry.params).includes('0x38ed1739'),
        ),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes a native parity capture only when requested', async () => {
    const outputPath = process.env.ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT
    if (!outputPath) return
    const fixture = await readFixture()
    vi.useFakeTimers()
    try {
      const behavior = { prepare: [], simulate: [] } as {
        prepare: Record<string, unknown>[]
        simulate: Record<string, unknown>[]
      }
      for (const entry of fixture.cases) {
        const actual = await runFixtureCase(entry)
        expect(actual.outcome, entry.caseId).toEqual(expectedOutcome(entry))
        expect(actual.trace, entry.caseId).toEqual(entry.rpcTrace)
        behavior[entry.method].push({
          caseId: entry.caseId,
          outcome: actual.outcome,
          rpcTrace: actual.trace,
        })
      }
      behavior.prepare.sort((left, right) =>
        String(left.caseId).localeCompare(String(right.caseId)),
      )
      behavior.simulate.sort((left, right) =>
        String(left.caseId).localeCompare(String(right.caseId)),
      )
      const runtime =
        process.env.ERPC_SDK_SWAP_EXECUTION_PARITY_PACKAGE === 'dist'
          ? `typescript-built-dist-${process.version}`
          : `typescript-source-${process.version}`
      await writeFile(
        outputPath,
        `${JSON.stringify({
          snapshotVersion: 1,
          snapshotKind: 'swap-execution-native-runtime',
          language: 'typescript',
          runtime,
          capabilityAsOfDate: SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
          capabilityDigest: SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
          behavior,
        }, null, 2)}\n`,
        'utf8',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
