import {
  BRIDGE_CAPABILITIES_AS_OF_DATE,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  BRIDGE_CAPABILITIES_JSON,
} from './generated/bridge_capabilities'
import {
  TOKEN_CHAIN_IDS,
  getTokenDeployment,
  type TokenDeployment,
} from './token_catalog'
import type { RpcEndpointConfig } from './config'
import {
  buildLocalUnsigned as buildLocalUnsignedRequest,
  prepareSourceSwap as prepareSourceSwapRequest,
} from './bridge_local'
import type {
  MayanSwiftV2LocalBuild,
  MayanSwiftV2LocalBuildRequest,
  MayanSwiftV2LocalRuntimeConfig,
  MayanSwiftV2LocalContext,
  MayanSwiftV2SourceSwapPlan,
} from './bridge_local'
import { wrapFetch } from './transport/fetch'

export type BridgeErrorCode =
  | 'BRIDGE_INVALID_ARGUMENT'
  | 'BRIDGE_UNSUPPORTED_ROUTE'
  | 'BRIDGE_PROVIDER_AUTH_REQUIRED'
  | 'BRIDGE_PROVIDER_TRANSPORT'
  | 'BRIDGE_PROVIDER_HTTP'
  | 'BRIDGE_PROVIDER_INVALID_RESPONSE'
  | 'BRIDGE_QUOTE_UNAVAILABLE'
  | 'BRIDGE_QUOTE_EXPIRED'
  | 'BRIDGE_QUOTE_MISMATCH'
  | 'BRIDGE_BUILD_INVALID'
  | 'BRIDGE_LOCAL_RPC_REQUIRED'
  | 'BRIDGE_SOURCE_RPC_TRANSPORT'
  | 'BRIDGE_SOURCE_RPC_INVALID_RESPONSE'
  | 'BRIDGE_LOCAL_PLAN_INVALID'
  | 'BRIDGE_LOCAL_BUILD_INVALID'
  | 'BRIDGE_STATUS_NOT_FOUND'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_ABORTED'

export const BRIDGE_ERROR_MESSAGES: Readonly<
  Record<BridgeErrorCode, string>
> = Object.freeze({
  BRIDGE_INVALID_ARGUMENT: 'Bridge request is invalid',
  BRIDGE_UNSUPPORTED_ROUTE: 'Bridge route is unsupported',
  BRIDGE_PROVIDER_AUTH_REQUIRED: 'Bridge provider authentication is required',
  BRIDGE_PROVIDER_TRANSPORT: 'Bridge provider transport failed',
  BRIDGE_PROVIDER_HTTP: 'Bridge provider HTTP request failed',
  BRIDGE_PROVIDER_INVALID_RESPONSE: 'Bridge provider response is invalid',
  BRIDGE_QUOTE_UNAVAILABLE: 'Bridge quote is unavailable',
  BRIDGE_QUOTE_EXPIRED: 'Bridge quote is expired',
  BRIDGE_QUOTE_MISMATCH: 'Bridge quote does not match the request',
  BRIDGE_BUILD_INVALID: 'Bridge provider build is invalid',
  BRIDGE_LOCAL_RPC_REQUIRED: 'Bridge local source RPC is required',
  BRIDGE_SOURCE_RPC_TRANSPORT: 'Bridge source RPC transport failed',
  BRIDGE_SOURCE_RPC_INVALID_RESPONSE: 'Bridge source RPC response is invalid',
  BRIDGE_LOCAL_PLAN_INVALID: 'Bridge local source-swap plan is invalid',
  BRIDGE_LOCAL_BUILD_INVALID: 'Bridge local unsigned build is invalid',
  BRIDGE_STATUS_NOT_FOUND: 'Bridge status was not found',
  BRIDGE_TIMEOUT: 'Bridge provider request timed out',
  BRIDGE_ABORTED: 'Bridge provider request was aborted',
})

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly status?: number

  constructor(code: BridgeErrorCode, status?: number) {
    super(BRIDGE_ERROR_MESSAGES[code])
    this.name = 'BridgeError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface MayanSwiftV2BridgeConfig {
  readonly builderEndpoint?: string
  readonly explorerEndpoint?: string
  readonly builderApiKey?: string
  readonly allowUnauthenticatedBuild?: boolean
  readonly minimumQuoteValiditySeconds?: number
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly localBuild?: MayanSwiftV2LocalBuildConfig
}

export interface MayanSwiftV2LocalBuildConfig {
  readonly sourceSwapEndpoint?: string
  readonly ethereumRpc?: RpcEndpointConfig
  readonly solanaRpc?: RpcEndpointConfig
}

export interface BridgeRequestOptions {
  readonly signal?: AbortSignal
}

export interface MayanSwiftV2QuoteRequest {
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly amountIn: string
  readonly slippageBps: number
}

export interface MayanSwiftV2SourceSwap {
  readonly required: boolean
  readonly inputTokenDeploymentId: string
  readonly intermediateTokenDeploymentId: string
  readonly intermediateTokenAddress: string
  readonly intermediateTokenStandard: string
  readonly intermediateTokenDecimals: 6
  readonly providerMinimumAmount: string
  readonly routerKind: 'provider-selected-evm' | 'jupiter-v6' | null
  readonly routerAddress: string | null
}

export interface MayanSwiftV2Quote {
  readonly quoteKind: 'mayan-swift-v2'
  readonly providerId: 'mayan-swift-v2'
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly amountIn: string
  readonly expectedAmountOut: string
  readonly minimumAmountOut: string
  readonly minimumReceived: string
  readonly deadline: string
  readonly slippageBps: number
  readonly quoteId: string
  readonly providerSignature: string
  readonly sourceSwap: MayanSwiftV2SourceSwap
  readonly dependencies: readonly string[]
  readonly quoteVerification: 'provider-signed-not-locally-verified'
  readonly rawSignedQuoteJson: string
}

export type MayanSwiftV2QuoteResult = readonly MayanSwiftV2Quote[]

export interface MayanEvmUnsignedTransaction {
  readonly kind: 'evm-unsigned-transaction'
  readonly chainId: 'eip155:1'
  readonly from: string
  readonly to: string
  readonly data: string
  readonly value: '0'
}

export interface MayanSolanaUnsignedTransaction {
  readonly kind: 'solana-v0-unsigned-transaction'
  readonly chainId: typeof TOKEN_CHAIN_IDS.solanaMainnet
  readonly feePayer: string
  readonly transactionBase64: string
}

export type MayanSwiftV2UnsignedTransaction =
  | MayanEvmUnsignedTransaction
  | MayanSolanaUnsignedTransaction

export interface MayanSwiftV2BuildValidation {
  readonly level: 'structural'
  readonly quoteSignatureLocallyVerified: false
  readonly transactionSemanticsLocallyVerified: false
  readonly settlementLocallyVerified: false
}

export interface MayanSwiftV2Build {
  readonly buildKind: 'mayan-swift-v2-unsigned'
  readonly providerId: 'mayan-swift-v2'
  readonly quote: MayanSwiftV2Quote
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly transaction: MayanSwiftV2UnsignedTransaction
  readonly allowance: {
    readonly tokenDeploymentId: string
    readonly tokenAddress: string
    readonly owner: string
    readonly spender: string
    readonly requiredAmount: string
  } | null
  readonly validation: MayanSwiftV2BuildValidation
  readonly rawProviderBuildJson: string
}

export type MayanSwiftV2BuildResult = MayanSwiftV2Build

export interface MayanSwiftV2StatusRequest {
  readonly sourceChainId: string
  readonly sourceTransactionHash: string
}

export interface MayanSwiftV2Status {
  readonly statusKind: 'mayan-explorer-index'
  readonly providerId: 'mayan-swift-v2'
  readonly sourceChainId: string
  readonly sourceTransactionHash: string
  readonly state: 'in-progress' | 'completed' | 'refunded' | 'unknown'
  readonly providerClientStatus: string
  readonly providerStatus: string | null
  readonly statusVerification: 'provider-indexed-not-locally-verified'
  readonly rawProviderStatusJson: string
}

export type MayanSwiftV2StatusResult = MayanSwiftV2Status

