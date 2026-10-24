"""Private streamed gRPC-Web transport for the bounded Sui facade."""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urlsplit, urlunsplit

import httpx

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from ._sui_proto import SUI_RESPONSE_LIMIT, SUI_TRAILER_LIMIT
from .bitcoin_transport import _close_response, _run_with_deadline
from .config import SuiGrpcWebEndpointConfig
from .errors import (
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcNotConfiguredError,
    ErpcTransportError,
)
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

SUI_GRPC_WEB_CONTENT_TYPE = "application/grpc-web+proto"


def _generated_sui_methods() -> tuple[str, ...]:
    method_sets = _RPC_NETWORK_CONTRACT.get("methodSets")
    if not isinstance(method_sets, list):
        raise RuntimeError("generated RPC contract has no method sets")
    method_set = next(
        (
            item
            for item in method_sets
            if isinstance(item, dict) and item.get("methodSetId") == "sui-unary3"
        ),
        None,
    )
    capabilities = method_set.get("capabilities") if isinstance(method_set, dict) else None
    if not isinstance(capabilities, list):
        raise RuntimeError("missing generated Sui capabilities")
    names = ("getServiceInfo", "getObject", "getBalance")
    result: list[str] = []
    for name in names:
        method = next(
            (
                item.get("wireOperation")
                for item in capabilities
                if isinstance(item, dict) and item.get("publicOperation") == name
            ),
            None,
        )
        if not isinstance(method, str):
            raise RuntimeError(f"missing generated Sui method: {name}")
        result.append(method)
    return tuple(result)


SUI_GRPC_WEB_METHODS = _generated_sui_methods()


