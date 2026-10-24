from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from erpc_sdk.arbitrum import ArbitrumClient, ArbitrumRpcClient, create_arbitrum_client
from erpc_sdk.base import _SealedEvmHttpTransport, sealed_evm_transport_facts
from erpc_sdk.config import RpcEndpointConfig

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACT = _ROOT / "registry" / "rpc-network-contract.json"


def _facts():
    return sealed_evm_transport_facts(json.loads(_CONTRACT.read_text()), "client-arbitrum-rpc")


@pytest.mark.asyncio
async def test_arbitrum_direct_facade_uses_exact_three_read_methods() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": "0xa4b1"},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    transport = _SealedEvmHttpTransport(
        facts=_facts(),
        direct_endpoint=RpcEndpointConfig(
            "https://customer.example/arbitrum/path?token=a%2Fb",
            headers={"x-chain-scope": "arbitrum-only"},
        ),
        http_client=http,
        namespace="arbitrum.rpc",
    )
    client = create_arbitrum_client(transport)
    try:
        assert isinstance(client, ArbitrumClient)
        assert isinstance(client.rpc, ArbitrumRpcClient)
        assert not hasattr(client.rpc, "__dict__")
        assert await client.rpc.eth_chain_id().send() == "0xa4b1"
        assert await client.rpc.eth_get_balance("0xabc").send() == "0xa4b1"
        assert await client.rpc.eth_call({"to": "0xabc"}).send() == "0xa4b1"
        assert [json.loads(request.content)["method"] for request in received] == [
            "eth_chainId",
            "eth_getBalance",
            "eth_call",
        ]
        assert [json.loads(request.content)["params"] for request in received] == [
            [],
            ["0xabc"],
            [{"to": "0xabc"}],
        ]
        assert all(
            str(request.url) == "https://customer.example/arbitrum/path?token=a%2Fb"
            for request in received
        )
        assert transport.endpoint == "https://customer.example/"
    finally:
        await transport.close()
        await http.aclose()