export interface MayanSwiftV2BridgeClient {
  quoteExactInput(
    request: MayanSwiftV2QuoteRequest,
    options?: BridgeRequestOptions,
  ): Promise<readonly MayanSwiftV2Quote[]>
  buildUnsigned(
    request: MayanSwiftV2BuildRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2Build>
  getStatus(
    request: MayanSwiftV2StatusRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2Status>
  prepareSourceSwap(
    context: MayanSwiftV2LocalContext,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2SourceSwapPlan>
  buildLocalUnsigned(
    request: MayanSwiftV2LocalBuildRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2LocalBuild>
  close(): void
}

export type BridgeClient = MayanSwiftV2BridgeClient

export interface MayanSwiftV2BuildRequest {
  readonly quote: MayanSwiftV2Quote
  readonly swapperAddress: string
  readonly destinationAddress: string
  readonly refundAddress?: string
}

export type MayanSwiftV2BuildUnsignedRequest = MayanSwiftV2BuildRequest

type JsonRecord = Record<string, unknown>

interface JsonNode {
  readonly value: unknown
  readonly start: number
  readonly end: number
  readonly objectEntries?: ReadonlyMap<string, JsonNode>
  readonly arrayItems?: readonly JsonNode[]
  readonly rawNumber?: string
}

interface ProviderResponse {
  readonly text: string
  readonly root: JsonNode
}

interface NormalizedBridgeConfig {
  readonly builderEndpoint: URL
  readonly explorerEndpoint: URL
  readonly builderApiKey?: string
  readonly allowUnauthenticatedBuild: boolean
  readonly minimumQuoteValiditySeconds: number
  readonly timeoutMs: number
  readonly fetch: typeof globalThis.fetch
  readonly localBuild?: MayanSwiftV2LocalBuildConfig
}

interface BridgeCapability {
  readonly bridgeCapabilityId: string
  readonly providerId: string
  readonly capabilityKind: string
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly sourceTokenAddress: string
  readonly destinationTokenAddress: string
  readonly sourceTokenStandard: string
  readonly destinationTokenStandard: string
  readonly sourceTokenDecimals: number
  readonly destinationTokenDecimals: number
  readonly sourceProviderChainName: string
  readonly destinationProviderChainName: string
  readonly sourceProviderChainId: number
  readonly destinationProviderChainId: number
  readonly sourceWormholeChainId: number
  readonly destinationWormholeChainId: number
  readonly sourceUsdcDeploymentId: string
  readonly sourceUsdcAddress: string
  readonly sourceUsdcStandard: string
  readonly sourceUsdcDecimals: number
  readonly swiftContract: string
  readonly forwarderAddress: string | null
  readonly forwarderFunctionSelector: string | null
  readonly jupiterProgramAddress: string | null
  readonly builderEndpoint: string
  readonly explorerEndpoint: string
  readonly dependencies: readonly string[]
  readonly status: string
}

const ETHEREUM_CHAIN_ID = TOKEN_CHAIN_IDS.ethereumMainnet
const SOLANA_CHAIN_ID = TOKEN_CHAIN_IDS.solanaMainnet
const ETHEREUM_NAME = 'ethereum'
const SOLANA_NAME = 'solana'
const ETHEREUM_PROVIDER_CHAIN_ID = 1
const SOLANA_PROVIDER_CHAIN_ID = 0
const ETHEREUM_WORMHOLE_CHAIN_ID = 2
const SOLANA_WORMHOLE_CHAIN_ID = 1
const ETHEREUM_EURC_DEPLOYMENT_ID = 'deployment-0011'
const SOLANA_EURC_DEPLOYMENT_ID = 'deployment-0013'
const ETHEREUM_USDC_DEPLOYMENT_ID = 'deployment-0008'
const SOLANA_USDC_DEPLOYMENT_ID = 'deployment-0010'
const ETHEREUM_EURC_ADDRESS =
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c'
const SOLANA_EURC_ADDRESS =
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const ETHEREUM_USDC_ADDRESS =
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const SOLANA_USDC_ADDRESS =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ETHEREUM_SWIFT_CONTRACT =
  '0x40ffe85a28dc9993541449464d7529a922142960'
const SOLANA_SWIFT_PROGRAM = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
const ETHEREUM_FORWARDER = '0x337685fdab40d39bd02028545a4ffa7d287cc3e2'
const SOLANA_JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const ETHEREUM_EURC_FORWARDER_SELECTOR = '0x30dedc57'
const ETHEREUM_USDC_FORWARDER_SELECTOR = '0xe4269fc4'
const MAYAN_USDC_MINT = 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM'
const DEFAULT_BUILDER_ENDPOINT = 'https://tx-builder.mayan.finance'
const DEFAULT_EXPLORER_ENDPOINT = 'https://explorer-api.mayan.finance/v3'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_RAW_QUOTE_BYTES = 256 * 1024
const MAX_JSON_DEPTH = 32
const MAX_QUOTES = 16
const UINT64_MAX = (1n << 64n) - 1n
const CANONICAL_UINT64 = /^(0|[1-9][0-9]*)$/u
const POSITIVE_UINT64 = /^[1-9][0-9]*$/u
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/u
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/u
const HEX_BYTES = /^0x[0-9a-fA-F]*$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const DEPENDENCIES = Object.freeze([
  'mayan-hosted-quote-api',
  'mayan-hosted-transaction-builder',
  'mayan-hosted-source-swap-builder',
  'swift-auction-solvers',
  'relayers',
  'wormhole-guardian-messaging',
  'mayan-explorer-indexer',
])
const DIRECT_USDC_DEPENDENCIES = Object.freeze([
  'mayan-hosted-quote-api',
  'mayan-hosted-transaction-builder',
  'swift-auction-solvers',
  'relayers',
  'wormhole-guardian-messaging',
  'mayan-explorer-indexer',
])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child)
  }
  return value
}

const parsedCapabilities = JSON.parse(BRIDGE_CAPABILITIES_JSON) as unknown
const BRIDGE_CAPABILITIES: readonly BridgeCapability[] = deepFreeze(
  (Array.isArray(parsedCapabilities)
    ? parsedCapabilities
    : isRecord(parsedCapabilities) && Array.isArray(parsedCapabilities.capabilities)
      ? parsedCapabilities.capabilities
      : []) as BridgeCapability[],
)

const fail = (code: BridgeErrorCode, status?: number): never => {
  throw new BridgeError(code, status)
}

const requireRecord = (value: unknown, code: BridgeErrorCode): JsonRecord => {
  if (!isRecord(value)) fail(code)
  return value as JsonRecord
}

const requireString = (
  value: unknown,
  code: BridgeErrorCode,
  nonempty = true,
): string => {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) fail(code)
  return value as string
}

const normalizeEvmAddress = (value: unknown, code: BridgeErrorCode): string => {
  const address = requireString(value, code)
  if (!EVM_ADDRESS.test(address) || /^0x0{40}$/iu.test(address)) fail(code)
  return address.toLowerCase()
}

const normalizePositiveUint64 = (
  value: unknown,
  code: BridgeErrorCode,
): { readonly source: string; readonly value: bigint } => {
  const source = requireString(value, code)
  if (!POSITIVE_UINT64.test(source) || source.length > 20) fail(code)
  let parsed: bigint
  try {
    parsed = BigInt(source)
  } catch {
    return fail(code)
  }
  const valueParsed = parsed as bigint
  if (valueParsed <= 0n || valueParsed > UINT64_MAX) fail(code)
  return { source, value: valueParsed }
}

const normalizeCanonicalUint64 = (
  value: unknown,
  code: BridgeErrorCode,
): { readonly source: string; readonly value: bigint } => {
  const source = requireString(value, code)
  if (!CANONICAL_UINT64.test(source) || source.length > 20) fail(code)
  let parsed: bigint
  try {
    parsed = BigInt(source)
  } catch {
    return fail(code)
  }
  const valueParsed = parsed as bigint
  if (valueParsed > UINT64_MAX) fail(code)
  return { source, value: valueParsed }
}

const normalizeSlippage = (value: unknown, code: BridgeErrorCode): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 500
  ) {
    fail(code)
  }
  return value as number
}

const providerAddressEquals = (value: unknown, expected: string): boolean =>
  typeof value === 'string' &&
  (EVM_ADDRESS.test(value) ? value.toLowerCase() === expected.toLowerCase() : value === expected)

const catalogTokenMatches = (
  token: TokenDeployment | undefined,
  expected: {
    readonly deploymentId: string
    readonly chainId: string
    readonly address: string
    readonly standard: string
    readonly decimals: number
  },
): boolean =>
  token?.deploymentId === expected.deploymentId &&
  token.chainId === expected.chainId &&
  token.address !== null &&
  (expected.chainId === ETHEREUM_CHAIN_ID
    ? token.address.toLowerCase() === expected.address.toLowerCase()
    : token.address === expected.address) &&
  token.standard === expected.standard &&
  token.decimals === expected.decimals &&
  token.status === 'active'

interface DirectionFacts {
  readonly asset: 'eurc' | 'usdc'
  readonly bridgeCapabilityId: string
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly sourceTokenAddress: string
  readonly destinationTokenAddress: string
  readonly sourceTokenStandard: string
  readonly destinationTokenStandard: string
  readonly sourceProviderChainId: number
  readonly destinationProviderChainId: number
  readonly sourceWormholeChainId: number
  readonly destinationWormholeChainId: number
  readonly sourceName: string
  readonly destinationName: string
  readonly sourceTokenName: 'EuroC' | 'USD Coin'
  readonly destinationTokenName: 'EuroC' | 'USD Coin'
  readonly sourceTokenMint: string
  readonly destinationTokenMint: string
  readonly sourceUsdcDeploymentId: string
  readonly sourceUsdcAddress: string
  readonly sourceUsdcStandard: string
  readonly swiftContract: string
  readonly forwarderAddress: string | null
  readonly forwarderFunctionSelector: string | null
}

const directionFacts = (
  sourceChainId: string,
  destinationChainId: string,
  sourceTokenDeploymentId: string,
  destinationTokenDeploymentId: string,
): DirectionFacts => {
  if (sourceChainId === ETHEREUM_CHAIN_ID && destinationChainId === SOLANA_CHAIN_ID) {
    const isEurc =
      sourceTokenDeploymentId === ETHEREUM_EURC_DEPLOYMENT_ID &&
      destinationTokenDeploymentId === SOLANA_EURC_DEPLOYMENT_ID
    const isUsdc =
      sourceTokenDeploymentId === ETHEREUM_USDC_DEPLOYMENT_ID &&
      destinationTokenDeploymentId === SOLANA_USDC_DEPLOYMENT_ID
    if (!isEurc && !isUsdc) return fail('BRIDGE_UNSUPPORTED_ROUTE')
    return {
      sourceChainId,
      destinationChainId,
      asset: isEurc ? 'eurc' : 'usdc',
      bridgeCapabilityId: isEurc
        ? 'bridge-mayan-swift-v2-eurc-eth-sol'
        : 'bridge-mayan-swift-v2-usdc-eth-sol',
      sourceTokenDeploymentId,
      destinationTokenDeploymentId,
      sourceTokenAddress: isEurc ? ETHEREUM_EURC_ADDRESS : ETHEREUM_USDC_ADDRESS,
      destinationTokenAddress: isEurc ? SOLANA_EURC_ADDRESS : SOLANA_USDC_ADDRESS,
      sourceTokenStandard: 'erc20',
      destinationTokenStandard: 'spl-token',
      sourceProviderChainId: ETHEREUM_PROVIDER_CHAIN_ID,
      destinationProviderChainId: SOLANA_PROVIDER_CHAIN_ID,
      sourceWormholeChainId: ETHEREUM_WORMHOLE_CHAIN_ID,
      destinationWormholeChainId: SOLANA_WORMHOLE_CHAIN_ID,
      sourceName: ETHEREUM_NAME,
      destinationName: SOLANA_NAME,
      sourceTokenName: isEurc ? 'EuroC' : 'USD Coin',
      destinationTokenName: isEurc ? 'EuroC' : 'USD Coin',
      sourceTokenMint: isEurc ? '' : MAYAN_USDC_MINT,
      destinationTokenMint: isEurc ? SOLANA_EURC_ADDRESS : SOLANA_USDC_ADDRESS,
      sourceUsdcDeploymentId: ETHEREUM_USDC_DEPLOYMENT_ID,
      sourceUsdcAddress: ETHEREUM_USDC_ADDRESS,
      sourceUsdcStandard: 'erc20',
      swiftContract: ETHEREUM_SWIFT_CONTRACT,
      forwarderAddress: ETHEREUM_FORWARDER,
      forwarderFunctionSelector: isUsdc
        ? ETHEREUM_USDC_FORWARDER_SELECTOR
        : ETHEREUM_EURC_FORWARDER_SELECTOR,
    }
  }
  if (sourceChainId === SOLANA_CHAIN_ID && destinationChainId === ETHEREUM_CHAIN_ID) {
    const isEurc =
      sourceTokenDeploymentId === SOLANA_EURC_DEPLOYMENT_ID &&
      destinationTokenDeploymentId === ETHEREUM_EURC_DEPLOYMENT_ID
    const isUsdc =
      sourceTokenDeploymentId === SOLANA_USDC_DEPLOYMENT_ID &&
      destinationTokenDeploymentId === ETHEREUM_USDC_DEPLOYMENT_ID
    if (!isEurc && !isUsdc) return fail('BRIDGE_UNSUPPORTED_ROUTE')
    return {
      sourceChainId,
      destinationChainId,
      asset: isEurc ? 'eurc' : 'usdc',
      bridgeCapabilityId: isEurc
        ? 'bridge-mayan-swift-v2-eurc-sol-eth'
        : 'bridge-mayan-swift-v2-usdc-sol-eth',
      sourceTokenDeploymentId,
      destinationTokenDeploymentId,
      sourceTokenAddress: isEurc ? SOLANA_EURC_ADDRESS : SOLANA_USDC_ADDRESS,
      destinationTokenAddress: isEurc ? ETHEREUM_EURC_ADDRESS : ETHEREUM_USDC_ADDRESS,
      sourceTokenStandard: 'spl-token',
      destinationTokenStandard: 'erc20',
      sourceProviderChainId: SOLANA_PROVIDER_CHAIN_ID,
      destinationProviderChainId: ETHEREUM_PROVIDER_CHAIN_ID,
      sourceWormholeChainId: SOLANA_WORMHOLE_CHAIN_ID,
      destinationWormholeChainId: ETHEREUM_WORMHOLE_CHAIN_ID,
      sourceName: SOLANA_NAME,
      destinationName: ETHEREUM_NAME,
      sourceTokenName: isEurc ? 'EuroC' : 'USD Coin',
      destinationTokenName: isEurc ? 'EuroC' : 'USD Coin',
      sourceTokenMint: isEurc ? SOLANA_EURC_ADDRESS : SOLANA_USDC_ADDRESS,
      destinationTokenMint: isEurc ? '' : MAYAN_USDC_MINT,
      sourceUsdcDeploymentId: SOLANA_USDC_DEPLOYMENT_ID,
      sourceUsdcAddress: SOLANA_USDC_ADDRESS,
      sourceUsdcStandard: 'spl-token',
      swiftContract: SOLANA_SWIFT_PROGRAM,
      forwarderAddress: null,
      forwarderFunctionSelector: null,
    }
  }
  return fail('BRIDGE_UNSUPPORTED_ROUTE')
}

