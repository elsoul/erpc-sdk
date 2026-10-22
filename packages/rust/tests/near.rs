#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, DEFAULT_NEAR_ENDPOINT, ErpcClient, ErpcClientConfig, ErpcError,
    ErpcErrorCode, NEAR_RPC_METHODS, NearAccountView, NearBlockId, NearBlockReference,
    NearBlockView, NearFinality, RequestOptions, RpcEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method},
};

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn status_fixture() -> Value {
    json!({
        "chain_id": "mainnet",
        "genesis_hash": "opaque-genesis",
        "latest_protocol_version": 1_000_000_000_000_007_u64,
        "protocol_version": 1_000_000_000_000_006_u64,
        "sync_info": {
            "latest_block_hash": "opaque-latest",
            "latest_block_height": 9_007_199_254_740_993_u64,
            "latest_block_time": "1777777777000000000",
            "latest_state_root": "opaque-state-root",
            "syncing": false,
            "future_sync_field": {"preserve": true}
        },
        "version": {
            "version": "1.40.0",
            "build": "nearcore-build",
            "rustc_version": "1.85.0",
            "future_version_field": [1, 2, 3]
        },
        "future_status_field": {"preserve": true}
    })
}

fn block_fixture() -> Value {
    json!({
        "author": "validator.near",
        "header": {
            "hash": "opaque-block",
            "height": 9_007_199_254_740_993_u64,
            "prev_hash": "opaque-parent",
            "timestamp": 9_007_199_254_740_994_u64,
            "timestamp_nanosec": "9007199254740994000000000",
            "gas_price": "123456789012345678901234567890",
            "total_supply": "987654321098765432109876543210",
            "future_header_field": "preserve"
        },
        "chunks": [{"chunk_hash": "opaque-chunk"}, {"shard_id": 0}],
        "future_block_field": {"preserve": true}
    })
}

fn account_fixture() -> Value {
    json!({
        "amount": "1234567890123456789012345678901234567890",
        "locked": "987654321098765432109876543210987654321",
        "code_hash": "11111111111111111111111111111111",
        "storage_usage": 9_007_199_254_740_993_u64,
        "storage_paid_at": null,
        "block_height": 9_007_199_254_740_994_u64,
        "block_hash": "opaque-account-block",
        "state": null,
        "bootstrap_nonce": null,
        "global_contract_account_id": null,
        "global_contract_hash": null,
        "future_account_field": {"preserve": true}
    })
}

fn dynamic_response(request: &Request) -> ResponseTemplate {
    let body = request_body(request);
    let result = match body["method"].as_str().expect("NEAR method") {
        "status" => status_fixture(),
        "block" => block_fixture(),
        "query" => account_fixture(),
        method => panic!("unexpected NEAR method {method}"),
    };
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": result,
    }))
}

fn finality(finality: NearFinality) -> NearBlockReference {
    NearBlockReference::Finality { finality }
}

fn assert_block_projection(block: &NearBlockView) {
    assert_eq!(block.header.height, 9_007_199_254_740_993_u64);
    assert_eq!(block.header.timestamp, 9_007_199_254_740_994_u64);
    assert_eq!(block.header.timestamp_nanosec, "9007199254740994000000000");
    assert_eq!(block.header.gas_price, "123456789012345678901234567890");
    assert_eq!(block.header.total_supply, "987654321098765432109876543210");
    assert_eq!(block.chunks.len(), 2);
    assert_eq!(
        block.additional["future_block_field"],
        json!({"preserve": true})
    );
    assert_eq!(block.header.additional["future_header_field"], "preserve");
}

fn assert_account_projection(account: &NearAccountView) {
    assert_eq!(account.amount, "1234567890123456789012345678901234567890");
    assert_eq!(account.locked, "987654321098765432109876543210987654321");
    assert_eq!(account.storage_usage, 9_007_199_254_740_993_u64);
    assert_eq!(account.block_height, 9_007_199_254_740_994_u64);
    assert!(account.storage_paid_at.is_none());
    assert_eq!(
        account.additional["future_account_field"],
        json!({"preserve": true})
    );
}

