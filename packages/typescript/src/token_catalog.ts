import {
  TOKEN_ALIASES,
  TOKEN_ASSETS,
  TOKEN_CATALOG_AS_OF_DATE,
  TOKEN_CATALOG_CONTENT_DIGEST,
  TOKEN_CATALOG_VERSION,
  TOKEN_CHAIN_IDS,
  TOKEN_DEPLOYMENTS,
  tokens,
} from './generated/token_catalog'
import type {
  TokenAlias,
  TokenAsset,
  TokenChainId,
  TokenDeployment,
  TokenRepresentationKind,
  TokenStandard,
  TokenStatus,
} from './generated/token_catalog'

export {
  TOKEN_ALIASES,
  TOKEN_ASSETS,
  TOKEN_CATALOG_AS_OF_DATE,
  TOKEN_CATALOG_CONTENT_DIGEST,
  TOKEN_CATALOG_VERSION,
  TOKEN_CHAIN_IDS,
  TOKEN_DEPLOYMENTS,
  tokens,
}

export type {
  TokenAlias,
  TokenAsset,
  TokenChainId,
  TokenDeployment,
  TokenRepresentationKind,
  TokenStandard,
  TokenStatus,
}

/** Stable currencies represented by the catalog's stablecoin metadata. */
export type StableCurrency = 'USD' | 'EUR' | 'JPY'

export interface ListTokenDeploymentsOptions {
  readonly chainId?: TokenChainId
  readonly stableCurrency?: StableCurrency
}

const EMPTY_DEPLOYMENTS: readonly TokenDeployment[] = Object.freeze([])

const assetsById = new Map<string, TokenAsset>(
  TOKEN_ASSETS.map((asset) => [asset.assetId, asset]),
)

const deploymentsById = new Map<string, TokenDeployment>(
  TOKEN_DEPLOYMENTS.map((deployment) => [deployment.deploymentId, deployment]),
)

const deploymentsBySymbol = new Map<string, readonly TokenDeployment[]>()
for (const deployment of TOKEN_DEPLOYMENTS) {
  const key = `${deployment.chainId}\u0000${deployment.symbol}`
  const existing = deploymentsBySymbol.get(key)
  if (existing) {
    deploymentsBySymbol.set(key, [...existing, deployment])
  } else {
    deploymentsBySymbol.set(key, [deployment])
  }
}

for (const [key, deployments] of deploymentsBySymbol) {
  deploymentsBySymbol.set(
    key,
    Object.freeze(
      [...deployments].sort((left, right) =>
        left.deploymentId < right.deploymentId
          ? -1
          : left.deploymentId > right.deploymentId
            ? 1
            : 0,
      ),
    ),
  )
}

const deploymentsByAddress = new Map<string, TokenDeployment>()
for (const deployment of TOKEN_DEPLOYMENTS) {
  if (deployment.address === null || deployment.address === '') continue

  const normalizedAddress = isEvmChain(deployment.chainId)
    ? normalizeEvmAddress(deployment.address)
    : deployment.address
  if (normalizedAddress === undefined || isZeroEvmAddress(normalizedAddress)) {
    continue
  }

  const key = `${deployment.chainId}\u0000${normalizedAddress}`
  if (!deploymentsByAddress.has(key)) {
    deploymentsByAddress.set(key, deployment)
  }
}

/**
 * Return an asset by its opaque, exact asset ID.
 *
 * IDs are intentionally treated as opaque strings. No chain or symbol is
 * inferred from the value.
 */
export function getTokenAsset(assetId: string): TokenAsset | undefined {
  return typeof assetId === 'string' ? assetsById.get(assetId) : undefined
}

/** Return a deployment by its opaque, exact deployment ID. */
export function getTokenDeployment(
  deploymentId: string,
): TokenDeployment | undefined {
  return typeof deploymentId === 'string'
    ? deploymentsById.get(deploymentId)
    : undefined
}

/**
 * List all catalog deployments, optionally restricted by chain and stable
 * currency. Every status remains visible in the result.
 */
export function listTokenDeployments(
  options: ListTokenDeploymentsOptions = {},
): readonly TokenDeployment[] {
  if (!isRecord(options)) return EMPTY_DEPLOYMENTS

  const { chainId, stableCurrency } = options
  if (chainId !== undefined && !isKnownChainId(chainId)) {
    return EMPTY_DEPLOYMENTS
  }
  if (
    stableCurrency !== undefined &&
    !isStableCurrency(stableCurrency)
  ) {
    return EMPTY_DEPLOYMENTS
  }

  const filtered = TOKEN_DEPLOYMENTS.filter((deployment) => {
    if (chainId !== undefined && deployment.chainId !== chainId) return false
    if (
      stableCurrency !== undefined &&
      deployment.stableCurrency !== stableCurrency
    ) {
      return false
    }
    return true
  })

  return filtered.length === 0 ? EMPTY_DEPLOYMENTS : Object.freeze(filtered)
}

/**
 * Find every exact-case symbol match on a chain, ordered by deployment ID.
 */
export function findTokenDeploymentsBySymbol(
  chainId: TokenChainId,
  symbol: string,
): readonly TokenDeployment[] {
  if (
    !isKnownChainId(chainId) ||
    typeof symbol !== 'string' ||
    symbol.length === 0
  ) {
    return EMPTY_DEPLOYMENTS
  }

  return (
    deploymentsBySymbol.get(`${chainId}\u0000${symbol}`) ?? EMPTY_DEPLOYMENTS
  )
}

/**
 * Find a deployment by address. EVM addresses are ASCII hex and are matched
 * case-insensitively; Solana addresses are matched byte-for-byte as strings.
 */
export function findTokenDeploymentByAddress(
  chainId: TokenChainId,
  address: string,
): TokenDeployment | undefined {
  if (!isKnownChainId(chainId) || typeof address !== 'string') return undefined
  if (address.length === 0) return undefined

  const normalizedAddress = isEvmChain(chainId)
    ? normalizeEvmAddress(address)
    : address
  if (
    normalizedAddress === undefined ||
    (isEvmChain(chainId) && isZeroEvmAddress(normalizedAddress))
  ) {
    return undefined
  }

  return deploymentsByAddress.get(`${chainId}\u0000${normalizedAddress}`)
}

/** Find the chain's native deployment. Native deployments use address null. */
export function getNativeTokenDeployment(
  chainId: TokenChainId,
): TokenDeployment | undefined {
  if (!isKnownChainId(chainId)) return undefined

  return TOKEN_DEPLOYMENTS.find(
    (deployment) =>
      deployment.chainId === chainId &&
      deployment.standard === 'native' &&
      deployment.address === null,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownChainId(value: unknown): value is TokenChainId {
  return (
    value === TOKEN_CHAIN_IDS.ethereumMainnet ||
    value === TOKEN_CHAIN_IDS.solanaMainnet ||
    value === TOKEN_CHAIN_IDS.avalancheCMainnet ||
    value === TOKEN_CHAIN_IDS.baseMainnet
  )
}

function isStableCurrency(value: unknown): value is StableCurrency {
  return value === 'USD' || value === 'EUR' || value === 'JPY'
}

function isEvmChain(chainId: string): boolean {
  return (
    chainId === TOKEN_CHAIN_IDS.ethereumMainnet ||
    chainId === TOKEN_CHAIN_IDS.avalancheCMainnet ||
    chainId === TOKEN_CHAIN_IDS.baseMainnet
  )
}

function normalizeEvmAddress(address: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined
  return address.toLowerCase()
}

function isZeroEvmAddress(address: string): boolean {
  return address === `0x${'0'.repeat(40)}`
}