const findCapability = (facts: DirectionFacts): BridgeCapability => {
  const capability = BRIDGE_CAPABILITIES.find(
    (entry) =>
      entry.bridgeCapabilityId === facts.bridgeCapabilityId &&
      entry.sourceChainId === facts.sourceChainId &&
      entry.destinationChainId === facts.destinationChainId &&
      entry.sourceTokenDeploymentId === facts.sourceTokenDeploymentId &&
      entry.destinationTokenDeploymentId === facts.destinationTokenDeploymentId,
  )
  if (!capability) fail('BRIDGE_UNSUPPORTED_ROUTE')
  return capability as BridgeCapability
}

const validateCatalogDirection = (facts: DirectionFacts): void => {
  const sourceToken = getTokenDeployment(facts.sourceTokenDeploymentId)
  const destinationToken = getTokenDeployment(facts.destinationTokenDeploymentId)
  const sourceUsdc = getTokenDeployment(facts.sourceUsdcDeploymentId)
  if (
    !catalogTokenMatches(sourceToken, {
      deploymentId: facts.sourceTokenDeploymentId,
      chainId: facts.sourceChainId,
      address: facts.sourceTokenAddress,
      standard: facts.sourceTokenStandard,
      decimals: 6,
    }) ||
    !catalogTokenMatches(destinationToken, {
      deploymentId: facts.destinationTokenDeploymentId,
      chainId: facts.destinationChainId,
      address: facts.destinationTokenAddress,
      standard: facts.destinationTokenStandard,
      decimals: 6,
    }) ||
    !catalogTokenMatches(sourceUsdc, {
      deploymentId: facts.sourceUsdcDeploymentId,
      chainId: facts.sourceChainId,
      address: facts.sourceUsdcAddress,
      standard: facts.sourceUsdcStandard,
      decimals: 6,
    })
  ) {
    fail('BRIDGE_UNSUPPORTED_ROUTE')
  }
}

const validateCapability = (
  capability: BridgeCapability,
  facts: DirectionFacts,
): void => {
  const expected: BridgeCapability = {
    bridgeCapabilityId: facts.bridgeCapabilityId,
    providerId: 'mayan-swift-v2',
    capabilityKind: 'external-provider-dynamic',
    sourceChainId: facts.sourceChainId,
    destinationChainId: facts.destinationChainId,
    sourceTokenDeploymentId: facts.sourceTokenDeploymentId,
    destinationTokenDeploymentId: facts.destinationTokenDeploymentId,
    sourceTokenAddress: facts.sourceTokenAddress,
    destinationTokenAddress: facts.destinationTokenAddress,
    sourceTokenStandard: facts.sourceTokenStandard,
    destinationTokenStandard: facts.destinationTokenStandard,
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    sourceProviderChainName: facts.sourceName,
    destinationProviderChainName: facts.destinationName,
    sourceProviderChainId: facts.sourceProviderChainId,
    destinationProviderChainId: facts.destinationProviderChainId,
    sourceWormholeChainId: facts.sourceWormholeChainId,
    destinationWormholeChainId: facts.destinationWormholeChainId,
    sourceUsdcDeploymentId: facts.sourceUsdcDeploymentId,
    sourceUsdcAddress: facts.sourceUsdcAddress,
    sourceUsdcStandard: facts.sourceUsdcStandard,
    sourceUsdcDecimals: 6,
    swiftContract: facts.swiftContract,
    forwarderAddress: facts.sourceChainId === ETHEREUM_CHAIN_ID ? ETHEREUM_FORWARDER : null,
    forwarderFunctionSelector: facts.sourceChainId === ETHEREUM_CHAIN_ID
      ? facts.asset === 'usdc'
        ? ETHEREUM_USDC_FORWARDER_SELECTOR
        : ETHEREUM_EURC_FORWARDER_SELECTOR
      : null,
    jupiterProgramAddress: facts.sourceChainId === SOLANA_CHAIN_ID && facts.asset === 'eurc'
      ? SOLANA_JUPITER_V6
      : null,
    builderEndpoint: DEFAULT_BUILDER_ENDPOINT,
    explorerEndpoint: DEFAULT_EXPLORER_ENDPOINT,
    dependencies: facts.asset === 'usdc'
      ? [...DIRECT_USDC_DEPENDENCIES]
      : facts.sourceChainId === SOLANA_CHAIN_ID
        ? [...DEPENDENCIES, 'jupiter-v6-source-swap']
        : [...DEPENDENCIES],
    status: 'active',
  }
  const actualKeys = Object.keys(capability).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('BRIDGE_UNSUPPORTED_ROUTE')
  }
  for (const key of expectedKeys) {
    const actual = capability[key as keyof BridgeCapability]
    const wanted = expected[key as keyof BridgeCapability]
    if (Array.isArray(actual) || Array.isArray(wanted)) {
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail('BRIDGE_UNSUPPORTED_ROUTE')
    } else if (actual !== wanted) {
      fail('BRIDGE_UNSUPPORTED_ROUTE')
    }
  }
}

const validateBridgeRoute = (
  request: unknown,
): { readonly request: MayanSwiftV2QuoteRequest; readonly facts: DirectionFacts; readonly capability: BridgeCapability } => {
  const value = requireRecord(request, 'BRIDGE_INVALID_ARGUMENT')
  const keys = new Set([
    'sourceChainId',
    'destinationChainId',
    'sourceTokenDeploymentId',
    'destinationTokenDeploymentId',
    'amountIn',
    'slippageBps',
  ])
  if (Object.keys(value).some((key) => !keys.has(key))) fail('BRIDGE_INVALID_ARGUMENT')
  const sourceChainId = requireString(value.sourceChainId, 'BRIDGE_INVALID_ARGUMENT')
  const destinationChainId = requireString(value.destinationChainId, 'BRIDGE_INVALID_ARGUMENT')
  const sourceTokenDeploymentId = requireString(
    value.sourceTokenDeploymentId,
    'BRIDGE_INVALID_ARGUMENT',
  )
  const destinationTokenDeploymentId = requireString(
    value.destinationTokenDeploymentId,
    'BRIDGE_INVALID_ARGUMENT',
  )
  const amountIn = normalizePositiveUint64(value.amountIn, 'BRIDGE_INVALID_ARGUMENT')
  const slippageBps = normalizeSlippage(value.slippageBps, 'BRIDGE_INVALID_ARGUMENT')
  const facts = directionFacts(
    sourceChainId,
    destinationChainId,
    sourceTokenDeploymentId,
    destinationTokenDeploymentId,
  )
  validateCatalogDirection(facts)
  const capability = findCapability(facts)
  validateCapability(capability, facts)
  return {
    request: {
      sourceChainId,
      destinationChainId,
      sourceTokenDeploymentId,
      destinationTokenDeploymentId,
      amountIn: amountIn.source,
      slippageBps,
    },
    facts,
    capability,
  }
}

const isJsonWhitespace = (character: string): boolean =>
  character === ' ' || character === '\n' || character === '\r' || character === '\t'

class StrictJsonParser {
  readonly #source: string
  #index = 0

  constructor(source: string) {
    this.#source = source
  }

  parse(): JsonNode {
    this.#skipWhitespace()
    const value = this.#value(0)
    this.#skipWhitespace()
    if (this.#index !== this.#source.length) this.#invalid()
    return value
  }

  #value(depth: number): JsonNode {
    if (depth > MAX_JSON_DEPTH) this.#invalid()
    const start = this.#index
    const character = this.#source[this.#index]
    if (character === '{') return this.#object(start, depth)
    if (character === '[') return this.#array(start, depth)
    if (character === '"') {
      const value = this.#string()
      return { value, start, end: this.#index }
    }
    if (character === 't' && this.#source.startsWith('true', this.#index)) {
      this.#index += 4
      return { value: true, start, end: this.#index }
    }
    if (character === 'f' && this.#source.startsWith('false', this.#index)) {
      this.#index += 5
      return { value: false, start, end: this.#index }
    }
    if (character === 'n' && this.#source.startsWith('null', this.#index)) {
      this.#index += 4
      return { value: null, start, end: this.#index }
    }
    if (character === '-' || (character !== undefined && /[0-9]/u.test(character))) {
      const rawNumber = this.#number()
      const value = Number(rawNumber)
      if (!Number.isFinite(value)) this.#invalid()
      return { value, start, end: this.#index, rawNumber }
    }
    return this.#invalid()
  }

  #object(start: number, depth: number): JsonNode {
    this.#index += 1
    this.#skipWhitespace()
    const object: JsonRecord = Object.create(null) as JsonRecord
    const entries = new Map<string, JsonNode>()
    if (this.#source[this.#index] === '}') {
      this.#index += 1
      return { value: object, start, end: this.#index, objectEntries: entries }
    }
    while (true) {
      if (this.#source[this.#index] !== '"') this.#invalid()
      const key = this.#string()
      if (entries.has(key)) this.#invalid()
      this.#skipWhitespace()
      if (this.#source[this.#index] !== ':') this.#invalid()
      this.#index += 1
      this.#skipWhitespace()
      const child = this.#value(depth + 1)
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      })
      entries.set(key, child)
      this.#skipWhitespace()
      const delimiter = this.#source[this.#index]
      if (delimiter === '}') {
        this.#index += 1
        return {
          value: object,
          start,
          end: this.#index,
          objectEntries: entries,
        }
      }
      if (delimiter !== ',') this.#invalid()
      this.#index += 1
      this.#skipWhitespace()
    }
  }

  #array(start: number, depth: number): JsonNode {
    this.#index += 1
    this.#skipWhitespace()
    const items: JsonNode[] = []
    if (this.#source[this.#index] === ']') {
      this.#index += 1
      return { value: items, start, end: this.#index, arrayItems: items }
    }
    while (true) {
      items.push(this.#value(depth + 1))
      this.#skipWhitespace()
      const delimiter = this.#source[this.#index]
      if (delimiter === ']') {
        this.#index += 1
        return { value: items, start, end: this.#index, arrayItems: items }
      }
      if (delimiter !== ',') this.#invalid()
      this.#index += 1
      this.#skipWhitespace()
    }
  }

  #string(): string {
    const start = this.#index
    this.#index += 1
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index]
      if (character === '"') {
        this.#index += 1
        const raw = this.#source.slice(start, this.#index)
        try {
          return JSON.parse(raw) as string
        } catch {
          this.#invalid()
        }
      }
      if (character === '\\') {
        this.#index += 1
        const escape = this.#source[this.#index]
        if (escape === 'u') {
          const digits = this.#source.slice(this.#index + 1, this.#index + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) this.#invalid()
          this.#index += 5
          continue
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) this.#invalid()
        this.#index += 1
        continue
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) this.#invalid()
      this.#index += 1
    }
    return this.#invalid()
  }

  #number(): string {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy.exec(
      this.#source.slice(this.#index),
    )
    if (!match) this.#invalid()
    const raw = match?.[0] as string
    this.#index += raw.length
    return raw
  }

  #skipWhitespace(): void {
    while (this.#index < this.#source.length && isJsonWhitespace(this.#source[this.#index] ?? '')) {
      this.#index += 1
    }
  }

  #invalid(): never {
    return fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
  }
}

