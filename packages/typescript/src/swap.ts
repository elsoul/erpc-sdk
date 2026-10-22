import {
  DEX_CATALOG_CONTENT_DIGEST,
  DEX_CHAIN_IDS,
  NATIVE_WRAP_DEFINITIONS,
  getDexDeployment,
  getPoolDefinition,
  type DexDeployment,
  type PoolDefinition,
} from './dex_catalog'
import {
  getTokenDeployment,
  TOKEN_CATALOG_CONTENT_DIGEST,
  type TokenDeployment,
} from './token_catalog'
import {
  SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
  SWAP_EXECUTION_CAPABILITIES_JSON,
  SWAP_EXECUTION_FUNCTION_SELECTOR,
  SWAP_EXECUTION_FUNCTION_SIGNATURE,
} from './generated/swap_execution_capabilities'
import { ErpcJsonRpcError } from './errors'
import type { HttpJsonRpcTransport } from './transport/http'
import type { RpcSendOptions } from './rpc/types'

export type SwapQuoteErrorCode =
  | 'SWAP_INVALID_ARGUMENT'
  | 'SWAP_UNSUPPORTED_CHAIN'
  | 'SWAP_UNKNOWN_POOL'
  | 'SWAP_UNKNOWN_TOKEN'
  | 'SWAP_TOKEN_NOT_ACTIVE'
  | 'SWAP_UNSUPPORTED_TOKEN_STANDARD'
  | 'SWAP_UNSUPPORTED_ADAPTER'
  | 'SWAP_UNSUPPORTED_TOKEN'
  | 'SWAP_CHAIN_MISMATCH'
  | 'SWAP_POOL_TOKEN_MISMATCH'
  | 'SWAP_PROGRAM_MISMATCH'
  | 'SWAP_INVALID_POOL_STATE'
  | 'SWAP_STATE_STALE'
  | 'SWAP_INSUFFICIENT_LIQUIDITY'
  | 'SWAP_ARITHMETIC'

export const SWAP_QUOTE_ERROR_MESSAGES: Readonly<
  Record<SwapQuoteErrorCode, string>
> = Object.freeze({
  SWAP_INVALID_ARGUMENT: 'Swap request is invalid',
  SWAP_UNSUPPORTED_CHAIN: 'Swap chain is unsupported',
  SWAP_UNKNOWN_POOL: 'Swap pool is unknown',
  SWAP_UNKNOWN_TOKEN: 'Swap token is unknown',
  SWAP_TOKEN_NOT_ACTIVE: 'Swap token is not active',
  SWAP_UNSUPPORTED_TOKEN_STANDARD: 'Swap token standard is unsupported',
  SWAP_UNSUPPORTED_ADAPTER: 'Swap adapter is unsupported',
  SWAP_UNSUPPORTED_TOKEN: 'Swap token is unsupported for the selected pool',
  SWAP_CHAIN_MISMATCH: 'Swap chain does not match the selected records',
  SWAP_POOL_TOKEN_MISMATCH: 'Swap pool tokens do not match the request',
  SWAP_PROGRAM_MISMATCH: 'Swap program does not match the selected records',
  SWAP_INVALID_POOL_STATE: 'Swap pool state is invalid',
  SWAP_STATE_STALE: 'Swap pool state is stale',
  SWAP_INSUFFICIENT_LIQUIDITY: 'Swap pool liquidity is insufficient',
  SWAP_ARITHMETIC: 'Swap arithmetic overflowed or produced an invalid result',
})

export class SwapQuoteError extends Error {
  readonly code: SwapQuoteErrorCode

  constructor(code: SwapQuoteErrorCode) {
    super(SWAP_QUOTE_ERROR_MESSAGES[code])
    this.name = 'SwapQuoteError'
    this.code = code
  }
}

export type SwapExecutionErrorCode =
  | 'SWAP_EXECUTION_INVALID_ARGUMENT'
  | 'SWAP_UNSUPPORTED_EXECUTION'
  | 'SWAP_PROGRAM_MISMATCH'
  | 'SWAP_INSUFFICIENT_ALLOWANCE'
  | 'SWAP_SIMULATION_REVERTED'
  | 'SWAP_INVALID_SIMULATION'

export const SWAP_EXECUTION_ERROR_MESSAGES: Readonly<
  Record<SwapExecutionErrorCode, string>
> = Object.freeze({
  SWAP_EXECUTION_INVALID_ARGUMENT: 'Swap execution request is invalid',
  SWAP_UNSUPPORTED_EXECUTION:
    'Swap execution is unsupported for the selected records',
  SWAP_PROGRAM_MISMATCH: 'Swap program does not match the selected records',
  SWAP_INSUFFICIENT_ALLOWANCE: 'Swap allowance is insufficient',
  SWAP_SIMULATION_REVERTED: 'Swap simulation reverted',
  SWAP_INVALID_SIMULATION: 'Swap simulation result is invalid',
})

export class SwapExecutionError extends Error {
  readonly code: SwapExecutionErrorCode

  constructor(code: SwapExecutionErrorCode) {
    super(SWAP_EXECUTION_ERROR_MESSAGES[code])
    this.name = 'SwapExecutionError'
    this.code = code
  }
}

export interface SwapFreshness {
  readonly maxBlockAgeSeconds?: number
  readonly maxBlockLag?: number
  readonly maxClockSkewSeconds?: number
}

export interface ExactInputQuoteRequest {
  readonly chainId: string
  readonly poolDefinitionId: string
  readonly inputTokenDeploymentId: string
  readonly outputTokenDeploymentId: string
  readonly amountIn: string
  readonly freshness?: SwapFreshness
}

export interface ExactInputQuoteResult {
  readonly quoteKind: 'exact-input'
  readonly chainId: string
  readonly poolDefinitionId: string
  readonly dexDeploymentId: string
  readonly adapterKind: string
  readonly inputTokenDeploymentId: string
  readonly outputTokenDeploymentId: string
  readonly amountIn: string
  readonly amountOut: string
  readonly fee: {
    readonly numerator: string
    readonly denominator: string
  }
  readonly snapshot: {
    readonly kind: 'evm-block'
    readonly blockNumber: string
    readonly blockHash: string
    readonly blockTimestamp: string
  }
  readonly tokenCatalogDigest: string
  readonly dexCatalogDigest: string
}

export interface PrepareExactInputSwapRequest extends ExactInputQuoteRequest {
  readonly sender: string
  readonly recipient: string
  readonly slippageBps: number
  readonly deadline: string
}

/** Alias for callers that prefer a shorter execution request name. */
export type ExactInputSwapRequest = PrepareExactInputSwapRequest

export interface ExactInputSwapPathEntry {
  readonly tokenDeploymentId: string
  readonly address: string
  readonly standard: 'erc20'
  readonly representationKind: TokenDeployment['representationKind']
}

export interface ExactInputSwapPreparation {
  readonly preparationKind: 'evm-router-v2-exact-input'
  readonly executionCapabilityId: string
  readonly executionCapabilityDigest: string
  readonly quote: ExactInputQuoteResult
  readonly minimumAmountOut: string
  readonly slippageBps: number
  readonly deadline: string
  readonly recipient: string
  readonly path: readonly [ExactInputSwapPathEntry, ExactInputSwapPathEntry]
  readonly transaction: {
    readonly kind: 'evm-unsigned-transaction'
    readonly chainId: string
    readonly from: string
    readonly to: string
    readonly data: string
    readonly value: '0'
  }
  readonly allowance: {
    readonly tokenDeploymentId: string
    readonly tokenAddress: string
    readonly owner: string
    readonly spender: string
    readonly requiredAmount: string
  }
}

