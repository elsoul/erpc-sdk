import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  __testFindProgramAddress,
  __testIsOnCurveZip215,
} from '../src/bridge_local'

type BridgeSdk = typeof import('../src')

const bridgeSdk: BridgeSdk = process.env.ERPC_SDK_BRIDGE_PARITY_PACKAGE === 'dist'
  ? await import(new URL('../dist/index.js', import.meta.url).href) as BridgeSdk
  : await import('../src')

const {
  BridgeError,
  createMayanSwiftV2BridgeClient,
} = bridgeSdk

type MayanSwiftV2Quote = Awaited<
  ReturnType<InstanceType<typeof bridgeSdk.MayanSwiftV2BridgeClient>['quoteExactInput']>
>[number]
type MayanSwiftV2SourceSwapPlan =
  Awaited<ReturnType<InstanceType<typeof bridgeSdk.MayanSwiftV2BridgeClient>['prepareSourceSwap']>>

interface LocalQuoteRecord {
  readonly quoteId: string
  readonly normalizedQuote: MayanSwiftV2Quote
}

interface LocalMock {
  readonly mockId: string
  readonly request: {
    readonly method: string
    readonly url: string
    readonly headers: Record<string, string>
    readonly body: string | null
  }
  readonly response: {
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: string
  }
}

interface LocalExpected {
  readonly kind: 'success' | 'sdk-error'
  readonly value?: unknown
  readonly code?: string
  readonly message?: string
  readonly status?: number
}

interface LocalCase {
  readonly caseId: string
  readonly method: 'prepareSourceSwap' | 'buildLocalUnsigned'
  readonly capabilityId: string
  readonly quoteId: string
  readonly context: {
    readonly quoteRef: string
    readonly swapperAddress: string
    readonly destinationAddress: string
    readonly orderNonce: string
  }
  readonly sourceSwapMockIds: readonly string[]
  readonly rpcMockIds: readonly string[]
  readonly sourceSwapPlanRef: string | null
  readonly expected: LocalExpected
  readonly httpTrace: readonly Record<string, unknown>[]
  readonly rpcTrace: readonly Record<string, unknown>[]
  readonly mutation: Record<string, unknown> | null
  readonly config: Record<string, unknown>
}

interface LocalFixture {
  readonly schemaVersion: number
  readonly fixtureKind: string
  readonly capabilityAsOfDate: string
  readonly capabilityDigest: string
  readonly localFixtureDigest: string
  readonly quotes: readonly LocalQuoteRecord[]
  readonly sourceSwapMocks: readonly LocalMock[]
  readonly rpcMocks: readonly LocalMock[]
  readonly cases: readonly LocalCase[]
}

interface LocalRun {
  readonly outcome: Record<string, unknown>
  readonly httpTrace: readonly Record<string, unknown>[]
  readonly rpcTrace: readonly Record<string, unknown>[]
}

const fixtureUrl = new URL(
  '../../../registry/fixtures/mayan-swift-v2-local-build-cases.json',
  import.meta.url,
)

const readFixture = async (): Promise<LocalFixture> =>
  JSON.parse(await readFile(fixtureUrl, 'utf8')) as LocalFixture

const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const setPath = (root: unknown, path: string, value: unknown): void => {
  const parts = path.split('.').flatMap((part) => part.replace(/\[(\d+)\]/gu, '.$1').split('.'))
  if (parts.length === 0) throw new Error('empty mutation path')
  let cursor: unknown = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (part === undefined || cursor === null || typeof cursor !== 'object') throw new Error('invalid mutation path')
    cursor = Array.isArray(cursor)
      ? cursor[Number(part)]
      : (cursor as Record<string, unknown>)[part]
  }
  const leaf = parts[parts.length - 1]
  if (leaf === undefined || cursor === null || typeof cursor !== 'object') throw new Error('invalid mutation path')
  if (Array.isArray(cursor)) cursor[Number(leaf)] = value
  else (cursor as Record<string, unknown>)[leaf] = value
}

