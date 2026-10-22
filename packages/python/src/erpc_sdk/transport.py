"""Async HTTP transports with explicit timeout, cancellation, and redaction."""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import AsyncIterator, Awaitable, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import TypeVar, cast
from urllib.parse import urlsplit, urlunsplit

import httpx

from .config import endpoint_with_path
from .errors import (
    ErpcAbortedError,
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    ErpcTimeoutError,
    ErpcTransportError,
    redact_text,
    redact_value,
)
from .types import (
    DEFAULT_REQUEST_OPTIONS,
    JsonRpcId,
    JsonRpcParams,
    JsonValue,
    RequestOptions,
    RpcBatchCall,
)

T = TypeVar("T")
QueryValue = bool | float | int | Sequence[str] | str | None


def _response_json(response: httpx.Response) -> object:
    """Parse a response without retaining parser context or response bodies."""
    parse_error: ErpcInvalidResponseError | None = None
    try:
        value = response.json()
    except ValueError:
        parse_error = ErpcInvalidResponseError("ERPC returned malformed JSON")
    if parse_error is not None:
        # Raising after leaving the native parser's exception handler keeps
        # its body and context out of the public SDK error.
        raise parse_error
    return value


def _direct_headers(headers: Mapping[str, str]) -> httpx.Headers:
    """Build direct headers without retaining native construction errors."""
    construction_error: ErpcConfigError | None = None
    try:
        result = httpx.Headers(headers)
    except (TypeError, UnicodeError, ValueError):
        construction_error = ErpcConfigError(
            "direct endpoint headers must contain valid HTTP values"
        )
    if construction_error is not None:
        raise construction_error
    result["accept"] = "application/json"
    result["content-type"] = "application/json"
    return result


def _direct_request(endpoint: str, headers: httpx.Headers, body: object) -> httpx.Request:
    """Build a direct request while discarding URL/body construction details."""
    construction_error: ErpcTransportError | None = None
    try:
        request = httpx.Request("POST", endpoint, headers=headers, json=body)
    except (TypeError, UnicodeError, ValueError, httpx.InvalidURL):
        construction_error = ErpcTransportError("Unable to construct direct HTTP request")
    if construction_error is not None:
        raise construction_error
    return request


async def _wait(awaitable: Awaitable[T], timeout: float, options: RequestOptions) -> T:
    request_task = asyncio.ensure_future(awaitable)
    cancel_task: asyncio.Task[bool] | None = None
    try:
        async with asyncio.timeout(timeout):
            if options.cancel_event is None:
                return await request_task
            if options.cancel_event.is_set():
                request_task.cancel()
                raise ErpcAbortedError
            cancel_task = asyncio.create_task(options.cancel_event.wait())
            done, _ = await asyncio.wait(
                {request_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if cancel_task in done:
                request_task.cancel()
                await asyncio.gather(request_task, return_exceptions=True)
                raise ErpcAbortedError
            cancel_task.cancel()
            return await request_task
    except TimeoutError:
        request_task.cancel()
        await asyncio.gather(request_task, return_exceptions=True)
        raise ErpcTimeoutError(timeout) from None
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()


def _valid_id(value: object) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)) or isinstance(value, str)


