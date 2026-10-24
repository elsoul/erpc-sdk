"""Dedicated streamed HTTP transport for the Bitcoin read facade."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .bitcoin_codec import (
    BITCOIN_RESPONSE_LIMITS,
    BitcoinJsonValue,
    BitcoinResultProjector,
    unwrap_bitcoin_rpc_response,
)
from .config import RpcEndpointConfig, direct_endpoint_redactions
from .errors import (
    ErpcAbortedError,
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcNotConfiguredError,
    ErpcTimeoutError,
    ErpcTransportError,
)
from .types import DEFAULT_REQUEST_OPTIONS, JsonRpcParams, RequestOptions


@dataclass(frozen=True, slots=True)
class BitcoinTransportFacts:
    """Immutable selected facts from the accepted A contract."""

    hosted_target: str
    method_names: tuple[str, ...]
    public_methods: tuple[tuple[str, str], ...]

    def wire_method(self, public_name: str) -> str:
        for candidate, wire_name in self.public_methods:
            if candidate == public_name:
                return wire_name
        raise ErpcConfigError("Bitcoin public method is absent from the accepted contract")


def _invalid_facts() -> ErpcConfigError:
    return ErpcConfigError("Bitcoin contract facts are unavailable")


def bitcoin_transport_facts(contract: Mapping[str, object]) -> BitcoinTransportFacts:
    """Select only Bitcoin's accepted A facts without copying a production list."""

    try:
        client_contracts = contract["clientContracts"]
        method_sets = contract["methodSets"]
        if not isinstance(client_contracts, list) or not isinstance(method_sets, list):
            raise _invalid_facts()
        client = next(
            item
            for item in client_contracts
            if isinstance(item, dict) and item.get("clientContractId") == "client-bitcoin-rpc"
        )
        modes = client["endpointModes"]
        method_set_id = client["methodSetId"]
        if not isinstance(modes, list) or not isinstance(method_set_id, str):
            raise _invalid_facts()
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
            raise _invalid_facts()
        selected: list[tuple[str, str]] = []
        for capability in capabilities:
            if not isinstance(capability, dict):
                raise _invalid_facts()
            wire_name = capability.get("wireOperation")
            public_names = capability.get("publicNames")
            public_name = public_names.get("python") if isinstance(public_names, dict) else None
            if not isinstance(wire_name, str) or not isinstance(public_name, str):
                raise _invalid_facts()
            selected.append((public_name, wire_name))
        methods = tuple(wire_name for _, wire_name in selected)
    except (KeyError, StopIteration, TypeError):
        raise _invalid_facts() from None
    if not methods or len(methods) != len(capabilities):
        raise _invalid_facts()
    return BitcoinTransportFacts(target, methods, tuple(selected))


def _validate_http_url(value: str, *, direct: bool) -> str:
    error: ErpcConfigError | None = None
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except (TypeError, ValueError):
        error = ErpcConfigError("HTTP endpoint must be an absolute HTTP(S) URL")
    if error is not None:
        raise error
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
        raise ErpcConfigError("HTTP endpoint must be an absolute HTTP(S) URL")
    if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
        raise ErpcConfigError("HTTP endpoint must not contain userinfo")
    if parsed.fragment != "" or "#" in value:
        raise ErpcConfigError("HTTP endpoint must not contain a fragment")
    if direct:
        return value
    return value


