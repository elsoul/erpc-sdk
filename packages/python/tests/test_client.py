from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

from erpc_sdk import (
    AVALANCHE_AVAX_METHODS,
    AVALANCHE_INDEX_METHODS,
    AVALANCHE_INFO_METHODS,
    AVALANCHE_P_CHAIN_METHODS,
    AVALANCHE_PROPOSER_VM_METHODS,
    AVALANCHE_X_CHAIN_METHODS,
    DEX_CATALOG_CONTENT_DIGEST,
    DEX_CHAIN_IDS,
    TOKEN_CATALOG_CONTENT_DIGEST,
    ErpcBatchPolicyError,
    ErpcClient,
    ErpcClientConfig,
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    RpcEndpointConfig,
    SwapQuoteError,
    SwapQuoteErrorCode,
)
from erpc_sdk.config import websocket_url
from erpc_sdk.types import RpcBatchCall

_ROOT = Path(__file__).resolve().parents[3]
_SWAP_FIXTURE_PATH = _ROOT / "registry" / "fixtures" / "swap-quote-cases.json"


def test_config_normalizes_endpoints_and_redacts_credential() -> None:
    config = ErpcClientConfig(
        " secret ",
        endpoint="https://example.test/rpc/?discard=yes#fragment",
        avalanche_endpoint="https://ava.example.test/c-chain/?discard=yes#fragment",
    )
    assert config.api_key == "secret"
    assert config.endpoint == "https://example.test/rpc"
    assert config.avalanche_endpoint == "https://ava.example.test/c-chain"
    assert (
        websocket_url(config.avalanche_endpoint, "socket key", "/ava-ws")
        == "wss://ava.example.test/c-chain/ava-ws?api-key=socket%20key"
    )
    assert "secret" not in repr(config)
    assert "[REDACTED]" in repr(config)


def test_keyless_config_requires_a_direct_rpc_override() -> None:
    with pytest.raises(ErpcConfigError):
        ErpcClientConfig()


@pytest.mark.parametrize(
    "url",
    [
        "https:customer.example/rpc",
        "https://customer.example/rpc#",
        "https://user:password@customer.example/rpc",
        "https://@customer.example/rpc",
        "http://:123/rpc",
    ],
)
def test_direct_url_rejects_unsafe_forms_without_echoing_input(url: str) -> None:
    with pytest.raises(ErpcConfigError) as captured:
        RpcEndpointConfig(url)
    assert url not in str(captured.value)


def test_direct_invalid_port_error_drops_parser_cause_and_context() -> None:
    url = "https://rpc.example:fixture-port-secret/rpc"
    with pytest.raises(ErpcConfigError) as captured:
        RpcEndpointConfig(url)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "fixture-port-secret" not in repr(captured.value)


@pytest.mark.parametrize(
    "headers,secret",
    [
        ({"X-Node-Secret": "fixture-MiXeD-é-secret"}, "fixture-MiXeD-é-secret"),
        ({"X\nNode": "fixture-header-secret"}, "fixture-header-secret"),
        ({"X-Node": "fixture-header\nsecret"}, "fixture-header\nsecret"),
    ],
)
def test_direct_invalid_headers_fail_safely_before_any_io(
    headers: dict[str, str],
    secret: str,
) -> None:
    with pytest.raises(ErpcConfigError) as captured:
        RpcEndpointConfig("https://rpc.example/rpc", headers=headers)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert secret not in str(captured.value)
    assert secret not in repr(captured.value)


@pytest.mark.asyncio
async def test_direct_header_construction_error_is_safe_after_input_mutation() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(200, json={})

    endpoint = RpcEndpointConfig(
        "https://rpc.example/rpc",
        headers={"X-Node-Secret": "valid-header"},
    )
    # The caller owns the input mapping; keep the transport defensive if that
    # mapping is changed after configuration construction.
    secret = "fixture-MiXeD-é-secret"
    endpoint.headers["X-Node-Secret"] = secret
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(ErpcClientConfig(ethereum_rpc=endpoint), http_client=http)
    try:
        with pytest.raises(ErpcConfigError) as captured:
            await client.ethereum.rpc.eth_chain_id().send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
        assert secret not in str(captured.value)
        assert secret not in repr(captured.value)
        assert request_count == 0
    finally:
        await client.close()
        await http.aclose()


