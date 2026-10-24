"""Configuration and URL handling."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .errors import ErpcConfigError

DEFAULT_ENDPOINT = "https://edge.erpc.global"
DEFAULT_AVALANCHE_ENDPOINT = "https://ava-rpc.erpc.global"
DEFAULT_ACCOUNT_ENDPOINT = "https://solana-rpc.erpc.global"
DEFAULT_USER_ENDPOINT = "https://user-api.erpc.global"
DEFAULT_TIMEOUT = 30.0


def _generated_public_default(client_contract_id: str) -> str:
    """Read one public hosted spelling from the private generated projection."""
    clients = _RPC_NETWORK_CONTRACT.get("clientContracts")
    if not isinstance(clients, list):
        raise RuntimeError("generated RPC contract has no client contracts")
    client = next(
        (
            candidate
            for candidate in clients
            if isinstance(candidate, dict)
            and candidate.get("clientContractId") == client_contract_id
        ),
        None,
    )
    if not isinstance(client, dict):
        raise RuntimeError(f"missing generated RPC client contract: {client_contract_id}")
    modes = client.get("endpointModes")
    if not isinstance(modes, list):
        raise RuntimeError(f"missing generated endpoint modes: {client_contract_id}")
    hosted = next(
        (
            candidate
            for candidate in modes
            if isinstance(candidate, dict) and candidate.get("mode") == "hosted"
        ),
        None,
    )
    value = hosted.get("publicDefault") if isinstance(hosted, dict) else None
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"missing generated public endpoint: {client_contract_id}")
    return value


DEFAULT_BASE_ENDPOINT = _generated_public_default("client-base-rpc")
DEFAULT_ARBITRUM_ENDPOINT = _generated_public_default("client-arbitrum-rpc")
DEFAULT_POLYGON_ENDPOINT = _generated_public_default("client-polygon-rpc")
DEFAULT_BSC_ENDPOINT = _generated_public_default("client-bsc-rpc")
DEFAULT_OPTIMISM_ENDPOINT = _generated_public_default("client-optimism-rpc")
DEFAULT_KAIA_ENDPOINT = _generated_public_default("client-kaia-rpc")
DEFAULT_SONEIUM_ENDPOINT = _generated_public_default("client-soneium-rpc")
DEFAULT_MONAD_ENDPOINT = _generated_public_default("client-monad-rpc")
DEFAULT_HYPERLIQUID_ENDPOINT = _generated_public_default("client-hyperliquid-rpc")
DEFAULT_ARC_ENDPOINT = _generated_public_default("client-arc-rpc")
DEFAULT_ROBINHOOD_ENDPOINT = _generated_public_default("client-robinhood-rpc")
DEFAULT_NEAR_ENDPOINT = _generated_public_default("client-near-rpc")
DEFAULT_TRON_ENDPOINT = _generated_public_default("client-tron-rpc")
DEFAULT_SUI_ENDPOINT = _generated_public_default("client-sui-grpc")


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


def _origin_url(value: str) -> str:
    """Return only the origin root for the new sealed-client diagnostics."""
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def direct_endpoint_redactions(endpoint: RpcEndpointConfig) -> tuple[str, ...]:
    """Collect direct query and scoped-header values for SDK error redaction."""
    values: list[str] = []
    for url in (endpoint.http_url, endpoint.websocket_url):
        if url is None:
            continue
        parsed = urlsplit(url)
        for component in parsed.path.split("/"):
            if not component:
                continue
            values.append(component)
            decoded = unquote(component)
            if decoded:
                values.append(decoded)
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


def _normalize_new_hosted_endpoint(value: object, field_name: str) -> str:
    """Normalize a sealed-client hosted root without retaining userinfo."""
    message = f"{field_name} must be an absolute HTTP(S) URL"
    if not isinstance(value, str):
        raise ErpcConfigError(message)
    candidate = value.strip()
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port
    except ValueError:
        raise ErpcConfigError(message) from None
    if (
        "#" in candidate
        or parsed.scheme.lower() not in {"http", "https"}
        or not parsed.netloc
        or not parsed.hostname
        or "@" in parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
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


def _sui_base_url(value: object) -> str:
    """Validate a direct Sui gRPC-Web prefix without rewriting its target."""
    message = "Sui gRPC-Web endpoint must be an absolute HTTP(S) URL"
    if not isinstance(value, str):
        raise ErpcConfigError(message)
    candidate = value.strip()
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port
    except ValueError:
        raise ErpcConfigError(message) from None
    if (
        "#" in candidate
        or parsed.scheme.lower() not in {"http", "https"}
        or not parsed.netloc
        or not parsed.hostname
        or "@" in parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ErpcConfigError(message)
    return candidate


@dataclass(frozen=True, repr=False, slots=True)
class SuiGrpcWebEndpointConfig:
    """Caller-owned Sui gRPC-Web base prefix and scoped headers."""

    base_url: str
    headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "base_url", _sui_base_url(self.base_url))
        if not isinstance(self.headers, Mapping):
            raise ErpcConfigError("Sui gRPC-Web endpoint headers must be a mapping")
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
            raise ErpcConfigError("Sui gRPC-Web endpoint headers must contain valid HTTP values")
        object.__setattr__(self, "headers", dict(self.headers))

    def __repr__(self) -> str:
        parsed = urlsplit(self.base_url)
        public = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        return f"SuiGrpcWebEndpointConfig(base_url={public!r}, header_names={list(self.headers)!r})"


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
    base_endpoint: str = DEFAULT_BASE_ENDPOINT
    base_rpc: RpcEndpointConfig | None = None
    arbitrum_endpoint: str = DEFAULT_ARBITRUM_ENDPOINT
    arbitrum_rpc: RpcEndpointConfig | None = None
    bitcoin_rpc: RpcEndpointConfig | None = None
    polygon_endpoint: str = DEFAULT_POLYGON_ENDPOINT
    polygon_rpc: RpcEndpointConfig | None = None
    bsc_endpoint: str = DEFAULT_BSC_ENDPOINT
    bsc_rpc: RpcEndpointConfig | None = None
    optimism_endpoint: str = DEFAULT_OPTIMISM_ENDPOINT
    optimism_rpc: RpcEndpointConfig | None = None
    kaia_endpoint: str = DEFAULT_KAIA_ENDPOINT
    kaia_rpc: RpcEndpointConfig | None = None
    soneium_endpoint: str = DEFAULT_SONEIUM_ENDPOINT
    soneium_rpc: RpcEndpointConfig | None = None
    monad_endpoint: str = DEFAULT_MONAD_ENDPOINT
    monad_rpc: RpcEndpointConfig | None = None
    hyperliquid_endpoint: str = DEFAULT_HYPERLIQUID_ENDPOINT
    hyperliquid_rpc: RpcEndpointConfig | None = None
    arc_endpoint: str = DEFAULT_ARC_ENDPOINT
    arc_rpc: RpcEndpointConfig | None = None
    robinhood_endpoint: str = DEFAULT_ROBINHOOD_ENDPOINT
    robinhood_rpc: RpcEndpointConfig | None = None
    near_endpoint: str = DEFAULT_NEAR_ENDPOINT
    near_rpc: RpcEndpointConfig | None = None
    tron_endpoint: str = DEFAULT_TRON_ENDPOINT
    tron_rpc: RpcEndpointConfig | None = None
    sui_endpoint: str = DEFAULT_SUI_ENDPOINT
    sui_grpc_web: SuiGrpcWebEndpointConfig | None = None

    def __post_init__(self) -> None:
        if self.api_key is not None and not isinstance(self.api_key, str):
            raise ErpcConfigError("api_key must be a string")
        key = self.api_key.strip() if self.api_key is not None else ""
        has_direct = any(
            endpoint is not None
            for endpoint in (
                self.solana_rpc,
                self.ethereum_rpc,
                self.avalanche_c_rpc,
                self.base_rpc,
                self.arbitrum_rpc,
                self.bitcoin_rpc,
                self.polygon_rpc,
                self.bsc_rpc,
                self.optimism_rpc,
                self.kaia_rpc,
                self.soneium_rpc,
                self.monad_rpc,
                self.hyperliquid_rpc,
                self.arc_rpc,
                self.robinhood_rpc,
                self.near_rpc,
                self.tron_rpc,
                self.sui_grpc_web,
            )
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
        object.__setattr__(
            self,
            "base_endpoint",
            _normalize_new_hosted_endpoint(self.base_endpoint, "base_endpoint"),
        )
        object.__setattr__(
            self,
            "arbitrum_endpoint",
            _normalize_new_hosted_endpoint(self.arbitrum_endpoint, "arbitrum_endpoint"),
        )
        for name in (
            "polygon_endpoint",
            "bsc_endpoint",
            "optimism_endpoint",
            "kaia_endpoint",
            "soneium_endpoint",
            "monad_endpoint",
            "hyperliquid_endpoint",
            "arc_endpoint",
            "robinhood_endpoint",
            "near_endpoint",
            "tron_endpoint",
            "sui_endpoint",
        ):
            object.__setattr__(
                self,
                name,
                _normalize_new_hosted_endpoint(getattr(self, name), name),
            )
        object.__setattr__(self, "headers", dict(self.headers))
        object.__setattr__(self, "timeout", float(self.timeout))
        for endpoint in (
            self.solana_rpc,
            self.ethereum_rpc,
            self.avalanche_c_rpc,
            self.base_rpc,
            self.arbitrum_rpc,
            self.bitcoin_rpc,
            self.polygon_rpc,
            self.bsc_rpc,
            self.optimism_rpc,
            self.kaia_rpc,
            self.soneium_rpc,
            self.monad_rpc,
            self.hyperliquid_rpc,
            self.arc_rpc,
            self.robinhood_rpc,
            self.near_rpc,
            self.tron_rpc,
        ):
            if endpoint is not None and not isinstance(endpoint, RpcEndpointConfig):
                raise ErpcConfigError("direct RPC overrides must use RpcEndpointConfig")
        if self.sui_grpc_web is not None and not isinstance(
            self.sui_grpc_web, SuiGrpcWebEndpointConfig
        ):
            raise ErpcConfigError("sui_grpc_web must use SuiGrpcWebEndpointConfig")
        for name, endpoint in (
            ("base_rpc", self.base_rpc),
            ("arbitrum_rpc", self.arbitrum_rpc),
            ("bitcoin_rpc", self.bitcoin_rpc),
            ("polygon_rpc", self.polygon_rpc),
            ("bsc_rpc", self.bsc_rpc),
            ("optimism_rpc", self.optimism_rpc),
            ("kaia_rpc", self.kaia_rpc),
            ("soneium_rpc", self.soneium_rpc),
            ("monad_rpc", self.monad_rpc),
            ("hyperliquid_rpc", self.hyperliquid_rpc),
            ("arc_rpc", self.arc_rpc),
            ("robinhood_rpc", self.robinhood_rpc),
            ("near_rpc", self.near_rpc),
            ("tron_rpc", self.tron_rpc),
        ):
            if endpoint is not None and endpoint.websocket_url is not None:
                raise ErpcConfigError(f"{name} does not support WebSocket URLs")

    @staticmethod
    def _new_direct_repr(endpoint: RpcEndpointConfig | None) -> str:
        if endpoint is None:
            return "None"
        return (
            "RpcEndpointConfig("
            f"http_url={_origin_url(endpoint.http_url)!r}, "
            f"websocket_url=None, header_names={list(endpoint.headers)!r})"
        )

    def __repr__(self) -> str:
        key = "[REDACTED]" if self.api_key is not None else None
        return (
            f"ErpcClientConfig(api_key={key!r}, "
            f"endpoint={self.endpoint!r}, avalanche_endpoint={self.avalanche_endpoint!r}, "
            f"account_endpoint={self.account_endpoint!r}, "
            f"user_endpoint={self.user_endpoint!r}, "
            f"header_names={list(self.headers)!r}, timeout={self.timeout!r}, "
            f"solana_rpc={self.solana_rpc!r}, ethereum_rpc={self.ethereum_rpc!r}, "
            f"avalanche_c_rpc={self.avalanche_c_rpc!r}, "
            f"base_endpoint={_origin_url(self.base_endpoint)!r}, "
            f"base_rpc={self._new_direct_repr(self.base_rpc)}, "
            f"arbitrum_endpoint={_origin_url(self.arbitrum_endpoint)!r}, "
            f"arbitrum_rpc={self._new_direct_repr(self.arbitrum_rpc)}, "
            f"bitcoin_rpc={self._new_direct_repr(self.bitcoin_rpc)}, "
            f"polygon_endpoint={_origin_url(self.polygon_endpoint)!r}, "
            f"polygon_rpc={self._new_direct_repr(self.polygon_rpc)}, "
            f"bsc_endpoint={_origin_url(self.bsc_endpoint)!r}, "
            f"bsc_rpc={self._new_direct_repr(self.bsc_rpc)}, "
            f"optimism_endpoint={_origin_url(self.optimism_endpoint)!r}, "
            f"optimism_rpc={self._new_direct_repr(self.optimism_rpc)}, "
            f"kaia_endpoint={_origin_url(self.kaia_endpoint)!r}, "
            f"kaia_rpc={self._new_direct_repr(self.kaia_rpc)}, "
            f"soneium_endpoint={_origin_url(self.soneium_endpoint)!r}, "
            f"soneium_rpc={self._new_direct_repr(self.soneium_rpc)}, "
            f"monad_endpoint={_origin_url(self.monad_endpoint)!r}, "
            f"monad_rpc={self._new_direct_repr(self.monad_rpc)}, "
            f"hyperliquid_endpoint={_origin_url(self.hyperliquid_endpoint)!r}, "
            f"hyperliquid_rpc={self._new_direct_repr(self.hyperliquid_rpc)}, "
            f"arc_endpoint={_origin_url(self.arc_endpoint)!r}, "
            f"arc_rpc={self._new_direct_repr(self.arc_rpc)}, "
            f"robinhood_endpoint={_origin_url(self.robinhood_endpoint)!r}, "
            f"robinhood_rpc={self._new_direct_repr(self.robinhood_rpc)}, "
            f"near_endpoint={_origin_url(self.near_endpoint)!r}, "
            f"near_rpc={self._new_direct_repr(self.near_rpc)}, "
            f"tron_endpoint={_origin_url(self.tron_endpoint)!r}, "
            f"tron_rpc={self._new_direct_repr(self.tron_rpc)}, "
            f"sui_endpoint={_origin_url(self.sui_endpoint)!r}, "
            f"sui_grpc_web={self.sui_grpc_web!r})"
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
