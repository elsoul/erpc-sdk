#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    BASE_RPC_METHODS, ErpcClient, ErpcClientConfig, ErpcError, ErpcErrorCode, RpcEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn dynamic_response(request: &Request) -> ResponseTemplate {
    let body = request_body(request);
    let result = match body["method"].as_str().expect("method") {
        "eth_chainId" => json!("0x2105"),
        "eth_getBalance" => json!("0x1234"),
        "eth_call" => json!("0xabcdef"),
        method => panic!("unexpected Base method {method}"),
    };
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": result,
    }))
}

#[tokio::test]
async fn hosted_base_uses_root_query_auth_and_exact_three_method_surface() {
    assert_eq!(
        BASE_RPC_METHODS,
        &["eth_call", "eth_chainId", "eth_getBalance"]
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(query_param("api-key", "key"))
        .and(header("x-global", "retained"))
        .respond_with(dynamic_response)
        .expect(3)
        .mount(&server)
        .await;

    let default = ErpcClient::new(ErpcClientConfig::new("key")).unwrap();
    assert_eq!(default.base.rpc.endpoint(), "https://base.erpc.global/");

    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_base_endpoint(server.uri())
            .with_header("x-global", "retained"),
    )
    .unwrap();
    let pending = client.base.rpc.eth_chain_id();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());
    assert_eq!(
        client.base.rpc.eth_chain_id().send().await.unwrap(),
        "0x2105"
    );
    assert_eq!(
        client
            .base
            .rpc
            .eth_get_balance(["0xabc", "latest"])
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0x1234"
    );
    assert_eq!(
        client
            .base
            .rpc
            .eth_call(json!([{"to":"0xabc","data":"0x"}, "latest"]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0xabcdef"
    );
    assert_eq!(client.base.rpc.endpoint(), format!("{}/", server.uri()));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests[0].url.path(), "/");
    assert_eq!(requests[0].url.query(), Some("api-key=key"));
    assert!(!requests[0].url.path().contains("base"));
    assert!(!requests[0].url.path().contains("eth"));
    assert_eq!(
        requests[0].body_json::<Value>().unwrap()["params"],
        json!([])
    );
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["params"],
        json!(["0xabc", "latest"])
    );
    assert_eq!(
        requests[2].body_json::<Value>().unwrap()["params"],
        json!([{"to":"0xabc","data":"0x"}, "latest"])
    );
}

#[tokio::test]
async fn direct_base_preserves_exact_target_and_isolated_headers() {
    let server = MockServer::start().await;
    let target = format!("{}/customer%2fbase/rpc?token=a%2Fb&region=eu", server.uri());
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("inherited-key")
            .with_endpoint("https://hosted.invalid")
            .with_header("x-global", "global-secret")
            .with_base_rpc(
                RpcEndpointConfig::new(target.clone())
                    .with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(client.base.rpc.endpoint(), format!("{}/", server.uri()));
    assert_eq!(
        client.base.rpc.eth_chain_id().send().await.unwrap(),
        "0x2105"
    );

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer%2fbase/rpc");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert!(!request.url.as_str().contains("api-key"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
}

#[tokio::test]
async fn direct_base_redacts_path_query_header_and_nested_rpc_credentials() {
    let server = MockServer::start().await;
    let target = format!(
        "{}/path-secret%2fencoded/rpc?query-secret=q%2Fvalue",
        server.uri()
    );
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let id = request_body(request)["id"].clone();
            ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": id,
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
    let config = ErpcClientConfig::for_rpc().with_base_rpc(
        RpcEndpointConfig::new(target).with_header("authorization", "Bearer header-secret"),
    );
    let debug = format!("{config:?}");
    for secret in [
        "path-secret%2fencoded",
        "path-secret/encoded",
        "q/value",
        "q%2Fvalue",
        "header-secret",
    ] {
        assert!(!debug.contains(secret), "debug leaked {secret}: {debug}");
    }
    let client = ErpcClient::new(config).unwrap();
    assert_eq!(client.base.rpc.endpoint(), format!("{}/", server.uri()));
    let error = client.base.rpc.eth_chain_id().send().await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::Rpc);
    let display = error.to_string();
    let rendered = format!("{error:?}");
    for secret in [
        "path-secret%2fencoded",
        "path-secret/encoded",
        "q/value",
        "q%2Fvalue",
        "header-secret",
    ] {
        assert!(
            !display.contains(secret),
            "display leaked {secret}: {display}"
        );
        assert!(
            !rendered.contains(secret),
            "debug leaked {secret}: {rendered}"
        );
    }
}

#[tokio::test]
async fn keyless_direct_base_works_and_other_only_is_not_configured() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_base_rpc(server.uri())).unwrap();
    assert_eq!(
        client.base.rpc.eth_chain_id().send().await.unwrap(),
        "0x2105"
    );

    let other_server = MockServer::start().await;
    let other =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(other_server.uri())).unwrap();
    let error = other.base.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "base.rpc"
    ));
    assert!(other_server.received_requests().await.unwrap().is_empty());
}

#[test]
fn base_websocket_configuration_is_rejected_without_credentials_in_error() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_base_rpc(
            RpcEndpointConfig::new("https://base.example/rpc?secret=query-secret")
                .with_websocket_url("wss://base.example/ws?secret=ws-secret")
                .with_header("authorization", "Bearer header-secret"),
        ),
    )
    .err()
    .expect("Base WebSocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    let rendered = format!("{error:?}");
    for secret in ["query-secret", "ws-secret", "header-secret"] {
        assert!(!rendered.contains(secret));
    }
}

#[tokio::test]
async fn base_failures_timeout_and_cancellation_use_existing_categories() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_base_rpc(server.uri())).unwrap();
    let error = client.base.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"jsonrpc":"2.0","id":1,"result":"0x2105"})),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_base_rpc(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .unwrap();
    let error = timeout_client
        .base
        .rpc
        .eth_chain_id()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc":"2.0","id":1,"result":"0x2105"
        })))
        .expect(0)
        .mount(&cancellation_server)
        .await;
    let cancellation_client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_base_rpc(cancellation_server.uri()))
            .unwrap();
    let cancellation = erpc_sdk::CancellationToken::new();
    cancellation.cancel();
    let error = cancellation_client
        .base
        .rpc
        .eth_chain_id()
        .send_with(erpc_sdk::RequestOptions {
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
async fn base_rejects_wrong_ids_malformed_json_shapes_and_reserved_keys() {
    let bodies = [
        r#"{"jsonrpc":"2.0","id":2,"result":"0x2105"}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":{"wrong":"shape"}}"#,
        r#"{"jsonrpc":"2.0","id":1}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":1} trailing"#,
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
            ErpcClient::new(ErpcClientConfig::for_rpc().with_base_rpc(server.uri())).unwrap();
        let error = client.base.rpc.eth_chain_id().send().await.unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}
