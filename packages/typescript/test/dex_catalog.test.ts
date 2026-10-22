import { describe, expect, it } from 'vitest'
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
  findPoolDefinitionByAddress,
  findPoolDefinitionsByPair,
  getDexDeployment,
  getNativeWrapDefinition,
  getPoolDefinition,
  listPoolDefinitions,
  pools,
  type DexChainId,
} from '../src'

const ETHEREUM_CHAIN_ID: DexChainId = DEX_CHAIN_IDS.ethereum
const SOLANA_CHAIN_ID: DexChainId = DEX_CHAIN_IDS.solana

describe('offline DEX catalog', () => {
  it('exports the generated metadata and chain-qualified aliases', () => {
    const typedEthereumChain: DexChainId = DEX_CHAIN_IDS.ethereum
    const typedDexAlias: string = dexes.ethereum.UNISWAP_V2
    const typedPoolAlias: string = pools.ethereum.UNISWAP_V2_USDC_WETH
    expect(typedEthereumChain).toBe('eip155:1')
    expect(typedDexAlias).toBe('dex-deployment-0001')
    expect(typedPoolAlias).toBe('pool-0001')
    expect(DEX_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/u)
    expect(DEX_CATALOG_AS_OF_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(DEX_CATALOG_CONTENT_DIGEST).toMatch(/^[0-9a-f]{64}$/u)
    expect(DEX_CHAIN_IDS).toEqual({
      ethereum: 'eip155:1',
      solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      avalancheC: 'eip155:43114',
    })
    expect(dexes.ethereum.UNISWAP_V2).toBe('dex-deployment-0001')
    expect(pools.ethereum.UNISWAP_V2_USDC_WETH).toBe('pool-0001')
    expect(dexes.avalancheC.LFJ_LEGACY).toBe('dex-deployment-0002')
    expect(pools.solana.ORCA_WHIRLPOOLS_WSOL_EURC).toBe('pool-0003')
    expect(Object.isFrozen(DEX_CHAIN_IDS)).toBe(true)
    expect(Object.isFrozen(DEX_DEPLOYMENTS)).toBe(true)
    expect(Object.isFrozen(POOL_DEFINITIONS)).toBe(true)
    expect(Object.isFrozen(NATIVE_WRAP_DEFINITIONS)).toBe(true)
    expect(Object.isFrozen(DEX_ALIASES)).toBe(true)
    expect(Object.isFrozen(dexes)).toBe(true)
    expect(Object.isFrozen(dexes.ethereum)).toBe(true)
    expect(Object.isFrozen(pools)).toBe(true)
    expect(Object.isFrozen(pools.solana)).toBe(true)

    const dexGroups = dexes as unknown as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
    const poolGroups = pools as unknown as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
    for (const alias of DEX_ALIASES) {
      const groups = alias.dexDeploymentId === null ? poolGroups : dexGroups
      const expected = alias.dexDeploymentId ?? alias.poolDefinitionId
      expect(groups[alias.namespace]?.[alias.name]).toBe(expected)
    }

    // Seed IDs remain stable public sentinels while generated arrays may grow.
    expect(dexes.ethereum.UNISWAP_V2).toBe('dex-deployment-0001')
    expect(dexes.avalancheC.LFJ_LEGACY).toBe('dex-deployment-0002')
    expect(pools.ethereum.UNISWAP_V2_USDC_WETH).toBe('pool-0001')
    expect(pools.avalancheC.LFJ_LEGACY_WAVAX_USDC).toBe('pool-0002')
  })

  it('resolves exact records, addresses, unordered pairs, and native wraps', () => {
    const ethereum = getDexDeployment('dex-deployment-0001')
    const ethereumPool = getPoolDefinition('pool-0001')
    expect(ethereum?.chainId).toBe(DEX_CHAIN_IDS.ethereum)
    expect(ethereumPool?.dexDeploymentId).toBe('dex-deployment-0001')
    expect(
      findPoolDefinitionByAddress(
        ETHEREUM_CHAIN_ID,
        '0xB4E16D0168E52D35CACD2C6185B44281EC28C9DC',
      )?.poolDefinitionId,
    ).toBe('pool-0001')
    const pairIds = (
      chainId: string,
      tokenADeploymentId: string,
      tokenBDeploymentId: string,
    ): string[] =>
      POOL_DEFINITIONS.filter(
        (pool) =>
          pool.chainId === chainId &&
          [pool.token0DeploymentId, pool.token1DeploymentId]
            .sort()
            .join('\u0000') ===
          [tokenADeploymentId, tokenBDeploymentId].sort().join('\u0000'),
      )
        .map(({ poolDefinitionId }) => poolDefinitionId)
        .sort()
    expect(
      findPoolDefinitionsByPair(
        ETHEREUM_CHAIN_ID,
        'deployment-0002',
        'deployment-0008',
      ).map(({ poolDefinitionId }) => poolDefinitionId),
    ).toEqual(pairIds(ETHEREUM_CHAIN_ID, 'deployment-0002', 'deployment-0008'))
    expect(
      findPoolDefinitionsByPair(
        SOLANA_CHAIN_ID,
        'deployment-0013',
        'deployment-0006',
      ).map(({ poolDefinitionId }) => poolDefinitionId),
    ).toEqual(pairIds(SOLANA_CHAIN_ID, 'deployment-0013', 'deployment-0006'))
    expect(getNativeWrapDefinition('deployment-0001')).toMatchObject({
      nativeWrapDefinitionId: 'native-wrap-0001',
      wrappedTokenDeploymentId: 'deployment-0002',
    })
    expect(getNativeWrapDefinition('native-wrap-0001')).toBeUndefined()
    expect(
      listPoolDefinitions({
        chainId: SOLANA_CHAIN_ID,
        tokenDeploymentId: 'deployment-0006',
      }).map(({ poolDefinitionId }) => poolDefinitionId),
    ).toEqual(
      POOL_DEFINITIONS.filter(
        ({ chainId, token0DeploymentId, token1DeploymentId }) =>
          chainId === SOLANA_CHAIN_ID &&
          [token0DeploymentId, token1DeploymentId].includes('deployment-0006'),
      )
        .map(({ poolDefinitionId }) => poolDefinitionId)
        .sort(),
    )
    expect(
      listPoolDefinitions({ adapterKind: 'evm-constant-product-v2' }).map(
        ({ poolDefinitionId }) => poolDefinitionId,
      ),
    ).toEqual(
      POOL_DEFINITIONS.filter(
        ({ adapter }) => adapter.kind === 'evm-constant-product-v2',
      )
        .map(({ poolDefinitionId }) => poolDefinitionId)
        .sort(),
    )
  })

  it('returns immutable records and safe empty results for invalid lookups', () => {
    const pool = getPoolDefinition('pool-0001')
    expect(pool).toBeDefined()
    if (!pool) return
    expect(Object.isFrozen(pool)).toBe(true)
    expect(Object.isFrozen(pool.adapter)).toBe(true)
    expect(() => {
      ;(pool as { status: string }).status = 'retired'
    }).toThrow()
    expect(getPoolDefinition('pool-0001')?.status).toBe('active')
    expect(getDexDeployment('dex-deployment-0001:extra')).toBeUndefined()
    expect(
      findPoolDefinitionByAddress('unknown:chain', 'not-an-address'),
    ).toBeUndefined()
    expect(
      findPoolDefinitionsByPair(
        'unknown:chain',
        'deployment-0002',
        'deployment-0008',
      ),
    ).toEqual([])
    expect(listPoolDefinitions(null as never)).toEqual([])
    expect(listPoolDefinitions([] as never)).toEqual([])
  })
})
