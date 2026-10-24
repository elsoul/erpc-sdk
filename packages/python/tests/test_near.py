from __future__ import annotations

import json
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from erpc_sdk import (
    ErpcClient,
    ErpcClientConfig,
    ErpcConfigError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    NearBlockReference,
    RpcEndpointConfig,
    near_transport,
)


class _IntegerExpansionTrap(Decimal):
    calls = 0

    def __int__(self) -> int:
        type(self).calls += 1
        raise RuntimeError("bounded probe intercepted integer expansion")


class _InjectedReference(NearBlockReference):
    def to_params(self) -> dict[str, str | int]:
        return {
            "finality": "final",
            "block_id": 123,
            "request_type": "call_function",
            "account_id": "other.near",
            "method_name": "local_probe",
            "args_base64": "",
        }


@pytest.mark.asyncio
async def test_near_typed_reads_preserve_selectors_and_exact_unknown_numbers() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if body["method"] == "status":
            result = {
                "chain_id": "mainnet",
                "genesis_hash": "genesis",
                "latest_protocol_version": 18446744073709551615,
                "protocol_version": 1,
                "sync_info": {
                    "latest_block_hash": "block",
                    "latest_block_height": 42,
                    "latest_block_time": "time",
                    "latest_state_root": "state",
                    "syncing": False,
                    "unknown_numeric": 1e-1000,
                },
                "version": {"version": "1", "build": "build"},
            }
        elif body["method"] == "block":
            result = {
                "author": "node",
                "header": {
                    "hash": "hash",
                    "height": 5,
                    "prev_hash": "prev",
                    "timestamp": 5,
                    "timestamp_nanosec": "5000000000",
                    "gas_price": "100",
                    "total_supply": "200",
                },
                "chunks": [],
            }
        else:
            result = {
                "amount": "100",
                "locked": "0",
                "code_hash": "hash",
                "storage_usage": 1,
                "block_height": 5,
                "block_hash": "hash",
            }
        encoded = json.dumps(
            {"jsonrpc": "2.0", "id": body["id"], "result": result},
            allow_nan=False,
        ).replace("0.0", "1e-1000", 1)
        return httpx.Response(
            200,
            content=encoded.encode(),
            headers={"content-type": "application/json"},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            near_rpc=RpcEndpointConfig(
                "https://customer.example/near?token=a%2Fb",
                headers={"authorization": "Bearer direct-secret", "x-near": "near-only"},
            )
        ),
        http_client=http,
    )
    try:
        status = await client.near.rpc.status().send()
        assert status.latest_protocol_version == 18446744073709551615
        assert status.sync_info.additional["unknown_numeric"] == Decimal("1e-1000")
        await client.near.rpc.block(NearBlockReference.height(5)).send()
        await client.near.rpc.view_account("alice.near", NearBlockReference.final()).send()
        assert json.loads(requests[0].content)["params"] == []
        assert json.loads(requests[1].content)["params"] == {"block_id": 5}
        assert json.loads(requests[2].content)["params"] == {
            "request_type": "view_account",
            "account_id": "alice.near",
            "finality": "final",
        }
        assert str(requests[0].url) == "https://customer.example/near?token=a%2Fb"
        assert requests[0].headers["x-near"] == "near-only"
        assert client.near.rpc.endpoint == "https://customer.example/"
    finally:
        await client.close()
        await http.aclose()


def test_near_selector_is_exclusive_and_rejects_boolean_heights() -> None:
    with pytest.raises(ErpcConfigError):
        NearBlockReference(finality="final", block_id="hash")
    with pytest.raises(ErpcConfigError):
        NearBlockReference.height(True)  # type: ignore[arg-type]
    assert NearBlockReference.hash("hash").to_params() == {"block_id": "hash"}


