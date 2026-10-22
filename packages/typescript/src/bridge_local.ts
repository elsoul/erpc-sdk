import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

import {
  ErpcAbortedError,
  ErpcConfigError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcTimeoutError,
  ErpcTransportError,
} from './errors'
import {
  createErpcClient,
  type ErpcClient,
} from './client'
import {
  TOKEN_CHAIN_IDS,
  getTokenDeployment,
  type TokenDeployment,
} from './token_catalog'
import {
  BRIDGE_CAPABILITIES_JSON,
} from './generated/bridge_capabilities'
import type {
  BridgeErrorCode,
  BridgeRequestOptions,
  MayanSwiftV2Build,
  MayanSwiftV2BridgeConfig,
  MayanSwiftV2Quote,
  MayanSwiftV2UnsignedTransaction,
} from './bridge'

export interface MayanSwiftV2LocalContext {
  readonly quote: MayanSwiftV2Quote
  readonly swapperAddress: string
  readonly destinationAddress: string
  readonly orderNonce: string
}

export interface MayanSwiftV2LocalSourceSwapInstructionAccount {
  readonly pubkey: string
  readonly isSigner: boolean
  readonly isWritable: boolean
}

export interface MayanSwiftV2LocalSourceSwapInstruction {
  readonly programId: string
  readonly accounts: readonly MayanSwiftV2LocalSourceSwapInstructionAccount[]
  readonly dataBase64: string
}

export interface MayanSwiftV2LocalSourceSwapNone {
  readonly kind: 'none'
}

export interface MayanSwiftV2LocalSourceSwapEvmRouter {
  readonly kind: 'evm-router'
  readonly routerAddress: string
  readonly calldata: string
  readonly rawResponseSha256: string
  readonly rawProviderSourceSwapJson: string
}

export interface MayanSwiftV2LocalSourceSwapSolanaJupiter {
  readonly kind: 'solana-jupiter-v6'
  readonly instructions: readonly MayanSwiftV2LocalSourceSwapInstruction[]
  readonly addressLookupTableAddresses: readonly string[]
  readonly rawResponseSha256: string
  readonly rawProviderSourceSwapJson: string
}

export type MayanSwiftV2LocalSourceSwapPlan =
  | MayanSwiftV2LocalSourceSwapNone
  | MayanSwiftV2LocalSourceSwapEvmRouter
  | MayanSwiftV2LocalSourceSwapSolanaJupiter

export interface MayanSwiftV2SourceSwapPlan {
  readonly planKind: 'mayan-swift-v2-local-source-swap'
  readonly providerId: 'mayan-swift-v2'
  readonly capabilityId: string
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceTokenDeploymentId: string
  readonly destinationTokenDeploymentId: string
  readonly quoteId: string
  readonly rawQuoteSha256: string
  readonly orderNonce: string
  readonly swapperAddress: string
  readonly destinationAddress: string
  readonly orderHash: string
  readonly quoteBindingHash: string
  readonly minimumIntermediateAmount: string
  readonly sourceSwap: MayanSwiftV2LocalSourceSwapPlan
  readonly planHash: string
}

export interface MayanSwiftV2LocalBuildRequest extends MayanSwiftV2LocalContext {
  readonly sourceSwapPlan: MayanSwiftV2SourceSwapPlan
}

export interface MayanSwiftV2LocalEvmRpcEvidence {
  readonly kind: 'evm'
  readonly rpcChainId: '0x1'
  readonly code: readonly { readonly address: string; readonly keccak256: string }[]
}

export interface MayanSwiftV2LocalSolanaRpcLookupTableEvidence {
  readonly address: string
  readonly dataSha256: string
}

export interface MayanSwiftV2LocalSolanaRpcEvidence {
  readonly kind: 'solana'
  readonly genesisHash: string
  readonly blockhashContextSlot: string
  readonly accountContextSlot: string
  readonly recentBlockhash: string
  readonly lastValidBlockHeight: string
  readonly lookupTables: readonly MayanSwiftV2LocalSolanaRpcLookupTableEvidence[]
}

export type MayanSwiftV2LocalSourceRpcEvidence =
  | MayanSwiftV2LocalEvmRpcEvidence
  | MayanSwiftV2LocalSolanaRpcEvidence

export interface MayanSwiftV2LocalConstruction {
  readonly mode: 'local'
  readonly referenceCommit: 'c4c98031aaad9264d17630d7b4de0cb18688cf78'
  readonly orderNonce: string
  readonly orderHash: string
  readonly minimumIntermediateAmount: string
  readonly effectiveDependencies: readonly string[]
  readonly sourceRpcEvidence: MayanSwiftV2LocalSourceRpcEvidence
}

export interface MayanSwiftV2LocalBuildValidation {
  readonly level: 'local-structural'
  readonly quoteSignatureLocallyVerified: false
  readonly planBindingLocallyVerified: true
  readonly transactionBytesLocallyConstructed: true
  readonly settlementLocallyVerified: false
}

export interface MayanSwiftV2LocalBuild {
  readonly buildKind: 'mayan-swift-v2-local-unsigned'
  readonly providerId: 'mayan-swift-v2'
  readonly capabilityId: string
  readonly quote: MayanSwiftV2Quote
  readonly sourceChainId: string
  readonly destinationChainId: string
  readonly sourceSwapPlan: MayanSwiftV2SourceSwapPlan
  readonly transaction: MayanSwiftV2UnsignedTransaction
  readonly allowance: MayanSwiftV2Build['allowance']
  readonly construction: MayanSwiftV2LocalConstruction
  readonly validation: MayanSwiftV2LocalBuildValidation
}

export interface MayanSwiftV2LocalRuntimeConfig {
  readonly localBuild: MayanSwiftV2BridgeConfig['localBuild']
  readonly fetch: typeof globalThis.fetch
  readonly timeoutMs: number
  readonly minimumQuoteValiditySeconds: number
  readonly validateQuote: (
    quote: MayanSwiftV2Quote,
    invalidCode: BridgeErrorCode,
  ) => MayanSwiftV2Quote
  readonly fail: (code: BridgeErrorCode) => never
}

interface LocalCapability {
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
const ETHEREUM_FORWARDER = '0x337685fdab40d39bd02028545a4ffa7d287cc3e2'
const ETHEREUM_FORWARDER_PROVIDER = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2'
const SOLANA_SWIFT_PROGRAM = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
const SOLANA_JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SOLANA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111'
const SOLANA_SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111'
const SOLANA_COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const SOLANA_CPI_PROXY_PROGRAM = 'D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa'
const SOLANA_ANCHOR_EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'
const SOLANA_FEE_MANAGER_PROGRAM = '5VtQHnhs2pfVEr68qQsbTRwKh4JV5GTu9mBHgHFxpHeQ'
const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const SOLANA_MAYAN_LOOKUP_TABLE = 'Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht'
const SOLANA_ADDRESS_LOOKUP_TABLE_OWNER = 'AddressLookupTab1e1111111111111111111111111'
const SOLANA_ROUTE_V2_DISCRIMINATOR = 'bb64facc31c4af14'
const SOLANA_ROUTE_V2_WHIRLPOOL_TAIL = '000001000000110010270001'
const SOLANA_ROUTE_V2_RAYDIUM_TAIL = '0000010000001a10270001'
const SOLANA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const SOLANA_WHIRLPOOL_POOL = 'ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i'
const SOLANA_RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
const SOLANA_RAYDIUM_CLMM_POOL = '2zVV22uNWdJNmkXpj5vCrMzwHGBoJdsyV7qACh29sK1w'
const SOLANA_INIT_ORDER_DISCRIMINATOR = '204c290c27a284db'
const EVM_SOURCE_SWAP_SELECTOR = '0x3f0bde25'
const SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT = 'https://price-api.mayan.finance/v3'
const MAYAN_REFERENCE_COMMIT = 'c4c98031aaad9264d17630d7b4de0cb18688cf78'
const MAYAN_ORACLE_SDK_VERSION = '15_2_2'
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 32
const MAX_ROUTER_CALLDATA_BYTES = 16_384
const MAX_SOLANA_SWAP_ACCOUNTS = 64
const MAX_SOLANA_SWAP_DATA_BYTES = 4096
const MAX_LOOKUP_TABLES = 8
const MAX_LOOKUP_TABLE_ADDRESSES = 256
const MAX_SOLANA_TRANSACTION_BYTES = 1232
const UINT64_MAX = (1n << 64n) - 1n
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/u
const UINT64 = /^(0|[1-9][0-9]*)$/u
const NONCE = /^0x[0-9a-f]{32}$/u
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const capabilities = JSON.parse(BRIDGE_CAPABILITIES_JSON) as LocalCapability[]

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const hexToBytes = (value: string): Uint8Array => {
  const normalized = value.startsWith('0x') ? value.slice(2) : value
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(normalized)) throw new Error('invalid hex')
  const bytes = new Uint8Array(normalized.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const sha256Hex = (value: Uint8Array | string): string =>
  bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value))

const keccakHex = (value: Uint8Array): string => bytesToHex(keccak_256(value))

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const assertJsonDepth = (value: unknown, depth = 0): void => {
  if (depth > MAX_JSON_DEPTH) throw new Error('json depth')
  if (Array.isArray(value)) {
    for (const child of value) assertJsonDepth(child, depth + 1)
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) assertJsonDepth(child, depth + 1)
  }
}

const parseJsonObject = (text: string): Record<string, unknown> => {
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('response too large')
  const value = JSON.parse(text) as unknown
  assertJsonDepth(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
  return value as Record<string, unknown>
}

const normalizeEvmAddress = (value: unknown): string => {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value) || /^0x0{40}$/iu.test(value)) throw new Error('EVM address')
  return value.toLowerCase()
}

const base58Decode = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('base58')
  let result = 0n
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('base58')
    result = result * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (result > 0n) {
    bytes.push(Number(result & 0xffn))
    result >>= 8n
  }
  bytes.reverse()
  let leading = 0
  while (leading < value.length && value[leading] === '1') leading += 1
  return Uint8Array.from([...new Uint8Array(leading), ...bytes])
}

const base58Encode = (value: Uint8Array): string => {
  let number = 0n
  for (const byte of value) number = number * 256n + BigInt(byte)
  let result = ''
  while (number > 0n) {
    const digit = Number(number % 58n)
    result = BASE58_ALPHABET[digit] + result
    number /= 58n
  }
  let leading = 0
  while (leading < value.length && value[leading] === 0) leading += 1
  return `${'1'.repeat(leading)}${result}`
}

const canonicalSolanaAddress = (value: unknown): string => {
  const bytes = base58Decode(value)
  if (bytes.length !== 32 || base58Encode(bytes) !== value) throw new Error('Solana address')
  return value as string
}

const uint64 = (value: unknown, positive = false): bigint => {
  if (typeof value !== 'string' || !UINT64.test(value) || value.length > 20) throw new Error('uint64')
  const parsed = BigInt(value)
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new Error('uint64')
  return parsed
}