export interface ExactInputSwapSimulation {
  readonly simulationKind: 'evm-call'
  readonly preparation: ExactInputSwapPreparation
  readonly snapshot: ExactInputQuoteResult['snapshot']
  readonly currentAllowance: string
  readonly amounts: readonly [string, string]
  readonly amountOut: string
}

/** Alias for callers that prefer the method-name result spelling. */
export type PrepareExactInputSwapResult = ExactInputSwapPreparation

/** Alias for callers that use the generic preparation name. */
export type SwapPreparation = ExactInputSwapPreparation

/** Alias for callers that prefer the method-name result spelling. */
export type SimulateExactInputSwapResult = ExactInputSwapSimulation

/** Alias for callers that use the generic simulation name. */
export type SwapSimulation = ExactInputSwapSimulation

export interface SwapClient {
  readonly quoteExactInput: (
    request: ExactInputQuoteRequest,
    options?: RpcSendOptions,
  ) => Promise<ExactInputQuoteResult>
  readonly prepareExactInputSwap: (
    request: PrepareExactInputSwapRequest,
    options?: RpcSendOptions,
  ) => Promise<ExactInputSwapPreparation>
  readonly simulateExactInputSwap: (
    request: PrepareExactInputSwapRequest,
    options?: RpcSendOptions,
  ) => Promise<ExactInputSwapSimulation>
}

interface SwapClientOptions {
  readonly ethereum: HttpJsonRpcTransport
  readonly avalanche: HttpJsonRpcTransport
  /** Test-only clock injection. Deliberately not exposed by createErpcClient. */
  readonly clock?: () => number
}

interface NormalizedFreshness {
  readonly maxBlockAgeSeconds: number
  readonly maxBlockLag: number
  readonly maxClockSkewSeconds: number
}

interface NormalizedRequest {
  readonly request: {
    readonly chainId: string
    readonly poolDefinitionId: string
    readonly inputTokenDeploymentId: string
    readonly outputTokenDeploymentId: string
    readonly amountIn: string
    readonly freshness: NormalizedFreshness
  }
  readonly amountIn: bigint
  readonly pool: PoolDefinition
  readonly dex: DexDeployment
  readonly input: TokenDeployment
  readonly output: TokenDeployment
  readonly freshness: NormalizedFreshness
}

interface Header {
  readonly number: bigint
  readonly hash: string
  readonly timestamp: bigint
}

interface Reserves {
  readonly reserve0: bigint
  readonly reserve1: bigint
}

interface EvmState {
  readonly initial: Header
  readonly latestAfterReads: Header
  readonly reserves: Reserves
}

const SUPPORTED_QUOTE_ADAPTER = 'evm-constant-product-v2'

interface SupportedQuoteCapability {
  readonly chainId: string
  readonly dexDeploymentId: string
  readonly factoryAddress: string
  readonly poolDefinitionId: string
  readonly poolAddress: string
  readonly token0DeploymentId: string
  readonly token0Address: string
  readonly token0Decimals: number
  readonly token0Standard: 'erc20'
  readonly token1DeploymentId: string
  readonly token1Address: string
  readonly token1Decimals: number
  readonly token1Standard: 'erc20'
  readonly adapterKind: typeof SUPPORTED_QUOTE_ADAPTER
  readonly feeNumerator: string
  readonly feeDenominator: string
}

// Swap eligibility is deliberately a handwritten, reviewed boundary. Catalog
// growth can add lookup and ranking records without granting RPC quote access.
const SUPPORTED_QUOTE_CAPABILITIES: readonly SupportedQuoteCapability[] =
  Object.freeze([
    Object.freeze({
      chainId: 'eip155:1',
      dexDeploymentId: 'dex-deployment-0001',
      factoryAddress: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
      poolDefinitionId: 'pool-0001',
      poolAddress: '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc',
      token0DeploymentId: 'deployment-0008',
      token0Address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      token0Decimals: 6,
      token0Standard: 'erc20',
      token1DeploymentId: 'deployment-0002',
      token1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      token1Decimals: 18,
      token1Standard: 'erc20',
      adapterKind: SUPPORTED_QUOTE_ADAPTER,
      feeNumerator: '3',
      feeDenominator: '1000',
    }),
    Object.freeze({
      chainId: 'eip155:43114',
      dexDeploymentId: 'dex-deployment-0002',
      factoryAddress: '0x9ad6c38be94206ca50bb0d90783181662f0cfa10',
      poolDefinitionId: 'pool-0002',
      poolAddress: '0xf4003f4efbe8691b60249e6afbd307abe7758adb',
      token0DeploymentId: 'deployment-0004',
      token0Address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      token0Decimals: 18,
      token0Standard: 'erc20',
      token1DeploymentId: 'deployment-0009',
      token1Address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      token1Decimals: 6,
      token1Standard: 'erc20',
      adapterKind: SUPPORTED_QUOTE_ADAPTER,
      feeNumerator: '3',
      feeDenominator: '1000',
    }),
  ])

const matchesSupportedQuoteCapability = (
  pool: PoolDefinition,
  dex: DexDeployment,
  input: TokenDeployment,
  output: TokenDeployment,
): boolean => {
  const capability = SUPPORTED_QUOTE_CAPABILITIES.find(
    (entry) => entry.poolDefinitionId === pool.poolDefinitionId,
  )
  if (!capability) return false
  if (
    input.representationKind === 'unclassified' ||
    output.representationKind === 'unclassified'
  ) {
    return false
  }

  const matchesToken = (
    token: TokenDeployment,
    deploymentId: string,
    address: string,
    decimals: number,
    standard: 'erc20',
  ): boolean =>
    token.chainId === capability.chainId &&
    token.deploymentId === deploymentId &&
    token.address === address &&
    token.decimals === decimals &&
    token.standard === standard

  return (
    pool.chainId === capability.chainId &&
    pool.dexDeploymentId === capability.dexDeploymentId &&
    pool.address === capability.poolAddress &&
    pool.token0DeploymentId === capability.token0DeploymentId &&
    pool.token1DeploymentId === capability.token1DeploymentId &&
    dex.chainId === capability.chainId &&
    dex.dexDeploymentId === capability.dexDeploymentId &&
    dex.programAddress === capability.factoryAddress &&
    dex.adapterKind === capability.adapterKind &&
    pool.adapter.kind === capability.adapterKind &&
    pool.adapter.feeNumerator === capability.feeNumerator &&
    pool.adapter.feeDenominator === capability.feeDenominator &&
    (matchesToken(
      input,
      capability.token0DeploymentId,
      capability.token0Address,
      capability.token0Decimals,
      capability.token0Standard,
    ) ||
      matchesToken(
        input,
        capability.token1DeploymentId,
        capability.token1Address,
        capability.token1Decimals,
        capability.token1Standard,
      )) &&
    (matchesToken(
      output,
      capability.token0DeploymentId,
      capability.token0Address,
      capability.token0Decimals,
      capability.token0Standard,
    ) ||
      matchesToken(
        output,
        capability.token1DeploymentId,
        capability.token1Address,
        capability.token1Decimals,
        capability.token1Standard,
      ))
  )
}
const DEFAULT_FRESHNESS: NormalizedFreshness = Object.freeze({
  maxBlockAgeSeconds: 120,
  maxBlockLag: 3,
  maxClockSkewSeconds: 5,
})
const UINT256_MAX = (1n << 256n) - 1n
const UINT112_MAX = (1n << 112n) - 1n
const UINT32_MAX = (1n << 32n) - 1n
const UINT256_DECIMAL = /^[1-9][0-9]*$/u
const NONNEGATIVE_DECIMAL = /^(0|[1-9][0-9]*)$/u
const HEX_BYTES = /^0x[0-9a-fA-F]*$/u
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u

