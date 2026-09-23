"""Fixture replay for local Mayan Swift v2 unsigned construction."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
from pathlib import Path
from typing import Any, TypeAlias, cast

import httpx
import pytest

import erpc_sdk.bridge_local as bridge_local_module
from erpc_sdk import (
    BridgeError,
    BridgeErrorCode,
    RequestOptions,
    create_mayan_swift_v2_bridge_client,
)

_FIXTURE_PATH = (
    Path(__file__).parents[3]
    / "registry/fixtures/mayan-swift-v2-local-build-cases.json"
)
_FIXTURE = json.loads(_FIXTURE_PATH.resolve().read_text(encoding="utf-8"))
LocalRun: TypeAlias = tuple[
    dict[str, object], list[dict[str, object]], list[dict[str, object]]
]


class _TrackingByteStream(httpx.AsyncByteStream):
    def __init__(
        self,
        chunks: list[bytes],
        *,
        cancel_event: asyncio.Event | None = None,
        stall: bool = False,
    ) -> None:
        self._chunks = chunks
        self._cancel_event = cancel_event
        self._stall = stall
        self.consumed = 0
        self.closed = False

    async def __aiter__(self) -> Any:
        for chunk in self._chunks:
            self.consumed += 1
            yield chunk
            if self._cancel_event is not None:
                self._cancel_event.set()
            if self._stall:
                await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.closed = True


class _ReadErrorStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self) -> Any:
        yield b"{"
        raise httpx.ReadError("sentinel credential=SYNTHETIC")

    async def aclose(self) -> None:
        self.closed = True


def _assert_sanitized_bridge_error(error: BridgeError, code: BridgeErrorCode) -> None:
    assert error.code is code
    assert error.__cause__ is None
    assert error.__context__ is None
    cursor: BaseException | None = error
    seen: set[int] = set()
    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        text = f"{cursor!s} {cursor!r}"
        assert "SYNTHETIC" not in text
        assert "credential" not in text
        assert "http" not in text.lower()
        cursor = cursor.__cause__ or cursor.__context__
    assert len(seen) == 1

def _set_path(root: object, path: str, value: object) -> None:
    parts: list[str] = []
    for component in path.split("."):
        cursor = 0
        while cursor < len(component):
            opening = component.find("[", cursor)
            if opening < 0:
                parts.append(component[cursor:])
                break
            if opening > cursor:
                parts.append(component[cursor:opening])
            closing = component.find("]", opening)
            if closing < 0:
                raise AssertionError("invalid mutation path")
            parts.append(component[opening + 1 : closing])
            cursor = closing + 1
    if not parts or any(part == "" for part in parts):
        raise AssertionError("invalid mutation path")
    cursor: object = root
    for part in parts[:-1]:
        if isinstance(cursor, list):
            cursor = cursor[int(part)]
        elif isinstance(cursor, dict):
            cursor = cursor[part]
        else:
            raise AssertionError("invalid mutation path")
    leaf = parts[-1]
    if isinstance(cursor, list):
        cursor[int(leaf)] = value
    elif isinstance(cursor, dict):
        cursor[leaf] = value
    else:
        raise AssertionError("invalid mutation path")


def _clone(value: object) -> object:
    return copy.deepcopy(value)


def _mutate_quote(
    quote: dict[str, object], mutation: dict[str, object] | None
) -> dict[str, object]:
    if mutation is None or mutation.get("kind") not in {
        "quote-normalized-set",
        "quote-raw-set",
    }:
        return cast(dict[str, object], _clone(quote))
    result = cast(dict[str, object], _clone(quote))
    if mutation["kind"] == "quote-normalized-set":
        _set_path(result, cast(str, mutation["path"]), mutation.get("value"))
        return result
    raw = json.loads(cast(str, result["rawSignedQuoteJson"]))
    _set_path(raw, cast(str, mutation["path"]), mutation.get("value"))
    result["rawSignedQuoteJson"] = json.dumps(
        raw, ensure_ascii=False, separators=(",", ":")
    )
    return result


def _mutate_source_mock(
    mock: dict[str, object], mutation: dict[str, object] | None
) -> dict[str, object]:
    if mutation is None or mutation.get("kind") != "source-swap-response-set":
        return cast(dict[str, object], _clone(mock))
    result = cast(dict[str, object], _clone(mock))
    response = cast(dict[str, object], result["response"])
    body = json.loads(cast(str, response["body"]))
    _set_path(body, cast(str, mutation["path"]), mutation.get("value"))
    response["body"] = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return result


def _request_body_parts(value: str | None) -> dict[str, object] | None:
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _mutate_rpc_mock(
    mock: dict[str, object],
    mutation: dict[str, object] | None,
    apply_envelope_mutation: bool = False,
) -> dict[str, object]:
    result = cast(dict[str, object], _clone(mock))
    response = cast(dict[str, object], result["response"])
    if mutation is not None and mutation.get("kind") == "boundary":
        request = cast(dict[str, object], result["request"])
        body = _request_body_parts(cast(str | None, request["body"]))
        if body is not None and body.get("method") == "getMultipleAccounts":
            payload = json.loads(cast(str, response["body"]))
            rpc_result = cast(dict[str, object], payload["result"])
            values = cast(list[object], rpc_result["value"])
            empty_data = bytearray(56)
            empty_data[0] = 1
            empty_data[4:12] = b"\xff" * 8
            encoded = base64.b64encode(bytes(empty_data)).decode("ascii")
            for account_value in values:
                if isinstance(account_value, dict) and isinstance(account_value.get("data"), list):
                    account_value["data"][0] = encoded
            response["body"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return result
    if (
        apply_envelope_mutation
        and mutation is not None
        and mutation.get("kind") == "rpc-envelope-set"
    ):
        payload = json.loads(cast(str, response["body"]))
        path = mutation.get("path")
        if path in {"id", "jsonrpc"}:
            payload[cast(str, path)] = mutation.get("value")
        elif path == "version":
            payload.pop("jsonrpc", None)
            payload["version"] = mutation.get("value")
        elif path == "depth":
            depth = mutation.get("value")
            if not isinstance(depth, str | int) or isinstance(depth, bool):
                raise AssertionError("invalid envelope depth")
            nested: object = payload.get("result")
            for _ in range(int(depth)):
                nested = {"nested": nested}
            payload["result"] = nested
        elif path == "size":
            size = mutation.get("value")
            if not isinstance(size, str | int) or isinstance(size, bool):
                raise AssertionError("invalid envelope size")
            payload["result"] = "x" * int(size)
        else:
            raise AssertionError("unsupported envelope mutation")
        response["body"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        return result
    if mutation is None or mutation.get("kind") != "rpc-response-set":
        return result
    request = cast(dict[str, object], result["request"])
    request_body = _request_body_parts(cast(str | None, request["body"]))
    method = request_body.get("method") if request_body is not None else None
    path = cast(str, mutation["path"])
    prefix = f"{method}."
    if not isinstance(method, str) or not path.startswith(prefix):
        return result
    payload = json.loads(cast(str, response["body"]))
    response_path = path[len(prefix) :]
    _set_path(
        payload,
        response_path if response_path == "result" else f"result.{response_path}",
        mutation.get("value"),
    )
    response["body"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return result


def _mutate_plan(plan: dict[str, object], mutation: dict[str, object] | None) -> dict[str, object]:
    if mutation is None or mutation.get("kind") != "plan-set":
        return cast(dict[str, object], _clone(plan))
    result = cast(dict[str, object], _clone(plan))
    _set_path(result, cast(str, mutation["path"]), mutation.get("value"))
    return result


def _mutate_config(
    config: dict[str, object], mutation: dict[str, object] | None
) -> dict[str, object]:
    if mutation is None or mutation.get("kind") != "config-set":
        return cast(dict[str, object], _clone(config))
    result = cast(dict[str, object], _clone(config))
    _set_path(result, cast(str, mutation["path"]), mutation.get("value"))
    return result


def _trace_entry(request: httpx.Request) -> dict[str, object]:
    headers = {name.lower(): value for name, value in request.headers.items()}
    for ignored in ("host", "content-length", "user-agent"):
        headers.pop(ignored, None)
    return {
        "method": request.method,
        "url": str(request.url),
        "headers": headers,
        "body": request.content.decode("utf-8") if request.content else None,
    }


async def _run_case(
    entry: dict[str, object],
    fixture: dict[str, object],
    quotes: dict[str, dict[str, object]],
    plans: dict[str, dict[str, object]],
) -> tuple[dict[str, object], list[dict[str, object]], list[dict[str, object]]]:
    mutation = cast(dict[str, object] | None, entry.get("mutation"))
    quote = _mutate_quote(quotes[cast(str, entry["quoteId"])], mutation)
    context = {
        "quote": quote,
        "swapperAddress": cast(dict[str, object], entry["context"])["swapperAddress"],
        "destinationAddress": cast(dict[str, object], entry["context"])["destinationAddress"],
        "orderNonce": cast(dict[str, object], entry["context"])["orderNonce"],
    }
    source_mocks = {
        cast(str, mock["mockId"]): _mutate_source_mock(cast(dict[str, object], mock), mutation)
        for mock in cast(list[dict[str, object]], fixture["sourceSwapMocks"])
        if cast(str, mock["mockId"]) in cast(list[str], entry["sourceSwapMockIds"])
    }
    rpc_mocks = {
        cast(str, mock["mockId"]): _mutate_rpc_mock(
            cast(dict[str, object], mock),
            mutation,
            index == 0,
        )
        for index, mock in enumerate(
            [
                mock
                for mock in cast(list[dict[str, object]], fixture["rpcMocks"])
                if cast(str, mock["mockId"]) in cast(list[str], entry["rpcMockIds"])
            ]
        )
    }
    http_trace: list[dict[str, object]] = []
    rpc_trace: list[dict[str, object]] = []
    transport_event = (
        cast(str, mutation["event"])
        if mutation is not None and mutation.get("kind") == "transport"
        else None
    )
    caller_cancel = asyncio.Event()
    fetch_calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal fetch_calls
        fetch_calls += 1
        if transport_event in {"credential-forwarding", "hosted-build-attempt"}:
            raise BridgeError(BridgeErrorCode.LOCAL_PLAN_INVALID)
        trace = _trace_entry(request)
        if request.method == "GET":
            http_trace.append(trace)
        else:
            rpc_trace.append(trace)
        if transport_event == "rpc-transport-error":
            raise RuntimeError("rpc transport")
        if transport_event in {"source-swap-timeout", "rpc-timeout"}:
            await asyncio.Event().wait()
        if transport_event in {"source-swap-abort", "rpc-abort"}:
            caller_cancel.set()
            await asyncio.Event().wait()
        body = trace["body"]
        if request.method == "GET":
            mock = next(
                (item for item in source_mocks.values() if item["request"] == trace),
                None,
            )
        else:
            actual = _request_body_parts(cast(str | None, body))
            mock = None
            for item in rpc_mocks.values():
                item_request = cast(dict[str, object], item["request"])
                expected = _request_body_parts(cast(str | None, item_request["body"]))
                if (
                    item_request["url"] == trace["url"]
                    and expected is not None
                    and actual is not None
                    and expected.get("method") == actual.get("method")
                    and expected.get("params") == actual.get("params")
                ):
                    mock = item
                    break
        if mock is None:
            raise RuntimeError("unexpected local provider request")
        response = cast(dict[str, object], mock["response"])
        return httpx.Response(
            cast(int, response["status"]),
            headers=cast(dict[str, str], response["headers"]),
            content=cast(str, response["body"]).encode("utf-8"),
        )

    config = _mutate_config(cast(dict[str, object], entry["config"]), mutation)
    local_build = config.get("localBuild")
    if isinstance(local_build, dict) and "altValidation" in local_build:
        local_build = dict(local_build)
        local_build.pop("altValidation", None)
        config["localBuild"] = local_build
    config["minimumQuoteValiditySeconds"] = 0
    if transport_event in {"source-swap-timeout", "rpc-timeout"}:
        config["timeoutMs"] = 5
    client_transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(
        transport=client_transport,
        auth=httpx.BasicAuth("inherited-user", "inherited-secret"),
        headers={"authorization": "Bearer inherited-header"},
        cookies={"inherited": "cookie"},
    )
    client = create_mayan_swift_v2_bridge_client(config, http_client=http_client)
    original_time = bridge_local_module.time.time
    quote_deadline = next(
        cast(dict[str, object], record)["normalizedQuote"]["deadline"]
        for record in cast(list[dict[str, object]], fixture["quotes"])
        if cast(dict[str, object], record)["quoteId"] == entry["quoteId"]
    )
    bridge_local_module.time.time = lambda: float(cast(str, quote_deadline)) - 1
    try:
        options = (
            RequestOptions(cancel_event=caller_cancel)
            if transport_event in {"source-swap-abort", "rpc-abort"}
            else RequestOptions()
        )
        if entry["method"] == "prepareSourceSwap":
            value = await client.prepare_source_swap(context, options)
        else:
            plan = _mutate_plan(
                plans[cast(str, entry["sourceSwapPlanRef"])], mutation
            )
            value = await client.build_local_unsigned(
                {**context, "sourceSwapPlan": plan}, options
            )
        outcome: dict[str, object] = {"kind": "success", "value": value}
    except BridgeError as error:
        outcome = {"kind": "sdk-error", "code": error.code.value, "message": str(error)}
        if error.status is not None:
            outcome["status"] = error.status
    finally:
        bridge_local_module.time.time = original_time
        await client.close()
        await http_client.aclose()
    if transport_event in {"credential-forwarding", "hosted-build-attempt"}:
        assert fetch_calls > 0
    return outcome, http_trace, rpc_trace


async def replay_local_fixture_for_capture() -> tuple[
    dict[str, object], dict[str, LocalRun]
]:
    fixture = cast(dict[str, object], _FIXTURE)
    quote_records = cast(list[dict[str, object]], fixture["quotes"])
    quotes = {
        cast(str, record["quoteId"]): cast(dict[str, object], record["normalizedQuote"])
        for record in quote_records
    }
    plans = {
        cast(str, entry["caseId"]): cast(
            dict[str, object], cast(dict[str, object], entry["expected"])["value"]
        )
        for entry in cast(list[dict[str, object]], fixture["cases"])
        if entry["method"] == "prepareSourceSwap"
        and cast(dict[str, object], entry["expected"])["kind"] == "success"
    }
    runs: dict[str, LocalRun] = {}
    for entry in cast(list[dict[str, object]], fixture["cases"]):
        outcome, http_trace, rpc_trace = await _run_case(entry, fixture, quotes, plans)
        runs[cast(str, entry["caseId"])] = (outcome, http_trace, rpc_trace)
    return fixture, runs


@pytest.mark.asyncio
async def test_replays_local_source_swap_and_unsigned_build_fixture() -> None:
    fixture, runs = await replay_local_fixture_for_capture()
    assert fixture["schemaVersion"] == 1
    assert fixture["fixtureKind"] == "mayan-swift-v2-local-build-fixtures"
    assert fixture["localFixtureDigest"] == (
        "19b1a9d601e7dedaf4e5ad8f8cbe9c7aec0d2b1f2f625b56eea53c48b16ee2d1"
    )
    for entry in cast(list[dict[str, object]], fixture["cases"]):
        outcome, http_trace, rpc_trace = runs[cast(str, entry["caseId"])]
        assert outcome == entry["expected"], entry["caseId"]
        assert http_trace == entry["httpTrace"], entry["caseId"]
        assert rpc_trace == entry["rpcTrace"], entry["caseId"]


@pytest.mark.asyncio
async def test_local_quote_revalidation_rejects_boolean_token_numbers_and_slippage() -> None:
    fixture = cast(dict[str, object], _FIXTURE)
    quote_records = cast(list[dict[str, object]], fixture["quotes"])
    quotes = {
        cast(str, record["quoteId"]): cast(dict[str, object], record["normalizedQuote"])
        for record in quote_records
    }
    plans: dict[str, dict[str, object]] = {}
    base = copy.deepcopy(
        next(
            entry
            for entry in cast(list[dict[str, object]], fixture["cases"])
            if entry["caseId"] == "prepare-eurc-ethereum-to-solana"
        )
    )
    cases = (
        {
            "kind": "quote-raw-set",
            "path": "fromToken.chainId",
            "value": True,
        },
        {
            "kind": "quote-raw-set",
            "path": "slippageBps",
            "value": 501,
        },
        {
            "kind": "quote-normalized-set",
            "path": "slippageBps",
            "value": 501,
        },
    )
    for index, mutation in enumerate(cases):
        entry = copy.deepcopy(base)
        entry["caseId"] = f"local-quote-revalidation-{index}"
        entry["mutation"] = mutation
        outcome, http_trace, rpc_trace = await _run_case(entry, fixture, quotes, plans)
        assert outcome == {
            "kind": "sdk-error",
            "code": "BRIDGE_LOCAL_PLAN_INVALID",
            "message": "Bridge local source-swap plan is invalid",
        }
        assert http_trace == []
        assert rpc_trace == []


@pytest.mark.asyncio
async def test_local_revalidation_preserves_trailing_raw_quote_bytes() -> None:
    fixture = cast(dict[str, object], _FIXTURE)
    quote_records = cast(list[dict[str, object]], fixture["quotes"])
    quotes = {
        cast(str, record["quoteId"]): cast(dict[str, object], record["normalizedQuote"])
        for record in quote_records
    }
    plans = {
        cast(str, entry["caseId"]): cast(
            dict[str, object], cast(dict[str, object], entry["expected"])["value"]
        )
        for entry in cast(list[dict[str, object]], fixture["cases"])
        if entry["method"] == "prepareSourceSwap"
        and cast(dict[str, object], entry["expected"])["kind"] == "success"
    }
    entry = next(
        item
        for item in cast(list[dict[str, object]], fixture["cases"])
        if item["caseId"] == "prepare-eurc-ethereum-to-solana"
    )
    outcome, http_trace, rpc_trace = await _run_case(entry, fixture, quotes, plans)
    assert outcome["kind"] == "success"
    raw = cast(str, quotes[cast(str, entry["quoteId"])]["rawSignedQuoteJson"])
    assert raw.endswith("\n")
    plan = cast(dict[str, object], outcome["value"])
    assert plan["rawQuoteSha256"] == hashlib.sha256(raw.encode("utf-8")).hexdigest()
    assert http_trace == cast(list[dict[str, object]], entry["httpTrace"])
    assert rpc_trace == []


@pytest.mark.asyncio
async def test_local_public_transport_errors_are_sanitized_for_source_and_rpc() -> None:
    fixture = cast(dict[str, object], _FIXTURE)
    quote_records = cast(list[dict[str, object]], fixture["quotes"])
    quotes = {
        cast(str, record["quoteId"]): cast(dict[str, object], record["normalizedQuote"])
        for record in quote_records
    }
    plans = {
        cast(str, entry["caseId"]): cast(
            dict[str, object], cast(dict[str, object], entry["expected"])["value"]
        )
        for entry in cast(list[dict[str, object]], fixture["cases"])
        if entry["method"] == "prepareSourceSwap"
        and cast(dict[str, object], entry["expected"])["kind"] == "success"
    }
    source_entry = next(
        entry
        for entry in cast(list[dict[str, object]], fixture["cases"])
        if entry["caseId"] == "prepare-eurc-ethereum-to-solana"
    )
    rpc_entry = next(
        entry
        for entry in cast(list[dict[str, object]], fixture["cases"])
        if entry["caseId"] == "build-usdc-solana-to-ethereum"
    )

    async def run_source(kind: str) -> BridgeError:
        context = {
            "quote": _mutate_quote(
                quotes[cast(str, source_entry["quoteId"])], None
            ),
            "swapperAddress": cast(dict[str, object], source_entry["context"])[
                "swapperAddress"
            ],
            "destinationAddress": cast(dict[str, object], source_entry["context"])[
                "destinationAddress"
            ],
            "orderNonce": cast(dict[str, object], source_entry["context"])["orderNonce"],
        }
        cancellation = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            if kind == "connect":
                raise httpx.ConnectError("sentinel credential=SYNTHETIC", request=request)
            if kind == "read":
                return httpx.Response(200, stream=_ReadErrorStream())
            if kind == "invalid":
                return httpx.Response(200, content=b"\xff")
            if kind == "cancel":
                cancellation.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        config = {
            "minimumQuoteValiditySeconds": 0,
            "localBuild": {
                "sourceSwapEndpoint": "https://price-api.mayan.finance/v3"
            },
        }
        if kind == "timeout":
            config["timeoutMs"] = 5
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = create_mayan_swift_v2_bridge_client(config, http_client=http_client)
        original_time = bridge_local_module.time.time
        source_deadline = next(
            record["normalizedQuote"]["deadline"]
            for record in cast(list[dict[str, object]], fixture["quotes"])
            if record["quoteId"] == source_entry["quoteId"]
        )
        bridge_local_module.time.time = lambda: float(source_deadline) - 1
        try:
            options = (
                RequestOptions(cancel_event=cancellation)
                if kind == "cancel"
                else RequestOptions()
            )
            await client.prepare_source_swap(context, options)
        except BridgeError as error:
            return error
        finally:
            bridge_local_module.time.time = original_time
            await client.close()
            await http_client.aclose()
        raise AssertionError("source transport case unexpectedly succeeded")

    async def run_rpc(kind: str) -> BridgeError:
        context = {
            "quote": _mutate_quote(
                quotes[cast(str, rpc_entry["quoteId"])], None
            ),
            "swapperAddress": cast(dict[str, object], rpc_entry["context"])[
                "swapperAddress"
            ],
            "destinationAddress": cast(dict[str, object], rpc_entry["context"])[
                "destinationAddress"
            ],
            "orderNonce": cast(dict[str, object], rpc_entry["context"])["orderNonce"],
            "sourceSwapPlan": _mutate_plan(
                plans[cast(str, rpc_entry["sourceSwapPlanRef"])], None
            ),
        }
        cancellation = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            if kind == "connect":
                raise httpx.ConnectError("sentinel credential=SYNTHETIC", request=request)
            if kind == "read":
                return httpx.Response(200, stream=_ReadErrorStream())
            if kind == "invalid":
                return httpx.Response(200, content=b"\xff")
            if kind == "cancel":
                cancellation.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        config = copy.deepcopy(cast(dict[str, object], rpc_entry["config"]))
        config["minimumQuoteValiditySeconds"] = 0
        if kind == "timeout":
            config["timeoutMs"] = 5
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = create_mayan_swift_v2_bridge_client(config, http_client=http_client)
        original_time = bridge_local_module.time.time
        bridge_local_module.time.time = lambda: float(
            next(
                record["normalizedQuote"]["deadline"]
                for record in cast(list[dict[str, object]], fixture["quotes"])
                if record["quoteId"] == rpc_entry["quoteId"]
            )
        ) - 1
        try:
            options = (
                RequestOptions(cancel_event=cancellation)
                if kind == "cancel"
                else RequestOptions()
            )
            await client.build_local_unsigned(context, options)
        except BridgeError as error:
            return error
        finally:
            bridge_local_module.time.time = original_time
            await client.close()
            await http_client.aclose()
        raise AssertionError("RPC transport case unexpectedly succeeded")

    for kind, code in (
        ("connect", BridgeErrorCode.PROVIDER_TRANSPORT),
        ("read", BridgeErrorCode.PROVIDER_TRANSPORT),
        ("timeout", BridgeErrorCode.TIMEOUT),
        ("cancel", BridgeErrorCode.ABORTED),
        ("invalid", BridgeErrorCode.PROVIDER_INVALID_RESPONSE),
    ):
        _assert_sanitized_bridge_error(await run_source(kind), code)
        rpc_code = {
            BridgeErrorCode.PROVIDER_TRANSPORT: BridgeErrorCode.SOURCE_RPC_TRANSPORT,
            BridgeErrorCode.PROVIDER_INVALID_RESPONSE: (
                BridgeErrorCode.SOURCE_RPC_INVALID_RESPONSE
            ),
        }.get(code, code)
        _assert_sanitized_bridge_error(
            await run_rpc(kind),
            rpc_code,
        )


@pytest.mark.asyncio
async def test_local_client_construction_performs_no_io() -> None:
    calls = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError("unexpected local request")

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {"localBuild": {"ethereumRpc": {"httpUrl": "https://ethereum.example/rpc"}}},
        http_client=http_client,
    )
    await client.close()
    assert calls == 0
    await http_client.aclose()


def test_native_edwards_zip215_and_pda_vectors() -> None:
    identity = b"\x01" + b"\0" * 31
    sign_one_at_x_zero = b"\x01" + b"\0" * 30 + b"\x80"
    noncanonical_y = (bridge_local_module._ED25519_P + 1).to_bytes(32, "little")
    invalid_square_root = (2).to_bytes(32, "little")
    assert bridge_local_module._is_on_curve_zip215(identity)
    assert bridge_local_module._is_on_curve_zip215(sign_one_at_x_zero)
    assert bridge_local_module._is_on_curve_zip215(noncanonical_y)
    assert not bridge_local_module._is_on_curve_zip215(invalid_square_root)

    program = bridge_local_module.SOLANA_SWIFT_PROGRAM
    derived, bump = bridge_local_module._find_program_address((b"seed",), program)
    assert bridge_local_module._canonical_solana_address(derived) == derived
    assert 0 <= bump <= 255
    with pytest.raises(bridge_local_module._LocalValidationError):
        bridge_local_module._find_program_address((b"x" * 33,), program)
    with pytest.raises(bridge_local_module._LocalValidationError):
        bridge_local_module._find_program_address((b"x",) * 17, program)

    assert bridge_local_module._associated_token_address(
        "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b",
        "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        False,
    ) == "7NtwRbkiepv2SwCPA3JRVLw1VYzDgf9nGThFqH5RGn2W"


@pytest.mark.asyncio
async def test_local_source_swap_timeout_covers_streamed_body_and_closes_it() -> None:
    record = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["quotes"])
        if item["quoteId"] == "0x7cc392912037d3040fc65db5596858a3"
    )
    case = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["cases"])
        if item["caseId"] == "prepare-eurc-ethereum-to-solana"
    )
    quote = cast(dict[str, object], record["normalizedQuote"])
    context = {
        "quote": quote,
        "swapperAddress": cast(dict[str, object], case["context"])["swapperAddress"],
        "destinationAddress": cast(dict[str, object], case["context"])["destinationAddress"],
        "orderNonce": cast(dict[str, object], case["context"])["orderNonce"],
    }
    started = asyncio.Event()
    stream = _TrackingByteStream([b"{"], stall=True)

    async def handler(_: httpx.Request) -> httpx.Response:
        started.set()
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {
            "timeoutMs": 20,
            "minimumQuoteValiditySeconds": 0,
            "localBuild": {
                "sourceSwapEndpoint": "https://price-api.mayan.finance/v3"
            },
        },
        http_client=http_client,
    )
    original_time = bridge_local_module.time.time
    bridge_local_module.time.time = lambda: float(quote["deadline"]) - 1
    try:
        with pytest.raises(BridgeError) as raised:
            await client.prepare_source_swap(context)
        assert raised.value.code is BridgeErrorCode.TIMEOUT
        assert started.is_set()
        assert stream.closed
    finally:
        bridge_local_module.time.time = original_time
        await client.close()
        await http_client.aclose()


@pytest.mark.asyncio
async def test_local_source_swap_abort_covers_streamed_body_and_closes_it() -> None:
    record = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["quotes"])
        if item["quoteId"] == "0x7cc392912037d3040fc65db5596858a3"
    )
    case = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["cases"])
        if item["caseId"] == "prepare-eurc-ethereum-to-solana"
    )
    quote = cast(dict[str, object], record["normalizedQuote"])
    context = {
        "quote": quote,
        "swapperAddress": cast(dict[str, object], case["context"])["swapperAddress"],
        "destinationAddress": cast(dict[str, object], case["context"])["destinationAddress"],
        "orderNonce": cast(dict[str, object], case["context"])["orderNonce"],
    }
    cancellation = asyncio.Event()
    stream = _TrackingByteStream([b"{"], cancel_event=cancellation, stall=True)

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {
            "timeoutMs": 1000,
            "minimumQuoteValiditySeconds": 0,
            "localBuild": {
                "sourceSwapEndpoint": "https://price-api.mayan.finance/v3"
            },
        },
        http_client=http_client,
    )
    original_time = bridge_local_module.time.time
    bridge_local_module.time.time = lambda: float(quote["deadline"]) - 1
    try:
        with pytest.raises(BridgeError) as raised:
            await client.prepare_source_swap(
                context, RequestOptions(cancel_event=cancellation)
            )
        assert raised.value.code is BridgeErrorCode.ABORTED
        assert stream.closed
    finally:
        bridge_local_module.time.time = original_time
        await client.close()
        await http_client.aclose()


@pytest.mark.asyncio
async def test_local_source_swap_stream_size_cap_closes_response() -> None:
    record = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["quotes"])
        if item["quoteId"] == "0x7cc392912037d3040fc65db5596858a3"
    )
    case = next(
        item
        for item in cast(list[dict[str, object]], _FIXTURE["cases"])
        if item["caseId"] == "prepare-eurc-ethereum-to-solana"
    )
    quote = cast(dict[str, object], record["normalizedQuote"])
    context = {
        "quote": quote,
        "swapperAddress": cast(dict[str, object], case["context"])["swapperAddress"],
        "destinationAddress": cast(dict[str, object], case["context"])["destinationAddress"],
        "orderNonce": cast(dict[str, object], case["context"])["orderNonce"],
    }
    stream = _TrackingByteStream([b"x" * 700_000, b"x" * 400_000])

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {
            "minimumQuoteValiditySeconds": 0,
            "localBuild": {
                "sourceSwapEndpoint": "https://price-api.mayan.finance/v3"
            },
        },
        http_client=http_client,
    )
    original_time = bridge_local_module.time.time
    bridge_local_module.time.time = lambda: float(quote["deadline"]) - 1
    try:
        with pytest.raises(BridgeError) as raised:
            await client.prepare_source_swap(context)
        assert raised.value.code is BridgeErrorCode.PROVIDER_INVALID_RESPONSE
        assert stream.consumed == 2
        assert stream.closed
    finally:
        bridge_local_module.time.time = original_time
        await client.close()
        await http_client.aclose()