const wordUint = (value: bigint): Uint8Array => {
  if (value < 0n || value >= (1n << 256n)) throw new Error('ABI uint')
  const result = new Uint8Array(32)
  let remaining = value
  for (let index = 31; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

const wordAddress = (value: string): Uint8Array => {
  const bytes = hexToBytes(normalizeEvmAddress(value))
  return concatBytes(new Uint8Array(12), bytes)
}

const wordBytes32 = (value: Uint8Array): Uint8Array => {
  if (value.length !== 32) throw new Error('bytes32')
  return value
}

const pad32 = (value: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(value.length / 32) * 32)
  padded.set(value)
  return padded
}

const encodeAbiBytes = (value: Uint8Array): Uint8Array =>
  concatBytes(wordUint(BigInt(value.length)), pad32(value))

const encodeAbiWithDynamics = (
  head: readonly Uint8Array[],
  dynamics: readonly Uint8Array[],
): Uint8Array => {
  const headSize = (head.length + dynamics.length) * 32
  let offset = headSize
  const offsets = dynamics.map((value) => {
    const current = offset
    offset += 32 + Math.ceil(value.length / 32) * 32
    return current
  })
  return concatBytes(
    ...head.map((word) => word),
    ...offsets.map((entry) => wordUint(BigInt(entry))),
    ...dynamics.map(encodeAbiBytes),
  )
}

const nativeAddressBytes = (value: string, chainId: string): Uint8Array => {
  if (chainId === ETHEREUM_CHAIN_ID) return wordAddress(value)
  canonicalSolanaAddress(value)
  return base58Decode(value)
}

const routeForQuote = (quote: MayanSwiftV2Quote): LocalCapability => {
  const route = capabilities.find((entry) =>
    entry.sourceChainId === quote.sourceChainId &&
    entry.destinationChainId === quote.destinationChainId &&
    entry.sourceTokenDeploymentId === quote.sourceTokenDeploymentId &&
    entry.destinationTokenDeploymentId === quote.destinationTokenDeploymentId)
  if (!route) throw new Error('route')
  return route
}

const sourceIsUsdc = (route: LocalCapability): boolean =>
  route.bridgeCapabilityId.includes('-usdc-')

const providerStandard = (chainId: string): 'erc20' | 'spl' =>
  chainId === ETHEREUM_CHAIN_ID ? 'erc20' : 'spl'

const assertCatalogToken = (
  deploymentId: string,
  chainId: string,
  address: string,
  standard: string,
): TokenDeployment => {
  const token = getTokenDeployment(deploymentId)
  if (
    !token || token.chainId !== chainId || token.address === null ||
    token.standard !== standard || token.decimals !== 6 || token.status !== 'active' ||
    (chainId === ETHEREUM_CHAIN_ID
      ? token.address.toLowerCase() !== address.toLowerCase()
      : token.address !== address)
  ) throw new Error('token')
  return token
}

const validateLocalRoute = (quote: MayanSwiftV2Quote): LocalCapability => {
  const route = routeForQuote(quote)
  if (route.providerId !== 'mayan-swift-v2' || route.status !== 'active') throw new Error('route')
  assertCatalogToken(route.sourceTokenDeploymentId, route.sourceChainId, route.sourceTokenAddress, route.sourceTokenStandard)
  assertCatalogToken(route.destinationTokenDeploymentId, route.destinationChainId, route.destinationTokenAddress, route.destinationTokenStandard)
  assertCatalogToken(route.sourceUsdcDeploymentId, route.sourceChainId, route.sourceUsdcAddress, route.sourceUsdcStandard)
  if (quote.sourceSwap.required !== !sourceIsUsdc(route)) throw new Error('quote')
  if (
    quote.sourceSwap.inputTokenDeploymentId !== route.sourceTokenDeploymentId ||
    quote.sourceSwap.intermediateTokenDeploymentId !== route.sourceUsdcDeploymentId ||
    quote.sourceSwap.intermediateTokenAddress !== route.sourceUsdcAddress ||
    quote.sourceSwap.intermediateTokenStandard !== providerStandard(route.sourceChainId) ||
    quote.sourceSwap.intermediateTokenDecimals !== 6
  ) throw new Error('quote')
  if (sourceIsUsdc(route)) {
    if (quote.sourceSwap.routerKind !== null || quote.sourceSwap.routerAddress !== null) throw new Error('quote')
    if (JSON.stringify(quote.dependencies) !== JSON.stringify(route.dependencies)) throw new Error('quote')
  } else if (
    (route.sourceChainId === ETHEREUM_CHAIN_ID &&
      (quote.sourceSwap.routerKind !== 'provider-selected-evm' || quote.sourceSwap.routerAddress === null)) ||
    (route.sourceChainId === SOLANA_CHAIN_ID &&
      (quote.sourceSwap.routerKind !== 'jupiter-v6' || quote.sourceSwap.routerAddress !== SOLANA_JUPITER_V6)) ||
    JSON.stringify(quote.dependencies) !== JSON.stringify(route.dependencies)
  ) throw new Error('quote')
  const raw = parseJsonObject(quote.rawSignedQuoteJson)
  if (raw.swiftWrapAndLock !== undefined && raw.swiftWrapAndLock !== false) throw new Error('quote')
  if (!sourceIsUsdc(route) && route.sourceChainId === ETHEREUM_CHAIN_ID) {
    if (
      raw.evmSwapRouterAddress !== undefined &&
      !rawAddressEquals(raw.evmSwapRouterAddress, quote.sourceSwap.routerAddress ?? '')
    ) throw new Error('quote')
    if (raw.evmSwapRouterCalldata !== undefined && (
      typeof raw.evmSwapRouterCalldata !== 'string' ||
      !HEX_BYTES.test(raw.evmSwapRouterCalldata) ||
      raw.evmSwapRouterCalldata === '0x' ||
      hexToBytes(raw.evmSwapRouterCalldata).length > MAX_ROUTER_CALLDATA_BYTES
    )) throw new Error('quote')
  }
  const mode = raw.swiftAuctionMode
  if (mode !== 2 && mode !== 3) throw new Error('quote')
  if (mode !== (sourceIsUsdc(route) ? 3 : 2)) throw new Error('quote')
  if (mode === 3 && (raw.expectedAmountOutBaseUnits !== raw.minAmountOutBaseUnits || raw.minAmountOutBaseUnits !== raw.minReceivedBaseUnits)) throw new Error('quote')
  const forbidden = ['customPayload', 'memoHex', 'referrer', 'referrerAddress', 'swiftRefundAddress', 'permit', 'approval', 'approvalBatch', 'separateSwapTx', 'jito', 'extraInstructions']
  for (const key of forbidden) if (Object.hasOwn(raw, key) && raw[key] !== null && raw[key] !== false && raw[key] !== '') throw new Error('quote')
  return route
}

const extractRawNumberLexeme = (raw: string, key: string): string => {
  const expression = new RegExp(`"${key}"\\s*:\\s*([^,}\\s]+)`, 'gu')
  const matches = [...raw.matchAll(expression)]
  const match = matches[0]
  if (matches.length !== 1 || match === undefined || match[1] === undefined) throw new Error('number')
  return match[1]
}

interface ExactDecimal {
  readonly source: string
  readonly integer: bigint
  readonly scale: number
}

const parsePlainDecimal = (value: string): ExactDecimal => {
  if (!PLAIN_DECIMAL.test(value)) throw new Error('decimal')
  const separator = value.indexOf('.')
  const integerPart = separator === -1 ? value : value.slice(0, separator)
  const fractionalPart = separator === -1 ? '' : value.slice(separator + 1)
  const integer = BigInt(integerPart)
  const keptFraction = fractionalPart.slice(0, 6).padEnd(6, '0')
  const result = integer * 1_000_000n + BigInt(keptFraction || '0')
  if (result <= 0n || result > UINT64_MAX) throw new Error('decimal')
  return { source: value, integer: result, scale: fractionalPart.length }
}

const binary64RoundedDecimalUnits = (value: string): bigint => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number === 0) throw new Error('decimal')
  const bits = new DataView(new ArrayBuffer(8))
  bits.setFloat64(0, number, false)
  const high = BigInt(bits.getUint32(0, false))
  const low = BigInt(bits.getUint32(4, false))
  const encoded = (high << 32n) | low
  const exponent = Number((encoded >> 52n) & 0x7ffn)
  const fraction = encoded & ((1n << 52n) - 1n)
  const mantissa = exponent === 0 ? fraction : (1n << 52n) | fraction
  const binaryExponent = exponent === 0 ? -1074 : exponent - 1023 - 52
  let numerator = mantissa * 10_000_000n
  let denominator = 1n
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent)
  else denominator <<= BigInt(-binaryExponent)
  let rounded = numerator / denominator
  const remainder = numerator % denominator
  if (remainder * 2n >= denominator) rounded += 1n
  const result = rounded / 10n
  if (result <= 0n || result > UINT64_MAX) throw new Error('decimal')
  return result
}

const exactIntermediateAmount = (
  raw: string,
  direct: boolean,
  amountIn: string,
): string => {
  const decimal = parsePlainDecimal(raw)
  const exact = decimal.integer
  if (direct) {
    if (exact !== uint64(amountIn, true)) throw new Error('decimal')
    return exact.toString()
  }
  if (binary64RoundedDecimalUnits(raw) !== exact) throw new Error('decimal')
  return exact.toString()
}

const validateDestinationMinimumCompatibility = (raw: string, canonical: string): void => {
  const units = uint64(canonical, true)
  const lexeme = extractRawNumberLexeme(raw, 'minAmountOut')
  if (parsePlainDecimal(lexeme).integer !== units || binary64RoundedDecimalUnits(lexeme) !== units) {
    throw new Error('destination minimum')
  }
}

const rawUint64 = (raw: Record<string, unknown>, key: string, required = true): bigint => {
  const value = raw[key]
  if (value === undefined && !required) return 0n
  return uint64(value, false)
}

const rawAddressEquals = (value: unknown, expected: string): boolean =>
  typeof value === 'string' && (EVM_ADDRESS.test(expected)
    ? value.toLowerCase() === expected.toLowerCase()
    : value === expected)

const isOnCurveZip215 = (bytes: Uint8Array): boolean => {
  try {
    ed25519.Point.fromBytes(bytes, true)
    return true
  } catch {
    return false
  }
}

const findProgramAddress = (
  seeds: readonly Uint8Array[],
  programId: string,
): { readonly address: string; readonly bump: number } => {
  if (seeds.length > 16 || seeds.some((seed) => seed.length > 32)) throw new Error('PDA seeds')
  const program = base58Decode(programId)
  if (program.length !== 32) throw new Error('PDA program')
  const suffix = new TextEncoder().encode('ProgramDerivedAddress')
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = sha256(concatBytes(...seeds, Uint8Array.from([bump]), program, suffix))
    if (!isOnCurveZip215(candidate)) return { address: base58Encode(candidate), bump }
  }
  throw new Error('PDA unavailable')
}

const associatedTokenAddress = (
  owner: string,
  mint: string,
  allowOwnerOffCurve: boolean,
): string => {
  const ownerBytes = base58Decode(owner)
  const mintBytes = base58Decode(mint)
  if (ownerBytes.length !== 32 || mintBytes.length !== 32) throw new Error('ATA address')
  if (!allowOwnerOffCurve && isOnCurveZip215(ownerBytes) === false) throw new Error('ATA owner')
  return findProgramAddress(
    [ownerBytes, base58Decode(SOLANA_TOKEN_PROGRAM), mintBytes],
    SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  ).address
}