const FACTORY_GET_PAIR_SELECTOR = '0xe6a43905'
const PAIR_FACTORY_SELECTOR = '0xc45a0155'
const PAIR_TOKEN0_SELECTOR = '0x0dfe1681'
const PAIR_TOKEN1_SELECTOR = '0xd21220a7'
const PAIR_GET_RESERVES_SELECTOR = '0x0902f1ac'

const ROUTER_FACTORY_SELECTOR = '0xc45a0155'
const ROUTER_GET_AMOUNTS_OUT_SELECTOR = '0xd06ca61f'
const ERC20_ALLOWANCE_SELECTOR = '0xdd62ed3e'

interface SwapExecutionCapability {
  readonly swapExecutionCapabilityId: string
  readonly chainId: string
  readonly dexDeploymentId: string
  readonly poolDefinitionId: string
  readonly factoryAddress: string
  readonly routerAddress: string
  readonly routerKind: string
  readonly adapterKind: string
  readonly token0DeploymentId: string
  readonly token0Address: string
  readonly token0Standard: 'erc20'
  readonly token1DeploymentId: string
  readonly token1Address: string
  readonly token1Standard: 'erc20'
  readonly wrappedNativeTokenDeploymentId: string
  readonly wrappedNativeTokenAddress: string
  readonly wrappedNativeFunctionSelector: string
  readonly functionKind: string
  readonly functionSignature: string
  readonly functionSelector: string
  readonly status: 'active'
}

interface ExecutionRequestSnapshot {
  readonly quoteRequest: ExactInputQuoteRequest
  readonly sender: unknown
  readonly recipient: unknown
  readonly slippageBps: unknown
  readonly deadline: unknown
}

interface NormalizedExecutionRequest {
  readonly normalized: NormalizedRequest
  readonly sender: string
  readonly recipient: string
  readonly slippageBps: number
  readonly deadline: string
  readonly deadlineValue: bigint
}

interface PreparedExecutionContext {
  readonly normalized: NormalizedExecutionRequest
  readonly capability: SwapExecutionCapability
  readonly transport: HttpJsonRpcTransport
  readonly state: EvmState
  readonly quote: ExactInputQuoteResult
  readonly preparation: ExactInputSwapPreparation
}

function swapFail(code: SwapQuoteErrorCode): never {
  throw new SwapQuoteError(code)
}

function executionFail(code: SwapExecutionErrorCode): never {
  throw new SwapExecutionError(code)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isKnownChain = (value: unknown): value is string =>
  value === DEX_CHAIN_IDS.ethereum ||
  value === DEX_CHAIN_IDS.solana ||
  value === DEX_CHAIN_IDS.avalancheC

const isOpaqueId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)

function assertRequestShape(
  request: unknown,
): asserts request is ExactInputQuoteRequest {
  if (!isRecord(request)) swapFail('SWAP_INVALID_ARGUMENT')
  const allowed = new Set([
    'chainId',
    'poolDefinitionId',
    'inputTokenDeploymentId',
    'outputTokenDeploymentId',
    'amountIn',
    'freshness',
  ])
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    swapFail('SWAP_INVALID_ARGUMENT')
  }

  for (const key of [
    'chainId',
    'poolDefinitionId',
    'inputTokenDeploymentId',
    'outputTokenDeploymentId',
    'amountIn',
  ] as const) {
    const value = request[key]
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      swapFail('SWAP_INVALID_ARGUMENT')
    }
  }

  for (const key of [
    'poolDefinitionId',
    'inputTokenDeploymentId',
    'outputTokenDeploymentId',
  ] as const) {
    const value = request[key]
    if (typeof value !== 'string' || !isOpaqueId(value)) {
      swapFail('SWAP_INVALID_ARGUMENT')
    }
  }
}

const normalizeFreshness = (value: unknown): NormalizedFreshness => {
  if (value === undefined) return DEFAULT_FRESHNESS
  if (!isRecord(value)) swapFail('SWAP_INVALID_ARGUMENT')
  const keys = [
    'maxBlockAgeSeconds',
    'maxBlockLag',
    'maxClockSkewSeconds',
  ] as const
  if (Object.keys(value).some((key) => !keys.includes(key as (typeof keys)[number]))) {
    swapFail('SWAP_INVALID_ARGUMENT')
  }
  const ranges = {
    maxBlockAgeSeconds: [0, 86400],
    maxBlockLag: [0, 1024],
    maxClockSkewSeconds: [0, 300],
  } as const
  const result: Record<(typeof keys)[number], number> = {
    maxBlockAgeSeconds: DEFAULT_FRESHNESS.maxBlockAgeSeconds,
    maxBlockLag: DEFAULT_FRESHNESS.maxBlockLag,
    maxClockSkewSeconds: DEFAULT_FRESHNESS.maxClockSkewSeconds,
  }
  for (const key of keys) {
    const current = Object.hasOwn(value, key)
      ? value[key]
      : DEFAULT_FRESHNESS[key]
    const [minimum, maximum] = ranges[key]
    if (
      typeof current !== 'number' ||
      !Number.isSafeInteger(current) ||
      current < minimum ||
      current > maximum
    ) {
      swapFail('SWAP_INVALID_ARGUMENT')
    }
    result[key] = current
  }
  return Object.freeze(result)
}

const parseAmountIn = (value: string): bigint => {
  if (!UINT256_DECIMAL.test(value) || value.length > 78) {
    swapFail('SWAP_INVALID_ARGUMENT')
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    swapFail('SWAP_INVALID_ARGUMENT')
  }
  if (parsed <= 0n || parsed > UINT256_MAX) {
    swapFail('SWAP_INVALID_ARGUMENT')
  }
  return parsed
}

const normalizeQuoteRequest = (request: unknown): NormalizedRequest => {
  assertRequestShape(request)
  const freshness = normalizeFreshness(request.freshness)
  const amountIn = parseAmountIn(request.amountIn)

  if (!isKnownChain(request.chainId)) swapFail('SWAP_UNSUPPORTED_CHAIN')
  const pool = getPoolDefinition(request.poolDefinitionId)
  if (!pool) swapFail('SWAP_UNKNOWN_POOL')
  if (pool.chainId !== request.chainId) swapFail('SWAP_CHAIN_MISMATCH')
  if (pool.status !== 'active') swapFail('SWAP_INVALID_POOL_STATE')
  const dex = getDexDeployment(pool.dexDeploymentId)
  if (!dex || dex.status !== 'active') swapFail('SWAP_INVALID_POOL_STATE')

  const input = getTokenDeployment(request.inputTokenDeploymentId)
  if (!input) swapFail('SWAP_UNKNOWN_TOKEN')
  const output = getTokenDeployment(request.outputTokenDeploymentId)
  if (!output) swapFail('SWAP_UNKNOWN_TOKEN')
  if (input.chainId !== request.chainId || output.chainId !== request.chainId) {
    swapFail('SWAP_CHAIN_MISMATCH')
  }
  for (const token of [input, output]) {
    if (token.status !== 'active') swapFail('SWAP_TOKEN_NOT_ACTIVE')
  }
  // Native and Token-2022 records are rejected before any address/pool RPC.
  // Classic SPL records continue to the adapter gate so their failure is
  // deterministic and costs zero RPC calls.
  for (const token of [input, output]) {
    if (token.standard !== 'erc20' && token.standard !== 'spl-token') {
      swapFail('SWAP_UNSUPPORTED_TOKEN_STANDARD')
    }
  }
  if (request.inputTokenDeploymentId === request.outputTokenDeploymentId) {
    swapFail('SWAP_POOL_TOKEN_MISMATCH')
  }
  const wanted = [request.inputTokenDeploymentId, request.outputTokenDeploymentId]
    .sort()
    .join('\u0000')
  const actual = [pool.token0DeploymentId, pool.token1DeploymentId]
    .sort()
    .join('\u0000')
  if (wanted !== actual) swapFail('SWAP_POOL_TOKEN_MISMATCH')
  if (pool.adapter.kind !== SUPPORTED_QUOTE_ADAPTER || dex.adapterKind !== SUPPORTED_QUOTE_ADAPTER) {
    swapFail('SWAP_UNSUPPORTED_ADAPTER')
  }
  if (input.standard !== 'erc20' || output.standard !== 'erc20') {
    swapFail('SWAP_UNSUPPORTED_TOKEN_STANDARD')
  }
  if (!matchesSupportedQuoteCapability(pool, dex, input, output)) {
    swapFail('SWAP_UNSUPPORTED_TOKEN')
  }

  const snapshot = Object.freeze({
    chainId: request.chainId,
    poolDefinitionId: request.poolDefinitionId,
    inputTokenDeploymentId: request.inputTokenDeploymentId,
    outputTokenDeploymentId: request.outputTokenDeploymentId,
    amountIn: request.amountIn,
    freshness,
  })
  return {
    request: snapshot,
    amountIn,
    pool,
    dex,
    input,
    output,
    freshness,
  }
}

