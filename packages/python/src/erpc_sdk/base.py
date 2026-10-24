"""Explicit sealed Base JSON-RPC read facade for bootstrap source tests."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .bitcoin_codec import BITCOIN_RESPONSE_LIMITS
from .bitcoin_transport import (
    _close_response,
    _read_stream_text,
    _run_with_deadline,
    _validate_http_url,
)
from .config import RpcEndpointConfig, direct_endpoint_redactions
from .errors import (
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    ErpcTransportError,
    redact_text,
    redact_value,
)
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class SealedEvmTransportFacts:
    """Immutable selected client/method facts from the accepted A contract."""

    hosted_target: str
    method_names: tuple[str, ...]
    public_methods: tuple[tuple[str, str], ...]

    def wire_method(self, public_name: str) -> str:
        for candidate, wire_name in self.public_methods:
            if candidate == public_name:
                return wire_name
        raise ErpcConfigError("sealed EVM public method is absent from the accepted contract")


def sealed_evm_transport_facts(
    contract: Mapping[str, object],
    client_contract_id: str,
) -> SealedEvmTransportFacts:
    """Select one sealed-EVM client from accepted A data for source-unit tests."""

    try:
        clients = contract["clientContracts"]
        method_sets = contract["methodSets"]
        if not isinstance(clients, list) or not isinstance(method_sets, list):
            raise ErpcConfigError("sealed EVM contract facts are unavailable")
        client = next(
            item
            for item in clients
            if isinstance(item, dict) and item.get("clientContractId") == client_contract_id
        )
        modes = client["endpointModes"]
        method_set_id = client["methodSetId"]
        if not isinstance(modes, list) or not isinstance(method_set_id, str):
            raise ErpcConfigError("sealed EVM contract facts are unavailable")
        hosted = next(
            item for item in modes if isinstance(item, dict) and item.get("mode") == "hosted"
        )
        target = hosted.get("defaultTarget")
        method_set = next(
            item
            for item in method_sets
            if isinstance(item, dict) and item.get("methodSetId") == method_set_id
        )
        capabilities = method_set["capabilities"]
        if not isinstance(target, str) or not isinstance(capabilities, list):
            raise ErpcConfigError("sealed EVM contract facts are unavailable")
        selected: list[tuple[str, str]] = []
        for capability in capabilities:
            if not isinstance(capability, dict):
                raise ErpcConfigError("sealed EVM contract facts are unavailable")
            wire_name = capability.get("wireOperation")
            public_names = capability.get("publicNames")
            public_name = public_names.get("python") if isinstance(public_names, dict) else None
            if not isinstance(wire_name, str) or not isinstance(public_name, str):
                raise ErpcConfigError("sealed EVM contract facts are unavailable")
            selected.append((public_name, wire_name))
        methods = tuple(wire_name for _, wire_name in selected)
    except (KeyError, StopIteration, TypeError):
        raise ErpcConfigError("sealed EVM contract facts are unavailable") from None
    if len(methods) != len(capabilities) or not methods:
        raise ErpcConfigError("sealed EVM contract facts are unavailable")
    return SealedEvmTransportFacts(target, methods, tuple(selected))


_GENERATED_BASE_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-base-rpc")
BASE_RPC_METHODS = _GENERATED_BASE_FACTS.method_names


def _origin_root(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def _set_api_key(value: str, api_key: str) -> str:
    parsed = urlsplit(value)
    pairs = [
        (name, item)
        for name, item in parse_qsl(parsed.query, keep_blank_values=True)
        if name.lower() != "api-key"
    ]
    pairs.append(("api-key", api_key))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(pairs), ""))


def _evm_headers(*, direct: bool, headers: Mapping[str, str]) -> httpx.Headers:
    values = dict(headers)
    try:
        result = httpx.Headers(values)
    except (TypeError, UnicodeError, ValueError):
        raise ErpcConfigError("HTTP headers must contain valid HTTP values") from None
    result["accept"] = "application/json"
    result["content-type"] = "application/json"
    del direct
    return result


def _evm_id(value: object) -> int | str:
    if isinstance(value, bool):
        raise ErpcInvalidResponseError()
    if isinstance(value, (int, str)):
        return value
    raise ErpcInvalidResponseError()


def _unwrap_evm_response(
    text: str,
    expected_id: int,
    redactions: tuple[str, ...],
) -> str:
    parse_error: ErpcInvalidResponseError | None = None
    try:
        response = json.loads(text)
    except (TypeError, ValueError, RecursionError):
        parse_error = ErpcInvalidResponseError()
    if parse_error is not None:
        raise parse_error
    if not isinstance(response, dict) or _evm_id(response.get("id")) != expected_id:
        raise ErpcInvalidResponseError()
    if "error" in response and response["error"] is not None:
        error = response["error"]
        if not isinstance(error, dict):
            raise ErpcInvalidResponseError()
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
            raise ErpcInvalidResponseError()
        data = error.get("data")
        raise ErpcJsonRpcError(
            code,
            redact_text(message, redactions),
            redact_value(data, redactions) if data is not None else None,
        )
    result = response.get("result")
    if not isinstance(result, str):
        raise ErpcInvalidResponseError()
    return result


class _SealedEvmHttpTransport:
    """Private transport shared by Base and Arbitrum's explicit facades."""

    __slots__ = (
        "_facts",
        "_api_key",
        "_target",
        "_headers",
        "_request_headers",
        "_timeout",
        "_http_client",
        "_owns_http_client",
        "_direct",
        "_redactions",
        "_namespace",
        "_available",
        "_next_id",
    )

    def __init__(
        self,
        *,
        facts: SealedEvmTransportFacts,
        api_key: str | None = None,
        endpoint: str | None = None,
        direct_endpoint: RpcEndpointConfig | str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
        namespace: str,
    ) -> None:
        self._facts = facts
        self._api_key = api_key.strip() if isinstance(api_key, str) and api_key.strip() else None
        self._timeout = float(timeout)
        if self._timeout <= 0:
            raise ErpcConfigError("timeout must be positive")
        self._namespace = namespace
        self._http_client = http_client or httpx.AsyncClient(timeout=None, follow_redirects=False)
        self._owns_http_client = http_client is None
        self._next_id = 1
        self._direct = direct_endpoint is not None
        self._redactions: tuple[str, ...] = ()

        if direct_endpoint is not None:
            config = (
                direct_endpoint
                if isinstance(direct_endpoint, RpcEndpointConfig)
                else RpcEndpointConfig(direct_endpoint, headers=headers or {})
            )
            if config.websocket_url is not None:
                raise ErpcConfigError(f"{namespace} does not support WebSocket URLs")
            self._target = _validate_http_url(config.http_url, direct=True)
            self._headers = dict(config.headers)
            self._redactions = direct_endpoint_redactions(config)
            self._available = True
        elif self._api_key is not None:
            root = _validate_http_url(endpoint or facts.hosted_target, direct=False)
            self._target = _set_api_key(root, self._api_key)
            self._headers = dict(headers or {})
            self._redactions = (self._api_key,)
            self._available = True
        else:
            self._target = ""
            self._headers = {}
            self._available = False
        self._request_headers = (
            _evm_headers(direct=self._direct, headers=self._headers)
            if self._available
            else httpx.Headers()
        )

    @property
    def endpoint(self) -> str:
        return _origin_root(self._target) if self._available else ""

    @property
    def method_names(self) -> tuple[str, ...]:
        return self._facts.method_names

    def wire_method(self, public_name: str) -> str:
        return self._facts.wire_method(public_name)

    async def request(
        self,
        method: str,
        params: list[Any],
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> str:
        if method not in self._facts.method_names:
            raise ErpcConfigError("sealed EVM method is not in the accepted named-read contract")
        if not self._available:
            raise ErpcNotConfiguredError(self._namespace)
        request_id = self._next_id
        self._next_id = 1 if request_id >= 2_147_483_647 else request_id + 1
        body = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": list(params),
        }
        try:
            raw_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            raise ErpcInvalidResponseError() from None
        text = await _run_with_deadline(self._send_and_read(raw_body), self._timeout, options)
        return _unwrap_evm_response(text, request_id, self._redactions)

    async def _send_and_read(self, raw_body: bytes) -> str:
        response: httpx.Response | None = None
        response_text: str | None = None
        failure: ErpcHttpError | ErpcInvalidResponseError | ErpcTransportError | None = None
        try:
            request = httpx.Request(
                "POST",
                self._target,
                headers=self._request_headers,
                content=raw_body,
            )
            response = await self._http_client.send(
                request,
                auth=None,
                follow_redirects=False,
                stream=True,
            )
            if not response.is_success:
                raise ErpcHttpError(response.status_code)
            response_text = await _read_stream_text(
                response,
                max_bytes=BITCOIN_RESPONSE_LIMITS.decoded_entity_bytes,
            )
        except ErpcHttpError as error:
            failure = error
        except ErpcInvalidResponseError as error:
            failure = error
        except ErpcTransportError as error:
            failure = error
        except httpx.HTTPError:
            failure = ErpcTransportError()
        finally:
            await _close_response(response)
        if failure is not None:
            raise failure
        if response_text is None:
            raise ErpcTransportError()
        return response_text

    async def close(self) -> None:
        if self._owns_http_client:
            await self._http_client.aclose()


