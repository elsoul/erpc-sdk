import { describe, expect, it } from 'vitest'
import {
  findTokenDeploymentByAddress,
  findTokenDeploymentsBySymbol,
  getNativeTokenDeployment,
  getTokenAsset,
  getTokenDeployment,
  listTokenDeployments,
  TOKEN_ALIASES,
  TOKEN_ASSETS,
  TOKEN_CATALOG_AS_OF_DATE,
  TOKEN_CATALOG_CONTENT_DIGEST,
  TOKEN_CATALOG_VERSION,
  TOKEN_CHAIN_IDS,
  TOKEN_DEPLOYMENTS,
  tokens,
  type TokenChainId,
  type TokenDeployment,
} from '../src'

const chains = [
  TOKEN_CHAIN_IDS.ethereumMainnet,
  TOKEN_CHAIN_IDS.solanaMainnet,
  TOKEN_CHAIN_IDS.avalancheCMainnet,
  (TOKEN_CHAIN_IDS as unknown as Record<string, string>).baseMainnet as TokenChainId,
] as const
const baseChainId = chains[3]
const baseTokens = (tokens as unknown as Record<
  string,
  Readonly<Record<string, string>>
>).base ?? {}

describe('offline token catalog', () => {
  it('exports the generated chain IDs and immutable grouped aliases', () => {
    expect(TOKEN_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u)
    expect(TOKEN_CATALOG_AS_OF_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(TOKEN_CATALOG_CONTENT_DIGEST).toMatch(/^[0-9a-f]{64}$/u)
    expect(TOKEN_CHAIN_IDS).toEqual({
      ethereumMainnet: 'eip155:1',
      solanaMainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      avalancheCMainnet: 'eip155:43114',
      baseMainnet: 'eip155:8453',
    })
    expect(Object.isFrozen(TOKEN_CHAIN_IDS)).toBe(true)
    expect(Object.isFrozen(TOKEN_ALIASES)).toBe(true)
    expect(Object.isFrozen(tokens)).toBe(true)
    expect(Object.isFrozen(tokens.ethereum)).toBe(true)
    expect(Object.isFrozen(tokens.solana)).toBe(true)
    expect(Object.isFrozen(tokens.avalancheC)).toBe(true)
    expect(Object.isFrozen(baseTokens)).toBe(true)

    const tokenGroups = tokens as unknown as Record<
      string,
      Readonly<Record<string, string>>
    >
    for (const alias of TOKEN_ALIASES) {
      const deploymentId = tokenGroups[alias.namespace]?.[alias.name]
      expect(alias.name.length).toBeGreaterThan(0)
      expect(deploymentId).toBe(alias.deploymentId)
      expect(getTokenDeployment(alias.deploymentId)).toBeDefined()
    }

    // Seed IDs are compatibility sentinels; future catalog rows may precede
    // them in the generated arrays without changing these public constants.
    expect(tokens.ethereum.ETH).toBe('deployment-0001')
    expect(tokens.ethereum.WETH).toBe('deployment-0002')
    expect(tokens.avalancheC.AVAX).toBe('deployment-0003')
    expect(tokens.avalancheC.WAVAX).toBe('deployment-0004')
    expect(tokens.solana.SOL).toBe('deployment-0005')
    expect(tokens.solana.WSOL).toBe('deployment-0006')
    expect(tokens.ethereum.USDC).toBe('deployment-0008')
    expect(tokens.avalancheC.USDC).toBe('deployment-0009')
    expect(baseTokens).toEqual({
      ETH: 'deployment-0061',
      EURC: 'deployment-0063',
      USDC: 'deployment-0062',
    })
  })

  it('cross-links every deployment to a complete flattened asset record', () => {
    expect(TOKEN_ASSETS).toHaveLength(49)
    expect(TOKEN_DEPLOYMENTS).toHaveLength(73)
    expect(TOKEN_ALIASES).toHaveLength(73)
    expect(TOKEN_ASSETS.length).toBeGreaterThan(0)
    expect(TOKEN_DEPLOYMENTS.length).toBeGreaterThan(0)

    for (const asset of TOKEN_ASSETS) {
      expect(getTokenAsset(asset.assetId)).toBe(asset)
      expect(Object.isFrozen(asset)).toBe(true)
      expect(asset).not.toHaveProperty('evidence')
      expect(asset).not.toHaveProperty('asOfDate')
    }

    for (const deployment of TOKEN_DEPLOYMENTS) {
      const asset = getTokenAsset(deployment.assetId)
      expect(asset).toBeDefined()
      expect(getTokenDeployment(deployment.deploymentId)).toBe(deployment)
      expect(Object.isFrozen(deployment)).toBe(true)
      if (!asset) continue

      expect(deployment).not.toHaveProperty('evidence')
      expect(deployment).not.toHaveProperty('asOfDate')
      expect(deployment.name).toBe(asset.name)
      expect(deployment.representationKind).toBe(asset.representationKind)
      expect(deployment.stableCurrency).toBe(asset.stableCurrency)
      expect(deployment.underlyingAssetId).toBe(asset.underlyingAssetId)
      expect(deployment.economicReferenceAssetId).toBe(
        asset.economicReferenceAssetId,
      )
      if (deployment.underlyingAssetId !== null) {
        expect(getTokenAsset(deployment.underlyingAssetId)).toBeDefined()
      }
      if (deployment.economicReferenceAssetId !== null) {
        expect(
          getTokenAsset(deployment.economicReferenceAssetId),
        ).toBeDefined()
      }
      if (deployment.replacedByDeploymentId !== null) {
        expect(
          getTokenDeployment(deployment.replacedByDeploymentId),
        ).toBeDefined()
      }
    }

    for (const alias of TOKEN_ALIASES) {
      expect(getTokenDeployment(alias.deploymentId)?.deploymentId).toBe(
        alias.deploymentId,
      )
    }
  })

  it('finds duplicate Ethereum EURe deployments and all Solana WSOL standards', () => {
    const euRe = findTokenDeploymentsBySymbol(
      TOKEN_CHAIN_IDS.ethereumMainnet,
      'EURe',
    )
    expect(euRe.length).toBeGreaterThanOrEqual(2)
    expect(euRe.map(({ deploymentId }) => deploymentId)).toEqual(
      [...euRe]
        .map(({ deploymentId }) => deploymentId)
        .sort(),
    )
    expect(new Set(euRe.map(({ deploymentId }) => deploymentId)).size).toBe(
      euRe.length,
    )

    const wsol = findTokenDeploymentsBySymbol(
      TOKEN_CHAIN_IDS.solanaMainnet,
      'WSOL',
    )
    expect(wsol.map(({ standard }) => standard)).toEqual(
      expect.arrayContaining(['spl-token', 'spl-token-2022']),
    )
    expect(wsol.every(({ chainId }) => chainId === TOKEN_CHAIN_IDS.solanaMainnet)).toBe(
      true,
    )
  })

  it('keeps USDC chain-qualified and preserves EURCV asset identity across decimals', () => {
    const usdcByChain = chains.map((chainId) =>
      findTokenDeploymentsBySymbol(chainId, 'USDC'),
    )
    expect(usdcByChain.every((matches) => matches.length > 0)).toBe(true)
    expect(
      usdcByChain.flat().every(({ symbol }) => symbol === 'USDC'),
    ).toBe(true)

    const eurcvEthereum = findTokenDeploymentsBySymbol(
      TOKEN_CHAIN_IDS.ethereumMainnet,
      'EURCV',
    ).find(({ decimals }) => decimals === 18)
    const eurcvSolana = findTokenDeploymentsBySymbol(
      TOKEN_CHAIN_IDS.solanaMainnet,
      'EURCV',
    ).find(({ decimals }) => decimals === 2)
    expect(eurcvEthereum).toBeDefined()
    expect(eurcvSolana).toBeDefined()
    expect(eurcvEthereum?.assetId).toBe(eurcvSolana?.assetId)
  })

  it('includes the three Base records with native and mixed-case EVM lookups', () => {
    const baseChain = baseChainId
    const baseEth = getTokenDeployment(baseTokens.ETH ?? '')
    const baseUsdc = getTokenDeployment(baseTokens.USDC ?? '')
    const baseEurc = getTokenDeployment(baseTokens.EURC ?? '')

    expect(baseEth).toMatchObject({
      deploymentId: 'deployment-0061',
      assetId: 'asset-0001',
      chainId: baseChain,
      symbol: 'ETH',
      decimals: 18,
      standard: 'native',
      address: null,
      status: 'active',
    })
    expect(baseUsdc).toMatchObject({
      deploymentId: 'deployment-0062',
      assetId: 'asset-0007',
      chainId: baseChain,
      symbol: 'USDC',
      decimals: 6,
      standard: 'erc20',
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      status: 'active',
    })
    expect(baseEurc).toMatchObject({
      deploymentId: 'deployment-0063',
      assetId: 'asset-0008',
      chainId: baseChain,
      symbol: 'EURC',
      decimals: 6,
      standard: 'erc20',
      address: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
      status: 'active',
    })
    expect(getNativeTokenDeployment(baseChain)).toBe(baseEth)
    expect(findTokenDeploymentsBySymbol(baseChain, 'ETH')).toEqual([baseEth])
    expect(findTokenDeploymentsBySymbol(baseChain, 'USDC')).toEqual([baseUsdc])
    expect(findTokenDeploymentsBySymbol(baseChain, 'EURC')).toEqual([baseEurc])
    expect(
      findTokenDeploymentByAddress(
        baseChain,
        '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
      ),
    ).toBe(baseUsdc)
    expect(
      findTokenDeploymentByAddress(
        baseChain,
        '0x60A3E35CC302BFA44CB288BC5A4F316FDB1ADB42',
      ),
    ).toBe(baseEurc)
    expect(findTokenDeploymentByAddress(baseChain, '0x' + '0'.repeat(40))).toBeUndefined()
  })

  it('includes every lifecycle and representation kind, including natives', () => {
    const all = listTokenDeployments()
    expect(all.length).toBe(TOKEN_DEPLOYMENTS.length)
    expect(all.map(({ status }) => status)).toEqual(
      expect.arrayContaining(['active', 'legacy', 'winding-down', 'retired']),
    )
    expect(all.map(({ representationKind }) => representationKind)).toEqual(
      expect.arrayContaining(['native', 'wrapped', 'bridged']),
    )

    for (const chainId of chains) {
      const native = getNativeTokenDeployment(chainId)
      expect(native).toBeDefined()
      expect(native?.chainId).toBe(chainId)
      expect(native?.standard).toBe('native')
      expect(native?.address).toBeNull()
      expect(findTokenDeploymentByAddress(chainId, '')).toBeUndefined()
      expect(findTokenDeploymentByAddress(chainId, null as never)).toBeUndefined()
    }
  })

  it('filters stable currency without hiding lifecycle records', () => {
    for (const currency of ['USD', 'EUR', 'JPY'] as const) {
      const filtered = listTokenDeployments({ stableCurrency: currency })
      expect(Object.isFrozen(filtered)).toBe(true)
      expect(filtered.length).toBeGreaterThan(0)
      expect(filtered.every(({ stableCurrency }) => stableCurrency === currency)).toBe(
        true,
      )
    }
    const solanaEur = listTokenDeployments({
      chainId: TOKEN_CHAIN_IDS.solanaMainnet,
      stableCurrency: 'EUR',
    })
    expect(solanaEur.length).toBeGreaterThan(0)
    expect(
      solanaEur.every(
        ({ chainId, stableCurrency }) =>
          chainId === TOKEN_CHAIN_IDS.solanaMainnet && stableCurrency === 'EUR',
      ),
    ).toBe(true)
    expect(listTokenDeployments({ stableCurrency: 'GBP' as never })).toEqual([])
    expect(listTokenDeployments(null as never)).toEqual([])
    expect(listTokenDeployments([] as never)).toEqual([])
  })

  it('uses exact opaque IDs, exact symbol case, and strict address rules', () => {
    const first = TOKEN_DEPLOYMENTS.find(
      ({ deploymentId }) => deploymentId === tokens.ethereum.ETH,
    )
    expect(first).toBeDefined()
    if (!first) return

    expect(getTokenAsset(`${first.assetId}:extra`)).toBeUndefined()
    expect(getTokenDeployment(`${first.deploymentId}:extra`)).toBeUndefined()
    expect(
      findTokenDeploymentsBySymbol(TOKEN_CHAIN_IDS.ethereumMainnet, 'usdc'),
    ).toEqual([])
    expect(findTokenDeploymentsBySymbol(first.chainId, '')).toEqual([])
    expect(findTokenDeploymentsBySymbol('eip155:999' as TokenChainId, first.symbol)).toEqual(
      [],
    )

    const evm = TOKEN_DEPLOYMENTS.find(
      (deployment) =>
        deployment.chainId === TOKEN_CHAIN_IDS.ethereumMainnet &&
        typeof deployment.address === 'string',
    )
    if (evm && evm.address) {
      expect(
        findTokenDeploymentByAddress(
          evm.chainId,
          evm.address.toUpperCase().replace(/^0X/, '0x'),
        ),
      ).toBe(evm)
      expect(
        findTokenDeploymentByAddress(evm.chainId, '0x1234'),
      ).toBeUndefined()
      expect(
        findTokenDeploymentByAddress(
          evm.chainId,
          `0x${'0'.repeat(40)}`,
        ),
      ).toBeUndefined()
    }

    const solana = TOKEN_DEPLOYMENTS.find(
      (deployment) =>
        deployment.chainId === TOKEN_CHAIN_IDS.solanaMainnet &&
        typeof deployment.address === 'string' &&
        deployment.address.length > 0,
    )
    if (solana && solana.address) {
      expect(
        findTokenDeploymentByAddress(solana.chainId, solana.address),
      ).toBe(solana)
      expect(
        findTokenDeploymentByAddress(
          solana.chainId,
          `${solana.address.slice(0, -1)}${
            solana.address.endsWith('1') ? '2' : '1'
          }`,
        ),
      ).toBeUndefined()
    }
  })

  it('keeps exported and returned data immutable across lookups', () => {
    const listed = listTokenDeployments()
    expect(Object.isFrozen(TOKEN_ASSETS)).toBe(true)
    expect(Object.isFrozen(TOKEN_DEPLOYMENTS)).toBe(true)
    expect(Object.isFrozen(listed)).toBe(true)

    const first = listed.find(
      ({ deploymentId }) => deploymentId === tokens.ethereum.ETH,
    )
    expect(first).toBeDefined()
    if (!first) return

    expect(() => (listed as TokenDeployment[]).pop()).toThrow()
    expect(() => {
      ;(first as { symbol: string }).symbol = 'MUTATED'
    }).toThrow()
    expect(getTokenDeployment(first.deploymentId)?.symbol).toBe(first.symbol)
  })

  it('performs catalog reads without touching fetch or client configuration', () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('token catalog must remain offline')
    }) as typeof fetch

    try {
      const first = TOKEN_DEPLOYMENTS.find(
        ({ deploymentId }) => deploymentId === tokens.ethereum.ETH,
      )
      expect(first).toBeDefined()
      if (first) {
        expect(getTokenAsset(first.assetId)).toBeDefined()
        expect(getTokenDeployment(first.deploymentId)).toBeDefined()
        expect(listTokenDeployments({ chainId: first.chainId })).not.toEqual([])
      }
      expect(getNativeTokenDeployment(TOKEN_CHAIN_IDS.ethereumMainnet)).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchCalls).toBe(0)
  })
})