const ensureUint256 = (
  value: bigint,
  code: SwapQuoteErrorCode = 'SWAP_ARITHMETIC',
): bigint => {
  if (value < 0n || value > UINT256_MAX) swapFail(code)
  return value
}

const parseHexQuantity = (
  value: unknown,
  code: SwapQuoteErrorCode = 'SWAP_INVALID_POOL_STATE',
): bigint => {
  if (typeof value !== 'string') swapFail(code)
  if (value.length > 66 || !HEX_QUANTITY.test(value)) swapFail(code)
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    swapFail(code)
  }
  return ensureUint256(parsed, code)
}

const parseHexBytes = (
  value: unknown,
  expectedBytes?: number,
  code: SwapQuoteErrorCode = 'SWAP_INVALID_POOL_STATE',
): string => {
  if (typeof value !== 'string') swapFail(code)
  if (
    !HEX_BYTES.test(value) ||
    value.length % 2 !== 0 ||
    (expectedBytes !== undefined && value.length !== expectedBytes * 2 + 2)
  ) swapFail(code)
  return value.toLowerCase()
}

const parseDecimalQuantity = (
  value: unknown,
  code: SwapQuoteErrorCode = 'SWAP_INVALID_POOL_STATE',
): bigint => {
  if (typeof value !== 'string') swapFail(code)
  if (value.length > 78 || !NONNEGATIVE_DECIMAL.test(value)) swapFail(code)
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    swapFail(code)
  }
  return ensureUint256(parsed, code)
}

const addressWord = (value: unknown): string => {
  const bytes = parseHexBytes(value, 32)
  const word = bytes.slice(2)
  if (!/^0{24}[0-9a-f]{40}$/u.test(word)) {
    swapFail('SWAP_INVALID_POOL_STATE')
  }
  return `0x${word.slice(24)}`
}

const uintWord = (value: string, maximum: bigint = UINT256_MAX): bigint => {
  const bytes = parseHexBytes(value, 32)
  const parsed = BigInt(`0x${bytes.slice(2)}`)
  if (parsed > maximum) swapFail('SWAP_INVALID_POOL_STATE')
  return parsed
}

const parseExecutionHexBytes = (
  value: unknown,
  expectedBytes?: number,
  code: SwapExecutionErrorCode = 'SWAP_INVALID_SIMULATION',
): string => {
  if (typeof value !== 'string') executionFail(code)
  if (
    !HEX_BYTES.test(value) ||
    value.length % 2 !== 0 ||
    (expectedBytes !== undefined && value.length !== expectedBytes * 2 + 2)
  ) {
    executionFail(code)
  }
  return value.toLowerCase()
}

const executionAddressWord = (
  value: unknown,
  code: SwapExecutionErrorCode = 'SWAP_INVALID_SIMULATION',
): string => {
  const bytes = parseExecutionHexBytes(value, 32, code)
  const word = bytes.slice(2)
  if (!/^0{24}[0-9a-f]{40}$/u.test(word)) executionFail(code)
  return `0x${word.slice(24)}`
}

const executionUintWord = (
  value: unknown,
  code: SwapExecutionErrorCode = 'SWAP_INVALID_SIMULATION',
): bigint => {
  const bytes = parseExecutionHexBytes(value, 32, code)
  try {
    return BigInt(`0x${bytes.slice(2)}`)
  } catch {
    executionFail(code)
  }
}

const executionUintArrayOfTwo = (
  value: unknown,
): readonly [bigint, bigint] => {
  const bytes = parseExecutionHexBytes(value)
  const payload = bytes.slice(2)
  if (payload.length % 64 !== 0 || payload.length < 256) {
    executionFail('SWAP_INVALID_SIMULATION')
  }
  const offset = BigInt(`0x${payload.slice(0, 64)}`)
  const length = BigInt(`0x${payload.slice(64, 128)}`)
  if (offset !== 0x20n || length !== 2n || payload.length !== 256) {
    executionFail('SWAP_INVALID_SIMULATION')
  }
  return [
    executionUintWord(`0x${payload.slice(128, 192)}`),
    executionUintWord(`0x${payload.slice(192, 256)}`),
  ]
}

const reserveWords = (value: unknown): Reserves => {
  const bytes = parseHexBytes(value, 96)
  const payload = bytes.slice(2)
  const reserve0 = uintWord(`0x${payload.slice(0, 64)}`, UINT112_MAX)
  const reserve1 = uintWord(`0x${payload.slice(64, 128)}`, UINT112_MAX)
  uintWord(`0x${payload.slice(128, 192)}`, UINT32_MAX)
  return { reserve0, reserve1 }
}

const blockHeader = (value: unknown): Header => {
  if (!isRecord(value)) swapFail('SWAP_STATE_STALE')
  return {
    number: parseHexQuantity(value.number, 'SWAP_STATE_STALE'),
    hash: parseHexBytes(value.hash, 32, 'SWAP_STATE_STALE'),
    timestamp: parseHexQuantity(value.timestamp, 'SWAP_STATE_STALE'),
  }
}

const assertChainIdResponse = (value: unknown, chainId: string): void => {
  const network = parseHexQuantity(value, 'SWAP_CHAIN_MISMATCH')
  const expected =
    chainId === DEX_CHAIN_IDS.ethereum
      ? 1n
      : chainId === DEX_CHAIN_IDS.avalancheC
        ? 43114n
        : null
  if (expected === null || network !== expected) swapFail('SWAP_CHAIN_MISMATCH')
}

const rpcSelector = (hash: string): Readonly<{ blockHash: string; requireCanonical: true }> => ({
  blockHash: hash,
  requireCanonical: true,
})

const abiCall = (to: string, data: string): Readonly<{ to: string; data: string }> => ({
  to,
  data,
})

const encodeAddressArgument = (address: string): string => {
  if (!EVM_ADDRESS.test(address)) swapFail('SWAP_INVALID_POOL_STATE')
  return address.slice(2).padStart(64, '0')
}

const rpcRequest = async (
  transport: HttpJsonRpcTransport,
  method: string,
  params: readonly unknown[],
  options?: RpcSendOptions,
): Promise<unknown> => {
  if (options?.signal?.aborted) {
    if (options.signal.reason !== undefined) throw options.signal.reason
    throw new DOMException('The operation was aborted', 'AbortError')
  }
  return transport.request(method, params, options)
}

