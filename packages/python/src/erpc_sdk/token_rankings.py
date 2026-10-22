"""Offline token ranking snapshot lookups.

The generated records are a static snapshot from the canonical registry.
Ranking reads do not require a client, API key, network request, or current
clock and therefore remain deterministic in an installed package.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, Literal, TypeAlias, cast

from ._token_rankings_data import (
    TOKEN_RANKINGS,
    TOKEN_RANKINGS_CONTENT_DIGEST,
    TOKEN_RANKINGS_METADATA,
    TokenRanking,
    TokenRankingCoverage,
    TokenRankingMetadata,
)

TokenRankingMetric: TypeAlias = Literal[
    "onchain-total-supply-value-native",
    "global-circulating-market-cap-usd",
]
TokenRankingStatus: TypeAlias = Literal["unconfigured", "complete", "partial"]

TOKEN_RANKINGS_SCHEMA_VERSION: Final[int] = TOKEN_RANKINGS_METADATA.schema_version
TOKEN_RANKINGS_METRIC: Final[str | None] = TOKEN_RANKINGS_METADATA.metric
TOKEN_RANKINGS_AS_OF: Final[str | None] = TOKEN_RANKINGS_METADATA.as_of
TOKEN_RANKINGS_STATUS: Final[str] = TOKEN_RANKINGS_METADATA.status
TOKEN_RANKINGS_COVERAGE = TOKEN_RANKINGS_METADATA.coverage
TOKEN_RANKINGS_SOURCE_IDS = TOKEN_RANKINGS_METADATA.source_ids

_EMPTY_RANKINGS: Final[tuple[TokenRanking, ...]] = ()
_rankings_by_chain: dict[str, list[TokenRanking]] = {}
for _ranking in cast(tuple[TokenRanking, ...], TOKEN_RANKINGS):
    _rankings_by_chain.setdefault(_ranking.chain_id, []).append(_ranking)
_RANKINGS_BY_CHAIN: Final[Mapping[str, tuple[TokenRanking, ...]]] = MappingProxyType(
    {chain_id: tuple(rows) for chain_id, rows in _rankings_by_chain.items()}
)
TOKEN_RANKINGS_BY_CHAIN = _RANKINGS_BY_CHAIN


def list_token_rankings(chain_id: object) -> tuple[TokenRanking, ...]:
    """Return immutable ranking rows for one exact chain ID.

    Empty, unknown, and special string inputs produce the same immutable empty
    tuple. No aliases, network lookups, or time-based filtering are inferred.
    """

    if not isinstance(chain_id, str) or not chain_id:
        return _EMPTY_RANKINGS
    return _RANKINGS_BY_CHAIN.get(chain_id, _EMPTY_RANKINGS)


__all__ = [
    "TOKEN_RANKINGS",
    "TOKEN_RANKINGS_AS_OF",
    "TOKEN_RANKINGS_BY_CHAIN",
    "TOKEN_RANKINGS_CONTENT_DIGEST",
    "TOKEN_RANKINGS_COVERAGE",
    "TOKEN_RANKINGS_METADATA",
    "TOKEN_RANKINGS_METRIC",
    "TOKEN_RANKINGS_SCHEMA_VERSION",
    "TOKEN_RANKINGS_SOURCE_IDS",
    "TOKEN_RANKINGS_STATUS",
    "TokenRanking",
    "TokenRankingCoverage",
    "TokenRankingMetadata",
    "TokenRankingMetric",
    "TokenRankingStatus",
    "list_token_rankings",
]
