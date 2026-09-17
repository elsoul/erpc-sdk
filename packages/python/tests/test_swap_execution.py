from __future__ import annotations

import asyncio
import json
import os
import platform
from pathlib import Path
from typing import Any

import httpx
import pytest

from erpc_sdk import (
    DEX_CATALOG_CONTENT_DIGEST,
    SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
    SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
    TOKEN_CATALOG_CONTENT_DIGEST,
    ErpcClient,
    ErpcClientConfig,
    RequestOptions,
    SwapExecutionError,
    SwapExecutionErrorCode,
    SwapQuoteError,
)

_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE_PATH = _ROOT / "registry" / "fixtures" / "swap-execution-cases.json"


def _load_fixture(*, required: bool = False) -> dict[str, Any] | None:
    if not _FIXTURE_PATH.is_file():
        if required:
            raise AssertionError(
                f"ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT requires {_FIXTURE_PATH}"
            )
        return None
    return json.loads(_FIXTURE_PATH.read_text())


def _client_for(
    handler: httpx.MockTransport,
    now_seconds: int,
) -> tuple[ErpcClient, httpx.AsyncClient]:
    http = httpx.AsyncClient(transport=handler)
    client = ErpcClient(
        ErpcClientConfig("capture-secret", endpoint="https://example.test/rpc"),
        http_client=http,
    )
    # The clock is private by design: production clients always use wall time,
    # while parity fixtures need deterministic deadline/freshness checks.
    client.swap._clock = lambda: now_seconds  # type: ignore[attr-defined]
    return client, http


def _fixture_handler(entry: dict[str, Any], trace: list[dict[str, Any]]) -> httpx.MockTransport:
    response_index = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal response_index
        body = json.loads(request.content)
        trace.append({"method": body["method"], "params": body.get("params", [])})
        mutation = entry.get("mutation")
        if mutation == "preflightProviderError":
            raise RuntimeError("upstream provider detail")
        if mutation == "changeRequestAfterAwait" and len(trace) == 1:
            request_value = entry["_request"]
            request_value.update(
                {
                    "sender": "0xcccccccccccccccccccccccccccccccccccccc",
                    "recipient": "0xdddddddddddddddddddddddddddddddddddddd",
                    "slippageBps": 9999,
                    "deadline": "1789498801",
                    "amountIn": "1",
                }
            )

        params = body.get("params", [])
        first_param = params[0] if params else None
        is_final_simulation = (
            body["method"] == "eth_call"
            and isinstance(first_param, dict)
            and str(first_param.get("data", "")).startswith("0x38ed1739")
        )
        if is_final_simulation and mutation in {
            "routerRevert",
            "routerProviderError",
            "routerRevertCode3",
            "routerNonRevertCode3",
        }:
            if mutation == "routerRevert":
                code, message = -32000, "execution reverted"
            elif mutation == "routerProviderError":
                code, message = -32000, "provider unavailable"
            elif mutation == "routerRevertCode3":
                code, message = 3, "execution reverted: ERC20: transfer amount exceeds balance"
            else:
                code, message = 3, "invalid router request"
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "error": {"code": code, "message": message},
                },
            )

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
    request = json.loads(json.dumps(entry["request"]))
    # The handler mutates this captured copy for the snapshot test case.
    entry_for_handler = {**entry, "_request": request}
    client, http = _client_for(
        _fixture_handler(entry_for_handler, trace),
        int(entry["nowSeconds"]),
    )
    try:
        options = RequestOptions()
        if entry.get("mutation") == "cancelBeforeFirstRpc":
            cancel_event = asyncio.Event()
            cancel_event.set()
            options = RequestOptions(cancel_event=cancel_event)
        try:
            if entry["method"] == "prepare":
                value = await client.swap.prepare_exact_input_swap(request, options)
            else:
                value = await client.swap.simulate_exact_input_swap(request, options)
            outcome: dict[str, Any] = {"kind": "success", "value": value}
        except (SwapExecutionError, SwapQuoteError) as error:
            outcome = {"kind": "sdk-error", "code": str(error.code)}
        except Exception:
            outcome = {"kind": "transport-error", "sourcePreserved": True}
    finally:
        await client.close()
        await http.aclose()
    return outcome, trace