const currentClockSeconds = (
  clock: (() => number) | undefined,
): number => {
  const value = clock === undefined ? Math.floor(Date.now() / 1000) : clock()
  if (!Number.isSafeInteger(value)) swapFail('SWAP_INVALID_ARGUMENT')
  return value
}

const EXECUTION_REQUEST_KEYS = new Set([
  'chainId',
  'poolDefinitionId',
  'inputTokenDeploymentId',
  'outputTokenDeploymentId',
  'amountIn',
  'freshness',
  'sender',
  'recipient',
  'slippageBps',
  'deadline',
])

const snapshotExecutionRequest = (
  request: unknown,
): ExecutionRequestSnapshot => {
  if (!isRecord(request)) executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  if (Object.keys(request).some((key) => !EXECUTION_REQUEST_KEYS.has(key))) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }

  // Copy every scalar and the shallow freshness record synchronously. The
  // resulting quote request is independent of mutations made while RPC is in
  // flight, while quote-field errors still come from normalizeQuoteRequest.
  const freshness = request.freshness
  const freshnessSnapshot = isRecord(freshness)
    ? { ...freshness }
    : freshness
  const quoteRequest = {
    chainId: request.chainId as string,
    poolDefinitionId: request.poolDefinitionId as string,
    inputTokenDeploymentId: request.inputTokenDeploymentId as string,
    outputTokenDeploymentId: request.outputTokenDeploymentId as string,
    amountIn: request.amountIn as string,
    ...(freshnessSnapshot === undefined
      ? {}
      : { freshness: freshnessSnapshot }),
  } as ExactInputQuoteRequest
  return {
    quoteRequest,
    sender: request.sender,
    recipient: request.recipient,
    slippageBps: request.slippageBps,
    deadline: request.deadline,
  }
}

const normalizeExecutionAddress = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  const normalized = value.toLowerCase()
  if (normalized === `0x${'0'.repeat(40)}`) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  return normalized
}

const normalizeExecutionSlippage = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 9999
  ) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  return value
}

const parseExecutionDeadline = (
  value: unknown,
): { readonly source: string; readonly value: bigint } => {
  if (typeof value !== 'string' || !UINT256_DECIMAL.test(value) || value.length > 78) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  if (parsed <= 0n || parsed > UINT256_MAX) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
  return { source: value, value: parsed }
}

const normalizeExecutionRequest = (
  request: unknown,
  clock: (() => number) | undefined,
): NormalizedExecutionRequest => {
  const snapshot = snapshotExecutionRequest(request)
  const sender = normalizeExecutionAddress(snapshot.sender)
  const recipient = normalizeExecutionAddress(snapshot.recipient)
  const slippageBps = normalizeExecutionSlippage(snapshot.slippageBps)
  const deadline = parseExecutionDeadline(snapshot.deadline)

  // A deadline that has already elapsed is rejected before the first RPC.
  // The quote snapshot and completion clock are checked again after I/O.
  const initialClock = BigInt(currentClockSeconds(clock))
  if (deadline.value <= initialClock) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }

  let normalized: NormalizedRequest
  try {
    normalized = normalizeQuoteRequest(snapshot.quoteRequest)
  } catch (error) {
    if (
      error instanceof SwapQuoteError &&
      (error.code === 'SWAP_UNKNOWN_POOL' ||
        error.code === 'SWAP_UNSUPPORTED_ADAPTER' ||
        error.code === 'SWAP_UNSUPPORTED_TOKEN' ||
        error.code === 'SWAP_UNSUPPORTED_TOKEN_STANDARD')
    ) {
      executionFail('SWAP_UNSUPPORTED_EXECUTION')
    }
    throw error
  }
  return {
    normalized,
    sender,
    recipient,
    slippageBps,
    deadline: deadline.source,
    deadlineValue: deadline.value,
  }
}

const assertFreshnessAtNow = (
  state: Pick<EvmState, 'initial' | 'latestAfterReads'>,
  freshness: NormalizedFreshness,
  now: bigint,
): void => {
  const initialAge = now - state.initial.timestamp
  if (
    initialAge < -BigInt(freshness.maxClockSkewSeconds) ||
    initialAge > BigInt(freshness.maxBlockAgeSeconds)
  ) {
    swapFail('SWAP_STATE_STALE')
  }
  const latestAge = now - state.latestAfterReads.timestamp
  if (
    latestAge < -BigInt(freshness.maxClockSkewSeconds) ||
    latestAge > BigInt(freshness.maxBlockAgeSeconds)
  ) {
    swapFail('SWAP_STATE_STALE')
  }
  if (
    state.latestAfterReads.number < state.initial.number ||
    state.latestAfterReads.number - state.initial.number > BigInt(freshness.maxBlockLag)
  ) {
    swapFail('SWAP_STATE_STALE')
  }
  if (
    state.latestAfterReads.number === state.initial.number &&
    state.latestAfterReads.hash !== state.initial.hash
  ) {
    swapFail('SWAP_STATE_STALE')
  }
  if (
    state.latestAfterReads.number > state.initial.number &&
    state.latestAfterReads.timestamp < state.initial.timestamp
  ) {
    swapFail('SWAP_STATE_STALE')
  }
  if (
    state.latestAfterReads.hash === state.initial.hash &&
    state.latestAfterReads.number === state.initial.number &&
    state.latestAfterReads.timestamp !== state.initial.timestamp
  ) {
    swapFail('SWAP_STATE_STALE')
  }
}

const assertFreshness = (
  state: Pick<EvmState, 'initial' | 'latestAfterReads'>,
  freshness: NormalizedFreshness,
  clock: (() => number) | undefined,
): void => {
  assertFreshnessAtNow(
    state,
    freshness,
    BigInt(currentClockSeconds(clock)),
  )
}