def _origin_root(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def _append_method(base: str, method: str) -> str:
    parsed = urlsplit(base)
    prefix = parsed.path.rstrip("/")
    return urlunsplit(
        (parsed.scheme, parsed.netloc, f"{prefix}{method}" or method, parsed.query, "")
    )


def _request_headers(
    direct: bool, headers: Mapping[str, str], api_key: str | None
) -> httpx.Headers:
    values = (
        dict(headers)
        if direct
        else {name: value for name, value in headers.items() if name.lower() != "authorization"}
    )
    if not direct:
        if api_key is None:
            raise ErpcNotConfiguredError("sui.grpc")
        values["authorization"] = f"Bearer {api_key}"
    try:
        result = httpx.Headers(values)
    except (TypeError, UnicodeError, ValueError):
        raise ErpcConfigError("HTTP headers must contain valid HTTP values") from None
    result["content-type"] = SUI_GRPC_WEB_CONTENT_TYPE
    result["accept"] = SUI_GRPC_WEB_CONTENT_TYPE
    result["x-grpc-web"] = "1"
    return result


def _frame_length(body: bytes, offset: int) -> int:
    if offset + 5 > len(body):
        raise ErpcInvalidResponseError("Sui response framing is invalid")
    length = int.from_bytes(body[offset + 1 : offset + 5], "big")
    if offset + 5 + length > len(body):
        raise ErpcInvalidResponseError("Sui response framing is invalid")
    return length


def _valid_header_name(value: str) -> bool:
    return bool(value) and all(
        ("0" <= character <= "9")
        or ("a" <= character <= "z")
        or character in "!#$%&'*+-.^_`|~"
        for character in value
    )


def _validate_trailer(payload: bytes) -> None:
    if len(payload) > SUI_TRAILER_LIMIT:
        raise ErpcInvalidResponseError("Sui response trailer is too large")
    text: str | None = None
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        pass
    if text is None or not text.endswith("\r\n"):
        raise ErpcInvalidResponseError("Sui response trailer is invalid")
    status_count = 0
    for line in text.split("\r\n")[:-1]:
        separator = line.find(":")
        if separator <= 0:
            raise ErpcInvalidResponseError("Sui response trailer is invalid")
        name = line[:separator]
        value = line[separator + 1 :]
        if not _valid_header_name(name) or any(
            (ord(character) < 0x20 and ord(character) != 0x09) or ord(character) == 0x7F
            for character in value
        ):
            raise ErpcInvalidResponseError("Sui response trailer is invalid")
        if name == "grpc-status":
            status_count += 1
            if status_count != 1 or value.strip(" \t") != "0":
                raise ErpcInvalidResponseError("Sui response status is invalid")
    if status_count != 1:
        raise ErpcInvalidResponseError("Sui response status is missing")


def _extract_data_frame(body: bytes) -> bytes:
    if len(body) < 10 or body[0] != 0:
        raise ErpcInvalidResponseError("Sui response framing is invalid")
    data_length = _frame_length(body, 0)
    trailer_offset = 5 + data_length
    if trailer_offset >= len(body) or body[trailer_offset] != 0x80:
        raise ErpcInvalidResponseError("Sui response framing is invalid")
    trailer_length = _frame_length(body, trailer_offset)
    if trailer_offset + 5 + trailer_length != len(body):
        raise ErpcInvalidResponseError("Sui response framing is invalid")
    _validate_trailer(body[trailer_offset + 5 :])
    return body[5:trailer_offset]


async def _read_body(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    too_large = False
    transport = False
    try:
        async for chunk in response.aiter_bytes():
            if total + len(chunk) > SUI_RESPONSE_LIMIT:
                too_large = True
                break
            total += len(chunk)
            chunks.append(chunk)
    except httpx.HTTPError:
        transport = True
    if transport:
        raise ErpcTransportError("Unable to read Sui gRPC-Web response")
    if too_large:
        raise ErpcInvalidResponseError("Sui response is too large")
    return b"".join(chunks)


class SuiGrpcWebTransport:
    """One-attempt streamed Sui gRPC-Web unary transport."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        endpoint: str | None = None,
        direct_endpoint: SuiGrpcWebEndpointConfig | str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
        namespace: str = "sui.grpc",
    ) -> None:
        self._api_key = api_key.strip() if isinstance(api_key, str) and api_key.strip() else None
        self._timeout = float(timeout)
        if self._timeout <= 0:
            raise ErpcConfigError("timeout must be positive")
        self._namespace = namespace
        self._http_client = http_client or httpx.AsyncClient(timeout=None, follow_redirects=False)
        self._owns_http_client = http_client is None
        self._direct = direct_endpoint is not None
        if direct_endpoint is not None:
            config = (
                direct_endpoint
                if isinstance(direct_endpoint, SuiGrpcWebEndpointConfig)
                else SuiGrpcWebEndpointConfig(direct_endpoint, headers or {})
            )
            self._base_url = config.base_url
            self._headers = dict(config.headers)
            self._available = True
        elif self._api_key is not None:
            self._base_url = endpoint or "https://sui.erpc.global/"
            self._headers = dict(headers or {})
            self._available = True
        else:
            self._base_url = ""
            self._headers = {}
            self._available = False
        self._request_headers = (
            _request_headers(self._direct, self._headers, self._api_key)
            if self._available
            else httpx.Headers()
        )

    @property
    def endpoint(self) -> str:
        return _origin_root(self._base_url) if self._available else ""

    async def execute(
        self,
        method: str,
        body: bytes,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> bytes:
        if method not in SUI_GRPC_WEB_METHODS:
            raise ErpcConfigError("Sui method is not in the accepted unary contract")
        if not self._available:
            raise ErpcNotConfiguredError(self._namespace)
        if len(body) > 1_048_576:
            raise ErpcConfigError("Sui request exceeds 1 MiB")
        response_bytes = await _run_with_deadline(
            self._send_and_read(method, body), self._timeout, options
        )
        return _extract_data_frame(response_bytes)

    async def _send_and_read(self, method: str, body: bytes) -> bytes:
        response: httpx.Response | None = None
        response_bytes: bytes | None = None
        failure: ErpcHttpError | ErpcInvalidResponseError | ErpcTransportError | None = None
        try:
            request = httpx.Request(
                "POST",
                _append_method(self._base_url, method),
                headers=self._request_headers,
                content=body,
            )
            response = await self._http_client.send(
                request,
                auth=None,
                follow_redirects=False,
                stream=True,
            )
            if response.status_code != 200:
                raise ErpcHttpError(response.status_code)
            if response.headers.get("content-type") != SUI_GRPC_WEB_CONTENT_TYPE:
                raise ErpcInvalidResponseError("Sui response content type is invalid")
            response_bytes = await _read_body(response)
        except ErpcHttpError as error:
            failure = error
        except ErpcInvalidResponseError as error:
            failure = error
        except ErpcTransportError as error:
            failure = error
        except httpx.HTTPError:
            failure = ErpcTransportError("Unable to reach Sui gRPC-Web endpoint")
        finally:
            await _close_response(response)
        if failure is not None:
            raise failure
        if response_bytes is None:
            raise ErpcTransportError("Unable to reach Sui gRPC-Web endpoint")
        return response_bytes

    async def close(self) -> None:
        if self._owns_http_client:
            await self._http_client.aclose()


__all__ = [
    "SUI_GRPC_WEB_CONTENT_TYPE",
    "SUI_GRPC_WEB_METHODS",
    "SuiGrpcWebTransport",
]