const mutateQuote = (
  quote: MayanSwiftV2Quote,
  mutation: Record<string, unknown> | null,
): MayanSwiftV2Quote => {
  if (mutation === null) return clone(quote)
  const kind = mutation.kind
  const path = mutation.path
  if (typeof kind !== 'string' || typeof path !== 'string') throw new Error('invalid quote mutation')
  const result = clone(quote)
  if (kind === 'quote-normalized-set') {
    setPath(result, path, mutation.value)
    return result
  }
  if (kind === 'quote-raw-set') {
    const raw = JSON.parse(result.rawSignedQuoteJson) as unknown
    setPath(raw, path, mutation.value)
    return { ...result, rawSignedQuoteJson: JSON.stringify(raw) }
  }
  return result
}

const mutateSourceMock = (
  mock: LocalMock,
  mutation: Record<string, unknown> | null,
): LocalMock => {
  if (mutation === null || mutation.kind !== 'source-swap-response-set' || typeof mutation.path !== 'string') return clone(mock)
  const body = JSON.parse(mock.response.body) as unknown
  setPath(body, mutation.path, mutation.value)
  return {
    ...clone(mock),
    response: { ...mock.response, body: JSON.stringify(body) },
  }
}

const mutateRpcMock = (
  mock: LocalMock,
  mutation: Record<string, unknown> | null,
  applyEnvelopeMutation = false,
): LocalMock => {
  if (mutation?.kind === 'boundary') {
    const request = requestBodyParts(mock.request.body)
    if (request?.method !== 'getMultipleAccounts') return clone(mock)
    const body = JSON.parse(mock.response.body) as unknown
    const values = (body as Record<string, unknown>)?.result as Record<string, unknown> | undefined
    if (!values || !Array.isArray(values.value)) return clone(mock)
    const emptyData = new Uint8Array(56)
    emptyData[0] = 1
    emptyData[4] = 0xff
    emptyData[5] = 0xff
    emptyData[6] = 0xff
    emptyData[7] = 0xff
    emptyData[8] = 0xff
    emptyData[9] = 0xff
    emptyData[10] = 0xff
    emptyData[11] = 0xff
    for (const value of values.value) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const account = value as Record<string, unknown>
        if (Array.isArray(account.data) && typeof account.data[0] === 'string') {
          account.data[0] = Buffer.from(emptyData).toString('base64')
        }
      }
    }
    return {
      ...clone(mock),
      response: { ...mock.response, body: JSON.stringify(body) },
    }
  }
  if (applyEnvelopeMutation && mutation?.kind === 'rpc-envelope-set' && typeof mutation.path === 'string') {
    const body = JSON.parse(mock.response.body) as Record<string, unknown>
    if (mutation.path === 'id' || mutation.path === 'jsonrpc') {
      body[mutation.path] = mutation.value
    } else if (mutation.path === 'version') {
      body.jsonrpc = mutation.value
    } else if (mutation.path === 'depth') {
      const depth = Number(mutation.value)
      let nested: unknown = body.result
      for (let index = 0; index < depth; index += 1) nested = { nested }
      body.result = nested
    } else if (mutation.path === 'size') {
      body.result = 'x'.repeat(Number(mutation.value))
    }
    return {
      ...clone(mock),
      response: { ...mock.response, body: JSON.stringify(body) },
    }
  }
  if (mutation === null || mutation.kind !== 'rpc-response-set' || typeof mutation.path !== 'string') return clone(mock)
  const body = JSON.parse(mock.response.body) as unknown
  const request = requestBodyParts(mock.request.body)
  const method = typeof request?.method === 'string' ? request.method : ''
  const prefix = `${method}.`
  if (!mutation.path.startsWith(prefix)) return clone(mock)
  const responsePath = mutation.path.startsWith(prefix) ? mutation.path.slice(prefix.length) : mutation.path
  setPath(body, responsePath === 'result' ? responsePath : `result.${responsePath}`, mutation.value)
  return {
    ...clone(mock),
    response: { ...mock.response, body: JSON.stringify(body) },
  }
}