#[test]
fn catalog_and_selectors_are_exclusive_and_wire_compatible() {
    assert_eq!(NEAR_RPC_METHODS, &["block", "query", "status"]);
    assert_eq!(
        serde_json::to_value(finality(NearFinality::Final)).unwrap(),
        json!({"finality": "final"})
    );
    assert_eq!(
        serde_json::to_value(finality(NearFinality::Optimistic)).unwrap(),
        json!({"finality": "optimistic"})
    );
    assert_eq!(
        serde_json::to_value(NearBlockReference::BlockId {
            block_id: NearBlockId::Height(187_310_138),
        })
        .unwrap(),
        json!({"block_id": 187_310_138_u64})
    );
    assert_eq!(
        serde_json::to_value(NearBlockReference::BlockId {
            block_id: NearBlockId::Hash("opaque-hash".to_owned()),
        })
        .unwrap(),
        json!({"block_id": "opaque-hash"})
    );

    let both =
        serde_json::from_value::<NearBlockReference>(json!({"finality": "final", "block_id": 1}));
    assert!(both.is_err(), "selectors must be exclusive");
    let neither = serde_json::from_value::<NearBlockReference>(json!({}));
    assert!(neither.is_err(), "a selector is required");
}

#[tokio::test]
async fn typed_reads_preserve_wire_shapes_precision_and_unknown_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(dynamic_response)
        .expect(11)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(server.uri())).unwrap();

    let pending = client.near.rpc.status();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());

    let status = client.near.rpc.status().send().await.unwrap();
    assert_eq!(status.chain_id, "mainnet");
    assert_eq!(status.latest_protocol_version, 1_000_000_000_000_007_u64);
    assert_eq!(
        status.sync_info.latest_block_height,
        9_007_199_254_740_993_u64
    );
    assert_eq!(status.sync_info.latest_block_time, "1777777777000000000");
    assert_eq!(status.version.rustc_version.as_deref(), Some("1.85.0"));
    assert_eq!(
        status.additional["future_status_field"],
        json!({"preserve": true})
    );
    assert_eq!(
        status.sync_info.additional["future_sync_field"],
        json!({"preserve": true})
    );
    assert_eq!(
        status.version.additional["future_version_field"],
        json!([1, 2, 3])
    );

    for reference in [
        finality(NearFinality::Final),
        finality(NearFinality::Optimistic),
        NearBlockReference::BlockId {
            block_id: NearBlockId::Height(9_007_199_254_740_993),
        },
        NearBlockReference::BlockId {
            block_id: NearBlockId::Hash("6RWmTYhXCzjMjoY3Mz1rfFcnBm8E6XeDDbFEPUA4sv1w".into()),
        },
    ] {
        let block = client
            .near
            .rpc
            .block(reference)
            .unwrap()
            .send()
            .await
            .unwrap();
        assert_block_projection(&block);
    }

    for account_id in [
        "near",
        "alice.near",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "0x0123456789abcdef0123456789abcdef0123456789",
        "0s0123456789abcdef0123456789abcdef0123456789",
        "0u0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    ] {
        let account = client
            .near
            .rpc
            .view_account(account_id, finality(NearFinality::Final))
            .unwrap()
            .send()
            .await
            .unwrap();
        assert_account_projection(&account);
    }

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 11);
    assert_eq!(request_body(&requests[0])["method"], "status");
    assert_eq!(request_body(&requests[0])["params"], json!([]));
    for request in &requests[1..5] {
        let body = request_body(request);
        assert_eq!(body["method"], "block");
        assert_eq!(body["params"].as_object().unwrap().len(), 1);
    }
    for (request, account_id) in requests[5..].iter().zip([
        "near",
        "alice.near",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "0x0123456789abcdef0123456789abcdef0123456789",
        "0s0123456789abcdef0123456789abcdef0123456789",
        "0u0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    ]) {
        let body = request_body(request);
        assert_eq!(body["method"], "query");
        assert_eq!(body["params"]["request_type"], "view_account");
        assert_eq!(body["params"]["account_id"], account_id);
        assert_eq!(body["params"].as_object().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn inherited_envelope_behavior_is_explicitly_covered() {
    let cases = [
        (
            r#"{"jsonrpc":"2.0","id":1,"error":null}"#,
            ErpcErrorCode::InvalidResponse,
        ),
        (
            r#"{"jsonrpc":"2.0","id":1,"result":null}"#,
            ErpcErrorCode::InvalidResponse,
        ),
        (
            r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-32000,"message":"denied"}}"#,
            ErpcErrorCode::Rpc,
        ),
        (
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            ErpcErrorCode::InvalidResponse,
        ),
        (
            r#"{"jsonrpc":"2.0","id":"1","result":{}}"#,
            ErpcErrorCode::InvalidResponse,
        ),
        (
            r#"{"jsonrpc":"2.0","result":{}}"#,
            ErpcErrorCode::InvalidResponse,
        ),
        (r"[1,2,3]", ErpcErrorCode::InvalidResponse),
    ];

    for (body, expected_code) in cases {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
            .expect(1)
            .mount(&server)
            .await;
        let client =
            ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(server.uri())).unwrap();
        let error = client.near.rpc.status().send().await.unwrap_err();
        assert_eq!(error.code(), expected_code);
    }

    for body in [
        r#"{"jsonrpc":"1.0","id":1,"result":FIXTURE}"#,
        r#"{"id":1,"result":FIXTURE}"#,
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(|request: &Request| {
                let body = body.replace("FIXTURE", &status_fixture().to_string());
                let mut value: Value = serde_json::from_str(&body).unwrap();
                value["id"] = request_body(request)["id"].clone();
                ResponseTemplate::new(200).set_body_json(value)
            })
            .expect(1)
            .mount(&server)
            .await;
        let client =
            ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(server.uri())).unwrap();
        let status = client.near.rpc.status().send().await.unwrap();
        assert_eq!(status.chain_id, "mainnet");
    }
}