def _origin_root(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def _append_path(root: str, suffix: str) -> str:
    parsed = urlsplit(root)
    base = parsed.path.rstrip("/")
    suffix = suffix.strip("/")
    path = f"{base}/{suffix}" if base else f"/{suffix}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))


def _remove_query_key(value: str, key: str) -> str:
    parsed = urlsplit(value)
    query = [
        (name, item)
        for name, item in parse_qsl(parsed.query, keep_blank_values=True)
        if name.lower() != key.lower()
    ]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def _request_headers(
    *,
    direct: bool,
    headers: Mapping[str, str],
    api_key: str | None,
) -> httpx.Headers:
    values: dict[str, str] = {}
    if direct:
        values.update(headers)
    else:
        values.update(
            (name, value) for name, value in headers.items() if name.lower() != "authorization"
        )
        if api_key is None:
            raise ErpcNotConfiguredError("bitcoin.rpc")
        values["authorization"] = f"Bearer {api_key}"
    construction_error: ErpcConfigError | None = None
    try:
        result = httpx.Headers(values)
    except (TypeError, UnicodeError, ValueError):
        construction_error = ErpcConfigError("HTTP headers must contain valid HTTP values")
    if construction_error is not None:
        raise construction_error
    result["accept"] = "application/json"
    result["content-type"] = "application/json"
    return result


async def _run_with_deadline(
    awaitable: Awaitable[Any],
    timeout: float,
    options: RequestOptions,
) -> Any:
    """Wait for headers and body under one total timeout/cancellation scope."""

    task = asyncio.ensure_future(awaitable)
    cancel_task: asyncio.Task[bool] | None = None
    timed_out = False
    try:
        async with asyncio.timeout(timeout):
            if options.cancel_event is None:
                return await task
            if options.cancel_event.is_set():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise ErpcAbortedError()
            cancel_task = asyncio.create_task(options.cancel_event.wait())
            done, _ = await asyncio.wait({task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
            if cancel_task in done:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise ErpcAbortedError()
            cancel_task.cancel()
            return await task
    except TimeoutError:
        timed_out = True
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()
    if timed_out:
        raise ErpcTimeoutError(timeout)


async def _read_stream_text(
    response: httpx.Response,
    *,
    max_bytes: int,
) -> str:
    chunks: list[bytes] = []
    byte_count = 0
    invalid = False
    transport = False
    try:
        async for chunk in response.aiter_bytes():
            next_count = byte_count + len(chunk)
            if next_count > max_bytes:
                invalid = True
                break
            byte_count = next_count
            chunks.append(chunk)
    except ErpcInvalidResponseError:
        invalid = True
    except UnicodeDecodeError:
        invalid = True
    except httpx.HTTPError:
        transport = True
    if transport:
        raise ErpcTransportError()
    if invalid:
        raise ErpcInvalidResponseError()
    body = b"".join(chunks)
    try:
        return body.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        pass
    raise ErpcInvalidResponseError()


async def _close_response(response: httpx.Response | None) -> None:
    if response is None:
        return
    try:
        await response.aclose()
    except (httpx.HTTPError, RuntimeError):
        # Closing is best-effort after an already failed stream/cancellation.
        return


class BitcoinHttpTransport:
    """One-attempt, credential-scoped, streamed Bitcoin JSON-RPC transport."""

    def __init__(
        self,
        *,
        facts: BitcoinTransportFacts,
        api_key: str | None = None,
        endpoint: str | None = None,
        direct_endpoint: RpcEndpointConfig | str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
        namespace: str = "bitcoin.rpc",
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
                raise ErpcConfigError("bitcoin_rpc does not support WebSocket URLs")
            self._target = _validate_http_url(config.http_url, direct=True)
            self._headers = dict(config.headers)
            self._redactions = direct_endpoint_redactions(config)
            self._available = True
        elif self._api_key is not None:
            root = endpoint or facts.hosted_target
            root = _validate_http_url(root, direct=False)
            target = root
            hosted_path = urlsplit(facts.hosted_target).path.strip("/")
            if hosted_path and not urlsplit(root).path.rstrip("/").endswith(f"/{hosted_path}"):
                target = _append_path(root, hosted_path)
            self._target = _remove_query_key(target, "api-key")
            self._headers = dict(headers or {})
            self._redactions = (self._api_key,)
            self._available = True
        else:
            self._target = ""
            self._headers = {}
            self._available = False

        self._request_headers = (
            _request_headers(
                direct=self._direct,
                headers=self._headers,
                api_key=self._api_key,
            )
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
        params: JsonRpcParams | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
        *,
        projector: BitcoinResultProjector | None = None,
    ) -> BitcoinJsonValue | Any:
        if method not in self._facts.method_names:
            raise ErpcConfigError("Bitcoin method is not in the accepted named-read contract")
        if not self._available:
            raise ErpcNotConfiguredError(self._namespace)
        request_id = self._next_id
        self._next_id = 1 if request_id >= 2_147_483_647 else request_id + 1
        body: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": list(params) if params is not None else [],
        }
        try:
            raw_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            raise ErpcInvalidResponseError() from None
        response_text = await _run_with_deadline(
            self._send_and_read(raw_body), self._timeout, options
        )
        return unwrap_bitcoin_rpc_response(
            response_text,
            request_id,
            redactions=self._redactions,
            projector=projector,
        )

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


__all__ = [
    "BitcoinHttpTransport",
    "BitcoinTransportFacts",
    "bitcoin_transport_facts",
]
