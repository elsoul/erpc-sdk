from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from erpc_sdk.base import (
    BaseClient,
    _SealedEvmHttpTransport,
    create_base_client,
    sealed_evm_transport_facts,
)
from erpc_sdk.config import RpcEndpointConfig
from erpc_sdk.errors import ErpcHttpError, ErpcJsonRpcError, ErpcNotConfiguredError

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACT = _ROOT / "registry" / "rpc-network-contract.json"


def _facts():
    return sealed_evm_transport_facts(json.loads(_CONTRACT.read_text()), "client-base-rpc")


def _response(request: httpx.Request, result: str) -> httpx.Response:
    body = json.loads(request.content)
    return httpx.Response(
        200,
        json={"jsonrpc": "2.0", "id": body["id"], "result": result},
    )


@pytest.mark.asyncio
async def test_base_direct_facade_preserves_target_scoped_headers_and_surface() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return _response(request, "0x2105")

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        params={"ambient": "must-not-forward"},
        headers={"X-Client-Default": "must-not-forward"},
        auth=httpx.BasicAuth("ambient-user", "ambient-pass"),
        cookies={"ambient-cookie": "must-not-forward"},
        follow_redirects=True,
    )
    direct = RpcEndpointConfig(
        "https://customer.example/base/path?token=a%2Fb&region=eu",
        headers={"authorization": "Bearer direct-secret", "x-chain-scope": "base-only"},
    )
    transport = _SealedEvmHttpTransport(
        facts=_facts(),
        direct_endpoint=direct,
        http_client=http,
        namespace="base.rpc",
    )
    client = create_base_client(transport)
    try:
        assert isinstance(client, BaseClient)
        assert await client.rpc.eth_chain_id().send() == "0x2105"
        assert await client.rpc.eth_get_balance("0xabc", "latest").send() == "0x2105"
        assert (
            await client.rpc.eth_call({"to": "0xabc"}, "latest", {"0xabc": {}}).send() == "0x2105"
        )
        assert len(received) == 3
        assert str(received[0].url) == "https://customer.example/base/path?token=a%2Fb&region=eu"
        assert all(
            request.headers["authorization"] == "Bearer direct-secret" for request in received
        )
        assert all(request.headers["x-chain-scope"] == "base-only" for request in received)
        assert all("x-client-default" not in request.headers for request in received)
        assert all("cookie" not in request.headers for request in received)
        assert all(request.url.params.get("ambient") is None for request in received)
        assert transport.endpoint == "https://customer.example/"
        assert {name for name in dir(client.rpc) if not name.startswith("_")} == {
            "endpoint",
            "eth_call",
            "eth_chain_id",
            "eth_get_balance",
        }
        request_bodies = [json.loads(request.content) for request in received]
        assert request_bodies[0]["params"] == []
        assert request_bodies[1]["params"] == ["0xabc", "latest"]
        assert request_bodies[2]["params"] == [{"to": "0xabc"}, "latest", {"0xabc": {}}]
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_base_hosted_root_uses_query_key_and_no_extra_suffix() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return _response(request, "0x2105")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = _SealedEvmHttpTransport(
        facts=_facts(),
        api_key="shared-secret",
        endpoint="https://edge.example/base?region=eu",
        headers={"x-global": "hosted-only"},
        http_client=http,
        namespace="base.rpc",
    )
    client = create_base_client(transport)
    try:
        await client.rpc.eth_chain_id().send()
        request = received[0]
        assert str(request.url) == "https://edge.example/base?region=eu&api-key=shared-secret"
        assert request.url.params["api-key"] == "shared-secret"
        assert request.headers["x-global"] == "hosted-only"
        assert transport.endpoint == "https://edge.example/"
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_base_unconfigured_and_redirect_are_local_and_single_attempt() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(307, headers={"location": "https://redirect.example/other"})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)
    unavailable = _SealedEvmHttpTransport(facts=_facts(), http_client=http, namespace="base.rpc")
    try:
        with pytest.raises(ErpcNotConfiguredError) as captured:
            await create_base_client(unavailable).rpc.eth_chain_id().send()
        assert captured.value.namespace == "base.rpc"
        assert request_count == 0
    finally:
        await unavailable.close()

    transport = _SealedEvmHttpTransport(
        facts=_facts(), api_key="key", http_client=http, namespace="base.rpc"
    )
    try:
        with pytest.raises(ErpcHttpError) as captured:
            await create_base_client(transport).rpc.eth_chain_id().send()
        assert captured.value.status == 307
        assert request_count == 1
    finally:
        await transport.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_base_rpc_error_redacts_direct_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": -32000,
                    "message": "node-secret",
                    "data": {"node-secret": "node-secret"},
                },
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    direct = RpcEndpointConfig(
        "https://customer.example/base?node-secret=encoded",
        headers={"authorization": "Bearer node-secret"},
    )
    transport = _SealedEvmHttpTransport(
        facts=_facts(), direct_endpoint=direct, http_client=http, namespace="base.rpc"
    )
    try:
        with pytest.raises(ErpcJsonRpcError) as captured:
            await create_base_client(transport).rpc.eth_chain_id().send()
        assert "node-secret" not in str(captured.value)
        assert "node-secret" not in repr(captured.value.data)
    finally:
        await transport.close()
        await http.aclose()