const parseProviderResponse = (text: string): ProviderResponse => {
  let root: JsonNode
  try {
    root = new StrictJsonParser(text).parse()
  } catch (error) {
    if (error instanceof BridgeError) throw error
    return fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
  }
  return { text, root: root as JsonNode }
}

const objectEntry = (node: JsonNode, key: string): JsonNode | undefined =>
  node.objectEntries?.get(key)

const objectValue = (node: JsonNode, key: string): unknown =>
  objectEntry(node, key)?.value

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength

const requestAbortError = (): DOMException =>
  new DOMException('The bridge provider request was aborted', 'AbortError')

const throwIfRequestAborted = (
  controlled: RequestSignal,
  external: AbortSignal | undefined,
): void => {
  if (controlled.timedOut()) fail('BRIDGE_TIMEOUT')
  if (external?.aborted) fail('BRIDGE_ABORTED')
}

const readWithSignal = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  if (signal.aborted) throw signal.reason ?? requestAbortError()
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason ?? requestAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let read: Promise<ReadableStreamReadResult<Uint8Array>>
    try {
      read = reader.read()
    } catch (error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
      return
    }
    void read.then(
      (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

const cancelResponseBody = (response: Response): void => {
  const body = response.body
  if (body === null || response.bodyUsed) return
  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // A body can already be locked or closed by the provider runtime.
  }
}

const decodeResponseBody = async (
  response: Response,
  controlled: RequestSignal,
  external: AbortSignal | undefined,
): Promise<string> => {
  throwIfRequestAborted(controlled, external)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    try {
      if (BigInt(contentLength) > BigInt(MAX_RESPONSE_BYTES)) {
        fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
      }
    } catch {
      // An unrepresentable declaration is handled by the streaming byte cap.
    }
  }

  const body = response.body
  if (body === null) return ''

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    return fail('BRIDGE_PROVIDER_TRANSPORT')
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let bodyComplete = false
  const releaseReader = (): void => {
    try {
      reader.releaseLock()
    } catch {
      // The provider runtime may keep a lock while an aborted read settles.
    }
  }
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await readWithSignal(reader, controlled.signal)
      } catch (error) {
        throwIfRequestAborted(controlled, external)
        if (error instanceof BridgeError) throw error
        return fail('BRIDGE_PROVIDER_TRANSPORT')
      }
      throwIfRequestAborted(controlled, external)
      if (result.done) {
        bodyComplete = true
        break
      }
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) return fail('BRIDGE_PROVIDER_TRANSPORT')
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
      }
      chunks.push(chunk)
    }

    throwIfRequestAborted(controlled, external)
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
    }
  } finally {
    if (!bodyComplete) {
      try {
        const cancellation = reader.cancel()
        void cancellation.then(releaseReader, releaseReader)
      } catch {
        // Cancellation is best-effort when a custom provider stream is stalled.
      }
    }
    releaseReader()
  }
}

const CONFIG_KEYS = new Set([
  'builderEndpoint',
  'explorerEndpoint',
  'builderApiKey',
  'allowUnauthenticatedBuild',
  'minimumQuoteValiditySeconds',
  'timeoutMs',
  'fetch',
  'localBuild',
])

const endpointWithPath = (base: URL, path: string): URL =>
  new URL(path.replace(/^\/+/, ''), `${base.toString().replace(/\/+$/u, '')}/`)

const normalizeProviderEndpoint = (
  value: unknown,
  fallback: string,
  label: string,
): URL => {
  const sourceValue = value === undefined ? fallback : value
  if (typeof sourceValue !== 'string') return fail('BRIDGE_INVALID_ARGUMENT')
  const source = sourceValue
  if (source.length === 0 || source.trim() !== source) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(source) || source.includes('#')) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const authorityStart = source.indexOf('://') + 3
  const authority = source.slice(authorityStart).split(/[/?#]/u, 1)[0] ?? ''
  if (authority.length === 0 || authority.includes('@')) fail('BRIDGE_INVALID_ARGUMENT')

  let endpoint: URL
  try {
    endpoint = new URL(source)
  } catch {
    return fail('BRIDGE_INVALID_ARGUMENT')
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname))
  ) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  if (
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    source.includes('?') ||
    endpoint.search ||
    endpoint.hash
  ) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  // Touching port forces URL's parser to have accepted a valid numeric port;
  // malformed ports fail in the constructor above.
  if (endpoint.port !== '' && (!/^\d+$/u.test(endpoint.port) || Number(endpoint.port) > 65535)) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
  if (!endpoint.pathname.startsWith('/')) fail('BRIDGE_INVALID_ARGUMENT')
  void label
  return endpoint as URL
}

const normalizeBridgeConfig = (
  config: MayanSwiftV2BridgeConfig | undefined,
): NormalizedBridgeConfig => {
  const value: JsonRecord = config === undefined
    ? {}
    : requireRecord(config, 'BRIDGE_INVALID_ARGUMENT')
  if (Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const builderEndpoint = normalizeProviderEndpoint(
    value.builderEndpoint,
    DEFAULT_BUILDER_ENDPOINT,
    'builderEndpoint',
  )
  const explorerEndpoint = normalizeProviderEndpoint(
    value.explorerEndpoint,
    DEFAULT_EXPLORER_ENDPOINT,
    'explorerEndpoint',
  )
  let builderApiKey: string | undefined
  if (value.builderApiKey !== undefined) {
    const builderApiKeyValue = value.builderApiKey
    if (
      typeof builderApiKeyValue !== 'string' ||
      /[\u0000-\u001f\u007f]/u.test(builderApiKeyValue)
    ) {
      fail('BRIDGE_INVALID_ARGUMENT')
    }
    const validatedBuilderApiKey = builderApiKeyValue as string
    builderApiKey = validatedBuilderApiKey.length === 0
      ? undefined
      : validatedBuilderApiKey
  }
  const allowUnauthenticatedBuildValue = value.allowUnauthenticatedBuild ?? false
  if (typeof allowUnauthenticatedBuildValue !== 'boolean') {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const allowUnauthenticatedBuild = allowUnauthenticatedBuildValue as boolean
  const minimumQuoteValiditySecondsValue = value.minimumQuoteValiditySeconds ?? 60
  if (
    typeof minimumQuoteValiditySecondsValue !== 'number' ||
    !Number.isSafeInteger(minimumQuoteValiditySecondsValue) ||
    minimumQuoteValiditySecondsValue < 0 ||
    minimumQuoteValiditySecondsValue > 300
  ) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const minimumQuoteValiditySeconds = minimumQuoteValiditySecondsValue as number
  const timeoutMsValue = value.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMsValue !== 'number' || !Number.isSafeInteger(timeoutMsValue) || timeoutMsValue <= 0) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const timeoutMs = timeoutMsValue as number
  const implementation = value.fetch ?? globalThis.fetch
  if (typeof implementation !== 'function') fail('BRIDGE_INVALID_ARGUMENT')
  let localBuild: MayanSwiftV2LocalBuildConfig | undefined
  if (value.localBuild !== undefined) {
    const localBuildValue = requireRecord(value.localBuild, 'BRIDGE_INVALID_ARGUMENT')
    const localBuildKeys = new Set(['sourceSwapEndpoint', 'ethereumRpc', 'solanaRpc'])
    if (Object.keys(localBuildValue).some((key) => !localBuildKeys.has(key))) {
      fail('BRIDGE_INVALID_ARGUMENT')
    }
    localBuild = localBuildValue as MayanSwiftV2LocalBuildConfig
  }
  return Object.freeze({
    builderEndpoint,
    explorerEndpoint,
    ...(builderApiKey === undefined ? {} : { builderApiKey }),
    allowUnauthenticatedBuild,
    minimumQuoteValiditySeconds,
    timeoutMs,
    fetch: wrapFetch(implementation as typeof globalThis.fetch),
    ...(localBuild === undefined ? {} : { localBuild }),
  })
}

interface RequestSignal {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly cleanup: () => void
}

interface ProviderRequestResult {
  readonly response: Response
  readonly controlled: RequestSignal
  readonly external: AbortSignal | undefined
}

const requestSignal = (
  timeoutMs: number,
  external: AbortSignal | undefined,
): RequestSignal => {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout)
      external?.removeEventListener('abort', onAbort)
    },
  }
}

const providerRequest = async (
  config: NormalizedBridgeConfig,
  endpoint: URL,
  method: 'GET' | 'POST',
  body: string | undefined,
  includeBuilderKey: boolean,
  options: BridgeRequestOptions | undefined,
): Promise<ProviderRequestResult> => {
  if (options?.signal?.aborted) fail('BRIDGE_ABORTED')
  const controlled = requestSignal(config.timeoutMs, options?.signal)
  try {
    const headers: Record<string, string> = {}
    headers.accept = 'application/json'
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (includeBuilderKey && config.builderApiKey !== undefined) {
      headers['x-api-key'] = config.builderApiKey
    }
    let response: Response
    try {
      response = await config.fetch(endpoint, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controlled.signal,
        credentials: 'omit',
        redirect: 'manual',
      })
      if (controlled.timedOut()) fail('BRIDGE_TIMEOUT')
      if (options?.signal?.aborted) fail('BRIDGE_ABORTED')
    } catch {
      if (controlled.timedOut()) fail('BRIDGE_TIMEOUT')
      if (options?.signal?.aborted) fail('BRIDGE_ABORTED')
      return fail('BRIDGE_PROVIDER_TRANSPORT')
    }
    return {
      response: response as Response,
      controlled,
      external: options?.signal,
    }
  } catch (error) {
    controlled.cleanup()
    if (error instanceof BridgeError) throw error
    if (controlled.timedOut()) fail('BRIDGE_TIMEOUT')
    if (options?.signal?.aborted) fail('BRIDGE_ABORTED')
    return fail('BRIDGE_PROVIDER_TRANSPORT')
  }
}

const providerHttpStatus = (
  response: Response,
  kind: 'quote' | 'build' | 'status',
): void => {
  if (kind === 'status' && response.status === 404) fail('BRIDGE_STATUS_NOT_FOUND')
  if (response.status >= 300 && response.status < 400) {
    fail('BRIDGE_PROVIDER_TRANSPORT')
  }
  if (kind === 'build' && (response.status === 401 || response.status === 403)) {
    fail('BRIDGE_PROVIDER_AUTH_REQUIRED')
  }
  if (response.status !== 200 && response.status !== 201) {
    fail('BRIDGE_PROVIDER_HTTP', response.status)
  }
}

const providerJson = async (
  request: ProviderRequestResult,
  kind: 'quote' | 'build' | 'status',
): Promise<ProviderResponse> => {
  try {
    providerHttpStatus(request.response, kind)
    const text = await decodeResponseBody(
      request.response,
      request.controlled,
      request.external,
    )
    throwIfRequestAborted(request.controlled, request.external)
    const parsed = parseProviderResponse(text)
    throwIfRequestAborted(request.controlled, request.external)
    return parsed
  } finally {
    cancelResponseBody(request.response)
    request.controlled.cleanup()
  }
}

