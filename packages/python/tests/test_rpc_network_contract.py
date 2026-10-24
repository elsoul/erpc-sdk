# ruff: noqa: E501,E701,F841
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

import httpx
import pytest

from erpc_sdk import (
    ErpcAbortedError,
    ErpcClient,
    ErpcClientConfig,
    ErpcError,
    ErpcHttpError,
    ErpcInvalidResponseError,
    ErpcJsonRpcError,
    ErpcNotConfiguredError,
    ErpcTimeoutError,
    ErpcTransportError,
    NearBlockReference,
    RpcEndpointConfig,
    SuiGrpcWebEndpointConfig,
)
from erpc_sdk._rpc_network_contract_data import RPC_NETWORK_CONTRACT_DIGEST
from erpc_sdk.types import RequestOptions

_ROOT = Path(__file__).resolve().parents[3]
_FIXTURE = _ROOT / "registry" / "fixtures" / "rpc-chain-contract-cases.json"
_CONTRACT = _ROOT / "registry" / "rpc-network-contract.json"
_FINAL_CONTRACT_DIGEST = "1cbe2b4a07c1d91b4bd40ea9501aa3c1f609489adde60baf1fea4dc89f506e67"
_FINAL_FIXTURE_DIGEST = "80c9465eac93e1536125d0af98d24b0215226cb9857f5d026ac4998923bd26d3"
_CAPTURE_FIXTURE: dict[str, Any] = {}


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _stable_json(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + _stable_json(value[key])
            for key in sorted(value)
        ) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class _RawNumber(str):
    pass


def _lossless_json_bytes(value: bytes) -> bytes:
    parsed = json.loads(value.decode("utf-8"), parse_int=_RawNumber, parse_float=_RawNumber)

    def emit(item: Any) -> str:
        if isinstance(item, _RawNumber):
            return str(item)
        if isinstance(item, list):
            return "[" + ",".join(emit(child) for child in item) + "]"
        if isinstance(item, dict):
            return (
                "{"
                + ",".join(
                    json.dumps(key, ensure_ascii=False, separators=(",", ":"))
                    + ":"
                    + emit(item[key])
                    for key in sorted(item)
                )
                + "}"
            )
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"))

    return emit(parsed).encode("utf-8")


def _run_descriptor_materializer() -> dict[str, dict[str, bytes]]:
    # Fixed helper: only approved fixture descriptor expansion, no data-supplied command execution.
    script = r"""
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const parity = await import('./registry/verify-rpc-network-parity.mjs');
const bytes = (entry, direction) => {
  const exchange = entry.mockExchange[direction];
  if (exchange.bodyEncoding === 'hex') return Buffer.from(exchange.body, 'hex').toString('base64');
  if (exchange.bodyEncoding === 'json' || exchange.bodyEncoding === 'utf8') return Buffer.from(exchange.body, 'utf8').toString('base64');
  const source = entry[direction === 'request' ? 'requestDescriptor' : 'responseDescriptor'];
  const golden = source.kind === 'oracle-ref-v1' ? fixture.oracleGoldens.find((item) => item.goldenId === source.oracleGoldenId) : source;
  const chunks = parity.expandDescriptorChunks(golden.descriptor);
  return Buffer.concat([...parity.applyChunkPlan(chunks, golden.chunkPlan, golden.measurement.decodedLength)]).toString('base64');
};
const output = {};
for (const entry of fixture.cases) output[entry.caseId] = { request: bytes(entry, 'request'), response: bytes(entry, 'response') };
for (const golden of fixture.suiGrpcWeb.golden) output[`sui:${golden.id}`] = { request: Buffer.from(golden.requestFrameHex, 'hex').toString('base64'), response: Buffer.from(golden.responseBodyHex, 'hex').toString('base64') };
process.stdout.write(JSON.stringify(output));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(_FIXTURE)],
        cwd=_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    raw = json.loads(completed.stdout)
    return {
        case_id: {direction: base64.b64decode(encoded) for direction, encoded in values.items()}
        for case_id, values in raw.items()
    }


def _read_fixture() -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, bytes]]]:
    return (
        json.loads(_FIXTURE.read_text()),
        json.loads(_CONTRACT.read_text()),
        _run_descriptor_materializer(),
    )


def _wire_equal(actual: Any, source: Any) -> bool:
    if isinstance(actual, Decimal) or isinstance(source, Decimal):
        try:
            return Decimal(str(actual)) == Decimal(str(source)) and type(actual) is type(source)
        except Exception:
            return False
    if isinstance(actual, (int, str, bool)) or actual is None:
        return actual == source and (not isinstance(actual, bool) or type(actual) is type(source))
    if isinstance(actual, list) or isinstance(source, list):
        return (
            isinstance(actual, list)
            and isinstance(source, list)
            and len(actual) == len(source)
            and all(_wire_equal(left, right) for left, right in zip(actual, source, strict=True))
        )
    if isinstance(actual, dict) or isinstance(source, dict):
        return (
            isinstance(actual, dict)
            and isinstance(source, dict)
            and set(actual) == set(source)
            and all(_wire_equal(actual[key], source[key]) for key in actual)
        )
    return actual == source


def _near_wire(operation: str, value: Any) -> Any:
    def freeze(item: Any) -> Any:
        if isinstance(item, (list, tuple)):
            return [freeze(child) for child in item]
        if isinstance(item, dict):
            return {key: freeze(child) for key, child in item.items()}
        return item

    def extra(item: Any) -> dict[str, Any]:
        return {key: freeze(child) for key, child in item.items()}

    if operation == "status":
        return {
            "chain_id": value.chain_id,
            "genesis_hash": value.genesis_hash,
            "latest_protocol_version": value.latest_protocol_version,
            "protocol_version": value.protocol_version,
            "sync_info": {
                "latest_block_hash": value.sync_info.latest_block_hash,
                "latest_block_height": value.sync_info.latest_block_height,
                "latest_block_time": value.sync_info.latest_block_time,
                "latest_state_root": value.sync_info.latest_state_root,
                "syncing": value.sync_info.syncing,
                **extra(value.sync_info.additional),
            },
            "version": {
                "version": value.version.version,
                "build": value.version.build,
                **(
                    {}
                    if value.version.rustc_version is None
                    else {"rustc_version": value.version.rustc_version}
                ),
                **extra(value.version.additional),
            },
            **extra(value.additional),
        }
    if operation == "block":
        return {
            "author": value.author,
            "header": {
                "hash": value.header.hash,
                "height": value.header.height,
                "prev_hash": value.header.prev_hash,
                "timestamp": value.header.timestamp,
                "timestamp_nanosec": value.header.timestamp_nanosec,
                "gas_price": value.header.gas_price,
                "total_supply": value.header.total_supply,
                **extra(value.header.additional),
            },
            "chunks": freeze(value.chunks),
            **extra(value.additional),
        }
    return {
        "amount": value.amount,
        "locked": value.locked,
        "code_hash": value.code_hash,
        "storage_usage": value.storage_usage,
        **({} if value.storage_paid_at is None else {"storage_paid_at": value.storage_paid_at}),
        "block_height": value.block_height,
        "block_hash": value.block_hash,
        **({} if value.state is None else {"state": value.state}),
        **({} if value.bootstrap_nonce is None else {"bootstrap_nonce": value.bootstrap_nonce}),
        **(
            {}
            if value.global_contract_account_id is None
            else {"global_contract_account_id": value.global_contract_account_id}
        ),
        **(
            {}
            if value.global_contract_hash is None
            else {"global_contract_hash": value.global_contract_hash}
        ),
        **extra(value.additional),
    }


def _sui_wire(operation: str, value: Any) -> dict[str, Any]:
    if operation == "getServiceInfo":
        return {
            "chainId": value.chain_id,
            "chain": value.chain,
            "epoch": value.epoch,
            "checkpoint": value.checkpoint_height,
            "timestampSeconds": value.timestamp_seconds,
            "timestampNanos": value.timestamp_nanos,
            "lowestCheckpoint": value.lowest_available_checkpoint,
            "lowestVerifiedCheckpoint": value.lowest_available_checkpoint_objects,
            **({} if value.server is None else {"server": value.server}),
        }
    if operation == "getObject":
        return {"objectId": value.object_id, "version": value.version, "digest": value.digest}
    return {
        "coinType": value.coin_type,
        "balance": value.balance,
        "addressBalance": value.address_balance,
        "coinBalance": value.coin_balance,
    }


class _IndependentSuiDecodeError(ValueError):
    """The capture oracle's bounded, independent Sui wire decoder failed."""


