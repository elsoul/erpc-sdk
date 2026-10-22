#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    ARC_RPC_METHODS, DEFAULT_ARC_ENDPOINT, ErpcClient, ErpcClientConfig, ErpcError, ErpcErrorCode,
    RpcEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

const NATIVE_BALANCE: &str = "0x1000000000000000000000000000000000000000000000000000000000000001";
const ERC20_DECIMALS_WORD: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000006";

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn arc_response(request: &Request) -> ResponseTemplate {
    let body = request_body(request);
    let result = match body["method"].as_str().expect("method") {
        "eth_chainId" => json!("0x13b2"),
        "eth_getBalance" => json!(NATIVE_BALANCE),
        "eth_call" => json!(ERC20_DECIMALS_WORD),
        method => panic!("unexpected Arc method {method}"),
    };
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": result,
    }))
}

#[tokio::test]
async fn hosted_arc_uses_root_query_auth_and_exact_three_method_surface() {
    assert_eq!(DEFAULT_ARC_ENDPOINT, "https://arc.erpc.global");
    assert_eq!(
        ARC_RPC_METHODS,
        &["eth_call", "eth_chainId", "eth_getBalance"]
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(query_param("api-key", "key"))
        .and(header("x-global", "retained"))
        .respond_with(arc_response)
        .expect(3)
        .mount(&server)
        .await;

    let default = ErpcClient::new(ErpcClientConfig::new("key")).unwrap();
    assert_eq!(default.arc.rpc.endpoint(), "https://arc.erpc.global/");

    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_arc_endpoint(server.uri())
            .with_header("x-global", "retained"),
    )
    .unwrap();
    let pending = client.arc.rpc.eth_chain_id();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x13b2"
    );
    assert_eq!(
        client
            .arc
            .rpc
            .eth_get_balance(["0xabc", "latest"])
            .unwrap()
            .send()
            .await
            .unwrap(),
        NATIVE_BALANCE
    );
    assert_eq!(
        client
            .arc
            .rpc
            .eth_call(json!([{"to":"0x3600000000000000000000000000000000000000","data":"0x313ce567"}, "latest"]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        ERC20_DECIMALS_WORD
    );
    assert_eq!(client.arc.rpc.endpoint(), format!("{}/", server.uri()));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests[0].url.path(), "/");
    assert_eq!(requests[0].url.query(), Some("api-key=key"));
    assert!(!requests[0].url.path().contains("arc"));
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
        json!([{
            "to": "0x3600000000000000000000000000000000000000",
            "data": "0x313ce567"
        }, "latest"])
    );
}

#[tokio::test]
async fn hosted_arc_edge_override_preserves_arc_path_and_query_auth() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/arc"))
        .and(query_param("api-key", "key"))
        .and(header("x-global", "retained"))
        .respond_with(arc_response)
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_arc_endpoint(format!("{}/arc", server.uri()))
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x13b2"
    );
    assert_eq!(client.arc.rpc.endpoint(), format!("{}/", server.uri()));

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/arc");
    assert_eq!(request.url.query(), Some("api-key=key"));
    assert!(!request.url.path().contains("/arc/arc"));
    assert_eq!(request.body_json::<Value>().unwrap()["params"], json!([]));
}

#[tokio::test]
async fn direct_arc_preserves_exact_target_and_isolated_headers() {
    let server = MockServer::start().await;
    let target = format!("{}/customer%2farc/rpc?token=a%2Fb&region=eu", server.uri());
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(arc_response)
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("inherited-key")
            .with_endpoint("https://hosted.invalid")
            .with_header("x-global", "global-secret")
            .with_arc_rpc(
                RpcEndpointConfig::new(target.clone())
                    .with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(client.arc.rpc.endpoint(), format!("{}/", server.uri()));
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x13b2"
    );

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer%2farc/rpc");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert!(!request.url.as_str().contains("api-key"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
}

