from __future__ import annotations

import json
from typing import cast

import httpx
import pytest

from erpc_sdk import (
    ErpcBatchPolicyError,
    ErpcClient,
    ErpcClientConfig,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
)
from erpc_sdk.types import RpcBatchCall


def test_config_normalizes_endpoints_and_redacts_credential() -> None:
    config = ErpcClientConfig(" secret ", endpoint="https://example.test/rpc/?discard=yes#fragment")
    assert config.api_key == "secret"
    assert config.endpoint == "https://example.test/rpc"
    assert "secret" not in repr(config)
    assert "[REDACTED]" in repr(config)


@pytest.mark.asyncio
async def test_request_is_inert_and_uses_exact_wire_method() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        assert body["method"] == "getBalance"
        assert body["params"] == ["address", {"commitment": "finalized"}]
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": {"value": 42}},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig("api key", endpoint="https://example.test"),
        http_client=http,
    )
    pending = erpc.solana.rpc.get_balance("address", {"commitment": "finalized"})
    assert received == []
    assert await pending.send() == {"value": 42}
    assert received[0].url.params["api-key"] == "api key"
    assert "api-key" not in erpc.solana.rpc.endpoint
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_batch_is_intact_and_restores_caller_order() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        body = json.loads(request.content)
        assert isinstance(body, list)
        return httpx.Response(
            200,
            json=[
                {"jsonrpc": "2.0", "id": body[1]["id"], "result": 200},
                {"jsonrpc": "2.0", "id": body[0]["id"], "result": 100},
            ],
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    calls: list[RpcBatchCall] = [
        {"method": "getSlot", "params": []},
        {"method": "getBlockHeight", "params": []},
    ]
    assert await erpc.solana.rpc.batch(calls).send() == [100, 200]
    assert request_count == 1
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_generic_raw_supports_forward_compatible_method() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["method"] == "futureMethod"
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": "ok"})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)

    def decoder(value: object) -> str:
        return cast(str, value).upper()

    assert await erpc.solana.rpc.raw("futureMethod", {}, decoder=decoder).send() == "OK"
    await erpc.close()
    await http.aclose()


def test_batch_policies_are_rejected_before_network_io() -> None:
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500)))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    with pytest.raises(ErpcBatchPolicyError):
        erpc.solana.rpc.batch(
            [
                {"method": "getSlot", "params": []},
                {"method": "getProgramAccounts", "params": ["address"]},
            ]
        )
    with pytest.raises(ErpcBatchPolicyError):
        erpc.solana.leaders.batch([{"method": "getLeaderSlots", "params": []}])


@pytest.mark.asyncio
async def test_batch_limit_is_enforced_without_splitting() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    calls = cast(list[RpcBatchCall], [{"method": "eth_chainId"}] * 257)
    with pytest.raises(ErpcInvalidResponseError):
        await erpc.ethereum.rpc.batch(calls).send()
    assert request_count == 0
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_rpc_error_redacts_raw_and_encoded_credentials() -> None:
    credential = "s e/c"

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": -32000,
                    "message": f"failed for {credential} and s+e%2Fc",
                    "data": {"url": "https://example.test?api-key=s%20e%2Fc"},
                },
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig(credential), http_client=http)
    with pytest.raises(ErpcJsonRpcError) as captured:
        await erpc.ethereum.rpc.eth_chain_id().send()
    error = captured.value
    rendered = f"{error} {error.data}"
    assert credential not in rendered
    assert "s+e%2Fc" not in rendered
    assert "s%20e%2Fc" not in rendered
    assert rendered.count("[REDACTED]") == 3
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_duplicate_batch_ids_are_invalid() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json=[
                {"jsonrpc": "2.0", "id": body[0]["id"], "result": 1},
                {"jsonrpc": "2.0", "id": body[0]["id"], "result": 2},
            ],
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    calls: list[RpcBatchCall] = [
        {"method": "eth_chainId"},
        {"method": "eth_blockNumber"},
    ]
    with pytest.raises(ErpcInvalidResponseError, match="duplicate"):
        await erpc.ethereum.rpc.batch(calls).send()
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_unexpected_batch_id_is_invalid_and_not_exposed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json=[
                {"jsonrpc": "2.0", "id": body[0]["id"], "result": 1},
                {"jsonrpc": "2.0", "id": body[1]["id"], "result": 2},
                {"jsonrpc": "2.0", "id": 999_999, "result": 3},
            ],
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    calls: list[RpcBatchCall] = [
        {"method": "eth_chainId"},
        {"method": "eth_blockNumber"},
    ]
    with pytest.raises(ErpcInvalidResponseError, match="unexpected") as captured:
        await erpc.ethereum.rpc.batch(calls).send()
    assert "999999" not in str(captured.value)
    await erpc.close()
    await http.aclose()
