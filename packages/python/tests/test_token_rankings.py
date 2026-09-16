from __future__ import annotations

import json
import os
import platform
import re
import sys
from collections.abc import Mapping
from math import gcd
from pathlib import Path
from typing import Any

import pytest

import erpc_sdk
from erpc_sdk import (
    TOKEN_CHAIN_IDS,
    TOKEN_RANKINGS,
    TOKEN_RANKINGS_AS_OF,
    TOKEN_RANKINGS_BY_CHAIN,
    TOKEN_RANKINGS_CONTENT_DIGEST,
    TOKEN_RANKINGS_COVERAGE,
    TOKEN_RANKINGS_METADATA,
    TOKEN_RANKINGS_METRIC,
    TOKEN_RANKINGS_SCHEMA_VERSION,
    TOKEN_RANKINGS_SOURCE_IDS,
    TOKEN_RANKINGS_STATUS,
    TokenRanking,
    TokenRankingCoverage,
    TokenRankingMetadata,
    list_token_rankings,
)

_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
_NONNEGATIVE_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)$")
_POSITIVE_DECIMAL = re.compile(r"^[1-9][0-9]*$")
_RANKING_FIELDS = (
    "rank",
    "chain_id",
    "deployment_ids",
    "metric",
    "value_numerator",
    "value_denominator",
    "quote_currency",
    "quote_deployment_id",
    "observed_at",
    "source_id",
    "source_asset_id",
)
_METADATA_FIELDS = (
    "schema_version",
    "metric",
    "as_of",
    "content_digest",
    "status",
    "coverage",
    "source_ids",
)
_COVERAGE_FIELDS = (
    "chain_id",
    "total_deployments",
    "ranked_deployments",
    "unranked_deployments",
    "observed_at",
)
_NATIVE_QUOTE_DEPLOYMENTS = {
    TOKEN_CHAIN_IDS["ethereum"]: "deployment-0001",
    TOKEN_CHAIN_IDS["avalancheC"]: "deployment-0003",
    TOKEN_CHAIN_IDS["solana"]: "deployment-0005",
}


def _row_json(row: TokenRanking) -> dict[str, Any]:
    return {
        "rank": row.rank,
        "chainId": row.chain_id,
        "deploymentIds": list(row.deployment_ids),
        "metric": row.metric,
        "valueNumerator": row.value_numerator,
        "valueDenominator": row.value_denominator,
        "quoteCurrency": row.quote_currency,
        "quoteDeploymentId": row.quote_deployment_id,
        "observedAt": row.observed_at,
        "sourceId": row.source_id,
        "sourceAssetId": row.source_asset_id,
    }


def _coverage_json(coverage: TokenRankingCoverage) -> dict[str, Any]:
    return {
        "chainId": coverage.chain_id,
        "totalDeployments": coverage.total_deployments,
        "rankedDeployments": coverage.ranked_deployments,
        "unrankedDeployments": coverage.unranked_deployments,
        "observedAt": coverage.observed_at,
    }


def _metadata_json(metadata: TokenRankingMetadata) -> dict[str, Any]:
    return {
        "schemaVersion": metadata.schema_version,
        "metric": metadata.metric,
        "asOf": metadata.as_of,
        "contentDigest": metadata.content_digest,
        "status": metadata.status,
        "coverage": [_coverage_json(row) for row in metadata.coverage],
        "sourceIds": list(metadata.source_ids),
    }