def _sui_read_varint(payload: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for index in range(10):
        if offset >= len(payload):
            raise _IndependentSuiDecodeError("truncated varint")
        byte = payload[offset]
        offset += 1
        if index == 9 and byte > 1:
            raise _IndependentSuiDecodeError("varint overflow")
        value |= (byte & 0x7F) << (index * 7)
        if byte & 0x80 == 0:
            return value, offset
    raise _IndependentSuiDecodeError("unterminated varint")


def _sui_skip_group(payload: bytes, offset: int, group_field: int) -> int:
    while offset < len(payload):
        key, offset = _sui_read_varint(payload, offset)
        field, wire = key >> 3, key & 7
        if wire == 4:
            if field != group_field:
                raise _IndependentSuiDecodeError("mismatched protobuf group")
            return offset
        if wire == 3:
            offset = _sui_skip_group(payload, offset, field)
            continue
        if wire == 0:
            _, offset = _sui_read_varint(payload, offset)
        elif wire == 1:
            offset += 8
        elif wire == 2:
            length, offset = _sui_read_varint(payload, offset)
            offset += length
        elif wire == 5:
            offset += 4
        else:
            raise _IndependentSuiDecodeError("unsupported protobuf group wire")
        if offset > len(payload):
            raise _IndependentSuiDecodeError("truncated protobuf group")
    raise _IndependentSuiDecodeError("unterminated protobuf group")


def _sui_fields(payload: bytes) -> dict[int, list[Any]]:
    """Decode protobuf wire primitives without importing the SDK codec."""
    fields: dict[int, list[Any]] = {}
    offset = 0
    while offset < len(payload):
        key, offset = _sui_read_varint(payload, offset)
        field, wire = key >> 3, key & 7
        if field <= 0 or wire in {4, 6, 7}:
            raise _IndependentSuiDecodeError("unsupported protobuf key")
        if wire == 3:
            offset = _sui_skip_group(payload, offset, field)
            continue
        if wire == 0:
            value, offset = _sui_read_varint(payload, offset)
        elif wire == 1:
            end = offset + 8
            if end > len(payload):
                raise _IndependentSuiDecodeError("truncated fixed64")
            value = payload[offset:end]
            offset = end
        elif wire == 2:
            length, offset = _sui_read_varint(payload, offset)
            end = offset + length
            if end > len(payload):
                raise _IndependentSuiDecodeError("truncated bytes")
            value = payload[offset:end]
            offset = end
        elif wire == 5:
            end = offset + 4
            if end > len(payload):
                raise _IndependentSuiDecodeError("truncated fixed32")
            value = payload[offset:end]
            offset = end
        else:
            raise _IndependentSuiDecodeError("unsupported protobuf wire")
        fields.setdefault(field, []).append(value)
    return fields


def _sui_string(value: Any) -> str:
    if not isinstance(value, bytes):
        raise _IndependentSuiDecodeError("string field is not bytes")
    try:
        return value.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise _IndependentSuiDecodeError("invalid UTF-8") from error


def _sui_one(fields: dict[int, list[Any]], field: int, wire_type: type) -> Any:
    values = fields.get(field)
    if not values or not isinstance(values[-1], wire_type):
        raise _IndependentSuiDecodeError(f"missing field {field}")
    return values[-1]


def _sui_signed_i64(value: int) -> int:
    return value - (1 << 64) if value > 9_223_372_036_854_775_807 else value


def _sui_signed_i32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value - (1 << 32) if value >= 0x80000000 else value


def _sui_data_payload(response: bytes) -> bytes:
    if len(response) < 10 or response[0] != 0:
        raise _IndependentSuiDecodeError("invalid gRPC-Web response framing")
    data_length = int.from_bytes(response[1:5], "big")
    data_end = 5 + data_length
    if data_end + 5 > len(response) or response[data_end] != 0x80:
        raise _IndependentSuiDecodeError("missing gRPC-Web trailer")
    trailer_length = int.from_bytes(response[data_end + 1 : data_end + 5], "big")
    trailer_end = data_end + 5 + trailer_length
    if trailer_end != len(response):
        raise _IndependentSuiDecodeError("trailing bytes after gRPC-Web trailer")
    trailer = response[data_end + 5 : trailer_end]
    if not trailer.endswith(b"\r\n") or b"grpc-status: 0\r\n" not in trailer:
        raise _IndependentSuiDecodeError("invalid gRPC-Web trailer")
    return response[5:data_end]


def _sui_raw_wire(operation: str, response: bytes) -> dict[str, Any]:
    """Independently interpret the exact common response bytes."""
    payload = _sui_data_payload(response)
    fields = _sui_fields(payload)
    if operation == "getServiceInfo":
        timestamp_seconds = 0
        timestamp_nanos = 0
        for timestamp_payload in fields.get(5, []):
            timestamp_fields = _sui_fields(timestamp_payload)
            if 1 in timestamp_fields:
                timestamp_seconds = _sui_signed_i64(_sui_one(timestamp_fields, 1, int))
            if 2 in timestamp_fields:
                timestamp_nanos = _sui_signed_i32(_sui_one(timestamp_fields, 2, int))
        if 5 not in fields:
            raise _IndependentSuiDecodeError("missing timestamp")
        return {
            "chainId": _sui_string(_sui_one(fields, 1, bytes)),
            "chain": _sui_string(_sui_one(fields, 2, bytes)),
            "epoch": _sui_one(fields, 3, int),
            "checkpoint": _sui_one(fields, 4, int),
            "timestampSeconds": timestamp_seconds,
            "timestampNanos": timestamp_nanos,
            "lowestCheckpoint": _sui_one(fields, 6, int),
            "lowestVerifiedCheckpoint": _sui_one(fields, 7, int),
            **(
                {}
                if 8 not in fields
                else {"server": _sui_string(_sui_one(fields, 8, bytes))}
            ),
        }
    if operation == "getObject":
        nested = fields.get(1)
        if not nested:
            raise _IndependentSuiDecodeError("missing object envelope")
        current = nested[-1]
        for _ in range(128):
            inner = _sui_fields(current)
            if all(field in inner for field in (2, 3, 4)):
                return {
                    "objectId": _sui_string(_sui_one(inner, 2, bytes)),
                    "version": _sui_one(inner, 3, int),
                    "digest": _sui_string(_sui_one(inner, 4, bytes)),
                }
            next_values = inner.get(1)
            if not next_values or not isinstance(next_values[-1], bytes):
                break
            current = next_values[-1]
        raise _IndependentSuiDecodeError("missing object fields")
    if operation == "getBalance":
        nested = fields.get(1)
        if not nested:
            raise _IndependentSuiDecodeError("missing balance envelope")
        inner = _sui_fields(nested[-1])
        return {
            "coinType": _sui_string(_sui_one(inner, 1, bytes)),
            "balance": _sui_one(inner, 3, int),
            "addressBalance": _sui_one(inner, 4, int),
            "coinBalance": _sui_one(inner, 5, int),
        }
    raise _IndependentSuiDecodeError(f"unsupported Sui operation: {operation}")


def _sui_object_nesting_depth(response: bytes) -> int:
    fields = _sui_fields(_sui_data_payload(response))
    nested = fields.get(1)
    if not nested or not isinstance(nested[-1], bytes):
        raise _IndependentSuiDecodeError("missing object envelope")
    # The embedded-depth goldens use protobuf groups as unknown nested
    # containers.  The outer object envelope contributes one level.
    def count_group(payload: bytes, offset: int, group_field: int) -> tuple[int, int]:
        count = 1
        while offset < len(payload):
            key, offset = _sui_read_varint(payload, offset)
            field, wire = key >> 3, key & 7
            if wire == 4:
                if field != group_field:
                    raise _IndependentSuiDecodeError("mismatched protobuf group")
                return count, offset
            if wire == 3:
                nested_count, offset = count_group(payload, offset, field)
                count += nested_count
            elif wire == 0:
                _, offset = _sui_read_varint(payload, offset)
            elif wire == 1:
                offset += 8
            elif wire == 2:
                length, offset = _sui_read_varint(payload, offset)
                offset += length
            elif wire == 5:
                offset += 4
            else:
                raise _IndependentSuiDecodeError("invalid object nesting wire")
            if offset > len(payload):
                raise _IndependentSuiDecodeError("truncated object nesting")
        raise _IndependentSuiDecodeError("unterminated object group")

    offset = 0
    groups = 0
    payload = nested[-1]
    while offset < len(payload):
        key, offset = _sui_read_varint(payload, offset)
        field, wire = key >> 3, key & 7
        if wire == 3:
            nested_count, offset = count_group(payload, offset, field)
            groups += nested_count
        elif wire == 0:
            _, offset = _sui_read_varint(payload, offset)
        elif wire == 1:
            offset += 8
        elif wire == 2:
            length, offset = _sui_read_varint(payload, offset)
            offset += length
        elif wire == 5:
            offset += 4
        else:
            raise _IndependentSuiDecodeError("invalid object nesting wire")
        if offset > len(payload):
            raise _IndependentSuiDecodeError("truncated object nesting")
    return groups + 1


def _assert_sui_wire_matches_raw(operation: str, value: Any, response: bytes) -> dict[str, Any]:
    actual = _sui_wire(operation, value)
    raw = _sui_raw_wire(operation, response)
    assert actual == raw, f"Sui DTO differs from independent raw response: {actual!r} != {raw!r}"
    return actual


def _public_operation(entry: dict[str, Any]) -> str:
    return (
        entry.get("operation", {})
        .get("publicOperations", {})
        .get("python", entry["operation"]["publicOperation"])
    )


def _client_field(client_id: str) -> str:
    return {
        "client-base-rpc": "base_rpc",
        "client-arbitrum-rpc": "arbitrum_rpc",
        "client-bitcoin-rpc": "bitcoin_rpc",
        "client-polygon-rpc": "polygon_rpc",
        "client-bsc-rpc": "bsc_rpc",
        "client-optimism-rpc": "optimism_rpc",
        "client-kaia-rpc": "kaia_rpc",
        "client-soneium-rpc": "soneium_rpc",
        "client-monad-rpc": "monad_rpc",
        "client-hyperliquid-rpc": "hyperliquid_rpc",
        "client-arc-rpc": "arc_rpc",
        "client-robinhood-rpc": "robinhood_rpc",
        "client-near-rpc": "near_rpc",
        "client-tron-rpc": "tron_rpc",
        "client-sui-grpc": "sui_grpc_web",
        "client-ethereum-rpc": "ethereum_rpc",
        "client-solana-rpc": "solana_rpc",
        "client-avalanche-rpc": "avalanche_c_rpc",
    }[client_id]


def _hosted_field(client_id: str) -> str:
    return {
        "client-base-rpc": "base_endpoint",
        "client-arbitrum-rpc": "arbitrum_endpoint",
        "client-polygon-rpc": "polygon_endpoint",
        "client-bsc-rpc": "bsc_endpoint",
        "client-optimism-rpc": "optimism_endpoint",
        "client-kaia-rpc": "kaia_endpoint",
        "client-soneium-rpc": "soneium_endpoint",
        "client-monad-rpc": "monad_endpoint",
        "client-hyperliquid-rpc": "hyperliquid_endpoint",
        "client-arc-rpc": "arc_endpoint",
        "client-robinhood-rpc": "robinhood_endpoint",
        "client-near-rpc": "near_endpoint",
        "client-tron-rpc": "tron_endpoint",
    }.get(client_id, "endpoint")


def _endpoint_for_config(entry: dict[str, Any]) -> str:
    endpoint = entry["setup"].get("endpoint")
    if isinstance(endpoint, str):
        if entry["clientContractId"] == "client-bitcoin-rpc" and entry["setup"]["mode"] == "hosted":
            parsed = urlsplit(endpoint)
            return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
        return endpoint
    return "https://node.fixture.invalid/rpc"


def _endpoint_origin(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def _expected_endpoint(entry: dict[str, Any]) -> str:
    if entry["setup"]["mode"] == "unconfigured":
        return ""
    endpoint = _endpoint_for_config(entry)
    if entry["clientContractId"] in {
        "client-avalanche-rpc",
        "client-ethereum-rpc",
        "client-solana-rpc",
    }:
        parsed = urlsplit(endpoint)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    return _endpoint_origin(endpoint)


def _assert_endpoint_getter(entry: dict[str, Any], endpoint: Any) -> str:
    assert isinstance(endpoint, str), f"{entry['caseId']} endpoint getter is not a string"
    expected = _expected_endpoint(entry)
    assert endpoint == expected, (
        f"{entry['caseId']} endpoint getter mismatch actual={endpoint!r} expected={expected!r}"
    )
    # A getter is accepted only as the exact sealed value; path/query
    # normalization happens after this assertion, never before it.
    assert "?" not in endpoint and "#" not in endpoint
    if entry["clientContractId"] not in {
        "client-avalanche-rpc",
        "client-ethereum-rpc",
        "client-solana-rpc",
    }:
        assert urlsplit(endpoint).path in {"", "/"}
    return endpoint


def _build_config(entry: dict[str, Any], timeout: float) -> ErpcClientConfig:
    setup = entry["setup"]
    client_id = entry["clientContractId"]
    headers = dict(setup.get("headers") or {})
    kwargs: dict[str, Any] = {"timeout": timeout}
    if setup["mode"] == "unconfigured":
        kwargs["ethereum_rpc"] = RpcEndpointConfig("https://unrelated.fixture.invalid/rpc")
        return ErpcClientConfig(**kwargs)
    if setup["mode"] == "none":
        kwargs["bitcoin_rpc" if client_id == "client-bitcoin-rpc" else _client_field(client_id)] = (
            RpcEndpointConfig(_endpoint_for_config(entry), headers=headers)
        )
        return ErpcClientConfig(**kwargs)
    if setup["mode"] == "hosted":
        kwargs["api_key"] = setup.get("apiKey")
        kwargs[_hosted_field(client_id)] = _endpoint_for_config(entry)
        return ErpcClientConfig(**kwargs)
    kwargs["sui_grpc_web" if client_id == "client-sui-grpc" else _client_field(client_id)] = (
        SuiGrpcWebEndpointConfig(_endpoint_for_config(entry), headers=headers)
        if client_id == "client-sui-grpc"
        else RpcEndpointConfig(_endpoint_for_config(entry), headers=headers)
    )
    return ErpcClientConfig(**kwargs)


def _surface(client: Any, client_id: str) -> Any:
    if client_id == "client-sui-grpc":
        return client.sui.grpc
    if client_id == "client-bitcoin-rpc":
        return client.bitcoin.rpc
    if client_id == "client-near-rpc":
        return client.near.rpc
    if client_id == "client-solana-rpc":
        return client.solana.rpc
    if client_id == "client-avalanche-rpc":
        return client.avalanche.rpc
    if client_id == "client-ethereum-rpc":
        return client.ethereum.rpc
    names = {
        "client-base-rpc": "base",
        "client-arbitrum-rpc": "arbitrum",
        "client-polygon-rpc": "polygon",
        "client-bsc-rpc": "bsc",
        "client-optimism-rpc": "optimism",
        "client-kaia-rpc": "kaia",
        "client-soneium-rpc": "soneium",
        "client-monad-rpc": "monad",
        "client-hyperliquid-rpc": "hyperliquid",
        "client-arc-rpc": "arc",
        "client-robinhood-rpc": "robinhood",
        "client-tron-rpc": "tron",
    }
    return getattr(client, names[client_id]).rpc


def _invoke(client: Any, entry: dict[str, Any], options: RequestOptions | None = None) -> Any:
    if options is None:
        options = RequestOptions()
    op = _public_operation(entry)
    params = entry["operation"].get("params")
    client_id = entry["clientContractId"]
    if op in {"surface", "cancellation"}:
        return None
    if client_id == "client-bitcoin-rpc":
        return getattr(client.bitcoin.rpc, op)(*(params if isinstance(params, list) else [])).send(
            options
        )
    if client_id == "client-near-rpc":
        if op == "status":
            return client.near.rpc.status().send(options)
        if op == "block":
            ref = (
                NearBlockReference.final()
                if params.get("finality") == "final"
                else NearBlockReference.optimistic()
                if params.get("finality") == "optimistic"
                else NearBlockReference.height(params["block_id"])
                if isinstance(params.get("block_id"), int)
                else NearBlockReference.hash(params["block_id"])
            )
            return client.near.rpc.block(ref).send(options)
        ref = (
            NearBlockReference.final()
            if params.get("finality") == "final"
            else NearBlockReference.optimistic()
            if params.get("finality") == "optimistic"
            else NearBlockReference.height(params["block_id"])
            if isinstance(params.get("block_id"), int)
            else NearBlockReference.hash(params["block_id"])
        )
        return client.near.rpc.view_account(params["account_id"], ref).send(options)
    if client_id == "client-sui-grpc":
        if op == "getServiceInfo":
            return client.sui.grpc.get_service_info().send(options)
        if op == "getObject":
            p = params[0] if isinstance(params, list) else params
            request_descriptor = entry.get("requestDescriptor") or {}
            if request_descriptor.get("kind") == "oracle-ref-v1" and request_descriptor.get("oracleGoldenId") in {"sui-request-bytes-inclusive", "sui-request-bytes-over"}:
                golden = next(item for item in _CAPTURE_FIXTURE["oracleGoldens"] if item["goldenId"] == request_descriptor["oracleGoldenId"])
                descriptor = golden["descriptor"]
                return client.sui.grpc.get_object(descriptor["objectByte"] * descriptor["objectCount"], None).send(options)
            return client.sui.grpc.get_object(p["objectId"], p.get("version")).send(options)
        p = (
            params[0]
            if isinstance(params, list) and len(params) == 1 and isinstance(params[0], dict)
            else params
        )
        return (
            client.sui.grpc.get_balance(p["owner"], p["coinType"]).send(options)
            if isinstance(p, dict)
            else client.sui.grpc.get_balance(p[0], p[1]).send(options)
        )
    if client_id == "client-solana-rpc":
        return client.solana.rpc.get_genesis_hash().send(options)
    if client_id == "client-avalanche-rpc":
        return getattr(client.avalanche.rpc, op)(
            *(params if isinstance(params, list) else [])
        ).send(options)
    if client_id == "client-ethereum-rpc":
        return getattr(client.ethereum.rpc, op)(
            *(params if isinstance(params, list) else [])
        ).send(options)
    names = {
        "client-base-rpc": "base",
        "client-arbitrum-rpc": "arbitrum",
        "client-polygon-rpc": "polygon",
        "client-bsc-rpc": "bsc",
        "client-optimism-rpc": "optimism",
        "client-kaia-rpc": "kaia",
        "client-soneium-rpc": "soneium",
        "client-monad-rpc": "monad",
        "client-hyperliquid-rpc": "hyperliquid",
        "client-arc-rpc": "arc",
        "client-robinhood-rpc": "robinhood",
        "client-tron-rpc": "tron",
    }
    return getattr(client, names[client_id]).rpc.__getattribute__(op)(*(params if isinstance(params, list) else [])).send(options)


def _generic_result(entry: dict[str, Any], request: dict[str, Any]) -> Any:
    client_id = entry["clientContractId"]
    method = request.get("method")
    if client_id == "client-bitcoin-rpc":
        if method == "getblockcount":
            return 0
        if method == "gettxout":
            return None
        if method in {"getbestblockhash", "getblockhash", "getblockheader"}:
            return "warmup"
        return {}
    if client_id == "client-near-rpc":
        op = entry["operation"]["publicOperation"]
        if op == "status":
            return {
                "chain_id": "mainnet",
                "genesis_hash": "warmup",
                "latest_protocol_version": 1,
                "protocol_version": 1,
                "sync_info": {
                    "latest_block_hash": "warmup",
                    "latest_block_height": 1,
                    "latest_block_time": "time",
                    "latest_state_root": "warmup",
                    "syncing": False,
                },
                "version": {"version": "1", "build": "warmup", "rustc_version": "1"},
            }
        if op == "block":
            return {
                "author": "warmup.near",
                "header": {
                    "hash": "warmup",
                    "height": 1,
                    "prev_hash": "warmup",
                    "timestamp": 1,
                    "timestamp_nanosec": "1",
                    "gas_price": "1",
                    "total_supply": "1",
                },
                "chunks": [],
            }
        return {
            "amount": "1",
            "locked": "0",
            "code_hash": "warmup",
            "storage_usage": 1,
            "storage_paid_at": 0,
            "block_height": 1,
            "block_hash": "warmup",
        }
    if client_id == "client-solana-rpc":
        return "warmup-genesis"
    if client_id == "client-avalanche-rpc":
        return "0xa86a"
    return "0x0"


def _json_response(entry: dict[str, Any], request_body: bytes) -> bytes:
    try:
        request = json.loads(request_body.decode("utf-8"))
    except Exception:
        request = {"id": 1, "method": entry["operation"]["wireOperation"]}
    return json.dumps(
        {"jsonrpc": "2.0", "id": request["id"], "result": _generic_result(entry, request)},
        separators=(",", ":"),
    ).encode()


class _CaptureState:
    def __init__(self) -> None:
        self.entry: dict[str, Any] | None = None
        self.response = b""
        self.schedule: dict[str, Any] | None = None
        self.warmups = 0
        self.first_chunk = threading.Event()
        self.server_closed = threading.Event()


class _CaptureHandler(BaseHTTPRequestHandler):
    state: _CaptureState

    def log_message(self, *_args: Any) -> None:
        return

    def do_POST(self) -> None:
        state = self.state
        size = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(size)
        if state.warmups > 0:
            state.warmups -= 1
            value = _json_response(state.entry or {}, body)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)
            return
        entry = state.entry
        assert entry is not None
        schedule = state.schedule
        status = int(entry["mockExchange"]["response"]["status"])
        headers = dict(entry["mockExchange"]["response"].get("headers") or {})
        if schedule and schedule.get("kind") == "redirect-to-second-server":
            self.send_response(status)
            self.send_header("location", "http://127.0.0.1:1/redirect-target")
            self.end_headers()
            return
        if schedule and schedule.get("kind") == "reset-before-headers":
            self.connection.close()
            return
        if schedule and schedule.get("kind") == "withhold-headers":
            time.sleep(float(schedule.get("delayMs", 100)) / 1000)
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(state.response)))
        self.end_headers()
        first = max(1, len(state.response) // 2)
        if schedule and schedule.get("kind") in {
            "first-chunk-then-delay",
            "first-chunk-cancellation-barrier",
            "reset-after-first-chunk",
        }:
            self.wfile.write(state.response[:first])
            self.wfile.flush()
            if schedule["kind"] == "first-chunk-cancellation-barrier":
                state.first_chunk.set()
                state.server_closed.wait(1.0)
            elif schedule["kind"] == "first-chunk-then-delay":
                time.sleep(float(schedule.get("delayMs", 100)) / 1000)
            else:
                self.connection.close()
                return
            self.wfile.write(state.response[first:])
            return
        self.wfile.write(state.response)


class _RemapTransport(httpx.AsyncBaseTransport):
    def __init__(self, port: int, state: _CaptureState, captures: list[dict[str, Any]]) -> None:
        self._port = port
        self._state = state
        self._captures = captures
        self._transport = httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        capture = {
            "method": request.method,
            "url": str(request.url),
            "headers": {name.lower(): value for name, value in request.headers.items()},
            "body": body,
            "phase": "setup" if self._state.warmups > 0 else "measured",
        }
        self._captures.append(capture)
        local = httpx.URL(f"http://127.0.0.1:{self._port}{request.url.raw_path.decode('ascii')}")
        response = await self._transport.handle_async_request(
            httpx.Request(request.method, local, headers=request.headers, content=body)
        )
        capture["responseStatus"] = response.status_code
        return response

    async def aclose(self) -> None:
        await self._transport.aclose()


def _schedule(fixture: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in fixture.get("lifecycleSchedules", [])
            if item.get("id") == entry.get("scheduleId")
        ),
        None,
    )