const parseSourceQuote = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
): { readonly raw: Record<string, unknown>; readonly minimumIntermediateAmount: string; readonly mode: 2 | 3; readonly cancelFee: bigint; readonly refundFee: bigint; readonly submitFee: bigint } => {
  const raw = parseJsonObject(quote.rawSignedQuoteJson)
  const minimumLexeme = extractRawNumberLexeme(quote.rawSignedQuoteJson, 'minMiddleAmount')
  const modeValue = raw.swiftAuctionMode
  if (modeValue !== 2 && modeValue !== 3) throw new Error('mode')
  const mode = (modeValue === 2 || modeValue === 3 ? modeValue : sourceIsUsdc(route) ? 3 : 2) as 2 | 3
  if (mode !== (sourceIsUsdc(route) ? 3 : 2)) throw new Error('mode')
  if (mode === 3 && (raw.expectedAmountOutBaseUnits !== raw.minAmountOutBaseUnits || raw.minAmountOutBaseUnits !== raw.minReceivedBaseUnits)) throw new Error('guaranteed output')
  const minimumIntermediateAmount = exactIntermediateAmount(minimumLexeme, sourceIsUsdc(route), quote.amountIn)
  if (quote.sourceSwap.providerMinimumAmount !== minimumLexeme) throw new Error('provider minimum')
  if (!sourceIsUsdc(route)) {
    const numeric = Number(minimumLexeme)
    if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('number')
  }
  return {
    raw,
    minimumIntermediateAmount,
    mode,
    cancelFee: rawUint64(raw, 'cancelRelayerFee64'),
    refundFee: rawUint64(raw, 'refundRelayerFee64'),
    submitFee: rawUint64(raw, 'submitRelayerFee64'),
  }
}

const swiftRandom = (quoteId: string, orderNonce: string): Uint8Array =>
  concatBytes(hexToBytes(quoteId), hexToBytes(orderNonce))

const writeUint16Be = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) throw new Error('uint16')
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff])
}

const writeUint64Be = (value: bigint): Uint8Array => {
  if (value < 0n || value > UINT64_MAX) throw new Error('uint64')
  const result = new Uint8Array(8)
  let current = value
  for (let index = 7; index >= 0; index -= 1) {
    result[index] = Number(current & 0xffn)
    current >>= 8n
  }
  return result
}

const writeUint64Le = (value: bigint): Uint8Array => {
  const result = writeUint64Be(value)
  return Uint8Array.from([...result].reverse())
}

const writeUint16Le = (value: number): Uint8Array => {
  const result = writeUint16Be(value)
  return Uint8Array.from([result[1], result[0]])
}

const zero32 = (): Uint8Array => new Uint8Array(32)

const orderPreimage = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  swapperAddress: string,
  destinationAddress: string,
  orderNonce: string,
  minimumIntermediateAmount: string,
  cancelFee: bigint,
  refundFee: bigint,
  mode: number,
): Uint8Array => {
  const destinationMinimum = uint64(quote.minimumAmountOut, true)
  const parts = [
    Uint8Array.from([1]),
    nativeAddressBytes(swapperAddress, route.sourceChainId),
    writeUint16Be(route.sourceWormholeChainId),
    nativeAddressBytes(route.sourceUsdcAddress, route.sourceChainId),
    nativeAddressBytes(destinationAddress, route.destinationChainId),
    writeUint16Be(route.destinationWormholeChainId),
    nativeAddressBytes(route.destinationTokenAddress, route.destinationChainId),
    writeUint64Be(destinationMinimum),
    writeUint64Be(0n),
    writeUint64Be(cancelFee),
    writeUint64Be(refundFee),
    writeUint64Be(uint64(quote.deadline, true)),
    zero32(),
    Uint8Array.from([0, 0, mode]),
    swiftRandom(quote.quoteId, orderNonce),
    zero32(),
  ] as const
  const result = concatBytes(...parts)
  if (result.length !== 272) throw new Error('order preimage')
  void minimumIntermediateAmount
  return result
}

const hashOrder = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  swapperAddress: string,
  destinationAddress: string,
  orderNonce: string,
  minimumIntermediateAmount: string,
  cancelFee: bigint,
  refundFee: bigint,
  mode: number,
): string => `0x${keccakHex(orderPreimage(quote, route, swapperAddress, destinationAddress, orderNonce, minimumIntermediateAmount, cancelFee, refundFee, mode))}`

const quoteBindingHash = (
  route: LocalCapability,
  quote: MayanSwiftV2Quote,
  rawQuoteSha256: string,
  orderNonce: string,
  swapperAddress: string,
  destinationAddress: string,
): string => sha256Hex(stableJson({
  capabilityId: route.bridgeCapabilityId,
  destinationAddress,
  destinationChainId: route.destinationChainId,
  destinationTokenDeploymentId: route.destinationTokenDeploymentId,
  orderNonce,
  quoteId: quote.quoteId,
  rawQuoteSha256,
  sourceChainId: route.sourceChainId,
  sourceTokenDeploymentId: route.sourceTokenDeploymentId,
  swapperAddress,
}))

const sourceSwapHashProjection = (sourceSwap: MayanSwiftV2LocalSourceSwapPlan): unknown => {
  if (sourceSwap.kind === 'none') return sourceSwap
  if (sourceSwap.kind === 'evm-router') {
    const { rawProviderSourceSwapJson: _raw, ...value } = sourceSwap
    return value
  }
  const { rawProviderSourceSwapJson: _raw, ...value } = sourceSwap
  return value
}

const planHash = (binding: string, sourceSwap: MayanSwiftV2LocalSourceSwapPlan): string =>
  sha256Hex(stableJson({ quoteBindingHash: binding, sourceSwap: sourceSwapHashProjection(sourceSwap) }))

const endpointUrl = (value: unknown): URL => {
  const source = value === undefined ? SOLANA_MAYAN_SOURCE_SWAP_ENDPOINT : value
  if (typeof source !== 'string' || source.length === 0 || source.trim() !== source) throw new Error('endpoint')
  let endpoint: URL
  try {
    endpoint = new URL(source)
  } catch {
    throw new Error('endpoint')
  }
  if (
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname)))
  ) throw new Error('endpoint')
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
  return endpoint
}

const sourceSwapUrl = (
  endpoint: URL,
  chain: 'evm' | 'solana',
  params: readonly (readonly [string, string | number | boolean])[],
): URL => {
  const result = new URL(endpoint)
  const basePath = result.pathname.replace(/\/+$/u, '')
  result.pathname = `${basePath}/get-swap/${chain}`.replace(/\/{2,}/gu, '/')
  for (const [key, value] of params) result.searchParams.append(key, String(value))
  return result
}

interface SourceSwapResponse {
  readonly text: string
  readonly root: Record<string, unknown>
}

class SourceResponseInvalidError extends Error {
  constructor() {
    super('invalid source response')
    this.name = 'SourceResponseInvalidError'
  }
}

const disposeResponseBody = (response: Response): void => {
  if (response.body === null) return
  try {
    const reader = response.body.getReader()
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  } catch {
    // Best effort: a disturbed or already-locked body is already unusable.
  }
}

const readSourceResponseText = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    disposeResponseBody(response)
    throw new SourceResponseInvalidError()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  let abortListener: (() => void) | undefined
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new DOMException('aborted', 'AbortError'))
        signal.addEventListener('abort', abortListener, { once: true })
      })
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), abortPromise])
      } finally {
        if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
        abortListener = undefined
      }
      if (result.done) {
        complete = true
        break
      }
      if (!(result.value instanceof Uint8Array)) throw new SourceResponseInvalidError()
      total += result.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new SourceResponseInvalidError()
      chunks.push(result.value)
    }
  } finally {
    if (!complete) {
      try { await reader.cancel() } catch { /* best effort */ }
    }
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SourceResponseInvalidError()
  }
}

const fetchSourceSwap = async (
  runtime: MayanSwiftV2LocalRuntimeConfig,
  url: URL,
  options: BridgeRequestOptions | undefined,
): Promise<SourceSwapResponse> => {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, runtime.timeoutMs)
  const abort = () => controller.abort()
  if (options?.signal?.aborted) controller.abort()
  else options?.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await runtime.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      disposeResponseBody(response)
      runtime.fail('BRIDGE_PROVIDER_HTTP')
    }
    const text = await readSourceResponseText(response, controller.signal)
    let root: Record<string, unknown>
    try {
      root = parseJsonObject(text)
    } catch {
      runtime.fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
    }
    return { text, root }
  } catch (error) {
    if (error instanceof Error && error.name === 'BridgeError') throw error
    if (error instanceof SourceResponseInvalidError) runtime.fail('BRIDGE_PROVIDER_INVALID_RESPONSE')
    if (runtime.fail && timedOut) runtime.fail('BRIDGE_TIMEOUT')
    if (options?.signal?.aborted) runtime.fail('BRIDGE_ABORTED')
    if (error instanceof ErpcHttpError) runtime.fail('BRIDGE_PROVIDER_HTTP')
    runtime.fail('BRIDGE_PROVIDER_TRANSPORT')
  } finally {
    clearTimeout(timeout)
    options?.signal?.removeEventListener('abort', abort)
  }
}

const base64Decode = (value: unknown, maximumBytes = MAX_SOLANA_SWAP_DATA_BYTES): Uint8Array => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximumBytes * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error('base64')
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  if (bytes.length > maximumBytes || Buffer.from(bytes).toString('base64') !== value) throw new Error('base64')
  return bytes
}

const instructionFromRaw = (value: unknown): MayanSwiftV2LocalSourceSwapInstruction => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('instruction')
  const source = value as Record<string, unknown>
  if (Object.keys(source).sort().join(',') !== 'accounts,data,programId') throw new Error('instruction')
  const programId = canonicalSolanaAddress(source.programId)
  if (!Array.isArray(source.accounts) || source.accounts.length > MAX_SOLANA_SWAP_ACCOUNTS) throw new Error('instruction')
  const accounts = source.accounts.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('account')
    const account = entry as Record<string, unknown>
    if (Object.keys(account).sort().join(',') !== 'isSigner,isWritable,pubkey' || typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') throw new Error('account')
    return {
      pubkey: canonicalSolanaAddress(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    }
  })
  const dataBase64 = source.data
  base64Decode(dataBase64)
  return { programId, accounts, dataBase64: dataBase64 as string }
}

const encodeInstructionData = (value: string): Uint8Array => base64Decode(value)

const accountAt = (instruction: MayanSwiftV2LocalSourceSwapInstruction, index: number): MayanSwiftV2LocalSourceSwapInstructionAccount => {
  const value = instruction.accounts[index]
  if (!value) throw new Error('account')
  return value
}

const assertAccount = (
  account: MayanSwiftV2LocalSourceSwapInstructionAccount,
  pubkey: string,
  isSigner: boolean,
  isWritable: boolean,
): void => {
  if (account.pubkey !== pubkey || account.isSigner !== isSigner || account.isWritable !== isWritable) {
    throw new Error('account')
  }
}

const validateComputeInstructions = (
  instructions: readonly MayanSwiftV2LocalSourceSwapInstruction[],
): void => {
  if (instructions.length > 2) throw new Error('compute')
  const tags = new Set<number>()
  for (const instruction of instructions) {
    if (instruction.programId !== SOLANA_COMPUTE_BUDGET_PROGRAM || instruction.accounts.length !== 0) throw new Error('compute')
    const data = encodeInstructionData(instruction.dataBase64)
    const tag = data[0]
    if (tag !== 2 && tag !== 3 || tags.has(tag)) throw new Error('compute')
    tags.add(tag)
    if (tag === 2) {
      if (data.length !== 5 || new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true) > 1_400_000) throw new Error('compute')
    } else if (data.length !== 9 || new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true) > 100_000n) {
      throw new Error('compute')
    }
  }
}