def test_generated_ranking_schema_and_nested_values_are_immutable() -> None:
    assert TokenRanking._fields == _RANKING_FIELDS
    assert TokenRankingMetadata._fields == _METADATA_FIELDS
    assert TokenRankingCoverage._fields == _COVERAGE_FIELDS
    assert isinstance(TOKEN_RANKINGS, tuple)
    assert isinstance(TOKEN_RANKINGS_BY_CHAIN, Mapping)
    assert isinstance(TOKEN_RANKINGS_COVERAGE, tuple)
    assert isinstance(TOKEN_RANKINGS_SOURCE_IDS, tuple)
    assert TOKEN_RANKINGS_SCHEMA_VERSION == 1
    assert TOKEN_RANKINGS_METRIC in {
        None,
        "onchain-total-supply-value-native",
        "global-circulating-market-cap-usd",
    }
    assert TOKEN_RANKINGS_AS_OF is None or _RFC3339.fullmatch(TOKEN_RANKINGS_AS_OF)
    assert re.fullmatch(r"[0-9a-f]{64}", TOKEN_RANKINGS_CONTENT_DIGEST)
    assert TOKEN_RANKINGS_CONTENT_DIGEST == TOKEN_RANKINGS_METADATA.content_digest
    assert TOKEN_RANKINGS_STATUS in {"unconfigured", "complete", "partial"}
    assert TOKEN_RANKINGS_METADATA.coverage is TOKEN_RANKINGS_COVERAGE
    assert TOKEN_RANKINGS_METADATA.source_ids is TOKEN_RANKINGS_SOURCE_IDS

    with pytest.raises(TypeError):
        TOKEN_RANKINGS_BY_CHAIN["eip155:1"] = ()  # type: ignore[index]
    with pytest.raises(AttributeError):
        TOKEN_RANKINGS_METADATA.status = "complete"  # type: ignore[misc]
    with pytest.raises(AttributeError):
        TOKEN_RANKINGS_METADATA.coverage = ()  # type: ignore[misc]
    if TOKEN_RANKINGS_COVERAGE:
        with pytest.raises(TypeError):
            TOKEN_RANKINGS_COVERAGE[0] = TOKEN_RANKINGS_COVERAGE[0]  # type: ignore[index]
    if TOKEN_RANKINGS_SOURCE_IDS:
        with pytest.raises(TypeError):
            TOKEN_RANKINGS_SOURCE_IDS[0] = "changed"  # type: ignore[index]

    for chain_id, rows in TOKEN_RANKINGS_BY_CHAIN.items():
        assert rows == tuple(row for row in TOKEN_RANKINGS if row.chain_id == chain_id)
        assert rows is not TOKEN_RANKINGS

    for coverage in TOKEN_RANKINGS_METADATA.coverage:
        assert coverage.total_deployments >= 0
        assert coverage.ranked_deployments >= 0
        assert coverage.unranked_deployments >= 0
        assert (
            coverage.ranked_deployments + coverage.unranked_deployments
            <= coverage.total_deployments
        )
        assert coverage.observed_at is None or _RFC3339.fullmatch(coverage.observed_at)

    for row in TOKEN_RANKINGS:
        assert row.rank > 0
        assert row.chain_id in TOKEN_CHAIN_IDS.values()
        assert row.deployment_ids
        assert _NONNEGATIVE_DECIMAL.fullmatch(row.value_numerator)
        assert _POSITIVE_DECIMAL.fullmatch(row.value_denominator)
        assert gcd(int(row.value_numerator), int(row.value_denominator)) == 1
        assert row.quote_currency in {"native", "USD"}
        assert _RFC3339.fullmatch(row.observed_at)
        assert row.source_id
        if row.metric == "onchain-total-supply-value-native":
            assert len(row.deployment_ids) == 1
            assert row.quote_currency == "native"
            assert row.quote_deployment_id == _NATIVE_QUOTE_DEPLOYMENTS[row.chain_id]
            assert row.source_asset_id is None
        elif row.metric == "global-circulating-market-cap-usd":
            assert row.quote_currency == "USD"
            assert row.quote_deployment_id is None
            assert row.source_asset_id
        else:
            pytest.fail(f"unknown ranking metric: {row.metric}")


def test_list_token_rankings_is_an_exact_offline_immutable_lookup() -> None:
    for chain_id in TOKEN_CHAIN_IDS.values():
        expected = tuple(row for row in TOKEN_RANKINGS if row.chain_id == chain_id)
        actual = list_token_rankings(chain_id)
        assert actual == expected
        assert isinstance(actual, tuple)
        if actual:
            assert actual[0] is next(row for row in TOKEN_RANKINGS if row.chain_id == chain_id)

    empty = list_token_rankings("")
    unknown = list_token_rankings("unknown:chain")
    assert empty == unknown == ()
    assert empty is unknown
    for value in (None, [], {}, "constructor", "toString", "__proto__"):
        assert list_token_rankings(value) == ()


def test_unconfigured_snapshot_is_empty_without_pinning_future_counts() -> None:
    if TOKEN_RANKINGS_METADATA.status == "unconfigured":
        assert TOKEN_RANKINGS_METADATA.metric is None
        assert TOKEN_RANKINGS_METADATA.as_of is None
        assert TOKEN_RANKINGS == ()
        assert TOKEN_RANKINGS_BY_CHAIN == {}


def test_captures_native_ranking_parity_from_the_installed_wheel_when_requested() -> None:
    output_path = os.environ.get("ERPC_SDK_RANKING_PARITY_OUTPUT")
    if not output_path:
        return

    package_path = Path(erpc_sdk.__file__).resolve()
    workspace_package = Path(__file__).resolve().parents[1] / "src" / "erpc_sdk"
    runtime_root = Path(sys.prefix).resolve()
    if package_path.parent == workspace_package or runtime_root not in package_path.parents:
        pytest.fail(
            "ERPC_SDK_RANKING_PARITY_OUTPUT requires an installed wheel; "
            "run python -I -m pytest --import-mode=importlib packages/python/tests "
            f"(loaded {package_path})"
        )

    behavior_inputs = [
        *erpc_sdk.TOKEN_CHAIN_IDS.values(),
        "",
        "unknown:chain",
        "constructor",
        "toString",
        "__proto__",
    ]
    behavior = {
        chain_id: [_row_json(row) for row in erpc_sdk.list_token_rankings(chain_id)]
        for chain_id in behavior_inputs
    }
    snapshot = {
        "snapshotVersion": 1,
        "snapshotKind": "native-runtime",
        "language": "python",
        "runtime": (
            f"python-installed-wheel-{platform.python_implementation()}-"
            f"{platform.python_version()}-{sys.implementation.name}"
        ),
        "metadata": _metadata_json(erpc_sdk.TOKEN_RANKINGS_METADATA),
        "records": [_row_json(row) for row in erpc_sdk.TOKEN_RANKINGS],
        "behavior": behavior,
    }
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(snapshot, indent=2) + "\n")
    assert destination.stat().st_size > 0