class _SealedEvmPendingRequest(Generic[T]):
    __slots__ = ("_callback",)

    def __init__(self, callback: Callable[[RequestOptions], Awaitable[T]]) -> None:
        self._callback = callback

    async def send(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> T:
        return await self._callback(options)


def _method(transport: _SealedEvmHttpTransport, name: str) -> str:
    return transport.wire_method(name)


def _pending(
    transport: _SealedEvmHttpTransport,
    method: str,
    params: list[Any],
) -> _SealedEvmPendingRequest[str]:
    async def execute(options: RequestOptions) -> str:
        return await transport.request(method, params, options)

    return _SealedEvmPendingRequest(execute)


class SealedEvmRpcClient:
    """Private implementation of the common sealed three-read surface."""

    __slots__ = ("_transport",)

    def __init__(self, transport: _SealedEvmHttpTransport) -> None:
        self._transport = transport

    @property
    def endpoint(self) -> str:
        return self._transport.endpoint

    def eth_chain_id(self) -> _SealedEvmPendingRequest[str]:
        return _pending(self._transport, _method(self._transport, "eth_chain_id"), [])

    def eth_get_balance(
        self,
        address: str,
        block: str | None = None,
    ) -> _SealedEvmPendingRequest[str]:
        params: list[Any] = [address]
        if block is not None:
            params.append(block)
        return _pending(self._transport, _method(self._transport, "eth_get_balance"), params)

    def eth_call(
        self,
        transaction: Mapping[str, Any],
        block: str | None = None,
        state_override: Mapping[str, Any] | None = None,
    ) -> _SealedEvmPendingRequest[str]:
        params: list[Any] = [dict(transaction)]
        if block is not None:
            params.append(block)
        if state_override is not None:
            params.append(dict(state_override))
        return _pending(self._transport, _method(self._transport, "eth_call"), params)


class BaseRpcClient(SealedEvmRpcClient):
    """Base's sealed three-read method surface."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class BaseClient:
    rpc: BaseRpcClient


def create_base_client(transport: _SealedEvmHttpTransport) -> BaseClient:
    return BaseClient(rpc=BaseRpcClient(transport))


__all__ = [
    "BASE_RPC_METHODS",
    "BaseClient",
    "BaseRpcClient",
    "SealedEvmTransportFacts",
    "create_base_client",
    "sealed_evm_transport_facts",
]