def _redactions(entry: dict[str, Any]) -> tuple[str, ...]:
    setup = entry["setup"]
    values: list[str] = []
    if setup.get("apiKey"):
        values.append(setup["apiKey"])
    if setup.get("mode") == "direct" and isinstance(setup.get("endpoint"), str):
        parsed = urlsplit(setup["endpoint"])
        values.extend(part for part in parsed.path.split("/") if part)
        values.extend(unquote(part) for part in parsed.path.split("/") if part)
        values.extend(
            value for _, value in parse_qsl(parsed.query, keep_blank_values=True) if value
        )
    values.extend(value for value in (setup.get("headers") or {}).values() if value)
    return tuple(dict.fromkeys(values))


def _redact_url(value: str, entry: dict[str, Any]) -> str:
    if entry["setup"]["mode"] == "hosted":
        parsed = urlsplit(value)
        query = "&".join(
            component
            for component in parsed.query.split("&")
            if component and component.split("=", 1)[0].lower() != "api-key"
        )
        value = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))
    secrets = list(_redactions(entry))
    if entry["caseId"] != "c1-path-query-header-and-api-key-redaction" and entry["setup"].get("mode") == "direct":
        endpoint = entry["setup"].get("endpoint")
        if isinstance(endpoint, str):
            parsed_endpoint = urlsplit(endpoint)
            path_parts = {part for part in parsed_endpoint.path.split("/") if part}
            path_parts.update(unquote(part) for part in list(path_parts))
            secrets = [secret for secret in secrets if secret not in path_parts]
    for secret in sorted((secret for secret in secrets if not secret.isdigit()), key=len, reverse=True):
        value = value.replace(secret, "<redacted>")
    return value


