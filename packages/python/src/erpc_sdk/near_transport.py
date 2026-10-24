"""Private, lossless JSON-RPC transport for the bounded NEAR read facade."""

from __future__ import annotations

import json
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .bitcoin_codec import BITCOIN_RESPONSE_LIMITS
from .bitcoin_transport import (
    _close_response,
    _read_stream_text,
    _run_with_deadline,
    _validate_http_url,
)
from .config import RpcEndpointConfig, direct_endpoint_redactions
from .errors import (
    ErpcBatchPolicyError,
    ErpcConfigError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    ErpcTransportError,
    redact_text,
)
from .types import DEFAULT_REQUEST_OPTIONS, RequestOptions

_U64_MAX = 18_446_744_073_709_551_615
_SAFE_ERROR_INTEGER = 9_007_199_254_740_991


class _NearIntegerToken:
    __slots__ = ("raw",)

    def __init__(self, raw: str) -> None:
        self.raw = raw


def _ordinary_integer_token(token: _NearIntegerToken) -> int:
    value: int | None = None
    failed = False
    try:
        value = int(token.raw)
    except (OverflowError, ValueError):
        failed = True
    if failed:
        raise ErpcInvalidResponseError()
    assert value is not None
    return value


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


def _request_headers(headers: Mapping[str, str]) -> httpx.Headers:
    try:
        result = httpx.Headers(dict(headers))
    except (TypeError, UnicodeError, ValueError):
        raise ErpcConfigError("HTTP headers must contain valid HTTP values") from None
    result["accept"] = "application/json"
    result["content-type"] = "application/json"
    return result


def _encode_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _encode_near_json(value: object, seen: set[int] | None = None) -> str:
    """Encode the small private NEAR request domain without float coercion."""
    active = seen if seen is not None else set()
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ErpcInvalidResponseError("Invalid NEAR number")
        return format(value, "f")
    if isinstance(value, str):
        return _encode_string(value)
    if isinstance(value, Mapping):
        identity = id(value)
        if identity in active:
            raise ErpcInvalidResponseError("Invalid NEAR JSON value")
        active.add(identity)
        try:
            entries: list[str] = []
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ErpcInvalidResponseError("Invalid NEAR JSON value")
                entries.append(f"{_encode_string(key)}:{_encode_near_json(item, active)}")
            return "{" + ",".join(entries) + "}"
        finally:
            active.remove(identity)
    if isinstance(value, (list, tuple)):
        identity = id(value)
        if identity in active:
            raise ErpcInvalidResponseError("Invalid NEAR JSON value")
        active.add(identity)
        try:
            return "[" + ",".join(_encode_near_json(item, active) for item in value) + "]"
        finally:
            active.remove(identity)
    raise ErpcInvalidResponseError("Invalid NEAR JSON value")


def _parse_constant(_: str) -> object:
    raise ValueError("non-finite JSON number")


def _parse_near_json(text: str) -> object:
    value: object | None = None
    failed = False
    try:
        value = json.loads(
            text,
            parse_int=_NearIntegerToken,
            parse_float=Decimal,
            parse_constant=_parse_constant,
        )
    except (TypeError, ValueError, RecursionError):
        failed = True
    if failed:
        raise ErpcInvalidResponseError("ERPC returned malformed JSON")
    return value


def _numeric_id_matches(value: object, expected: int) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value == expected
    if isinstance(value, _NearIntegerToken):
        return value.raw == str(expected) or (expected == 0 and value.raw == "-0")
    if not isinstance(value, Decimal) or not value.is_finite():
        return False
    try:
        return value == Decimal(expected)
    except (InvalidOperation, OverflowError, ValueError):
        return False