#[tokio::test]
async fn hosted_and_direct_routes_keep_authentication_and_endpoint_metadata_scoped() {
    assert_eq!(DEFAULT_NEAR_ENDPOINT, "https://near.erpc.global");

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(header("x-global", "retained"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&server)
        .await;
    let hosted = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_near_endpoint(format!("{}/near", server.uri()))
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(hosted.near.rpc.endpoint(), format!("{}/", server.uri()));
    hosted.near.rpc.status().send().await.unwrap();
    let hosted_request = &server.received_requests().await.unwrap()[0];
    assert_eq!(hosted_request.url.query(), Some("api-key=key"));
    assert_eq!(hosted_request.url.path(), "/near");

    let direct_server = MockServer::start().await;
    let direct_target = format!(
        "{}/customer%2fnear/rpc?token=a%2Fb&region=eu",
        direct_server.uri()
    );
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&direct_server)
        .await;
    let direct = ErpcClient::new(
        ErpcClientConfig::new("inherited-key")
            .with_near_endpoint("https://hosted.invalid/near")
            .with_header("x-global", "global-secret")
            .with_near_rpc(
                RpcEndpointConfig::new(direct_target)
                    .with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(
        direct.near.rpc.endpoint(),
        format!("{}/", direct_server.uri())
    );
    direct.near.rpc.status().send().await.unwrap();
    let request = &direct_server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer%2fnear/rpc");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert!(!request.url.as_str().contains("api-key"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
}

#[tokio::test]
async fn direct_routes_do_not_follow_redirects_and_redact_credentials() {
    let redirect_server = MockServer::start().await;
    let destination_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("location", format!("{}/target", destination_server.uri())),
        )
        .expect(1)
        .mount(&redirect_server)
        .await;
    let client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(redirect_server.uri())).unwrap();
    assert!(matches!(
        client.near.rpc.status().send().await.unwrap_err(),
        ErpcError::Http { status: 307 }
    ));
    assert!(
        destination_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );

    let server = MockServer::start().await;
    let target = format!(
        "{}/path-secret%2fencoded/rpc?query-secret=q%2Fvalue",
        server.uri()
    );
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": request_body(request)["id"],
                "error": {
                    "code": -32000,
                    "message": "path-secret%2fencoded path-secret/encoded q%2Fvalue q/value header-secret",
                    "data": {
                        "path-secret%2fencoded": "path-secret%2fencoded",
                        "path-secret/encoded": "path-secret/encoded",
                        "q%2Fvalue": "q/value",
                        "header-secret": "header-secret"
                    }
                }
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    let config = ErpcClientConfig::for_rpc().with_near_rpc(
        RpcEndpointConfig::new(target).with_header("authorization", "Bearer header-secret"),
    );
    let debug = format!("{config:?}");
    for secret in [
        "path-secret%2fencoded",
        "path-secret/encoded",
        "q%2Fvalue",
        "q/value",
        "header-secret",
    ] {
        assert!(!debug.contains(secret));
    }
    let client = ErpcClient::new(config).unwrap();
    let error = client.near.rpc.status().send().await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::Rpc);
    let display = error.to_string();
    let rendered = format!("{error:?}");
    for secret in [
        "path-secret%2fencoded",
        "path-secret/encoded",
        "q%2Fvalue",
        "q/value",
        "header-secret",
    ] {
        assert!(!display.contains(secret));
        assert!(!rendered.contains(secret));
    }
}