const executionCapabilityFor = (
  normalized: NormalizedRequest,
): SwapExecutionCapability => {
  const capability = EXECUTION_CAPABILITIES.find(
    (entry) => entry.poolDefinitionId === normalized.pool.poolDefinitionId,
  )
  if (!capability || capability.status !== 'active') {
    executionFail('SWAP_UNSUPPORTED_EXECUTION')
  }

  const token0 = getTokenDeployment(capability.token0DeploymentId)
  const token1 = getTokenDeployment(capability.token1DeploymentId)
  const wrapped = getTokenDeployment(capability.wrappedNativeTokenDeploymentId)
  const nativeWrap = NATIVE_WRAP_DEFINITIONS.find(
    (entry) =>
      entry.chainId === capability.chainId &&
      entry.wrappedTokenDeploymentId === capability.wrappedNativeTokenDeploymentId,
  )
  const matchesCapabilityToken = (
    token: TokenDeployment | undefined,
    deploymentId: string,
    address: string,
    standard: 'erc20',
  ): boolean =>
    token?.deploymentId === deploymentId &&
    token.chainId === capability.chainId &&
    token.address === address &&
    token.standard === standard &&
    token.status === 'active'

  const inputMatches =
    matchesCapabilityToken(
      normalized.input,
      capability.token0DeploymentId,
      capability.token0Address,
      capability.token0Standard,
    ) ||
    matchesCapabilityToken(
      normalized.input,
      capability.token1DeploymentId,
      capability.token1Address,
      capability.token1Standard,
    )
  const outputMatches =
    matchesCapabilityToken(
      normalized.output,
      capability.token0DeploymentId,
      capability.token0Address,
      capability.token0Standard,
    ) ||
    matchesCapabilityToken(
      normalized.output,
      capability.token1DeploymentId,
      capability.token1Address,
      capability.token1Standard,
    )

  if (
    capability.chainId !== normalized.pool.chainId ||
    capability.dexDeploymentId !== normalized.pool.dexDeploymentId ||
    capability.adapterKind !== SUPPORTED_QUOTE_ADAPTER ||
    capability.functionKind !== 'exact-input-erc20-to-erc20' ||
    capability.functionSignature !== SWAP_EXECUTION_FUNCTION_SIGNATURE ||
    capability.functionSelector !== SWAP_EXECUTION_FUNCTION_SELECTOR ||
    normalized.dex.status !== 'active' ||
    normalized.dex.programAddress !== capability.factoryAddress ||
    normalized.dex.adapterKind !== capability.adapterKind ||
    normalized.pool.status !== 'active' ||
    normalized.pool.adapter.kind !== capability.adapterKind ||
    normalized.pool.adapter.feeNumerator !== '3' ||
    normalized.pool.adapter.feeDenominator !== '1000' ||
    normalized.pool.token0DeploymentId !== capability.token0DeploymentId ||
    normalized.pool.token1DeploymentId !== capability.token1DeploymentId ||
    !inputMatches ||
    !outputMatches ||
    !token0 ||
    !token1 ||
    !wrapped ||
    wrapped.chainId !== capability.chainId ||
    wrapped.address !== capability.wrappedNativeTokenAddress ||
    wrapped.standard !== 'erc20' ||
    wrapped.status !== 'active' ||
    !nativeWrap ||
    nativeWrap.status !== 'active' ||
    nativeWrap.wrappedTokenDeploymentId !== capability.wrappedNativeTokenDeploymentId
  ) {
    executionFail('SWAP_UNSUPPORTED_EXECUTION')
  }
  return capability
}

const readEvmState = async (
  transport: HttpJsonRpcTransport,
  normalized: NormalizedRequest,
  clock: (() => number) | undefined,
  options?: RpcSendOptions,
): Promise<EvmState> => {
  const { pool, dex } = normalized
  const chainId = await rpcRequest(transport, 'eth_chainId', [], options)
  assertChainIdResponse(chainId, pool.chainId)

  const initial = blockHeader(
    await rpcRequest(transport, 'eth_getBlockByNumber', ['latest', false], options),
  )
  const selector = rpcSelector(initial.hash)

  // Keep all state responses opaque until both final header checks pass. This
  // preserves stale/reorg precedence over malformed ABI data.
  const factoryCodeRaw = await rpcRequest(transport, 'eth_getCode', [
    dex.programAddress,
    selector,
  ], options)
  const poolCodeRaw = await rpcRequest(transport, 'eth_getCode', [
    pool.address,
    selector,
  ], options)
  const token0 = getTokenDeployment(pool.token0DeploymentId)
  const token1 = getTokenDeployment(pool.token1DeploymentId)
  const token0Address = token0?.address
  const token1Address = token1?.address
  if (typeof token0Address !== 'string' || typeof token1Address !== 'string') {
    swapFail('SWAP_INVALID_POOL_STATE')
  }
  const pairCallData = `${FACTORY_GET_PAIR_SELECTOR}${encodeAddressArgument(
    token0Address,
  )}${encodeAddressArgument(token1Address)}`
  const factoryPairRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(dex.programAddress, pairCallData),
    selector,
  ], options)
  const pairFactoryRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(pool.address, PAIR_FACTORY_SELECTOR),
    selector,
  ], options)
  const pairToken0Raw = await rpcRequest(transport, 'eth_call', [
    abiCall(pool.address, PAIR_TOKEN0_SELECTOR),
    selector,
  ], options)
  const pairToken1Raw = await rpcRequest(transport, 'eth_call', [
    abiCall(pool.address, PAIR_TOKEN1_SELECTOR),
    selector,
  ], options)
  const reservesRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(pool.address, PAIR_GET_RESERVES_SELECTOR),
    selector,
  ], options)

  const latestAfterReads = blockHeader(
    await rpcRequest(transport, 'eth_getBlockByNumber', ['latest', false], options),
  )
  const reread = blockHeader(
    await rpcRequest(transport, 'eth_getBlockByNumber', [
      `0x${initial.number.toString(16)}`,
      false,
    ], options),
  )
  if (
    reread.number !== initial.number ||
    reread.hash !== initial.hash ||
    reread.timestamp !== initial.timestamp
  ) {
    swapFail('SWAP_STATE_STALE')
  }

  assertFreshness({ initial, latestAfterReads }, normalized.freshness, clock)

  const factoryCode = parseHexBytes(factoryCodeRaw)
  if (factoryCode.length <= 2) swapFail('SWAP_PROGRAM_MISMATCH')
  const poolCode = parseHexBytes(poolCodeRaw)
  if (poolCode.length <= 2) swapFail('SWAP_INVALID_POOL_STATE')

  const factoryPair = addressWord(factoryPairRaw)
  if (factoryPair !== pool.address) swapFail('SWAP_PROGRAM_MISMATCH')
  const pairFactory = addressWord(pairFactoryRaw)
  if (pairFactory !== dex.programAddress) swapFail('SWAP_PROGRAM_MISMATCH')
  const pairToken0 = addressWord(pairToken0Raw)
  const pairToken1 = addressWord(pairToken1Raw)
  if (pairToken0 !== token0Address || pairToken1 !== token1Address) {
    swapFail('SWAP_POOL_TOKEN_MISMATCH')
  }
  const reserves = reserveWords(reservesRaw)
  return { initial, latestAfterReads, reserves }
}

const calculateQuote = (
  normalized: NormalizedRequest,
  state: EvmState,
): { readonly amountOut: bigint; readonly feeNumerator: bigint; readonly feeDenominator: bigint } => {
  const feeNumerator = parseDecimalQuantity(
    normalized.pool.adapter.feeNumerator,
    'SWAP_ARITHMETIC',
  )
  const feeDenominator = parseDecimalQuantity(
    normalized.pool.adapter.feeDenominator,
    'SWAP_ARITHMETIC',
  )
  if (feeDenominator <= feeNumerator) swapFail('SWAP_ARITHMETIC')

  const token0 = getTokenDeployment(normalized.pool.token0DeploymentId)
  if (!token0?.address || !normalized.input.address || !normalized.output.address) {
    swapFail('SWAP_INVALID_POOL_STATE')
  }
  const inputIsToken0 = normalized.input.address.toLowerCase() === token0.address
  const reserveIn = inputIsToken0 ? state.reserves.reserve0 : state.reserves.reserve1
  const reserveOut = inputIsToken0 ? state.reserves.reserve1 : state.reserves.reserve0
  if (reserveIn <= 0n || reserveOut <= 0n) swapFail('SWAP_INSUFFICIENT_LIQUIDITY')

  const adjusted = ensureUint256(
    normalized.amountIn * (feeDenominator - feeNumerator),
  )
  const denominator = ensureUint256(reserveIn * feeDenominator + adjusted)
  if (denominator <= 0n) swapFail('SWAP_ARITHMETIC')
  const numerator = ensureUint256(adjusted * reserveOut)
  const amountOut = numerator / denominator
  ensureUint256(amountOut)
  if (amountOut <= 0n || amountOut > reserveOut) {
    swapFail('SWAP_INSUFFICIENT_LIQUIDITY')
  }
  return { amountOut, feeNumerator, feeDenominator }
}