#[tokio::test]
async fn direct_arc_does_not_follow_redirects() {
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
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_arc_rpc(RpcEndpointConfig::new(redirect_server.uri())),
    )
    .unwrap();
    let error = client.arc.rpc.eth_chain_id().send().await.unwrap_err();
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
async fn direct_arc_redacts_path_query_header_and_nested_rpc_credentials() {
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
    let config = ErpcClientConfig::for_rpc().with_arc_rpc(
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
    assert_eq!(client.arc.rpc.endpoint(), format!("{}/", server.uri()));
    let error = client.arc.rpc.eth_chain_id().send().await.unwrap_err();
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
async fn keyless_direct_arc_works_and_other_only_is_not_configured() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(arc_response)
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_arc_rpc(server.uri())).unwrap();
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x13b2"
    );

    let other_server = MockServer::start().await;
    let other =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(other_server.uri())).unwrap();
    let error = other.arc.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "arc.rpc"
    ));
    assert!(other_server.received_requests().await.unwrap().is_empty());
}

#[test]
fn arc_websocket_configuration_is_rejected_without_credentials_in_error() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_arc_rpc(
            RpcEndpointConfig::new("https://arc.example/rpc?secret=query-secret")
                .with_websocket_url("wss://arc.example/ws?secret=ws-secret")
                .with_header("authorization", "Bearer header-secret"),
        ),
    )
    .err()
    .expect("Arc WebSocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    let rendered = format!("{error:?}");
    for secret in ["query-secret", "ws-secret", "header-secret"] {
        assert!(!rendered.contains(secret));
    }
}

#[tokio::test]
async fn arc_forwards_testnet_id_and_native_18_decimal_and_erc20_6_decimal_views_raw() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let body = request_body(request);
            let result = match body["method"].as_str().expect("method") {
                "eth_chainId" => json!("0x4cef52"),
                "eth_getBalance" => json!(NATIVE_BALANCE),
                "eth_call" => json!(ERC20_DECIMALS_WORD),
                method => panic!("unexpected Arc method {method}"),
            };
            ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": result,
            }))
        })
        .expect(3)
        .mount(&server)
        .await;

    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_arc_rpc(server.uri())).unwrap();
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x4cef52"
    );
    assert_eq!(
        client
            .arc
            .rpc
            .eth_get_balance(["0xabc", "latest"])
            .unwrap()
            .send()
            .await
            .unwrap(),
        NATIVE_BALANCE
    );
    assert_eq!(
        client
            .arc
            .rpc
            .eth_call(json!([{
                "to": "0x3600000000000000000000000000000000000000",
                "data": "0x313ce567"
            }, "latest"]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        ERC20_DECIMALS_WORD
    );
    assert!(
        NATIVE_BALANCE.trim_start_matches("0x").len() > 16,
        "native result must exceed u64 width"
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["params"],
        json!(["0xabc", "latest"])
    );
    assert_eq!(
        requests[2].body_json::<Value>().unwrap()["params"],
        json!([{
            "to": "0x3600000000000000000000000000000000000000",
            "data": "0x313ce567"
        }, "latest"])
    );
}

#[tokio::test]
async fn arc_failures_timeout_and_cancellation_use_existing_categories() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_arc_rpc(server.uri())).unwrap();
    let error = client.arc.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"jsonrpc":"2.0","id":1,"result":"0x13b2"})),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_arc_rpc(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .unwrap();
    let error = timeout_client
        .arc
        .rpc
        .eth_chain_id()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc":"2.0","id":1,"result":"0x13b2"
        })))
        .expect(0)
        .mount(&cancellation_server)
        .await;
    let cancellation_client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_arc_rpc(cancellation_server.uri()))
            .unwrap();
    let cancellation = erpc_sdk::CancellationToken::new();
    cancellation.cancel();
    let error = cancellation_client
        .arc
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
async fn arc_rejects_wrong_ids_malformed_json_shapes_and_reserved_keys() {
    let bodies = [
        r#"{"jsonrpc":"2.0","id":2,"result":"0x13b2"}"#,
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
            ErpcClient::new(ErpcClientConfig::for_rpc().with_arc_rpc(server.uri())).unwrap();
        let error = client.arc.rpc.eth_chain_id().send().await.unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}
