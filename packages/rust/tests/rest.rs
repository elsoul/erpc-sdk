#![allow(missing_docs)]

mod support;

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, ErpcCloudClient, ErpcCloudClientConfig, ErpcError, MonthlyApiKeyUsageParams,
    PriceStreamOptions, PriceUpdateOptions,
};
use futures_util::StreamExt;
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

use support::delayed_body_server;

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

#[tokio::test]
async fn price_timestamp_is_encoded_as_one_path_segment() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/updates/price/1700%2F%2E%2E%2F%3Fsecret%3D%23"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "binary": {"data": [], "encoding": "base64"}
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = erpc_sdk::ErpcClient::new(
        erpc_sdk::ErpcClientConfig::new("key").with_endpoint(server.uri()),
    )
    .unwrap();

    client
        .price
        .get_price_updates_at_timestamp("1700/../?secret=#", &PriceUpdateOptions::default())
        .await
        .unwrap();
}

#[tokio::test]
async fn price_cancellation_covers_response_body_read() {
    let endpoint = delayed_body_server(
        r#"{"binary":{"data":[],"encoding":"base64"}}"#,
        Duration::from_millis(500),
    )
    .await;
    let client =
        erpc_sdk::ErpcClient::new(erpc_sdk::ErpcClientConfig::new("key").with_endpoint(endpoint))
            .unwrap();
    let cancellation = CancellationToken::new();
    let trigger = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(75)).await;
        trigger.cancel();
    });

    let error = client
        .price
        .get_latest_price_updates_with(&PriceUpdateOptions::default(), Some(&cancellation))
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
}

#[tokio::test]
async fn every_non_streaming_price_get_exposes_cancellation() {
    let client = erpc_sdk::ErpcClient::new(
        erpc_sdk::ErpcClientConfig::new("key").with_endpoint("http://127.0.0.1:1"),
    )
    .unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    assert!(matches!(
        client
            .price
            .get_price_feeds_with(None, None, Some(&cancellation))
            .await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .price
            .get_latest_price_updates_with(&PriceUpdateOptions::default(), Some(&cancellation),)
            .await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .price
            .get_price_updates_at_timestamp_with(
                1_700_000_000,
                &PriceUpdateOptions::default(),
                Some(&cancellation),
            )
            .await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .price
            .get_latest_publisher_stake_caps_with(None, None, Some(&cancellation))
            .await,
        Err(ErpcError::Aborted)
    ));
}

#[tokio::test]
async fn rest_timeout_covers_response_body_read() {
    let endpoint = delayed_body_server("[]", Duration::from_millis(500)).await;
    let client = erpc_sdk::ErpcClient::new(
        erpc_sdk::ErpcClientConfig::new("key")
            .with_endpoint(endpoint)
            .with_timeout(Duration::from_millis(75)),
    )
    .unwrap();

    let error = client.price.get_price_feeds(None, None).await.unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));
}

#[tokio::test]
async fn cloud_cancellation_covers_response_body_read() {
    let endpoint = delayed_body_server(
        r#"{"success":true,"message":{"offerings":[]}}"#,
        Duration::from_millis(500),
    )
    .await;
    let client =
        ErpcCloudClient::new(ErpcCloudClientConfig::new("cloud-token").with_endpoint(endpoint))
            .unwrap();
    let cancellation = CancellationToken::new();
    let trigger = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(75)).await;
        trigger.cancel();
    });

    let error = client
        .catalog
        .list_with(Some(&cancellation))
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
}

#[tokio::test]
async fn every_cloud_rest_operation_exposes_cancellation() {
    let client = ErpcCloudClient::new(
        ErpcCloudClientConfig::new("cloud-token").with_endpoint("http://127.0.0.1:1"),
    )
    .unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    assert!(matches!(
        client.catalog.list_with(Some(&cancellation)).await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client.credit.get_with(Some(&cancellation)).await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client.resources.list_with(Some(&cancellation)).await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .resources
            .get_with("resource-1", Some(&cancellation))
            .await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .resources
            .get_status_with("resource-1", Some(&cancellation))
            .await,
        Err(ErpcError::Aborted)
    ));
    assert!(matches!(
        client
            .usage
            .get_monthly_api_key_usage_with(
                MonthlyApiKeyUsageParams::default(),
                Some(&cancellation),
            )
            .await,
        Err(ErpcError::Aborted)
    ));
}