const mutatePlan = (
  plan: MayanSwiftV2SourceSwapPlan,
  mutation: Record<string, unknown> | null,
): MayanSwiftV2SourceSwapPlan => {
  if (mutation === null || mutation.kind !== 'plan-set' || typeof mutation.path !== 'string') return clone(plan)
  const result = clone(plan)
  setPath(result, mutation.path, mutation.value)
  return result
}

const mutateConfig = (
  config: Record<string, unknown>,
  mutation: Record<string, unknown> | null,
): Record<string, unknown> => {
  if (mutation === null || mutation.kind !== 'config-set' || typeof mutation.path !== 'string') return clone(config)
  const result = clone(config)
  setPath(result, mutation.path, mutation.value)
  return result
}

const captureHeaders = (value: HeadersInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(value).entries())

const response = (mock: LocalMock): Response => new Response(mock.response.body, {
  status: mock.response.status,
  headers: mock.response.headers,
})

const requestBodyParts = (value: string | null): { method: unknown; params: unknown } | null => {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return { method: record.method, params: record.params }
  } catch {
    return null
  }
}

const runLocalCase = async (
  fixture: LocalFixture,
  entry: LocalCase,
  quoteMap: ReadonlyMap<string, MayanSwiftV2Quote>,
  planMap: ReadonlyMap<string, MayanSwiftV2SourceSwapPlan>,
): Promise<LocalRun> => {
  const baseQuote = quoteMap.get(entry.quoteId)
  if (!baseQuote) throw new Error(`missing quote ${entry.quoteId}`)
  const mutation = entry.mutation
  const quote = mutateQuote(baseQuote, mutation?.kind === 'quote-normalized-set' || mutation?.kind === 'quote-raw-set' ? mutation : null)
  const context = {
    quote,
    swapperAddress: entry.context.swapperAddress,
    destinationAddress: entry.context.destinationAddress,
    orderNonce: entry.context.orderNonce,
  }
  const planRef = entry.sourceSwapPlanRef === null ? null : planMap.get(entry.sourceSwapPlanRef)
  if (entry.method === 'buildLocalUnsigned' && !planRef) throw new Error(`missing plan ${entry.sourceSwapPlanRef}`)

  const sourceMocks = new Map(
    fixture.sourceSwapMocks
      .filter((mock) => entry.sourceSwapMockIds.includes(mock.mockId))
      .map((mock) => [mock.mockId, mutateSourceMock(mock, mutation)] as const),
  )
  const rpcMocks = new Map(
    entry.rpcMockIds.map((mockId, index) => {
      const mock = fixture.rpcMocks.find((candidate) => candidate.mockId === mockId)
      if (!mock) throw new Error(`missing RPC mock ${mockId}`)
      return [mockId, mutateRpcMock(mock, mutation, index === 0)] as const
    }),
  )
  const httpTrace: Record<string, unknown>[] = []
  const rpcTrace: Record<string, unknown>[] = []
  const transportEvent = mutation?.kind === 'transport' && typeof mutation.event === 'string'
    ? mutation.event
    : null
  const callerAbort = new AbortController()
  let fetchCalls = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    fetchCalls += 1
    if (transportEvent === 'credential-forwarding' || transportEvent === 'hosted-build-attempt') {
      throw new BridgeError('BRIDGE_LOCAL_PLAN_INVALID')
    }
    const method = String(init?.method ?? 'GET').toUpperCase()
    const url = String(input)
    const trace = {
      method,
      url,
      headers: captureHeaders(init?.headers),
      body: init?.body === undefined ? null : String(init.body),
    }
    if (method === 'GET') httpTrace.push(trace)
    else rpcTrace.push(trace)
    if (transportEvent === 'rpc-transport-error') throw new Error('rpc transport')
    if (transportEvent === 'source-swap-timeout' || transportEvent === 'rpc-timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    }
    if (transportEvent === 'source-swap-abort' || transportEvent === 'rpc-abort') {
      callerAbort.abort(new Error('caller cancelled'))
      throw new DOMException('aborted', 'AbortError')
    }
    if (method === 'GET') {
      const mock = [...sourceMocks.values()].find((candidate) => candidate.request.url === url)
      if (!mock) throw new Error(`unexpected source-swap request ${url}`)
      return response(mock)
    }
    const actual = requestBodyParts(trace.body as string | null)
    const mock = [...rpcMocks.values()].find((candidate) => {
      if (candidate.request.url !== url) return false
      const expected = requestBodyParts(candidate.request.body)
      return expected?.method === actual?.method && JSON.stringify(expected?.params) === JSON.stringify(actual?.params)
    })
    if (!mock) throw new Error(`unexpected RPC request ${url}`)
    return response(mock)
  }

  const configured = mutateConfig(entry.config, mutation)
  const localBuildConfig = configured.localBuild
  const localConfig = localBuildConfig !== null && typeof localBuildConfig === 'object'
    ? {
        ...configured,
        localBuild: Object.fromEntries(
          Object.entries(localBuildConfig).filter(([key]) => key !== 'altValidation'),
        ),
      }
    : configured
  const client = createMayanSwiftV2BridgeClient({
    ...localConfig,
    fetch,
    minimumQuoteValiditySeconds: 0,
    timeoutMs: transportEvent === 'source-swap-timeout' || transportEvent === 'rpc-timeout' ? 5 : 2000,
  })
  const originalDateNow = Date.now
  Date.now = () => (Number(baseQuote.deadline) - 1) * 1000
  let outcome: Record<string, unknown>
  try {
    let value: unknown
    const options = transportEvent === 'source-swap-abort' || transportEvent === 'rpc-abort'
      ? { signal: callerAbort.signal }
      : undefined
    if (entry.method === 'prepareSourceSwap') {
      value = await client.prepareSourceSwap(context, options)
    } else {
      value = await client.buildLocalUnsigned({
        ...context,
        sourceSwapPlan: mutatePlan(planRef as MayanSwiftV2SourceSwapPlan, mutation),
      }, options)
    }
    outcome = { kind: 'success', value: clone(value) }
  } catch (error) {
    if (error instanceof BridgeError) {
      outcome = {
        kind: 'sdk-error',
        code: error.code,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
      }
    } else {
      outcome = { kind: 'transport-error', sourcePreserved: true }
    }
  } finally {
    Date.now = originalDateNow
    client.close()
  }
  if (transportEvent === 'credential-forwarding' || transportEvent === 'hosted-build-attempt') {
    expect(fetchCalls, entry.caseId).toBeGreaterThan(0)
  }
  return { outcome, httpTrace, rpcTrace }
}