def _redact_headers(headers: dict[str, str], entry: dict[str, Any]) -> dict[str, str]:
    header_secrets = list(_redactions(entry))
    if entry["caseId"] != "c1-path-query-header-and-api-key-redaction":
        endpoint = entry["setup"].get("endpoint")
        if isinstance(endpoint, str):
            parsed = urlsplit(endpoint)
            path_parts = {part for part in parsed.path.split("/") if part}
            path_parts.update(unquote(part) for part in list(path_parts))
            header_secrets = [secret for secret in header_secrets if secret not in path_parts]
    keep = {"host", "content-length", "user-agent"}
    if entry["clientContractId"] != "client-sui-grpc":
        keep.add("accept")
    return {
        key.lower(): (
            "<redacted>"
            if key.lower() == "authorization"
            or any(secret in value for secret in header_secrets if not secret.isdigit())
            else value
        )
        for key, value in headers.items()
        if key.lower() not in keep
    }


def _independent_credential_variants(values: tuple[str, ...]) -> tuple[str, ...]:
    variants: set[str] = set()
    for value in values:
        if not value:
            continue
        variants.add(value)
        # These are the two URL encodings used by the fixture's direct paths
        # and query values.  They intentionally do not call SDK redaction code.
        from urllib.parse import quote, quote_plus

        variants.add(quote(value, safe="~()*!.'"))
        variants.add(quote_plus(value))
    return tuple(sorted((value for value in variants if value), key=len, reverse=True))


def _independent_percent_pattern(value: str) -> str | None:
    parts: list[str] = []
    has_escape = False
    index = 0
    while index < len(value):
        if (
            value[index] == "%"
            and index + 2 < len(value)
            and all(character in "0123456789abcdefABCDEF" for character in value[index + 1 : index + 3])
        ):
            first, second = value[index + 1 : index + 3]
            parts.append(
                f"%[{first if first.isdigit() else first.lower() + first.upper()}][{second if second.isdigit() else second.lower() + second.upper()}]"
            )
            index += 3
            has_escape = True
            continue
        parts.append(re.escape(value[index]))
        index += 1
    return "".join(parts) if has_escape else None


def _independent_redact_text(value: str, entry: dict[str, Any]) -> str:
    # Source-derived values are the only oracle input.  The replacement token
    # and mixed-case percent matching are deliberately implemented here.
    variants = _independent_credential_variants(_redactions(entry))
    for variant in variants:
        value = value.replace(variant, "[REDACTED]")
    for variant in variants:
        pattern = _independent_percent_pattern(variant)
        if pattern is not None:
            value = re.sub(pattern, "[REDACTED]", value)
    return value


