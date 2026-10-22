#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, DEFAULT_MONAD_ENDPOINT, ErpcClient, ErpcClientConfig, ErpcError,
    ErpcErrorCode, MONAD_RPC_METHODS, MonadClient, MonadRpcClient, RpcEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method, query_param},
};

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn dynamic_response(request: &Request) -> ResponseTemplate {
    let body = request_body(request);
    let result = match body["method"].as_str().expect("method") {
        "eth_chainId" => json!("0x8f"),
        "eth_getBalance" => json!("0x1234"),
        "eth_call" => json!("0xabcdef"),
        method => panic!("unexpected Monad method {method}"),
    };
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": result,
    }))
}

fn assert_public_shape(client: &MonadClient) {
    let _: &MonadRpcClient = &client.rpc;
}

#[tokio::test]
async fn hosted_monad_routes_root_and_edge_override_without_duplicate_suffix() {
    assert_eq!(DEFAULT_MONAD_ENDPOINT, "https://monad.erpc.global");
    assert_eq!(
        MONAD_RPC_METHODS,
        &["eth_call", "eth_chainId", "eth_getBalance"]
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(query_param("api-key", "key"))
        .and(header("x-global", "retained"))
        .respond_with(dynamic_response)
        .expect(2)
        .mount(&server)
        .await;

    let default = ErpcClient::new(ErpcClientConfig::new("key")).unwrap();
    assert_eq!(default.monad.rpc.endpoint(), "https://monad.erpc.global/");
    assert_public_shape(&default.monad);

    let hosted = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_monad_endpoint(server.uri())
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(
        hosted.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x8f"
    );

    let edge = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_monad_endpoint(format!("{}/monad", server.uri()))
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(edge.monad.rpc.eth_chain_id().send().await.unwrap(), "0x8f");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests[0].url.path(), "/");
    assert_eq!(requests[1].url.path(), "/monad");
    for request in requests {
        assert_eq!(request.url.query(), Some("api-key=key"));
        assert!(!request.url.path().contains("/eth"));
        assert!(!request.url.path().contains("/rpc"));
    }
}

#[tokio::test]
async fn monad_methods_preserve_parameters_and_pending_requests_are_inert() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(dynamic_response)
        .expect(3)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(server.uri())).unwrap();
    let pending = client.monad.rpc.eth_chain_id();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());
    assert_eq!(
        client.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x8f"
    );
    assert_eq!(
        client
            .monad
            .rpc
            .eth_get_balance(["0xabc", "safe"])
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0x1234"
    );
    assert_eq!(
        client
            .monad
            .rpc
            .eth_call(json!([{"to":"0xabc","data":"0x"}, "finalized"]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0xabcdef"
    );
    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[0].body_json::<Value>().unwrap()["params"],
        json!([])
    );
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["params"],
        json!(["0xabc", "safe"])
    );
    assert_eq!(
        requests[2].body_json::<Value>().unwrap()["params"],
        json!([{"to":"0xabc","data":"0x"}, "finalized"])
    );
}

#[tokio::test]
async fn custom_monad_testnet_chain_id_is_returned_unchanged() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let body = request_body(request);
            ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": "0x279f",
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(server.uri())).unwrap();

    assert_eq!(
        client.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x279f"
    );
}

#[tokio::test]
async fn direct_monad_preserves_exact_target_and_scoped_headers() {
    let server = MockServer::start().await;
    let target = format!(
        "{}/customer%2fmonad/rpc?token=a%2Fb&region=eu",
        server.uri()
    );
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::new("inherited-key")
            .with_monad_endpoint("https://hosted.invalid/monad")
            .with_header("x-global", "global-secret")
            .with_monad_rpc(
                RpcEndpointConfig::new(target).with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(client.monad.rpc.endpoint(), format!("{}/", server.uri()));
    assert_eq!(
        client.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x8f"
    );
    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer%2fmonad/rpc");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert!(!request.url.as_str().contains("api-key"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
}

#[tokio::test]
async fn direct_monad_does_not_follow_redirects() {
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
        ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(redirect_server.uri())).unwrap();
    let error = client.monad.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 307 }));
    assert!(
        destination_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn direct_monad_redacts_path_query_header_and_nested_credentials() {
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
    let config = ErpcClientConfig::for_rpc().with_monad_rpc(
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
    assert_eq!(client.monad.rpc.endpoint(), format!("{}/", server.uri()));
    let error = client.monad.rpc.eth_chain_id().send().await.unwrap_err();
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

#[tokio::test]
async fn keyless_direct_monad_works_and_other_only_is_not_configured() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(dynamic_response)
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(server.uri())).unwrap();
    assert_eq!(
        client.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x8f"
    );

    let other_server = MockServer::start().await;
    let other =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(other_server.uri())).unwrap();
    let error = other.monad.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "monad.rpc"
    ));
    assert!(other_server.received_requests().await.unwrap().is_empty());
}

#[test]
fn monad_websocket_configuration_is_rejected_without_credentials_in_error() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_monad_rpc(
            RpcEndpointConfig::new("https://monad.example/rpc?secret=query-secret")
                .with_websocket_url("wss://monad.example/ws?secret=ws-secret")
                .with_header("authorization", "Bearer header-secret"),
        ),
    )
    .err()
    .expect("Monad WebSocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    let rendered = format!("{error:?}");
    for secret in ["query-secret", "ws-secret", "header-secret"] {
        assert!(!rendered.contains(secret));
    }
}

#[tokio::test]
async fn monad_failures_timeout_and_cancellation_use_existing_categories() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(server.uri())).unwrap();
    let error = client.monad.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));

    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"jsonrpc":"2.0","id":1,"result":"0x8f"})),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_monad_rpc(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .unwrap();
    let error = timeout_client
        .monad
        .rpc
        .eth_chain_id()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc":"2.0","id":1,"result":"0x8f"
        })))
        .expect(0)
        .mount(&cancellation_server)
        .await;
    let cancellation_client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(cancellation_server.uri()))
            .unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = cancellation_client
        .monad
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
async fn monad_rejects_wrong_ids_malformed_json_shapes_and_reserved_keys() {
    let bodies = [
        r#"{"jsonrpc":"2.0","id":2,"result":"0x8f"}"#,
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
            ErpcClient::new(ErpcClientConfig::for_rpc().with_monad_rpc(server.uri())).unwrap();
        let error = client.monad.rpc.eth_chain_id().send().await.unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}