const quoteResult = (
  normalized: NormalizedRequest,
  state: EvmState,
  result: ReturnType<typeof calculateQuote>,
): ExactInputQuoteResult => {
  const output: ExactInputQuoteResult = {
    quoteKind: 'exact-input',
    chainId: normalized.request.chainId,
    poolDefinitionId: normalized.pool.poolDefinitionId,
    dexDeploymentId: normalized.pool.dexDeploymentId,
    adapterKind: normalized.pool.adapter.kind,
    inputTokenDeploymentId: normalized.request.inputTokenDeploymentId,
    outputTokenDeploymentId: normalized.request.outputTokenDeploymentId,
    amountIn: normalized.amountIn.toString(10),
    amountOut: result.amountOut.toString(10),
    fee: {
      numerator: result.feeNumerator.toString(10),
      denominator: result.feeDenominator.toString(10),
    },
    snapshot: {
      kind: 'evm-block',
      blockNumber: state.initial.number.toString(10),
      blockHash: state.initial.hash,
      blockTimestamp: state.initial.timestamp.toString(10),
    },
    tokenCatalogDigest: TOKEN_CATALOG_CONTENT_DIGEST,
    dexCatalogDigest: DEX_CATALOG_CONTENT_DIGEST,
  }
  return deepFreeze(output)
}

const transportForNormalized = (
  normalized: NormalizedRequest,
  options: SwapClientOptions,
): HttpJsonRpcTransport => {
  const transport =
    normalized.pool.chainId === DEX_CHAIN_IDS.ethereum
      ? options.ethereum
      : normalized.pool.chainId === DEX_CHAIN_IDS.avalancheC
        ? options.avalanche
        : undefined
  if (!transport) swapFail('SWAP_UNSUPPORTED_ADAPTER')
  return transport
}

const encodeUint256Word = (value: bigint): string =>
  ensureUint256(value).toString(16).padStart(64, '0')

const executionTokenAddress = (token: TokenDeployment): string => {
  if (typeof token.address !== 'string' || !EVM_ADDRESS.test(token.address)) {
    executionFail('SWAP_INVALID_SIMULATION')
  }
  return token.address.toLowerCase()
}

const executionGetAmountsOutData = (
  amountIn: bigint,
  inputAddress: string,
  outputAddress: string,
): string =>
  `${ROUTER_GET_AMOUNTS_OUT_SELECTOR}${encodeUint256Word(amountIn)}${encodeUint256Word(
    0x40n,
  )}${encodeUint256Word(2n)}${encodeAddressArgument(
    inputAddress,
  )}${encodeAddressArgument(outputAddress)}`

const executionSwapData = (
  amountIn: bigint,
  minimumAmountOut: bigint,
  inputAddress: string,
  outputAddress: string,
  recipient: string,
  deadline: bigint,
): string =>
  `${SWAP_EXECUTION_FUNCTION_SELECTOR}${encodeUint256Word(
    amountIn,
  )}${encodeUint256Word(minimumAmountOut)}${encodeUint256Word(
    0xa0n,
  )}${encodeAddressArgument(recipient)}${encodeUint256Word(
    deadline,
  )}${encodeUint256Word(2n)}${encodeAddressArgument(
    inputAddress,
  )}${encodeAddressArgument(outputAddress)}`

const buildExecutionPreparation = (
  execution: NormalizedExecutionRequest,
  capability: SwapExecutionCapability,
  quote: ExactInputQuoteResult,
): ExactInputSwapPreparation => {
  const inputAddress = executionTokenAddress(execution.normalized.input)
  const outputAddress = executionTokenAddress(execution.normalized.output)
  const quoteAmountOut = parseDecimalQuantity(quote.amountOut, 'SWAP_ARITHMETIC')
  const minimumAmountOut = ensureUint256(
    quoteAmountOut * BigInt(10000 - execution.slippageBps),
    'SWAP_ARITHMETIC',
  ) / 10000n
  if (minimumAmountOut <= 0n) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }

  const path = [
    {
      tokenDeploymentId: execution.normalized.input.deploymentId,
      address: inputAddress,
      standard: 'erc20' as const,
      representationKind: execution.normalized.input.representationKind,
    },
    {
      tokenDeploymentId: execution.normalized.output.deploymentId,
      address: outputAddress,
      standard: 'erc20' as const,
      representationKind: execution.normalized.output.representationKind,
    },
  ] as const
  const transaction = {
    kind: 'evm-unsigned-transaction' as const,
    chainId: quote.chainId,
    from: execution.sender,
    to: capability.routerAddress,
    data: executionSwapData(
      execution.normalized.amountIn,
      minimumAmountOut,
      inputAddress,
      outputAddress,
      execution.recipient,
      execution.deadlineValue,
    ),
    value: '0' as const,
  }
  return deepFreeze({
    preparationKind: 'evm-router-v2-exact-input' as const,
    executionCapabilityId: capability.swapExecutionCapabilityId,
    executionCapabilityDigest: SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
    quote,
    minimumAmountOut: minimumAmountOut.toString(10),
    slippageBps: execution.slippageBps,
    deadline: execution.deadline,
    recipient: execution.recipient,
    path,
    transaction,
    allowance: {
      tokenDeploymentId: execution.normalized.input.deploymentId,
      tokenAddress: inputAddress,
      owner: execution.sender,
      spender: capability.routerAddress,
      requiredAmount: quote.amountIn,
    },
  })
}

const assertExecutionDeadline = (
  execution: NormalizedExecutionRequest,
  quoteTimestamp: bigint,
  completionClock: bigint,
): void => {
  if (
    execution.deadlineValue <= quoteTimestamp ||
    execution.deadlineValue <= completionClock
  ) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }
}

const prepareExecutionContext = async (
  execution: NormalizedExecutionRequest,
  capability: SwapExecutionCapability,
  transport: HttpJsonRpcTransport,
  options: SwapClientOptions,
  requestOptions?: RpcSendOptions,
): Promise<PreparedExecutionContext> => {
  // The quote path is deliberately reused verbatim: this gives preparation
  // the existing eleven reads and the same local arithmetic/result contract.
  const state = await readEvmState(
    transport,
    execution.normalized,
    options.clock,
    requestOptions,
  )
  assertFreshness(state, execution.normalized.freshness, options.clock)
  const quote = quoteResult(
    execution.normalized,
    state,
    calculateQuote(execution.normalized, state),
  )
  if (execution.deadlineValue <= state.initial.timestamp) {
    executionFail('SWAP_EXECUTION_INVALID_ARGUMENT')
  }

  const inputAddress = executionTokenAddress(execution.normalized.input)
  const outputAddress = executionTokenAddress(execution.normalized.output)
  const selector = rpcSelector(state.initial.hash)
  const routerCodeRaw = await rpcRequest(transport, 'eth_getCode', [
    capability.routerAddress,
    selector,
  ], requestOptions)
  const routerCode = parseExecutionHexBytes(routerCodeRaw)
  if (routerCode.length <= 2) executionFail('SWAP_INVALID_SIMULATION')

  const routerFactoryRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(capability.routerAddress, ROUTER_FACTORY_SELECTOR),
    selector,
  ], requestOptions)
  const routerFactory = executionAddressWord(routerFactoryRaw)
  if (routerFactory !== capability.factoryAddress) {
    executionFail('SWAP_PROGRAM_MISMATCH')
  }

  const wrappedNativeRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(capability.routerAddress, capability.wrappedNativeFunctionSelector),
    selector,
  ], requestOptions)
  const wrappedNative = executionAddressWord(wrappedNativeRaw)
  if (wrappedNative !== capability.wrappedNativeTokenAddress) {
    executionFail('SWAP_PROGRAM_MISMATCH')
  }

  const amountsOutRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(
      capability.routerAddress,
      executionGetAmountsOutData(
        execution.normalized.amountIn,
        inputAddress,
        outputAddress,
      ),
    ),
    selector,
  ], requestOptions)
  const amountsOut = executionUintArrayOfTwo(amountsOutRaw)
  const quoteAmountOut = parseDecimalQuantity(quote.amountOut, 'SWAP_ARITHMETIC')
  if (
    amountsOut[0] !== execution.normalized.amountIn ||
    amountsOut[1] !== quoteAmountOut
  ) {
    executionFail('SWAP_INVALID_SIMULATION')
  }

  const latestAfterRouterReads = blockHeader(
    await rpcRequest(
      transport,
      'eth_getBlockByNumber',
      ['latest', false],
      requestOptions,
    ),
  )

  // The final latest read is the freshness/reorg check for the router reads.
  const completionClock = BigInt(currentClockSeconds(options.clock))
  assertFreshnessAtNow(
    {
      initial: state.initial,
      latestAfterReads: latestAfterRouterReads,
    },
    execution.normalized.freshness,
    completionClock,
  )

  const preparation = buildExecutionPreparation(execution, capability, quote)
  assertExecutionDeadline(
    execution,
    state.initial.timestamp,
    BigInt(currentClockSeconds(options.clock)),
  )
  return { normalized: execution, capability, transport, state, quote, preparation }
}

