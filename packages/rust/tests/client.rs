#![allow(missing_docs)]

mod support;

use std::time::Duration;

use erpc_sdk::{
    AssetRequest, CancellationToken, ETHEREUM_RPC_METHODS, ErpcClient, ErpcClientConfig,
    ErpcCloudClient, ErpcCloudClientConfig, ErpcError, ErpcErrorCode, RpcBatchCall,
    SOLANA_ANALYTICS_METHODS, SOLANA_DAS_METHODS, SOLANA_HISTORY_METHODS, SOLANA_LEADER_METHODS,
    SOLANA_RPC_METHODS, SlotStatsOptions,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, header, method, path, query_param},
};

use support::delayed_body_server;

fn config(server: &MockServer, api_key: &str) -> ErpcClientConfig {
    ErpcClientConfig::new(api_key)
        .with_endpoint(server.uri())
        .with_avalanche_endpoint(server.uri())
        .with_account_endpoint(server.uri())
        .with_user_endpoint(server.uri())
}

#[tokio::test]
async fn avalanche_uses_its_c_chain_endpoint() {
    assert_eq!(
        erpc_sdk::DEFAULT_AVALANCHE_ENDPOINT,
        "https://ava-rpc.erpc.global"
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/ava"))
        .and(query_param("api-key", "test-key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_chainId",
            "params": []
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": "0xa86a"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(config(&server, "test-key")).unwrap();
    assert!(!client.avalanche.rpc.endpoint().contains("test-key"));
    assert_eq!(
        client.avalanche.subscriptions.endpoint(),
        format!("{}/ava-ws", server.uri().replacen("http://", "ws://", 1))
    );
    assert_eq!(
        client.avalanche.rpc.eth_chain_id().send().await.unwrap(),
        "0xa86a"
    );
    client.close().await;
}

#[test]
fn configuration_debug_redacts_credentials() {
    let rendered = format!("{:?}", ErpcClientConfig::new("super-secret"));
    assert!(!rendered.contains("super-secret"));
    assert!(rendered.contains("[REDACTED]"));

    let rendered = format!("{:?}", ErpcCloudClientConfig::new("cloud-secret"));
    assert!(!rendered.contains("cloud-secret"));
    assert!(rendered.contains("[REDACTED]"));
}

#[test]
fn method_catalogs_match_the_public_contract() {
    assert_eq!(SOLANA_RPC_METHODS.len(), 55);
    assert_eq!(SOLANA_DAS_METHODS.len(), 14);
    assert_eq!(SOLANA_HISTORY_METHODS.len(), 2);
    assert_eq!(SOLANA_LEADER_METHODS.len(), 2);
    assert_eq!(SOLANA_ANALYTICS_METHODS.len(), 5);
    assert_eq!(ETHEREUM_RPC_METHODS.len(), 53);
}

#[test]
fn typed_extended_parameters_preserve_wire_names() {
    let asset = AssetRequest {
        id: "asset-1".to_owned(),
        display_options: Some(std::collections::HashMap::from([(
            "showCollectionMetadata".to_owned(),
            true,
        )])),
    };
    assert_eq!(
        serde_json::to_value(asset).unwrap(),
        json!({
            "id": "asset-1",
            "displayOptions": {"showCollectionMetadata": true}
        })
    );
    assert_eq!(
        serde_json::to_value(SlotStatsOptions::Range {
            from_slot: 10,
            to_slot: 20,
        })
        .unwrap(),
        json!({"fromSlot": 10, "toSlot": 20})
    );
}

#[test]
fn configuration_rejects_invalid_values() {
    let error = ErpcClient::new(ErpcClientConfig::new("  "))
        .err()
        .expect("empty key must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);

    let error = ErpcCloudClient::new(
        ErpcCloudClientConfig::new("token").with_endpoint("http://example.invalid"),
    )
    .err()
    .expect("non-local Cloud HTTP must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
}

#[tokio::test]
async fn json_rpc_uses_query_auth_and_typed_result() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(query_param("api-key", "test-key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": ["address"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"context": {"slot": 42}, "value": 99}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(config(&server, "test-key")).unwrap();
    let balance = client
        .solana
        .rpc
        .get_balance(["address"])
        .unwrap()
        .send()
        .await
        .unwrap();
    assert_eq!(balance.context.slot, 42);
    assert_eq!(balance.value, 99);
}

#[tokio::test]
async fn rpc_errors_redact_raw_and_encoded_credentials() {
    let server = MockServer::start().await;
    let credential = "secret value/+";
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": format!("bad {credential} secret+value%2F%2B secret%20value%2F%2B"),
                "data": {"url": format!("https://example.invalid/?api-key={credential}")}
            }
        })))
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, credential)).unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    let rendered = format!("{error:?}");
    assert!(!rendered.contains(credential));
    assert!(!rendered.contains("secret+value%2F%2B"));
    assert!(!rendered.contains("secret%20value%2F%2B"));
    assert!(rendered.contains("[REDACTED]"));
}

