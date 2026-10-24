from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from erpc_sdk import (
    SUI_GRPC_WEB_CONTENT_TYPE,
    ErpcClient,
    ErpcClientConfig,
    ErpcConfigError,
    ErpcInvalidResponseError,
    SuiGrpcWebEndpointConfig,
)
from erpc_sdk._sui_proto import (
    decode_balance_response,
    decode_object_response,
    decode_service_info_response,
    encode_get_balance_request,
    encode_get_object_request,
    encode_get_service_info_request,
    encode_varint,
)


def _field_varint(field: int, value: int) -> bytes:
    return encode_varint(field << 3) + encode_varint(value)


def _field_string(field: int, value: str) -> bytes:
    raw = value.encode()
    return encode_varint((field << 3) | 2) + encode_varint(len(raw)) + raw


def _field_message(field: int, value: bytes) -> bytes:
    return encode_varint((field << 3) | 2) + encode_varint(len(value)) + value


def _frame(payload: bytes, trailer: bytes = b"grpc-status: 0\r\n") -> bytes:
    return (
        b"\x00"
        + len(payload).to_bytes(4, "big")
        + payload
        + b"\x80"
        + len(trailer).to_bytes(4, "big")
        + trailer
    )


def _loopback_server() -> tuple[ThreadingHTTPServer, threading.Thread, dict[str, object]]:
    state: dict[str, object] = {"payload": b"", "requests": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            return

        def do_POST(self) -> None:
            data = self.rfile.read(int(self.headers["content-length"]))
            state["requests"].append((self.path, len(data)))  # type: ignore[union-attr]
            body = _frame(state["payload"])  # type: ignore[arg-type]
            self.send_response(200)
            self.send_header("Content-Type", SUI_GRPC_WEB_CONTENT_TYPE)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, state


def test_sui_golden_request_frames_and_bounded_decoders() -> None:
    assert encode_get_service_info_request().hex() == "0000000000"
    assert encode_get_object_request("0x2", 0).hex() == "00000000070a033078321000"
    assert encode_get_object_request("0x2").hex() == "00000000050a03307832"
    assert encode_get_balance_request("owner", "coin").hex() == (
        "000000000d0a056f776e65721204636f696e"
    )

    timestamp = _field_varint(1, 123) + _field_varint(2, 4)
    service = (
        _field_string(1, "chain")
        + _field_string(2, "mainnet")
        + _field_varint(3, 18446744073709551615)
        + _field_varint(4, 42)
        + _field_message(5, timestamp)
        + _field_varint(6, 0)
        + _field_varint(7, 10)
        + _field_string(8, "sui-test")
    )
    info = decode_service_info_response(service)
    assert info.chain == "mainnet"
    assert info.epoch == 18446744073709551615
    assert info.timestamp.nanos == 4

    obj = _field_string(2, "0x2") + _field_varint(3, 0) + _field_string(4, "digest")
    assert decode_object_response(_field_message(1, obj)).version == 0
    balance = (
        _field_string(1, "coin")
        + _field_varint(3, 5)
        + _field_varint(4, 2)
        + _field_varint(5, 3)
    )
    assert decode_balance_response(_field_message(1, balance)).balance == 5


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "value"),
    [
        ("object", "\ud800"),
        ("object", "\udfff"),
        ("owner", "\ud800"),
        ("owner", "\udfff"),
        ("coin", "\ud800"),
        ("coin", "\udfff"),
    ],
)
async def test_sui_rejects_lone_surrogates_as_safe_config_errors(
    operation: str,
    value: str,
) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig("https://sui.example/tenant")
        ),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcConfigError) as captured:
            if operation == "object":
                client.sui.grpc.get_object(value)
            elif operation == "owner":
                client.sui.grpc.get_balance(value, "coin")
            else:
                client.sui.grpc.get_balance("owner", value)
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
        assert calls == 0
        assert "Sui" in str(captured.value)
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, 123, "", "\x00", "\x1f", "\x7f"])
async def test_sui_wrong_empty_and_control_inputs_fail_before_io(value: object) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig("https://sui.example/tenant")
        ),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcConfigError):
            client.sui.grpc.get_object(value)  # type: ignore[arg-type]
        with pytest.raises(ErpcConfigError):
            client.sui.grpc.get_balance(value, "coin")  # type: ignore[arg-type]
        with pytest.raises(ErpcConfigError):
            client.sui.grpc.get_balance("owner", value)  # type: ignore[arg-type]
        assert calls == 0
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_sui_valid_supplementary_unicode_preserves_utf8_bytes() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = _field_message(
            1,
            _field_string(2, "object")
            + _field_varint(3, 0)
            + _field_string(4, "digest"),
        )
        return httpx.Response(
            200,
            content=_frame(payload),
            headers={"content-type": SUI_GRPC_WEB_CONTENT_TYPE},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig("https://sui.example/tenant")
        ),
        http_client=http,
    )
    try:
        await client.sui.grpc.get_object("😀").send()
        assert "f09f9880" in requests[0].content.hex()
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_sui_public_loopback_depth_merge_and_request_boundaries() -> None:
    server, thread, state = _loopback_server()
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig(
                f"http://127.0.0.1:{server.server_port}/tenant"
            )
        )
    )

    def object_payload(group_count: int) -> bytes:
        object_value = bytes.fromhex("120018002200")
        groups = bytes([0x4B]) * group_count + bytes([0x4C]) * group_count
        return _field_message(1, object_value + groups)

    try:
        state["payload"] = object_payload(99)
        accepted = await client.sui.grpc.get_object("x").send()
        assert accepted.version == 0

        state["payload"] = object_payload(100)
        with pytest.raises(ErpcInvalidResponseError):
            await client.sui.grpc.get_object("x").send()

        prefix = bytes.fromhex("0a00120018002000")
        suffix = bytes.fromhex("30003800")
        invalid_then_valid = bytes.fromhex("0807108094ebdc03")
        valid_nanos = bytes.fromhex("1000")
        state["payload"] = (
            prefix
            + _field_message(5, invalid_then_valid)
            + _field_message(5, valid_nanos)
            + suffix
        )
        info = await client.sui.grpc.get_service_info().send()
        assert info.timestamp_seconds == 7
        assert info.timestamp_nanos == 0

        state["payload"] = (
            prefix
            + _field_message(5, valid_nanos)
            + _field_message(5, invalid_then_valid)
            + suffix
        )
        with pytest.raises(ErpcInvalidResponseError):
            await client.sui.grpc.get_service_info().send()

    finally:
        await client.close()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.asyncio
