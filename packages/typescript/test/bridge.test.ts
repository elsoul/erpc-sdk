import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

type BridgeSdk = typeof import('../src')

const bridgeSdk: BridgeSdk = process.env.ERPC_SDK_BRIDGE_PARITY_PACKAGE === 'dist'
  ? await import(new URL('../dist/index.js', import.meta.url).href) as BridgeSdk
  : await import('../src')

const {
  BRIDGE_CAPABILITIES_AS_OF_DATE,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  BridgeError,
  createMayanSwiftV2BridgeClient,
} = bridgeSdk

type MayanSwiftV2Quote = Awaited<
  ReturnType<InstanceType<typeof bridgeSdk.MayanSwiftV2BridgeClient>['quoteExactInput']>
>[number]

type QuoteMutation =
  | {
      readonly kind: 'normalized-set'
      readonly path: 'sourceSwap.required'
      readonly value: true
    }
  | {
      readonly kind: 'normalized-set'
      readonly path: 'sourceTokenDeploymentId'
      readonly value: 'deployment-0008' | 'deployment-0011'
    }
  | {
      readonly kind: 'raw-replace'
      readonly path: 'rawSignedQuoteJson'
      readonly from: string
      readonly to: string
    }

interface BridgeFixtureCase {
  readonly caseId: string
  readonly method: 'quote' | 'build' | 'status'
  readonly request: Record<string, unknown>
  readonly nowSeconds: number
  readonly providerStatus: number | null
  readonly providerBody: string | null
  readonly expected: Record<string, unknown>
  readonly httpTrace: readonly Record<string, unknown>[]
  readonly config: Record<string, unknown> | null
  readonly quoteCaseId: string | null
  readonly quoteMutation?: QuoteMutation
}

interface BridgeFixture {
  readonly schemaVersion: number
  readonly fixtureKind: string
  readonly capabilityAsOfDate: string
  readonly capabilityDigest: string
  readonly cases: readonly BridgeFixtureCase[]
}

interface FixtureRun {
  readonly outcome: Record<string, unknown>
  readonly trace: readonly Record<string, unknown>[]
}

const fixtureUrl = new URL(
  '../../../registry/fixtures/mayan-swift-v2-cases.json',
  import.meta.url,
)

const FROZEN_LEGACY_FIXTURE_CASE_IDS = [
  'quote-eth-sol-synthetic',
  'quote-sol-eth-synthetic',
  'build-eth-sol-synthetic',
  'build-sol-eth-synthetic',
  'status-eth-inprogress-synthetic',
  'status-eth-completed-synthetic',
  'status-sol-refunded-synthetic',
  'status-sol-unknown-synthetic',
  'status-eth-not-found-synthetic',
  'quote-duplicate-key',
  'quote-malformed-json',
  'quote-expired',
  'quote-mismatched-amount',
  'quote-bad-signature-shape',
  'quote-json-depth-limit',
  'quote-body-size-limit',
  'quote-unsupported-route',
  'build-auth-required-local',
  'build-quote-mismatch',
  'build-evm-forwarder-violation',
  'build-evm-selector-violation',
  'build-evm-value-violation',
  'build-solana-framing-violation',
  'build-solana-fee-payer-violation',
  'build-solana-extra-signer-violation',
  'build-solana-swap-message-violation',
  'build-http-auth-401',
  'build-http-rate-limit-429',
  'quote-redirect-rejected',
  'quote-timeout',
  'quote-aborted',
  'status-invalid-evm-hash',
  'status-invalid-provider-fields',
  'build-eth-sol-wrong-evm-destination',
  'build-sol-eth-wrong-solana-destination',
  'quote-eth-sol-zero-validity-margin',
] as const

const readFixture = async (): Promise<BridgeFixture> =>
  JSON.parse(await readFile(fixtureUrl, 'utf8')) as BridgeFixture

