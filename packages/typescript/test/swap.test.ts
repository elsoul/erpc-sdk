import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEX_ALIASES,
  DEX_CATALOG_AS_OF_DATE,
  DEX_CATALOG_CONTENT_DIGEST,
  DEX_CATALOG_VERSION,
  createErpcClient,
  DEX_CHAIN_IDS,
  DEX_DEPLOYMENTS,
  ErpcTransportError,
  NATIVE_WRAP_DEFINITIONS,
  POOL_DEFINITIONS,
  SwapQuoteError,
  TOKEN_CATALOG_AS_OF_DATE,
  TOKEN_CATALOG_CONTENT_DIGEST,
  TOKEN_DEPLOYMENTS,
  TOKEN_CHAIN_IDS,
  TOKEN_CATALOG_VERSION,
  dexes,
  findPoolDefinitionByAddress,
  findPoolDefinitionsByPair,
  getDexDeployment,
  getNativeWrapDefinition,
  getPoolDefinition,
  listPoolDefinitions,
  pools,
  type ExactInputQuoteRequest,
} from '../src'

const ETH_FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f'
const ETH_POOL = '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc'
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ETH_HASH = '0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb'
const ETH_BLOCK = '0x18c7f20'
const ETHEREUM_CHAIN_ID = DEX_CHAIN_IDS.ethereum
const SOLANA_CHAIN_ID = DEX_CHAIN_IDS.solana
const AVALANCHE_CHAIN_ID = DEX_CHAIN_IDS.avalancheC

interface RpcRequest {
  readonly id: number
  readonly method: string
  readonly params?: readonly unknown[]
}

interface MockRpcOptions {
  readonly chain?: 'avalancheC' | 'ethereum'
  readonly now?: number
  readonly latestTimestamp?: number
  readonly secondLatestHash?: string
  readonly malformedFactoryPair?: boolean
  readonly malformedFactoryCode?: boolean
  readonly throwOn?: string
}

