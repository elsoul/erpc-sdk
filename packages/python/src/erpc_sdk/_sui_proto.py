# Copyright (c) Mysten Labs, Inc.
# SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
#
# This file is an adapted and modified handwritten bounded Python projection
# of the Mysten Labs Sui RPC v2 schema. It is limited to the three read-only
# unary methods implemented by this SDK, omits unrelated schema fields, and
# is pinned to commit aa9ba2c13b2a9348059b38110e64af39849a0377.
# Adapted source paths:
#   proto/sui/rpc/v2/ledger_service.proto
#   proto/sui/rpc/v2/state_service.proto
#   proto/sui/rpc/v2/object.proto
#   proto/google/protobuf/timestamp.proto
# The codec mechanics are handwritten and dependency-free; this is not an
# upstream generated file.
#
# Protocol Buffers - Google's data interchange format
# Copyright 2008 Google Inc.  All rights reserved.
# https://developers.google.com/protocol-buffers/
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are
# met:
#
#     * Redistributions of source code must retain the above copyright
# notice, this list of conditions and the following disclaimer.
#     * Redistributions in binary form must reproduce the above
# copyright notice, this list of conditions and the following disclaimer
# in the documentation and/or other materials provided with the
# distribution.
#     * Neither the name of Google Inc. nor the names of its
# contributors may be used to endorse or promote products derived from
# this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
# "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
# LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
# A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
# OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
# SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
# LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
# DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
# THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
# OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

