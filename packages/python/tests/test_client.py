from __future__ import annotations

import base64
import json
from typing import cast

import httpx
import pytest

from erpc_sdk import (
    AVALANCHE_AVAX_METHODS,
    AVALANCHE_INDEX_METHODS,
    AVALANCHE_INFO_METHODS,
    AVALANCHE_P_CHAIN_METHODS,
    AVALANCHE_PROPOSER_VM_METHODS,
    AVALANCHE_X_CHAIN_METHODS,
    ErpcBatchPolicyError,
    ErpcClient,
    ErpcClientConfig,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
)
from erpc_sdk.config import websocket_url
from erpc_sdk.types import RpcBatchCall


def test_config_normalizes_endpoints_and_redacts_credential() -> None:
    config = ErpcClientConfig(
        " secret ",
        endpoint="https://example.test/rpc/?discard=yes#fragment",
        avalanche_endpoint="https://ava.example.test/c-chain/?discard=yes#fragment",
    )
    assert config.api_key == "secret"
    assert config.endpoint == "https://example.test/rpc"
    assert config.avalanche_endpoint == "https://ava.example.test/c-chain"
    assert websocket_url(
        config.avalanche_endpoint, "socket key", "/ava-ws"
    ) == "wss://ava.example.test/c-chain/ava-ws?api-key=socket%20key"
    assert "secret" not in repr(config)
    assert "[REDACTED]" in repr(config)


@pytest.mark.asyncio
async def test_avalanche_uses_the_c_chain_endpoint() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        assert body["method"] == "eth_chainId"
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": "0xa86a"},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("api key"), http_client=http)
    assert await erpc.avalanche.rpc.eth_chain_id().send() == "0xa86a"
    assert received[0].url.host == "ava-rpc.erpc.global"
    assert received[0].url.path == "/ava"
    assert received[0].url.params["api-key"] == "api key"
    assert "api-key" not in erpc.avalanche.rpc.endpoint
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_avalanche_native_and_index_namespaces_preserve_wire_routes() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": body["method"]},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("api key"), http_client=http)
    assert await erpc.avalanche.p_chain.get_height().send() == "platform.getHeight"
    assert (
        await erpc.avalanche.index.x_chain_transactions.get_container_by_id(
            {"id": "tx-id"}
        ).send()
        == "index.getContainerByID"
    )
    assert received[0].url.path == "/ava"
    assert received[1].url.path == "/ava/ext/index/X/tx"
    assert json.loads(received[1].content)["params"] == {"id": "tx-id"}
    with pytest.raises(ErpcBatchPolicyError):
        erpc.avalanche.x_chain.batch([{"method": "getHeight"}])
    await erpc.close()
    await http.aclose()


def test_avalanche_method_catalogs_cover_native_apis() -> None:
    assert len(AVALANCHE_AVAX_METHODS) == 4
    assert len(AVALANCHE_X_CHAIN_METHODS) == 11
    assert len(AVALANCHE_P_CHAIN_METHODS) == 26
    assert len(AVALANCHE_PROPOSER_VM_METHODS) == 2
    assert len(AVALANCHE_INFO_METHODS) == 1
    assert len(AVALANCHE_INDEX_METHODS) == 6


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


