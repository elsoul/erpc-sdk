from __future__ import annotations

import asyncio
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from erpc_sdk.bitcoin import BitcoinPendingRequest, create_bitcoin_client
from erpc_sdk.bitcoin_codec import BitcoinResponseLimits
from erpc_sdk.bitcoin_transport import BitcoinHttpTransport, bitcoin_transport_facts
from erpc_sdk.config import RpcEndpointConfig
from erpc_sdk.errors import (
    ErpcAbortedError,
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcNotConfiguredError,
    ErpcTimeoutError,
    ErpcTransportError,
)
from erpc_sdk.types import RequestOptions

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACT = _ROOT / "registry" / "rpc-network-contract.json"


def _facts():
    return bitcoin_transport_facts(json.loads(_CONTRACT.read_text()))


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], *, gate: asyncio.Event | None = None) -> None:
        self._chunks = chunks
        self._gate = gate
        self.started = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        if self._gate is not None:
            await self._gate.wait()
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class _FailStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        raise httpx.ReadError(
            "native stream failure",
            request=httpx.Request("POST", "https://example.invalid/"),
        )
        if False:
            yield b""


def _response(request: httpx.Request, *, result: object) -> httpx.Response:
    body = json.loads(request.content)
    return httpx.Response(
        200,
        json={"jsonrpc": "2.0", "id": body["id"], "result": result},
    )


