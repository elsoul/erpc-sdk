"""Configuration and URL handling."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from .errors import ErpcConfigError

DEFAULT_ENDPOINT = "https://edge.erpc.global"
DEFAULT_AVALANCHE_ENDPOINT = "https://ava-rpc.erpc.global"
DEFAULT_ACCOUNT_ENDPOINT = "https://solana-rpc.erpc.global"
DEFAULT_USER_ENDPOINT = "https://user-api.erpc.global"
DEFAULT_TIMEOUT = 30.0


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
class ErpcClientConfig:
    """Configuration for :class:`ErpcClient`; credentials are hidden in repr."""

    api_key: str
    endpoint: str = DEFAULT_ENDPOINT
    account_endpoint: str = DEFAULT_ACCOUNT_ENDPOINT
    user_endpoint: str = DEFAULT_USER_ENDPOINT
    headers: Mapping[str, str] = field(default_factory=dict)
    timeout: float = DEFAULT_TIMEOUT
    avalanche_endpoint: str = DEFAULT_AVALANCHE_ENDPOINT

    def __post_init__(self) -> None:
        key = self.api_key.strip()
        if not key:
            raise ErpcConfigError("api_key must not be empty")
        if not isinstance(self.timeout, (int, float)) or self.timeout <= 0:
            raise ErpcConfigError("timeout must be positive")
        object.__setattr__(self, "api_key", key)
        object.__setattr__(self, "endpoint", normalize_endpoint(self.endpoint))
        object.__setattr__(
            self, "avalanche_endpoint", normalize_endpoint(self.avalanche_endpoint)
        )
        object.__setattr__(self, "account_endpoint", normalize_endpoint(self.account_endpoint))
        object.__setattr__(self, "user_endpoint", normalize_endpoint(self.user_endpoint))
        object.__setattr__(self, "headers", dict(self.headers))
        object.__setattr__(self, "timeout", float(self.timeout))

    def __repr__(self) -> str:
        return (
            "ErpcClientConfig(api_key='[REDACTED]', "
            f"endpoint={self.endpoint!r}, avalanche_endpoint={self.avalanche_endpoint!r}, "
            f"account_endpoint={self.account_endpoint!r}, "
            f"user_endpoint={self.user_endpoint!r}, "
            f"header_names={list(self.headers)!r}, timeout={self.timeout!r})"
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