const validateAtaSetup = (
  instructions: readonly MayanSwiftV2LocalSourceSwapInstruction[],
  swapperAddress: string,
  stateAddress: string,
  sourceUsdcAddress: string,
): void => {
  if (instructions.length === 0 || instructions.length > 2) throw new Error('setup')
  const tokenProgram = SOLANA_TOKEN_PROGRAM
  const owners = new Set<string>()
  for (const instruction of instructions) {
    if (instruction.programId !== SOLANA_ASSOCIATED_TOKEN_PROGRAM || instruction.accounts.length !== 6) throw new Error('setup')
    const payer = accountAt(instruction, 0)
    assertAccount(payer, swapperAddress, true, true)
    const owner = accountAt(instruction, 2).pubkey
    if (owner !== swapperAddress && owner !== stateAddress) throw new Error('setup')
    if (owners.has(owner)) throw new Error('setup')
    owners.add(owner)
    const expectedAta = associatedTokenAddress(owner, sourceUsdcAddress, owner === stateAddress)
    assertAccount(accountAt(instruction, 2), owner, false, false)
    assertAccount(accountAt(instruction, 1), expectedAta, false, true)
    assertAccount(accountAt(instruction, 3), sourceUsdcAddress, false, false)
    assertAccount(accountAt(instruction, 4), SOLANA_SYSTEM_PROGRAM, false, false)
    assertAccount(accountAt(instruction, 5), tokenProgram, false, false)
    const data = encodeInstructionData(instruction.dataBase64)
    if (data.length !== 0 && (data.length !== 1 || data[0] !== 1)) throw new Error('setup')
  }
  if (!owners.has(stateAddress)) throw new Error('setup')
}

const validateJupiterInstruction = (
  instruction: MayanSwiftV2LocalSourceSwapInstruction,
  route: LocalCapability,
  quote: MayanSwiftV2Quote,
  stateTokenAccount: string,
  swapperAddress: string,
  minimumIntermediateAmount: string,
  sourceSwapRaw: Record<string, unknown>,
): void => {
  if (instruction.programId !== SOLANA_JUPITER_V6 || instruction.accounts.length < 8 || instruction.accounts.length > MAX_SOLANA_SWAP_ACCOUNTS) throw new Error('jupiter')
  const data = encodeInstructionData(instruction.dataBase64)
  if (bytesToHex(data.slice(0, 8)) !== SOLANA_ROUTE_V2_DISCRIMINATOR) throw new Error('jupiter')
  const quoteResponse = sourceSwapRaw.quoteResponse
  if (quoteResponse === null || typeof quoteResponse !== 'object' || Array.isArray(quoteResponse)) throw new Error('jupiter')
  const quoteResponseRaw = (quoteResponse as Record<string, unknown>).raw
  if (quoteResponseRaw === null || typeof quoteResponseRaw !== 'object' || Array.isArray(quoteResponseRaw)) throw new Error('jupiter')
  const routePlan = (quoteResponseRaw as Record<string, unknown>).routePlan
  if (!Array.isArray(routePlan) || routePlan.length !== 1) throw new Error('jupiter')
  const swapInfo = (routePlan[0] as Record<string, unknown> | undefined)?.swapInfo
  if (swapInfo === null || typeof swapInfo !== 'object' || Array.isArray(swapInfo)) throw new Error('jupiter')
  const swapInfoRecord = swapInfo as Record<string, unknown>
  const quoteResponseRecord = quoteResponse as Record<string, unknown>
  const quoteResponseRawRecord = quoteResponseRaw as Record<string, unknown>
  if (
    !rawAddressEquals(quoteResponseRecord.inputMint, route.sourceTokenAddress) ||
    !rawAddressEquals(quoteResponseRecord.outputMint, route.sourceUsdcAddress) ||
    !rawAddressEquals(quoteResponseRawRecord.inputMint, route.sourceTokenAddress) ||
    !rawAddressEquals(quoteResponseRawRecord.outputMint, route.sourceUsdcAddress) ||
    !rawAddressEquals(swapInfoRecord.inputMint, route.sourceTokenAddress) ||
    !rawAddressEquals(swapInfoRecord.outputMint, route.sourceUsdcAddress) ||
    typeof swapInfoRecord.inAmount !== 'string' ||
    typeof swapInfoRecord.outAmount !== 'string' ||
    uint64(swapInfoRecord.inAmount, true) !== uint64(quote.amountIn, true) ||
    uint64(swapInfoRecord.outAmount, true) < uint64(minimumIntermediateAmount, true)
  ) throw new Error('jupiter')
  const label = (swapInfo as Record<string, unknown>).label
  const expectedTail = label === 'Whirlpool'
    ? SOLANA_ROUTE_V2_WHIRLPOOL_TAIL
    : label === 'Raydium CLMM'
      ? SOLANA_ROUTE_V2_RAYDIUM_TAIL
      : null
  if (expectedTail === null || data.length !== 28 + expectedTail.length / 2 || bytesToHex(data.slice(28)) !== expectedTail) throw new Error('jupiter')
  const expectedAccountCount = label === 'Whirlpool' ? 22 : 25
  const expectedAccounts: readonly (readonly [string, boolean, boolean])[] = label === 'Whirlpool'
    ? [
        [swapperAddress, true, false],
        [associatedTokenAddress(swapperAddress, route.sourceTokenAddress, false), false, true],
        [associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false), false, true],
        [route.sourceTokenAddress, false, false],
        [route.sourceUsdcAddress, false, false],
        [SOLANA_TOKEN_PROGRAM, false, false],
        [SOLANA_TOKEN_PROGRAM, false, false],
        [stateTokenAccount, false, true],
        [SOLANA_ANCHOR_EVENT_AUTHORITY, false, false],
        [SOLANA_JUPITER_V6, false, false],
        [SOLANA_WHIRLPOOL_PROGRAM, false, false],
        [SOLANA_TOKEN_PROGRAM, false, false],
        [swapperAddress, false, false],
        [SOLANA_WHIRLPOOL_POOL, false, true],
        [associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false), false, true],
        ['6i68TM44UYSawGAS4Bx1vX31Af7QNZaRNBLUbc4r8exB', false, true],
        [associatedTokenAddress(swapperAddress, route.sourceTokenAddress, false), false, true],
        ['8aq9zUXe37KLtXSaEYt7oq65oNAJiu1my2kRNMRPhTD5', false, true],
        ['7qscKXFXCd1WQinZJvSDLsGLTTEwjmd88a871pz2V3Ja', false, true],
        ['CaohZGaBaLmXyFQ4cLc83wGZTET7Mt9xMtUqR9EGaMHF', false, true],
        ['7Mr4WYMiGPAXkyt9ePsHHmV6ust3U6dHwBmyfMRiHPA7', false, true],
        ['9BjNZYSCZ3ac3XUYVKte4YYtmBGd7ATKfRshTGN99NxQ', false, false],
      ]
    : [
        [swapperAddress, true, false],
        [associatedTokenAddress(swapperAddress, route.sourceTokenAddress, false), false, true],
        [associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false), false, true],
        [route.sourceTokenAddress, false, false],
        [route.sourceUsdcAddress, false, false],
        [SOLANA_TOKEN_PROGRAM, false, false],
        [SOLANA_TOKEN_PROGRAM, false, false],
        [stateTokenAccount, false, true],
        [SOLANA_ANCHOR_EVENT_AUTHORITY, false, false],
        [SOLANA_JUPITER_V6, false, false],
        [SOLANA_RAYDIUM_CLMM_PROGRAM, false, false],
        [swapperAddress, false, false],
        ['9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x', false, false],
        [SOLANA_RAYDIUM_CLMM_POOL, false, true],
        [associatedTokenAddress(swapperAddress, route.sourceTokenAddress, false), false, true],
        [associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false), false, true],
        ['GFwsANMCPK8W3WhqTnwVP8JiwHaAr3cNDe5TJqgHHSPe', false, true],
        ['ECw2X1TYbsrqFgdiYApNpn2ggznbj8pL5tREpY9Fb8jY', false, true],
        ['2UQncszfVU7igwDiGN3jq2sUKzziLxDZqNsJEXzEob5x', false, true],
        [SOLANA_TOKEN_PROGRAM, false, false],
        ['BVvv13QAQjPYKTWrpX7wQbhBAu3pbWwTb8P9SAqgRNKQ', false, true],
        ['4HSR9WBSHgw7n5V8WGYYhLW8g92RPSrgnf2CHzbeQrrr', false, true],
        ['HssFpWsQcNbJXBro1NVWCFAYEh8jp6NJV2nyFhE1zMGj', false, true],
        ['DKcmVcrXuiF5FZre6h8GqurR2sKChUGBakxdTX7dSDw9', false, true],
        [SOLANA_JUPITER_V6, false, false],
      ]
  const expectedPool = label === 'Whirlpool' ? SOLANA_WHIRLPOOL_POOL : SOLANA_RAYDIUM_CLMM_POOL
  if (instruction.accounts.length !== expectedAccountCount || expectedAccounts.length !== instruction.accounts.length) throw new Error('jupiter')
  for (const [index, [pubkey, isSigner, isWritable]] of expectedAccounts.entries()) {
    assertAccount(accountAt(instruction, index), pubkey, isSigner, isWritable)
  }
  if (typeof swapInfoRecord.ammKey !== 'string' || swapInfoRecord.ammKey !== expectedPool) throw new Error('jupiter')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const inputAmount = view.getBigUint64(8, true)
  const quotedOutput = view.getBigUint64(16, true)
  const slippageBps = view.getUint16(24, true)
  const platformBps = view.getUint16(26, true)
  if (inputAmount !== uint64(quote.amountIn, true) || quotedOutput < uint64(minimumIntermediateAmount, true) || platformBps !== 0 || slippageBps > 10_000) throw new Error('jupiter')
}

const wrapInCpiProxy = (
  instruction: MayanSwiftV2LocalSourceSwapInstruction,
): MayanSwiftV2LocalSourceSwapInstruction => ({
  programId: SOLANA_CPI_PROXY_PROGRAM,
  accounts: [
    { pubkey: instruction.programId, isSigner: false, isWritable: false },
    ...instruction.accounts,
  ],
  dataBase64: instruction.dataBase64,
})

const makeAtaInstruction = (
  swapperAddress: string,
  owner: string,
  mint: string,
  allowOwnerOffCurve: boolean,
): MayanSwiftV2LocalSourceSwapInstruction => ({
  programId: SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  accounts: [
    { pubkey: swapperAddress, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddress(owner, mint, allowOwnerOffCurve), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SOLANA_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SOLANA_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SOLANA_SYSVAR_RENT, isSigner: false, isWritable: false },
  ],
  dataBase64: 'AQ==',
})

const makeSplTransferInstruction = (
  source: string,
  destination: string,
  owner: string,
  amount: bigint,
): MayanSwiftV2LocalSourceSwapInstruction => ({
  programId: SOLANA_TOKEN_PROGRAM,
  accounts: [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ],
  dataBase64: Buffer.from(Uint8Array.from([3, ...writeUint64Le(amount)])).toString('base64'),
})

const makeComputeUnitPriceInstruction = (
  microLamports: bigint,
): MayanSwiftV2LocalSourceSwapInstruction => ({
  programId: SOLANA_COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  dataBase64: Buffer.from(Uint8Array.from([3, ...writeUint64Le(microLamports)])).toString('base64'),
})