const encodeBase58 = (bytes: Uint8Array): string => {
  let zeroes = 0
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1
  if (zeroes === bytes.length) return '1'.repeat(zeroes)
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const value = (digits[index] ?? 0) * 256 + carry
      digits[index] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let result = '1'.repeat(zeroes)
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += BASE58_ALPHABET[digits[index] ?? 0] ?? ''
  }
  return result === '' ? '1' : result
}

const decodeBase58 = (
  value: unknown,
  expectedBytes: number,
  code: BridgeErrorCode,
): Uint8Array => {
  const text = requireString(value, code)
  if (text.length > expectedBytes * 2 || [...text].some((char) => !BASE58_ALPHABET.includes(char))) {
    fail(code)
  }
  const bytes: number[] = [0]
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char)
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      const current = (bytes[index] ?? 0) * 58 + carry
      bytes[index] = current % 256
      carry = Math.floor(current / 256)
    }
    while (carry > 0) {
      bytes.push(carry % 256)
      carry = Math.floor(carry / 256)
    }
  }
  let zeroes = 0
  while (zeroes < text.length && text[zeroes] === '1') zeroes += 1
  const result = new Uint8Array(zeroes + (bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length))
  for (let index = 0; index < bytes.length && !(bytes.length === 1 && bytes[0] === 0); index += 1) {
    result[result.length - 1 - index] = bytes[index] ?? 0
  }
  if (result.length !== expectedBytes || encodeBase58(result) !== text) fail(code)
  return result
}

const decodeBase64 = (value: unknown, code: BridgeErrorCode): Uint8Array => {
  const text = requireString(value, code)
  if (!BASE64.test(text)) fail(code)
  let binary: string
  try {
    binary = globalThis.atob(text)
  } catch {
    return fail(code)
  }
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  let canonical: string
  try {
    canonical = globalThis.btoa(binary)
  } catch {
    return fail(code)
  }
  if (canonical !== text) fail(code)
  return result
}

interface ByteCursor {
  readonly bytes: Uint8Array
  index: number
}

const readBytes = (cursor: ByteCursor, count: number, code: BridgeErrorCode): Uint8Array => {
  if (!Number.isSafeInteger(count) || count < 0 || cursor.index + count > cursor.bytes.length) fail(code)
  const value = cursor.bytes.slice(cursor.index, cursor.index + count)
  cursor.index += count
  return value
}

const readShortVec = (cursor: ByteCursor, maximum: number, code: BridgeErrorCode): number => {
  let value = 0
  let shift = 0
  for (let count = 0; count < 5; count += 1) {
    const byte = readBytes(cursor, 1, code)[0] ?? 0
    const payload = byte & 0x7f
    if (shift >= 28 || payload > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** shift)) fail(code)
    value += payload * 2 ** shift
    if ((byte & 0x80) === 0) {
      if (count > 0 && payload === 0) fail(code)
      if (!Number.isSafeInteger(value) || value > maximum) fail(code)
      return value
    }
    shift += 7
  }
  return fail(code)
}

const allZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0)

const validateSolanaTransaction = (
  encoded: unknown,
  feePayer: string,
): string => {
  const bytes = decodeBase64(encoded, 'BRIDGE_BUILD_INVALID')
  if (bytes.byteLength === 0 || bytes.byteLength > 1232) fail('BRIDGE_BUILD_INVALID')
  const cursor: ByteCursor = { bytes, index: 0 }
  const signatureCount = readShortVec(cursor, 1, 'BRIDGE_BUILD_INVALID')
  if (signatureCount !== 1 || !allZero(readBytes(cursor, 64, 'BRIDGE_BUILD_INVALID'))) {
    fail('BRIDGE_BUILD_INVALID')
  }
  const version = readBytes(cursor, 1, 'BRIDGE_BUILD_INVALID')[0]
  if (version !== 0x80) fail('BRIDGE_BUILD_INVALID')
  const requiredSignatures = readBytes(cursor, 1, 'BRIDGE_BUILD_INVALID')[0] ?? 0
  const readonlySigned = readBytes(cursor, 1, 'BRIDGE_BUILD_INVALID')[0] ?? 0
  const readonlyUnsigned = readBytes(cursor, 1, 'BRIDGE_BUILD_INVALID')[0] ?? 0
  if (requiredSignatures !== 1 || readonlySigned !== 0) fail('BRIDGE_BUILD_INVALID')
  const staticKeyCount = readShortVec(cursor, 64, 'BRIDGE_BUILD_INVALID')
  if (staticKeyCount === 0 || readonlyUnsigned >= staticKeyCount) fail('BRIDGE_BUILD_INVALID')
  const staticKeys = readBytes(cursor, staticKeyCount * 32, 'BRIDGE_BUILD_INVALID')
  const payerBytes = decodeBase58(feePayer, 32, 'BRIDGE_BUILD_INVALID')
  if (!staticKeys.slice(0, 32).every((byte, index) => byte === payerBytes[index])) fail('BRIDGE_BUILD_INVALID')
  readBytes(cursor, 32, 'BRIDGE_BUILD_INVALID')
  const instructionCount = readShortVec(cursor, 64, 'BRIDGE_BUILD_INVALID')
  let largestAccountIndex = -1
  for (let instruction = 0; instruction < instructionCount; instruction += 1) {
    largestAccountIndex = Math.max(
      largestAccountIndex,
      readBytes(cursor, 1, 'BRIDGE_BUILD_INVALID')[0] ?? 0,
    )
    const accountCount = readShortVec(cursor, 64, 'BRIDGE_BUILD_INVALID')
    const accountIndices = readBytes(cursor, accountCount, 'BRIDGE_BUILD_INVALID')
    for (const index of accountIndices) largestAccountIndex = Math.max(largestAccountIndex, index)
    const dataLength = readShortVec(cursor, 1024, 'BRIDGE_BUILD_INVALID')
    readBytes(cursor, dataLength, 'BRIDGE_BUILD_INVALID')
  }
  const lookupCount = readShortVec(cursor, 32, 'BRIDGE_BUILD_INVALID')
  let loadedAddressCount = 0
  for (let lookup = 0; lookup < lookupCount; lookup += 1) {
    readBytes(cursor, 32, 'BRIDGE_BUILD_INVALID')
    const writableCount = readShortVec(cursor, 64, 'BRIDGE_BUILD_INVALID')
    readBytes(cursor, writableCount, 'BRIDGE_BUILD_INVALID')
    const readonlyCount = readShortVec(cursor, 64, 'BRIDGE_BUILD_INVALID')
    readBytes(cursor, readonlyCount, 'BRIDGE_BUILD_INVALID')
    loadedAddressCount += writableCount + readonlyCount
    if (loadedAddressCount > 256) fail('BRIDGE_BUILD_INVALID')
  }
  if (largestAccountIndex >= staticKeyCount + loadedAddressCount || cursor.index !== bytes.length) {
    fail('BRIDGE_BUILD_INVALID')
  }
  return requireString(encoded, 'BRIDGE_BUILD_INVALID')
}

const providerInvalid = (): never => fail('BRIDGE_PROVIDER_INVALID_RESPONSE')

const requiredNode = (node: JsonNode, key: string): JsonNode => {
  const child = objectEntry(node, key)
  if (!child) providerInvalid()
  return child as JsonNode
}

const providerString = (
  node: JsonNode,
  key: string,
  allowEmpty = false,
): string => {
  const value = requiredNode(node, key).value
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    providerInvalid()
  }
  return value as string
}

const providerBoolean = (node: JsonNode, key: string): boolean => {
  const value = requiredNode(node, key).value
  if (typeof value !== 'boolean') providerInvalid()
  return value as boolean
}

const providerNumber = (node: JsonNode, key: string): number => {
  const value = requiredNode(node, key).value
  if (typeof value !== 'number' || !Number.isFinite(value)) providerInvalid()
  return value as number
}

const providerInteger = (node: JsonNode, key: string): number => {
  const value = providerNumber(node, key)
  if (!Number.isSafeInteger(value)) providerInvalid()
  return value
}

const providerAddress = (
  node: JsonNode,
  key: string,
  expected: string,
): string => {
  const value = providerString(node, key)
  if (!providerAddressEquals(value, expected)) providerInvalid()
  return EVM_ADDRESS.test(value) ? value.toLowerCase() : value
}

const providerUint64 = (
  node: JsonNode,
  key: string,
  positive: boolean,
): { readonly source: string; readonly value: bigint } => {
  const value = providerString(node, key)
  try {
    return positive
      ? normalizePositiveUint64(value, 'BRIDGE_PROVIDER_INVALID_RESPONSE')
      : normalizeCanonicalUint64(value, 'BRIDGE_PROVIDER_INVALID_RESPONSE')
  } catch (error) {
    if (error instanceof BridgeError) throw error
    return providerInvalid()
  }
}

const providerToken = (
  node: JsonNode,
  expected: {
    readonly address: string
    readonly standard: 'erc20' | 'spl'
    readonly chainId: number
    readonly wormholeChainId: number
    readonly mint: string
    readonly name: 'EuroC' | 'USD Coin'
  },
): void => {
  if (!isRecord(node.value)) providerInvalid()
  const contract = providerString(node, 'contract')
  if (!providerAddressEquals(contract, expected.address)) providerInvalid()
  const mint = providerString(node, 'mint', true)
  if (mint !== expected.mint) providerInvalid()
  const realOrigin = providerString(node, 'realOriginContractAddress')
  if (!providerAddressEquals(realOrigin, expected.address)) providerInvalid()
  if (providerString(node, 'name') !== expected.name) providerInvalid()
  if (providerString(node, 'standard') !== expected.standard) providerInvalid()
  if (providerInteger(node, 'chainId') !== expected.chainId) providerInvalid()
  if (providerInteger(node, 'wChainId') !== expected.wormholeChainId) providerInvalid()
  if (providerInteger(node, 'realOriginChainId') !== expected.wormholeChainId) providerInvalid()
  if (providerInteger(node, 'decimals') !== 6) providerInvalid()
}

const quoteProviderStandard = (facts: DirectionFacts): 'erc20' | 'spl' =>
  facts.sourceChainId === ETHEREUM_CHAIN_ID ? 'erc20' : 'spl'

interface ValidatedProviderQuote {
  readonly quote: MayanSwiftV2Quote
  readonly rawNode: JsonNode
  readonly deadlineValue: bigint
}

const ensureQuoteDeadline = (
  deadlineValue: bigint,
  margin: number,
): void => {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (!Number.isSafeInteger(Number(now)) || deadlineValue < now + BigInt(margin)) {
    fail('BRIDGE_QUOTE_EXPIRED')
  }
}