async def test_sui_public_loopback_request_boundaries_are_inclusive() -> None:
    server, thread, state = _loopback_server()
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig(
                f"http://127.0.0.1:{server.server_port}/tenant"
            )
        )
    )

    try:
        state["payload"] = _field_message(1, bytes.fromhex("120018002200"))
        requests = state["requests"]
        assert isinstance(requests, list)
        before = len(requests)
        await client.sui.grpc.get_object("x" * 1_048_567).send()
        assert requests[before][1] == 1_048_576
        before = len(requests)
        with pytest.raises(ErpcConfigError):
            client.sui.grpc.get_object("x" * 1_048_568)
        assert len(requests) == before

        state["payload"] = _field_message(1, bytes.fromhex("0a00180020002800"))
        before = len(requests)
        await client.sui.grpc.get_balance("a" * 524_281, "b" * 524_282).send()
        assert requests[before][1] == 1_048_576
        before = len(requests)
        with pytest.raises(ErpcConfigError):
            client.sui.grpc.get_balance("a" * 524_281, "b" * 524_283)
        assert len(requests) == before
    finally:
        await client.close()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.asyncio
async def test_sui_streamed_transport_uses_exact_prefix_path_and_headers() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("GetServiceInfo"):
            payload = (
                _field_string(1, "chain")
                + _field_string(2, "mainnet")
                + _field_varint(3, 1)
                + _field_varint(4, 2)
                + _field_message(5, b"")
                + _field_varint(6, 0)
                + _field_varint(7, 0)
            )
        elif path.endswith("GetObject"):
            payload = _field_message(
                1,
                _field_string(2, "0x2")
                + _field_varint(3, 2)
                + _field_string(4, "digest"),
            )
        else:
            payload = _field_message(
                1,
                _field_string(1, "coin")
                + _field_varint(3, 5)
                + _field_varint(4, 2)
                + _field_varint(5, 3),
            )
        return httpx.Response(
            200,
            content=_frame(payload),
            headers={"content-type": SUI_GRPC_WEB_CONTENT_TYPE},
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig(
                "https://customer.example/prefix%2Ftenant?token=a%2Fb",
                headers={"authorization": "Bearer direct-secret", "x-sui": "sui-only"},
            )
        ),
        http_client=http,
    )
    try:
        assert (await client.sui.grpc.get_service_info().send()).chain == "mainnet"
        assert (await client.sui.grpc.get_object("0x2", 0).send()).version == 2
        assert (await client.sui.grpc.get_balance("owner", "coin").send()).balance == 5
        assert str(requests[0].url) == (
            "https://customer.example/prefix%2Ftenant/"
            "sui.rpc.v2.LedgerService/GetServiceInfo?token=a%2Fb"
        )
        assert requests[0].headers["authorization"] == "Bearer direct-secret"
        assert requests[0].headers["x-sui"] == "sui-only"
        assert requests[0].headers["content-type"] == SUI_GRPC_WEB_CONTENT_TYPE
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_sui_rejects_bad_trailer_and_version_before_io() -> None:
    with pytest.raises(ErpcConfigError):
        encode_get_object_request("0x2", True)  # type: ignore[arg-type]

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                content=_frame(b"x", b"Grpc-status: 0\r\n"),
                headers={"content-type": SUI_GRPC_WEB_CONTENT_TYPE},
            )
        )
    )
    client = ErpcClient(
        ErpcClientConfig(
            sui_grpc_web=SuiGrpcWebEndpointConfig("https://customer.example/sui")
        ),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcInvalidResponseError):
            await client.sui.grpc.get_service_info().send()
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "trailer",
    [b"grpc-status: \xc2\xa00\xc2\xa0\r\n", "\xc3\xa9: ok\r\ngrpc-status: 0\r\n".encode()],
)
async def test_sui_rejects_non_ascii_trailer_grammar_without_context(trailer: bytes) -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                content=_frame(bytes.fromhex("0a06120018002200"), trailer),
                headers={"content-type": SUI_GRPC_WEB_CONTENT_TYPE},
            )
        )
    )
    client = ErpcClient(
        ErpcClientConfig(sui_grpc_web=SuiGrpcWebEndpointConfig("https://sui.example/tenant")),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcInvalidResponseError) as captured:
            await client.sui.grpc.get_object("x").send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
    finally:
        await client.close()
        await http.aclose()


@pytest.mark.asyncio
async def test_sui_invalid_protobuf_utf8_has_no_native_context() -> None:
    payload = bytes.fromhex("0a071201ff18002200")
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                content=_frame(payload),
                headers={"content-type": SUI_GRPC_WEB_CONTENT_TYPE},
            )
        )
    )
    client = ErpcClient(
        ErpcClientConfig(sui_grpc_web=SuiGrpcWebEndpointConfig("https://sui.example/tenant")),
        http_client=http,
    )
    try:
        with pytest.raises(ErpcInvalidResponseError) as captured:
            await client.sui.grpc.get_object("x").send()
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None
    finally:
        await client.close()
        await http.aclose()