def _expected_outcome(entry: dict[str, Any]) -> dict[str, Any]:
    expected = json.loads(json.dumps(entry["outcome"]))
    if expected.get("kind") != "success" or not isinstance(expected.get("value"), dict):
        return expected
    value = expected["value"]
    preparation = value.get("preparation", value)
    preparation["executionCapabilityDigest"] = SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST
    quote = preparation.get("quote")
    if isinstance(quote, dict):
        quote["tokenCatalogDigest"] = TOKEN_CATALOG_CONTENT_DIGEST
        quote["dexCatalogDigest"] = DEX_CATALOG_CONTENT_DIGEST
    return expected


@pytest.mark.asyncio
async def test_shared_swap_execution_cases_replay_exactly() -> None:
    fixture = _load_fixture()
    if fixture is None:
        pytest.skip("shared execution fixtures are available only in the repository workspace")
    assert fixture["schemaVersion"] == 1
    assert fixture["fixtureKind"] == "swap-execution-fixtures"
    assert fixture["capabilityAsOfDate"] == SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE
    assert fixture["capabilityDigest"] == SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST

    for entry in fixture["cases"]:
        outcome, trace = await _run_fixture_case(entry)
        assert outcome == _expected_outcome(entry), entry["caseId"]
        assert trace == entry.get("rpcTrace", []), entry["caseId"]


@pytest.mark.asyncio
async def test_preparation_calldata_and_allowance_gate() -> None:
    fixture = _load_fixture()
    if fixture is None:
        pytest.skip("shared execution fixtures are available only in the repository workspace")
    preparation_case = next(
        entry
        for entry in fixture["cases"]
        if entry["caseId"] == "prepare-ethereum-weth-usdc-forward"
    )
    allowance_case = next(
        entry for entry in fixture["cases"] if entry["caseId"] == "allowance-below-required"
    )
    preparation, _ = await _run_fixture_case(preparation_case)
    expected = _expected_outcome(preparation_case)
    assert preparation["value"]["transaction"] == expected["value"]["transaction"]

    allowance, trace = await _run_fixture_case(allowance_case)
    assert allowance == _expected_outcome(allowance_case)
    assert len(trace) == 17
    assert not any("0x38ed1739" in str(item["params"]) for item in trace)


def test_execution_error_codes_and_messages_are_stable() -> None:
    assert str(SwapExecutionError(SwapExecutionErrorCode.INVALID_ARGUMENT)) == (
        "Swap execution request is invalid"
    )
    assert str(SwapExecutionError(SwapExecutionErrorCode.UNSUPPORTED_EXECUTION)) == (
        "Swap execution is unsupported for the selected records"
    )


@pytest.mark.asyncio
async def test_native_capture_is_written_only_when_requested() -> None:
    output_path = os.environ.get("ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT")
    if not output_path:
        return
    fixture = _load_fixture(required=True)
    assert fixture is not None
    behavior: dict[str, list[dict[str, Any]]] = {"prepare": [], "simulate": []}
    for entry in fixture["cases"]:
        outcome, trace = await _run_fixture_case(entry)
        behavior[entry["method"]].append(
            {"caseId": entry["caseId"], "outcome": outcome, "rpcTrace": trace}
        )
    for values in behavior.values():
        values.sort(key=lambda item: str(item["caseId"]))
    package_kind = (
        "built-dist"
        if os.environ.get("ERPC_SDK_SWAP_EXECUTION_PARITY_PACKAGE") == "dist"
        else "source"
    )
    capture = {
        "snapshotVersion": 1,
        "snapshotKind": "swap-execution-native-runtime",
        "language": "python",
        "runtime": f"python-{package_kind}-{platform.python_version()}",
        "capabilityAsOfDate": SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
        "capabilityDigest": SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
        "behavior": behavior,
    }
    Path(output_path).write_text(json.dumps(capture, indent=2) + "\n")
