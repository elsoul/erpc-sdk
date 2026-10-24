"""Bounded, exact JSON decoding for the new Bitcoin read client.

The legacy SDK decoder remains in :mod:`erpc_sdk.transport`.  This module is
deliberately private to the Bitcoin client so integer, Decimal, duplicate-key,
and resource-limit rules cannot change existing namespaces.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, TypeAlias, cast

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .errors import ErpcInvalidResponseError, ErpcJsonRpcError, redact_text, redact_value

BITCOIN_POLICY_ID = "bitcoin-exact-json-v1"
_INTEGER_TOKEN = re.compile(r"^(0|[1-9][0-9]*)$")
_NUMBER_TOKEN = re.compile(r"^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$")
_TOKEN_DELIMITERS = " \t\r\n,:[}]"


@dataclass(frozen=True, slots=True)
class BitcoinResponseLimits:
    """Fixed limits for the four new non-Rust Bitcoin decoders."""

    decoded_entity_bytes: int = 67_108_864
    container_depth: int = 64
    json_tokens: int = 1_000_000
    numeric_lexeme_bytes: int = 1_024
    coefficient_digits: int = 1_000
    explicit_exponent_min: int = -10_000
    explicit_exponent_max: int = 10_000
    canonical_exponent_min: int = -10_000
    canonical_exponent_max: int = 10_000


def _generated_bitcoin_method_names() -> tuple[str, ...]:
    contract = cast(dict[str, object], _RPC_NETWORK_CONTRACT)
    method_sets = contract.get("methodSets")
    if not isinstance(method_sets, list):
        raise RuntimeError("generated RPC contract has no method sets")
    method_set = next(
        (
            candidate
            for candidate in method_sets
            if isinstance(candidate, dict) and candidate.get("methodSetId") == "bitcoin-read12"
        ),
        None,
    )
    if not isinstance(method_set, dict):
        raise RuntimeError("missing generated Bitcoin method set")
    capabilities = method_set.get("capabilities")
    if not isinstance(capabilities, list):
        raise RuntimeError("missing generated Bitcoin capabilities")
    methods: list[str] = []
    for capability in capabilities:
        if not isinstance(capability, dict):
            raise RuntimeError("invalid generated Bitcoin capability")
        method = capability.get("wireOperation")
        if not isinstance(method, str) or not method:
            raise RuntimeError("invalid generated Bitcoin wire method")
        methods.append(method)
    if not methods:
        raise RuntimeError("generated Bitcoin method set is empty")
    return tuple(methods)


def _generated_bitcoin_limits() -> BitcoinResponseLimits:
    contract = cast(dict[str, object], _RPC_NETWORK_CONTRACT)
    clients = contract.get("clientContracts")
    if not isinstance(clients, list):
        raise RuntimeError("generated RPC contract has no client contracts")
    client = next(
        (
            candidate
            for candidate in clients
            if isinstance(candidate, dict)
            and candidate.get("clientContractId") == "client-bitcoin-rpc"
        ),
        None,
    )
    policy = client.get("responsePolicy") if isinstance(client, dict) else None
    limits = policy.get("limits") if isinstance(policy, dict) else None
    if not isinstance(limits, dict):
        raise RuntimeError("missing generated Bitcoin response limits")

    def integer(name: str) -> int:
        value = limits.get(name)
        if not isinstance(value, int) or isinstance(value, bool):
            raise RuntimeError(f"invalid generated Bitcoin limit: {name}")
        return value

    return BitcoinResponseLimits(
        decoded_entity_bytes=integer("decodedEntityBytes"),
        container_depth=integer("containerDepth"),
        json_tokens=integer("jsonTokens"),
        numeric_lexeme_bytes=integer("numericLexemeBytes"),
        coefficient_digits=integer("coefficientDigits"),
        explicit_exponent_min=integer("explicitExponentMin"),
        explicit_exponent_max=integer("explicitExponentMax"),
        canonical_exponent_min=integer("canonicalExponentMin"),
        canonical_exponent_max=integer("canonicalExponentMax"),
    )


BITCOIN_RPC_METHODS = _generated_bitcoin_method_names()
BITCOIN_RESPONSE_LIMITS = _generated_bitcoin_limits()


@dataclass(frozen=True, slots=True)
class BitcoinNumberTuple:
    """Canonical mathematical representation used by the shared contract."""

    sign: int
    coefficient: str
    exponent10: str


@dataclass(frozen=True, slots=True)
class _BitcoinNumberToken:
    """A validated original JSON number token retained until projection."""

    raw: str
    integer: bool
    tuple: BitcoinNumberTuple


BitcoinJsonValue: TypeAlias = (
    None | bool | int | Decimal | str | list["BitcoinJsonValue"] | dict[str, "BitcoinJsonValue"]
)


@dataclass(frozen=True, slots=True)
class BitcoinPreflightResult:
    """Bounded scanner output; it does not contain a second JSON object model."""

    token_count: int
    numeric_token_count: int
    max_depth: int


def _invalid() -> ErpcInvalidResponseError:
    return ErpcInvalidResponseError()


def _checked_explicit_exponent(raw: str) -> int:
    sign = -1 if raw.startswith("-") else 1
    digits = raw[1:] if raw[:1] in {"-", "+"} else raw
    normalized = digits.lstrip("0") or "0"
    if len(normalized) > 5:
        raise _invalid()
    value = 0
    for character in normalized:
        value = value * 10 + (ord(character) - ord("0"))
        if value > BITCOIN_RESPONSE_LIMITS.explicit_exponent_max:
            raise _invalid()
    result = sign * value
    if not (
        BITCOIN_RESPONSE_LIMITS.explicit_exponent_min
        <= result
        <= BITCOIN_RESPONSE_LIMITS.explicit_exponent_max
    ):
        raise _invalid()
    return result


def canonicalize_bitcoin_number(raw: str) -> BitcoinNumberTuple:
    """Validate a JSON number and return its canonical sign/coefficient/exponent."""

    if not isinstance(raw, str):
        raise _invalid()
    try:
        raw_bytes = raw.encode("ascii", "strict")
    except UnicodeEncodeError:
        raise _invalid() from None
    if len(raw_bytes) > BITCOIN_RESPONSE_LIMITS.numeric_lexeme_bytes:
        raise _invalid()
    match = _NUMBER_TOKEN.fullmatch(raw)
    if match is None:
        raise _invalid()
    sign_token, integer, fraction, exponent_token = match.groups()
    fraction = fraction or ""
    explicit_exponent = _checked_explicit_exponent(exponent_token or "0")
    raw_coefficient = integer + fraction
    if len(raw_coefficient) > BITCOIN_RESPONSE_LIMITS.coefficient_digits:
        raise _invalid()

    without_leading_zeroes = raw_coefficient.lstrip("0") or "0"
    if without_leading_zeroes == "0":
        return BitcoinNumberTuple(0, "0", "0")

    coefficient = without_leading_zeroes.rstrip("0")
    trailing_zeroes = len(without_leading_zeroes) - len(coefficient)
    exponent10 = explicit_exponent - len(fraction) + trailing_zeroes
    if not (
        BITCOIN_RESPONSE_LIMITS.canonical_exponent_min
        <= exponent10
        <= BITCOIN_RESPONSE_LIMITS.canonical_exponent_max
    ):
        raise _invalid()
    return BitcoinNumberTuple(
        -1 if sign_token == "-" else 1,
        coefficient,
        str(exponent10),
    )


def _scan_string(text: str, start: int) -> int:
    index = start + 1
    while index < len(text):
        character = text[index]
        if character == "\\":
            if index + 1 >= len(text):
                raise _invalid()
            index += 2
            continue
        if character == '"':
            return index + 1
        if ord(character) < 0x20:
            raise _invalid()
        index += 1
    raise _invalid()


def _scan_number(text: str, start: int) -> tuple[int, str]:
    index = start
    if text[index] == "-":
        index += 1
    if index >= len(text):
        raise _invalid()

    if text[index] == "0":
        index += 1
        if index < len(text) and text[index].isdigit():
            raise _invalid()
    elif "1" <= text[index] <= "9":
        index += 1
        while index < len(text) and "0" <= text[index] <= "9":
            index += 1
    else:
        raise _invalid()

    if index < len(text) and text[index] == ".":
        index += 1
        fraction_start = index
        while index < len(text) and "0" <= text[index] <= "9":
            index += 1
        if index == fraction_start:
            raise _invalid()

    if index < len(text) and text[index] in "eE":
        index += 1
        if index < len(text) and text[index] in "+-":
            index += 1
        exponent_start = index
        while index < len(text) and "0" <= text[index] <= "9":
            index += 1
        if index == exponent_start:
            raise _invalid()

    if index < len(text) and text[index] not in _TOKEN_DELIMITERS:
        raise _invalid()
    raw = text[start:index]
    canonicalize_bitcoin_number(raw)
    return index, raw


def _scan_literal(text: str, start: int, literal: str) -> int:
    end = start + len(literal)
    if text[start:end] != literal:
        raise _invalid()
    if end < len(text) and text[end] not in _TOKEN_DELIMITERS:
        raise _invalid()
    return end


def preflight_bitcoin_json(text: str) -> BitcoinPreflightResult:
    """Run the non-recursive resource and numeric preflight before parsing."""

    if not isinstance(text, str):
        raise _invalid()
    token_count = 0
    numeric_token_count = 0
    depth = 0
    maximum_depth = 0
    stack: list[str] = []
    index = 0

    def add_token() -> None:
        nonlocal token_count
        token_count += 1
        if token_count > BITCOIN_RESPONSE_LIMITS.json_tokens:
            raise _invalid()

    while index < len(text):
        character = text[index]
        if character in " \t\r\n,:":
            index += 1
            continue
        if character == '"':
            add_token()
            index = _scan_string(text, index)
            continue
        if character in "[{":
            add_token()
            depth += 1
            maximum_depth = max(maximum_depth, depth)
            if depth > BITCOIN_RESPONSE_LIMITS.container_depth:
                raise _invalid()
            stack.append(character)
            index += 1
            continue
        if character in "]}":
            if (
                not stack
                or (character == "]" and stack[-1] != "[")
                or (character == "}" and stack[-1] != "{")
            ):
                raise _invalid()
            stack.pop()
            depth -= 1
            index += 1
            continue
        if character == "-" or "0" <= character <= "9":
            index, _ = _scan_number(text, index)
            add_token()
            numeric_token_count += 1
            continue
        if character == "t":
            index = _scan_literal(text, index, "true")
            add_token()
            continue
        if character == "f":
            index = _scan_literal(text, index, "false")
            add_token()
            continue
        if character == "n":
            index = _scan_literal(text, index, "null")
            add_token()
            continue
        raise _invalid()

    if stack:
        raise _invalid()
    return BitcoinPreflightResult(token_count, numeric_token_count, maximum_depth)


def _parse_number(raw: str) -> _BitcoinNumberToken:
    return _BitcoinNumberToken(
        raw,
        "." not in raw and "e" not in raw.lower(),
        canonicalize_bitcoin_number(raw),
    )


def _reject_constant(_: str) -> Any:
    raise _invalid()


def _last_key_wins(pairs: list[tuple[str, object]]) -> dict[str, object]:
    # dict assignment intentionally implements the approved decoded-key policy.
    result: dict[str, object] = {}
    for key, value in pairs:
        result[key] = value
    return result


def _parse_document(text: str) -> object:
    parse_error: ErpcInvalidResponseError | None = None
    try:
        value = json.loads(
            text,
            parse_int=_parse_number,
            parse_float=_parse_number,
            parse_constant=_reject_constant,
            object_pairs_hook=_last_key_wins,
        )
    except (InvalidOperation, RecursionError, TypeError, ValueError):
        parse_error = _invalid()
    if parse_error is not None:
        raise parse_error
    return value


def _decimal_tuple(value: Decimal) -> BitcoinNumberTuple:
    if not value.is_finite():
        raise _invalid()
    sign, digits, exponent = value.as_tuple()
    coefficient = "".join(str(digit) for digit in digits).lstrip("0") or "0"
    if coefficient == "0":
        return BitcoinNumberTuple(0, "0", "0")
    coefficient = coefficient.rstrip("0")
    trailing_zeroes = len(digits) - len(coefficient)
    normalized_exponent = int(exponent) + trailing_zeroes
    if not (
        BITCOIN_RESPONSE_LIMITS.canonical_exponent_min
        <= normalized_exponent
        <= BITCOIN_RESPONSE_LIMITS.canonical_exponent_max
    ):
        raise _invalid()
    return BitcoinNumberTuple(
        -1 if sign else 1,
        coefficient,
        str(normalized_exponent),
    )


def _decimal_from_token(token: _BitcoinNumberToken) -> Decimal:
    conversion_error: ErpcInvalidResponseError | None = None
    try:
        value = Decimal(token.raw)
        if not value.is_finite():
            conversion_error = _invalid()
        elif token.tuple.sign != 0 and value.is_zero():
            conversion_error = _invalid()
        elif _decimal_tuple(value) != token.tuple:
            conversion_error = _invalid()
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        conversion_error = _invalid()
    if conversion_error is not None:
        raise conversion_error
    return value


def _convert(value: object) -> BitcoinJsonValue:
    if isinstance(value, _BitcoinNumberToken):
        if value.integer:
            try:
                return int(value.raw, 10)
            except (TypeError, ValueError, OverflowError):
                raise _invalid() from None
        return _decimal_from_token(value)
    if value is None or isinstance(value, (bool, int, str, Decimal)):
        return cast(BitcoinJsonValue, value)
    if isinstance(value, list):
        return [_convert(item) for item in value]
    if isinstance(value, dict):
        return {key: _convert(item) for key, item in value.items()}
    raise _invalid()


def _response_id(value: object) -> int | str:
    if isinstance(value, _BitcoinNumberToken):
        if not value.integer or _INTEGER_TOKEN.fullmatch(value.raw) is None:
            raise _invalid()
        try:
            return int(value.raw, 10)
        except (TypeError, ValueError, OverflowError):
            raise _invalid() from None
    if isinstance(value, str):
        return value
    raise _invalid()


def as_bitcoin_string(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid()
    return value


def as_bitcoin_block_count(value: object) -> int:
    if not isinstance(value, _BitcoinNumberToken):
        raise _invalid()
    if not value.integer or _INTEGER_TOKEN.fullmatch(value.raw) is None:
        raise _invalid()
    try:
        result = int(value.raw, 10)
    except (TypeError, ValueError, OverflowError):
        raise _invalid() from None
    if result > 18_446_744_073_709_551_615:
        raise _invalid()
    return result


def as_bitcoin_nullable_object(value: object) -> BitcoinJsonValue | None:
    if value is None:
        return None
    converted = _convert(value)
    if not isinstance(converted, dict):
        raise _invalid()
    return converted


BitcoinResultProjector = Callable[[object], Any]


def unwrap_bitcoin_rpc_response(
    text: str,
    expected_id: int | str,
    *,
    redactions: Iterable[str] = (),
    projector: BitcoinResultProjector | None = None,
) -> Any:
    """Decode one bounded Bitcoin JSON-RPC envelope without native causes."""

    preflight_bitcoin_json(text)
    response = _parse_document(text)
    if not isinstance(response, dict):
        raise _invalid()
    if _response_id(response.get("id")) != expected_id:
        raise _invalid()

    if "error" in response and response["error"] is not None:
        raw_error = response["error"]
        converted_error = _convert(raw_error)
        if not isinstance(converted_error, dict):
            raise _invalid()
        code = converted_error.get("code")
        message = converted_error.get("message")
        if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
            raise _invalid()
        credentials = tuple(value for value in redactions if isinstance(value, str))
        data = converted_error.get("data")
        raise ErpcJsonRpcError(
            code,
            redact_text(message, credentials),
            redact_value(data, credentials) if data is not None else None,
        )

    if "result" not in response:
        raise _invalid()
    raw_result = response["result"]
    if projector is not None:
        return projector(raw_result)
    return _convert(raw_result)


__all__ = [
    "BITCOIN_POLICY_ID",
    "BITCOIN_RPC_METHODS",
    "BITCOIN_RESPONSE_LIMITS",
    "BitcoinJsonValue",
    "BitcoinNumberTuple",
    "BitcoinPreflightResult",
    "BitcoinResponseLimits",
    "as_bitcoin_block_count",
    "as_bitcoin_nullable_object",
    "as_bitcoin_string",
    "canonicalize_bitcoin_number",
    "preflight_bitcoin_json",
    "unwrap_bitcoin_rpc_response",
]