def _integer_error_code(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        result = value
    elif isinstance(value, _NearIntegerToken):
        raw = value.raw
        digits = raw[1:] if raw.startswith("-") else raw
        bound = str(_SAFE_ERROR_INTEGER)
        if len(digits) > len(bound) or (
            len(digits) == len(bound) and digits > bound
        ):
            return None
        try:
            result = int(raw)
        except (OverflowError, ValueError):
            return None
    elif isinstance(value, Decimal) and value.is_finite():
        try:
            lower = Decimal(-_SAFE_ERROR_INTEGER)
            upper = Decimal(_SAFE_ERROR_INTEGER)
            if value < lower or value > upper:
                return None
            if value != value.to_integral_value():
                return None
            result = int(value)
        except (InvalidOperation, OverflowError, ValueError):
            return None
    else:
        return None
    if abs(result) > _SAFE_ERROR_INTEGER:
        return None
    return result


def _redact_near_value(value: object, redactions: tuple[str, ...], depth: int = 0) -> object:
    if depth >= 32:
        return "[REDACTED]"
    if isinstance(value, str):
        return redact_text(value, redactions)
    if isinstance(value, _NearIntegerToken):
        return _ordinary_integer_token(value)
    if isinstance(value, list):
        return [_redact_near_value(item, redactions, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_near_value(item, redactions, depth + 1) for item in value)
    if isinstance(value, dict):
        return {
            redact_text(key, redactions) if isinstance(key, str) else key: _redact_near_value(
                item, redactions, depth + 1
            )
            for key, item in value.items()
        }
    return value


class NearHttpTransport:
    """One-attempt exact JSON transport for status, block, and view_account."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        endpoint: str | None = None,
        direct_endpoint: RpcEndpointConfig | str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
        namespace: str = "near.rpc",
    ) -> None:
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
            self._target = _set_api_key(
                _validate_http_url(endpoint or "https://near.erpc.global/", direct=False),
                self._api_key,
            )
            self._headers = dict(headers or {})
            self._redactions = (self._api_key,)
            self._available = True
        else:
            self._target = ""
            self._headers = {}
            self._available = False
        self._request_headers = (
            _request_headers(self._headers) if self._available else httpx.Headers()
        )

    @property
    def endpoint(self) -> str:
        return _origin_root(self._target) if self._available else ""

    async def request(
        self,
        method: str,
        params: object | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> object:
        if not self._available:
            raise ErpcNotConfiguredError(self._namespace)
        request_id = self._next_id
        self._next_id = 1 if request_id >= 2_147_483_647 else request_id + 1
        body = (
            '{"jsonrpc":"2.0","id":'
            + str(request_id)
            + ',"method":'
            + _encode_string(method)
            + ("" if params is None else ',"params":' + _encode_near_json(params))
            + "}"
        )
        response_text = await _run_with_deadline(
            self._send_and_read(body.encode("utf-8")), self._timeout, options
        )
        return self._unwrap(response_text, request_id)

    async def batch(
        self,
        _calls: object,
        _options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> object:
        raise ErpcBatchPolicyError("NEAR RPC does not support batch calls")

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

    def _unwrap(self, text: str, expected_id: int) -> object:
        value = _parse_near_json(text)
        if not isinstance(value, dict) or not _numeric_id_matches(value.get("id"), expected_id):
            raise ErpcInvalidResponseError("ERPC returned an unexpected response id")
        error = value.get("error")
        if error is not None:
            if not isinstance(error, dict):
                raise ErpcInvalidResponseError()
            code = _integer_error_code(error.get("code"))
            message = error.get("message")
            if code is None or not isinstance(message, str):
                raise ErpcInvalidResponseError()
            data = error.get("data")
            raise ErpcJsonRpcError(
                code,
                redact_text(message, self._redactions),
                _redact_near_value(data, self._redactions) if data is not None else None,
            )
        if "result" not in value:
            raise ErpcInvalidResponseError()
        return value["result"]

    async def close(self) -> None:
        if self._owns_http_client:
            await self._http_client.aclose()


__all__ = ["NearHttpTransport"]