const makeSwiftInitInstruction = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  swapperAddress: string,
  destinationAddress: string,
  stateAddress: string,
  stateTokenAccount: string,
  minimumIntermediateAmount: string,
  cancelFee: bigint,
  refundFee: bigint,
  submitFee: bigint,
  mode: number,
  orderNonce: string,
): MayanSwiftV2LocalSourceSwapInstruction => {
  const relayerAccount = associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false)
  const data = new Uint8Array(198)
  data.set(hexToBytes(`0x${SOLANA_INIT_ORDER_DISCRIMINATOR}`), 0)
  data.set(writeUint64Le(uint64(minimumIntermediateAmount, true)), 8)
  data[16] = 0
  data.set(writeUint64Le(submitFee), 17)
  data.set(nativeAddressBytes(destinationAddress, route.destinationChainId), 25)
  data.set(writeUint16Le(route.destinationWormholeChainId), 57)
  data.set(nativeAddressBytes(route.destinationTokenAddress, route.destinationChainId), 59)
  data.set(writeUint64Le(uint64(quote.minimumAmountOut, true)), 91)
  data.set(writeUint64Le(0n), 99)
  data.set(writeUint64Le(cancelFee), 107)
  data.set(writeUint64Le(refundFee), 115)
  data.set(writeUint64Le(uint64(quote.deadline, true)), 123)
  data.set(zero32(), 131)
  data[163] = 0
  data[164] = 0
  data[165] = mode
  data.set(swiftRandom(quote.quoteId, orderNonce), 166)
  const accounts = [
    { pubkey: swapperAddress, isSigner: false, isWritable: false },
    { pubkey: swapperAddress, isSigner: true, isWritable: true },
    { pubkey: stateAddress, isSigner: false, isWritable: true },
    { pubkey: stateTokenAccount, isSigner: false, isWritable: true },
    { pubkey: relayerAccount, isSigner: false, isWritable: true },
    { pubkey: SOLANA_SWIFT_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: route.sourceUsdcAddress, isSigner: false, isWritable: false },
    { pubkey: SOLANA_FEE_MANAGER_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SOLANA_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SOLANA_SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ] as const
  return {
    programId: SOLANA_SWIFT_PROGRAM,
    accounts,
    dataBase64: Buffer.from(data).toString('base64'),
  }
}

const encodeShortVec = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) throw new Error('shortvec')
  const bytes: number[] = []
  let current = value
  do {
    let element = current & 0x7f
    current >>>= 7
    if (current !== 0) element |= 0x80
    bytes.push(element)
  } while (current !== 0)
  return Uint8Array.from(bytes)
}

interface KeyMeta {
  signer: boolean
  writable: boolean
  invoked: boolean
}

interface CompiledInstruction {
  readonly programIdIndex: number
  readonly accountKeyIndexes: readonly number[]
  readonly data: Uint8Array
}

interface LocalLookupTable {
  readonly address: string
  readonly addresses: readonly string[]
}

interface AddressTableLookup {
  readonly accountKey: string
  readonly writableIndexes: readonly number[]
  readonly readonlyIndexes: readonly number[]
}

const compileSolanaV0 = (
  payer: string,
  recentBlockhash: string,
  instructions: readonly MayanSwiftV2LocalSourceSwapInstruction[],
  lookupTables: readonly LocalLookupTable[],
): { readonly transactionBase64: string; readonly lookupTableLookups: readonly AddressTableLookup[] } => {
  const keyMeta = new Map<string, KeyMeta>()
  const getOrInsert = (address: string): KeyMeta => {
    const existing = keyMeta.get(address)
    if (existing) return existing
    const value = { signer: false, writable: false, invoked: false }
    keyMeta.set(address, value)
    return value
  }
  const payerMeta = getOrInsert(payer)
  payerMeta.signer = true
  payerMeta.writable = true
  for (const instruction of instructions) {
    getOrInsert(instruction.programId).invoked = true
    for (const account of instruction.accounts) {
      const meta = getOrInsert(account.pubkey)
      meta.signer ||= account.isSigner
      meta.writable ||= account.isWritable
    }
  }
  const lookupTableLookups: AddressTableLookup[] = []
  const writableLookupKeys: string[] = []
  const readonlyLookupKeys: string[] = []
  for (const table of lookupTables) {
    const writableIndexes: number[] = []
    const readonlyIndexes: number[] = []
    for (const [address, meta] of [...keyMeta.entries()]) {
      if (meta.signer || meta.invoked || !meta.writable) continue
      const index = table.addresses.indexOf(address)
      if (index >= 0) {
        if (index > 255) throw new Error('ALT index')
        writableIndexes.push(index)
        writableLookupKeys.push(address)
        keyMeta.delete(address)
      }
    }
    for (const [address, meta] of [...keyMeta.entries()]) {
      if (meta.signer || meta.invoked || meta.writable) continue
      const index = table.addresses.indexOf(address)
      if (index >= 0) {
        if (index > 255) throw new Error('ALT index')
        readonlyIndexes.push(index)
        readonlyLookupKeys.push(address)
        keyMeta.delete(address)
      }
    }
    if (writableIndexes.length > 0 || readonlyIndexes.length > 0) {
      lookupTableLookups.push({ accountKey: table.address, writableIndexes, readonlyIndexes })
    }
  }
  if (keyMeta.size > 256 || lookupTableLookups.length > MAX_LOOKUP_TABLES) throw new Error('account keys')
  const entries = [...keyMeta.entries()]
  const writableSigners = entries.filter(([, meta]) => meta.signer && meta.writable)
  const readonlySigners = entries.filter(([, meta]) => meta.signer && !meta.writable)
  const writableNonSigners = entries.filter(([, meta]) => !meta.signer && meta.writable)
  const readonlyNonSigners = entries.filter(([, meta]) => !meta.signer && !meta.writable)
  if (writableSigners.length !== 1 || readonlySigners.length !== 0 || writableSigners[0]?.[0] !== payer) throw new Error('payer')
  const staticKeys = [
    ...writableSigners.map(([address]) => address),
    ...readonlySigners.map(([address]) => address),
    ...writableNonSigners.map(([address]) => address),
    ...readonlyNonSigners.map(([address]) => address),
  ]
  const allKeys = [...staticKeys, ...writableLookupKeys, ...readonlyLookupKeys]
  if (allKeys.length > 256) throw new Error('account index')
  const keyIndexes = new Map(allKeys.map((address, index) => [address, index]))
  const compiled = instructions.map((instruction): CompiledInstruction => {
    const programIdIndex = keyIndexes.get(instruction.programId)
    if (programIdIndex === undefined) throw new Error('program index')
    const accountKeyIndexes = instruction.accounts.map((account) => {
      const index = keyIndexes.get(account.pubkey)
      if (index === undefined) throw new Error('account index')
      return index
    })
    return { programIdIndex, accountKeyIndexes, data: encodeInstructionData(instruction.dataBase64) }
  })
  const header = Uint8Array.from([
    writableSigners.length + readonlySigners.length,
    readonlySigners.length,
    readonlyNonSigners.length,
  ])
  const compiledInstructionBytes = concatBytes(
    encodeShortVec(compiled.length),
    ...compiled.map((instruction) => concatBytes(
      Uint8Array.from([instruction.programIdIndex]),
      encodeShortVec(instruction.accountKeyIndexes.length),
      Uint8Array.from(instruction.accountKeyIndexes),
      encodeShortVec(instruction.data.length),
      instruction.data,
    )),
  )
  const lookupBytes = concatBytes(
    encodeShortVec(lookupTableLookups.length),
    ...lookupTableLookups.map((lookup) => concatBytes(
      base58Decode(lookup.accountKey),
      encodeShortVec(lookup.writableIndexes.length),
      Uint8Array.from(lookup.writableIndexes),
      encodeShortVec(lookup.readonlyIndexes.length),
      Uint8Array.from(lookup.readonlyIndexes),
    )),
  )
  const message = concatBytes(
    Uint8Array.from([0x80]),
    header,
    encodeShortVec(staticKeys.length),
    ...staticKeys.map((address) => base58Decode(address)),
    base58Decode(canonicalSolanaAddress(recentBlockhash)),
    compiledInstructionBytes,
    lookupBytes,
  )
  const requiredSignatures = writableSigners.length + readonlySigners.length
  const transaction = concatBytes(
    encodeShortVec(requiredSignatures),
    new Uint8Array(requiredSignatures * 64),
    message,
  )
  if (transaction.length > MAX_SOLANA_TRANSACTION_BYTES) throw new Error('transaction size')
  return {
    transactionBase64: Buffer.from(transaction).toString('base64'),
    lookupTableLookups,
  }
}

const validateSourceSwapEnvelope = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  raw: Record<string, unknown>,
  stateAddress: string,
  stateTokenAccount: string,
  swapperAddress: string,
  minimumIntermediateAmount: string,
): MayanSwiftV2LocalSourceSwapPlan => {
  const direct = sourceIsUsdc(route)
  if (direct) throw new Error('direct source swap')
  if (route.sourceChainId === ETHEREUM_CHAIN_ID) {
    if (Object.keys(raw).sort().join(',') !== 'swapRouterAddress,swapRouterCalldata') throw new Error('source swap')
    const routerAddress = normalizeEvmAddress(raw.swapRouterAddress)
    if (quote.sourceSwap.routerAddress !== routerAddress || quote.sourceSwap.routerKind !== 'provider-selected-evm') throw new Error('source swap')
    if (typeof raw.swapRouterCalldata !== 'string' || !HEX_BYTES.test(raw.swapRouterCalldata) || raw.swapRouterCalldata === '0x' || !raw.swapRouterCalldata.toLowerCase().startsWith(EVM_SOURCE_SWAP_SELECTOR) || hexToBytes(raw.swapRouterCalldata).length > MAX_ROUTER_CALLDATA_BYTES) throw new Error('source swap')
    return {
      kind: 'evm-router',
      routerAddress,
      calldata: raw.swapRouterCalldata.toLowerCase(),
      rawResponseSha256: '',
      rawProviderSourceSwapJson: '',
    }
  }
  if (Object.hasOwn(raw, 'tokenLedgerInstruction') && raw.tokenLedgerInstruction !== null) throw new Error('source swap')
  if (!Array.isArray(raw.computeBudgetInstructions) || !Array.isArray(raw.setupInstructions) || raw.swapInstruction === undefined || raw.swapInstruction === null) throw new Error('source swap')
  if (raw.cleanupInstruction !== null && raw.cleanupInstruction !== undefined) throw new Error('source swap')
  if (!Array.isArray(raw.otherInstructions) || raw.otherInstructions.length !== 0) throw new Error('source swap')
  if (raw.simulationError !== null && raw.simulationError !== undefined) throw new Error('source swap')
  if (raw.separateSwapTx !== undefined && raw.separateSwapTx !== false) throw new Error('source swap')
  if (raw.jito !== undefined && raw.jito !== false && raw.jito !== null) throw new Error('source swap')
  const compute = raw.computeBudgetInstructions.map(instructionFromRaw)
  const setup = raw.setupInstructions.map(instructionFromRaw)
  const swap = instructionFromRaw(raw.swapInstruction)
  validateComputeInstructions(compute)
  validateAtaSetup(setup, swapperAddress, stateAddress, route.sourceUsdcAddress)
  validateJupiterInstruction(swap, route, quote, stateTokenAccount, swapperAddress, minimumIntermediateAmount, raw)
  const providerAlts = raw.addressLookupTableAddresses
  if (!Array.isArray(providerAlts) || providerAlts.length > MAX_LOOKUP_TABLES || providerAlts.some((address) => {
    try { canonicalSolanaAddress(address); return false } catch { return true }
  })) throw new Error('source swap')
  const addressLookupTableAddresses = providerAlts as string[]
  if (raw.prioritizationFeeLamports !== undefined && (typeof raw.prioritizationFeeLamports !== 'number' || !Number.isSafeInteger(raw.prioritizationFeeLamports) || raw.prioritizationFeeLamports < 0)) throw new Error('source swap')
  if (raw.computeUnitLimit !== undefined && (typeof raw.computeUnitLimit !== 'number' || !Number.isSafeInteger(raw.computeUnitLimit) || raw.computeUnitLimit > 1_400_000)) throw new Error('source swap')
  return {
    kind: 'solana-jupiter-v6',
    instructions: [...compute, ...setup, swap],
    addressLookupTableAddresses,
    rawResponseSha256: '',
    rawProviderSourceSwapJson: '',
  }
}