def test_direct_url_preserves_encoded_hash_and_repr_hides_query_and_headers() -> None:
    endpoint = RpcEndpointConfig(
        "https://customer.example/customer/path?token=a%2Fb&region=eu",
        websocket_url="wss://customer.example/socket?token=ws%2Fsecret",
        headers={"authorization": "Bearer direct-secret"},
    )
    assert endpoint.http_url.endswith("?token=a%2Fb&region=eu")
    assert endpoint.websocket_url == "wss://customer.example/socket?token=ws%2Fsecret"
    rendered = repr(endpoint)
    assert "a%2Fb" not in rendered
    assert "ws%2Fsecret" not in rendered
    assert "direct-secret" not in rendered
    assert "authorization" in rendered


@pytest.mark.asyncio
async def test_keyless_direct_rpc_uses_exact_target_and_scoped_headers() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": "ok"},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            solana_rpc=RpcEndpointConfig(
                "https://customer.example/customer/path?token=a%2Fb&region=eu",
                headers={
                    "authorization": "Bearer direct-secret",
                    "x-node-scope": "solana-only",
                    "Content-Type": "application/custom",
                    "Accept": "text/plain",
                },
            ),
            headers={
                "authorization": "Bearer global-secret",
                "x-global": "must-not-be-forwarded",
            },
        ),
        http_client=http,
    )
    assert await erpc.solana.rpc.get_health().send() == "ok"
    assert str(received[0].url) == ("https://customer.example/customer/path?token=a%2Fb&region=eu")
    assert received[0].url.params.get("api-key") is None
    assert received[0].headers["authorization"] == "Bearer direct-secret"
    assert received[0].headers["x-node-scope"] == "solana-only"
    assert received[0].headers.get_list("content-type") == ["application/json"]
    assert received[0].headers.get_list("accept") == ["application/json"]
    assert "x-global" not in received[0].headers
    assert erpc.solana.rpc.endpoint == "https://customer.example/customer/path"
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_direct_rpc_ignores_http_client_defaults_and_redirects() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(
            307,
            headers={"location": "https://redirect.example/other"},
        )

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        params={"global": "fixture-param"},
        headers={"X-Client-Default": "client-default"},
        auth=httpx.BasicAuth("default-user", "default-pass"),
        cookies={"client-cookie": "cookie-value"},
        follow_redirects=True,
    )
    erpc = ErpcClient(
        ErpcClientConfig(
            "shared-key",
            headers={"X-Global": "global-only"},
            ethereum_rpc=RpcEndpointConfig(
                "https://rpc.example/customer/path?token=a%2Fb&region=eu",
                headers={"X-Node-Secret": "node-secret"},
            ),
        ),
        http_client=http,
    )
    with pytest.raises(ErpcHttpError):
        await erpc.ethereum.rpc.eth_chain_id().send()
    assert len(received) == 1
    request = received[0]
    assert str(request.url) == "https://rpc.example/customer/path?token=a%2Fb&region=eu"
    assert request.url.params.get("global") is None
    assert request.headers["x-node-secret"] == "node-secret"
    assert "x-client-default" not in request.headers
    assert "x-global" not in request.headers
    assert "authorization" not in request.headers
    assert "cookie" not in request.headers
    assert http.headers["x-client-default"] == "client-default"
    assert http.params["global"] == "fixture-param"
    assert isinstance(http.auth, httpx.BasicAuth)
    assert http.cookies["client-cookie"] == "cookie-value"
    assert http.follow_redirects is True
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_keyless_unconfigured_namespaces_fail_without_transport_io() -> None:
    request_count = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(solana_rpc=RpcEndpointConfig("https://customer.example/rpc")),
        http_client=http,
    )
    with pytest.raises(ErpcNotConfiguredError) as captured:
        await erpc.ethereum.rpc.eth_chain_id().send()
    assert captured.value.namespace == "ethereum.rpc"
    with pytest.raises(ErpcNotConfiguredError):
        await erpc.avalanche.x_chain.get_height().send()
    with pytest.raises(ErpcNotConfiguredError):
        await erpc.price.get_price_feeds()
    with pytest.raises(ErpcNotConfiguredError):
        async for _ in erpc.price.stream_price_updates(["feed"]):
            pass
    assert request_count == 0
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_direct_avalanche_c_transport_is_separate_from_native_and_index() -> None:
    received: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        received.append((str(request.url), body["method"]))
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": body["method"]},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            "shared-key",
            avalanche_c_rpc=RpcEndpointConfig("https://customer.example/c?token=c"),
        ),
        http_client=http,
    )
    assert await erpc.avalanche.rpc.eth_chain_id().send() == "eth_chainId"
    assert await erpc.avalanche.x_chain.get_height().send() == "avm.getHeight"
    assert (
        await erpc.avalanche.index.x_chain_transactions.get_container_by_id({"id": "tx"}).send()
        == "index.getContainerByID"
    )
    assert received[0] == ("https://customer.example/c?token=c", "eth_chainId")
    assert received[1][0] == "https://ava-rpc.erpc.global/ava?api-key=shared-key"
    assert received[2][0] == ("https://ava-rpc.erpc.global/ava/ext/index/X/tx?api-key=shared-key")
    await erpc.close()
    await http.aclose()


