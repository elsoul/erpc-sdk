"""Configuration and URL handling."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from .errors import ErpcConfigError

DEFAULT_ENDPOINT = "https://edge.erpc.global"
DEFAULT_AVALANCHE_ENDPOINT = "https://ava-rpc.erpc.global"
DEFAULT_ACCOUNT_ENDPOINT = "https://solana-rpc.erpc.global"
DEFAULT_USER_ENDPOINT = "https://user-api.erpc.global"
DEFAULT_TIMEOUT = 30.0


def _direct_url(value: object, *, websocket: bool) -> str:
    """Validate a direct endpoint while preserving its exact request target."""
    if not isinstance(value, str):
        raise ErpcConfigError("direct endpoint must be an absolute URL")
    value = value.strip()
    # Require the explicit authority delimiter so parsers cannot disagree on
    # opaque or schemeless URL forms.
    separator = value.find("://")
    if separator <= 0 or value[:separator].lower() not in (
        ("ws", "wss") if websocket else ("http", "https")
    ):
        raise ErpcConfigError("direct endpoint must be an absolute URL")
    # Fragments are never part of an HTTP request target.  Check the literal
    # delimiter before parsing so an empty fragment is rejected as well.
    if "#" in value:
        raise ErpcConfigError("direct endpoint must not contain a fragment")
    parse_error: ErpcConfigError | None = None
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        parse_error = ErpcConfigError("direct endpoint must be an absolute URL")
    if parse_error is not None:
        # Raise after leaving the native parser's exception handler so an
        # invalid port cannot retain a value-bearing context.
        raise parse_error
    if not parsed.scheme or not parsed.netloc or not parsed.hostname:
        raise ErpcConfigError("direct endpoint must be an absolute URL")
    if parsed.scheme.lower() not in (("ws", "wss") if websocket else ("http", "https")):
        message = (
            "direct endpoint must use HTTP(S)"
            if not websocket
            else "direct endpoint must use WS(S)"
        )
        raise ErpcConfigError(message)
    # urlsplit exposes userinfo through username/password, but checking the
    # authority itself also catches an empty `@` prefix.
    if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
        raise ErpcConfigError("direct endpoint must not contain userinfo")
    return value


def _public_direct_url(value: str) -> str:
    """Return a diagnostic-safe direct URL with its query omitted."""
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def direct_endpoint_redactions(endpoint: RpcEndpointConfig) -> tuple[str, ...]:
    """Collect direct query and scoped-header values for SDK error redaction."""
    values: list[str] = []
    for url in (endpoint.http_url, endpoint.websocket_url):
        if url is None:
            continue
        parsed = urlsplit(url)
        # Keep both raw query components (for already encoded values) and
        # decoded values (for native JSON-RPC error data).
        for component in parsed.query.split("&"):
            if not component:
                continue
            raw_value = component.split("=", 1)[1] if "=" in component else component
            if raw_value:
                values.append(raw_value)
        for _, value in parse_qsl(parsed.query, keep_blank_values=True):
            if value:
                values.append(value)
    for name, value in endpoint.headers.items():
        if value:
            values.append(value)
            if name.lower() in {"authorization", "proxy-authorization"}:
                parts = value.strip().split(None, 1)
                if len(parts) == 2 and parts[0].lower() in {"bearer", "basic"}:
                    values.append(parts[1])
                    if parts[0].lower() == "basic":
                        try:
                            decoded = base64.b64decode(parts[1], validate=True).decode()
                        except (ValueError, UnicodeDecodeError):
                            pass
                        else:
                            values.append(decoded)
                            if ":" in decoded:
                                username, password = decoded.split(":", 1)
                                values.extend((username, password))
    # Preserve order for deterministic diagnostics while removing duplicates.
    return tuple(dict.fromkeys(values))


def normalize_endpoint(value: str, *, local_http_only: bool = False) -> str:
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as error:
        raise ErpcConfigError("endpoint must be an absolute HTTP(S) URL") from error
    if not parsed.scheme or not parsed.netloc:
        raise ErpcConfigError("endpoint must be an absolute HTTP(S) URL")
    local = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    allowed = parsed.scheme == "https" or (
        parsed.scheme == "http" and (not local_http_only or local)
    )
    if not allowed:
        message = (
            "endpoint must use HTTPS except on localhost"
            if local_http_only
            else "endpoint must use HTTP or HTTPS"
        )
        raise ErpcConfigError(message)
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def endpoint_with_path(endpoint: str, path: str) -> str:
    parsed = urlsplit(endpoint)
    base = parsed.path.rstrip("/")
    joined = f"{base}/{path.lstrip('/')}"
    return urlunsplit((parsed.scheme, parsed.netloc, joined, "", ""))


def websocket_url(endpoint: str, api_key: str, path: str = "") -> str:
    parsed = urlsplit(endpoint_with_path(endpoint, path))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    query = urlencode({"api-key": api_key}, quote_via=quote)
    return urlunsplit((scheme, parsed.netloc, parsed.path, query, ""))


@dataclass(frozen=True, repr=False, slots=True)
class RpcEndpointConfig:
    """A caller-owned direct JSON-RPC HTTP/WebSocket endpoint."""

    http_url: str
    websocket_url: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "http_url", _direct_url(self.http_url, websocket=False))
        if self.websocket_url is not None:
            object.__setattr__(
                self,
                "websocket_url",
                _direct_url(self.websocket_url, websocket=True),
            )
        if not isinstance(self.headers, Mapping):
            raise ErpcConfigError("direct endpoint headers must be a mapping")
        if not all(
            isinstance(name, str)
            and name
            and name.isascii()
            and all(character.isalnum() or character in "!#$%&'*+-.^_`|~" for character in name)
            and isinstance(value, str)
            and value.isascii()
            and all(
                ord(character) >= 0x20 and ord(character) != 0x7F or character == "\t"
                for character in value
            )
            for name, value in self.headers.items()
        ):
            raise ErpcConfigError("direct endpoint headers must contain valid HTTP values")
        object.__setattr__(self, "headers", dict(self.headers))

    def __repr__(self) -> str:
        websocket = (
            repr(_public_direct_url(self.websocket_url))
            if self.websocket_url is not None
            else "None"
        )
        return (
            "RpcEndpointConfig("
            f"http_url={_public_direct_url(self.http_url)!r}, "
            f"websocket_url={websocket}, header_names={list(self.headers)!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class ErpcClientConfig:
    """Configuration for :class:`ErpcClient`; credentials are hidden in repr."""

    api_key: str | None = None
    endpoint: str = DEFAULT_ENDPOINT
    account_endpoint: str = DEFAULT_ACCOUNT_ENDPOINT
    user_endpoint: str = DEFAULT_USER_ENDPOINT
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout: float = DEFAULT_TIMEOUT
    avalanche_endpoint: str = DEFAULT_AVALANCHE_ENDPOINT
    solana_rpc: RpcEndpointConfig | None = None
    ethereum_rpc: RpcEndpointConfig | None = None
    avalanche_c_rpc: RpcEndpointConfig | None = None

    def __post_init__(self) -> None:
        if self.api_key is not None and not isinstance(self.api_key, str):
            raise ErpcConfigError("api_key must be a string")
        key = self.api_key.strip() if self.api_key is not None else ""
        has_direct = any(
            endpoint is not None
            for endpoint in (self.solana_rpc, self.ethereum_rpc, self.avalanche_c_rpc)
        )
        if not key and not has_direct:
            raise ErpcConfigError("api_key must not be empty")
        if not isinstance(self.timeout, (int, float)) or self.timeout <= 0:
            raise ErpcConfigError("timeout must be positive")
        object.__setattr__(self, "api_key", key or None)
        object.__setattr__(self, "endpoint", normalize_endpoint(self.endpoint))
        object.__setattr__(self, "avalanche_endpoint", normalize_endpoint(self.avalanche_endpoint))
        object.__setattr__(self, "account_endpoint", normalize_endpoint(self.account_endpoint))
        object.__setattr__(self, "user_endpoint", normalize_endpoint(self.user_endpoint))
        object.__setattr__(self, "headers", dict(self.headers))
        object.__setattr__(self, "timeout", float(self.timeout))
        for endpoint in (self.solana_rpc, self.ethereum_rpc, self.avalanche_c_rpc):
            if endpoint is not None and not isinstance(endpoint, RpcEndpointConfig):
                raise ErpcConfigError("direct RPC overrides must use RpcEndpointConfig")

    def __repr__(self) -> str:
        key = "[REDACTED]" if self.api_key is not None else None
        return (
            f"ErpcClientConfig(api_key={key!r}, "
            f"endpoint={self.endpoint!r}, avalanche_endpoint={self.avalanche_endpoint!r}, "
            f"account_endpoint={self.account_endpoint!r}, "
            f"user_endpoint={self.user_endpoint!r}, "
            f"header_names={list(self.headers)!r}, timeout={self.timeout!r}, "
            f"solana_rpc={self.solana_rpc!r}, ethereum_rpc={self.ethereum_rpc!r}, "
            f"avalanche_c_rpc={self.avalanche_c_rpc!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class ErpcCloudClientConfig:
    """Configuration for scoped Cloud reads."""

    access_token: str
    endpoint: str = DEFAULT_USER_ENDPOINT
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout: float = DEFAULT_TIMEOUT

    def __post_init__(self) -> None:
        token = self.access_token.strip()
        if not token:
            raise ErpcConfigError("access_token must not be empty")
        if not isinstance(self.timeout, (int, float)) or self.timeout <= 0:
            raise ErpcConfigError("timeout must be positive")
        object.__setattr__(self, "access_token", token)
        object.__setattr__(
            self, "endpoint", normalize_endpoint(self.endpoint, local_http_only=True)
        )
        object.__setattr__(self, "headers", dict(self.headers))
        object.__setattr__(self, "timeout", float(self.timeout))

    def __repr__(self) -> str:
        return (
            "ErpcCloudClientConfig(access_token='[REDACTED]', "
            f"endpoint={self.endpoint!r}, header_names={list(self.headers)!r}, "
            f"timeout={self.timeout!r})"
        )