const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const applyQuoteMutation = (
  quote: MayanSwiftV2Quote,
  mutation: QuoteMutation | undefined,
): MayanSwiftV2Quote => {
  if (mutation === undefined) return quote
  if (mutation.kind === 'normalized-set') {
    if (mutation.path === 'sourceSwap.required' && mutation.value === true) {
      return {
        ...quote,
        sourceSwap: {
          ...quote.sourceSwap,
          required: mutation.value,
        },
      }
    }
    if (
      mutation.path === 'sourceTokenDeploymentId' &&
      (mutation.value === 'deployment-0008' || mutation.value === 'deployment-0011')
    ) {
      return {
        ...quote,
        sourceTokenDeploymentId: mutation.value,
      }
    }
    throw new Error('unsupported normalized quote mutation')
  }
  if (mutation.kind === 'raw-replace' && mutation.path === 'rawSignedQuoteJson') {
    if (!quote.rawSignedQuoteJson.includes(mutation.from)) {
      throw new Error('raw quote mutation source was not found')
    }
    return {
      ...quote,
      rawSignedQuoteJson: quote.rawSignedQuoteJson.replace(mutation.from, mutation.to),
    }
  }
  throw new Error('unsupported quote mutation')
}

const response = (
  body: string,
  status: number,
): Response => new Response(body, {
  status,
  headers: { 'content-type': 'application/json' },
})

const captureHeaders = (value: HeadersInit | undefined): Record<string, string> => {
  const headers = new Headers(value)
  return Object.fromEntries(
    [...headers.entries()].map(([name, header]) => [name.toLowerCase(), header]),
  )
}

const loadBaseQuotes = async (
  fixture: BridgeFixture,
): Promise<ReadonlyMap<string, MayanSwiftV2Quote>> => {
  const quotes = new Map<string, MayanSwiftV2Quote>()
  for (const entry of fixture.cases) {
    if (entry.method !== 'quote' || entry.expected.kind !== 'success') continue
    const body = entry.providerBody
    if (body === null || body === '__SYNTHETIC_BODY_EXCEEDS_1MIB__') continue
    vi.setSystemTime(entry.nowSeconds * 1000)
    const client = createMayanSwiftV2BridgeClient({
      ...(entry.config ?? {}),
      fetch: async () => response(body, entry.providerStatus ?? 200),
    })
    try {
      const value = await client.quoteExactInput(entry.request as never)
      if (value.length > 0) quotes.set(entry.caseId, value[0] as MayanSwiftV2Quote)
    } finally {
      client.close()
    }
  }
  return quotes
}