class HttpJsonRpcTransport:
    """Credential-safe transport for intact JSON-RPC requests and batches."""

    def __init__(
        self,
        *,
        api_key: str | None,
        endpoint: str,
        headers: Mapping[str, str],
        timeout: float,
        client: httpx.AsyncClient,
        max_batch_size: int = 256,
        direct: bool = False,
        redactions: Iterable[str] = (),
    ) -> None:
        self._api_key = api_key
        self._endpoint = endpoint
        self._headers = dict(headers)
        self._timeout = timeout
        self._client = client
        self._max_batch_size = max_batch_size
        self._direct = direct
        self._redactions = tuple(redactions)
        self._ids = itertools.count(1)

    @property
    def endpoint(self) -> str:
        """Return the public endpoint without credentials."""
        return strip_url_query(self._endpoint) if self._direct else self._endpoint

    @property
    def max_batch_size(self) -> int:
        return self._max_batch_size

    def _id(self) -> int:
        return next(self._ids)

    async def request(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        request_id = self._id()
        body: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            body["params"] = params
        response = await self._post(body, options)
        return self._unwrap(response, request_id)

    async def batch(
        self,
        calls: Sequence[RpcBatchCall],
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> list[JsonValue]:
        if not calls:
            return []
        if len(calls) > self._max_batch_size:
            raise ErpcInvalidResponseError(
                f"A batch may contain at most {self._max_batch_size} calls"
            )
        requests: list[dict[str, object]] = []
        for call in calls:
            item: dict[str, object] = {
                "jsonrpc": "2.0",
                "id": self._id(),
                "method": call["method"],
            }
            if "params" in call:
                item["params"] = call["params"]
            requests.append(item)
        response = await self._post(requests, options)
        if not isinstance(response, list):
            if isinstance(response, dict) and isinstance(response.get("error"), dict):
                self._raise_rpc(cast(dict[str, object], response["error"]))
            raise ErpcInvalidResponseError("ERPC returned a non-array batch response")
        by_id: dict[JsonRpcId, object] = {}
        for response_item in response:
            if not isinstance(response_item, dict) or not _valid_id(response_item.get("id")):
                raise ErpcInvalidResponseError("ERPC returned an invalid batch item")
            item_id = cast(JsonRpcId, response_item["id"])
            if item_id in by_id:
                raise ErpcInvalidResponseError("ERPC returned a duplicate batch id")
            by_id[item_id] = response_item
        results: list[JsonValue] = []
        for request in requests:
            request_id = cast(JsonRpcId, request["id"])
            response_item = by_id.pop(request_id, None)
            if response_item is None:
                raise ErpcInvalidResponseError(f"ERPC omitted batch response id {request_id}")
            results.append(self._unwrap(response_item, request_id))
        if by_id:
            raise ErpcInvalidResponseError("ERPC returned an unexpected batch response id")
        return results

    async def _post(self, body: object, options: RequestOptions) -> object:
        transport_error: ErpcTransportError | None = None
        try:
            if self._direct:
                request = _direct_request(
                    self._endpoint,
                    _direct_headers(self._headers),
                    body,
                )
                response = await _wait(
                    self._client.send(
                        request,
                        auth=None,
                        follow_redirects=False,
                    ),
                    self._timeout,
                    options,
                )
            else:
                if self._api_key is None:
                    raise ErpcNotConfiguredError("rpc")
                response = await _wait(
                    self._client.post(
                        self._endpoint,
                        params={"api-key": self._api_key},
                        headers=self._headers,
                        json=body,
                    ),
                    self._timeout,
                    options,
                )
        except (ErpcAbortedError, ErpcTimeoutError):
            raise
        except httpx.HTTPError:
            transport_error = ErpcTransportError()
        if transport_error is not None:
            # Raise after leaving the native exception handler so its context
            # is not retained on the SDK error object.
            raise transport_error
        if not response.is_success:
            raise ErpcHttpError(response.status_code)
        return _response_json(response)

    def _unwrap(self, response: object, expected_id: JsonRpcId) -> JsonValue:
        if not isinstance(response, dict) or response.get("id") != expected_id:
            raise ErpcInvalidResponseError("ERPC returned an unexpected response id")
        if "error" in response:
            error = response["error"]
            if not isinstance(error, dict):
                raise ErpcInvalidResponseError("ERPC returned an invalid RPC error")
            self._raise_rpc(cast(dict[str, object], error))
        if "result" not in response:
            raise ErpcInvalidResponseError("ERPC returned an invalid response")
        return cast(JsonValue, response["result"])

    def _raise_rpc(self, error: dict[str, object]) -> None:
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
            raise ErpcInvalidResponseError("ERPC returned an invalid RPC error")
        data = error.get("data")
        credentials = self._redactions if self._direct else (self._api_key or "")
        raise ErpcJsonRpcError(
            code,
            redact_text(message, credentials),
            redact_value(data, credentials) if data is not None else None,
        )


class UnavailableHttpJsonRpcTransport(HttpJsonRpcTransport):
    """A local transport target for an unconfigured RPC namespace."""

    def __init__(self, namespace: str) -> None:
        self._namespace = namespace
        self._max_batch_size = 256

    @property
    def endpoint(self) -> str:
        return ""

    @property
    def max_batch_size(self) -> int:
        return self._max_batch_size

    async def request(
        self,
        method: str,
        params: JsonRpcParams | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        del method, params, options
        raise ErpcNotConfiguredError(self._namespace)

    async def batch(
        self,
        calls: Sequence[RpcBatchCall],
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> list[JsonValue]:
        del options
        if not calls:
            return []
        if len(calls) > self._max_batch_size:
            raise ErpcInvalidResponseError(
                f"A batch may contain at most {self._max_batch_size} calls"
            )
        raise ErpcNotConfiguredError(self._namespace)


class RestTransport:
    """Bearer-authenticated async JSON and SSE transport."""

    def __init__(
        self,
        *,
        credential: str,
        endpoint: str,
        headers: Mapping[str, str],
        timeout: float,
        client: httpx.AsyncClient,
    ) -> None:
        self._credential = credential
        self._endpoint = endpoint
        self._headers = dict(headers)
        self._timeout = timeout
        self._client = client

    @property
    def endpoint(self) -> str:
        return self._endpoint

    def url(self, path: str) -> str:
        return endpoint_with_path(self._endpoint, path)

    @staticmethod
    def query(query: Mapping[str, QueryValue] | None) -> httpx.QueryParams:
        result = httpx.QueryParams()
        for key, value in (query or {}).items():
            if value is None:
                continue
            if isinstance(value, Sequence) and not isinstance(value, str):
                for item in value:
                    result = result.add(key, item)
            elif isinstance(value, bool):
                result = result.add(key, str(value).lower())
            else:
                result = result.add(key, str(value))
        return result

    def _request(self, path: str, query: Mapping[str, QueryValue] | None) -> httpx.Request:
        headers = {
            **self._headers,
            "authorization": f"Bearer {self._credential}",
            "accept": "application/json",
        }
        return self._client.build_request(
            "GET",
            self.url(path),
            params=self.query(query),
            headers=headers,
        )

    async def get(
        self,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        try:
            response = await _wait(
                self._client.send(self._request(path, query)), self._timeout, options
            )
        except (ErpcAbortedError, ErpcTimeoutError):
            raise
        except httpx.HTTPError:
            raise ErpcTransportError() from None
        if not response.is_success:
            raise ErpcHttpError(response.status_code)
        return cast(JsonValue, _response_json(response))

    @asynccontextmanager
    async def stream(
        self,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> AsyncIterator[httpx.Response]:
        request = self._request(path, query)
        try:
            response = await _wait(self._client.send(request, stream=True), self._timeout, options)
        except (ErpcAbortedError, ErpcTimeoutError):
            raise
        except httpx.HTTPError:
            raise ErpcTransportError() from None
        if not response.is_success:
            await response.aclose()
            raise ErpcHttpError(response.status_code)
        try:
            yield response
        except httpx.HTTPError:
            raise ErpcTransportError() from None
        finally:
            await response.aclose()


class UnavailableRestTransport(RestTransport):
    """A local transport target for an unconfigured REST/SSE namespace."""

    def __init__(self, namespace: str) -> None:
        self._namespace = namespace

    @property
    def endpoint(self) -> str:
        return ""

    def url(self, path: str) -> str:
        del path
        return ""

    async def get(
        self,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> JsonValue:
        del path, query, options
        raise ErpcNotConfiguredError(self._namespace)

    @asynccontextmanager
    async def stream(
        self,
        path: str,
        query: Mapping[str, QueryValue] | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> AsyncIterator[httpx.Response]:
        del path, query, options
        raise ErpcNotConfiguredError(self._namespace)
        yield cast(httpx.Response, None)


def strip_url_query(url: str) -> str:
    """Return a URL safe for public display."""
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