const validateProviderQuote = (
  node: JsonNode,
  text: string,
  request: MayanSwiftV2QuoteRequest,
  facts: DirectionFacts,
  config: NormalizedBridgeConfig,
): ValidatedProviderQuote => {
  if (!isRecord(node.value)) providerInvalid()
  const raw = text.slice(node.start, node.end)
  if (byteLength(raw) > MAX_RAW_QUOTE_BYTES) providerInvalid()
  if (providerString(node, 'type') !== 'SWIFT') providerInvalid()
  if (providerString(node, 'swiftVersion') !== 'V2') providerInvalid()
  if (providerBoolean(node, 'gasless')) providerInvalid()
  if (providerString(node, 'fromChain') !== facts.sourceName) providerInvalid()
  if (providerString(node, 'toChain') !== facts.destinationName) providerInvalid()
  if (providerInteger(node, 'slippageBps') !== request.slippageBps) providerInvalid()
  if (providerBoolean(node, 'onlyBridging')) providerInvalid()

  const effectiveAmount = providerUint64(node, 'effectiveAmountIn64', true)
  if (effectiveAmount.source !== request.amountIn) providerInvalid()
  const expectedAmountOut = providerUint64(node, 'expectedAmountOutBaseUnits', true)
  const minimumAmountOut = providerUint64(node, 'minAmountOutBaseUnits', true)
  const minimumReceived = providerUint64(node, 'minReceivedBaseUnits', true)
  if (minimumAmountOut.value > expectedAmountOut.value || minimumReceived.value > minimumAmountOut.value) {
    providerInvalid()
  }
  const deadline = providerUint64(node, 'deadline64', true)
  ensureQuoteDeadline(deadline.value, config.minimumQuoteValiditySeconds)

  const sourceToken = requiredNode(node, 'fromToken')
  const destinationToken = requiredNode(node, 'toToken')
  providerToken(sourceToken, {
    address: facts.sourceTokenAddress,
    standard: facts.sourceChainId === ETHEREUM_CHAIN_ID ? 'erc20' : 'spl',
    chainId: facts.sourceProviderChainId,
    wormholeChainId: facts.sourceWormholeChainId,
    mint: facts.sourceTokenMint,
    name: facts.sourceTokenName,
  })
  providerToken(destinationToken, {
    address: facts.destinationTokenAddress,
    standard: facts.destinationChainId === ETHEREUM_CHAIN_ID ? 'erc20' : 'spl',
    chainId: facts.destinationProviderChainId,
    wormholeChainId: facts.destinationWormholeChainId,
    mint: facts.destinationTokenMint,
    name: facts.destinationTokenName,
  })

  const sourceUsdcStandard = quoteProviderStandard(facts)
  if (providerAddress(node, 'swiftInputContract', facts.sourceUsdcAddress) !== facts.sourceUsdcAddress) {
    providerInvalid()
  }
  if (providerString(node, 'swiftInputContractStandard') !== sourceUsdcStandard) providerInvalid()
  if (providerInteger(node, 'swiftInputDecimals') !== 6) providerInvalid()
  if (providerAddress(node, 'swiftMayanContract', facts.swiftContract) !== facts.swiftContract) {
    providerInvalid()
  }

  const middleNode = requiredNode(node, 'minMiddleAmount')
  if (
    middleNode.rawNumber === undefined ||
    typeof middleNode.value !== 'number' ||
    !Number.isFinite(middleNode.value) ||
    middleNode.value <= 0
  ) {
    providerInvalid()
  }

  let routerAddress: string | null
  let routerKind: 'provider-selected-evm' | 'jupiter-v6' | null
  const evmRouter = objectValue(node, 'evmSwapRouterAddress')
  if (facts.asset === 'usdc') {
    if (evmRouter !== undefined && evmRouter !== null) providerInvalid()
    routerAddress = null
    routerKind = null
  } else if (facts.sourceChainId === ETHEREUM_CHAIN_ID) {
    routerAddress = normalizeEvmAddress(
      providerString(node, 'evmSwapRouterAddress'),
      'BRIDGE_PROVIDER_INVALID_RESPONSE',
    )
    routerKind = 'provider-selected-evm'
  } else {
    routerAddress = SOLANA_JUPITER_V6
    routerKind = 'jupiter-v6'
    if (evmRouter !== undefined && evmRouter !== null) providerInvalid()
  }

  const quoteId = providerString(node, 'quoteId')
  if (!/^0x[0-9a-fA-F]{32}$/u.test(quoteId)) providerInvalid()
  const signature = providerString(node, 'signature')
  if (!EVM_SIGNATURE.test(signature)) providerInvalid()

  const dependencies = facts.asset === 'usdc'
    ? [...DIRECT_USDC_DEPENDENCIES]
    : facts.sourceChainId === SOLANA_CHAIN_ID
      ? [...DEPENDENCIES, 'jupiter-v6-source-swap']
      : [...DEPENDENCIES]
  const quote: MayanSwiftV2Quote = {
    quoteKind: 'mayan-swift-v2',
    providerId: 'mayan-swift-v2',
    sourceChainId: request.sourceChainId,
    destinationChainId: request.destinationChainId,
    sourceTokenDeploymentId: request.sourceTokenDeploymentId,
    destinationTokenDeploymentId: request.destinationTokenDeploymentId,
    amountIn: effectiveAmount.source,
    expectedAmountOut: expectedAmountOut.source,
    minimumAmountOut: minimumAmountOut.source,
    minimumReceived: minimumReceived.source,
    deadline: deadline.source,
    slippageBps: request.slippageBps,
    quoteId: quoteId.toLowerCase(),
    providerSignature: signature.toLowerCase(),
    sourceSwap: {
      required: facts.asset === 'eurc',
      inputTokenDeploymentId: facts.asset === 'usdc'
        ? facts.sourceUsdcDeploymentId
        : facts.sourceTokenDeploymentId,
      intermediateTokenDeploymentId: facts.sourceUsdcDeploymentId,
      intermediateTokenAddress: facts.sourceUsdcAddress,
      intermediateTokenStandard: sourceUsdcStandard,
      intermediateTokenDecimals: 6,
      providerMinimumAmount: middleNode.rawNumber as string,
      routerKind,
      routerAddress,
    },
    dependencies,
    quoteVerification: 'provider-signed-not-locally-verified',
    rawSignedQuoteJson: raw,
  }
  return {
    quote: deepFreeze(quote),
    rawNode: node,
    deadlineValue: deadline.value,
  }
}

const QUOTE_KEYS = [
  'quoteKind',
  'providerId',
  'sourceChainId',
  'destinationChainId',
  'sourceTokenDeploymentId',
  'destinationTokenDeploymentId',
  'amountIn',
  'expectedAmountOut',
  'minimumAmountOut',
  'minimumReceived',
  'deadline',
  'slippageBps',
  'quoteId',
  'providerSignature',
  'sourceSwap',
  'dependencies',
  'quoteVerification',
  'rawSignedQuoteJson',
] as const
const SOURCE_SWAP_KEYS = [
  'required',
  'inputTokenDeploymentId',
  'intermediateTokenDeploymentId',
  'intermediateTokenAddress',
  'intermediateTokenStandard',
  'intermediateTokenDecimals',
  'providerMinimumAmount',
  'routerKind',
  'routerAddress',
] as const

const exactObjectKeys = (
  value: JsonRecord,
  expected: readonly string[],
  code: BridgeErrorCode,
): void => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code)
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const cloneQuote = (quote: MayanSwiftV2Quote): MayanSwiftV2Quote => {
  try {
    return JSON.parse(JSON.stringify(quote)) as MayanSwiftV2Quote
  } catch {
    return fail('BRIDGE_INVALID_ARGUMENT')
  }
}

const validateNormalizedQuoteShape = (
  quote: unknown,
  code: BridgeErrorCode,
): MayanSwiftV2Quote => {
  const value = requireRecord(quote, code)
  exactObjectKeys(value, QUOTE_KEYS, code)
  if (value.quoteKind !== 'mayan-swift-v2' || value.providerId !== 'mayan-swift-v2') fail(code)
  const sourceChainId = requireString(value.sourceChainId, code)
  const destinationChainId = requireString(value.destinationChainId, code)
  const sourceTokenDeploymentId = requireString(value.sourceTokenDeploymentId, code)
  const destinationTokenDeploymentId = requireString(value.destinationTokenDeploymentId, code)
  let facts: DirectionFacts
  try {
    facts = directionFacts(
      sourceChainId,
      destinationChainId,
      sourceTokenDeploymentId,
      destinationTokenDeploymentId,
    )
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'BRIDGE_UNSUPPORTED_ROUTE') {
      return fail(code)
    }
    throw error
  }
  if (
    sourceTokenDeploymentId !== facts.sourceTokenDeploymentId ||
    destinationTokenDeploymentId !== facts.destinationTokenDeploymentId
  ) fail(code)
  const amountIn = normalizePositiveUint64(value.amountIn, code)
  const expectedAmountOut = normalizePositiveUint64(value.expectedAmountOut, code)
  const minimumAmountOut = normalizePositiveUint64(value.minimumAmountOut, code)
  const minimumReceived = normalizePositiveUint64(value.minimumReceived, code)
  if (minimumAmountOut.value > expectedAmountOut.value || minimumReceived.value > minimumAmountOut.value) fail(code)
  const deadline = normalizePositiveUint64(value.deadline, code)
  const slippageBps = normalizeSlippage(value.slippageBps, code)
  if (value.quoteVerification !== 'provider-signed-not-locally-verified') fail(code)
  const quoteId = requireString(value.quoteId, code)
  if (!/^0x[0-9a-fA-F]{32}$/u.test(quoteId)) fail(code)
  const signature = requireString(value.providerSignature, code)
  if (!EVM_SIGNATURE.test(signature)) fail(code)
  const sourceSwap = requireRecord(value.sourceSwap, code)
  exactObjectKeys(sourceSwap, SOURCE_SWAP_KEYS, code)
  if (sourceSwap.required !== (facts.asset === 'eurc')) fail(code)
  if (
    sourceSwap.inputTokenDeploymentId !== (facts.asset === 'usdc'
      ? facts.sourceUsdcDeploymentId
      : facts.sourceTokenDeploymentId) ||
    sourceSwap.intermediateTokenDeploymentId !== facts.sourceUsdcDeploymentId
  ) fail(code)
  if (sourceSwap.intermediateTokenAddress !== facts.sourceUsdcAddress) fail(code)
  const providerStandard = quoteProviderStandard(facts)
  if (sourceSwap.intermediateTokenStandard !== providerStandard || sourceSwap.intermediateTokenDecimals !== 6) fail(code)
  const providerMinimumAmount = sourceSwap.providerMinimumAmount
  if (typeof providerMinimumAmount !== 'string' || providerMinimumAmount.length === 0) fail(code)
  let normalizedRouterAddress: string | null
  let normalizedRouterKind: 'provider-selected-evm' | 'jupiter-v6' | null
  if (facts.asset === 'usdc') {
    if (sourceSwap.routerKind !== null || sourceSwap.routerAddress !== null) fail(code)
    normalizedRouterAddress = null
    normalizedRouterKind = null
  } else if (facts.sourceChainId === ETHEREUM_CHAIN_ID) {
    const routerAddress = sourceSwap.routerAddress
    if (sourceSwap.routerKind !== 'provider-selected-evm' || typeof routerAddress !== 'string' || !EVM_ADDRESS.test(routerAddress) || /^0x0{40}$/iu.test(routerAddress)) return fail(code)
    normalizedRouterAddress = (routerAddress as string).toLowerCase()
    normalizedRouterKind = 'provider-selected-evm'
  } else if (sourceSwap.routerKind !== 'jupiter-v6' || sourceSwap.routerAddress !== SOLANA_JUPITER_V6) {
    return fail(code)
  } else {
    normalizedRouterAddress = SOLANA_JUPITER_V6
    normalizedRouterKind = 'jupiter-v6'
  }
  if (!Array.isArray(value.dependencies)) fail(code)
  const wantedDependencies = facts.asset === 'usdc'
    ? [...DIRECT_USDC_DEPENDENCIES]
    : facts.sourceChainId === SOLANA_CHAIN_ID
      ? [...DEPENDENCIES, 'jupiter-v6-source-swap']
      : [...DEPENDENCIES]
  if (stableJson(value.dependencies) !== stableJson(wantedDependencies)) fail(code)
  const rawSignedQuoteJson = requireString(value.rawSignedQuoteJson, code)
  if (byteLength(rawSignedQuoteJson) > MAX_RAW_QUOTE_BYTES) fail(code)
  return {
    quoteKind: 'mayan-swift-v2',
    providerId: 'mayan-swift-v2',
    sourceChainId,
    destinationChainId,
    sourceTokenDeploymentId: facts.sourceTokenDeploymentId,
    destinationTokenDeploymentId: facts.destinationTokenDeploymentId,
    amountIn: amountIn.source,
    expectedAmountOut: expectedAmountOut.source,
    minimumAmountOut: minimumAmountOut.source,
    minimumReceived: minimumReceived.source,
    deadline: deadline.source,
    slippageBps,
    quoteId: quoteId.toLowerCase(),
    providerSignature: signature.toLowerCase(),
    sourceSwap: {
      required: facts.asset === 'eurc',
      inputTokenDeploymentId: facts.asset === 'usdc'
        ? facts.sourceUsdcDeploymentId
        : facts.sourceTokenDeploymentId,
      intermediateTokenDeploymentId: facts.sourceUsdcDeploymentId,
      intermediateTokenAddress: facts.sourceUsdcAddress,
      intermediateTokenStandard: providerStandard,
      intermediateTokenDecimals: 6,
      providerMinimumAmount: providerMinimumAmount as string,
      routerKind: normalizedRouterKind,
      routerAddress: normalizedRouterAddress,
    },
    dependencies: wantedDependencies,
    quoteVerification: 'provider-signed-not-locally-verified',
    rawSignedQuoteJson,
  }
}