const runFixtureCase = async (
  entry: BridgeFixtureCase,
  quotes: ReadonlyMap<string, MayanSwiftV2Quote>,
): Promise<FixtureRun> => {
  vi.setSystemTime(entry.nowSeconds * 1000)
  const trace: Record<string, unknown>[] = []
  const timeout = entry.caseId === 'quote-timeout'
  const body = entry.providerBody
  let abortController: AbortController | undefined
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (body === '__SYNTHETIC_BODY_EXCEEDS_1MIB__') {
      trace.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: captureHeaders(init?.headers),
        body: init?.body === undefined ? null : String(init.body),
      })
      return response('x'.repeat(1024 * 1024 + 1), entry.providerStatus ?? 200)
    }
    trace.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: captureHeaders(init?.headers),
      body: init?.body === undefined ? null : String(init.body),
    })
    if (entry.caseId === 'quote-aborted') {
      abortController?.abort(new Error('caller cancelled'))
      throw new DOMException('aborted', 'AbortError')
    }
    if (timeout) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    }
    if (body === null && entry.providerStatus === null) {
      throw new Error(`fixture ${entry.caseId} must not reach provider`)
    }
    return response(body ?? '', entry.providerStatus ?? 200)
  }
  const config = {
    ...(entry.config ?? {}),
    fetch,
    ...(timeout ? { timeoutMs: 1 } : {}),
  }
  const client = createMayanSwiftV2BridgeClient(config)
  let outcome: Record<string, unknown>
  try {
    let value: unknown
    if (entry.method === 'quote') {
      if (entry.caseId === 'quote-aborted') {
        abortController = new AbortController()
        value = await client.quoteExactInput(entry.request as never, {
          signal: abortController.signal,
        })
      } else {
        const pending = client.quoteExactInput(entry.request as never)
        if (timeout) {
          const settled = pending.then(
            (result) => ({ kind: 'success' as const, result }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          )
          await vi.advanceTimersByTimeAsync(2)
          const result = await settled
          if (result.kind === 'error') throw result.error
          value = result.result
        } else {
          value = await pending
        }
      }
    } else if (entry.method === 'build') {
      const baseQuote = entry.quoteCaseId === null ? undefined : quotes.get(entry.quoteCaseId)
      const quote = baseQuote === undefined
        ? undefined
        : applyQuoteMutation(baseQuote, entry.quoteMutation)
      value = await client.buildUnsigned({
        ...(entry.request as object),
        quote,
      } as never)
    } else {
      value = await client.getStatus(entry.request as never)
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
    client.close()
  }
  return { outcome, trace }
}

const replay = async (
  fixture: BridgeFixture,
): Promise<ReadonlyMap<string, FixtureRun>> => {
  const quotes = await loadBaseQuotes(fixture)
  const runs = new Map<string, FixtureRun>()
  for (const entry of fixture.cases) {
    runs.set(entry.caseId, await runFixtureCase(entry, quotes))
  }
  return runs
}

describe('standalone Mayan Swift v2 bridge', () => {
  it('replays the literal quote, build, status, and safety fixtures', async () => {
    const fixture = await readFixture()
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.fixtureKind).toBe('mayan-swift-v2-fixtures')
    expect(fixture.capabilityAsOfDate).toBe(BRIDGE_CAPABILITIES_AS_OF_DATE)
    expect(fixture.capabilityDigest).toBe(BRIDGE_CAPABILITIES_CONTENT_DIGEST)
    vi.useFakeTimers()
    try {
      const runs = await replay(fixture)
      for (const entry of fixture.cases) {
        const actual = runs.get(entry.caseId)
        expect(actual?.outcome, entry.caseId).toEqual(entry.expected)
        expect(actual?.trace, entry.caseId).toEqual(entry.httpTrace)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the frozen original fixture case bodies and order', async () => {
    const fixture = await readFixture()
    const selected = FROZEN_LEGACY_FIXTURE_CASE_IDS.map((caseId) => {
      const entry = fixture.cases.find((candidate) => candidate.caseId === caseId)
      expect(entry, caseId).toBeDefined()
      return entry as BridgeFixtureCase
    })
    expect(selected.map((entry) => entry.caseId)).toEqual([...FROZEN_LEGACY_FIXTURE_CASE_IDS])
    expect(
      createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
    ).toBe('dce10a654672921bc4b26d4d14312abe81c0b93ac1de3fce48be3bd5beb7e5ee')
  })

  it('constructs without I/O and keeps the bridge transport separate from ERPC', () => {
    let calls = 0
    const client = createMayanSwiftV2BridgeClient({
      fetch: async () => {
        calls += 1
        throw new Error('unexpected provider request')
      },
    })
    client.close()
    client.close()
    expect(calls).toBe(0)
  })

  it('stops reading an oversized provider stream at the byte cap', async () => {
    vi.useRealTimers()
    const encoder = new TextEncoder()
    let pulls = 0
    let cancelled = false
    let resolveCancelled: (() => void) | undefined
    const cancelledPromise = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const chunk = encoder.encode('x'.repeat(512 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
        resolveCancelled?.()
      },
    })
    const client = createMayanSwiftV2BridgeClient({
      timeoutMs: 500,
      fetch: async () => new Response(stream),
    })
    try {
      const fixture = await readFixture()
      const quoteCase = fixture.cases.find(
        (entry) => entry.caseId === 'quote-eth-sol-synthetic',
      )
      expect(quoteCase).toBeDefined()
      if (!quoteCase) return
      await expect(client.quoteExactInput(quoteCase.request as never)).rejects.toMatchObject({
        code: 'BRIDGE_PROVIDER_INVALID_RESPONSE',
      })
      await Promise.race([
        cancelledPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThanOrEqual(4)
    } finally {
      client.close()
    }
  })

  it('keeps the total timeout active while a provider body is stalled', async () => {
    vi.useRealTimers()
    let pulls = 0
    let cancelled = false
    let resolveStarted: (() => void) | undefined
    let resolveCancelled: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const cancelledPromise = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1
        resolveStarted?.()
        return new Promise<void>(() => {})
      },
      cancel() {
        cancelled = true
        resolveCancelled?.()
      },
    })
    const client = createMayanSwiftV2BridgeClient({
      timeoutMs: 20,
      fetch: async () => new Response(stream),
    })
    try {
      const fixture = await readFixture()
      const quoteCase = fixture.cases.find(
        (entry) => entry.caseId === 'quote-eth-sol-synthetic',
      )
      expect(quoteCase).toBeDefined()
      if (!quoteCase) return
      const pending = client.quoteExactInput(quoteCase.request as never)
      await started
      await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' })
      await Promise.race([
        cancelledPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
      expect(pulls).toBeGreaterThan(0)
      expect(cancelled).toBe(true)
    } finally {
      client.close()
    }
  })

  it('cancels a stalled provider body when the caller aborts', async () => {
    vi.useRealTimers()
    let cancelled = false
    let resolveStarted: (() => void) | undefined
    let resolveCancelled: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const cancelledPromise = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        resolveStarted?.()
        return new Promise<void>(() => {})
      },
      cancel() {
        cancelled = true
        resolveCancelled?.()
      },
    })
    const caller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const client = createMayanSwiftV2BridgeClient({
      timeoutMs: 500,
      fetch: async (_input, init) => {
        providerSignal = init?.signal ?? undefined
        return new Response(stream)
      },
    })
    try {
      const fixture = await readFixture()
      const quoteCase = fixture.cases.find(
        (entry) => entry.caseId === 'quote-eth-sol-synthetic',
      )
      expect(quoteCase).toBeDefined()
      if (!quoteCase) return
      const pending = client.quoteExactInput(quoteCase.request as never, {
        signal: caller.signal,
      })
      await started
      caller.abort(new Error('caller cancelled'))
      await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_ABORTED' })
      await Promise.race([
        cancelledPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
      expect(cancelled).toBe(true)
      expect(providerSignal?.aborted).toBe(true)
    } finally {
      client.close()
    }
  })

  it('clears the body deadline and caller listener after a response completes', async () => {
    vi.useRealTimers()
    const caller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const client = createMayanSwiftV2BridgeClient({
      timeoutMs: 20,
      fetch: async (_input, init) => {
        providerSignal = init?.signal ?? undefined
        return new Response('{}')
      },
    })
    try {
      const fixture = await readFixture()
      const quoteCase = fixture.cases.find(
        (entry) => entry.caseId === 'quote-eth-sol-synthetic',
      )
      expect(quoteCase).toBeDefined()
      if (!quoteCase) return
      await expect(
        client.quoteExactInput(quoteCase.request as never, {
          signal: caller.signal,
        }),
      ).rejects.toMatchObject({ code: 'BRIDGE_PROVIDER_INVALID_RESPONSE' })
      caller.abort(new Error('late caller cancellation'))
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      expect(providerSignal?.aborted).toBe(false)
    } finally {
      client.close()
    }
  })

  it('writes an actual native parity capture only when requested', async () => {
    const outputPath = process.env.ERPC_SDK_BRIDGE_PARITY_OUTPUT
    if (!outputPath) return
    const fixture = await readFixture()
    vi.useFakeTimers()
    try {
      const runs = await replay(fixture)
      const behavior = { quote: [], build: [], status: [] } as {
        quote: Record<string, unknown>[]
        build: Record<string, unknown>[]
        status: Record<string, unknown>[]
      }
      for (const entry of fixture.cases) {
        const run = runs.get(entry.caseId)
        if (!run) throw new Error(`missing fixture run ${entry.caseId}`)
        expect(run.outcome, entry.caseId).toEqual(entry.expected)
        expect(run.trace, entry.caseId).toEqual(entry.httpTrace)
        behavior[entry.method].push({
          caseId: entry.caseId,
          outcome: run.outcome,
          httpTrace: run.trace,
        })
      }
      for (const rows of Object.values(behavior)) {
        rows.sort((left, right) =>
          String(left.caseId).localeCompare(String(right.caseId)),
        )
      }
      const runtime =
        process.env.ERPC_SDK_BRIDGE_PARITY_PACKAGE === 'dist'
          ? `typescript-built-dist-${process.version}`
          : `typescript-source-${process.version}`
      await writeFile(
        outputPath,
        `${JSON.stringify({
          snapshotVersion: 1,
          snapshotKind: 'bridge-native-runtime',
          language: 'typescript',
          runtime,
          capabilityAsOfDate: BRIDGE_CAPABILITIES_AS_OF_DATE,
          capabilityDigest: BRIDGE_CAPABILITIES_CONTENT_DIGEST,
          behavior,
        }, null, 2)}\n`,
        'utf8',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
