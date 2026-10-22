import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOKEN_CHAIN_IDS,
  TOKEN_RANKINGS,
  TOKEN_RANKINGS_BY_CHAIN,
  TOKEN_RANKINGS_CONTENT_DIGEST,
  TOKEN_RANKINGS_METADATA,
  listTokenRankings,
  type TokenRanking,
} from '../src'

interface CaptureRecord {
  readonly [key: string]: unknown
}

interface CaptureSdk {
  readonly TOKEN_CHAIN_IDS: Readonly<Record<string, string>>
  readonly TOKEN_RANKINGS_METADATA: CaptureRecord
  readonly TOKEN_RANKINGS: readonly CaptureRecord[]
  readonly listTokenRankings: (chainId: string) => readonly CaptureRecord[]
}

const RANKING_CHAINS = [
  TOKEN_CHAIN_IDS.ethereumMainnet,
  TOKEN_CHAIN_IDS.solanaMainnet,
  TOKEN_CHAIN_IDS.avalancheCMainnet,
] as const
const BASE_CHAIN_ID = (TOKEN_CHAIN_IDS as unknown as Record<string, string>)
  .baseMainnet

const jsonClone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T

const sourceCaptureSdk = (): CaptureSdk => ({
  TOKEN_CHAIN_IDS,
  TOKEN_RANKINGS_METADATA: TOKEN_RANKINGS_METADATA as unknown as CaptureRecord,
  TOKEN_RANKINGS: TOKEN_RANKINGS as unknown as readonly CaptureRecord[],
  listTokenRankings: listTokenRankings as unknown as (
    chainId: string,
  ) => readonly CaptureRecord[],
})

const loadCaptureSdk = async (): Promise<CaptureSdk> => {
  const captureRequested =
    process.env.ERPC_SDK_RANKING_PARITY_OUTPUT !== undefined ||
    process.env.ERPC_SDK_RANKING_PARITY_PACKAGE === 'dist'
  if (!captureRequested) return sourceCaptureSdk()
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href
  return (await import(moduleUrl)) as unknown as CaptureSdk
}

describe('offline token rankings', () => {
  it('exports exact metadata and immutable generated rows', () => {
    expect(Object.keys(TOKEN_RANKINGS_METADATA).sort()).toEqual([
      'asOf',
      'contentDigest',
      'coverage',
      'metric',
      'schemaVersion',
      'sourceIds',
      'status',
    ])
    expect(TOKEN_RANKINGS_METADATA.schemaVersion).toBe(1)
    expect(TOKEN_RANKINGS_METADATA.metric === null || typeof TOKEN_RANKINGS_METADATA.metric === 'string').toBe(true)
    expect(TOKEN_RANKINGS_METADATA.asOf === null || typeof TOKEN_RANKINGS_METADATA.asOf === 'string').toBe(true)
    expect(TOKEN_RANKINGS_METADATA.contentDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(TOKEN_RANKINGS_CONTENT_DIGEST).toBe(
      TOKEN_RANKINGS_METADATA.contentDigest,
    )
    expect(['unconfigured', 'complete', 'partial']).toContain(
      TOKEN_RANKINGS_METADATA.status,
    )
    expect(Object.isFrozen(TOKEN_RANKINGS_METADATA)).toBe(true)
    expect(Object.isFrozen(TOKEN_RANKINGS_METADATA.coverage)).toBe(true)
    expect(Object.isFrozen(TOKEN_RANKINGS_METADATA.sourceIds)).toBe(true)
    expect(Object.isFrozen(TOKEN_RANKINGS)).toBe(true)
    expect(Object.isFrozen(TOKEN_RANKINGS_BY_CHAIN)).toBe(true)

    for (const coverage of TOKEN_RANKINGS_METADATA.coverage) {
      expect(Object.isFrozen(coverage)).toBe(true)
    }
    for (const ranking of TOKEN_RANKINGS) {
      expect(Object.isFrozen(ranking)).toBe(true)
      expect(Object.isFrozen(ranking.deploymentIds)).toBe(true)
      expect(ranking.rank).toBeGreaterThan(0)
      expect(ranking.valueNumerator).toMatch(/^(0|[1-9][0-9]*)$/u)
      expect(ranking.valueDenominator).toMatch(/^[1-9][0-9]*$/u)
    }

    expect(TOKEN_RANKINGS_METADATA.coverage.map(({ chainId }) => chainId)).toEqual(
      expect.arrayContaining([...RANKING_CHAINS]),
    )
    expect(TOKEN_RANKINGS_METADATA.coverage.map(({ chainId }) => chainId)).not.toContain(
      BASE_CHAIN_ID,
    )

    for (const chainId of RANKING_CHAINS) {
      expect(listTokenRankings(chainId)).toBe(
        TOKEN_RANKINGS_BY_CHAIN[chainId] ?? listTokenRankings(''),
      )
    }
  })

  it('runs unknown and empty chain queries as immutable empty lookups', () => {
    const empty = listTokenRankings('')
    const unknown = listTokenRankings('unknown:chain')
    expect(empty).toEqual([])
    expect(unknown).toEqual([])
    expect(Object.isFrozen(empty)).toBe(true)
    expect(Object.isFrozen(unknown)).toBe(true)
    for (const key of ['constructor', 'toString', '__proto__']) {
      const result = listTokenRankings(key)
      expect(result).toEqual([])
      expect(Object.isFrozen(result)).toBe(true)
    }
    expect(listTokenRankings(null as never)).toEqual([])
  })

  it('captures ranking parity from the public built package when requested', async () => {
    const outputPath = process.env.ERPC_SDK_RANKING_PARITY_OUTPUT
    if (!outputPath) return

    const sdk = await loadCaptureSdk()
    const behaviorInputs = [
      ...RANKING_CHAINS,
      '',
      'unknown:chain',
      'constructor',
      'toString',
      '__proto__',
    ]
    const behavior = Object.fromEntries(
      behaviorInputs.map((chainId) => [
        chainId,
        jsonClone(sdk.listTokenRankings(chainId)),
      ]),
    )
    const snapshot = {
      snapshotVersion: 1,
      snapshotKind: 'native-runtime',
      language: 'typescript',
      runtime:
        process.env.ERPC_SDK_RANKING_PARITY_OUTPUT !== undefined ||
        process.env.ERPC_SDK_RANKING_PARITY_PACKAGE === 'dist'
          ? `typescript-built-dist-${process.version}`
          : `typescript-source-${process.version}`,
      metadata: jsonClone(sdk.TOKEN_RANKINGS_METADATA),
      records: jsonClone(sdk.TOKEN_RANKINGS),
      behavior,
    }

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(`${outputPath}`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    expect((await readFile(outputPath, 'utf8')).length).toBeGreaterThan(0)
  })
})

// Keep the public row type exercised by this package test as the generated
// schema grows; this assertion does not depend on a particular snapshot size.
const _tokenRankingTypeCheck: TokenRanking | undefined = TOKEN_RANKINGS.find(
  (ranking) => ranking.rank === 1,
)
void _tokenRankingTypeCheck