const word = (address: string): string =>
  `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

const uintWord = (value: bigint): string =>
  value.toString(16).padStart(64, '0')

const reserves = (reserve0: bigint, reserve1: bigint): string =>
  `0x${uintWord(reserve0)}${uintWord(reserve1)}${uintWord(1n)}`

const response = (request: RpcRequest, result: unknown): Response =>
  new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result,
  }), {
    headers: { 'content-type': 'application/json' },
  })

const mockRpcFetch = (
  requests: RpcRequest[],
  options: MockRpcOptions = {},
): typeof globalThis.fetch => {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const timestamp = options.latestTimestamp ?? now
  let latestReads = 0
  return async (input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    requests.push(request)
    if (options.throwOn === request.method) {
      throw new Error('upstream transport detail')
    }

    const isAvalanche = options.chain === 'avalancheC' ||
      (options.chain === undefined && String(input).includes('/ava'))
    const factory = isAvalanche
      ? '0x9ad6c38be94206ca50bb0d90783181662f0cfa10'
      : ETH_FACTORY
    const pool = isAvalanche
      ? '0xf4003f4efbe8691b60249e6afbd307abe7758adb'
      : ETH_POOL
    const token0 = isAvalanche
      ? '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'
      : ETH_USDC
    const token1 = isAvalanche
      ? '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
      : ETH_WETH
    const block = isAvalanche ? '0x5af2cac' : ETH_BLOCK
    const hash = isAvalanche
      ? '0x782561de07be8fa1af1da86cf19a859eedd0377f6f3582cec4623e5566fb8c30'
      : ETH_HASH

    if (request.method === 'eth_chainId') return response(request, isAvalanche ? '0xa86a' : '0x1')
    if (request.method === 'eth_getBlockByNumber') {
      const requested = request.params?.[0]
      if (requested === 'latest') {
        latestReads += 1
        return response(request, {
          number: block,
          hash:
            latestReads === 2 && options.secondLatestHash
              ? options.secondLatestHash
              : hash,
          timestamp: `0x${timestamp.toString(16)}`,
        })
      }
      return response(request, {
        number: block,
        hash,
        timestamp: `0x${timestamp.toString(16)}`,
      })
    }
    if (request.method === 'eth_getCode') {
      return response(
        request,
        options.malformedFactoryCode && request.params?.[0] === factory
          ? '0xZZ'
          : '0x6000',
      )
    }
    if (request.method === 'eth_call') {
      const transaction = request.params?.[0] as { readonly to?: string; readonly data?: string }
      const data = transaction.data ?? ''
      if (data.startsWith('0xe6a43905')) {
        return response(request, options.malformedFactoryPair ? `${word(pool)}00` : word(pool))
      }
      if (data === '0xc45a0155') return response(request, word(factory))
      if (data === '0x0dfe1681') return response(request, word(token0))
      if (data === '0xd21220a7') return response(request, word(token1))
      if (data === '0x0902f1ac') {
        return response(
          request,
          isAvalanche
            ? reserves(25140425368720458877890n, 184829229672n)
            : reserves(9922163268622n, 4131396377933182743090n),
        )
      }
    }
    throw new Error(`unhandled RPC method ${request.method}`)
  }
}

const ethereumRequest = (
  overrides: Partial<ExactInputQuoteRequest> = {},
): ExactInputQuoteRequest => ({
  chainId: ETHEREUM_CHAIN_ID,
  poolDefinitionId: 'pool-0001',
  inputTokenDeploymentId: 'deployment-0002',
  outputTokenDeploymentId: 'deployment-0008',
  amountIn: '1000000000000000000',
  ...overrides,
})

interface CaptureRecord {
  readonly [key: string]: unknown
}

interface CaptureClient {
  readonly swap: {
    readonly quoteExactInput: (
      request: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<unknown>
  }
  close(): void
}

interface CaptureSdk {
  readonly createErpcClient: (config: {
    readonly apiKey: string
    readonly fetch: typeof globalThis.fetch
  }) => CaptureClient
  readonly DEX_ALIASES: readonly CaptureRecord[]
  readonly DEX_CATALOG_AS_OF_DATE: string
  readonly DEX_CATALOG_CONTENT_DIGEST: string
  readonly DEX_CATALOG_VERSION: string
  readonly DEX_CHAIN_IDS: Readonly<Record<string, string>>
  readonly DEX_DEPLOYMENTS: readonly CaptureRecord[]
  readonly NATIVE_WRAP_DEFINITIONS: readonly CaptureRecord[]
  readonly POOL_DEFINITIONS: readonly CaptureRecord[]
  readonly TOKEN_CATALOG_AS_OF_DATE: string
  readonly TOKEN_CATALOG_CONTENT_DIGEST: string
  readonly TOKEN_CHAIN_IDS: Readonly<{
    readonly ethereumMainnet: string
    readonly solanaMainnet: string
    readonly avalancheCMainnet: string
  }>
  readonly TOKEN_DEPLOYMENTS: readonly CaptureRecord[]
  readonly TOKEN_CATALOG_VERSION: string
  readonly dexes: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly pools: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly findPoolDefinitionByAddress: (
    chainId: string,
    address: string,
  ) => CaptureRecord | undefined
  readonly findPoolDefinitionsByPair: (
    chainId: string,
    tokenA: string,
    tokenB: string,
  ) => readonly CaptureRecord[]
  readonly getDexDeployment: (id: string) => CaptureRecord | undefined
  readonly getNativeWrapDefinition: (id: string) => CaptureRecord | undefined
  readonly getPoolDefinition: (id: string) => CaptureRecord | undefined
  readonly listPoolDefinitions: (
    options?: Record<string, unknown>,
  ) => readonly CaptureRecord[]
}

interface QuoteFixtureCase {
  readonly caseId: string
  readonly request: Record<string, unknown>
  readonly nowSeconds: number
  readonly rpcResponses: readonly unknown[]
  readonly rpcTrace: readonly CaptureRecord[]
  readonly outcome: unknown
  readonly applicability?: string
  readonly mutation?: string
}

interface QuoteFixture {
  readonly validCases: readonly QuoteFixtureCase[]
  readonly invalidCases: readonly QuoteFixtureCase[]
  readonly rpcCases: readonly QuoteFixtureCase[]
  readonly arithmeticCases: readonly QuoteFixtureCase[]
}

const jsonClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const sourceCaptureSdk = (): CaptureSdk => ({
  createErpcClient: createErpcClient as unknown as CaptureSdk['createErpcClient'],
  DEX_ALIASES,
  DEX_CATALOG_AS_OF_DATE,
  DEX_CATALOG_CONTENT_DIGEST,
  DEX_CATALOG_VERSION,
  DEX_CHAIN_IDS,
  DEX_DEPLOYMENTS,
  NATIVE_WRAP_DEFINITIONS,
  POOL_DEFINITIONS,
  TOKEN_CATALOG_AS_OF_DATE,
  TOKEN_CATALOG_CONTENT_DIGEST,
  TOKEN_CHAIN_IDS,
  TOKEN_DEPLOYMENTS,
  TOKEN_CATALOG_VERSION,
  dexes,
  pools,
  findPoolDefinitionByAddress,
  findPoolDefinitionsByPair,
  getDexDeployment,
  getNativeWrapDefinition,
  getPoolDefinition,
  listPoolDefinitions,
} as unknown as CaptureSdk)

const loadCaptureSdk = async (): Promise<CaptureSdk> => {
  const captureRequested =
    process.env.ERPC_SDK_DEX_PARITY_OUTPUT !== undefined ||
    process.env.ERPC_SDK_DEX_PARITY_PACKAGE === 'dist'
  if (!captureRequested) {
    return sourceCaptureSdk()
  }
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href
  return await import(moduleUrl) as unknown as CaptureSdk
}

const readCaptureFixture = async <T>(name: string): Promise<T> => {
  const fixtureUrl = new URL(`../../../registry/fixtures/${name}`, import.meta.url)
  return JSON.parse(await readFile(fixtureUrl, 'utf8')) as T
}

const recordId = (
  record: CaptureRecord | undefined,
  key: string,
): string | null => {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

const captureLookupBehavior = (sdk: CaptureSdk): CaptureRecord => {
  const behavior: {
    getDexDeployment: CaptureRecord[]
    getPoolDefinition: CaptureRecord[]
    findPoolDefinitionByAddress: CaptureRecord[]
    findPoolDefinitionsByPair: CaptureRecord[]
    listPoolDefinitions: CaptureRecord[]
    getNativeWrapDefinition: CaptureRecord[]
  } = {
    getDexDeployment: [],
    getPoolDefinition: [],
    findPoolDefinitionByAddress: [],
    findPoolDefinitionsByPair: [],
    listPoolDefinitions: [],
    getNativeWrapDefinition: [],
  }
  for (const dex of sdk.DEX_DEPLOYMENTS) {
    const input = recordId(dex, 'dexDeploymentId') ?? ''
    behavior.getDexDeployment.push({
      input,
      result: recordId(sdk.getDexDeployment(input), 'dexDeploymentId'),
    })
  }
  behavior.getDexDeployment.push({
    input: 'dex-unknown',
    result: recordId(sdk.getDexDeployment('dex-unknown'), 'dexDeploymentId'),
  })

  for (const pool of sdk.POOL_DEFINITIONS) {
    const input = recordId(pool, 'poolDefinitionId') ?? ''
    behavior.getPoolDefinition.push({
      input,
      result: recordId(sdk.getPoolDefinition(input), 'poolDefinitionId'),
    })
  }
  behavior.getPoolDefinition.push({
    input: 'pool-unknown',
    result: recordId(sdk.getPoolDefinition('pool-unknown'), 'poolDefinitionId'),
  })

  for (const pool of sdk.POOL_DEFINITIONS) {
    const chainId = typeof pool.chainId === 'string' ? pool.chainId : ''
    const address = typeof pool.address === 'string' ? pool.address : ''
    behavior.findPoolDefinitionByAddress.push({
      chainId,
      address,
      result: recordId(sdk.findPoolDefinitionByAddress(chainId, address), 'poolDefinitionId'),
    })
    if (chainId.startsWith('eip155:')) {
      behavior.findPoolDefinitionByAddress.push({
        chainId,
        address: `0x${address.slice(2).toUpperCase()}`,
        result: recordId(
          sdk.findPoolDefinitionByAddress(
            chainId,
            `0x${address.slice(2).toUpperCase()}`,
          ),
          'poolDefinitionId',
        ),
      })
    }
  }
  behavior.findPoolDefinitionByAddress.push(
    {
      chainId: sdk.DEX_CHAIN_IDS.ethereum ?? '',
      address: `0x${'0'.repeat(40)}`,
      result: recordId(
        sdk.findPoolDefinitionByAddress(
          sdk.DEX_CHAIN_IDS.ethereum ?? '',
          `0x${'0'.repeat(40)}`,
        ),
        'poolDefinitionId',
      ),
    },
    {
      chainId: sdk.DEX_CHAIN_IDS.ethereum ?? '',
      address: 'not-an-address',
      result: recordId(
        sdk.findPoolDefinitionByAddress(
          sdk.DEX_CHAIN_IDS.ethereum ?? '',
          'not-an-address',
        ),
        'poolDefinitionId',
      ),
    },
    {
      chainId: 'unknown:chain',
      address: '0x0000000000000000000000000000000000000001',
      result: recordId(
        sdk.findPoolDefinitionByAddress(
          'unknown:chain',
          '0x0000000000000000000000000000000000000001',
        ),
        'poolDefinitionId',
      ),
    },
  )

  const pairKey = (pool: CaptureRecord): string =>
    [recordId(pool, 'token0DeploymentId'), recordId(pool, 'token1DeploymentId')]
      .sort()
      .join('\u0000')
  for (const pool of sdk.POOL_DEFINITIONS) {
    const chainId = typeof pool.chainId === 'string' ? pool.chainId : ''
    const token0 = recordId(pool, 'token0DeploymentId') ?? ''
    const token1 = recordId(pool, 'token1DeploymentId') ?? ''
    const result = sdk.POOL_DEFINITIONS.filter(
      (candidate) =>
        candidate.chainId === chainId && pairKey(candidate) === pairKey(pool),
    )
      .map((candidate) => recordId(candidate, 'poolDefinitionId'))
      .filter((id): id is string => id !== null)
      .sort()
    behavior.findPoolDefinitionsByPair.push({
      chainId,
      token0DeploymentId: token0,
      token1DeploymentId: token1,
      result: sdk
        .findPoolDefinitionsByPair(chainId, token0, token1)
        .map((candidate) => recordId(candidate, 'poolDefinitionId'))
        .filter((id): id is string => id !== null),
    })
    behavior.findPoolDefinitionsByPair.push({
      chainId,
      token0DeploymentId: token1,
      token1DeploymentId: token0,
      result: sdk
        .findPoolDefinitionsByPair(chainId, token1, token0)
        .map((candidate) => recordId(candidate, 'poolDefinitionId'))
        .filter((id): id is string => id !== null),
    })
    expect(
      sdk
        .findPoolDefinitionsByPair(chainId, token0, token1)
        .map((candidate) => recordId(candidate, 'poolDefinitionId'))
        .filter((id): id is string => id !== null),
    ).toEqual(result)
  }
  const mismatchedPair = {
    chainId: sdk.DEX_CHAIN_IDS.ethereum ?? '',
    token0DeploymentId: 'deployment-0001',
    token1DeploymentId: 'deployment-0003',
  }
  behavior.findPoolDefinitionsByPair.push({
    ...mismatchedPair,
    result: sdk
      .findPoolDefinitionsByPair(
        mismatchedPair.chainId,
        mismatchedPair.token0DeploymentId,
        mismatchedPair.token1DeploymentId,
      )
      .map((candidate) => recordId(candidate, 'poolDefinitionId'))
      .filter((id): id is string => id !== null),
  })
  behavior.findPoolDefinitionsByPair.push({
    chainId: 'unknown:chain',
    token0DeploymentId: 'deployment-0002',
    token1DeploymentId: 'deployment-0008',
    result: sdk
      .findPoolDefinitionsByPair(
        'unknown:chain',
        'deployment-0002',
        'deployment-0008',
      )
      .map((candidate) => recordId(candidate, 'poolDefinitionId'))
      .filter((id): id is string => id !== null),
  })

  const filters: readonly Record<string, unknown>[] = [
    {},
    ...Object.values(sdk.DEX_CHAIN_IDS).map((chainId) => ({ chainId })),
    ...sdk.POOL_DEFINITIONS.flatMap((pool) => [
      { tokenDeploymentId: recordId(pool, 'token0DeploymentId') ?? '' },
      { tokenDeploymentId: recordId(pool, 'token1DeploymentId') ?? '' },
    ]),
    ...[
      ...new Set(
        sdk.POOL_DEFINITIONS.map((pool) => pool.adapter)
          .filter((adapter): adapter is CaptureRecord => adapter !== null)
          .map((adapter) => recordId(adapter, 'kind'))
          .filter((kind): kind is string => kind !== null),
      ),
    ].map((adapterKind) => ({ adapterKind })),
    ...sdk.POOL_DEFINITIONS.map((pool) => ({
      chainId: pool.chainId,
      tokenDeploymentId: recordId(pool, 'token0DeploymentId') ?? '',
      adapterKind: recordId(pool.adapter as CaptureRecord, 'kind') ?? '',
    })),
    { chainId: 'unknown:chain' },
    { tokenDeploymentId: 'deployment-unknown' },
    { adapterKind: 'unknown-adapter' },
  ]
  for (const filter of filters) {
    behavior.listPoolDefinitions.push({
      filter,
      result: sdk
        .listPoolDefinitions(filter)
        .map((pool) => recordId(pool, 'poolDefinitionId'))
        .filter((id): id is string => id !== null),
    })
  }

  for (const deployment of sdk.TOKEN_DEPLOYMENTS) {
    if (deployment.standard !== 'native') continue
    const input = recordId(deployment, 'deploymentId') ?? ''
    behavior.getNativeWrapDefinition.push({
      input,
      result: recordId(sdk.getNativeWrapDefinition(input), 'nativeWrapDefinitionId'),
    })
  }
  behavior.getNativeWrapDefinition.push(
    {
      input: 'deployment-unknown',
      result: recordId(
        sdk.getNativeWrapDefinition('deployment-unknown'),
        'nativeWrapDefinitionId',
      ),
    },
    {
      input: 'native-wrap-0001',
      result: recordId(
        sdk.getNativeWrapDefinition('native-wrap-0001'),
        'nativeWrapDefinitionId',
      ),
    },
  )
  return behavior as unknown as CaptureRecord
}

const captureAliasBehavior = (sdk: CaptureSdk): readonly CaptureRecord[] =>
  sdk.DEX_ALIASES.map((alias) => {
    const namespace = typeof alias.namespace === 'string' ? alias.namespace : ''
    const name = typeof alias.name === 'string' ? alias.name : ''
    const dexId = recordId(alias, 'dexDeploymentId')
    const group = dexId === null ? sdk.pools : sdk.dexes
    const result = group[namespace]?.[name] ?? null
    return {
      namespace,
      name,
      kind: dexId === null ? 'pool' : 'dex',
      result,
    }
  })

const expectedQuoteOutcome = (
  sdk: CaptureSdk,
  expected: unknown,
): unknown => {
  if (
    expected === null ||
    typeof expected !== 'object' ||
    Array.isArray(expected)
  ) {
    return expected
  }
  const record = expected as CaptureRecord
  if (
    record.kind !== 'success' ||
    record.value === null ||
    typeof record.value !== 'object' ||
    Array.isArray(record.value)
  ) {
    return expected
  }
  return {
    ...record,
    value: {
      ...(record.value as CaptureRecord),
      tokenCatalogDigest: sdk.TOKEN_CATALOG_CONTENT_DIGEST,
      dexCatalogDigest: sdk.DEX_CATALOG_CONTENT_DIGEST,
    },
  }
}

const captureQuoteBehavior = async (
  sdk: CaptureSdk,
  fixture: QuoteFixture,
): Promise<readonly CaptureRecord[]> => {
  const cases = [
    ...fixture.validCases,
    ...fixture.invalidCases,
    ...fixture.rpcCases,
    ...fixture.arithmeticCases,
  ].filter((entry) => entry.applicability !== 'language-local')
  const captured: CaptureRecord[] = []
  vi.useFakeTimers()
  try {
    for (const entry of cases) {
      vi.setSystemTime(entry.nowSeconds * 1000)
      const requests: RpcRequest[] = []
      let responseIndex = 0
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as RpcRequest
        requests.push(request)
        if (entry.mutation === 'throwSourceError') {
          throw new Error('upstream transport detail')
        }
        const result = entry.rpcResponses[responseIndex]
        responseIndex += 1
        if (result === undefined) {
          throw new Error(`fixture has no response for ${request.method}`)
        }
        return response(request, result)
      }
      const client = sdk.createErpcClient({ apiKey: 'capture-secret', fetch })
      let outcome: CaptureRecord
      try {
        if (entry.mutation === 'abortBeforeRequest') {
          const controller = new AbortController()
          controller.abort(new Error('caller cancelled'))
          await client.swap.quoteExactInput(entry.request, {
            signal: controller.signal,
          })
          throw new Error(`fixture ${entry.caseId} unexpectedly succeeded`)
        }
        const value = await client.swap.quoteExactInput(entry.request)
        outcome = { kind: 'success', value: jsonClone(value) }
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'SwapQuoteError' &&
          typeof (error as { readonly code?: unknown }).code === 'string'
        ) {
          outcome = {
            kind: 'sdk-error',
            code: (error as unknown as { readonly code: string }).code,
          }
        } else {
          outcome = { kind: 'transport-error', sourcePreserved: true }
        }
      } finally {
        client.close()
      }
      const trace = requests.map(({ method, params }) => ({
        method,
        params: params ?? [],
      }))
      expect(outcome).toEqual(expectedQuoteOutcome(sdk, entry.outcome))
      expect(responseIndex).toBe(entry.rpcResponses.length)
      expect(trace).toEqual(entry.rpcTrace)
      captured.push({ caseId: entry.caseId, outcome, rpcTrace: trace })
    }
  } finally {
    vi.useRealTimers()
  }
  return captured
}

const captureNativeSnapshot = async (
  sdk: CaptureSdk,
  quoteFixture: QuoteFixture,
): Promise<CaptureRecord> => {
  const lookupBehavior = captureLookupBehavior(sdk)
  const behavior = {
    ...lookupBehavior,
    alias: captureAliasBehavior(sdk),
    quote: await captureQuoteBehavior(sdk, quoteFixture),
  }
  return {
    snapshotVersion: 1,
    snapshotKind: 'native-runtime',
    language: 'typescript',
    runtime:
      process.env.ERPC_SDK_DEX_PARITY_OUTPUT !== undefined ||
      process.env.ERPC_SDK_DEX_PARITY_PACKAGE === 'dist'
        ? `typescript-built-dist-${process.version}`
        : `typescript-source-${process.version}`,
    metadata: {
      version: sdk.TOKEN_CATALOG_VERSION,
      asOfDate: sdk.TOKEN_CATALOG_AS_OF_DATE,
      contentDigest: sdk.TOKEN_CATALOG_CONTENT_DIGEST,
      chainIds: {
        ethereum: sdk.TOKEN_CHAIN_IDS.ethereumMainnet,
        solana: sdk.TOKEN_CHAIN_IDS.solanaMainnet,
        avalancheC: sdk.TOKEN_CHAIN_IDS.avalancheCMainnet,
      },
    },
    dexMetadata: {
      version: sdk.DEX_CATALOG_VERSION,
      asOfDate: sdk.DEX_CATALOG_AS_OF_DATE,
      contentDigest: sdk.DEX_CATALOG_CONTENT_DIGEST,
    },
    dexDeployments: jsonClone(sdk.DEX_DEPLOYMENTS),
    poolDefinitions: jsonClone(sdk.POOL_DEFINITIONS),
    nativeWrapDefinitions: jsonClone(sdk.NATIVE_WRAP_DEFINITIONS),
    aliases: jsonClone(sdk.DEX_ALIASES),
    behavior,
  }
}


describe('RPC-only swap quotes', () => {
  it('performs the exact EVM read sequence and computes a decimal quote', async () => {
    const requests: RpcRequest[] = []
    const now = Math.floor(Date.now() / 1000)
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: mockRpcFetch(requests, { now }),
    })

    await expect(client.swap.quoteExactInput(ethereumRequest())).resolves.toEqual({
      quoteKind: 'exact-input',
      chainId: DEX_CHAIN_IDS.ethereum,
      poolDefinitionId: 'pool-0001',
      dexDeploymentId: 'dex-deployment-0001',
      adapterKind: 'evm-constant-product-v2',
      inputTokenDeploymentId: 'deployment-0002',
      outputTokenDeploymentId: 'deployment-0008',
      amountIn: '1000000000000000000',
      amountOut: '2393866186',
      fee: { numerator: '3', denominator: '1000' },
      snapshot: {
        kind: 'evm-block',
        blockNumber: '25984800',
        blockHash: ETH_HASH,
        blockTimestamp: String(now),
      },
      tokenCatalogDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dexCatalogDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(requests).toHaveLength(11)
    expect(requests.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getCode',
      'eth_call',
      'eth_call',
      'eth_call',
      'eth_call',
      'eth_call',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ])
    expect(requests[1]?.params).toEqual(['latest', false])
    expect(requests[2]?.params?.[1]).toEqual({
      blockHash: ETH_HASH,
      requireCanonical: true,
    })
    expect(requests[8]?.params?.[1]).toEqual({
      blockHash: ETH_HASH,
      requireCanonical: true,
    })
    expect(requests[10]?.params).toEqual([ETH_BLOCK, false])
    client.close()
  })

  it('routes Avalanche quotes to the C-Chain transport', async () => {
    const requests: RpcRequest[] = []
    const now = Math.floor(Date.now() / 1000)
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: mockRpcFetch(requests, { now }),
    })
    await expect(client.swap.quoteExactInput({
      chainId: AVALANCHE_CHAIN_ID,
      poolDefinitionId: 'pool-0002',
      inputTokenDeploymentId: 'deployment-0004',
      outputTokenDeploymentId: 'deployment-0009',
      amountIn: '1000000000000000000',
    })).resolves.toMatchObject({
      amountOut: '7329527',
      snapshot: { blockNumber: '95366316' },
    })
    expect(requests).toHaveLength(11)
    client.close()
  })

  it('uses a keyless direct Ethereum endpoint for every quote read', async () => {
    const requests: RpcRequest[] = []
    const urls: string[] = []
    const directUrl = 'https://customer.example/customer/path?token=a%2Fb&region=eu'
    const now = Math.floor(Date.now() / 1000)
    const rpcFetch = mockRpcFetch(requests, { now, chain: 'ethereum' })
    const client = createErpcClient({
      ethereumRpc: { httpUrl: directUrl },
      fetch: async (input, init) => {
        urls.push(String(input))
        return rpcFetch(input, init)
      },
    })

    await expect(client.swap.quoteExactInput(ethereumRequest())).resolves.toMatchObject({
      amountOut: '2393866186',
      chainId: DEX_CHAIN_IDS.ethereum,
    })
    expect(requests).toHaveLength(11)
    expect(urls).toHaveLength(11)
    expect(new Set(urls)).toEqual(new Set([directUrl]))
    expect(urls.every((url) => !url.includes('api-key='))).toBe(true)
    client.close()
  })

  it('uses a keyless direct Avalanche C endpoint for every quote read and preserves chain mismatch', async () => {
    const requests: RpcRequest[] = []
    const urls: string[] = []
    const directUrl = 'https://customer.example/customer/path?token=a%2Fb&region=eu'
    const now = Math.floor(Date.now() / 1000)
    const rpcFetch = mockRpcFetch(requests, { now, chain: 'avalancheC' })
    const client = createErpcClient({
      avalancheCRpc: { httpUrl: directUrl },
      fetch: async (input, init) => {
        urls.push(String(input))
        return rpcFetch(input, init)
      },
    })

    await expect(client.swap.quoteExactInput({
      chainId: AVALANCHE_CHAIN_ID,
      poolDefinitionId: 'pool-0002',
      inputTokenDeploymentId: 'deployment-0004',
      outputTokenDeploymentId: 'deployment-0009',
      amountIn: '1000000000000000000',
    })).resolves.toMatchObject({
      amountOut: '7329527',
      chainId: AVALANCHE_CHAIN_ID,
    })
    expect(requests).toHaveLength(11)
    expect(urls).toHaveLength(11)
    expect(new Set(urls)).toEqual(new Set([directUrl]))
    expect(urls.every((url) => !url.includes('api-key='))).toBe(true)
    client.close()

    const mismatchRequests: RpcRequest[] = []
    const mismatchFetch = mockRpcFetch(mismatchRequests, {
      now,
      chain: 'avalancheC',
    })
    const mismatchClient = createErpcClient({
      ethereumRpc: { httpUrl: directUrl },
      fetch: mismatchFetch,
    })
    await expect(
      mismatchClient.swap.quoteExactInput(ethereumRequest()),
    ).rejects.toMatchObject({ code: 'SWAP_CHAIN_MISMATCH' })
    expect(mismatchRequests).toHaveLength(1)
    mismatchClient.close()
  })

  it('snapshots request scalars before awaiting RPC and freezes the result', async () => {
    const requests: RpcRequest[] = []
    const now = Math.floor(Date.now() / 1000)
    const request = {
      ...ethereumRequest(),
      freshness: {
        maxBlockAgeSeconds: 120,
        maxBlockLag: 3,
        maxClockSkewSeconds: 5,
      },
    }
    let mutated = false
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: async (input, init) => {
        if (!mutated) {
          mutated = true
          request.poolDefinitionId = 'pool-0002'
          request.amountIn = '1'
          request.freshness.maxBlockAgeSeconds = 0
        }
        return mockRpcFetch(requests, { now })(input, init)
      },
    })
    const quote = await client.swap.quoteExactInput(request)
    expect(quote.poolDefinitionId).toBe('pool-0001')
    expect(quote.amountIn).toBe('1000000000000000000')
    expect(Object.isFrozen(quote)).toBe(true)
    expect(Object.isFrozen(quote.fee)).toBe(true)
    expect(Object.isFrozen(quote.snapshot)).toBe(true)
    client.close()

    const staleRequests: RpcRequest[] = []
    const staleRequest = {
      ...ethereumRequest(),
      freshness: {
        maxBlockAgeSeconds: 0,
        maxBlockLag: 3,
        maxClockSkewSeconds: 5,
      },
    }
    let staleMutated = false
    const staleClient = createErpcClient({
      apiKey: 'quote-secret',
      fetch: async (input, init) => {
        if (!staleMutated) {
          staleMutated = true
          staleRequest.freshness.maxBlockAgeSeconds = 86400
        }
        return mockRpcFetch(staleRequests, {
          now,
          latestTimestamp: now - 1,
        })(input, init)
      },
    })
    await expect(
      staleClient.swap.quoteExactInput(staleRequest),
    ).rejects.toMatchObject({ code: 'SWAP_STATE_STALE' })
    staleClient.close()
  })

  it('rejects catalog and token errors before making any RPC call', async () => {
    let calls = 0
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: async () => {
        calls += 1
        throw new Error('RPC must not be called')
      },
    })
    const expectCode = async (
      request: ExactInputQuoteRequest,
      code: SwapQuoteError['code'],
    ) => {
      await expect(client.swap.quoteExactInput(request)).rejects.toMatchObject({ code })
    }
    await expectCode(ethereumRequest({ chainId: 'eip155:999' }), 'SWAP_UNSUPPORTED_CHAIN')
    await expectCode(ethereumRequest({ inputTokenDeploymentId: 'deployment-0001' }), 'SWAP_UNSUPPORTED_TOKEN_STANDARD')
    await expectCode({
      chainId: SOLANA_CHAIN_ID,
      poolDefinitionId: 'pool-0003',
      inputTokenDeploymentId: 'deployment-0006',
      outputTokenDeploymentId: 'deployment-0013',
      amountIn: '1',
    }, 'SWAP_UNSUPPORTED_ADAPTER')
    await expectCode(ethereumRequest({ amountIn: '01' }), 'SWAP_INVALID_ARGUMENT')
    expect(calls).toBe(0)
    client.close()
  })

  it('gives stale headers precedence over malformed state and detects reorgs', async () => {
    const now = Math.floor(Date.now() / 1000)
    const staleRequests: RpcRequest[] = []
    const staleClient = createErpcClient({
      apiKey: 'quote-secret',
      fetch: mockRpcFetch(staleRequests, {
        now,
        latestTimestamp: now - 1000,
        malformedFactoryCode: true,
      }),
    })
    await expect(staleClient.swap.quoteExactInput(ethereumRequest())).rejects.toMatchObject({
      code: 'SWAP_STATE_STALE',
    })
    staleClient.close()

    const reorgRequests: RpcRequest[] = []
    const reorgClient = createErpcClient({
      apiKey: 'quote-secret',
      fetch: mockRpcFetch(reorgRequests, {
        now,
        secondLatestHash: `0x${'f'.repeat(64)}`,
      }),
    })
    await expect(reorgClient.swap.quoteExactInput(ethereumRequest())).rejects.toMatchObject({
      code: 'SWAP_STATE_STALE',
    })
    reorgClient.close()
  })

  it('keeps the transport error class and safe message', async () => {
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: async () => {
        throw new Error('credential=quote-secret upstream detail')
      },
    })
    await expect(client.swap.quoteExactInput(ethereumRequest())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ErpcTransportError &&
        error.message === 'Unable to reach ERPC' &&
        !error.message.includes('quote-secret'),
    )
    client.close()
  })

  it('preserves an already-aborted caller signal without starting an RPC read', async () => {
    let calls = 0
    const client = createErpcClient({
      apiKey: 'quote-secret',
      fetch: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    const controller = new AbortController()
    const source = new Error('caller cancelled')
    controller.abort(source)
    await expect(
      client.swap.quoteExactInput(ethereumRequest(), {
        signal: controller.signal,
      }),
    ).rejects.toBe(source)
    expect(calls).toBe(0)
    client.close()
  })

  it('captures native DEX parity only when the CI output path is configured', async () => {
    const outputPath = process.env.ERPC_SDK_DEX_PARITY_OUTPUT
    if (!outputPath) return
    const sdk = await loadCaptureSdk()
    const quoteFixture = await readCaptureFixture<QuoteFixture>('swap-quote-cases.json')
    const snapshot = await captureNativeSnapshot(sdk, quoteFixture)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    expect(outputPath.length).toBeGreaterThan(0)
  })
})
