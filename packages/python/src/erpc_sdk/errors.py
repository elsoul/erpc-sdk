"""Stable, credential-safe error types for the ERPC Python SDK."""

from __future__ import annotations

from enum import StrEnum
from urllib.parse import quote, quote_plus


class ErpcErrorCode(StrEnum):
    """Stable machine-readable SDK error categories."""

    ABORTED = "ERPC_ABORTED"
    BATCH_POLICY = "ERPC_BATCH_POLICY"
    CONFIG = "ERPC_CONFIG"
    HTTP = "ERPC_HTTP"
    INVALID_RESPONSE = "ERPC_INVALID_RESPONSE"
    RPC = "ERPC_RPC"
    TIMEOUT = "ERPC_TIMEOUT"
    TRANSPORT = "ERPC_TRANSPORT"


class ErpcError(Exception):
    """Base class for all SDK errors."""

    code: ErpcErrorCode

    def __init__(self, code: ErpcErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ErpcConfigError(ErpcError):
    def __init__(self, message: str) -> None:
        super().__init__(ErpcErrorCode.CONFIG, message)


class ErpcTransportError(ErpcError):
    def __init__(self, message: str = "Unable to reach ERPC") -> None:
        super().__init__(ErpcErrorCode.TRANSPORT, message)


class ErpcHttpError(ErpcError):
    status: int

    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(ErpcErrorCode.HTTP, f"ERPC request failed with HTTP {status}")


class ErpcTimeoutError(ErpcError):
    timeout: float

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        super().__init__(
            ErpcErrorCode.TIMEOUT,
            f"ERPC request timed out after {round(timeout * 1000)}ms",
        )


class ErpcAbortedError(ErpcError):
    def __init__(self) -> None:
        super().__init__(ErpcErrorCode.ABORTED, "ERPC request was aborted")


class ErpcInvalidResponseError(ErpcError):
    def __init__(self, message: str = "ERPC returned an invalid response") -> None:
        super().__init__(ErpcErrorCode.INVALID_RESPONSE, message)


class ErpcBatchPolicyError(ErpcError):
    def __init__(self, message: str) -> None:
        super().__init__(ErpcErrorCode.BATCH_POLICY, message)


class ErpcJsonRpcError(ErpcError):
    """A JSON-RPC error with credential-redacted message and data."""

    rpc_code: int
    data: object | None

    def __init__(self, rpc_code: int, message: str, data: object | None = None) -> None:
        self.rpc_code = rpc_code
        self.data = data
        super().__init__(ErpcErrorCode.RPC, message)


def credential_variants(credential: str) -> tuple[str, ...]:
    values = {credential, quote(credential, safe="~()*!.'"), quote_plus(credential)}
    return tuple(sorted((value for value in values if value), key=len, reverse=True))


def redact_text(value: str, credential: str) -> str:
    for variant in credential_variants(credential):
        value = value.replace(variant, "[REDACTED]")
    return value


def redact_value(value: object, credential: str, depth: int = 0) -> object:
    if depth >= 32:
        return "[REDACTED]"
    if isinstance(value, str):
        return redact_text(value, credential)
    if isinstance(value, list):
        return [redact_value(item, credential, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_value(item, credential, depth + 1) for item in value)
    if isinstance(value, dict):
        return {key: redact_value(item, credential, depth + 1) for key, item in value.items()}
    return value