const quoteRequestBody = (route: ReturnType<typeof validateBridgeRoute>): string =>
  JSON.stringify({
    fromToken: route.facts.sourceTokenAddress,
    fromChain: route.facts.sourceName,
    toToken: route.facts.destinationTokenAddress,
    toChain: route.facts.destinationName,
    amountIn64: route.request.amountIn,
    slippageBps: route.request.slippageBps,
    swift: true,
    mctp: false,
    fastMctp: false,
    wormhole: false,
    monoChain: false,
    gasless: false,
    fullList: true,
    guaranteedOutput: true,
    gasDrop: 0,
  })

const quoteFromResponse = (
  response: ProviderResponse,
  request: MayanSwiftV2QuoteRequest,
  facts: DirectionFacts,
  config: NormalizedBridgeConfig,
): readonly MayanSwiftV2Quote[] => {
  if (!isRecord(response.root.value) || response.root.objectEntries === undefined) {
    providerInvalid()
  }
  if (objectValue(response.root, 'success') !== true) providerInvalid()
  const quotesNode = requiredNode(response.root, 'quotes')
  const quoteNodes = quotesNode.arrayItems
  if (!quoteNodes || quoteNodes.length > MAX_QUOTES) return providerInvalid()
  const selected: MayanSwiftV2Quote[] = []
  for (const quoteNode of quoteNodes) {
    if (!isRecord(quoteNode.value)) continue
    if (
      quoteNode.value.type !== 'SWIFT' ||
      quoteNode.value.swiftVersion !== 'V2' ||
      quoteNode.value.gasless !== false
    ) continue
    const validated = validateProviderQuote(
      quoteNode,
      response.text,
      request,
      facts,
      config,
    )
    selected.push(validated.quote)
  }
  if (selected.length === 0) fail('BRIDGE_QUOTE_UNAVAILABLE')
  for (const quote of selected) {
    ensureQuoteDeadline(
      normalizePositiveUint64(quote.deadline, 'BRIDGE_PROVIDER_INVALID_RESPONSE').value,
      config.minimumQuoteValiditySeconds,
    )
  }
  return deepFreeze(selected)
}

const buildRequestSnapshot = (
  value: unknown,
): { readonly quote: MayanSwiftV2Quote; readonly swapperAddress: unknown; readonly destinationAddress: unknown; readonly refundAddress: unknown } => {
  const request = requireRecord(value, 'BRIDGE_INVALID_ARGUMENT')
  const allowed = new Set(['quote', 'swapperAddress', 'destinationAddress', 'refundAddress'])
  if (Object.keys(request).some((key) => !allowed.has(key))) fail('BRIDGE_INVALID_ARGUMENT')
  if (!Object.hasOwn(request, 'quote') || !Object.hasOwn(request, 'swapperAddress') || !Object.hasOwn(request, 'destinationAddress')) {
    fail('BRIDGE_INVALID_ARGUMENT')
  }
  const rawQuote = request.quote
  if (!isRecord(rawQuote)) fail('BRIDGE_INVALID_ARGUMENT')
  let quote: MayanSwiftV2Quote
  try {
    quote = cloneQuote(rawQuote as MayanSwiftV2Quote)
  } catch {
    return fail('BRIDGE_INVALID_ARGUMENT')
  }
  return {
    quote,
    swapperAddress: request.swapperAddress,
    destinationAddress: request.destinationAddress,
    refundAddress: request.refundAddress,
  }
}

const normalizeChainAddress = (
  value: unknown,
  chainId: string,
  code: BridgeErrorCode,
): string => {
  if (chainId === ETHEREUM_CHAIN_ID) return normalizeEvmAddress(value, code)
  const address = requireString(value, code)
  decodeBase58(address, 32, code)
  return address
}

const isCanonicalSolanaAddress = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  try {
    decodeBase58(value, 32, 'BRIDGE_INVALID_ARGUMENT')
    return true
  } catch {
    return false
  }
}

const rejectAddressFromOtherChain = (
  value: unknown,
  expectedChainId: string,
): void => {
  const isEvm =
    typeof value === 'string' &&
    EVM_ADDRESS.test(value) &&
    !/^0x0{40}$/iu.test(value)
  const isSolana = isCanonicalSolanaAddress(value)
  if (
    (expectedChainId === ETHEREUM_CHAIN_ID && isSolana) ||
    (expectedChainId === SOLANA_CHAIN_ID && isEvm)
  ) {
    fail('BRIDGE_QUOTE_MISMATCH')
  }
}

const normalizeDestinationAddress = (
  value: unknown,
  destinationChainId: string,
): string => {
  return normalizeChainAddress(value, destinationChainId, 'BRIDGE_INVALID_ARGUMENT')
}

const buildRouteFromQuote = (
  quote: MayanSwiftV2Quote,
): { readonly route: ReturnType<typeof validateBridgeRoute>; readonly normalizedQuote: MayanSwiftV2Quote } => {
  let normalizedQuote: MayanSwiftV2Quote
  try {
    normalizedQuote = validateNormalizedQuoteShape(quote, 'BRIDGE_QUOTE_MISMATCH')
  } catch (error) {
    if (error instanceof BridgeError) throw error
    return fail('BRIDGE_QUOTE_MISMATCH')
  }
  if (stableJson(quote) !== stableJson(normalizedQuote)) fail('BRIDGE_QUOTE_MISMATCH')
  const route = validateBridgeRoute({
    sourceChainId: normalizedQuote.sourceChainId,
    destinationChainId: normalizedQuote.destinationChainId,
    sourceTokenDeploymentId: normalizedQuote.sourceTokenDeploymentId,
    destinationTokenDeploymentId: normalizedQuote.destinationTokenDeploymentId,
    amountIn: normalizedQuote.amountIn,
    slippageBps: normalizedQuote.slippageBps,
  })
  return { route, normalizedQuote }
}

const validateRawQuoteForBuild = (
  quote: MayanSwiftV2Quote,
  route: ReturnType<typeof validateBridgeRoute>,
  config: NormalizedBridgeConfig,
): MayanSwiftV2Quote => {
  let response: ProviderResponse
  try {
    response = parseProviderResponse(quote.rawSignedQuoteJson)
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'BRIDGE_QUOTE_EXPIRED') throw error
    return fail('BRIDGE_QUOTE_MISMATCH')
  }
  if (
    !isRecord(response.root.value) ||
    response.root.start !== 0 ||
    response.root.end !== response.text.length
  ) {
    fail('BRIDGE_QUOTE_MISMATCH')
  }
  let rebuilt: ValidatedProviderQuote
  try {
    rebuilt = validateProviderQuote(
      response.root,
      response.text,
      route.request,
      route.facts,
      config,
    )
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'BRIDGE_QUOTE_EXPIRED') throw error
    return fail('BRIDGE_QUOTE_MISMATCH')
  }
  if (stableJson(rebuilt.quote) !== stableJson(quote)) {
    fail('BRIDGE_QUOTE_MISMATCH')
  }
  return deepFreeze(quote)
}

const numericZero = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value) && value === 0
  if (typeof value !== 'string') return false
  if (value === '0') return true
  return /^0x0+$/iu.test(value)
}

const validateEvmBuildResult = (
  wrapper: JsonNode,
  swapperAddress: string,
  facts: DirectionFacts,
): MayanEvmUnsignedTransaction => {
  const forwarderAddress = facts.forwarderAddress ?? providerInvalid()
  const forwarderFunctionSelector = facts.forwarderFunctionSelector ?? providerInvalid()
  if (providerString(wrapper, 'chainCategory') !== 'evm') providerInvalid()
  if (providerString(wrapper, 'quoteType') !== 'SWIFT') providerInvalid()
  if (providerBoolean(wrapper, 'gasless')) providerInvalid()
  const transaction = requiredNode(wrapper, 'transaction')
  if (!isRecord(transaction.value)) providerInvalid()
  const to = providerString(transaction, 'to')
  if (!providerAddressEquals(to, forwarderAddress)) providerInvalid()
  const chainId = providerInteger(transaction, 'chainId')
  if (chainId !== ETHEREUM_PROVIDER_CHAIN_ID) providerInvalid()
  if (!numericZero(objectValue(transaction, 'value'))) providerInvalid()
  const data = providerString(transaction, 'data').toLowerCase()
  const minimumWords = facts.asset === 'usdc' ? 10 : 13
  if (
    !HEX_BYTES.test(data) ||
    data.length % 2 !== 0 ||
    !data.startsWith(forwarderFunctionSelector) ||
    data.length < 2 + 8 + minimumWords * 64
  ) {
    providerInvalid()
  }
  return {
    kind: 'evm-unsigned-transaction',
    chainId: 'eip155:1',
    from: swapperAddress,
    to: forwarderAddress,
    data,
    value: '0',
  }
}

const validateSolanaBuildResult = (
  wrapper: JsonNode,
  swapperAddress: string,
): MayanSolanaUnsignedTransaction => {
  if (providerString(wrapper, 'chainCategory') !== 'svm') providerInvalid()
  if (providerString(wrapper, 'quoteType') !== 'SWIFT') providerInvalid()
  const gaslessNode = objectEntry(wrapper, 'gasless')
  if (gaslessNode !== undefined && gaslessNode.value !== false) providerInvalid()
  const transaction = requiredNode(wrapper, 'transaction')
  const encoded = validateSolanaTransaction(transaction.value, swapperAddress)
  return {
    kind: 'solana-v0-unsigned-transaction',
    chainId: SOLANA_CHAIN_ID,
    feePayer: swapperAddress,
    transactionBase64: encoded,
  }
}

