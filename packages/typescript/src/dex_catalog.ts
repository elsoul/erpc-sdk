import {
  DEX_ALIASES,
  DEX_CATALOG_AS_OF_DATE,
  DEX_CATALOG_CONTENT_DIGEST,
  DEX_CATALOG_VERSION,
  DEX_CHAIN_IDS,
  DEX_DEPLOYMENTS,
  NATIVE_WRAP_DEFINITIONS,
  POOL_DEFINITIONS,
  dexes,
  pools,
} from './generated/dex_catalog'
import type {
  DexAlias,
  DexChainId,
  DexDeployment,
  DexStatus,
  NativeWrapDefinition,
  PoolDefinition,
} from './generated/dex_catalog'

export {
  DEX_ALIASES,
  DEX_CATALOG_AS_OF_DATE,
  DEX_CATALOG_CONTENT_DIGEST,
  DEX_CATALOG_VERSION,
  DEX_CHAIN_IDS,
  DEX_DEPLOYMENTS,
  NATIVE_WRAP_DEFINITIONS,
  POOL_DEFINITIONS,
}

export type {
  DexAlias,
  DexChainId,
  DexDeployment,
  DexStatus,
  NativeWrapDefinition,
  PoolDefinition,
}

export type DexNamespace = 'ethereum' | 'solana' | 'avalancheC'

export interface ListPoolDefinitionsOptions {
  readonly chainId?: DexChainId
  readonly tokenDeploymentId?: string
  readonly adapterKind?: string
}

const EMPTY_POOLS: readonly PoolDefinition[] = Object.freeze([])

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

// The generated module is a package data boundary. Freeze it again here so
// hand-authored generator changes cannot accidentally expose mutable records.
deepFreeze(DEX_CHAIN_IDS)
deepFreeze(DEX_DEPLOYMENTS)
deepFreeze(POOL_DEFINITIONS)
deepFreeze(NATIVE_WRAP_DEFINITIONS)
deepFreeze(DEX_ALIASES)
deepFreeze(dexes)
deepFreeze(pools)

const knownChainIds = new Set<string>(Object.values(DEX_CHAIN_IDS))
const dexById = new Map<string, DexDeployment>(
  DEX_DEPLOYMENTS.map((deployment) => [deployment.dexDeploymentId, deployment]),
)
const poolById = new Map<string, PoolDefinition>(
  POOL_DEFINITIONS.map((pool) => [pool.poolDefinitionId, pool]),
)
const wrapByNativeTokenId = new Map<string, NativeWrapDefinition>(
  NATIVE_WRAP_DEFINITIONS.map((definition) => [
    definition.nativeTokenDeploymentId,
    definition,
  ]),
)

/** Chain-qualified DEX aliases whose values are opaque deployment IDs. */
export { dexes }

/** Chain-qualified pool aliases whose values are opaque pool IDs. */
export { pools }

/** Return a DEX deployment by its exact opaque ID. */
export function getDexDeployment(
  dexDeploymentId: string,
): DexDeployment | undefined {
  return typeof dexDeploymentId === 'string'
    ? dexById.get(dexDeploymentId)
    : undefined
}

/** Return a pool definition by its exact opaque ID. */
export function getPoolDefinition(
  poolDefinitionId: string,
): PoolDefinition | undefined {
  return typeof poolDefinitionId === 'string'
    ? poolById.get(poolDefinitionId)
    : undefined
}

/** Find a pool by its chain-qualified address. */
export function findPoolDefinitionByAddress(
  chainId: DexChainId,
  address: string,
): PoolDefinition | undefined {
  if (!isKnownChain(chainId) || typeof address !== 'string' || address.length === 0) {
    return undefined
  }
  const normalizedAddress = isEvmChain(chainId)
    ? normalizeEvmAddress(address)
    : address
  if (normalizedAddress === undefined) return undefined
  return POOL_DEFINITIONS.find(
    (pool) =>
      pool.chainId === chainId && pool.address === normalizedAddress,
  )
}

/** Find all pools for an unordered token pair in stable pool-ID order. */
export function findPoolDefinitionsByPair(
  chainId: DexChainId,
  tokenADeploymentId: string,
  tokenBDeploymentId: string,
): readonly PoolDefinition[] {
  if (
    !isKnownChain(chainId) ||
    typeof tokenADeploymentId !== 'string' ||
    typeof tokenBDeploymentId !== 'string' ||
    tokenADeploymentId.length === 0 ||
    tokenBDeploymentId.length === 0 ||
    tokenADeploymentId === tokenBDeploymentId
  ) {
    return EMPTY_POOLS
  }

  const wanted = [tokenADeploymentId, tokenBDeploymentId].sort().join('\u0000')
  const matches = POOL_DEFINITIONS.filter((pool) => {
    const actual = [pool.token0DeploymentId, pool.token1DeploymentId]
      .sort()
      .join('\u0000')
    return pool.chainId === chainId && actual === wanted
  }).sort((left, right) =>
    left.poolDefinitionId < right.poolDefinitionId
      ? -1
      : left.poolDefinitionId > right.poolDefinitionId
        ? 1
        : 0,
  )
  return matches.length === 0 ? EMPTY_POOLS : Object.freeze(matches)
}

/** List pool definitions using the optional exact filters. */
export function listPoolDefinitions(
  options: ListPoolDefinitionsOptions = {},
): readonly PoolDefinition[] {
  if (!isRecord(options)) return EMPTY_POOLS
  const { chainId, tokenDeploymentId, adapterKind } = options
  if (chainId !== undefined && !isKnownChain(chainId)) return EMPTY_POOLS
  if (
    tokenDeploymentId !== undefined &&
    (typeof tokenDeploymentId !== 'string' || tokenDeploymentId.length === 0)
  ) {
    return EMPTY_POOLS
  }
  if (
    adapterKind !== undefined &&
    (typeof adapterKind !== 'string' || adapterKind.length === 0)
  ) {
    return EMPTY_POOLS
  }

  const matches = POOL_DEFINITIONS.filter((pool) => {
    if (chainId !== undefined && pool.chainId !== chainId) return false
    if (
      tokenDeploymentId !== undefined &&
      pool.token0DeploymentId !== tokenDeploymentId &&
      pool.token1DeploymentId !== tokenDeploymentId
    ) {
      return false
    }
    if (adapterKind !== undefined && pool.adapter.kind !== adapterKind) {
      return false
    }
    return true
  }).sort((left, right) =>
    left.poolDefinitionId < right.poolDefinitionId
      ? -1
      : left.poolDefinitionId > right.poolDefinitionId
        ? 1
        : 0,
  )
  return matches.length === 0 ? EMPTY_POOLS : Object.freeze(matches)
}

/** Return the active or historical native-to-wrapped relationship for a token. */
export function getNativeWrapDefinition(
  nativeTokenDeploymentId: string,
): NativeWrapDefinition | undefined {
  return typeof nativeTokenDeploymentId === 'string'
    ? wrapByNativeTokenId.get(nativeTokenDeploymentId)
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownChain(value: unknown): value is DexChainId {
  return typeof value === 'string' && knownChainIds.has(value)
}

function isEvmChain(chainId: string): boolean {
  return (
    chainId === DEX_CHAIN_IDS.ethereum ||
    chainId === DEX_CHAIN_IDS.avalancheC
  )
}

function normalizeEvmAddress(address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(address)) return undefined
  return address.toLowerCase()
}