export const replayLocalFixtureForParity = async (): Promise<{
  readonly fixture: LocalFixture
  readonly runs: ReadonlyMap<string, LocalRun>
}> => {
  const fixture = await readFixture()
  const quoteMap = new Map(fixture.quotes.map((entry) => [entry.quoteId, entry.normalizedQuote]))
  const planMap = new Map<string, MayanSwiftV2SourceSwapPlan>()
  for (const entry of fixture.cases) {
    if (entry.method !== 'prepareSourceSwap' || entry.expected.kind !== 'success') continue
    if (entry.expected.value === undefined) throw new Error(`missing expected plan ${entry.caseId}`)
    planMap.set(entry.caseId, entry.expected.value as MayanSwiftV2SourceSwapPlan)
  }
  const runs = new Map<string, LocalRun>()
  for (const entry of fixture.cases) {
    runs.set(entry.caseId, await runLocalCase(fixture, entry, quoteMap, planMap))
  }
  return { fixture, runs }
}

describe('standalone Mayan Swift v2 local construction', () => {
  it('replays the local source-swap and unsigned-build fixtures', async () => {
    const fixture = await readFixture()
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.fixtureKind).toBe('mayan-swift-v2-local-build-fixtures')
    const quoteMap = new Map(fixture.quotes.map((entry) => [entry.quoteId, entry.normalizedQuote]))
    const planMap = new Map<string, MayanSwiftV2SourceSwapPlan>()
    for (const entry of fixture.cases) {
      if (entry.method !== 'prepareSourceSwap' || entry.expected.kind !== 'success') continue
      const value = entry.expected.value
      if (value === undefined) throw new Error(`missing expected plan ${entry.caseId}`)
      planMap.set(entry.caseId, value as MayanSwiftV2SourceSwapPlan)
    }
    for (const entry of fixture.cases) {
      const actual = await runLocalCase(fixture, entry, quoteMap, planMap)
      expect(actual.outcome, entry.caseId).toEqual(entry.expected)
      expect(actual.httpTrace, entry.caseId).toEqual(entry.httpTrace)
      expect(actual.rpcTrace, entry.caseId).toEqual(entry.rpcTrace)
    }
  })

  it('exercises the final-size boundary through empty mocked lookup tables', async () => {
    const fixture = await readFixture()
    const entry = fixture.cases.find((candidate) => candidate.caseId === 'build-solana-final-size-cap')
    expect(entry?.mutation).toEqual({
      kind: 'boundary',
      path: 'solana.finalTransactionBytes',
      value: '1233',
    })
    if (!entry) return
    const quoteMap = new Map(fixture.quotes.map((candidate) => [candidate.quoteId, candidate.normalizedQuote]))
    const planCase = fixture.cases.find((candidate) => candidate.caseId === entry.sourceSwapPlanRef)
    if (!planCase?.expected.value) return
    const planMap = new Map([[planCase.caseId, planCase.expected.value as MayanSwiftV2SourceSwapPlan]])
    const actual = await runLocalCase(fixture, entry, quoteMap, planMap)
    expect(actual.outcome).toEqual(entry.expected)
    expect(actual.rpcTrace).toEqual(entry.rpcTrace)
  })

  it('does not perform local network work during client construction', () => {
    let calls = 0
    const client = createMayanSwiftV2BridgeClient({
      localBuild: {
        sourceSwapEndpoint: 'https://price-api.mayan.finance/v3',
        ethereumRpc: { httpUrl: 'https://ethereum-rpc.publicnode.com/' },
      },
      fetch: async () => {
        calls += 1
        throw new Error('unexpected request')
      },
    })
    client.close()
    expect(calls).toBe(0)
  })

  it('keeps native Edwards and PDA primitives bounded and deterministic', () => {
    const identity = new Uint8Array(32)
    identity[0] = 1
    const signOne = identity.slice()
    signOne[31] = (signOne[31] ?? 0) | 0x80
    const nonCanonicalY = new Uint8Array(32)
    let prime = (1n << 255n) - 19n
    for (let index = 0; index < nonCanonicalY.length; index += 1) {
      nonCanonicalY[index] = Number(prime & 0xffn)
      prime >>= 8n
    }
    const invalidSqrt = new Uint8Array(32)
    invalidSqrt[0] = 2

    expect(__testIsOnCurveZip215(identity)).toBe(true)
    expect(__testIsOnCurveZip215(signOne)).toBe(true)
    expect(__testIsOnCurveZip215(nonCanonicalY)).toBe(true)
    expect(__testIsOnCurveZip215(invalidSqrt)).toBe(false)

    const program = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
    const result = __testFindProgramAddress([
      new TextEncoder().encode('STATE_SOURCE'),
      new Uint8Array(32),
      new Uint8Array([2, 0]),
    ], program)
    expect(result.bump).toBeGreaterThanOrEqual(0)
    expect(result.bump).toBeLessThanOrEqual(255)
    expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u)
    expect(() => __testFindProgramAddress(new Array(17).fill(new Uint8Array()), program)).toThrow()
    expect(() => __testFindProgramAddress([new Uint8Array(33)], program)).toThrow()
  })

  it('bounds streamed source bodies through timeout, cancel, size, and depth', async () => {
    const fixture = await readFixture()
    const quote = fixture.quotes.find((entry) => entry.quoteId === '0x7e6a3fd367955cb68aed7f9186424652')?.normalizedQuote
    if (!quote) throw new Error('missing streamed-body quote')
    const context = {
      quote,
      swapperAddress: 'HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b',
      destinationAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      orderNonce: '0x102132435465768798a9bacbdcedfe0f',
    }
    vi.useFakeTimers()
    vi.setSystemTime((Number(quote.deadline) - 1) * 1000)
    try {
      let cancelled = false
      let release: (() => void) | undefined
      const slow = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
          release = () => controller.close()
        },
        cancel() {
          cancelled = true
        },
        pull() {
          return new Promise<void>((resolve) => {
            release = () => {
              release = undefined
              resolve()
            }
          })
        },
      })
      const timeoutClient = createMayanSwiftV2BridgeClient({
        timeoutMs: 2,
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response(slow, { status: 200 }),
      })
      const timed = timeoutClient.prepareSourceSwap(context)
      const timedExpectation = expect(timed).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(3)
      await timedExpectation
      timeoutClient.close()
      expect(cancelled).toBe(true)
      release?.()

      let abortCancelled = false
      const abortController = new AbortController()
      const abortStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
        },
        cancel() {
          abortCancelled = true
        },
        pull() {
          return new Promise<void>(() => {})
        },
      })
      const abortClient = createMayanSwiftV2BridgeClient({
        timeoutMs: 10_000,
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response(abortStream, { status: 200 }),
      })
      const aborted = abortClient.prepareSourceSwap(context, { signal: abortController.signal })
      await Promise.resolve()
      abortController.abort()
      await expect(aborted).rejects.toMatchObject({ code: 'BRIDGE_ABORTED' })
      abortClient.close()
      expect(abortCancelled).toBe(true)

      const oversizedClient = createMayanSwiftV2BridgeClient({
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
      })
      await expect(oversizedClient.prepareSourceSwap(context)).rejects.toMatchObject({
        code: 'BRIDGE_PROVIDER_INVALID_RESPONSE',
      })
      oversizedClient.close()

      let declaredOversizeCancelled = false
      const declaredOversizeStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'))
        },
        cancel() {
          declaredOversizeCancelled = true
        },
        pull() {
          return new Promise<void>(() => {})
        },
      })
      const declaredOversizeClient = createMayanSwiftV2BridgeClient({
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response(declaredOversizeStream, {
          status: 200,
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
      })
      await expect(declaredOversizeClient.prepareSourceSwap(context)).rejects.toMatchObject({
        code: 'BRIDGE_PROVIDER_INVALID_RESPONSE',
      })
      declaredOversizeClient.close()
      expect(declaredOversizeCancelled).toBe(true)

      let httpErrorCancelled = false
      const httpErrorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'))
        },
        cancel() {
          httpErrorCancelled = true
        },
        pull() {
          return new Promise<void>(() => {})
        },
      })
      const httpErrorClient = createMayanSwiftV2BridgeClient({
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response(httpErrorStream, { status: 503 }),
      })
      await expect(httpErrorClient.prepareSourceSwap(context)).rejects.toMatchObject({
        code: 'BRIDGE_PROVIDER_HTTP',
      })
      httpErrorClient.close()
      expect(httpErrorCancelled).toBe(true)

      let nested = '{}'
      for (let index = 0; index < 33; index += 1) nested = `{"nested":${nested}}`
      const deepClient = createMayanSwiftV2BridgeClient({
        minimumQuoteValiditySeconds: 0,
        fetch: async () => new Response(nested, { status: 200 }),
      })
      await expect(deepClient.prepareSourceSwap(context)).rejects.toMatchObject({
        code: 'BRIDGE_PROVIDER_INVALID_RESPONSE',
      })
      deepClient.close()

      const buildCase = fixture.cases.find((entry) => entry.caseId === 'build-usdc-solana-to-ethereum')
      const buildQuote = buildCase === undefined
        ? undefined
        : fixture.quotes.find((entry) => entry.quoteId === buildCase.quoteId)?.normalizedQuote
      const buildPlanCase = buildCase?.sourceSwapPlanRef === null || buildCase?.sourceSwapPlanRef === undefined
        ? undefined
        : fixture.cases.find((entry) => entry.caseId === buildCase.sourceSwapPlanRef)
      if (!buildCase || !buildQuote || !buildPlanCase?.expected.value) throw new Error('missing RPC oversize fixture')
      let rpcDeclaredOversizeCancelled = false
      const rpcDeclaredOversizeStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'))
        },
        cancel() {
          rpcDeclaredOversizeCancelled = true
        },
        pull() {
          return new Promise<void>(() => {})
        },
      })
      const rpcOversizeClient = createMayanSwiftV2BridgeClient({
        minimumQuoteValiditySeconds: 0,
        localBuild: { solanaRpc: { httpUrl: 'https://rpc.example.test' } },
        fetch: async () => new Response(rpcDeclaredOversizeStream, {
          status: 200,
          headers: { 'content-length': String(1024 * 1024 + 1) },
        }),
      })
      await expect(rpcOversizeClient.buildLocalUnsigned({
        quote: buildQuote,
        swapperAddress: buildCase.context.swapperAddress,
        destinationAddress: buildCase.context.destinationAddress,
        orderNonce: buildCase.context.orderNonce,
        sourceSwapPlan: buildPlanCase.expected.value as MayanSwiftV2SourceSwapPlan,
      })).rejects.toMatchObject({ code: 'BRIDGE_SOURCE_RPC_INVALID_RESPONSE' })
      rpcOversizeClient.close()
      expect(rpcDeclaredOversizeCancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses hosted quote validation for local preflight with zero I/O', async () => {
    const fixture = await readFixture()
    const base = fixture.quotes.find((entry) => entry.quoteId === '0x7cc392912037d3040fc65db5596858a3')?.normalizedQuote
    if (!base) throw new Error('missing hosted validation quote')
    const context = {
      quote: base,
      swapperAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      destinationAddress: 'HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b',
      orderNonce: '0x00112233445566778899aabbccddeeff',
    }
    vi.useFakeTimers()
    vi.setSystemTime((Number(base.deadline) - 1) * 1000)
    try {
      const variants: MayanSwiftV2Quote[] = []
      const slippageRaw = JSON.parse(base.rawSignedQuoteJson) as Record<string, unknown>
      slippageRaw.slippageBps = 501
      variants.push({
        ...base,
        slippageBps: 501,
        rawSignedQuoteJson: JSON.stringify(slippageRaw),
      })
      variants.push({
        ...base,
        quoteVerification: 'tampered' as never,
      })
      const boolTokenRaw = JSON.parse(base.rawSignedQuoteJson) as Record<string, unknown>
      ;(boolTokenRaw.fromToken as Record<string, unknown>).chainId = false
      variants.push({ ...base, rawSignedQuoteJson: JSON.stringify(boolTokenRaw) })
      const wrongTokenRaw = JSON.parse(base.rawSignedQuoteJson) as Record<string, unknown>
      ;(wrongTokenRaw.toToken as Record<string, unknown>).chainId = 999
      variants.push({ ...base, rawSignedQuoteJson: JSON.stringify(wrongTokenRaw) })

      for (const quote of variants) {
        let calls = 0
        const client = createMayanSwiftV2BridgeClient({
          minimumQuoteValiditySeconds: 0,
          fetch: async () => {
            calls += 1
            return new Response('{}')
          },
        })
        await expect(client.prepareSourceSwap({ ...context, quote })).rejects.toMatchObject({
          code: 'BRIDGE_LOCAL_PLAN_INVALID',
        })
        client.close()
        expect(calls).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