def _load_direct_quote_case(case_id: str) -> dict[str, Any]:
    if not _SWAP_FIXTURE_PATH.is_file():
        pytest.skip("shared quote fixtures are available only in the repository workspace")
    fixture = cast(dict[str, Any], json.loads(_SWAP_FIXTURE_PATH.read_text()))
    for entry in fixture["validCases"]:
        if entry["caseId"] == case_id:
            return cast(dict[str, Any], entry)
    raise AssertionError(f"missing shared quote fixture {case_id}")


def _direct_quote_handler(
    entry: dict[str, Any],
    received_urls: list[str],
    received_trace: list[dict[str, Any]],
) -> httpx.MockTransport:
    response_index = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal response_index
        body = cast(dict[str, Any], json.loads(request.content))
        received_urls.append(str(request.url))
        received_trace.append({"method": body["method"], "params": body.get("params", [])})
        responses = cast(list[Any], entry["rpcResponses"])
        result = responses[response_index]
        response_index += 1
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    return httpx.MockTransport(handler)


async def _assert_direct_quote_routing(
    case_id: str,
    direct_url: str,
    override_name: str,
    wrong_chain_id: str,
) -> None:
    entry = _load_direct_quote_case(case_id)
    received_urls: list[str] = []
    received_trace: list[dict[str, Any]] = []
    http = httpx.AsyncClient(transport=_direct_quote_handler(entry, received_urls, received_trace))
    client = ErpcClient(
        ErpcClientConfig(
            **{override_name: RpcEndpointConfig(direct_url)},
        ),
        http_client=http,
    )
    client.swap._clock = lambda: int(entry["nowSeconds"])  # type: ignore[attr-defined]
    try:
        expected = {
            **entry["outcome"]["value"],
            "tokenCatalogDigest": TOKEN_CATALOG_CONTENT_DIGEST,
            "dexCatalogDigest": DEX_CATALOG_CONTENT_DIGEST,
        }
        assert await client.swap.quote_exact_input(entry["request"]) == expected
        assert received_trace == entry["rpcTrace"]
        assert received_urls == [direct_url] * 11
        assert all("api-key" not in url for url in received_urls)

        wrong_chain_request = dict(cast(dict[str, Any], entry["request"]))
        wrong_chain_request["chainId"] = wrong_chain_id
        with pytest.raises(SwapQuoteError) as captured:
            await client.swap.quote_exact_input(wrong_chain_request)
        assert captured.value.code == SwapQuoteErrorCode.CHAIN_MISMATCH
        assert len(received_trace) == 11
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_direct_ethereum_quote_uses_exact_endpoint_for_all_reads() -> None:
    await _assert_direct_quote_routing(
        "ethereum-weth-usdc-forward",
        "https://ethereum.example.test/customer/path?token=eth%2Fb&region=eu",
        "ethereum_rpc",
        DEX_CHAIN_IDS["avalancheC"],
    )


@pytest.mark.asyncio
async def test_direct_avalanche_quote_uses_exact_endpoint_for_all_reads() -> None:
    await _assert_direct_quote_routing(
        "avalanche-wavax-usdc-forward",
        "https://avalanche.example.test/customer/path?token=avax%2Fb&region=eu",
        "avalanche_c_rpc",
        DEX_CHAIN_IDS["ethereum"],
    )