@pytest.mark.asyncio
async def test_solana_v1_transaction_options_and_opaque_responses() -> None:
    received: list[dict[str, object]] = []
    transaction_v1 = {
        "slot": 123_456,
        "blockTime": 1_700_000_001,
        "meta": {
            "err": None,
            "fee": 5_000,
            "computeUnitsConsumed": 80_000,
            "unrelatedMetaField": {"preserve": [True, 7]},
        },
        "transaction": {
            "signatures": ["synthetic-signature"],
            "message": {
                "accountKeys": ["synthetic-account"],
                "instructions": [],
                "recentBlockhash": "synthetic-blockhash",
                "transactionConfig": {
                    "computeUnitLimit": 1_400_000,
                    "loadedAccountsDataSizeLimit": 64_000,
                    "heapSize": None,
                    "priorityFee": None,
                    "unrelatedConfigField": "preserve",
                },
                "unrelatedMessageField": {"keep": "opaque"},
            },
            "unrelatedTransactionField": ["preserve", 9],
        },
        "version": 1,
        "unrelatedTopLevelField": {"keep": "opaque"},
    }
    block_v1 = {
        "blockhash": "synthetic-blockhash",
        "blockTime": 1_700_000_001,
        "blockHeight": 98_765,
        "parentSlot": 123_455,
        "previousBlockhash": "synthetic-previous-blockhash",
        "rewards": [],
        "signatures": ["synthetic-signature"],
        "transactions": [
            {
                "meta": {
                    "err": None,
                    "fee": 5_000,
                    "computeUnitsConsumed": 80_000,
                    "unrelatedMetaField": {"preserve": [True, 7]},
                },
                "transaction": {
                    "signatures": ["synthetic-signature"],
                    "message": {
                        "accountKeys": ["synthetic-account"],
                        "instructions": [],
                        "recentBlockhash": "synthetic-blockhash",
                        "transactionConfig": {
                            "computeUnitLimit": 1_400_000,
                            "loadedAccountsDataSizeLimit": 64_000,
                            "heapSize": None,
                            "priorityFee": 5_000,
                            "unrelatedConfigField": "preserve",
                        },
                        "unrelatedMessageField": {"keep": "opaque"},
                    },
                    "unrelatedTransactionField": ["preserve", 9],
                },
                "version": 1,
                "unrelatedTransactionEnvelopeField": "preserve",
            }
        ],
        "unrelatedTopLevelField": {"keep": "opaque"},
    }
    legacy = {
        "slot": 123_457,
        "transaction": {
            "signatures": [],
            "message": {
                "accountKeys": [],
                "instructions": [],
                "recentBlockhash": "legacy-blockhash",
            },
        },
        "version": "legacy",
        "unrelatedField": "preserve",
    }
    v0 = {
        "slot": 123_458,
        "transaction": {
            "signatures": [],
            "message": {
                "accountKeys": [],
                "instructions": [],
                "recentBlockhash": "v0-blockhash",
            },
        },
        "version": 0,
        "unrelatedField": {"preserve": True},
    }
    assert "transactionConfig" not in legacy["transaction"]["message"]
    assert "transactionConfig" not in v0["transaction"]["message"]

    transaction_options = {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
    }
    block_options = {
        "commitment": "finalized",
        "encoding": "jsonParsed",
        "transactionDetails": "full",
        "rewards": True,
        "maxSupportedTransactionVersion": 1,
    }
    responses = {
        ("getTransaction", "v1-signature"): transaction_v1,
        ("getBlock", 123_456): block_v1,
        ("getTransaction", "v0-signature"): v0,
        ("getBlock", 123_458): v0,
        ("getTransaction", "legacy-signature"): legacy,
        ("getBlock", 123_457): legacy,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        received.append(body)
        if (
            body["method"] in {"getTransaction", "getBlock"}
            and len(body["params"]) == 2
        ):
            version = body["params"][1]["maxSupportedTransactionVersion"]
            assert type(version) is int
            if body["params"][0] in {"v1-signature", 123_456}:
                assert version == 1
            else:
                assert version == 0
        result = responses[(body["method"], body["params"][0])]
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    assert await erpc.solana.rpc.get_transaction(
        "v1-signature", transaction_options
    ).send() == transaction_v1
    assert await erpc.solana.rpc.get_block(123_456, block_options).send() == block_v1
    assert await erpc.solana.rpc.get_transaction(
        "v0-signature", {"maxSupportedTransactionVersion": 0}
    ).send() == v0
    assert await erpc.solana.rpc.get_block(
        123_458, {"maxSupportedTransactionVersion": 0}
    ).send() == v0
    assert await erpc.solana.rpc.get_transaction("legacy-signature").send() == legacy
    assert await erpc.solana.rpc.get_block(123_457).send() == legacy

    assert [(body["method"], body["params"]) for body in received] == [
        ("getTransaction", ["v1-signature", transaction_options]),
        ("getBlock", [123_456, block_options]),
        ("getTransaction", ["v0-signature", {"maxSupportedTransactionVersion": 0}]),
        ("getBlock", [123_458, {"maxSupportedTransactionVersion": 0}]),
        ("getTransaction", ["legacy-signature"]),
        ("getBlock", [123_457]),
    ]
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_solana_transaction_submission_forwards_base64_once() -> None:
    # Synthetic opaque transport fixture: NOT a valid signed transaction and NOT
    # proof of chain acceptance.
    transaction = "A" * 5462 + "=="
    received: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        received.append(body)
        result: object = (
            "synthetic-signature"
            if body["method"] == "sendTransaction"
            else {"value": ["synthetic"], "err": None}
        )
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    options = {"encoding": "base64"}
    assert await erpc.solana.rpc.send_transaction(transaction, options).send() == (
        "synthetic-signature"
    )
    assert await erpc.solana.rpc.simulate_transaction(transaction, options).send() == {
        "value": ["synthetic"],
        "err": None,
    }

    assert len(transaction) == 5464
    assert base64.b64decode(transaction, validate=True) == bytes(4096)
    assert [body["method"] for body in received] == [
        "sendTransaction",
        "simulateTransaction",
    ]
    assert len(received) == 2
    assert all(body["params"] == [transaction, options] for body in received)
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_solana_transaction_version_error_surfaces_once_without_retry() -> None:
    received: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        received.append(body)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": -32015,
                    "message": "transaction version is not supported",
                    "data": {"maxSupportedTransactionVersion": 1, "retryable": False},
                },
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("key"), http_client=http)
    with pytest.raises(ErpcJsonRpcError) as captured:
        await erpc.solana.rpc.get_transaction(
            "unsupported-signature", {"maxSupportedTransactionVersion": 1}
        ).send()
    assert captured.value.rpc_code == -32015
    assert captured.value.data == {
        "maxSupportedTransactionVersion": 1,
        "retryable": False,
    }
    assert len(received) == 1
    assert received[0]["method"] == "getTransaction"
    await erpc.close()
    await http.aclose()
