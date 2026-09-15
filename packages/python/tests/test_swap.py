from __future__ import annotations

import json
import os
import platform
from pathlib import Path
from typing import Any

import httpx
import pytest

from erpc_sdk import (
    DEX_ALIASES,
    DEX_CATALOG_AS_OF_DATE,
    DEX_CATALOG_CONTENT_DIGEST,
    DEX_CATALOG_VERSION,
    DEX_CHAIN_IDS,
    DEX_DEPLOYMENTS,
    NATIVE_WRAP_DEFINITIONS,
    POOL_DEFINITIONS,
    TOKEN_CATALOG_AS_OF_DATE,
    TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION,
    TOKEN_CHAIN_IDS,
    ErpcAbortedError,
    ErpcClient,
    ErpcClientConfig,
    RequestOptions,
    SwapQuoteError,
    dexes,
    find_pool_definition_by_address,
    find_pool_definitions_by_pair,
    get_dex_deployment,
    get_native_wrap_definition,
    get_pool_definition,
    list_pool_definitions,
    pools,
)

_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE_PATH = _ROOT / "registry" / "fixtures" / "swap-quote-cases.json"


def _load_fixture(*, required: bool = False) -> dict[str, Any] | None:
    if not _FIXTURE_PATH.is_file():
        if required:
            raise AssertionError(
                f"ERPC_SDK_DEX_PARITY_OUTPUT requires the workspace fixture at {_FIXTURE_PATH}"
            )
        return None
    return json.loads(_FIXTURE_PATH.read_text())