@pytest.mark.asyncio
async def test_mixed_keyed_and_direct_headers_remain_scoped() -> None:
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        if request.url.path == "/v2/price_feeds":
            return httpx.Response(200, json=[])
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": "ok"},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            "shared-key",
            headers={
                "authorization": "Bearer global-secret",
                "x-global": "global-only",
            },
            ethereum_rpc=RpcEndpointConfig(
                "https://ethereum.example.test/rpc?token=direct",
                headers={"authorization": "Bearer direct-secret", "x-direct": "direct-only"},
            ),
        ),
        http_client=http,
    )
    await erpc.ethereum.rpc.eth_chain_id().send()
    await erpc.solana.rpc.get_slot().send()
    await erpc.price.get_price_feeds()
    direct, legacy_rpc, rest = received
    assert direct.url.params.get("api-key") is None
    assert direct.headers["authorization"] == "Bearer direct-secret"
    assert direct.headers["x-direct"] == "direct-only"
    assert "x-global" not in direct.headers
    assert legacy_rpc.url.params["api-key"] == "shared-key"
    assert legacy_rpc.headers["authorization"] == "Bearer global-secret"
    assert rest.headers["authorization"] == "Bearer shared-key"
    assert rest.headers["x-global"] == "global-only"
    assert "x-direct" not in rest.headers
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_direct_rpc_errors_redact_query_and_scoped_authorization() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": -32000,
                    "message": "a%2fb a/b direct-secret",
                    "data": {"a/b": "direct-secret"},
                },
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            ethereum_rpc=RpcEndpointConfig(
                "https://customer.example/rpc?token=a%2Fb",
                headers={"authorization": "Bearer direct-secret"},
            )
        ),
        http_client=http,
    )
    with pytest.raises(ErpcJsonRpcError) as captured:
        await erpc.ethereum.rpc.eth_chain_id().send()
    rendered = f"{captured.value} {captured.value.data!r}"
    for secret in ("a%2fb", "a%2Fb", "a/b", "direct-secret"):
        assert secret not in rendered
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_direct_redaction_preserves_plaintext_case_and_folds_percent_hex_case() -> None:
    secret = "MiXeD/Secret/Value"

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {
                    "code": -32000,
                    "message": (
                        f"{secret} {secret.replace('/', '%2F')} "
                        f"{secret.replace('/', '%2f')} "
                        f"{secret.replace('/', '%2f', 1).replace('/', '%2F', 1)} "
                        "mixed/secret/value Mixed%2FSecret%2FValue"
                    ),
                    "data": {
                        secret: secret.replace("/", "%2f"),
                        "keep": "mixed/secret/value",
                    },
                },
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            ethereum_rpc=RpcEndpointConfig(
                "https://rpc.example/rpc?token=MiXeD%2fSecret%2fValue",
                headers={"authorization": f"Bearer {secret}"},
            )
        ),
        http_client=http,
    )
    with pytest.raises(ErpcJsonRpcError) as captured:
        await erpc.ethereum.rpc.eth_chain_id().send()
    rendered = f"{captured.value} {captured.value.data!r}"
    for redacted in (
        secret,
        secret.replace("/", "%2F"),
        secret.replace("/", "%2f"),
        secret.replace("/", "%2f", 1).replace("/", "%2F", 1),
    ):
        assert redacted not in rendered
    assert "mixed/secret/value" in rendered
    assert "Mixed%2FSecret%2FValue" in rendered
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_direct_malformed_response_does_not_retain_response_body_cause() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"provider-secret")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig(
            ethereum_rpc=RpcEndpointConfig("https://rpc.example/rpc?token=provider-secret")
        ),
        http_client=http,
    )
    with pytest.raises(ErpcInvalidResponseError) as captured:
        await erpc.ethereum.rpc.eth_chain_id().send()
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "provider-secret" not in repr(captured.value)
    await erpc.close()
    await http.aclose()


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
        await erpc.avalanche.index.x_chain_transactions.get_container_by_id({"id": "tx-id"}).send()
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
        if body["method"] in {"getTransaction", "getBlock"} and len(body["params"]) == 2:
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
    assert (
        await erpc.solana.rpc.get_transaction("v1-signature", transaction_options).send()
        == transaction_v1
    )
    assert await erpc.solana.rpc.get_block(123_456, block_options).send() == block_v1
    assert (
        await erpc.solana.rpc.get_transaction(
            "v0-signature", {"maxSupportedTransactionVersion": 0}
        ).send()
        == v0
    )
    assert (
        await erpc.solana.rpc.get_block(123_458, {"maxSupportedTransactionVersion": 0}).send() == v0
    )
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
