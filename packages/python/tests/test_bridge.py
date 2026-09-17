"""Literal fixture replay for the standalone Mayan bridge client."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

import erpc_sdk.bridge as bridge_module
from erpc_sdk import (
    BRIDGE_CAPABILITIES_AS_OF_DATE,
    BRIDGE_CAPABILITIES_CONTENT_DIGEST,
    BridgeError,
    create_mayan_swift_v2_bridge_client,
)
from erpc_sdk.types import RequestOptions

_FIXTURE_PATH = Path(__file__).parents[3] / "registry/fixtures/mayan-swift-v2-cases.json"
_FIXTURE = json.loads(_FIXTURE_PATH.resolve().read_text(encoding="utf-8"))
_FROZEN_LEGACY_FIXTURE_CASE_IDS = (
    "quote-eth-sol-synthetic",
    "quote-sol-eth-synthetic",
    "build-eth-sol-synthetic",
    "build-sol-eth-synthetic",
    "status-eth-inprogress-synthetic",
    "status-eth-completed-synthetic",
    "status-sol-refunded-synthetic",
    "status-sol-unknown-synthetic",
    "status-eth-not-found-synthetic",
    "quote-duplicate-key",
    "quote-malformed-json",
    "quote-expired",
    "quote-mismatched-amount",
    "quote-bad-signature-shape",
    "quote-json-depth-limit",
    "quote-body-size-limit",
    "quote-unsupported-route",
    "build-auth-required-local",
    "build-quote-mismatch",
    "build-evm-forwarder-violation",
    "build-evm-selector-violation",
    "build-evm-value-violation",
    "build-solana-framing-violation",
    "build-solana-fee-payer-violation",
    "build-solana-extra-signer-violation",
    "build-solana-swap-message-violation",
    "build-http-auth-401",
    "build-http-rate-limit-429",
    "quote-redirect-rejected",
    "quote-timeout",
    "quote-aborted",
    "status-invalid-evm-hash",
    "status-invalid-provider-fields",
    "build-eth-sol-wrong-evm-destination",
    "build-sol-eth-wrong-solana-destination",
    "quote-eth-sol-zero-validity-margin",
)


def _response(body: str | None, status: int) -> httpx.Response:
    if body == "__SYNTHETIC_BODY_EXCEEDS_1MIB__":
        body = "x" * (1024 * 1024 + 1)
    return httpx.Response(status, content=b"" if body is None else body.encode("utf-8"))


def _trace_entry(request: httpx.Request) -> dict[str, object]:
    headers = {name.lower(): value for name, value in request.headers.items()}
    assert "authorization" not in headers
    assert "cookie" not in headers
    for ignored in ("host", "content-length", "user-agent"):
        headers.pop(ignored, None)
    return {
        "method": request.method,
        "url": str(request.url),
        "headers": headers,
        "body": request.content.decode("utf-8") if request.content else None,
    }


def _apply_quote_mutation(
    quote: dict[str, object], mutation: dict[str, object] | None
) -> dict[str, object]:
    if mutation is None:
        return quote
    value = cast(dict[str, object], json.loads(json.dumps(quote, separators=(",", ":"))))
    kind = mutation.get("kind")
    if kind == "normalized-set":
        path = mutation.get("path")
        mutation_value = mutation.get("value")
        if path == "sourceSwap.required" and mutation_value is True:
            source_swap = cast(dict[str, object], value["sourceSwap"])
            source_swap["required"] = True
            return value
        if path == "sourceTokenDeploymentId" and mutation_value in {
            "deployment-0008",
            "deployment-0011",
        }:
            value["sourceTokenDeploymentId"] = mutation_value
            return value
        raise AssertionError("unsupported normalized bridge quote mutation")
    if kind == "raw-replace":
        if mutation.get("path") != "rawSignedQuoteJson":
            raise AssertionError("unsupported raw bridge quote mutation")
        raw = cast(str, value["rawSignedQuoteJson"])
        source = mutation.get("from")
        replacement = mutation.get("to")
        if not isinstance(source, str) or not isinstance(replacement, str) or source not in raw:
            raise AssertionError("raw quote mutation source was not found")
        value["rawSignedQuoteJson"] = raw.replace(source, replacement, 1)
        return value
    raise AssertionError("unsupported bridge quote mutation")


class _TrackingByteStream(httpx.AsyncByteStream):
    def __init__(
        self,
        chunks: list[bytes],
        *,
        started: asyncio.Event | None = None,
        cancel_event: asyncio.Event | None = None,
        stall: bool = False,
    ) -> None:
        self._chunks = chunks
        self._started = started
        self._cancel_event = cancel_event
        self._stall = stall
        self.consumed = 0
        self.closed = False

    async def __aiter__(self) -> Any:
        for chunk in self._chunks:
            self.consumed += 1
            if self._started is not None:
                self._started.set()
            yield chunk
            if self._cancel_event is not None:
                self._cancel_event.set()
            if self._stall:
                await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.closed = True


async def _run_case(
    entry: dict[str, Any],
    quotes: dict[str, dict[str, object]],
) -> tuple[dict[str, object], list[dict[str, object]]]:
    previous_time = bridge_module.time.time
    bridge_module.time.time = lambda: float(entry["nowSeconds"])
    trace: list[dict[str, object]] = []
    cancellation = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        trace.append(_trace_entry(request))
        if entry["caseId"] == "quote-timeout":
            await asyncio.Event().wait()
        if entry["caseId"] == "quote-aborted":
            cancellation.set()
            await asyncio.Event().wait()
        if entry["providerBody"] is None and entry["providerStatus"] is None:
            raise AssertionError("local bridge rejection must not reach the provider")
        status = entry["providerStatus"]
        return _response(entry["providerBody"], 200 if status is None else status)

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        auth=httpx.BasicAuth("inherited-user", "inherited-secret"),
        headers={"authorization": "Bearer inherited-header"},
        cookies={"inherited": "cookie"},
    )
    config = dict(entry["config"] or {})
    if entry["caseId"] == "quote-timeout":
        config["timeoutMs"] = 1
    client = create_mayan_swift_v2_bridge_client(config, http_client=http_client)
    try:
        if entry["method"] == "quote":
            options = (
                RequestOptions(cancel_event=cancellation)
                if entry["caseId"] == "quote-aborted"
                else RequestOptions()
            )
            value = await client.quote_exact_input(entry["request"], options)
            if value:
                quotes[entry["caseId"]] = cast(dict[str, object], value[0])
            outcome: dict[str, object] = {"kind": "success", "value": value}
        elif entry["method"] == "build":
            request = dict(entry["request"])
            request["quote"] = _apply_quote_mutation(
                quotes[entry["quoteCaseId"]], entry.get("quoteMutation")
            )
            value = await client.build_unsigned(request)
            outcome = {"kind": "success", "value": value}
        else:
            value = await client.get_status(entry["request"])
            outcome = {"kind": "success", "value": value}
    except BridgeError as error:
        outcome = {
            "kind": "sdk-error",
            "code": error.code.value,
            "message": str(error),
        }
        if error.status is not None:
            outcome["status"] = error.status
    finally:
        await client.close()
        assert not http_client.is_closed
        await http_client.aclose()
        bridge_module.time.time = previous_time
    return outcome, trace


@pytest.mark.asyncio
async def test_bridge_replays_literal_fixture() -> None:
    assert _FIXTURE["schemaVersion"] == 1
    assert _FIXTURE["fixtureKind"] == "mayan-swift-v2-fixtures"
    assert _FIXTURE["capabilityAsOfDate"] == BRIDGE_CAPABILITIES_AS_OF_DATE
    assert _FIXTURE["capabilityDigest"] == BRIDGE_CAPABILITIES_CONTENT_DIGEST
    quotes: dict[str, dict[str, object]] = {}
    for entry in _FIXTURE["cases"]:
        outcome, trace = await _run_case(entry, quotes)
        assert outcome == entry["expected"], entry["caseId"]
        assert trace == entry["httpTrace"], entry["caseId"]


def test_bridge_preserves_frozen_legacy_fixture_cases_and_order() -> None:
    selected = [
        next(
            entry for entry in _FIXTURE["cases"] if entry["caseId"] == case_id
        )
        for case_id in _FROZEN_LEGACY_FIXTURE_CASE_IDS
    ]
    assert [entry["caseId"] for entry in selected] == list(_FROZEN_LEGACY_FIXTURE_CASE_IDS)
    encoded = json.dumps(selected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert hashlib.sha256(encoded).hexdigest() == (
        "dce10a654672921bc4b26d4d14312abe81c0b93ac1de3fce48be3bd5beb7e5ee"
    )


@pytest.mark.asyncio
async def test_bridge_constructs_without_io_and_close_is_idempotent() -> None:
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(http_client=http_client)
    await client.close()
    await client.close()
    assert calls == 0
    assert not http_client.is_closed
    await http_client.aclose()


@pytest.mark.asyncio
async def test_bridge_timeout_ms_is_converted_once_and_conflicts_are_rejected() -> None:
    client = create_mayan_swift_v2_bridge_client({"timeoutMs": 20})
    try:
        assert client._config.timeout == pytest.approx(0.02)  # type: ignore[attr-defined]
        with pytest.raises(BridgeError) as raised:
            create_mayan_swift_v2_bridge_client({"timeout": 1, "timeoutMs": 20})
        assert raised.value.code.value == "BRIDGE_INVALID_ARGUMENT"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_bridge_stops_consuming_an_oversized_stream_and_closes_response() -> None:
    stream = _TrackingByteStream([b"x" * 700_000] * 4)

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(http_client=http_client)
    try:
        with pytest.raises(BridgeError) as raised:
            await client.quote_exact_input(_FIXTURE["cases"][0]["request"])
        assert raised.value.code.value == "BRIDGE_PROVIDER_INVALID_RESPONSE"
        assert stream.consumed == 2
        assert stream.closed
    finally:
        await client.close()
        await http_client.aclose()


@pytest.mark.asyncio
async def test_bridge_timeout_covers_a_stalled_response_body_and_closes_it() -> None:
    started = asyncio.Event()
    stream = _TrackingByteStream([b"{"], started=started, stall=True)

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {"timeoutMs": 20}, http_client=http_client
    )
    try:
        assert client._config.timeout == pytest.approx(0.02)  # type: ignore[attr-defined]
        with pytest.raises(BridgeError) as raised:
            await client.quote_exact_input(_FIXTURE["cases"][0]["request"])
        assert raised.value.code.value == "BRIDGE_TIMEOUT"
        assert started.is_set()
        assert stream.closed
        assert "secret" not in repr(raised.value)
    finally:
        await client.close()
        await http_client.aclose()


@pytest.mark.asyncio
async def test_bridge_cancellation_covers_a_stalled_response_body_and_closes_it() -> None:
    started = asyncio.Event()
    cancellation = asyncio.Event()
    stream = _TrackingByteStream(
        [b"{"], started=started, cancel_event=cancellation, stall=True
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = create_mayan_swift_v2_bridge_client(
        {"timeoutMs": 1}, http_client=http_client
    )
    try:
        with pytest.raises(BridgeError) as raised:
            await client.quote_exact_input(
                _FIXTURE["cases"][0]["request"],
                RequestOptions(cancel_event=cancellation),
            )
        assert raised.value.code.value == "BRIDGE_ABORTED"
        assert started.is_set()
        assert stream.closed
    finally:
        await client.close()
        await http_client.aclose()


@pytest.mark.asyncio
async def test_bridge_writes_native_capture_when_requested() -> None:
    output_path = os.environ.get("ERPC_SDK_BRIDGE_PARITY_OUTPUT")
    if not output_path:
        return
    quotes: dict[str, dict[str, object]] = {}
    behavior: dict[str, list[dict[str, object]]] = {"quote": [], "build": [], "status": []}
    for entry in _FIXTURE["cases"]:
        outcome, trace = await _run_case(entry, quotes)
        behavior[entry["method"]].append(
            {"caseId": entry["caseId"], "outcome": outcome, "httpTrace": trace}
        )
    for rows in behavior.values():
        rows.sort(key=lambda row: cast(str, row["caseId"]))
    snapshot = {
        "snapshotVersion": 1,
        "snapshotKind": "bridge-native-runtime",
        "language": "python",
        "runtime": f"python-{platform.python_version()}",
        "capabilityAsOfDate": BRIDGE_CAPABILITIES_AS_OF_DATE,
        "capabilityDigest": BRIDGE_CAPABILITIES_CONTENT_DIGEST,
        "behavior": behavior,
    }
    Path(output_path).write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
