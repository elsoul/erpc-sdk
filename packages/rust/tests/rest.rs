#![allow(missing_docs)]

use erpc_sdk::{
    ErpcCloudClient, ErpcCloudClientConfig, ErpcError, PriceStreamOptions, PriceUpdateOptions,
};
use futures_util::StreamExt;
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

#[tokio::test]
async fn cloud_catalog_is_validated_and_uses_access_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v4/cloud/catalog"))
        .and(header("authorization", "Bearer cloud-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "message": {
                "offerings": [{
                    "id": "compute-1",
                    "kind": "vps",
                    "name": "Compute",
                    "description": "Virtual compute",
                    "regions": ["eu"],
                    "capabilities": ["standard Solana JSON-RPC"],
                    "compute": {"tenancy": "virtual-machine"},
                    "billing": {"amountCents": 25, "unit": "cents-per-hour"}
                }]
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client =
        ErpcCloudClient::new(ErpcCloudClientConfig::new("cloud-token").with_endpoint(server.uri()))
            .unwrap();
    let offerings = client.catalog.list().await.unwrap();
    assert_eq!(offerings[0].id, "compute-1");
}

#[tokio::test]
async fn cloud_catalog_rejects_an_unknown_billing_unit() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "message": {
                "offerings": [{
                    "id": "compute-1",
                    "kind": "vps",
                    "name": "Compute",
                    "description": "Virtual compute",
                    "regions": [],
                    "capabilities": [],
                    "billing": {"amountCents": 25, "unit": "per-day"}
                }]
            }
        })))
        .mount(&server)
        .await;
    let client =
        ErpcCloudClient::new(ErpcCloudClientConfig::new("cloud-token").with_endpoint(server.uri()))
            .unwrap();
    assert!(matches!(
        client.catalog.list().await,
        Err(ErpcError::InvalidResponse(_))
    ));
}

#[tokio::test]
async fn price_stream_preserves_repeated_ids_and_parses_sse() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/updates/price/stream"))
        .and(query_param("ids[]", "feed-a"))
        .and(query_param("ids[]", "feed-b"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(
                    concat!(
                        "event: price\n",
                        "id: 7\n",
                        "data: {\"binary\":{\"data\":[\"abc\"],\"encoding\":\"base64\"}}\n\n"
                    ),
                    "text/event-stream",
                ),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = erpc_sdk::ErpcClient::new(
        erpc_sdk::ErpcClientConfig::new("key").with_endpoint(server.uri()),
    )
    .unwrap();
    let mut stream = client
        .price
        .stream_price_updates(
            &PriceStreamOptions {
                update: PriceUpdateOptions {
                    ids: vec!["feed-a".to_owned(), "feed-b".to_owned()],
                    ..PriceUpdateOptions::default()
                },
                ..PriceStreamOptions::default()
            },
            None,
        )
        .await
        .unwrap();
    let event = stream.next().await.unwrap().unwrap();
    assert_eq!(event.event.as_deref(), Some("price"));
    assert_eq!(event.id.as_deref(), Some("7"));
    assert_eq!(event.data.binary.data, vec!["abc"]);
}