"""Handwritten bounded Sui protobuf projection (no protobuf runtime dependency).

Adapted source paths: MystenLabs/sui-apis commit
aa9ba2c13b2a9348059b38110e64af39849a0377, limited to the three read-only
unary methods and Timestamp.  Codec mechanics are handwritten and private.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from .errors import ErpcConfigError, ErpcInvalidResponseError

SUI_REQUEST_LIMIT = 1_048_576
SUI_RESPONSE_LIMIT = 8 * 1024 * 1024
SUI_TRAILER_LIMIT = 8 * 1024
MAX_U64 = 18_446_744_073_709_551_615
MAX_I64 = 9_223_372_036_854_775_807
MAX_DEPTH = 100
T = TypeVar("T")


def _invalid() -> ErpcInvalidResponseError:
    return ErpcInvalidResponseError("Sui protobuf response is invalid")


def encode_varint(value: int) -> bytes:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_U64:
        raise ErpcConfigError("Sui integer is out of range")
    result = bytearray()
    while True:
        next_byte = value & 0x7F
        value >>= 7
        result.append(next_byte if value == 0 else next_byte | 0x80)
        if value == 0:
            return bytes(result)


def _append_key(output: bytearray, field: int, wire: int) -> None:
    output.extend(encode_varint((field << 3) | wire))


def _append_bytes(output: bytearray, field: int, value: bytes) -> None:
    _append_key(output, field, 2)
    output.extend(encode_varint(len(value)))
    output.extend(value)


def _append_string(output: bytearray, field: int, value: str) -> None:
    encoded: bytes | None = None
    failed = False
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        failed = True
    if failed:
        raise ErpcConfigError("Sui string is invalid")
    if encoded is None:
        raise ErpcConfigError("Sui string is invalid")
    _append_bytes(output, field, encoded)


def _append_u64(output: bytearray, field: int, value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_U64:
        raise ErpcConfigError("Sui integer is out of range")
    _append_key(output, field, 0)
    output.extend(encode_varint(value))


def _frame_request(payload: bytes) -> bytes:
    if len(payload) + 5 > SUI_REQUEST_LIMIT:
        raise ErpcConfigError("Sui request exceeds 1 MiB")
    return b"\x00" + len(payload).to_bytes(4, "big") + payload


def _validate_input(value: str, label: str) -> None:
    if (
        not isinstance(value, str)
        or not value
        or any(
            ord(character) < 0x20
            or ord(character) == 0x7F
            or 0xD800 <= ord(character) <= 0xDFFF
            for character in value
        )
    ):
        raise ErpcConfigError(f"Sui {label} is invalid")


def encode_get_service_info_request() -> bytes:
    return _frame_request(b"")


def encode_get_object_request(object_id: str, version: int | None = None) -> bytes:
    _validate_input(object_id, "object ID")
    if version is not None and (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version < 0
        or version > MAX_U64
    ):
        raise ErpcConfigError("Sui object version is invalid")
    payload = bytearray()
    _append_string(payload, 1, object_id)
    if version is not None:
        _append_u64(payload, 2, version)
    return _frame_request(bytes(payload))


def encode_get_balance_request(owner: str, coin_type: str) -> bytes:
    _validate_input(owner, "owner")
    _validate_input(coin_type, "coin type")
    payload = bytearray()
    _append_string(payload, 1, owner)
    _append_string(payload, 2, coin_type)
    return _frame_request(bytes(payload))


class _Reader:
    __slots__ = ("_bytes", "_offset", "_depth")

    def __init__(self, value: bytes, *, depth: int = 0) -> None:
        self._bytes = value
        self._offset = 0
        self._depth = depth

    @property
    def done(self) -> bool:
        return self._offset == len(self._bytes)

    def key(self) -> tuple[int, int]:
        key = self.varint()
        field = key >> 3
        wire = key & 7
        if field <= 0 or field > 0x1FFFFFFF or wire in {6, 7}:
            raise _invalid()
        return field, wire

    def varint(self) -> int:
        value = 0
        for index in range(10):
            if self._offset >= len(self._bytes):
                raise _invalid()
            byte = self._bytes[self._offset]
            self._offset += 1
            if index == 9 and byte > 1:
                raise _invalid()
            value |= (byte & 0x7F) << (index * 7)
            if byte & 0x80 == 0:
                return value
        raise _invalid()

    def length_delimited(self) -> bytes:
        length = self.varint()
        end = self._offset + length
        if end > len(self._bytes):
            raise _invalid()
        value = self._bytes[self._offset : end]
        self._offset = end
        return value

    def string(self) -> str:
        value = self.length_delimited()
        decoded: str | None = None
        try:
            decoded = value.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            pass
        if decoded is None:
            raise _invalid()
        return decoded

    def skip_bytes(self, length: int) -> None:
        end = self._offset + length
        if length < 0 or end > len(self._bytes):
            raise _invalid()
        self._offset = end

    def skip(self, wire: int, field: int) -> None:
        if wire == 4:
            raise _invalid()
        if wire == 0:
            self.varint()
            return
        if wire == 1:
            self.skip_bytes(8)
            return
        if wire == 2:
            self.length_delimited()
            return
        if wire == 3:
            self._depth += 1
            if self._depth > MAX_DEPTH:
                raise _invalid()
            try:
                while True:
                    child_field, child_wire = self.key()
                    if child_wire == 4:
                        if child_field != field:
                            raise _invalid()
                        return
                    self.skip(child_wire, child_field)
            finally:
                self._depth -= 1
        elif wire == 5:
            self.skip_bytes(4)
        else:
            raise _invalid()

    def nested(self, decoder: Callable[[_Reader], T]) -> T:
        payload = self.length_delimited()
        self._depth += 1
        if self._depth > MAX_DEPTH:
            raise _invalid()
        child = _Reader(payload, depth=self._depth)
        try:
            value = decoder(child)
            if not child.done:
                raise _invalid()
            return value
        finally:
            self._depth -= 1


def _require_wire(actual: int, expected: int) -> None:
    if actual != expected:
        raise _invalid()


def _signed_i64(value: int) -> int:
    return value - (1 << 64) if value > MAX_I64 else value


def _signed_i32(value: int) -> int:
    lower = value & 0xFFFFFFFF
    return lower - 0x100000000 if lower >= 0x80000000 else lower


@dataclass(frozen=True, slots=True)
class SuiTimestampWire:
    seconds: int
    nanos: int


@dataclass(frozen=True, slots=True)
class _TimestampPartial:
    seconds: int | None = None
    nanos: int | None = None


@dataclass(frozen=True, slots=True)
class SuiServiceInfoWire:
    chain_id: str
    chain: str
    epoch: int
    checkpoint_height: int
    timestamp: SuiTimestampWire
    lowest_available_checkpoint: int
    lowest_available_checkpoint_objects: int
    server: str | None = None


@dataclass(frozen=True, slots=True)
class SuiObjectSummaryWire:
    object_id: str
    version: int
    digest: str


@dataclass(frozen=True, slots=True)
class SuiBalanceWire:
    coin_type: str
    balance: int
    address_balance: int
    coin_balance: int


def _decode_timestamp(reader: _Reader) -> _TimestampPartial:
    seconds: int | None = None
    nanos: int | None = None
    while not reader.done:
        field, wire = reader.key()
        if field == 1:
            _require_wire(wire, 0)
            seconds = _signed_i64(reader.varint())
        elif field == 2:
            _require_wire(wire, 0)
            nanos = _signed_i32(reader.varint())
        else:
            reader.skip(wire, field)
    return _TimestampPartial(seconds, nanos)


def _decode_service_info(reader: _Reader) -> SuiServiceInfoWire:
    chain_id: str | None = None
    chain: str | None = None
    epoch: int | None = None
    checkpoint_height: int | None = None
    timestamp: SuiTimestampWire | None = None
    lowest_available_checkpoint: int | None = None
    lowest_available_checkpoint_objects: int | None = None
    server: str | None = None
    while not reader.done:
        field, wire = reader.key()
        if field == 1:
            _require_wire(wire, 2)
            chain_id = reader.string()
        elif field == 2:
            _require_wire(wire, 2)
            chain = reader.string()
        elif field == 3:
            _require_wire(wire, 0)
            epoch = reader.varint()
        elif field == 4:
            _require_wire(wire, 0)
            checkpoint_height = reader.varint()
        elif field == 5:
            _require_wire(wire, 2)
            next_timestamp = reader.nested(_decode_timestamp)
            previous = timestamp or SuiTimestampWire(0, 0)
            timestamp = SuiTimestampWire(
                next_timestamp.seconds if next_timestamp.seconds is not None else previous.seconds,
                next_timestamp.nanos if next_timestamp.nanos is not None else previous.nanos,
            )
        elif field == 6:
            _require_wire(wire, 0)
            lowest_available_checkpoint = reader.varint()
        elif field == 7:
            _require_wire(wire, 0)
            lowest_available_checkpoint_objects = reader.varint()
        elif field == 8:
            _require_wire(wire, 2)
            server = reader.string()
        else:
            reader.skip(wire, field)
    if (
        chain_id is None
        or chain is None
        or epoch is None
        or checkpoint_height is None
        or timestamp is None
        or lowest_available_checkpoint is None
        or lowest_available_checkpoint_objects is None
    ):
        raise _invalid()
    if timestamp.nanos < 0 or timestamp.nanos >= 1_000_000_000:
        raise _invalid()
    return SuiServiceInfoWire(
        chain_id,
        chain,
        epoch,
        checkpoint_height,
        timestamp,
        lowest_available_checkpoint,
        lowest_available_checkpoint_objects,
        server,
    )


def _decode_object(reader: _Reader) -> dict[str, object]:
    result: dict[str, object] = {}
    while not reader.done:
        field, wire = reader.key()
        if field == 2:
            _require_wire(wire, 2)
            result["object_id"] = reader.string()
        elif field == 3:
            _require_wire(wire, 0)
            result["version"] = reader.varint()
        elif field == 4:
            _require_wire(wire, 2)
            result["digest"] = reader.string()
        else:
            reader.skip(wire, field)
    return result


def _decode_object_envelope(reader: _Reader) -> SuiObjectSummaryWire:
    result: dict[str, object] = {}
    while not reader.done:
        field, wire = reader.key()
        if field == 1:
            _require_wire(wire, 2)
            result.update(reader.nested(_decode_object))
        else:
            reader.skip(wire, field)
    object_id = result.get("object_id")
    version = result.get("version")
    digest = result.get("digest")
    if (
        not isinstance(object_id, str)
        or not isinstance(version, int)
        or not isinstance(digest, str)
    ):
        raise _invalid()
    return SuiObjectSummaryWire(object_id, version, digest)


def _decode_balance(reader: _Reader) -> dict[str, object]:
    result: dict[str, object] = {}
    while not reader.done:
        field, wire = reader.key()
        if field == 1:
            _require_wire(wire, 2)
            result["coin_type"] = reader.string()
        elif field == 3:
            _require_wire(wire, 0)
            result["balance"] = reader.varint()
        elif field == 4:
            _require_wire(wire, 0)
            result["address_balance"] = reader.varint()
        elif field == 5:
            _require_wire(wire, 0)
            result["coin_balance"] = reader.varint()
        else:
            reader.skip(wire, field)
    return result


def _decode_balance_envelope(reader: _Reader) -> SuiBalanceWire:
    result: dict[str, object] = {}
    while not reader.done:
        field, wire = reader.key()
        if field == 1:
            _require_wire(wire, 2)
            result.update(reader.nested(_decode_balance))
        else:
            reader.skip(wire, field)
    coin_type = result.get("coin_type")
    balance = result.get("balance")
    address_balance = result.get("address_balance")
    coin_balance = result.get("coin_balance")
    if not all(
        isinstance(value, (str, int))
        for value in (coin_type, balance, address_balance, coin_balance)
    ):
        raise _invalid()
    if (
        not isinstance(coin_type, str)
        or not isinstance(balance, int)
        or not isinstance(address_balance, int)
        or not isinstance(coin_balance, int)
    ):
        raise _invalid()
    if address_balance + coin_balance != balance:
        raise _invalid()
    return SuiBalanceWire(coin_type, balance, address_balance, coin_balance)


def decode_service_info_response(payload: bytes) -> SuiServiceInfoWire:
    return _decode_service_info(_Reader(payload))


def decode_object_response(payload: bytes) -> SuiObjectSummaryWire:
    return _decode_object_envelope(_Reader(payload))


def decode_balance_response(payload: bytes) -> SuiBalanceWire:
    return _decode_balance_envelope(_Reader(payload))


__all__ = [
    "MAX_DEPTH",
    "MAX_I64",
    "MAX_U64",
    "SUI_REQUEST_LIMIT",
    "SUI_RESPONSE_LIMIT",
    "SUI_TRAILER_LIMIT",
    "SuiBalanceWire",
    "SuiObjectSummaryWire",
    "SuiServiceInfoWire",
    "SuiTimestampWire",
    "decode_balance_response",
    "decode_object_response",
    "decode_service_info_response",
    "encode_get_balance_request",
    "encode_get_object_request",
    "encode_get_service_info_request",
    "encode_varint",
]