def test_near_response_numeric_bounds_do_not_expand_compact_decimals() -> None:
    for function, args in (
        (near_transport._numeric_id_matches, (1,)),
        (near_transport._integer_error_code, ()),
    ):
        value = _IntegerExpansionTrap("1e1000000000")
        _IntegerExpansionTrap.calls = 0
        assert function(value, *args) in (False, None)
        assert _IntegerExpansionTrap.calls == 0
    assert near_transport._numeric_id_matches(Decimal("1.0"), 1)
    assert near_transport._integer_error_code(Decimal("-32000")) == -32000


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_kind", ["id", "code"])
async def test_near_public_invalid_compact_id_and_code_are_safe(
    bad_kind: str,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if bad_kind == "id":
            response = (
                '{"jsonrpc":"2.0","id":1e1000000000,"result":{}}'
            )
        else:
            response = (
                f'{{"jsonrpc":"2.0","id":{body["id"]},'
                '"error":{"code":1e1000000000,"message":"bad"}}}'
            )
        return httpx.Response(200, content=response.encode())

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcInvalidResponseError):
            await client.near.rpc.status().send()
        assert len(requests) == 1
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_near_selector_subclass_is_rejected_before_any_io() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": {}},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        injected = _InjectedReference(finality="final")
        with pytest.raises(ErpcConfigError):
            client.near.rpc.block(injected)
        with pytest.raises(ErpcConfigError):
            client.near.rpc.view_account("alice.near", injected)
        assert calls == 0
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_near_optional_fields_accept_null_and_preserve_values() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if body["method"] == "status":
            result = {
                "chain_id": "mainnet",
                "genesis_hash": "g",
                "latest_protocol_version": 1,
                "protocol_version": 0,
                "sync_info": {
                    "latest_block_hash": "b",
                    "latest_block_height": 1,
                    "latest_block_time": "t",
                    "latest_state_root": "s",
                    "syncing": False,
                },
                "version": {"version": "1", "build": "b", "rustc_version": None},
            }
        else:
            result = {
                "amount": "0",
                "locked": "0",
                "code_hash": "h",
                "storage_usage": 0,
                "storage_paid_at": None,
                "block_height": 0,
                "block_hash": "h",
                "state": None,
                "bootstrap_nonce": None,
                "global_contract_account_id": None,
                "global_contract_hash": None,
            }
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        status = await client.near.rpc.status().send()
        account = await client.near.rpc.view_account(
            "alice.near", NearBlockReference.final()
        ).send()
        assert status.version.rustc_version is None
        assert account.storage_paid_at is None
        assert account.state is None
        assert account.bootstrap_nonce is None
        assert account.global_contract_account_id is None
        assert account.global_contract_hash is None
        assert len(requests) == 2
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "field", "value"),
    [
        ("status", "rustc_version", 1),
        ("query", "storage_paid_at", "bad"),
        ("query", "state", 1),
        ("query", "bootstrap_nonce", "bad"),
        ("query", "global_contract_account_id", 1),
        ("query", "global_contract_hash", 1),
    ],
)
async def test_near_optional_non_null_wrong_types_are_rejected(
    method: str,
    field: str,
    value: object,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if method == "status":
            result: dict[str, object] = {
                "chain_id": "mainnet",
                "genesis_hash": "g",
                "latest_protocol_version": 1,
                "protocol_version": 0,
                "sync_info": {
                    "latest_block_hash": "b",
                    "latest_block_height": 1,
                    "latest_block_time": "t",
                    "latest_state_root": "s",
                    "syncing": False,
                },
                "version": {"version": "1", "build": "b", field: value},
            }
        else:
            result = {
                "amount": "0",
                "locked": "0",
                "code_hash": "h",
                "storage_usage": 0,
                "block_height": 0,
                "block_hash": "h",
                field: value,
            }
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": body["id"], "result": result},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcInvalidResponseError):
            if method == "status":
                await client.near.rpc.status().send()
            else:
                await client.near.rpc.view_account(
                    "alice.near", NearBlockReference.final()
                ).send()
    finally:
        await client.close()
        await http.aclose()


_NEAR_U64_MAX = "18446744073709551615"
_KNOWN_U64_FIELDS = (
    ("latest_protocol_version", "status"),
    ("protocol_version", "status"),
    ("latest_block_height", "status"),
    ("height", "block"),
    ("timestamp", "block"),
    ("storage_usage", "query"),
    ("block_height", "query"),
    ("storage_paid_at", "query"),
    ("bootstrap_nonce", "query"),
)


def _tokenized_json(value: object, tokens: dict[str, str]) -> str:
    result = json.dumps(value, separators=(",", ":"))
    for marker, token in tokens.items():
        result = result.replace(f'"{marker}"', token)
    return result


def _raw_near_result(field: str, token: str) -> str:
    tokens: dict[str, str] = {}

    def numeric(name: str) -> str:
        marker = f"__{name}__"
        tokens[marker] = token if field == name else "0"
        return marker

    status = {
        "chain_id": "mainnet",
        "genesis_hash": "g",
        "latest_protocol_version": numeric("latest_protocol_version"),
        "protocol_version": numeric("protocol_version"),
        "sync_info": {
            "latest_block_hash": "b",
            "latest_block_height": numeric("latest_block_height"),
            "latest_block_time": "t",
            "latest_state_root": "s",
            "syncing": False,
        },
        "version": {"version": "1", "build": "b"},
    }
    block = {
        "author": "node",
        "header": {
            "hash": "h",
            "height": numeric("height"),
            "prev_hash": "p",
            "timestamp": numeric("timestamp"),
            "timestamp_nanosec": "0",
            "gas_price": "0",
            "total_supply": "0",
        },
        "chunks": [],
    }
    account: dict[str, object] = {
        "amount": "0",
        "locked": "0",
        "code_hash": "h",
        "storage_usage": numeric("storage_usage"),
        "block_height": numeric("block_height"),
        "block_hash": "h",
    }
    if field in {"storage_paid_at", "bootstrap_nonce"}:
        account[field] = numeric(field)
    result: object = status if field in {
        "latest_protocol_version",
        "protocol_version",
        "latest_block_height",
    } else block
    if field in {"storage_usage", "block_height", "storage_paid_at", "bootstrap_nonce"}:
        result = account
    return _tokenized_json(
        {"jsonrpc": "2.0", "id": 1, "result": result},
        tokens,
    )


async def _raw_near_call(
    template: str,
    action: str,
) -> tuple[object | None, list[httpx.Request]]:
    requests: list[httpx.Request] = []
    state = {"template": template}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        response = state["template"].replace(
            '"id":1', f'"id":{body["id"]}', 1
        )
        return httpx.Response(200, content=response.encode())

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        request = {
            "status": lambda: client.near.rpc.status().send(),
            "block": lambda: client.near.rpc.block(NearBlockReference.final()).send(),
            "query": lambda: client.near.rpc.view_account(
                "alice.near", NearBlockReference.final()
            ).send(),
        }[action]
        return await request(), requests
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_near_known_u64_tokens_match_rust_spelling_and_bounds() -> None:
    for field, action in _KNOWN_U64_FIELDS:
        for token in ("0", "1", _NEAR_U64_MAX):
            result, _ = await _raw_near_call(_raw_near_result(field, token), action)
            assert result is not None
        for token in ("-0", "0.0", "0e0", "-1", "18446744073709551616"):
            with pytest.raises(ErpcInvalidResponseError):
                await _raw_near_call(_raw_near_result(field, token), action)


@pytest.mark.asyncio
async def test_near_duplicate_escaped_keys_use_last_token_without_string_spoofing() -> None:
    accepted = _raw_near_result("protocol_version", "0").replace(
        '"protocol_version":0',
        '"protocol_version":-0,"\\u0070rotocol_version":0',
        1,
    )
    result, _ = await _raw_near_call(accepted, "status")
    assert result is not None

    rejected = _raw_near_result("protocol_version", "0").replace(
        '"protocol_version":0',
        '"protocol_version":0,"\\u0070rotocol_version":-0',
        1,
    )
    with pytest.raises(ErpcInvalidResponseError):
        await _raw_near_call(rejected, "status")

    string_then_integer = _raw_near_result("protocol_version", "0").replace(
        '"protocol_version":0',
        '"protocol_version":"-0","\\u0070rotocol_version":0',
        1,
    )
    result, _ = await _raw_near_call(string_then_integer, "status")
    assert result is not None

    integer_then_string = _raw_near_result("protocol_version", "0").replace(
        '"protocol_version":0',
        '"protocol_version":0,"\\u0070rotocol_version":"-0"',
        1,
    )
    with pytest.raises(ErpcInvalidResponseError):
        await _raw_near_call(integer_then_string, "status")


@pytest.mark.asyncio
async def test_near_unknown_numeric_values_normalize_without_private_markers() -> None:
    template = (
        '{"jsonrpc":"2.0","id":1,"result":{'
        '"chain_id":"mainnet","genesis_hash":"g",'
        '"latest_protocol_version":0,"protocol_version":0,'
        '"sync_info":{"latest_block_hash":"b","latest_block_height":0,'
        '"latest_block_time":"t","latest_state_root":"s","syncing":false,'
        '"unknown_zero":-0,"unknown_decimal":1e-3},'
        '"version":{"version":"1","build":"b"}}}'
    )
    result, _ = await _raw_near_call(template, "status")
    assert result is not None
    status = result
    assert status.sync_info.additional["unknown_zero"] == 0
    assert type(status.sync_info.additional["unknown_zero"]) is int
    assert status.sync_info.additional["unknown_decimal"] == Decimal("1e-3")
    assert "_NearIntegerToken" not in repr(status.sync_info.additional)


@pytest.mark.asyncio
async def test_near_unknown_chunks_and_error_data_return_ordinary_exact_values() -> None:
    state = {"kind": "block"}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if state["kind"] == "block":
            response = (
                f'{{"jsonrpc":"2.0","id":{body["id"]},"result":{{'
                '"author":"node","header":{"hash":"h","height":0,'
                '"prev_hash":"p","timestamp":0,"timestamp_nanosec":"0",'
                '"gas_price":"0","total_supply":"0"},'
                '"chunks":[-0,1e-3],"unknown":-0}}'
            )
        else:
            response = (
                f'{{"jsonrpc":"2.0","id":{body["id"]},"error":{{'
                '"code":-32000,"message":"bad",'
                '"data":{"zero":-0,"fraction":1e-3}}}'
            )
        return httpx.Response(200, content=response.encode())

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(near_rpc=RpcEndpointConfig("https://near.example/rpc")),
        http_client=http,
    )
    try:
        block = await client.near.rpc.block(NearBlockReference.final()).send()
        assert block.chunks == (0, Decimal("1e-3"))
        assert all(type(value).__name__ != "_NearIntegerToken" for value in block.chunks)
        state["kind"] = "error"
        with pytest.raises(ErpcJsonRpcError) as captured:
            await client.near.rpc.status().send()
        assert captured.value.data == {"zero": 0, "fraction": Decimal("1e-3")}
        assert "_NearIntegerToken" not in repr(captured.value.data)
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_near_direct_error_redaction_keeps_numeric_data_exact() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(
            200,
            content=(
                f'{{"jsonrpc":"2.0","id":{body["id"]},"error":{{"code":-32000,'
                '"message":"secret%2fpath direct-secret",'
                '"data":{"height":18446744073709551615,"token":"secret/path"}}}'
            ).encode(),
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            near_rpc=RpcEndpointConfig(
                "https://customer.example/near?token=secret%2Fpath",
                headers={"authorization": "Bearer direct-secret"},
            )
        ),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcJsonRpcError) as captured:
            await client.near.rpc.status().send()
        assert captured.value.data == {"height": 18446744073709551615, "token": "[REDACTED]"}
        assert "secret" not in repr(captured.value)
        assert "query" not in dir(client.near.rpc)
    finally:
        await client.close()
        await http.aclose()