#[tokio::test]
async fn batch_preserves_one_boundary_and_caller_order() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_json(json!([
            {"jsonrpc": "2.0", "id": 1, "method": "getHealth", "params": []},
            {"jsonrpc": "2.0", "id": 2, "method": "getGenesisHash", "params": []}
        ])))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"jsonrpc": "2.0", "id": 2, "result": "hash"},
            {"jsonrpc": "2.0", "id": 1, "result": "ok"}
        ])))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let results = client
        .solana
        .rpc
        .batch(vec![
            RpcBatchCall::new("getHealth", Vec::<Value>::new()).unwrap(),
            RpcBatchCall::new("getGenesisHash", Vec::<Value>::new()).unwrap(),
        ])
        .unwrap()
        .send()
        .await
        .unwrap();
    assert_eq!(results, vec![json!("ok"), json!("hash")]);
}

#[tokio::test]
async fn batch_rejects_an_unexpected_response_id_without_exposing_it() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"jsonrpc": "2.0", "id": 1, "result": "ok"},
            {"jsonrpc": "2.0", "id": 2, "result": "hash"},
            {"jsonrpc": "2.0", "id": 999_999, "result": "unexpected"}
        ])))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let error = client
        .solana
        .rpc
        .batch(vec![
            RpcBatchCall::without_params("getHealth"),
            RpcBatchCall::without_params("getGenesisHash"),
        ])
        .unwrap()
        .send()
        .await
        .unwrap_err();
    let rendered = error.to_string();
    assert!(rendered.contains("unexpected batch response id"));
    assert!(!rendered.contains("999999"));
}

#[tokio::test]
async fn invalid_mixed_and_leader_batches_are_rejected_locally() {
    let server = MockServer::start().await;
    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let mixed = client.solana.rpc.batch(vec![
        RpcBatchCall::without_params("getHealth"),
        RpcBatchCall::without_params("getProgramAccounts"),
    ]);
    assert!(matches!(mixed, Err(ErpcError::BatchPolicy(_))));

    let leaders = client
        .solana
        .leaders
        .batch(vec![RpcBatchCall::without_params("getLeaderSlots")]);
    assert!(matches!(leaders, Err(ErpcError::BatchPolicy(_))));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn transaction_submission_is_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let error = client
        .solana
        .rpc
        .send_transaction(["signed-transaction"])
        .unwrap()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));
}

#[tokio::test]
async fn cancellation_aborts_an_in_flight_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(2))
                .set_body_json(json!({"jsonrpc": "2.0", "id": 1, "result": "ok"})),
        )
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = client
        .solana
        .rpc
        .get_health()
        .send_with(erpc_sdk::RequestOptions {
            cancellation: Some(cancellation),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
}

#[tokio::test]
async fn http_cancellation_covers_response_body_read() {
    let endpoint = delayed_body_server(
        r#"{"jsonrpc":"2.0","id":1,"result":"ok"}"#,
        Duration::from_millis(500),
    )
    .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(endpoint)).unwrap();
    let cancellation = CancellationToken::new();
    let trigger = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(75)).await;
        trigger.cancel();
    });

    let error = client
        .solana
        .rpc
        .get_health()
        .send_with(erpc_sdk::RequestOptions {
            cancellation: Some(cancellation),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
}

#[tokio::test]
async fn http_timeout_covers_response_body_read() {
    let endpoint = delayed_body_server(
        r#"{"jsonrpc":"2.0","id":1,"result":"ok"}"#,
        Duration::from_millis(500),
    )
    .await;
    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_endpoint(endpoint)
            .with_timeout(Duration::from_millis(75)),
    )
    .unwrap();

    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));
}

#[tokio::test]
async fn account_rest_uses_bearer_auth() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v3/erpc/token-balance"))
        .and(header("authorization", "Bearer account-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "max_tokens": 100,
            "next_refill_at": null,
            "plan": "developer",
            "remaining_tokens": 75
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(config(&server, "account-key")).unwrap();
    let balance = client.account.get_token_balance().await.unwrap();
    assert_eq!(balance.remaining_tokens, 75);
}
