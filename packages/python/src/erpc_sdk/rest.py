"""Typed account, usage, price, SSE, and Cloud read clients."""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import datetime
from typing import cast
from urllib.parse import quote

from .errors import ErpcAbortedError, ErpcConfigError, ErpcInvalidResponseError
from .transport import QueryValue, RestTransport
from .types import (
    DEFAULT_REQUEST_OPTIONS,
    CloudCredit,
    CloudOffering,
    CloudResource,
    CloudResourceStatus,
    JsonValue,
    MonthlyApiKeyUsage,
    PriceFeedMetadata,
    PriceStreamEvent,
    PriceUpdateResponse,
    RequestOptions,
    TokenBalance,
)

_YEAR_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_RESOURCE_KINDS = {"bare-metal", "solana-grpc", "solana-shredstream", "vps"}
_RESOURCE_MODES = {"dedicated", "direct", "shared"}
_BILLING_STATUSES = {"active", "grace-period", "inactive", "suspended"}
_ALERT_LEVELS = {"critical", "normal", "suspended", "warning"}


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ErpcInvalidResponseError()
    return cast(dict[str, object], value)


def _string(value: object) -> str:
    if not isinstance(value, str):
        raise ErpcInvalidResponseError()
    return value


def _number(value: object, *, integer: bool = False, nonnegative: bool = False) -> int | float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ErpcInvalidResponseError()
    if integer and not isinstance(value, int):
        raise ErpcInvalidResponseError()
    if nonnegative and value < 0:
        raise ErpcInvalidResponseError()
    return value


def _datetime(value: object) -> str:
    text = _string(value)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ErpcInvalidResponseError() from error
    return text


class AccountClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def get_token_balance(
        self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS
    ) -> TokenBalance:
        value = await self._transport.get("/v3/erpc/token-balance", options=options)
        data = _mapping(value)
        if data.get("plan") not in {"business", "developer", "free", "pro"}:
            raise ErpcInvalidResponseError("ERPC returned an invalid token balance")
        _number(data.get("max_tokens"), integer=True)
        _number(data.get("remaining_tokens"), integer=True)
        if data.get("next_refill_at") is not None:
            _string(data.get("next_refill_at"))
        return cast(TokenBalance, data)


class UsageClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def get_monthly_api_key_usage(
        self,
        year_month: str | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> MonthlyApiKeyUsage:
        if year_month is not None and not _YEAR_MONTH.fullmatch(year_month):
            raise ErpcConfigError("year_month must use YYYY-MM format")
        value = await self._transport.get(
            "/v3/user/api-keys/usage", {"yearMonth": year_month}, options
        )
        envelope = _mapping(value)
        if envelope.get("success") is not True:
            raise ErpcInvalidResponseError(
                "ERPC returned an invalid monthly API key usage response"
            )
        usage = _mapping(envelope.get("message"))
        try:
            year = _string(usage.get("yearMonth"))
            if not _YEAR_MONTH.fullmatch(year):
                raise ErpcInvalidResponseError()
            for field in ("keyCount", "totalCount", "totalCredits"):
                _number(usage.get(field))
            if not isinstance(usage.get("hasStrandedUsage"), bool):
                raise ErpcInvalidResponseError()
            if usage.get("updatedAt") is not None:
                _string(usage.get("updatedAt"))
            self._validate_chains(usage.get("chains"))
            api_keys = usage.get("apiKeys")
            if not isinstance(api_keys, list):
                raise ErpcInvalidResponseError()
            for value in api_keys:
                item = _mapping(value)
                _string(item.get("apiKeyLast4"))
                for field in ("apiKeyLength", "count", "credits"):
                    _number(item.get(field))
                if item.get("keyId") is not None:
                    _number(item.get("keyId"))
                if item.get("updatedAt") is not None:
                    _string(item.get("updatedAt"))
                self._validate_chains(item.get("chains"))
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError(
                "ERPC returned an invalid monthly API key usage response"
            ) from error
        return cast(MonthlyApiKeyUsage, usage)

    @staticmethod
    def _validate_chains(value: object) -> None:
        if not isinstance(value, list):
            raise ErpcInvalidResponseError()
        for raw_chain in value:
            chain = _mapping(raw_chain)
            _string(chain.get("chain"))
            _number(chain.get("count"))
            _number(chain.get("credits"))
            if chain.get("updatedAt") is not None:
                _string(chain.get("updatedAt"))
            methods = chain.get("methods")
            if not isinstance(methods, list):
                raise ErpcInvalidResponseError()
            for raw_method in methods:
                method = _mapping(raw_method)
                _string(method.get("method"))
                for field in ("count", "creditCost", "credits"):
                    _number(method.get(field))
                if method.get("updatedAt") is not None:
                    _string(method.get("updatedAt"))


class PriceClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def get_price_feeds(
        self,
        *,
        asset_type: str | None = None,
        query: str | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> list[PriceFeedMetadata]:
        value = await self._transport.get(
            "/v2/price_feeds", {"query": query, "asset_type": asset_type}, options
        )
        if not isinstance(value, list):
            raise ErpcInvalidResponseError("ERPC returned invalid price feed metadata")
        for item in value:
            metadata = _mapping(item)
            _string(metadata.get("id"))
            attributes = metadata.get("attributes")
            if attributes is not None and (
                not isinstance(attributes, dict)
                or not all(
                    isinstance(key, str) and isinstance(entry, str)
                    for key, entry in attributes.items()
                )
            ):
                raise ErpcInvalidResponseError("ERPC returned invalid price feed metadata")
        return cast(list[PriceFeedMetadata], value)

    async def get_latest_price_updates(
        self,
        ids: Sequence[str],
        *,
        encoding: str | None = None,
        parsed: bool | None = None,
        ignore_invalid_price_ids: bool | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> PriceUpdateResponse:
        value = await self._transport.get(
            "/v2/updates/price/latest",
            self._update_query(ids, encoding, parsed, ignore_invalid_price_ids),
            options,
        )
        return self._price_update(value)

    async def get_price_updates_at_timestamp(
        self,
        publish_time: int | str,
        ids: Sequence[str],
        *,
        encoding: str | None = None,
        parsed: bool | None = None,
        ignore_invalid_price_ids: bool | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> PriceUpdateResponse:
        value = await self._transport.get(
            f"/v2/updates/price/{quote(str(publish_time), safe='')}",
            self._update_query(ids, encoding, parsed, ignore_invalid_price_ids),
            options,
        )
        return self._price_update(value)

    async def get_latest_publisher_stake_caps(
        self,
        *,
        encoding: str | None = None,
        parsed: bool | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> dict[str, JsonValue]:
        value = await self._transport.get(
            "/v2/updates/publisher_stake_caps/latest",
            {"encoding": encoding, "parsed": parsed},
            options,
        )
        return cast(dict[str, JsonValue], _mapping(value))

    async def stream_price_updates(
        self,
        ids: Sequence[str],
        *,
        encoding: str | None = None,
        parsed: bool | None = None,
        ignore_invalid_price_ids: bool | None = None,
        allow_unordered: bool | None = None,
        benchmarks_only: bool | None = None,
        options: RequestOptions = DEFAULT_REQUEST_OPTIONS,
    ) -> AsyncIterator[PriceStreamEvent]:
        query = {
            **self._update_query(ids, encoding, parsed, ignore_invalid_price_ids),
            "allow_unordered": allow_unordered,
            "benchmarks_only": benchmarks_only,
        }
        async with self._transport.stream("/v2/updates/price/stream", query, options) as response:
            buffer = ""
            iterator = response.aiter_text().__aiter__()
            while True:
                try:
                    chunk = await self._next_chunk(iterator, options.cancel_event)
                except StopAsyncIteration:
                    break
                buffer += chunk
                while match := re.search(r"\r?\n\r?\n", buffer):
                    block, buffer = buffer[: match.start()], buffer[match.end() :]
                    event = self._parse_sse_block(block)
                    if event is not None:
                        yield event
            event = self._parse_sse_block(buffer)
            if event is not None:
                yield event

    @staticmethod
    async def _next_chunk(iterator: AsyncIterator[str], cancel_event: asyncio.Event | None) -> str:
        chunk_task: asyncio.Future[str] = asyncio.ensure_future(anext(iterator))
        if cancel_event is None:
            return await chunk_task
        if cancel_event.is_set():
            chunk_task.cancel()
            raise ErpcAbortedError

        async def abort() -> str:
            await cancel_event.wait()
            raise ErpcAbortedError

        cancel_task = asyncio.create_task(abort())
        done, _ = await asyncio.wait({chunk_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
        if cancel_task in done:
            chunk_task.cancel()
            await asyncio.gather(chunk_task, return_exceptions=True)
            return await cancel_task
        cancel_task.cancel()
        return await chunk_task

    @staticmethod
    def _update_query(
        ids: Sequence[str],
        encoding: str | None,
        parsed: bool | None,
        ignore_invalid_price_ids: bool | None,
    ) -> Mapping[str, QueryValue]:
        return {
            "ids[]": ids,
            "encoding": encoding,
            "parsed": parsed,
            "ignore_invalid_price_ids": ignore_invalid_price_ids,
        }

    @staticmethod
    def _price_update(value: object) -> PriceUpdateResponse:
        update = _mapping(value)
        binary = _mapping(update.get("binary"))
        data = binary.get("data")
        if (
            not isinstance(data, list)
            or not all(isinstance(item, str) for item in data)
            or not isinstance(binary.get("encoding"), str)
            or ("parsed" in update and not isinstance(update["parsed"], list))
        ):
            raise ErpcInvalidResponseError("ERPC returned an invalid price update")
        return cast(PriceUpdateResponse, update)

    @classmethod
    def _parse_sse_block(cls, block: str) -> PriceStreamEvent | None:
        data: list[str] = []
        result: dict[str, object] = {}
        for line in block.splitlines():
            if not line or line.startswith(":"):
                continue
            field, separator, raw = line.partition(":")
            value = raw[1:] if separator and raw.startswith(" ") else raw
            if field == "data":
                data.append(value)
            elif field in {"event", "id"}:
                result[field] = value
        if not data:
            return None
        try:
            result["data"] = cls._price_update(json.loads("\n".join(data)))
        except (ValueError, ErpcInvalidResponseError) as error:
            raise ErpcInvalidResponseError("ERPC returned malformed stream data") from error
        return cast(PriceStreamEvent, result)


class CloudCatalogClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def list(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> list[CloudOffering]:
        value = await self._transport.get("/v4/cloud/catalog", options=options)
        try:
            envelope = _mapping(value)
            message = _mapping(envelope.get("message"))
            offerings = message.get("offerings")
            if envelope.get("success") is not True or not isinstance(offerings, list):
                raise ErpcInvalidResponseError()
            for raw in offerings:
                item = _mapping(raw)
                for field in ("id", "name", "description"):
                    _string(item.get(field))
                if item.get("kind") not in _RESOURCE_KINDS:
                    raise ErpcInvalidResponseError()
                if item.get("mode") is not None and item.get("mode") not in _RESOURCE_MODES:
                    raise ErpcInvalidResponseError()
                for field in ("regions", "capabilities"):
                    array = item.get(field)
                    if not isinstance(array, list) or not all(
                        isinstance(entry, str) for entry in array
                    ):
                        raise ErpcInvalidResponseError()
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError("ERPC returned an invalid Cloud catalog") from error
        return cast(list[CloudOffering], offerings)


class CloudCreditClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def get(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> CloudCredit:
        value = await self._transport.get("/v4/cloud/credit", options=options)
        try:
            envelope = _mapping(value)
            if envelope.get("success") is not True:
                raise ErpcInvalidResponseError()
            credit = _mapping(envelope.get("message"))
            if credit.get("alertLevel") not in _ALERT_LEVELS:
                raise ErpcInvalidResponseError()
            _number(credit.get("balanceCents"), integer=True)
            _number(credit.get("burnRateCentsPerHour"), integer=True, nonnegative=True)
            if credit.get("timeToZeroHours") is not None:
                _number(credit.get("timeToZeroHours"), nonnegative=True)
            _datetime(credit.get("quoteTimestamp"))
            _datetime(credit.get("quoteExpiresAt"))
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError(
                "ERPC returned an invalid Cloud credit snapshot"
            ) from error
        return cast(CloudCredit, credit)


class CloudResourcesClient:
    def __init__(self, transport: RestTransport) -> None:
        self._transport = transport

    async def list(self, options: RequestOptions = DEFAULT_REQUEST_OPTIONS) -> list[CloudResource]:
        value = await self._transport.get("/v4/cloud/resources", options=options)
        try:
            envelope = _mapping(value)
            message = _mapping(envelope.get("message"))
            resources = message.get("resources")
            if envelope.get("success") is not True or not isinstance(resources, list):
                raise ErpcInvalidResponseError()
            for resource in resources:
                self._validate_resource(resource)
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError(
                "ERPC returned an invalid Cloud resource list"
            ) from error
        return cast(list[CloudResource], resources)

    async def get(
        self, resource_id: str, options: RequestOptions = DEFAULT_REQUEST_OPTIONS
    ) -> CloudResource:
        resource_id = self._resource_id(resource_id)
        value = await self._transport.get(
            f"/v4/cloud/resources/{quote(resource_id, safe='')}", options=options
        )
        try:
            envelope = _mapping(value)
            message = _mapping(envelope.get("message"))
            if envelope.get("success") is not True:
                raise ErpcInvalidResponseError()
            resource = self._validate_resource(message.get("resource"))
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError("ERPC returned an invalid Cloud resource") from error
        return cast(CloudResource, resource)

    async def get_status(
        self, resource_id: str, options: RequestOptions = DEFAULT_REQUEST_OPTIONS
    ) -> CloudResourceStatus:
        resource_id = self._resource_id(resource_id)
        value = await self._transport.get(
            f"/v4/cloud/resources/{quote(resource_id, safe='')}/status",
            options=options,
        )
        try:
            envelope = _mapping(value)
            if envelope.get("success") is not True:
                raise ErpcInvalidResponseError()
            status = _mapping(envelope.get("message"))
            _string(status.get("id"))
            _string(status.get("status"))
            if "billing" in status:
                billing = _mapping(status["billing"])
                if billing.get("status") not in _BILLING_STATUSES:
                    raise ErpcInvalidResponseError()
                if "hourlyCredits" in billing:
                    _number(billing["hourlyCredits"], nonnegative=True)
                for field in ("nextChargeAt", "graceEndsAt"):
                    if field in billing:
                        _datetime(billing[field])
        except ErpcInvalidResponseError as error:
            raise ErpcInvalidResponseError(
                "ERPC returned an invalid Cloud resource status"
            ) from error
        return cast(CloudResourceStatus, status)

    @staticmethod
    def _resource_id(value: str) -> str:
        result = value.strip()
        if not result:
            raise ErpcConfigError("resource_id must not be empty")
        return result

    @staticmethod
    def _validate_resource(value: object) -> dict[str, object]:
        resource = _mapping(value)
        _string(resource.get("id"))
        _string(resource.get("status"))
        if resource.get("kind") not in _RESOURCE_KINDS:
            raise ErpcInvalidResponseError()
        if resource.get("mode") is not None and resource.get("mode") not in _RESOURCE_MODES:
            raise ErpcInvalidResponseError()
        for field in ("name", "region", "createdAt"):
            if resource.get(field) is not None:
                _string(resource[field])
        return resource
