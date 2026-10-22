"""Stable, credential-safe error types for the ERPC Python SDK."""

from __future__ import annotations

import re
from collections.abc import Iterable
from enum import StrEnum
from urllib.parse import quote, quote_plus


class ErpcErrorCode(StrEnum):
    """Stable machine-readable SDK error categories."""

    ABORTED = "ERPC_ABORTED"
    BATCH_POLICY = "ERPC_BATCH_POLICY"
    CONFIG = "ERPC_CONFIG"
    HTTP = "ERPC_HTTP"
    INVALID_RESPONSE = "ERPC_INVALID_RESPONSE"
    NOT_CONFIGURED = "ERPC_NOT_CONFIGURED"
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


class ErpcNotConfiguredError(ErpcError):
    """Raised when a requested chain or service has no configured transport."""

    namespace: str

    def __init__(self, namespace: str) -> None:
        self.namespace = namespace
        super().__init__(
            ErpcErrorCode.NOT_CONFIGURED,
            f"ERPC namespace {namespace!r} is not configured",
        )


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


def _credential_values(credential: str | Iterable[str]) -> tuple[str, ...]:
    if isinstance(credential, str):
        return (credential,)
    return tuple(value for value in credential if isinstance(value, str))


def credential_variants(credential: str | Iterable[str]) -> tuple[str, ...]:
    values: set[str] = set()
    for value in _credential_values(credential):
        if not value:
            continue
        component_encoded = quote(value, safe="~()*!.'")
        query_encoded = quote_plus(value)
        values.update({value, component_encoded, query_encoded})
    return tuple(sorted((value for value in values if value), key=len, reverse=True))


def _percent_escape_pattern(value: str) -> str | None:
    """Build one pattern that folds only hex digits in percent escapes."""
    parts: list[str] = []
    has_escape = False
    index = 0
    while index < len(value):
        if (
            value[index] == "%"
            and index + 2 < len(value)
            and value[index + 1] in "0123456789abcdefABCDEF"
            and value[index + 2] in "0123456789abcdefABCDEF"
        ):
            first = value[index + 1]
            second = value[index + 2]
            first_class = first if first.isdigit() else f"{first.lower()}{first.upper()}"
            second_class = second if second.isdigit() else f"{second.lower()}{second.upper()}"
            parts.append(f"%[{first_class}][{second_class}]")
            index += 3
            has_escape = True
            continue
        parts.append(re.escape(value[index]))
        index += 1
    return "".join(parts) if has_escape else None


def redact_text(value: str, credential: str | Iterable[str]) -> str:
    # Materialize iterable credentials once.  Direct endpoint redaction is
    # applied independently to the message, data keys, and data values.
    credentials = _credential_values(credential)
    variants = credential_variants(credentials)
    for variant in variants:
        value = value.replace(variant, "[REDACTED]")
    # URL encoders differ in the case of hexadecimal digits after `%`. Match
    # that case variation while keeping ordinary credential characters exact.
    for variant in variants:
        pattern = _percent_escape_pattern(variant)
        if pattern is not None:
            value = re.sub(pattern, "[REDACTED]", value)
    return value


def redact_value(value: object, credential: str | Iterable[str], depth: int = 0) -> object:
    credentials = _credential_values(credential) if depth == 0 else credential
    if depth >= 32:
        return "[REDACTED]"
    if isinstance(value, str):
        return redact_text(value, credentials)
    if isinstance(value, list):
        return [redact_value(item, credentials, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_value(item, credentials, depth + 1) for item in value)
    if isinstance(value, dict):
        return {
            redact_text(key, credentials) if isinstance(key, str) else key: redact_value(
                item, credentials, depth + 1
            )
            for key, item in value.items()
        }
    return value