def _near_loopback_server() -> tuple[ThreadingHTTPServer, threading.Thread, dict[str, object]]:
    state: dict[str, object] = {"response": b"", "requests": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            return

        def do_POST(self) -> None:
            data = self.rfile.read(int(self.headers["content-length"]))
            requests = state["requests"]
            assert isinstance(requests, list)
            requests.append((self.path, len(data)))
            response = state["response"]
            assert isinstance(response, bytes)
            request_id = json.loads(data)["id"]
            response = response.replace(
                b'"id":1', f'"id":{request_id}'.encode(), 1
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, state


@pytest.mark.asyncio
async def test_near_loopback_safe_error_boundary_and_valid_large_unknown_number() -> None:
    server, thread, state = _near_loopback_server()
    client = ErpcClient(
        ErpcClientConfig(
            near_rpc=RpcEndpointConfig(
                f"http://127.0.0.1:{server.server_port}/near"
            )
        )
    )
    sentinel = "response-body-sentinel"
    huge = "7" * 4_301

    async def expect_safe_error(response: str) -> None:
        state["response"] = response.encode()
        with pytest.raises(ErpcInvalidResponseError) as captured:
            await client.near.rpc.status().send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
        assert sentinel not in str(captured.value)
        assert sentinel not in repr(captured.value)

    try:
        await expect_safe_error(
            '{"jsonrpc":"2.0","id":1,"result":{"sentinel":"'
            + sentinel
            + '"}'
        )
        await expect_safe_error(
            _raw_near_result("protocol_version", "0").replace(
                '"syncing":false',
                '"syncing":false,"sentinel":"'
                + sentinel
                + '","unknown":'
                + huge,
                1,
            )
        )
        block_response = (
            '{"jsonrpc":"2.0","id":1,"result":{"author":"node",'
            '"header":{"hash":"h","height":0,"prev_hash":"p",'
            '"timestamp":0,"timestamp_nanosec":"0","gas_price":"0",'
            '"total_supply":"0"},"chunks":['
            + huge
            + ']}}'
        )
        state["response"] = block_response.encode()
        with pytest.raises(ErpcInvalidResponseError) as chunk_error:
            await client.near.rpc.block(NearBlockReference.final()).send()
        assert chunk_error.value.__cause__ is None
        assert chunk_error.value.__context__ is None

        error_response = (
            '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,'
            '"message":"bad","data":{"sentinel":"'
            + sentinel
            + '","huge":'
            + huge
            + '}}}'
        )
        state["response"] = error_response.encode()
        with pytest.raises(ErpcInvalidResponseError) as data_error:
            await client.near.rpc.status().send()
        assert data_error.value.__cause__ is None
        assert data_error.value.__context__ is None
        assert sentinel not in repr(data_error.value)

        valid = _raw_near_result("protocol_version", _NEAR_U64_MAX).replace(
            '"syncing":false',
            '"syncing":false,"unknown_decimal":1e1000',
            1,
        )
        state["response"] = valid.encode()
        status = await client.near.rpc.status().send()
        assert status.protocol_version == int(_NEAR_U64_MAX)
        assert status.sync_info.additional["unknown_decimal"] == Decimal("1e1000")
    finally:
        await client.close()
        server.shutdown()
        server.server_close()
        thread.join()