const validateBuildResponse = (
  response: ProviderResponse,
  quote: MayanSwiftV2Quote,
  facts: DirectionFacts,
  swapperAddress: string,
): MayanSwiftV2Build => {
  if (!isRecord(response.root.value) || objectValue(response.root, 'success') !== true) {
    fail('BRIDGE_BUILD_INVALID')
  }
  const wrapper = requiredNode(response.root, 'transaction')
  if (!isRecord(wrapper.value)) fail('BRIDGE_BUILD_INVALID')
  const signers = objectValue(wrapper, 'signers')
  if (signers !== undefined && signers !== null && (!Array.isArray(signers) || signers.length !== 0)) {
    fail('BRIDGE_BUILD_INVALID')
  }
  const swapMessageV0Params = objectValue(wrapper, 'swapMessageV0Params')
  if (swapMessageV0Params !== undefined && swapMessageV0Params !== null) {
    fail('BRIDGE_BUILD_INVALID')
  }

  let transaction: MayanSwiftV2UnsignedTransaction
  try {
    transaction = facts.sourceChainId === ETHEREUM_CHAIN_ID
      ? validateEvmBuildResult(wrapper, swapperAddress, facts)
      : validateSolanaBuildResult(wrapper, swapperAddress)
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.code === 'BRIDGE_BUILD_INVALID') throw error
      return fail('BRIDGE_BUILD_INVALID')
    }
    return fail('BRIDGE_BUILD_INVALID')
  }
  return deepFreeze({
    buildKind: 'mayan-swift-v2-unsigned' as const,
    providerId: 'mayan-swift-v2' as const,
    quote,
    sourceChainId: quote.sourceChainId,
    destinationChainId: quote.destinationChainId,
    transaction,
    allowance: facts.sourceChainId === ETHEREUM_CHAIN_ID
      ? {
          tokenDeploymentId: facts.sourceTokenDeploymentId,
          tokenAddress: facts.sourceTokenAddress,
          owner: swapperAddress,
          spender: facts.forwarderAddress as string,
          requiredAmount: quote.amountIn,
        }
      : null,
    validation: {
      level: 'structural' as const,
      quoteSignatureLocallyVerified: false as const,
      transactionSemanticsLocallyVerified: false as const,
      settlementLocallyVerified: false as const,
    },
    rawProviderBuildJson: response.text,
  })
}

const boundedProviderString = (
  value: unknown,
  code: BridgeErrorCode,
  maximum = 1024,
): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail(code)
  return value as string
}

const statusRequestSnapshot = (
  value: unknown,
): { readonly sourceChainId: string; readonly sourceTransactionHash: string } => {
  const request = requireRecord(value, 'BRIDGE_INVALID_ARGUMENT')
  exactObjectKeys(request, ['sourceChainId', 'sourceTransactionHash'], 'BRIDGE_INVALID_ARGUMENT')
  return {
    sourceChainId: requireString(request.sourceChainId, 'BRIDGE_INVALID_ARGUMENT'),
    sourceTransactionHash: requireString(request.sourceTransactionHash, 'BRIDGE_INVALID_ARGUMENT'),
  }
}

const normalizeStatusRequest = (
  value: unknown,
): { readonly sourceChainId: string; readonly sourceTransactionHash: string } => {
  const request = statusRequestSnapshot(value)
  if (request.sourceChainId === ETHEREUM_CHAIN_ID) {
    if (!EVM_HASH.test(request.sourceTransactionHash)) fail('BRIDGE_INVALID_ARGUMENT')
    return {
      sourceChainId: request.sourceChainId,
      sourceTransactionHash: request.sourceTransactionHash.toLowerCase(),
    }
  }
  if (request.sourceChainId === SOLANA_CHAIN_ID) {
    decodeBase58(request.sourceTransactionHash, 64, 'BRIDGE_INVALID_ARGUMENT')
    return request
  }
  return fail('BRIDGE_UNSUPPORTED_ROUTE')
}

const statusFromResponse = (
  response: ProviderResponse,
  request: { readonly sourceChainId: string; readonly sourceTransactionHash: string },
): MayanSwiftV2Status => {
  if (!isRecord(response.root.value)) fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
  const providerClientStatus = boundedProviderString(
    objectValue(response.root, 'clientStatus'),
    'BRIDGE_PROVIDER_INVALID_RESPONSE',
    128,
  )
  const providerStatusValue = objectValue(response.root, 'status')
  if (
    providerStatusValue !== null &&
    providerStatusValue !== undefined &&
    (typeof providerStatusValue !== 'string' || providerStatusValue.length > 1024)
  ) {
    fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
  }
  const providerStatus =
    providerStatusValue === undefined ? null : providerStatusValue as string | null
  const state = providerClientStatus === 'INPROGRESS'
    ? 'in-progress'
    : providerClientStatus === 'COMPLETED'
      ? 'completed'
      : providerClientStatus === 'REFUNDED'
        ? 'refunded'
        : 'unknown'
  return deepFreeze({
    statusKind: 'mayan-explorer-index' as const,
    providerId: 'mayan-swift-v2' as const,
    sourceChainId: request.sourceChainId,
    sourceTransactionHash: request.sourceTransactionHash,
    state: state as 'in-progress' | 'completed' | 'refunded' | 'unknown',
    providerClientStatus,
    providerStatus,
    statusVerification: 'provider-indexed-not-locally-verified' as const,
    rawProviderStatusJson: response.text,
  })
}

const buildBody = (
  quote: MayanSwiftV2Quote,
  sourceChainId: string,
  swapperAddress: string,
  destinationAddress: string,
  refundAddress: string | undefined,
): string => {
  const params: JsonRecord = {
    swapperAddress,
    destinationAddress,
  }
  if (sourceChainId === ETHEREUM_CHAIN_ID) params.signerChainId = 1
  if (refundAddress !== undefined) params.swiftRefundAddress = refundAddress
  return `{"quote":${quote.rawSignedQuoteJson},"params":${JSON.stringify(params)}}`
}

const quoteRequestBodyForRoute = (
  route: ReturnType<typeof validateBridgeRoute>,
): string => quoteRequestBody(route)

export class MayanSwiftV2BridgeClient implements MayanSwiftV2BridgeClient {
  readonly #config: NormalizedBridgeConfig

  constructor(config?: MayanSwiftV2BridgeConfig) {
    this.#config = normalizeBridgeConfig(config)
  }

  async quoteExactInput(
    request: MayanSwiftV2QuoteRequest,
    options?: BridgeRequestOptions,
  ): Promise<readonly MayanSwiftV2Quote[]> {
    const route = validateBridgeRoute(request)
    const response = await providerRequest(
      this.#config,
      endpointWithPath(this.#config.builderEndpoint, '/quote'),
      'POST',
      quoteRequestBodyForRoute(route),
      false,
      options,
    )
    const parsed = await providerJson(response, 'quote')
    const quotes = quoteFromResponse(parsed, route.request, route.facts, this.#config)
    return deepFreeze([...quotes])
  }

  async buildUnsigned(
    request: MayanSwiftV2BuildRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2Build> {
    const snapshot = buildRequestSnapshot(request)
    const { route, normalizedQuote } = buildRouteFromQuote(snapshot.quote)
    rejectAddressFromOtherChain(snapshot.swapperAddress, route.facts.sourceChainId)
    const sourceAddress = normalizeChainAddress(
      snapshot.swapperAddress,
      route.facts.sourceChainId,
      'BRIDGE_INVALID_ARGUMENT',
    )
    const destinationAddress = normalizeDestinationAddress(
      snapshot.destinationAddress,
      route.facts.destinationChainId,
    )
    let refundAddress: string | undefined
    if (snapshot.refundAddress !== undefined) {
      refundAddress = normalizeChainAddress(
        snapshot.refundAddress,
        route.facts.sourceChainId,
        'BRIDGE_INVALID_ARGUMENT',
      )
    }
    if (
      this.#config.builderApiKey === undefined &&
      !this.#config.allowUnauthenticatedBuild
    ) {
      fail('BRIDGE_PROVIDER_AUTH_REQUIRED')
    }
    const quote = validateRawQuoteForBuild(normalizedQuote, route, this.#config)
    const response = await providerRequest(
      this.#config,
      endpointWithPath(this.#config.builderEndpoint, '/build'),
      'POST',
      buildBody(quote, route.facts.sourceChainId, sourceAddress, destinationAddress, refundAddress),
      true,
      options,
    )
    const parsed = await providerJson(response, 'build')
    ensureQuoteDeadline(
      normalizePositiveUint64(quote.deadline, 'BRIDGE_QUOTE_EXPIRED').value,
      this.#config.minimumQuoteValiditySeconds,
    )
    return validateBuildResponse(parsed, quote, route.facts, sourceAddress)
  }

  async getStatus(
    request: MayanSwiftV2StatusRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2Status> {
    const normalized = normalizeStatusRequest(request)
    const response = await providerRequest(
      this.#config,
      endpointWithPath(
        this.#config.explorerEndpoint,
        `/swap/trx/${encodeURIComponent(normalized.sourceTransactionHash)}`,
      ),
      'GET',
      undefined,
      false,
      options,
    )
    const parsed = await providerJson(response, 'status')
    return statusFromResponse(parsed, normalized)
  }

  async prepareSourceSwap(
    context: MayanSwiftV2LocalContext,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2SourceSwapPlan> {
    return prepareSourceSwapRequest(context, this.#localRuntime(), options)
  }

  async buildLocalUnsigned(
    request: MayanSwiftV2LocalBuildRequest,
    options?: BridgeRequestOptions,
  ): Promise<MayanSwiftV2LocalBuild> {
    return buildLocalUnsignedRequest(request, this.#localRuntime(), options)
  }

  #localRuntime(): MayanSwiftV2LocalRuntimeConfig {
    return {
      localBuild: this.#config.localBuild,
      fetch: this.#config.fetch,
      timeoutMs: this.#config.timeoutMs,
      minimumQuoteValiditySeconds: this.#config.minimumQuoteValiditySeconds,
      validateQuote: (quote, invalidCode) => {
        try {
          const { route, normalizedQuote } = buildRouteFromQuote(quote)
          const validationQuote = /[ \t\r\n]$/u.test(normalizedQuote.rawSignedQuoteJson)
            ? {
                ...normalizedQuote,
                rawSignedQuoteJson: normalizedQuote.rawSignedQuoteJson.replace(/[ \t\r\n]+$/gu, ''),
              }
            : normalizedQuote
          validateRawQuoteForBuild(validationQuote, route, this.#config)
          return quote
        } catch (error) {
          if (error instanceof BridgeError && error.code === 'BRIDGE_QUOTE_EXPIRED') {
            throw error
          }
          return fail(invalidCode)
        }
      },
      fail,
    }
  }

  close(): void {
    // This client owns no external sockets or HTTP agent; close is intentionally
    // idempotent and leaves an injected fetch implementation untouched.
  }
}

export const createMayanSwiftV2BridgeClient = (
  config?: MayanSwiftV2BridgeConfig,
): MayanSwiftV2BridgeClient => new MayanSwiftV2BridgeClient(config)

export {
  BRIDGE_CAPABILITIES_AS_OF_DATE,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
}
