from __future__ import annotations

import json

import httpx
import pytest

from erpc_sdk import (
    ErpcClient,
    ErpcClientConfig,
    ErpcCloudClient,
    ErpcCloudClientConfig,
    ErpcConfigError,
    ErpcInvalidResponseError,
)


@pytest.mark.asyncio
async def test_price_rest_uses_bearer_and_repeated_ids() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer secret"
        assert request.url.path == "/v2/updates/price/latest"
        assert request.url.params.get_list("ids[]") == ["feed-a", "feed-b"]
        assert request.url.params["parsed"] == "true"
        return httpx.Response(200, json={"binary": {"data": ["value"], "encoding": "base64"}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(
        ErpcClientConfig("secret", endpoint="https://example.test"),
        http_client=http,
    )
    result = await erpc.price.get_latest_price_updates(["feed-a", "feed-b"], parsed=True)
    assert result["binary"]["encoding"] == "base64"
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_price_sse_parses_event_fields_and_multiline_data() -> None:
    update = {"binary": {"data": [], "encoding": "hex"}}
    body = f"id: 7\nevent: price_update\ndata: {json.dumps(update)}\n\n"

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body.encode())

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("secret"), http_client=http)
    events = [event async for event in erpc.price.stream_price_updates(["feed"])]
    assert events == [{"id": "7", "event": "price_update", "data": update}]
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_usage_validates_year_month_before_transport() -> None:
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500)))
    erpc = ErpcClient(ErpcClientConfig("secret"), http_client=http)
    with pytest.raises(ErpcConfigError, match="YYYY-MM"):
        await erpc.usage.get_monthly_api_key_usage("2026-13")
    await erpc.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_usage_unwraps_and_validates_envelope() -> None:
    usage = {
        "apiKeys": [],
        "chains": [],
        "hasStrandedUsage": False,
        "keyCount": 0,
        "totalCount": 0,
        "totalCredits": 0,
        "updatedAt": None,
        "yearMonth": "2026-08",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["yearMonth"] == "2026-08"
        return httpx.Response(200, json={"success": True, "message": usage})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    erpc = ErpcClient(ErpcClientConfig("secret"), http_client=http)
    assert await erpc.usage.get_monthly_api_key_usage("2026-08") == usage
    await erpc.close()
    await http.aclose()


def test_cloud_rejects_non_local_plain_http_and_redacts_token() -> None:
    with pytest.raises(ErpcConfigError, match="HTTPS"):
        ErpcCloudClientConfig("token", endpoint="http://example.test")
    config = ErpcCloudClientConfig(" top-secret ", endpoint="http://localhost:9000/")
    assert "top-secret" not in repr(config)
    assert config.endpoint == "http://localhost:9000/"


@pytest.mark.asyncio
async def test_cloud_catalog_and_resource_paths_are_scoped_reads() -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        assert request.headers["authorization"] == "Bearer access"
        if request.url.path.endswith("/catalog"):
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "message": {
                        "offerings": [
                            {
                                "id": "vps-small",
                                "kind": "vps",
                                "name": "Small",
                                "description": "Small compute",
                                "regions": ["eu"],
                                "capabilities": ["compute"],
                            }
                        ]
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "success": True,
                "message": {"resource": {"id": "a/b", "kind": "vps", "status": "ready"}},
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    cloud = ErpcCloudClient(
        ErpcCloudClientConfig("access", endpoint="https://example.test/base"),
        http_client=http,
    )
    assert (await cloud.catalog.list())[0]["id"] == "vps-small"
    assert (await cloud.resources.get("a/b"))["status"] == "ready"
    assert paths == ["/base/v4/cloud/catalog", "/base/v4/cloud/resources/a/b"]
    await cloud.close()
    await http.aclose()


@pytest.mark.asyncio
async def test_invalid_account_response_is_rejected() -> None:
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"plan": "unknown"}))
    )
    erpc = ErpcClient(ErpcClientConfig("secret"), http_client=http)
    with pytest.raises(ErpcInvalidResponseError):
        await erpc.account.get_token_balance()
    await erpc.close()
    await http.aclose()