def _shared_cases(fixture: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    return tuple(
        entry
        for group in ("validCases", "invalidCases", "rpcCases", "arithmeticCases")
        for entry in fixture[group]
        if entry.get("applicability") != "language-local"
    )


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "entry" not in metafunc.fixturenames:
        return
    if metafunc.function.__name__ != "test_shared_quote_cases_replay_exactly":
        return
    fixture = _load_fixture()
    if fixture is None:
        metafunc.parametrize(
            "entry",
            [
                pytest.param(
                    None,
                    marks=pytest.mark.skip(
                        reason=(
                            "shared quote fixtures are available only in the repository workspace"
                        )
                    ),
                )
            ],
            ids=["workspace-fixture-missing"],
        )
        return
    cases = _shared_cases(fixture)
    metafunc.parametrize("entry", cases, ids=[entry["caseId"] for entry in cases])


def _client_for(
    handler: httpx.MockTransport,
    now_seconds: int | None = None,
) -> tuple[ErpcClient, httpx.AsyncClient]:
    http = httpx.AsyncClient(transport=handler)
    client = ErpcClient(
        ErpcClientConfig("capture-secret", endpoint="https://example.test/rpc"),
        http_client=http,
    )
    if now_seconds is not None:
        client.swap._clock = lambda: now_seconds  # type: ignore[attr-defined]
    return client, http


def _fixture_handler(entry: dict[str, Any], trace: list[dict[str, Any]]) -> httpx.MockTransport:
    response_index = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal response_index
        body = json.loads(request.content)
        trace.append({"method": body["method"], "params": body.get("params", [])})
        responses = entry.get("rpcResponses", [])
        if response_index >= len(responses):
            raise AssertionError(f"fixture has no response for {body['method']}")
        result = responses[response_index]
        response_index += 1
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    return httpx.MockTransport(handler)


async def _run_fixture_case(entry: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    trace: list[dict[str, Any]] = []
    transport = _fixture_handler(entry, trace)
    client, http = _client_for(transport, int(entry["nowSeconds"]))
    try:
        try:
            value = await client.swap.quote_exact_input(entry["request"])
            outcome: dict[str, Any] = {"kind": "success", "value": value}
        except SwapQuoteError as error:
            outcome = {"kind": "sdk-error", "code": str(error.code)}
        except Exception:
            outcome = {"kind": "transport-error", "sourcePreserved": True}
    finally:
        await client.close()
        await http.aclose()
    return outcome, trace


@pytest.mark.asyncio
async def test_shared_quote_cases_replay_exactly(entry: dict[str, Any]) -> None:
    outcome, trace = await _run_fixture_case(entry)
    assert outcome == entry["outcome"], entry["caseId"]
    assert trace == entry.get("rpcTrace", []), entry["caseId"]


def test_quote_shape_rejects_extra_fields_before_rpc() -> None:
    called = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal called
        called += 1
        return httpx.Response(500)

    async def run() -> None:
        client, http = _client_for(httpx.MockTransport(handler), 1789498700)
        try:
            with pytest.raises(SwapQuoteError) as captured:
                await client.swap.quote_exact_input(
                    {
                        "chainId": DEX_CHAIN_IDS["ethereum"],
                        "poolDefinitionId": "pool-0001",
                        "inputTokenDeploymentId": "deployment-0002",
                        "outputTokenDeploymentId": "deployment-0008",
                        "amountIn": "1",
                        "rpc": {},
                    }
                )
            assert str(captured.value.code) == "SWAP_INVALID_ARGUMENT"
            assert called == 0
        finally:
            await client.close()
            await http.aclose()

    import asyncio

    asyncio.run(run())


@pytest.mark.asyncio
async def test_preaborted_request_preserves_native_abort_error_and_does_not_send() -> None:
    called = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal called
        called += 1
        return httpx.Response(500)

    client, http = _client_for(httpx.MockTransport(handler), 1789498700)
    try:
        event = __import__("asyncio").Event()
        event.set()
        request = {
            "chainId": DEX_CHAIN_IDS["ethereum"],
            "poolDefinitionId": "pool-0001",
            "inputTokenDeploymentId": "deployment-0002",
            "outputTokenDeploymentId": "deployment-0008",
            "amountIn": "1",
        }
        with pytest.raises(ErpcAbortedError):
            await client.swap.quote_exact_input(request, RequestOptions(cancel_event=event))
        assert called == 0
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_request_scalars_are_snapshotted_before_awaits() -> None:
    fixture = _load_fixture()
    if fixture is None:
        pytest.skip("shared quote fixtures are available only in the repository workspace")
    entry = fixture["validCases"][0]
    trace: list[dict[str, Any]] = []
    response_index = 0
    request = dict(entry["request"])
    freshness = {
        "maxBlockAgeSeconds": 120,
        "maxBlockLag": 3,
        "maxClockSkewSeconds": 5,
    }
    request["freshness"] = freshness

    def handler(rpc_request: httpx.Request) -> httpx.Response:
        nonlocal response_index
        body = json.loads(rpc_request.content)
        trace.append({"method": body["method"], "params": body.get("params", [])})
        result = entry["rpcResponses"][response_index]
        response_index += 1
        if response_index == 1:
            # These mutations happen while the first transport call is
            # pending, after quote validation has taken its scalar snapshot.
            request["amountIn"] = "2"
            request["outputTokenDeploymentId"] = "deployment-0004"
            freshness["maxBlockAgeSeconds"] = 0
            freshness["maxBlockLag"] = 0
            freshness["maxClockSkewSeconds"] = 0
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    transport = httpx.MockTransport(handler)
    client, http = _client_for(transport, int(entry["nowSeconds"]))
    try:
        result = await client.swap.quote_exact_input(request)
        assert result["amountIn"] == entry["request"]["amountIn"]
        assert result["outputTokenDeploymentId"] == entry["request"]["outputTokenDeploymentId"]
        assert response_index == len(entry["rpcResponses"])
    finally:
        await client.close()
        await http.aclose()


def _record_dex(value: Any) -> dict[str, Any]:
    return {
        "dexDeploymentId": value.dex_deployment_id,
        "protocolId": value.protocol_id,
        "name": value.name,
        "chainId": value.chain_id,
        "programAddress": value.program_address,
        "adapterKind": value.adapter_kind,
        "status": value.status,
        "replacedByDexDeploymentId": value.replaced_by_dex_deployment_id,
    }


def _record_pool(value: Any) -> dict[str, Any]:
    return {
        "poolDefinitionId": value.pool_definition_id,
        "dexDeploymentId": value.dex_deployment_id,
        "chainId": value.chain_id,
        "address": value.address,
        "token0DeploymentId": value.token0_deployment_id,
        "token1DeploymentId": value.token1_deployment_id,
        "adapter": {
            "kind": value.adapter.kind,
            "feeNumerator": value.adapter.fee_numerator,
            "feeDenominator": value.adapter.fee_denominator,
        },
        "status": value.status,
        "replacedByPoolDefinitionId": value.replaced_by_pool_definition_id,
    }


def _record_wrap(value: Any) -> dict[str, Any]:
    return {
        "nativeWrapDefinitionId": value.native_wrap_definition_id,
        "chainId": value.chain_id,
        "nativeTokenDeploymentId": value.native_token_deployment_id,
        "wrappedTokenDeploymentId": value.wrapped_token_deployment_id,
        "status": value.status,
    }


def _record_alias(value: Any) -> dict[str, Any]:
    return {
        "namespace": value.namespace,
        "name": value.name,
        "dexDeploymentId": value.dex_deployment_id,
        "poolDefinitionId": value.pool_definition_id,
    }


def _lookup_behavior() -> dict[str, list[dict[str, Any]]]:
    behavior: dict[str, list[dict[str, Any]]] = {
        "getDexDeployment": [],
        "getPoolDefinition": [],
        "findPoolDefinitionByAddress": [],
        "findPoolDefinitionsByPair": [],
        "listPoolDefinitions": [],
        "getNativeWrapDefinition": [],
    }
    for deployment in DEX_DEPLOYMENTS:
        value = get_dex_deployment(deployment.dex_deployment_id)
        behavior["getDexDeployment"].append(
            {
                "input": deployment.dex_deployment_id,
                "result": value.dex_deployment_id if value else None,
            }
        )
    behavior["getDexDeployment"].append(
        {
            "input": "dex-unknown",
            "result": (
                value.dex_deployment_id if (value := get_dex_deployment("dex-unknown")) else None
            ),
        }
    )
    for pool in POOL_DEFINITIONS:
        value = get_pool_definition(pool.pool_definition_id)
        behavior["getPoolDefinition"].append(
            {
                "input": pool.pool_definition_id,
                "result": value.pool_definition_id if value else None,
            }
        )
    behavior["getPoolDefinition"].append(
        {
            "input": "pool-unknown",
            "result": (
                value.pool_definition_id if (value := get_pool_definition("pool-unknown")) else None
            ),
        }
    )
    for pool in POOL_DEFINITIONS:
        behavior["findPoolDefinitionByAddress"].append(
            {
                "chainId": pool.chain_id,
                "address": pool.address,
                "result": (
                    value.pool_definition_id
                    if (value := find_pool_definition_by_address(pool.chain_id, pool.address))
                    else None
                ),
            }
        )
        if pool.chain_id.startswith("eip155:"):
            address = "0x" + pool.address[2:].upper()
            value = find_pool_definition_by_address(pool.chain_id, address)
            behavior["findPoolDefinitionByAddress"].append(
                {
                    "chainId": pool.chain_id,
                    "address": address,
                    "result": value.pool_definition_id if value else None,
                }
            )
    for chain_id, address in (
        (DEX_CHAIN_IDS["ethereum"], "0x" + "0" * 40),
        (DEX_CHAIN_IDS["ethereum"], "not-an-address"),
        ("unknown:chain", "0x" + "0" * 39 + "1"),
    ):
        value = find_pool_definition_by_address(chain_id, address)
        behavior["findPoolDefinitionByAddress"].append(
            {
                "chainId": chain_id,
                "address": address,
                "result": value.pool_definition_id if value else None,
            }
        )
    for pool in POOL_DEFINITIONS:
        for token_a, token_b in (
            (pool.token0_deployment_id, pool.token1_deployment_id),
            (pool.token1_deployment_id, pool.token0_deployment_id),
        ):
            value = find_pool_definitions_by_pair(pool.chain_id, token_a, token_b)
            behavior["findPoolDefinitionsByPair"].append(
                {
                    "chainId": pool.chain_id,
                    "token0DeploymentId": token_a,
                    "token1DeploymentId": token_b,
                    "result": [entry.pool_definition_id for entry in value],
                }
            )
    for chain_id, token_a, token_b in (
        (DEX_CHAIN_IDS["ethereum"], "deployment-0001", "deployment-0003"),
        ("unknown:chain", "deployment-0002", "deployment-0008"),
    ):
        value = find_pool_definitions_by_pair(chain_id, token_a, token_b)
        behavior["findPoolDefinitionsByPair"].append(
            {
                "chainId": chain_id,
                "token0DeploymentId": token_a,
                "token1DeploymentId": token_b,
                "result": [entry.pool_definition_id for entry in value],
            }
        )
    filters: list[dict[str, str]] = [{}]
    filters.extend({"chainId": chain_id} for chain_id in TOKEN_CHAIN_IDS.values())
    filters.extend(
        {"tokenDeploymentId": token_id}
        for pool in POOL_DEFINITIONS
        for token_id in (pool.token0_deployment_id, pool.token1_deployment_id)
    )
    filters.extend(
        {"adapterKind": adapter_kind}
        for adapter_kind in dict.fromkeys(pool.adapter.kind for pool in POOL_DEFINITIONS)
    )
    filters.extend(
        {
            "chainId": pool.chain_id,
            "tokenDeploymentId": pool.token0_deployment_id,
            "adapterKind": pool.adapter.kind,
        }
        for pool in POOL_DEFINITIONS
    )
    filters.extend(
        [
            {"chainId": "unknown:chain"},
            {"tokenDeploymentId": "deployment-unknown"},
            {"adapterKind": "unknown-adapter"},
        ]
    )
    for selected in filters:
        value = list_pool_definitions(selected)
        behavior["listPoolDefinitions"].append(
            {"filter": selected, "result": [entry.pool_definition_id for entry in value]}
        )
    from erpc_sdk.token_catalog import TOKEN_DEPLOYMENTS

    for deployment in TOKEN_DEPLOYMENTS:
        if deployment.standard == "native":
            value = get_native_wrap_definition(deployment.deployment_id)
            behavior["getNativeWrapDefinition"].append(
                {
                    "input": deployment.deployment_id,
                    "result": value.native_wrap_definition_id if value else None,
                }
            )
    for native_token_deployment_id in ("deployment-unknown", "native-wrap-0001"):
        value = get_native_wrap_definition(native_token_deployment_id)
        behavior["getNativeWrapDefinition"].append(
            {
                "input": native_token_deployment_id,
                "result": value.native_wrap_definition_id if value else None,
            }
        )
    return behavior


def _alias_behavior() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for alias in DEX_ALIASES:
        namespace = alias.namespace if alias.namespace != "avalancheC" else "avalanche_c"
        group = getattr(dexes if alias.dex_deployment_id is not None else pools, namespace)
        result.append(
            {
                "namespace": alias.namespace,
                "name": alias.name,
                "kind": "dex" if alias.dex_deployment_id is not None else "pool",
                "result": getattr(group, alias.name),
            }
        )
    return result


async def _captured_quote_behavior(
    fixture: dict[str, Any],
) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []
    for entry in _shared_cases(fixture):
        outcome, trace = await _run_fixture_case(entry)
        assert trace == entry.get("rpcTrace", []), entry["caseId"]
        captured.append({"caseId": entry["caseId"], "outcome": outcome, "rpcTrace": trace})
    return captured


@pytest.mark.asyncio
async def test_captures_native_dex_parity_only_when_output_is_configured() -> None:
    output_path = os.environ.get("ERPC_SDK_DEX_PARITY_OUTPUT")
    if not output_path:
        return
    fixture = _load_fixture(required=True)
    assert fixture is not None
    behavior = _lookup_behavior()
    behavior["alias"] = _alias_behavior()
    behavior["quote"] = await _captured_quote_behavior(fixture)
    snapshot = {
        "snapshotVersion": 1,
        "snapshotKind": "native-runtime",
        "language": "python",
        "runtime": f"python-native-{platform.python_version()}",
        "metadata": {
            "version": TOKEN_CATALOG_VERSION,
            "asOfDate": TOKEN_CATALOG_AS_OF_DATE,
            "contentDigest": TOKEN_CATALOG_CONTENT_DIGEST,
            "chainIds": dict(TOKEN_CHAIN_IDS),
        },
        "dexMetadata": {
            "version": DEX_CATALOG_VERSION,
            "asOfDate": DEX_CATALOG_AS_OF_DATE,
            "contentDigest": DEX_CATALOG_CONTENT_DIGEST,
        },
        "dexDeployments": [_record_dex(value) for value in DEX_DEPLOYMENTS],
        "poolDefinitions": [_record_pool(value) for value in POOL_DEFINITIONS],
        "nativeWrapDefinitions": [_record_wrap(value) for value in NATIVE_WRAP_DEFINITIONS],
        "aliases": [_record_alias(value) for value in DEX_ALIASES],
        "behavior": behavior,
    }
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(snapshot, indent=2) + "\n")
    assert destination.stat().st_size > 0
