import {
  TOKEN_RANKINGS,
  TOKEN_RANKINGS_BY_CHAIN,
  TOKEN_RANKINGS_CONTENT_DIGEST,
  TOKEN_RANKINGS_METADATA,
} from './generated/token_rankings'
import type {
  TokenRanking,
  TokenRankingCoverage,
  TokenRankingMetadata,
  TokenRankingMetric,
  TokenRankingStatus,
} from './generated/token_rankings'

export {
  TOKEN_RANKINGS,
  TOKEN_RANKINGS_BY_CHAIN,
  TOKEN_RANKINGS_CONTENT_DIGEST,
  TOKEN_RANKINGS_METADATA,
}

export type {
  TokenRanking,
  TokenRankingCoverage,
  TokenRankingMetadata,
  TokenRankingMetric,
  TokenRankingStatus,
}

const EMPTY_RANKINGS: readonly TokenRanking[] = Object.freeze([])

/**
 * Return the bundled token rankings for an exact chain ID.
 *
 * Rankings are an offline snapshot. An unknown or empty chain ID is a safe,
 * immutable empty result; no chain aliases or network lookups are inferred.
 */
export function listTokenRankings(chainId: string): readonly TokenRanking[] {
  if (typeof chainId !== 'string' || chainId.length === 0) {
    return EMPTY_RANKINGS
  }
  return Object.hasOwn(TOKEN_RANKINGS_BY_CHAIN, chainId)
    ? TOKEN_RANKINGS_BY_CHAIN[chainId] ?? EMPTY_RANKINGS
    : EMPTY_RANKINGS
}