const preparePlan = (
  context: MayanSwiftV2LocalContext,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  options: BridgeRequestOptions | undefined,
): Promise<MayanSwiftV2SourceSwapPlan> => {
  const snapshot = cloneJson(context)
  return (async () => {
    const context = {
      ...snapshot,
      quote: runtime.validateQuote(snapshot.quote, 'BRIDGE_LOCAL_PLAN_INVALID'),
    }
    let route: LocalCapability
    let rawQuote: ReturnType<typeof parseSourceQuote>
    let swapperAddress: string
    let destinationAddress: string
    let orderNonce: string
    try {
      if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new Error('context')
      const keys = Object.keys(context as unknown as Record<string, unknown>).sort().join(',')
      if (keys !== 'destinationAddress,orderNonce,quote,swapperAddress') throw new Error('context')
      route = validateLocalRoute(context.quote)
      rawQuote = parseSourceQuote(context.quote, route)
      swapperAddress = route.sourceChainId === ETHEREUM_CHAIN_ID ? normalizeEvmAddress(context.swapperAddress) : canonicalSolanaAddress(context.swapperAddress)
      destinationAddress = route.destinationChainId === ETHEREUM_CHAIN_ID ? normalizeEvmAddress(context.destinationAddress) : canonicalSolanaAddress(context.destinationAddress)
      orderNonce = context.orderNonce
      if (typeof orderNonce !== 'string' || !NONCE.test(orderNonce)) throw new Error('nonce')
      validateDestinationMinimumCompatibility(context.quote.rawSignedQuoteJson, context.quote.minimumAmountOut)
      if (Math.floor(Date.now() / 1000) + runtime.minimumQuoteValiditySeconds > Number(uint64(context.quote.deadline, true))) runtime.fail('BRIDGE_QUOTE_EXPIRED')
    } catch (error) {
      if (error instanceof Error && error.name === 'BridgeError') throw error
      runtime.fail('BRIDGE_LOCAL_PLAN_INVALID')
    }
    const rawQuoteSha256 = sha256Hex(context.quote.rawSignedQuoteJson)
    const orderHash = hashOrder(context.quote, route, swapperAddress, destinationAddress, orderNonce, rawQuote.minimumIntermediateAmount, rawQuote.cancelFee, rawQuote.refundFee, rawQuote.mode)
    const binding = quoteBindingHash(route, context.quote, rawQuoteSha256, orderNonce, swapperAddress, destinationAddress)
    let sourceSwap: MayanSwiftV2LocalSourceSwapPlan
    if (sourceIsUsdc(route)) {
      sourceSwap = { kind: 'none' }
    } else {
      const endpoint = endpointUrl(runtime.localBuild?.sourceSwapEndpoint)
      const sourceChain = route.sourceChainId === ETHEREUM_CHAIN_ID ? 'evm' : 'solana'
      let url: URL
      if (sourceChain === 'evm') {
        url = sourceSwapUrl(endpoint, sourceChain, [
          ['forwarderAddress', ETHEREUM_FORWARDER_PROVIDER],
          ['slippageBps', context.quote.slippageBps],
          ['fromToken', String((rawQuote.raw.fromToken as Record<string, unknown>).contract)],
          ['middleToken', route.sourceUsdcAddress],
          ['chainName', route.sourceProviderChainName],
          ['amountIn64', context.quote.amountIn],
          ['sdkVersion', MAYAN_ORACLE_SDK_VERSION],
        ])
      } else {
        const state = findProgramAddress([
          new TextEncoder().encode('STATE_SOURCE'),
          hexToBytes(orderHash),
          writeUint16Le(2),
        ], SOLANA_SWIFT_PROGRAM)
        const sourceMinimum = extractRawNumberLexeme(context.quote.rawSignedQuoteJson, 'minMiddleAmount')
        url = sourceSwapUrl(endpoint, sourceChain, [
          ['minMiddleAmount', Number(sourceMinimum)],
          ['middleToken', route.sourceUsdcAddress],
          ['userWallet', swapperAddress],
          ['slippageBps', context.quote.slippageBps],
          ['fromToken', route.sourceTokenAddress],
          ['amountIn64', context.quote.amountIn],
          ['depositMode', 'SWIFT'],
          ['fillMaxAccounts', false],
          ['chainName', route.sourceProviderChainName],
          ['userLedger', state.address],
          ['sdkVersion', MAYAN_ORACLE_SDK_VERSION],
        ])
      }
      try {
        const response = await fetchSourceSwap(runtime, url, options)
        const state = route.sourceChainId === SOLANA_CHAIN_ID
          ? findProgramAddress([new TextEncoder().encode('STATE_SOURCE'), hexToBytes(orderHash), writeUint16Le(2)], SOLANA_SWIFT_PROGRAM).address
          : ''
        const stateTokenAccount = route.sourceChainId === SOLANA_CHAIN_ID ? associatedTokenAddress(state, route.sourceUsdcAddress, true) : ''
        sourceSwap = validateSourceSwapEnvelope(context.quote, route, response.root, state, stateTokenAccount, swapperAddress, rawQuote.minimumIntermediateAmount)
        if (sourceSwap.kind === 'none') throw new Error('source swap')
        sourceSwap = {
          ...sourceSwap,
          rawResponseSha256: sha256Hex(response.text),
          rawProviderSourceSwapJson: response.text,
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'BridgeError') throw error
        runtime.fail('BRIDGE_LOCAL_PLAN_INVALID')
      }
    }
    const plan: MayanSwiftV2SourceSwapPlan = {
      planKind: 'mayan-swift-v2-local-source-swap',
      providerId: 'mayan-swift-v2',
      capabilityId: route.bridgeCapabilityId,
      sourceChainId: route.sourceChainId,
      destinationChainId: route.destinationChainId,
      sourceTokenDeploymentId: route.sourceTokenDeploymentId,
      destinationTokenDeploymentId: route.destinationTokenDeploymentId,
      quoteId: context.quote.quoteId,
      rawQuoteSha256,
      orderNonce,
      swapperAddress,
      destinationAddress,
      orderHash,
      quoteBindingHash: binding,
      minimumIntermediateAmount: rawQuote.minimumIntermediateAmount,
      sourceSwap,
      planHash: planHash(binding, sourceSwap),
    }
    return plan
  })()
}

interface SourceRpcResult {
  readonly erpc: ErpcClient
  readonly evidence: MayanSwiftV2LocalSourceRpcEvidence
  readonly lookupTables: readonly LocalLookupTable[]
  readonly recentBlockhash: string | null
}

const sourceRpcError = (
  runtime: MayanSwiftV2LocalRuntimeConfig,
  error: unknown,
): never => {
  if (error instanceof Error && error.name === 'BridgeError') throw error
  if (error instanceof ErpcInvalidResponseError || error instanceof ErpcJsonRpcError) {
    return runtime.fail('BRIDGE_SOURCE_RPC_INVALID_RESPONSE')
  }
  if (error instanceof ErpcAbortedError) return runtime.fail('BRIDGE_ABORTED')
  if (error instanceof ErpcTimeoutError) return runtime.fail('BRIDGE_TIMEOUT')
  if (error instanceof ErpcHttpError || error instanceof ErpcTransportError) {
    return runtime.fail('BRIDGE_SOURCE_RPC_TRANSPORT')
  }
  if (error instanceof ErpcConfigError) return runtime.fail('BRIDGE_LOCAL_BUILD_INVALID')
  return runtime.fail('BRIDGE_SOURCE_RPC_INVALID_RESPONSE')
}