const isRecognizedExecutionRevert = (error: unknown): boolean => {
  if (!(error instanceof ErpcJsonRpcError)) return false
  if (![3, -32000, -32015, -32603].includes(error.rpcCode)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('execution reverted') ||
    message.includes('transaction reverted') ||
    message.includes('vm execution error') ||
    /^revert(?:ed)?(?:\b|:)/u.test(message)
  )
}

const simulateExecutionContext = async (
  context: PreparedExecutionContext,
  options: SwapClientOptions,
  requestOptions?: RpcSendOptions,
): Promise<ExactInputSwapSimulation> => {
  const { normalized, capability, transport, state, preparation } = context
  const selector = rpcSelector(state.initial.hash)
  const inputAddress = preparation.allowance.tokenAddress
  const allowanceData = `${ERC20_ALLOWANCE_SELECTOR}${encodeAddressArgument(
    normalized.sender,
  )}${encodeAddressArgument(capability.routerAddress)}`
  const allowanceRaw = await rpcRequest(transport, 'eth_call', [
    abiCall(inputAddress, allowanceData),
    selector,
  ], requestOptions)
  const currentAllowance = executionUintWord(
    allowanceRaw,
    'SWAP_INSUFFICIENT_ALLOWANCE',
  )
  if (currentAllowance < normalized.normalized.amountIn) {
    executionFail('SWAP_INSUFFICIENT_ALLOWANCE')
  }

  let simulationRaw: unknown
  try {
    simulationRaw = await rpcRequest(transport, 'eth_call', [
      {
        from: preparation.transaction.from,
        to: preparation.transaction.to,
        data: preparation.transaction.data,
        value: '0x0',
      },
      selector,
    ], requestOptions)
  } catch (error) {
    if (isRecognizedExecutionRevert(error)) {
      executionFail('SWAP_SIMULATION_REVERTED')
    }
    throw error
  }

  const latestAfterSimulation = blockHeader(
    await rpcRequest(
      transport,
      'eth_getBlockByNumber',
      ['latest', false],
      requestOptions,
    ),
  )
  const completionClock = BigInt(currentClockSeconds(options.clock))
  assertFreshnessAtNow(
    { initial: state.initial, latestAfterReads: latestAfterSimulation },
    normalized.normalized.freshness,
    completionClock,
  )

  const amounts = executionUintArrayOfTwo(simulationRaw)
  const quoteAmountOut = parseDecimalQuantity(
    preparation.quote.amountOut,
    'SWAP_ARITHMETIC',
  )
  const minimumAmountOut = parseDecimalQuantity(
    preparation.minimumAmountOut,
    'SWAP_ARITHMETIC',
  )
  if (
    amounts[0] !== normalized.normalized.amountIn ||
    amounts[1] !== quoteAmountOut ||
    amounts[1] < minimumAmountOut
  ) {
    executionFail('SWAP_INVALID_SIMULATION')
  }

  // Keep the completion check immediately adjacent to the returned result so
  // an expired deadline cannot be handed to the caller after decoding.
  assertExecutionDeadline(
    normalized,
    state.initial.timestamp,
    BigInt(currentClockSeconds(options.clock)),
  )

  return deepFreeze({
    simulationKind: 'evm-call' as const,
    preparation,
    snapshot: preparation.quote.snapshot,
    currentAllowance: currentAllowance.toString(10),
    amounts: [
      amounts[0].toString(10),
      amounts[1].toString(10),
    ] as const,
    amountOut: amounts[1].toString(10),
  })
}

const quoteExactInputWithTransports = async (
  request: unknown,
  options: SwapClientOptions,
  requestOptions?: RpcSendOptions,
): Promise<ExactInputQuoteResult> => {
  const normalized = normalizeQuoteRequest(request)
  if (normalized.pool.adapter.kind !== SUPPORTED_QUOTE_ADAPTER) {
    swapFail('SWAP_UNSUPPORTED_ADAPTER')
  }
  const selectedTransport = transportForNormalized(normalized, options)
  const state = await readEvmState(
    selectedTransport,
    normalized,
    options.clock,
    requestOptions,
  )
  // Repeat freshness immediately before decoding the quote result so the
  // private test clock and the real wall clock cannot silently drift.
  assertFreshness(state, normalized.freshness, options.clock)
  return quoteResult(normalized, state, calculateQuote(normalized, state))
}

const prepareExactInputSwapWithTransports = async (
  request: unknown,
  options: SwapClientOptions,
  requestOptions?: RpcSendOptions,
): Promise<ExactInputSwapPreparation> => {
  const normalized = normalizeExecutionRequest(request, options.clock)
  const capability = executionCapabilityFor(normalized.normalized)
  const transport = transportForNormalized(normalized.normalized, options)
  const context = await prepareExecutionContext(
    normalized,
    capability,
    transport,
    options,
    requestOptions,
  )
  return context.preparation
}

const simulateExactInputSwapWithTransports = async (
  request: unknown,
  options: SwapClientOptions,
  requestOptions?: RpcSendOptions,
): Promise<ExactInputSwapSimulation> => {
  const normalized = normalizeExecutionRequest(request, options.clock)
  const capability = executionCapabilityFor(normalized.normalized)
  const transport = transportForNormalized(normalized.normalized, options)
  const context = await prepareExecutionContext(
    normalized,
    capability,
    transport,
    options,
    requestOptions,
  )
  return simulateExecutionContext(context, options, requestOptions)
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

const EXECUTION_CAPABILITIES = deepFreeze(
  JSON.parse(SWAP_EXECUTION_CAPABILITIES_JSON) as SwapExecutionCapability[],
)

/** Internal constructor used by the configured client and package tests. */
export const createSwapClient = (options: SwapClientOptions): SwapClient =>
  Object.freeze({
    quoteExactInput: (
      request: ExactInputQuoteRequest,
      requestOptions?: RpcSendOptions,
    ) => quoteExactInputWithTransports(request, options, requestOptions),
    prepareExactInputSwap: (
      request: PrepareExactInputSwapRequest,
      requestOptions?: RpcSendOptions,
    ) => prepareExactInputSwapWithTransports(request, options, requestOptions),
    simulateExactInputSwap: (
      request: PrepareExactInputSwapRequest,
      requestOptions?: RpcSendOptions,
    ) => simulateExactInputSwapWithTransports(request, options, requestOptions),
  })