#[test]
fn websocket_configuration_is_rejected_without_secret_leakage() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_near_rpc(
            RpcEndpointConfig::new("https://near.example/rpc?secret=query-secret")
                .with_websocket_url("wss://near.example/ws?secret=ws-secret")
                .with_header("authorization", "Bearer header-secret"),
        ),
    )
    .err()
    .expect("NEAR WebSocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    let rendered = format!("{error:?}");
    for secret in ["query-secret", "ws-secret", "header-secret"] {
        assert!(!rendered.contains(secret));
    }
}

#[tokio::test]
async fn unavailable_namespace_and_lifecycle_errors_use_existing_categories() {
    let other_server = MockServer::start().await;
    let other =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(other_server.uri())).unwrap();
    assert_eq!(other.near.rpc.endpoint(), "");
    let error = other.near.rpc.status().send().await.unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "near.rpc"
    ));
    assert!(other_server.received_requests().await.unwrap().is_empty());

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(server.uri())).unwrap();
    assert!(matches!(
        client.near.rpc.status().send().await.unwrap_err(),
        ErpcError::Http { status: 503 }
    ));

    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"jsonrpc":"2.0","id":1,"result":status_fixture()})),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_near_rpc(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .unwrap();
    assert!(matches!(
        timeout_client.near.rpc.status().send().await.unwrap_err(),
        ErpcError::Timeout { .. }
    ));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(dynamic_response)
        .expect(0)
        .mount(&cancellation_server)
        .await;
    let cancellation_client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(cancellation_server.uri()))
            .unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = cancellation_client
        .near
        .rpc
        .status()
        .send_with(RequestOptions {
            cancellation: Some(cancellation),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
    assert!(
        cancellation_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn malformed_json_shapes_reserved_keys_and_wrong_ids_are_invalid() {
    let bodies = [
        r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":{"wrong":"shape"}}"#,
        r#"{"jsonrpc":"2.0","id":1}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":{}} trailing"#,
        r#"{"jsonrpc":"2.0","id":1,"result":{"$serde_json::private::Number":"1"}}"#,
    ];
    for body in bodies {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
            .expect(1)
            .mount(&server)
            .await;
        let client =
            ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(server.uri())).unwrap();
        let error = client.near.rpc.status().send().await.unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}