const directRpc = (
  endpoint: NonNullable<MayanSwiftV2BridgeConfig['localBuild']>['ethereumRpc'] | NonNullable<MayanSwiftV2BridgeConfig['localBuild']>['solanaRpc'] | undefined,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  code: BridgeErrorCode,
  chain: 'ethereum' | 'solana',
): ErpcClient => {
  if (endpoint === undefined || endpoint === null) runtime.fail(code)
  if (endpoint === null || typeof endpoint !== 'object' || Array.isArray(endpoint)) runtime.fail('BRIDGE_LOCAL_BUILD_INVALID')
  const rpcFetch: typeof globalThis.fetch = async (input, init) => {
    const requestBody = init?.body
    if (typeof requestBody !== 'string') return runtime.fetch(input, init)
    let request: Record<string, unknown>
    try {
      const parsed = JSON.parse(requestBody) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return runtime.fetch(input, init)
      request = parsed as Record<string, unknown>
    } catch {
      return runtime.fetch(input, init)
    }
    const requestId = request.id
    request.id = 1
    const response = await runtime.fetch(input, { ...init, body: JSON.stringify(request) })
    let responseBody: string
    try {
      const signal = init?.signal ?? new AbortController().signal
      responseBody = await readSourceResponseText(response, signal)
    } catch (error) {
      if (error instanceof SourceResponseInvalidError) {
        return new Response('null', {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      throw error
    }
    if (!response.ok) {
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    let parsed: Record<string, unknown>
    try {
      parsed = parseJsonObject(responseBody)
    } catch {
      return new Response('null', {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    if (
      parsed.jsonrpc !== '2.0' ||
      typeof parsed.id !== 'number' ||
      !Number.isSafeInteger(parsed.id) ||
      parsed.id !== 1
    ) {
      return new Response('null', {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    parsed.id = requestId
    responseBody = JSON.stringify(parsed)
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return createErpcClient({
    ...(chain === 'ethereum' ? { ethereumRpc: endpoint } : { solanaRpc: endpoint }),
    fetch: rpcFetch,
    timeoutMs: runtime.timeoutMs,
  })
}

const parseRpcAccount = (value: unknown): { readonly data: Uint8Array; readonly owner: string } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('account')
  const account = value as Record<string, unknown>
  if (
    !Array.isArray(account.data) ||
    account.data.length !== 2 ||
    typeof account.data[0] !== 'string' ||
    account.data[1] !== 'base64' ||
    typeof account.owner !== 'string' ||
    account.executable !== false
  ) throw new Error('account')
  const data = base64Decode(account.data[0], 16_384)
  return { data, owner: canonicalSolanaAddress(account.owner) }
}

const decodeLookupTable = (
  address: string,
  account: { readonly data: Uint8Array; readonly owner: string },
  accountContextSlot: number,
): LocalLookupTable => {
  if (
    account.owner !== SOLANA_ADDRESS_LOOKUP_TABLE_OWNER ||
    account.data.length < 56 ||
    (account.data.length - 56) % 32 !== 0
  ) throw new Error('ALT')
  const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength)
  if (view.getUint32(0, true) !== 1) throw new Error('ALT')
  const deactivationSlot = view.getBigUint64(4, true)
  if (deactivationSlot !== UINT64_MAX) throw new Error('ALT')
  const lastExtendedSlot = view.getBigUint64(12, true)
  if (lastExtendedSlot > BigInt(accountContextSlot)) throw new Error('ALT')
  const lastExtendedStartIndex = account.data[20]
  const authorityOption = account.data[21]
  if (lastExtendedStartIndex === undefined || authorityOption === undefined || (authorityOption !== 0 && authorityOption !== 1)) throw new Error('ALT')
  for (let index = 54; index < 56; index += 1) {
    if (account.data[index] !== 0) throw new Error('ALT')
  }
  if (authorityOption === 0) {
    for (let index = 22; index < 54; index += 1) {
      if (account.data[index] !== 0) throw new Error('ALT')
    }
  }
  const addresses: string[] = []
  for (let offset = 56; offset < account.data.length; offset += 32) addresses.push(base58Encode(account.data.slice(offset, offset + 32)))
  if (addresses.length > MAX_LOOKUP_TABLE_ADDRESSES || lastExtendedStartIndex > addresses.length) throw new Error('ALT')
  const activeCount = lastExtendedSlot === BigInt(accountContextSlot)
    ? lastExtendedStartIndex
    : addresses.length
  return { address, addresses: addresses.slice(0, activeCount) }
}

const fetchSourceRpc = async (
  route: LocalCapability,
  plan: MayanSwiftV2SourceSwapPlan,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  options: BridgeRequestOptions | undefined,
): Promise<SourceRpcResult> => {
  const endpoint = route.sourceChainId === ETHEREUM_CHAIN_ID
    ? runtime.localBuild?.ethereumRpc
    : runtime.localBuild?.solanaRpc
  let erpc: ErpcClient
  try {
    erpc = directRpc(endpoint, runtime, 'BRIDGE_LOCAL_RPC_REQUIRED', route.sourceChainId === ETHEREUM_CHAIN_ID ? 'ethereum' : 'solana')
  } catch (error) {
    return sourceRpcError(runtime, error)
  }
  const rpcOptions = options?.signal === undefined ? undefined : { signal: options.signal }
  try {
    if (route.sourceChainId === ETHEREUM_CHAIN_ID) {
      const rpcChainId = await erpc.ethereum.rpc.eth_chainId().send(rpcOptions)
      if (rpcChainId.toLowerCase() !== '0x1') throw new Error('chain')
      const codeAddresses = [ETHEREUM_FORWARDER, route.swiftContract]
      if (plan.sourceSwap.kind === 'evm-router') codeAddresses.push(plan.sourceSwap.routerAddress)
      const code: { address: string; keccak256: string }[] = []
      for (const address of codeAddresses) {
        const bytecode = await erpc.ethereum.rpc.eth_getCode(address as `0x${string}`, 'latest').send(rpcOptions)
        if (typeof bytecode !== 'string' || !HEX_BYTES.test(bytecode) || bytecode === '0x') throw new Error('code')
        code.push({ address: normalizeEvmAddress(address), keccak256: `0x${keccakHex(hexToBytes(bytecode))}` })
      }
      return {
        erpc,
        evidence: { kind: 'evm', rpcChainId: '0x1', code },
        lookupTables: [],
        recentBlockhash: null,
      }
    }
    const genesisHash = await erpc.solana.rpc.getGenesisHash().send(rpcOptions)
    if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) throw new Error('genesis')
    const blockhashResult = await erpc.solana.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(rpcOptions)
    if (blockhashResult === null || typeof blockhashResult !== 'object' || Array.isArray(blockhashResult)) throw new Error('blockhash')
    const blockhashWrapper = blockhashResult as unknown as Record<string, unknown>
    const blockhashContext = blockhashWrapper.context
    const blockhashValue = blockhashWrapper.value
    if (blockhashContext === null || typeof blockhashContext !== 'object' || Array.isArray(blockhashContext) || blockhashValue === null || typeof blockhashValue !== 'object' || Array.isArray(blockhashValue)) throw new Error('blockhash')
    const blockhashSlot = (blockhashContext as Record<string, unknown>).slot
    const recentBlockhash = (blockhashValue as Record<string, unknown>).blockhash
    const lastValidBlockHeight = (blockhashValue as Record<string, unknown>).lastValidBlockHeight
    if (
      typeof blockhashSlot !== 'number' ||
      !Number.isSafeInteger(blockhashSlot) ||
      blockhashSlot < 0 ||
      typeof recentBlockhash !== 'string' ||
      typeof lastValidBlockHeight !== 'number' ||
      !Number.isSafeInteger(lastValidBlockHeight) ||
      lastValidBlockHeight < 0 ||
      !canonicalSolanaAddress(recentBlockhash)
    ) throw new Error('blockhash')
    const providerAlts = plan.sourceSwap.kind === 'solana-jupiter-v6' ? plan.sourceSwap.addressLookupTableAddresses : []
    const altAddresses = [...new Set([SOLANA_MAYAN_LOOKUP_TABLE, ...providerAlts])]
    if (altAddresses.length > MAX_LOOKUP_TABLES) throw new Error('ALT')
    const accountsResult = await erpc.solana.rpc.getMultipleAccounts(
      altAddresses,
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: blockhashSlot },
    ).send(rpcOptions)
    if (accountsResult === null || typeof accountsResult !== 'object' || Array.isArray(accountsResult)) throw new Error('accounts')
    const accountsWrapper = accountsResult as unknown as Record<string, unknown>
    const accountContext = accountsWrapper.context
    const accountValues = accountsWrapper.value
    if (accountContext === null || typeof accountContext !== 'object' || Array.isArray(accountContext) || !Array.isArray(accountValues)) throw new Error('accounts')
    const accountSlot = (accountContext as Record<string, unknown>).slot
    if (
      typeof accountSlot !== 'number' ||
      !Number.isSafeInteger(accountSlot) ||
      accountSlot < 0 ||
      typeof blockhashSlot !== 'number' ||
      accountSlot < blockhashSlot ||
      accountValues.length !== altAddresses.length
    ) throw new Error('accounts')
    const lookupTables = altAddresses.map((address, index) => decodeLookupTable(address, parseRpcAccount(accountValues[index]), accountSlot))
    return {
      erpc,
      evidence: {
        kind: 'solana',
        genesisHash,
        blockhashContextSlot: String(blockhashSlot),
        accountContextSlot: String(accountSlot),
        recentBlockhash,
        lastValidBlockHeight: String(lastValidBlockHeight),
        lookupTables: lookupTables.map((table) => ({ address: table.address, dataSha256: sha256Hex(parseRpcAccount(accountValues[altAddresses.indexOf(table.address)]).data) })),
      },
      lookupTables,
      recentBlockhash,
    }
  } catch (error) {
    erpc.close()
    return sourceRpcError(runtime, error)
  }
}

const exactKeys = (value: unknown, expected: readonly string[]): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value as Record<string, unknown>).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

const validatePlan = (
  request: MayanSwiftV2LocalBuildRequest,
  route: LocalCapability,
  rawQuote: ReturnType<typeof parseSourceQuote>,
  plan: MayanSwiftV2SourceSwapPlan,
  rawQuoteSha256: string,
  orderHash: string,
  binding: string,
  swapperAddress: string,
  destinationAddress: string,
): MayanSwiftV2SourceSwapPlan => {
  if (!exactKeys(plan, [
    'planKind', 'providerId', 'capabilityId', 'sourceChainId', 'destinationChainId',
    'sourceTokenDeploymentId', 'destinationTokenDeploymentId', 'quoteId', 'rawQuoteSha256',
    'orderNonce', 'swapperAddress', 'destinationAddress', 'orderHash', 'quoteBindingHash',
    'minimumIntermediateAmount', 'sourceSwap', 'planHash',
  ])) throw new Error('plan')
  if (
    plan.planKind !== 'mayan-swift-v2-local-source-swap' || plan.providerId !== 'mayan-swift-v2' ||
    plan.capabilityId !== route.bridgeCapabilityId || plan.sourceChainId !== route.sourceChainId ||
    plan.destinationChainId !== route.destinationChainId || plan.sourceTokenDeploymentId !== route.sourceTokenDeploymentId ||
    plan.destinationTokenDeploymentId !== route.destinationTokenDeploymentId || plan.quoteId !== request.quote.quoteId ||
    plan.rawQuoteSha256 !== rawQuoteSha256 || plan.orderNonce !== request.orderNonce ||
    plan.swapperAddress !== swapperAddress || plan.destinationAddress !== destinationAddress ||
    plan.orderHash !== orderHash || plan.quoteBindingHash !== binding ||
    plan.minimumIntermediateAmount !== rawQuote.minimumIntermediateAmount
  ) throw new Error('plan')
  let normalizedSwap: MayanSwiftV2LocalSourceSwapPlan
  if (sourceIsUsdc(route)) {
    if (!exactKeys(plan.sourceSwap, ['kind']) || plan.sourceSwap.kind !== 'none') throw new Error('plan')
    normalizedSwap = { kind: 'none' }
  } else {
    const state = route.sourceChainId === SOLANA_CHAIN_ID
      ? findProgramAddress([new TextEncoder().encode('STATE_SOURCE'), hexToBytes(orderHash), writeUint16Le(2)], SOLANA_SWIFT_PROGRAM).address
      : ''
    const stateTokenAccount = route.sourceChainId === SOLANA_CHAIN_ID ? associatedTokenAddress(state, route.sourceUsdcAddress, true) : ''
    if (plan.sourceSwap.kind === 'none') throw new Error('plan')
    const sourceRaw = parseJsonObject(plan.sourceSwap.rawProviderSourceSwapJson)
    if (plan.sourceSwap.rawResponseSha256 !== sha256Hex(plan.sourceSwap.rawProviderSourceSwapJson)) throw new Error('plan')
    const expected = validateSourceSwapEnvelope(request.quote, route, sourceRaw, state, stateTokenAccount, swapperAddress, rawQuote.minimumIntermediateAmount)
    if (stableJson(expected) !== stableJson({ ...plan.sourceSwap, rawResponseSha256: '', rawProviderSourceSwapJson: '' })) throw new Error('plan')
    normalizedSwap = plan.sourceSwap
  }
  if (plan.planHash !== planHash(binding, normalizedSwap)) throw new Error('plan')
  return plan
}

const localBuildDependencies = (route: LocalCapability): readonly string[] => [
  ...route.dependencies.filter((dependency) => dependency !== 'mayan-hosted-transaction-builder'),
  route.sourceChainId === ETHEREUM_CHAIN_ID ? 'configured-ethereum-rpc' : 'configured-solana-rpc',
]

const buildEvmOrderCall = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  plan: MayanSwiftV2SourceSwapPlan,
  swapperAddress: string,
  destinationAddress: string,
  minimumIntermediateAmount: string,
  cancelFee: bigint,
  refundFee: bigint,
  mode: number,
  orderNonce: string,
): string => {
  const orderWords = [
    wordUint(1n),
    wordBytes32(nativeAddressBytes(swapperAddress, route.sourceChainId)),
    wordBytes32(nativeAddressBytes(destinationAddress, route.destinationChainId)),
    wordUint(BigInt(route.destinationWormholeChainId)),
    wordBytes32(zero32()),
    wordBytes32(nativeAddressBytes(route.destinationTokenAddress, route.destinationChainId)),
    wordUint(uint64(quote.minimumAmountOut, true)),
    wordUint(0n),
    wordUint(cancelFee),
    wordUint(refundFee),
    wordUint(uint64(quote.deadline, true)),
    wordUint(0n),
    wordUint(BigInt(mode)),
    wordBytes32(swiftRandom(quote.quoteId, orderNonce)),
  ]
  const swiftCallData = `0xa3a30834${bytesToHex(encodeAbiWithDynamics([
    wordAddress(route.sourceUsdcAddress),
    wordUint(uint64(quote.amountIn, true)),
    ...orderWords,
  ], [new Uint8Array()]))}`
  if (plan.sourceSwap.kind === 'none') {
    return `0xe4269fc4${bytesToHex(encodeAbiWithDynamics([
      wordAddress(route.sourceUsdcAddress),
      wordUint(uint64(quote.amountIn, true)),
      ...[wordUint(0n), wordUint(0n), wordUint(0n), wordBytes32(zero32()), wordBytes32(zero32())],
      wordAddress(route.swiftContract),
    ], [hexToBytes(swiftCallData)]))}`
  }
  if (plan.sourceSwap.kind !== 'evm-router') throw new Error('plan')
  const routerData = hexToBytes(plan.sourceSwap.calldata)
  const routerOffset = 13 * 32
  const swiftOffset = routerOffset + 32 + Math.ceil(routerData.length / 32) * 32
  const head = [
    wordAddress(route.sourceTokenAddress),
    wordUint(uint64(quote.amountIn, true)),
    wordUint(0n), wordUint(0n), wordUint(0n), wordBytes32(zero32()), wordBytes32(zero32()),
    wordAddress(plan.sourceSwap.routerAddress),
    wordUint(BigInt(routerOffset)),
    wordAddress(route.sourceUsdcAddress),
    wordUint(uint64(minimumIntermediateAmount, true)),
    wordAddress(route.swiftContract),
    wordUint(BigInt(swiftOffset)),
  ]
  return `0x30dedc57${bytesToHex(concatBytes(
    ...head,
    encodeAbiBytes(routerData),
    encodeAbiBytes(hexToBytes(swiftCallData)),
  ))}`
}

const buildSolanaInstructions = (
  quote: MayanSwiftV2Quote,
  route: LocalCapability,
  plan: MayanSwiftV2SourceSwapPlan,
  swapperAddress: string,
  destinationAddress: string,
  minimumIntermediateAmount: string,
  cancelFee: bigint,
  refundFee: bigint,
  submitFee: bigint,
  mode: number,
  orderNonce: string,
  raw: Record<string, unknown>,
): readonly MayanSwiftV2LocalSourceSwapInstruction[] => {
  const state = findProgramAddress([
    new TextEncoder().encode('STATE_SOURCE'),
    hexToBytes(hashOrder(quote, route, swapperAddress, destinationAddress, orderNonce, minimumIntermediateAmount, cancelFee, refundFee, mode)),
    writeUint16Le(2),
  ], SOLANA_SWIFT_PROGRAM).address
  const stateTokenAccount = associatedTokenAddress(state, route.sourceUsdcAddress, true)
  const init = makeSwiftInitInstruction(
    quote,
    route,
    swapperAddress,
    destinationAddress,
    state,
    stateTokenAccount,
    minimumIntermediateAmount,
    cancelFee,
    refundFee,
    submitFee,
    mode,
    orderNonce,
  )
  if (sourceIsUsdc(route)) {
    const instructions: MayanSwiftV2LocalSourceSwapInstruction[] = []
    const suggestedPriorityFee = raw.suggestedPriorityFee
    if (typeof suggestedPriorityFee === 'number' && Number.isSafeInteger(suggestedPriorityFee) && suggestedPriorityFee > 0) {
      if (suggestedPriorityFee > 100_000) throw new Error('compute')
      instructions.push(makeComputeUnitPriceInstruction(BigInt(suggestedPriorityFee)))
    }
    instructions.push(wrapInCpiProxy(makeAtaInstruction(swapperAddress, state, route.sourceUsdcAddress, true)))
    instructions.push(wrapInCpiProxy(makeSplTransferInstruction(
      associatedTokenAddress(swapperAddress, route.sourceUsdcAddress, false),
      stateTokenAccount,
      swapperAddress,
      uint64(quote.amountIn, true),
    )))
    instructions.push(wrapInCpiProxy(init))
    return instructions
  }
  if (plan.sourceSwap.kind !== 'solana-jupiter-v6') throw new Error('plan')
  const computeCount = plan.sourceSwap.instructions.filter((instruction) => instruction.programId === SOLANA_COMPUTE_BUDGET_PROGRAM).length
  const compute = plan.sourceSwap.instructions.slice(0, computeCount)
  const remainder = plan.sourceSwap.instructions.slice(computeCount)
  const swapIndex = remainder.findIndex((instruction) => instruction.programId === SOLANA_JUPITER_V6)
  if (swapIndex < 1) throw new Error('source swap')
  const setup = remainder.slice(0, swapIndex)
  const swap = remainder[swapIndex]
  if (!swap || remainder.slice(swapIndex + 1).length !== 0) throw new Error('source swap')
  return [
    ...compute,
    ...setup.map(wrapInCpiProxy),
    swap,
    wrapInCpiProxy(init),
  ]
}

const buildLocalPlan = (
  context: MayanSwiftV2LocalBuildRequest,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  options: BridgeRequestOptions | undefined,
): Promise<MayanSwiftV2LocalBuild> => {
  const snapshot = cloneJson(context)
  return (async () => {
  const context = {
    ...snapshot,
    quote: runtime.validateQuote(snapshot.quote, 'BRIDGE_LOCAL_BUILD_INVALID'),
  }
  let route: LocalCapability
  let rawQuote: ReturnType<typeof parseSourceQuote>
  let swapperAddress: string
  let destinationAddress: string
  try {
    if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new Error('context')
    const keys = Object.keys(context as unknown as Record<string, unknown>).sort().join(',')
    if (keys !== 'destinationAddress,orderNonce,quote,sourceSwapPlan,swapperAddress') throw new Error('context')
    route = validateLocalRoute(context.quote)
    rawQuote = parseSourceQuote(context.quote, route)
    swapperAddress = route.sourceChainId === ETHEREUM_CHAIN_ID ? normalizeEvmAddress(context.swapperAddress) : canonicalSolanaAddress(context.swapperAddress)
    destinationAddress = route.destinationChainId === ETHEREUM_CHAIN_ID ? normalizeEvmAddress(context.destinationAddress) : canonicalSolanaAddress(context.destinationAddress)
    if (typeof context.orderNonce !== 'string' || !NONCE.test(context.orderNonce)) throw new Error('nonce')
    validateDestinationMinimumCompatibility(context.quote.rawSignedQuoteJson, context.quote.minimumAmountOut)
    if (Math.floor(Date.now() / 1000) + runtime.minimumQuoteValiditySeconds > Number(uint64(context.quote.deadline, true))) runtime.fail('BRIDGE_QUOTE_EXPIRED')
  } catch (error) {
    if (error instanceof Error && error.name === 'BridgeError') throw error
    runtime.fail('BRIDGE_LOCAL_BUILD_INVALID')
  }
  const rawQuoteSha256 = sha256Hex(context.quote.rawSignedQuoteJson)
  const orderHash = hashOrder(context.quote, route, swapperAddress, destinationAddress, context.orderNonce, rawQuote.minimumIntermediateAmount, rawQuote.cancelFee, rawQuote.refundFee, rawQuote.mode)
  const binding = quoteBindingHash(route, context.quote, rawQuoteSha256, context.orderNonce, swapperAddress, destinationAddress)
  try {
    const plan = validatePlan(context, route, rawQuote, context.sourceSwapPlan, rawQuoteSha256, orderHash, binding, swapperAddress, destinationAddress)
    const rpc = await fetchSourceRpc(route, plan, runtime, options)
    try {
      let transaction: MayanSwiftV2UnsignedTransaction
      if (route.sourceChainId === ETHEREUM_CHAIN_ID) {
        const data = buildEvmOrderCall(context.quote, route, plan, swapperAddress, destinationAddress, rawQuote.minimumIntermediateAmount, rawQuote.cancelFee, rawQuote.refundFee, rawQuote.mode, context.orderNonce)
        transaction = {
          kind: 'evm-unsigned-transaction',
          chainId: ETHEREUM_CHAIN_ID as 'eip155:1',
          from: swapperAddress,
          to: ETHEREUM_FORWARDER,
          data,
          value: '0',
        }
      } else {
        const instructions = buildSolanaInstructions(context.quote, route, plan, swapperAddress, destinationAddress, rawQuote.minimumIntermediateAmount, rawQuote.cancelFee, rawQuote.refundFee, rawQuote.submitFee, rawQuote.mode, context.orderNonce, rawQuote.raw)
        if (rpc.recentBlockhash === null) throw new Error('blockhash')
        const compiled = compileSolanaV0(swapperAddress, rpc.recentBlockhash, instructions, rpc.lookupTables)
        transaction = {
          kind: 'solana-v0-unsigned-transaction',
          chainId: SOLANA_CHAIN_ID,
          feePayer: swapperAddress,
          transactionBase64: compiled.transactionBase64,
        }
      }
      const allowance = route.sourceChainId === ETHEREUM_CHAIN_ID
        ? {
            tokenDeploymentId: route.sourceTokenDeploymentId,
            tokenAddress: route.sourceTokenAddress,
            owner: swapperAddress,
            spender: ETHEREUM_FORWARDER,
            requiredAmount: context.quote.amountIn,
          }
        : null
      return {
        buildKind: 'mayan-swift-v2-local-unsigned',
        providerId: 'mayan-swift-v2',
        capabilityId: route.bridgeCapabilityId,
        quote: cloneJson(context.quote),
        sourceChainId: route.sourceChainId,
        destinationChainId: route.destinationChainId,
        sourceSwapPlan: cloneJson(plan),
        transaction,
        allowance,
        construction: {
          mode: 'local',
          referenceCommit: MAYAN_REFERENCE_COMMIT,
          orderNonce: context.orderNonce,
          orderHash,
          minimumIntermediateAmount: rawQuote.minimumIntermediateAmount,
          effectiveDependencies: localBuildDependencies(route),
          sourceRpcEvidence: rpc.evidence,
        },
        validation: {
          level: 'local-structural',
          quoteSignatureLocallyVerified: false,
          planBindingLocallyVerified: true,
          transactionBytesLocallyConstructed: true,
          settlementLocallyVerified: false,
        },
      }
    } finally {
      rpc.erpc.close()
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'BridgeError') throw error
    runtime.fail('BRIDGE_LOCAL_BUILD_INVALID')
  }
})()
}

export const prepareSourceSwap = (
  context: MayanSwiftV2LocalContext,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  options?: BridgeRequestOptions,
): Promise<MayanSwiftV2SourceSwapPlan> => preparePlan(context, runtime, options)

export const buildLocalUnsigned = (
  request: MayanSwiftV2LocalBuildRequest,
  runtime: MayanSwiftV2LocalRuntimeConfig,
  options?: BridgeRequestOptions,
): Promise<MayanSwiftV2LocalBuild> => buildLocalPlan(request, runtime, options)

export const __testIsOnCurveZip215 = (bytes: Uint8Array): boolean =>
  isOnCurveZip215(bytes)

export const __testFindProgramAddress = (
  seeds: readonly Uint8Array[],
  programId: string,
): { readonly address: string; readonly bump: number } =>
  findProgramAddress(seeds, programId)