@pytest.mark.asyncio
async def test_direct_bitcoin_named_reads_preserve_target_headers_and_exact_values() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        if body["method"] == "getblockcount":
            return _response(request, result=18_446_744_073_709_551_615)
        if body["method"] == "gettxout":
            return _response(request, result=None)
        return _response(request, result={"value": 1.2300, "tiny": 1e-1000})

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        params={"ambient": "must-not-forward"},
        headers={"X-Client-Default": "must-not-forward"},
        auth=httpx.BasicAuth("ambient-user", "ambient-pass"),
        cookies={"ambient-cookie": "must-not-forward"},
        follow_redirects=True,
    )
    endpoint = RpcEndpointConfig(
        "https://customer.example/customer/path?token=a%2Fb&region=eu",
        headers={"authorization": "Bearer direct-secret", "x-node-scope": "bitcoin-only"},
    )
    transport = BitcoinHttpTransport(facts=_facts(), direct_endpoint=endpoint, http_client=http)
    client = create_bitcoin_client(transport)
    try:
        assert await client.rpc.get_block_count().send() == 18_446_744_073_709_551_615
        assert await client.rpc.get_tx_out("tx", 0).send() is None
        result = await client.rpc.get_block("block", 2).send()
        assert result["value"] == Decimal("1.23")
        assert len(received) == 3
        assert (
            str(received[0].url) == "https://customer.example/customer/path?token=a%2Fb&region=eu"
        )
        assert all(
            request.headers["authorization"] == "Bearer direct-secret" for request in received
        )
        assert all(request.headers["x-node-scope"] == "bitcoin-only" for request in received)
        assert all("x-client-default" not in request.headers for request in received)
        assert all("cookie" not in request.headers for request in received)
        assert all(request.url.params.get("ambient") is None for request in received)
        assert all(
            request.headers.get("content-type") == "application/json" for request in received
        )
        assert transport.endpoint == "https://customer.example/"
        assert "request" not in {name for name in dir(client.rpc) if not name.startswith("_")}
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_hosted_bitcoin_uses_bearer_without_api_key_query_or_global_authorization() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return _response(request, result="0000000000000000000")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(
        facts=_facts(),
        api_key="shared-secret",
        endpoint="https://edge.example/base?api-key=stale&region=eu",
        headers={"authorization": "Bearer global-secret", "x-global": "hosted-only"},
        http_client=http,
    )
    client = create_bitcoin_client(transport)
    try:
        assert await client.rpc.get_best_block_hash().send() == "0000000000000000000"
        request = received[0]
        body = json.loads(request.content)
        assert body["method"] == "getbestblockhash"
        assert body["params"] == []
        assert str(request.url) == "https://edge.example/base/bitcoin?region=eu"
        assert request.headers["authorization"] == "Bearer shared-secret"
        assert request.headers["x-global"] == "hosted-only"
        assert request.url.params.get("api-key") is None
        assert transport.endpoint == "https://edge.example/"
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_bitcoin_public_surface_has_exact_named_methods_and_positional_params() -> None:
    received: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        received.append(body)
        return _response(request, result="0x01")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", http_client=http)
    client = create_bitcoin_client(transport)
    try:
        public = {name for name in dir(client.rpc) if not name.startswith("_")}
        assert public == {
            "endpoint",
            "estimate_smart_fee",
            "get_best_block_hash",
            "get_block",
            "get_block_hash",
            "get_block_header",
            "get_block_count",
            "get_blockchain_info",
            "get_mempool_info",
            "get_network_info",
            "get_raw_mempool",
            "get_raw_transaction",
            "get_tx_out",
        }
        pending = client.rpc.get_best_block_hash()
        assert isinstance(pending, BitcoinPendingRequest)
        assert received == []
        await pending.send()
        await client.rpc.get_block("hash", 2).send()
        assert received[0]["params"] == []
        assert received[1]["params"] == ["hash", 2]
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_unconfigured_bitcoin_fails_locally_without_io() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(facts=_facts(), http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcNotConfiguredError) as captured:
            await client.rpc.get_block_count().send()
        assert captured.value.namespace == "bitcoin.rpc"
        assert request_count == 0
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_redirect_is_surfaced_as_http_error_without_following() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(307, headers={"location": "https://redirect.example/other"})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcHttpError) as captured:
            await client.rpc.get_network_info().send()
        assert captured.value.status == 307
        assert len(received) == 1
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_stream_limit_uses_decoded_bytes_and_closes_real_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = _ChunkStream([b"1234"])

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": "1"}, stream=stream)

    monkeypatch.setattr(
        "erpc_sdk.bitcoin_transport.BITCOIN_RESPONSE_LIMITS",
        BitcoinResponseLimits(decoded_entity_bytes=3),
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcInvalidResponseError):
            await client.rpc.get_network_info().send()
        assert stream.closed
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_native_stream_failure_is_transport_without_native_context() -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=_FailStream()))
    )
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcTransportError) as captured:
            await client.rpc.get_network_info().send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_invalid_utf8_response_has_no_native_context() -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"\xff"))
    )
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcInvalidResponseError) as captured:
            await client.rpc.get_network_info().send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_timeout_cancels_body_read_and_closes_stream() -> None:
    gate = asyncio.Event()
    stream = _ChunkStream([b'{"id":1,"result":null}'], gate=gate)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", timeout=0.01, http_client=http)
    client = create_bitcoin_client(transport)
    try:
        with pytest.raises(ErpcTimeoutError):
            await client.rpc.get_network_info().send()
        assert stream.closed
    finally:
        gate.set()
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_caller_cancellation_cancels_body_read_and_closes_stream() -> None:
    gate = asyncio.Event()
    stream = _ChunkStream([b'{"id":1,"result":null}'], gate=gate)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = BitcoinHttpTransport(facts=_facts(), api_key="key", timeout=1, http_client=http)
    client = create_bitcoin_client(transport)
    cancel = asyncio.Event()
    task = asyncio.create_task(
        client.rpc.get_network_info().send(RequestOptions(cancel_event=cancel))
    )
    try:
        await stream.started.wait()
        cancel.set()
        with pytest.raises(ErpcAbortedError):
            await task
        assert stream.closed
    finally:
        gate.set()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await transport.close()
        await http.aclose()


def test_websocket_direct_override_is_rejected_before_io() -> None:
    with pytest.raises(ErpcConfigError):
        BitcoinHttpTransport(
            facts=_facts(),
            direct_endpoint=RpcEndpointConfig(
                "https://rpc.example/bitcoin", websocket_url="wss://rpc.example/bitcoin"
            ),
        )