def _independent_redact_value(value: Any, entry: dict[str, Any], depth: int = 0) -> Any:
    if depth >= 32:
        return "[REDACTED]"
    if isinstance(value, str):
        return _independent_redact_text(value, entry)
    if isinstance(value, list):
        return [_independent_redact_value(item, entry, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(_independent_redact_value(item, entry, depth + 1) for item in value)
    if isinstance(value, dict):
        return {
            _independent_redact_text(key, entry) if isinstance(key, str) else key: _independent_redact_value(item, entry, depth + 1)
            for key, item in value.items()
        }
    # Numbers and all other scalar source values retain their native type.
    return value


def _expected_namespace(entry: dict[str, Any]) -> str:
    return {
        "client-bitcoin-rpc": "bitcoin.rpc",
        "client-sui-grpc": "sui.grpc",
        "client-near-rpc": "near.rpc",
        "client-ethereum-rpc": "ethereum.rpc",
        "client-solana-rpc": "solana.rpc",
        "client-avalanche-rpc": "avalanche.rpc",
        "client-base-rpc": "base.rpc",
        "client-arbitrum-rpc": "arbitrum.rpc",
        "client-polygon-rpc": "polygon.rpc",
        "client-bsc-rpc": "bsc.rpc",
        "client-optimism-rpc": "optimism.rpc",
        "client-kaia-rpc": "kaia.rpc",
        "client-soneium-rpc": "soneium.rpc",
        "client-monad-rpc": "monad.rpc",
        "client-hyperliquid-rpc": "hyperliquid.rpc",
        "client-arc-rpc": "arc.rpc",
        "client-robinhood-rpc": "robinhood.rpc",
        "client-tron-rpc": "tron.rpc",
    }[entry["clientContractId"]]


def _error_category(error: BaseException, entry: dict[str, Any]) -> str:
    if isinstance(error, ErpcNotConfiguredError):
        assert error.namespace == _expected_namespace(entry), (
            f"{entry['caseId']} wrong missing namespace {error.namespace!r}"
        )
        return "not-configured"
    if isinstance(error, ErpcAbortedError):
        return "context-cancelled"
    if isinstance(error, ErpcTimeoutError):
        return "timeout"
    if isinstance(error, ErpcTransportError):
        return "transport"
    if isinstance(error, ErpcHttpError):
        expected_status = int(entry["mockExchange"]["response"]["status"])
        assert error.status == expected_status, (
            f"{entry['caseId']} wrong HTTP status {error.status}, expected {expected_status}"
        )
        if entry.get("scheduleId") == "life-redirect-to-second-server":
            assert error.status == 302
            return "http-redirect"
        return "http-status"
    if isinstance(error, ErpcJsonRpcError):
        return "json-rpc"
    if isinstance(error, ErpcInvalidResponseError):
        return "invalid-response"
    if isinstance(error, ErpcError):
        return str(error.code).replace("ERPC_", "").lower()
    raise AssertionError(f"unknown native SDK error: {type(error).__name__}")


def _numeric_tuples(value: Any, path: str = "$.result") -> list[dict[str, Any]]:
    if isinstance(value, Decimal):
        sign, digits, exponent = value.as_tuple()
        digits_list = list(digits)
        while len(digits_list) > 1 and digits_list[-1] == 0:
            digits_list.pop()
            exponent += 1
        coefficient = "".join(str(digit) for digit in digits_list).lstrip("0") or "0"
        return [
            {
                "path": path,
                "sign": -1 if sign else (0 if coefficient == "0" else 1),
                "coefficient": coefficient,
                "exponent10": str(exponent),
            }
        ]
    if isinstance(value, float) and value == value and value not in {float("inf"), float("-inf")}:
        return _numeric_tuples(Decimal(str(value)), path)
    if isinstance(value, int) and not isinstance(value, bool):
        digits = str(abs(value))
        exponent = 0
        while len(digits) > 1 and digits.endswith("0"):
            digits = digits[:-1]
            exponent += 1
        return [
            {
                "path": path,
                "sign": -1 if value < 0 else (0 if value == 0 else 1),
                "coefficient": digits,
                "exponent10": str(exponent),
            }
        ]
    if isinstance(value, list):
        return [
            item
            for index, child in enumerate(value)
            for item in _numeric_tuples(child, f"{path}[{index}]")
        ]
    if isinstance(value, dict):
        return [
            item for key, child in value.items() for item in _numeric_tuples(child, f"{path}.{key}")
        ]
    return []


def _source_error(entry: dict[str, Any], source: dict[str, Any], error: ErpcJsonRpcError) -> None:
    source_error = source.get("error")
    assert isinstance(source_error, dict)
    assert error.rpc_code == source_error["code"]
    source_data = source_error.get("data")
    expected_data = (
        _independent_redact_value(source_data, entry) if source_data is not None else None
    )
    assert _wire_equal(error.data, expected_data), f"{entry['caseId']} actual={error.data!r} expected={expected_data!r}"
    expected_message = _independent_redact_text(str(source_error.get("message", "")), entry)
    assert str(error) == expected_message, (
        f"{entry['caseId']} message mismatch actual={str(error)!r} expected={expected_message!r}"
    )
    for secret in _independent_credential_variants(_redactions(entry)):
        assert secret not in f"{error} {error.data!r}"


def _operation_binding(contract: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    if entry["clientContractId"] == "client-sui-grpc":
        suffix = entry["operation"]["wireOperation"].rsplit("/", 1)[-1]
        return {"publicOperation": {"GetServiceInfo": "get_service_info", "GetObject": "get_object", "GetBalance": "get_balance"}.get(suffix, suffix), "wireOperation": entry["operation"]["wireOperation"], "params": entry["operation"].get("params")}
    client = next(
        item
        for item in contract["clientContracts"]
        if item["clientContractId"] == entry["clientContractId"]
    )
    method_set = next(
        item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"]
    )
    capability = next(
        (
            item
            for item in method_set.get("capabilities", [])
            if item["wireOperation"] == entry["operation"]["wireOperation"]
        ),
        None,
    )
    return {
        "publicOperation": entry["operation"]
        .get("publicOperations", {})
        .get(
            "python",
            capability.get("publicOperation")
            if capability
            else entry["operation"]["publicOperation"],
        ),
        "wireOperation": entry["operation"]["wireOperation"],
        "params": entry["operation"].get("params"),
    }


def _surface_policy(
    contract: dict[str, Any], entry: dict[str, Any], inventory: list[str]
) -> dict[str, Any]:
    client = next(
        item
        for item in contract["clientContracts"]
        if item["clientContractId"] == entry["clientContractId"]
    )
    method_set = next(
        item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"]
    )
    case_id = entry["caseId"]
    operation = entry["operation"].get("publicOperations", {}).get("python", entry["operation"]["publicOperation"])
    forbidden = sorted(client["forbiddenCapabilities"])
    if entry["operation"]["publicOperation"] == "surface":
        if case_id == "c1-sealed-evm-three-method-payloads-and-no-escape-hatches":
            return {"allowed": ["eth_chainId", "eth_getBalance", "eth_call"], "forbidden": ["raw", "request", "batch", "transport", "websocket", "subscription", "sign", "send", "approve", "broadcast", "swap", "bridge"]}
        if case_id == "c4-hyperevm-arc-robinhood-product-scope":
            return {"allowed": ["eth_chainId", "eth_getBalance", "eth_call"], "forbidden": ["hypercore", "info", "nanoreth", "brokerage", "swap", "bridge"]}
        if case_id == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription":
            return {"allowed": ["named-read-methods"], "forbidden": ["raw", "request", "batch", "subscription"]}
        return {"allowed": inventory, "forbidden": forbidden}
    if case_id == "c1-one-attempt-no-redirect-timeout-and-cancellation" or entry.get("scheduleId", "").startswith("life-"):
        return {"allowed": ["timeout", "aborted-or-context-cancelled"], "forbidden": ["redirect-follow", "retry"]}
    if case_id == "c1-unconfigured-namespace-fails-locally-with-zero-io":
        return {"allowed": ["getBlockCount"], "forbidden": []}
    if case_id == "c1-existing-ethereum-solana-avalanche-and-typescript-base-regression":
        return {"allowed": ["legacy-solana-namespace", "explicit-direct-only"], "forbidden": ["hosted-devnet-preset", "network-switch"]}
    if case_id == "c1-path-query-header-and-api-key-redaction":
        return {"allowed": ["credential-safe-errors"], "forbidden": ["credential-leak"]}
    if entry["clientContractId"] == "client-near-rpc":
        return {"allowed": ["status", "block", "view_account"], "forbidden": ["query", "raw", "request", "batch"]}
    if entry["clientContractId"] == "client-sui-grpc":
        if case_id == "c5-sui-binary-limit-descriptor": return {"allowed": ["getServiceInfo"], "forbidden": []}
        if case_id in {"sui-request-bytes-inclusive-case", "sui-request-bytes-over-case", "sui-response-bytes-inclusive-case", "sui-response-bytes-over-case", "sui-trailer-bytes-inclusive-case", "sui-trailer-bytes-over-case"}:
            return {"allowed": ["request-1MiB-inclusive", "response-8MiB-inclusive", "trailer-8KiB-inclusive"], "forbidden": ["request-1MiB-plus-one"]}
        return {"allowed": [entry["operation"]["wireOperation"].rsplit("/", 1)[-1]], "forbidden": ["raw", "request", "bytes", "protobuf", "transport", "batch", "stream", "subscription", "swap", "bridge"]}
    if entry["clientContractId"] == "client-bitcoin-rpc":
        if case_id == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription": return {"allowed": ["named-read-methods"], "forbidden": ["batch", "raw", "request", "subscription"]}
        if case_id in {"c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"}: return {"allowed": ["estimateSmartFee", "getBestBlockHash", "getBlock", "getBlockchainInfo", "getBlockCount", "getBlockHash", "getBlockHeader", "getMempoolInfo", "getNetworkInfo", "getRawMempool", "getRawTransaction", "getTxOut"], "forbidden": ["raw", "request", "batch", "subscription"]}
        if case_id == "c1-direct-bitcoin-exact-target-scoped-header-keyless": return {"allowed": ["getBestBlockHash"], "forbidden": ["raw", "request", "batch", "subscription"]}
        if case_id == "c1-hosted-bitcoin-bearer-no-query-null-error": return {"allowed": ["getBlockchainInfo"], "forbidden": ["raw", "request", "batch", "subscription"]}
        if case_id == "btc-duplicate-escaped-key-last-wins": return {"allowed": ["duplicate-last-wins", "escaped-equivalent-keys"], "forbidden": ["prototype-mutation"]}
        if case_id == "btc-resource-exponent-boundary-and-overflow": return {"allowed": ["bounded-preflight"], "forbidden": ["float-rounding", "unbounded-expansion"]}
        if case_id == "btc-u64-overflow-and-integer-token-rejection": return {"allowed": ["integer-token-check"], "forbidden": ["rounding", "saturation"]}
        if case_id == "btc-u64-maximum-integer-projection": return {"allowed": ["getBlockCount"], "forbidden": []}
        if case_id in {"c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"}: return {"allowed": ["estimateSmartFee", "getBestBlockHash", "getBlock", "getBlockchainInfo", "getBlockCount", "getBlockHash", "getBlockHeader", "getMempoolInfo", "getNetworkInfo", "getRawMempool", "getRawTransaction", "getTxOut"], "forbidden": ["raw", "request", "batch", "subscription"]}
        if case_id.startswith("btc-method-"):
            return {"allowed": [entry["operation"]["wireOperation"]], "forbidden": []}
        if case_id.startswith("btc-u64-"):
            return {"allowed": ["getblockcount"], "forbidden": []}
        if case_id.startswith("btc-explicit-") or case_id.startswith("btc-long-coefficient-"):
            return {"allowed": ["getnetworkinfo"], "forbidden": []}
        if case_id == "c1-path-query-header-and-api-key-redaction":
            return {"allowed": ["credential-safe-errors"], "forbidden": ["credential-leak"]}
        return {"allowed": ["getNetworkInfo"], "forbidden": []}
    if case_id == "c3-mainnet-only-monad-soneium-kaia": return {"allowed": ["mainnet-identity"], "forbidden": ["testnet-relabel", "swap", "bridge"]}
    if case_id == "c1-hosted-base-root-query-auth": return {"allowed": ["eth_chainId", "eth_getBalance", "eth_call"], "forbidden": ["raw", "request", "batch", "websocket", "subscription", "send", "swap", "bridge"]}
    return {"allowed": [entry["operation"]["wireOperation"]], "forbidden": []}


def _actual_capability_names(contract: dict[str, Any], client_id: str) -> dict[str, str]:
    client = next(item for item in contract["clientContracts"] if item["clientContractId"] == client_id)
    method_set = next(item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"])
    return {
        capability["publicOperation"]: capability.get("publicNames", {}).get(
            "python", capability["publicOperation"]
        )
        for capability in method_set.get("capabilities", [])
    }


def _surface_name_to_actual(name: str, names: dict[str, str]) -> str | None:
    if name in names:
        return names[name]
    if name in names.values():
        return name
    # The fixture contains both wire spellings and semantic camel-case names.
    for semantic, actual in names.items():
        if semantic.lower() == name.lower() or semantic.replace("_", "").lower() == name.replace("_", "").lower():
            return actual
        if actual.lower() == name.lower():
            return actual
    return {
        "eth_chainId": "eth_chain_id",
        "eth_getBalance": "eth_get_balance",
        "getServiceInfo": "get_service_info",
        "GetServiceInfo": "get_service_info",
        "getObject": "get_object",
        "GetObject": "get_object",
        "getBalance": "get_balance",
        "GetBalance": "get_balance",
        "getBlockCount": "get_block_count",
        "getNetworkInfo": "get_network_info",
        "getBestBlockHash": "get_best_block_hash",
        "getBlockchainInfo": "get_blockchain_info",
        "getRawMempool": "get_raw_mempool",
        "getRawTransaction": "get_raw_transaction",
        "getTxOut": "get_tx_out",
        "estimateSmartFee": "estimate_smart_fee",
        "getBlock": "get_block",
        "getBlockHash": "get_block_hash",
        "getBlockHeader": "get_block_header",
        "getMempoolInfo": "get_mempool_info",
        "viewAccount": "view_account",
    }.get(name)


def _validate_surface_inventory(
    contract: dict[str, Any], entry: dict[str, Any], inventory: list[str]
) -> None:
    policy = _surface_policy(contract, entry, inventory)
    actual = set(inventory)
    names = _actual_capability_names(contract, entry["clientContractId"])
    client = next(
        item for item in contract["clientContracts"] if item["clientContractId"] == entry["clientContractId"]
    )
    method_set = next(item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"])
    if method_set.get("kind") == "expanded":
        expected_methods = set(names.values())
        assert actual == expected_methods, (
            f"{entry['caseId']} observed surface {sorted(actual)!r} != "
            f"contract methods {sorted(expected_methods)!r}"
        )
    required: set[str] = set()
    if method_set.get("kind") == "expanded":
        for label in policy["allowed"]:
            if label == "named-read-methods":
                required.update(names.values())
                continue
            resolved = _surface_name_to_actual(label, names)
            if resolved is not None:
                required.add(resolved)
    assert required <= actual, (
        f"{entry['caseId']} missing allowed public methods "
        f"{sorted(required - actual)!r}"
    )
    forbidden: set[str] = set()
    for label in policy["forbidden"]:
        resolved = _surface_name_to_actual(label, names)
        if resolved is not None:
            forbidden.add(resolved)
        # Capability escape hatches are intentionally also checked by their
        # literal public Python spelling (raw/request/transport/etc.).
        if label in {"raw", "request", "batch", "transport", "websocket", "subscription", "sign", "send", "approve", "broadcast", "swap", "bridge", "bytes", "protobuf", "stream"}:
            forbidden.add(label)
    leaked = actual & forbidden
    assert not leaked, f"{entry['caseId']} forbidden public surface leaked: {sorted(leaked)!r}"


def _success_label(entry: dict[str, Any], value: Any) -> Any:
    case_id = entry["caseId"]
    if entry["operation"]["publicOperation"] == "surface":
        return (
            "sealed-read3"
            if case_id == "c1-sealed-evm-three-method-payloads-and-no-escape-hatches"
            else "HyperEVM-only"
            if case_id == "c4-hyperevm-arc-robinhood-product-scope"
            else "named-only"
        )
    if entry["clientContractId"] == "client-near-rpc":
        return value
    if case_id.endswith("method-coverage"):
        return "method coverage"
    if case_id == "c1-schedule-immediate-response":
        return "schedule-control"
    if entry["clientContractId"] == "client-sui-grpc":
        if case_id == "sui-framing-sui-data-and-terminal-trailer":
            return "framing-control"
        if case_id.endswith("bytes-inclusive-case"):
            return (
                "response boundary"
                if "response" in case_id
                else "trailer boundary"
                if "trailer" in case_id
                else "response boundary"
            )
        if case_id == "c5-sui-binary-limit-descriptor" or case_id.startswith("sui-golden"):
            return "sui-golden"
    if case_id.startswith("btc-"):
        if "duplicate" in case_id:
            return "last-occurrence-wins"
        if (
            "explicit" in case_id and "inclusive" in case_id
        ) or "long-coefficient-inclusive" in case_id:
            return "exact-number"
        if "maximum-integer" in case_id:
            return str(value)
        if "u64-max-token" in case_id:
            return "exact-number"
        if "numeric-lexeme" in case_id or "prototype" in case_id or "inclusive" in case_id or "chunked-content-length" in case_id:
            return "exact-boundary"
    if case_id == "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values":
        return "exact-json"
    return value


def _error_label(entry: dict[str, Any], category: str) -> str:
    labels = {
        "btc-resource-exponent-boundary-and-overflow": "numeric resource bound exceeded",
        "c1-path-query-header-and-api-key-redaction": "fixture secret was redacted",
        "btc-error-data-lossless-redaction": "approved golden failure",
        "c1-response-id-http-jsonrpc-and-malformed-response-errors": "response identity or envelope is invalid",
        "c1-schedule-first-chunk-cancellation-barrier": "request cancelled after first chunk",
        "c1-schedule-first-chunk-then-delay": "body timed out",
        "c1-schedule-pre-cancel": "request cancelled",
        "c1-schedule-withhold-headers": "request timed out",
        "c1-schedule-reset-after-first-chunk": "connection reset after first chunk",
        "c1-schedule-reset-before-headers": "connection reset before headers",
        "c1-schedule-redirect-to-second-server": "HTTP status 302",
        "c1-unconfigured-namespace-fails-locally-with-zero-io": "bitcoin.rpc is not configured",
        "sui-request-bytes-over-case": "request exceeds 1 MiB",
        "sui-response-bytes-over-case": "response byte limit",
        "sui-trailer-bytes-over-case": "trailer byte limit",
    }
    if entry["caseId"] in labels:
        return labels[entry["caseId"]]
    if entry["caseId"].startswith("sui-framing-"):
        return "invalid-response"
    if category == "invalid-response" and entry["clientContractId"] == "client-bitcoin-rpc":
        return "invalid response bytes"
    if category == "http-status":
        return "HTTP status 302"
    raise AssertionError(f"{entry['caseId']} lacks error policy")


def _numeric_evidence(entry: dict[str, Any], result: Any, error: BaseException | None, source: Any) -> list[dict[str, Any]]:
    case_id = entry["caseId"]
    if case_id in {"btc-u64-maximum-integer-projection", "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values"}:
        return _numeric_tuples(result)
    if case_id in {"btc-error-data-lossless-redaction", "c1-path-query-header-and-api-key-redaction"} and isinstance(error, ErpcJsonRpcError):
        return _numeric_tuples(error.data, "$.error.data")
    if case_id == "btc-resource-exponent-boundary-and-overflow" and isinstance(source, dict):
        return _numeric_tuples(source.get("result", {}).get("atLimit"), "$.result.atLimit")
    if case_id == "btc-u64-overflow-and-integer-token-rejection" and isinstance(source, dict):
        return _numeric_tuples(source.get("result"), "$.result")
    return []


def _run_case(
    fixture: dict[str, Any],
    entry: dict[str, Any],
    materialized: dict[str, bytes],
    server: ThreadingHTTPServer,
    state: _CaptureState,
) -> dict[str, Any]:
    async def inner() -> dict[str, Any]:
        captures: list[dict[str, Any]] = []
        schedule = _schedule(fixture, entry)
        state.entry = entry
        state.response = materialized["response"]
        state.schedule = schedule
        state.warmups = 0
        state.first_chunk.clear()
        state.server_closed.clear()
        timeout = float(schedule.get("timeoutMs", 5000)) / 1000 if schedule else 5.0
        transport = _RemapTransport(server.server_port, state, captures)
        client = ErpcClient(
            _build_config(entry, timeout),
            http_client=httpx.AsyncClient(
                transport=transport, timeout=None, follow_redirects=False
            ),
        )
        surface = _surface(client, entry["clientContractId"])
        endpoint = _assert_endpoint_getter(entry, getattr(surface, "endpoint", None))
        inventory = sorted(
            name for name in dir(surface) if not name.startswith("_") and name != "endpoint"
        )
        result = None
        error = None
        measured_id = (
            int(json.loads(materialized["request"].decode())["id"])
            if entry["mockExchange"]["request"]["bodyEncoding"] == "json"
            else 0
        )
        state.warmups = max(0, measured_id - 1)
        try:
            if entry["operation"]["publicOperation"] not in {"surface", "cancellation"}:
                for _ in range(state.warmups):
                    await _invoke(client, entry)
                if schedule and schedule.get("kind") == "pre-cancel":
                    event = asyncio.Event()
                    event.set()
                    result = await _invoke(client, entry, RequestOptions(cancel_event=event))
                elif schedule and schedule.get("kind") == "first-chunk-cancellation-barrier":
                    event = asyncio.Event()
                    task = asyncio.create_task(
                        _invoke(client, entry, RequestOptions(cancel_event=event))
                    )
                    await asyncio.to_thread(state.first_chunk.wait, 2.0)
                    event.set()
                    result = await task
                else:
                    result = await _invoke(client, entry)
        except BaseException as caught:
            error = caught
        finally:
            await client.close()
            await transport.aclose()
        return {
            "surface": inventory,
            "endpoint": endpoint,
            "result": result,
            "error": error,
            "captures": captures,
            "measured": [item for item in captures if item["phase"] == "measured"],
        }

    return asyncio.run(inner())


def _assert_wire(
    entry: dict[str, Any], run: dict[str, Any], materialized: dict[str, bytes]
) -> None:
    measured = run["measured"]
    no_io = (
        entry["operation"]["publicOperation"] in {"surface", "cancellation"}
        or entry["setup"]["mode"] == "unconfigured"
        or entry["caseId"] == "sui-request-bytes-over-case"
        or entry.get("scheduleId") == "life-pre-cancel"
    )
    assert len(measured) == (0 if no_io else 1), (
        f"{entry['caseId']} measured I/O count {len(measured)}"
    )
    if no_io:
        return
    capture = measured[0]
    expected = entry["mockExchange"]["request"]
    assert capture["method"] == expected["method"]
    assert capture["url"] == expected["target"]
    if "responseStatus" in capture:
        assert capture["responseStatus"] == int(entry["mockExchange"]["response"]["status"])
    expected_headers = {key.lower(): value for key, value in expected.get("headers", {}).items()}
    actual_headers = {key.lower(): value for key, value in capture["headers"].items()}
    for key, value in expected_headers.items():
        assert actual_headers.get(key) == value, f"{entry['caseId']} header {key} mismatch"
    for key in actual_headers:
        assert key in expected_headers or key in {
            "accept",
            "host",
            "content-length",
            "user-agent",
            "x-grpc-web",
        }, f"{entry['caseId']} exposed header {key}"
    assert (
        (
            _sha256(_lossless_json_bytes(capture["body"]))
            == _sha256(_lossless_json_bytes(materialized["request"]))
        )
        if expected["bodyEncoding"] == "json"
        else (capture["body"] == materialized["request"])
    )


def _behavior(
    fixture: dict[str, Any],
    contract: dict[str, Any],
    entry: dict[str, Any],
    run: dict[str, Any],
    materialized: dict[str, bytes],
) -> dict[str, Any]:
    error = run["error"]
    result = run["result"]
    source = None
    if entry["clientContractId"] != "client-sui-grpc" and (
        error is None
        or isinstance(error, ErpcJsonRpcError)
        or entry["caseId"] in {"btc-resource-exponent-boundary-and-overflow", "btc-u64-overflow-and-integer-token-rejection"}
    ):
        source = json.loads(
            materialized["response"].decode("utf-8"),
            parse_int=int,
            parse_float=Decimal
            if entry["clientContractId"] in {"client-bitcoin-rpc", "client-near-rpc"}
            else float,
        )
    if error is not None:
        category = _error_category(error, entry)
        if isinstance(error, ErpcHttpError):
            assert run["measured"] and run["measured"][0]["responseStatus"] == error.status
        assert category == entry["expected"]["outcome"].get("category"), (
            f"{entry['caseId']} category mismatch"
        )
        if isinstance(error, ErpcJsonRpcError):
            _source_error(entry, source, error)
        outcome = {"kind": "error", "category": category, "message": _error_label(entry, category)}
    elif entry["operation"]["publicOperation"] in {"surface", "cancellation"}:
        outcome = {
            "kind": "not-applicable"
            if entry["caseId"] == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription"
            else "success"
            if entry["operation"]["publicOperation"] == "surface"
            else "not-applicable",
            "value": _success_label(entry, result),
        }
    else:
        if entry["clientContractId"] == "client-near-rpc":
            actual_wire = _near_wire(entry["operation"]["publicOperation"], result)
            assert _wire_equal(actual_wire, source["result"])
            result_value = actual_wire
        elif entry["clientContractId"] == "client-sui-grpc":
            result_value = _assert_sui_wire_matches_raw(
                entry["operation"]["publicOperation"], result, materialized["response"]
            )
        else:
            assert _wire_equal(result, source["result"])
            result_value = result
        outcome = {"kind": "success", "value": _success_label(entry, result_value)}
    capture = run["measured"][0] if run["measured"] else None
    if capture is None:
        raw_recipe_hash = _sha256(materialized["request"])
        trace = {
            "method": "NONE",
            "target": "NO_IO",
            "headers": {},
            "bodySha256": "0" * 64
            if entry["caseId"] in {"c1-schedule-pre-cancel", "sui-request-bytes-over-case"}
            else raw_recipe_hash,
            "attempts": 0,
            "ioKind": "none",
        }
    else:
        trace = {
            "method": "POST",
            "target": _redact_url(capture["url"], entry),
            "headers": _redact_headers(capture["headers"], entry),
            "bodySha256": _sha256(_lossless_json_bytes(capture["body"]))
            if entry["mockExchange"]["request"]["bodyEncoding"] == "json"
            else _sha256(capture["body"]),
            "attempts": 1,
            "ioKind": "performed",
        }
    binary = (
        {
            "encoding": "hex",
            "decodedLength": len(materialized["response"]),
            "sha256": _sha256(materialized["response"]),
        }
        if entry["clientContractId"] == "client-sui-grpc" and capture is not None
        else None
    )
    if binary is not None and entry["expected"].get("binary") is not None:
        assert binary == entry["expected"]["binary"]
    _validate_surface_inventory(contract, entry, run["surface"])
    endpoint_diagnostic = ""
    if capture is not None:
        endpoint_diagnostic = _endpoint_origin(run["endpoint"])
    elif entry["caseId"] == "c1-schedule-pre-cancel":
        endpoint_diagnostic = _endpoint_origin(run["endpoint"])
    return {
        "outcome": outcome,
        "trace": trace,
        "endpointDiagnostic": endpoint_diagnostic
        if entry["operation"]["publicOperation"] not in {"surface", "cancellation"}
        else "",
        "ioCount": len(run["measured"]),
        "surface": _surface_policy(contract, entry, run["surface"]),
        "numericTuples": _numeric_evidence(entry, result, error, source),
        "binary": binary,
        "operation": _operation_binding(contract, entry),
        "caseKind": entry["caseKind"],
        "exceptionIds": sorted(entry.get("exceptionIds", [])),
    }


def _capture_output_path() -> str | None:
    value = os.environ.get("ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT")
    return value if value else None


def _build_coverage(
    contract: dict[str, Any], fixture: dict[str, Any], scope: dict[str, Any], completed: set[str]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for network_id in scope["networkIds"]:
        network = next(item for item in contract["networks"] if item["networkId"] == network_id)
        client = next(item for item in contract["clientContracts"] if item["clientContractId"] == network["clientContractId"])
        method_set = next(item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"])
        rows.append({
            "networkId": network_id,
            "clientContractId": client["clientContractId"],
            "namespace": client["namespace"],
            "methodSetDigest": _sha256(_stable_json(method_set).encode()),
            "routePolicyIds": sorted(mode["transportProfileId"] for mode in client["endpointModes"]),
            "portableCasesExecuted": any(
                item["networkId"] == network_id and item["caseId"] in completed
                for item in fixture["cases"]
            ),
        })
    return rows


def _assert_coverage_complete(rows: list[dict[str, Any]], completed: set[str]) -> None:
    assert completed, "native capture completed no applicable cases"
    missing = [row["networkId"] for row in rows if not row["portableCasesExecuted"]]
    assert not missing, f"native capture missed applicable network cases: {missing!r}"


def _build_surface(
    contract: dict[str, Any], scope: dict[str, Any], observed: dict[str, list[str]]
) -> list[dict[str, Any]]:
    client_ids = sorted({
        next(item for item in contract["networks"] if item["networkId"] == network_id)["clientContractId"]
        for network_id in scope["networkIds"]
    })
    rows: list[dict[str, Any]] = []
    for client_id in client_ids:
        assert client_id in observed, f"native capture has no surface inventory for {client_id}"
        inventory = observed[client_id]
        representative = next(
            item
            for item in _CAPTURE_FIXTURE.get("cases", [])
            if item["clientContractId"] == client_id and "python" in item.get("applicability", [])
        )
        _validate_surface_inventory(contract, representative, inventory)
        client = next(item for item in contract["clientContracts"] if item["clientContractId"] == client_id)
        method_set = next(item for item in contract["methodSets"] if item["methodSetId"] == client["methodSetId"])
        allowed = (
            [capability["publicNames"].get("python", capability["publicOperation"]) for capability in method_set["capabilities"]]
            if method_set.get("kind") == "expanded"
            else ["legacy-reference"]
        )
        rows.append({"clientContractId": client_id, "allowed": allowed, "forbidden": sorted(client["forbiddenCapabilities"])})
    return rows


def _snapshot_payload_sha256(snapshot: dict[str, Any]) -> str:
    payload = {key: snapshot[key] for key in ("snapshotVersion", "snapshotKind", "language", "runtime", "contractVersion", "contractDigest", "fixtureDigest", "scope", "coverage", "behavior", "surface")}
    payload["scope"] = {**payload["scope"], "cohortIds": sorted(payload["scope"]["cohortIds"]), "networkIds": sorted(payload["scope"]["networkIds"])}
    payload["coverage"] = [
        {**row, "routePolicyIds": sorted(row["routePolicyIds"])}
        for row in sorted(payload["coverage"], key=lambda row: row["networkId"])
    ]
    payload["behavior"] = {key: payload["behavior"][key] for key in sorted(payload["behavior"])}
    payload["surface"] = [
        {**row, "forbidden": sorted(row["forbidden"])}
        for row in sorted(payload["surface"], key=lambda row: row["clientContractId"])
    ]
    return _sha256(_stable_json(payload).encode())


def _run_sui_supplementals(
    fixture: dict[str, Any], materialized: dict[str, dict[str, bytes]], server: ThreadingHTTPServer, state: _CaptureState
) -> list[dict[str, Any]]:
    source_cases = {
        "sui-get-object-embedded-depth100": "sui-golden-object-absent",
        "sui-get-object-embedded-depth101": "sui-golden-object-absent",
        "sui-get-service-info-timestamp-merge-final-zero": "sui-golden-service-info",
        "sui-get-service-info-timestamp-merge-final-invalid": "sui-golden-service-info",
    }

    async def one(golden_id: str, case_id: str) -> dict[str, Any]:
        import copy

        entry = copy.deepcopy(next(item for item in fixture["cases"] if item["caseId"] == source_cases[golden_id]))
        entry["caseId"] = f"supplemental:{golden_id}"
        entry["operation"] = copy.deepcopy(entry["operation"])
        if "object" in golden_id:
            entry["operation"]["publicOperation"] = "getObject"
        else:
            entry["operation"]["publicOperation"] = "getServiceInfo"
        entry["mockExchange"]["request"]["target"] = entry["setup"]["endpoint"] + "/sui.rpc.v2.LedgerService/" + ("GetObject" if "object" in golden_id else "GetServiceInfo")
        entry["mockExchange"]["response"]["headers"] = {"content-type": "application/grpc-web+proto"}
        state.entry = entry
        state.response = materialized[f"sui:{golden_id}"]["response"]
        state.schedule = None
        state.warmups = 0
        state.first_chunk.clear()
        state.server_closed.clear()
        captures: list[dict[str, Any]] = []
        transport = _RemapTransport(server.server_port, state, captures)
        client = ErpcClient(_build_config(entry, 5.0), http_client=httpx.AsyncClient(transport=transport, timeout=None, follow_redirects=False))
        value: Any = None
        error: BaseException | None = None
        try:
            if "object" in golden_id:
                value = await client.sui.grpc.get_object("0x2").send()
            else:
                value = await client.sui.grpc.get_service_info().send()
        except BaseException as caught:
            error = caught
        finally:
            await client.close()
            await transport.aclose()
        if golden_id.endswith("depth100"):
            assert error is None
            raw_value = _sui_raw_wire("getObject", materialized[f"sui:{golden_id}"]["response"])
            assert _sui_object_nesting_depth(materialized[f"sui:{golden_id}"]["response"]) == 100
            assert _sui_wire("getObject", value) == raw_value == {
                "objectId": "",
                "version": 0,
                "digest": "",
            }
        elif golden_id.endswith("depth101"):
            assert _sui_object_nesting_depth(materialized[f"sui:{golden_id}"]["response"]) == 101
            assert isinstance(error, ErpcInvalidResponseError)
            assert error.__context__ is None and error.__cause__ is None
        elif golden_id.endswith("final-zero"):
            assert error is None
            raw_value = _sui_raw_wire("getServiceInfo", materialized[f"sui:{golden_id}"]["response"])
            assert _sui_wire("getServiceInfo", value) == raw_value == {
                "chainId": "chain",
                "chain": "mainnet",
                "epoch": 0,
                "checkpoint": 0,
                "timestampSeconds": 42,
                "timestampNanos": 0,
                "lowestCheckpoint": 0,
                "lowestVerifiedCheckpoint": 0,
            }
        else:
            raw_value = _sui_raw_wire("getServiceInfo", materialized[f"sui:{golden_id}"]["response"])
            assert raw_value["timestampNanos"] == 1_000_000_000
            assert isinstance(error, ErpcInvalidResponseError)
            assert error.__context__ is None and error.__cause__ is None
        request = captures[0]
        assert request["body"] == materialized[f"sui:{golden_id}"]["request"]
        return {
            "goldenId": golden_id,
            "requestUrl": request["url"],
            "requestBodyBase64": base64.b64encode(request["body"]).decode(),
            "requestBodySha256": _sha256(request["body"]),
            "responseBodyBase64": base64.b64encode(materialized[f"sui:{golden_id}"]["response"]).decode(),
            "responseBodyLength": len(materialized[f"sui:{golden_id}"]["response"]),
            "responseBodySha256": _sha256(materialized[f"sui:{golden_id}"]["response"]),
            "result": None if error else _sui_wire(entry["operation"]["publicOperation"], value),
            "error": None if error is None else {"type": type(error).__name__, "category": _error_category(error, entry)},
        }

    async def all_vectors() -> list[dict[str, Any]]:
        return [await one(golden_id, case_id) for golden_id, case_id in source_cases.items()]

    return asyncio.run(all_vectors())


def _run_gated_capture() -> None:
    output = _capture_output_path()
    if output is None:
        pytest.skip("native capture is gated; set ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT")
    manifest_path = os.environ.get("ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST")
    assert manifest_path, "ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST is required"
    fixture, contract, materialized = _read_fixture()
    _CAPTURE_FIXTURE.clear()
    _CAPTURE_FIXTURE.update(fixture)
    assert contract["contentDigest"] == _FINAL_CONTRACT_DIGEST
    assert fixture["fixtureDigest"] == _FINAL_FIXTURE_DIGEST
    entries = sorted(
        (entry for entry in fixture["cases"] if "python" in entry["applicability"]),
        key=lambda item: item["caseId"],
    )
    assert len(entries) == 121
    state = _CaptureState()
    _CaptureHandler.state = state
    server = ThreadingHTTPServer(("127.0.0.1", 0), _CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    behavior: dict[str, Any] = {}
    raw: list[dict[str, Any]] = []
    completed: set[str] = set()
    observed_surfaces: dict[str, list[str]] = {}
    supplemental: list[dict[str, Any]] = []
    try:
        for entry in entries:
            run = _run_case(fixture, entry, materialized[entry["caseId"]], server, state)
            _assert_wire(entry, run, materialized[entry["caseId"]])
            behavior[entry["caseId"]] = _behavior(
                fixture, contract, entry, run, materialized[entry["caseId"]]
            )
            prior_inventory = observed_surfaces.setdefault(entry["clientContractId"], run["surface"])
            assert prior_inventory == run["surface"], (
                f"{entry['clientContractId']} public inventory changed during capture"
            )
            completed.add(entry["caseId"])
            raw.append(
                {
                    "caseId": entry["caseId"],
                    "captures": [
                        {
                            "phase": c["phase"],
                            "url": c["url"],
                            "headers": _redact_headers(c["headers"], entry),
                            "responseStatus": c.get("responseStatus"),
                            "bodyBase64": base64.b64encode(c["body"]).decode(),
                            "bodySha256": _sha256(c["body"]),
                        }
                        for c in run["captures"]
                    ],
                    "responseBodyBase64": (
                        base64.b64encode(materialized[entry["caseId"]]["response"]).decode()
                        if len(materialized[entry["caseId"]]["response"]) <= 65536
                        else None
                    ),
                    "responseBodyLength": len(materialized[entry["caseId"]]["response"]),
                    "responseBodySha256": _sha256(materialized[entry["caseId"]]["response"]),
                    "actualResult": None if run["error"] else repr(run["result"]),
                    "actualError": None
                    if not run["error"]
                    else {
                        "type": type(run["error"]).__name__,
                        "category": _error_category(run["error"], entry),
                        "rpcCode": getattr(run["error"], "rpc_code", None),
                        "data": repr(getattr(run["error"], "data", None)),
                    },
                }
            )
        supplemental = _run_sui_supplementals(fixture, materialized, server, state)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    scope = {
        "mode": "through-cohort",
        "throughCohort": 5,
        "cohortIds": [0, 1, 2, 3, 4, 5],
        "networkIds": sorted(
            item["networkId"] for item in contract["networks"] if item["cohort"] <= 5
        ),
    }
    snapshot = {
        "snapshotVersion": 1,
        "snapshotKind": "rpc-network-native-runtime",
        "language": "python",
        "runtime": f"python-source-capture {sys.version.split()[0]}",
        "contractVersion": contract["contractVersion"],
        "contractDigest": contract["contentDigest"],
        "fixtureDigest": fixture["fixtureDigest"],
        "scope": scope,
        "coverage": _build_coverage(contract, fixture, scope, completed),
        "behavior": behavior,
        "surface": _build_surface(contract, scope, observed_surfaces),
    }
    _assert_coverage_complete(snapshot["coverage"], completed)
    source_hash = _sha256(Path(manifest_path).read_bytes())
    payload_sha256 = _snapshot_payload_sha256(snapshot)
    evidence = {
        "kind": "native-capture-v1",
        "command": "pytest -q packages/python/tests/test_rpc_network_contract.py -k native_capture",
        "exitCode": 0,
        "sourceIdentity": {
            "kind": "frozen-source-manifest-v1",
            "version": "0.11.0",
            "sourceManifestSha256": source_hash,
        },
        "consumer": {
            "command": "Python source harness with controlled local HTTP server",
            "exitCode": 0,
            "status": "success",
        },
        "capture": {
            "command": "Python source harness with ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT",
            "exitCode": 0,
            "snapshotSha256": payload_sha256,
            "networkCount": len(scope["networkIds"]),
            "caseCount": len(entries),
        },
        "snapshotSha256": payload_sha256,
    }
    snapshot["evidence"] = evidence
    Path(output).write_text(json.dumps(snapshot, indent=2) + "\n")
    Path(output + ".raw.json").write_text(json.dumps(raw, indent=2, default=str) + "\n")
    Path(output + ".supplemental-sui.json").write_text(json.dumps({
        "kind": "native-supplemental-sui-v1",
        "vectors": supplemental,
    }, indent=2) + "\n")


def test_bootstrap_units_select_only_accepted_a_facts() -> None:
    contract = json.loads(_CONTRACT.read_text())
    assert contract["contentDigest"] == _FINAL_CONTRACT_DIGEST
    assert RPC_NETWORK_CONTRACT_DIGEST == _FINAL_CONTRACT_DIGEST


def test_private_projection_binds_public_python_facts() -> None:
    generated_path = (
        _ROOT / "packages" / "python" / "src" / "erpc_sdk" / "_rpc_network_contract_data.py"
    )
    assert (
        hashlib.sha256(generated_path.read_bytes()).hexdigest()
        == "6ecff4d528c7e974943ebb7471d8a6869c44e6f6a02bcc10c125928132dd4aef"
    )


def test_native_capture_sabotage_controls() -> None:
    """The native evidence gate must reject poisoned actual observations."""
    fixture, contract, materialized = _read_fixture()
    _CAPTURE_FIXTURE.clear()
    _CAPTURE_FIXTURE.update(fixture)

    redirect = next(item for item in fixture["cases"] if item["caseId"] == "c1-schedule-redirect-to-second-server")
    with pytest.raises(AssertionError):
        _error_category(RuntimeError("unrecognized native failure"), redirect)
    with pytest.raises(AssertionError):
        _error_category(ErpcHttpError(418), redirect)

    unconfigured = next(
        item
        for item in fixture["cases"]
        if item["caseId"] == "c1-unconfigured-namespace-fails-locally-with-zero-io"
    )
    with pytest.raises(AssertionError):
        _error_category(ErpcNotConfiguredError("sui.grpc"), unconfigured)

    endpoint_case = next(item for item in fixture["cases"] if item["caseId"] == "sui-golden-object-zero")
    with pytest.raises(AssertionError):
        _assert_endpoint_getter(
            endpoint_case,
            "https://sui.erpc.global/REVIEW-LEAK?secret=REVIEW-LEAK",
        )

    sui_names = _actual_capability_names(contract, "client-sui-grpc")
    inventory = sorted(sui_names.values())
    _validate_surface_inventory(contract, endpoint_case, inventory)
    with pytest.raises(AssertionError):
        _validate_surface_inventory(contract, endpoint_case, [name for name in inventory if name != "get_object"])
    with pytest.raises(AssertionError):
        _validate_surface_inventory(contract, endpoint_case, inventory + ["raw"])

    scope = {
        "networkIds": sorted(
            item["networkId"] for item in contract["networks"] if item["cohort"] <= 5
        )
    }
    incomplete = _build_coverage(contract, fixture, scope, set())
    with pytest.raises(AssertionError):
        _assert_coverage_complete(incomplete, set())

    redact_case = next(
        item
        for item in fixture["cases"]
        if item["caseId"] == "c1-path-query-header-and-api-key-redaction"
    )
    redacted = _independent_redact_value(
        {
            "%66oo": "fixture-secret",
            "nested": {"decodedPath": "foo", "value": "Bearer fixture-secret"},
            "count": 7,
        },
        redact_case,
    )
    assert redacted == {
        "[REDACTED]": "[REDACTED]",
        "nested": {"decodedPath": "[REDACTED]", "value": "[REDACTED]"},
        "count": 7,
    }
    encoded_case = next(item for item in fixture["cases"] if item["caseId"] == "base-eth-call-method-coverage")
    assert _independent_redact_text("custom%2fpath", encoded_case) == "[REDACTED]"

    object_response = materialized["sui-golden-object-zero"]["response"]
    object_raw = _sui_raw_wire("getObject", object_response)
    object_value = SimpleNamespace(
        object_id=object_raw["objectId"], version=object_raw["version"], digest=object_raw["digest"]
    )
    _assert_sui_wire_matches_raw("getObject", object_value, object_response)
    for field in ("object_id", "version", "digest"):
        poisoned = vars(object_value).copy()
        poisoned[field] = "WRONG" if field != "version" else 999
        with pytest.raises(AssertionError):
            _assert_sui_wire_matches_raw("getObject", SimpleNamespace(**poisoned), object_response)

    balance_response = materialized["sui-golden-balance"]["response"]
    balance_raw = _sui_raw_wire("getBalance", balance_response)
    balance_value = SimpleNamespace(
        coin_type=balance_raw["coinType"],
        balance=balance_raw["balance"],
        address_balance=balance_raw["addressBalance"],
        coin_balance=balance_raw["coinBalance"],
    )
    _assert_sui_wire_matches_raw("getBalance", balance_value, balance_response)
    for field in ("coin_type", "balance", "address_balance", "coin_balance"):
        poisoned = vars(balance_value).copy()
        poisoned[field] = "WRONG" if field == "coin_type" else poisoned[field] + 1
        with pytest.raises(AssertionError):
            _assert_sui_wire_matches_raw("getBalance", SimpleNamespace(**poisoned), balance_response)

    service_response = materialized["sui-golden-service-info"]["response"]
    service_raw = _sui_raw_wire("getServiceInfo", service_response)
    service_value = SimpleNamespace(
        chain_id=service_raw["chainId"],
        chain=service_raw["chain"],
        epoch=service_raw["epoch"],
        checkpoint_height=service_raw["checkpoint"],
        timestamp_seconds=service_raw["timestampSeconds"],
        timestamp_nanos=service_raw["timestampNanos"],
        lowest_available_checkpoint=service_raw["lowestCheckpoint"],
        lowest_available_checkpoint_objects=service_raw["lowestVerifiedCheckpoint"],
        server=service_raw.get("server"),
    )
    _assert_sui_wire_matches_raw("getServiceInfo", service_value, service_response)
    for field in ("timestamp_seconds", "timestamp_nanos", "server"):
        poisoned = vars(service_value).copy()
        poisoned[field] = 999 if field != "server" else None
        with pytest.raises(AssertionError):
            _assert_sui_wire_matches_raw("getServiceInfo", SimpleNamespace(**poisoned), service_response)


def test_native_capture_is_explicitly_gated() -> None:
    _run_gated_capture()
