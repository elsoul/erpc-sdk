from __future__ import annotations

from decimal import Decimal

import pytest

from erpc_sdk.bitcoin_codec import (
    BITCOIN_RESPONSE_LIMITS,
    as_bitcoin_block_count,
    canonicalize_bitcoin_number,
    preflight_bitcoin_json,
    unwrap_bitcoin_rpc_response,
)
from erpc_sdk.errors import ErpcInvalidResponseError, ErpcJsonRpcError


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("0", (0, "0", "0")),
        ("-0", (0, "0", "0")),
        ("1.2300e+4", (1, "123", "2")),
        ("1e1000", (1, "1", "1000")),
        ("1e-1000", (1, "1", "-1000")),
        ("100000", (1, "1", "5")),
    ],
)
def test_canonical_tuple_preserves_approved_exact_domain(
    token: str,
    expected: tuple[int, str, str],
) -> None:
    actual = canonicalize_bitcoin_number(token)
    assert (actual.sign, actual.coefficient, actual.exponent10) == expected


@pytest.mark.parametrize(
    "token",
    [
        "01",
        "1.",
        "1e",
        "1e10001",
        "1e-10001",
        "1" + "0" * BITCOIN_RESPONSE_LIMITS.coefficient_digits,
        "1" + "0" * BITCOIN_RESPONSE_LIMITS.numeric_lexeme_bytes,
    ],
)
def test_numeric_limits_and_json_grammar_fail_safely(token: str) -> None:
    with pytest.raises(ErpcInvalidResponseError) as captured:
        canonicalize_bitcoin_number(token)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert token not in str(captured.value)


def test_preflight_is_nonrecursive_and_counts_containers_and_tokens() -> None:
    valid = (
        "[" * BITCOIN_RESPONSE_LIMITS.container_depth
        + "0"
        + "]" * BITCOIN_RESPONSE_LIMITS.container_depth
    )
    result = preflight_bitcoin_json(valid)
    assert result.token_count == BITCOIN_RESPONSE_LIMITS.container_depth + 1
    assert result.max_depth == BITCOIN_RESPONSE_LIMITS.container_depth

    too_deep = (
        "[" * (BITCOIN_RESPONSE_LIMITS.container_depth + 1)
        + "0"
        + "]" * (BITCOIN_RESPONSE_LIMITS.container_depth + 1)
    )
    with pytest.raises(ErpcInvalidResponseError):
        preflight_bitcoin_json(too_deep)

    too_many_tokens = (
        "[" + ",".join("0" for _ in range(BITCOIN_RESPONSE_LIMITS.json_tokens + 1)) + "]"
    )
    with pytest.raises(ErpcInvalidResponseError):
        preflight_bitcoin_json(too_many_tokens)


def test_duplicate_decoded_keys_are_last_wins_and_numbers_stay_exact() -> None:
    response = (
        '{"jsonrpc":"2.0","id":1,"result":1.20,'
        '"\\u0072esult":{"nested":{"x":5.60,"x":7.80},"tiny":1e-1000,'
        '"huge":1e1000}}'
    )
    result = unwrap_bitcoin_rpc_response(response, 1)
    assert result["nested"]["x"] == Decimal("7.80")
    assert result["tiny"] == Decimal("1e-1000")
    assert result["huge"] == Decimal("1e1000")


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("0", 0),
        ("1", 1),
        ("18446744073709551615", 18_446_744_073_709_551_615),
    ],
)
def test_block_count_requires_unsigned_integer_token(token: str, expected: int) -> None:
    result = unwrap_bitcoin_rpc_response(
        '{"jsonrpc":"2.0","id":1,"result":' + token + "}",
        1,
        projector=as_bitcoin_block_count,
    )
    assert result == expected


@pytest.mark.parametrize("token", ["-0", "1.0", "1e0", "18446744073709551616"])
def test_block_count_rejects_non_integer_or_out_of_range_token(token: str) -> None:
    with pytest.raises(ErpcInvalidResponseError):
        unwrap_bitcoin_rpc_response(
            '{"jsonrpc":"2.0","id":1,"result":' + token + "}",
            1,
            projector=as_bitcoin_block_count,
        )


def test_error_precedence_and_nested_redaction_preserve_decimal_values() -> None:
    response = (
        '{"jsonrpc":"2.0","id":1,"result":"ignored",'
        '"error":{"code":-32001,"message":"token-secret",'
        '"data":{"token-secret":1e-1000,"nested":["token-secret",1e1000]}}}'
    )
    with pytest.raises(ErpcJsonRpcError) as captured:
        unwrap_bitcoin_rpc_response(response, 1, redactions=("token-secret",))
    assert captured.value.rpc_code == -32001
    assert "token-secret" not in str(captured.value)
    assert captured.value.data == {
        "[REDACTED]": Decimal("1e-1000"),
        "nested": ["[REDACTED]", Decimal("1e1000")],
    }


def test_error_null_accepts_result_and_parser_failures_drop_native_context() -> None:
    assert unwrap_bitcoin_rpc_response('{"id":1,"error":null,"result":null}', 1) is None
    with pytest.raises(ErpcInvalidResponseError) as captured:
        unwrap_bitcoin_rpc_response('{"id":1,"result":', 1)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "result" not in str(captured.value)
