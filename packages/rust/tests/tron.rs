#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, DEFAULT_TRON_ENDPOINT, ErpcClient, ErpcClientConfig, ErpcError,
    ErpcErrorCode, RpcEndpointConfig, TRON_RPC_METHODS, TronClient, TronRpcClient,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

const MAINNET_CHAIN_ID: &str = "0x2b6653dc";
const ADDRESS: &str = "0x1111111111111111111111111111111111111111";

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn tron_response(request: &Request) -> ResponseTemplate {
    let body = request_body(request);
    let result = match body["method"].as_str().expect("method") {
        "eth_chainId" => json!(MAINNET_CHAIN_ID),
        "eth_getBalance" => json!("0x100000"),
        "eth_call" => json!("0xabcdef"),
        method => panic!("unexpected TRON method {method}"),
    };
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": result,
    }))
}

fn assert_public_shape(client: &TronClient) {
    let _: &TronRpcClient = &client.rpc;
}

#[tokio::test]
async fn hosted_tron_routes_root_and_edge_without_jsonrpc_suffix() {
    assert_eq!(DEFAULT_TRON_ENDPOINT, "https://tron.erpc.global");
    assert_eq!(
        TRON_RPC_METHODS,
        &["eth_call", "eth_chainId", "eth_getBalance"]
    );

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(query_param("api-key", "key"))
        .and(header("x-global", "retained"))
        .respond_with(tron_response)
        .expect(2)
        .mount(&server)
        .await;

    let default = ErpcClient::new(ErpcClientConfig::new("key")).unwrap();
    assert_eq!(default.tron.rpc.endpoint(), "https://tron.erpc.global/");

    let hosted = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_tron_endpoint(server.uri())
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_public_shape(&hosted.tron);
    assert_eq!(
        hosted.tron.rpc.eth_chain_id().send().await.unwrap(),
        MAINNET_CHAIN_ID
    );

    let edge = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_tron_endpoint(format!("{}/tron", server.uri()))
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(
        edge.tron.rpc.eth_chain_id().send().await.unwrap(),
        MAINNET_CHAIN_ID
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests[0].url.path(), "/");
    assert_eq!(requests[1].url.path(), "/tron");
    for request in requests {
        assert_eq!(request.url.query(), Some("api-key=key"));
        assert!(!request.url.path().contains("/jsonrpc"));
        assert!(!request.url.path().contains("/eth"));
    }
}

#[tokio::test]
async fn tron_methods_preserve_parameters_and_pending_requests_are_inert() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(tron_response)
        .expect(3)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(server.uri())).unwrap();

    let pending = client.tron.rpc.eth_chain_id();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());

    assert_eq!(
        client.tron.rpc.eth_chain_id().send().await.unwrap(),
        MAINNET_CHAIN_ID
    );
    assert_eq!(
        client
            .tron
            .rpc
            .eth_get_balance([ADDRESS, "latest"])
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0x100000"
    );
    assert_eq!(
        client
            .tron
            .rpc
            .eth_call(json!([{"from": ADDRESS, "to": ADDRESS, "data": "0xdeadbeef"}, "latest"]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0xabcdef"
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[0].body_json::<Value>().unwrap()["method"],
        "eth_chainId"
    );
    assert_eq!(
        requests[0].body_json::<Value>().unwrap()["params"],
        json!([])
    );
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["method"],
        "eth_getBalance"
    );
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["params"],
        json!([ADDRESS, "latest"])
    );
    assert_eq!(
        requests[2].body_json::<Value>().unwrap()["method"],
        "eth_call"
    );
    assert_eq!(
        requests[2].body_json::<Value>().unwrap()["params"],
        json!([{"from": ADDRESS, "to": ADDRESS, "data": "0xdeadbeef"}, "latest"])
    );
}

#[tokio::test]
async fn custom_tron_chain_id_is_returned_unchanged() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let body = request_body(request);
            ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": "0xcd8690dc",
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(server.uri())).unwrap();

    assert_eq!(
        client.tron.rpc.eth_chain_id().send().await.unwrap(),
        "0xcd8690dc"
    );
}

#[tokio::test]
async fn direct_tron_preserves_complete_jsonrpc_target_and_scoped_headers() {
    let server = MockServer::start().await;
    let target = format!(
        "{}/customer%2Ftron/jsonrpc?token=a%2Fb&region=eu",
        server.uri()
    );
    Mock::given(method("POST"))
        .and(path("/customer%2Ftron/jsonrpc"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(tron_response)
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("inherited-key")
            .with_tron_endpoint("https://hosted.invalid/tron")
            .with_header("x-global", "global-secret")
            .with_tron_rpc(
                RpcEndpointConfig::new(target).with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();

    assert_eq!(client.tron.rpc.endpoint(), format!("{}/", server.uri()));
    assert_eq!(
        client.tron.rpc.eth_chain_id().send().await.unwrap(),
        MAINNET_CHAIN_ID
    );
    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer%2Ftron/jsonrpc");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert!(!request.url.as_str().contains("api-key"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
}

#[tokio::test]
async fn direct_tron_does_not_follow_redirects_and_makes_one_attempt() {
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
        ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(redirect_server.uri())).unwrap();
    let error = client.tron.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 307 }));
    assert_eq!(redirect_server.received_requests().await.unwrap().len(), 1);
    assert!(
        destination_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn direct_tron_redacts_path_query_header_and_nested_rpc_credentials() {
    let server = MockServer::start().await;
    let target = format!(
        "{}/path-secret%2fencoded/jsonrpc?query-secret=q%2Fvalue",
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

    let config = ErpcClientConfig::for_rpc().with_tron_rpc(
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
        assert!(
            !debug.contains(secret),
            "config debug leaked {secret}: {debug}"
        );
    }

    let client = ErpcClient::new(config).unwrap();
    assert_eq!(client.tron.rpc.endpoint(), format!("{}/", server.uri()));
    let error = client.tron.rpc.eth_chain_id().send().await.unwrap_err();
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
async fn keyless_direct_tron_works_and_unconfigured_tron_does_not_make_io() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(tron_response)
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(server.uri())).unwrap();
    assert_eq!(
        client.tron.rpc.eth_chain_id().send().await.unwrap(),
        MAINNET_CHAIN_ID
    );

    let other_server = MockServer::start().await;
    let other =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(other_server.uri())).unwrap();
    let error = other.tron.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "tron.rpc"
    ));
    assert!(other_server.received_requests().await.unwrap().is_empty());
}

#[test]
fn tron_websocket_configuration_is_rejected_without_credentials_in_error() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_tron_rpc(
            RpcEndpointConfig::new("https://tron.example/jsonrpc?secret=query-secret")
                .with_websocket_url("wss://tron.example/ws?secret=ws-secret")
                .with_header("authorization", "Bearer header-secret"),
        ),
    )
    .err()
    .expect("TRON WebSocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    let rendered = format!("{error:?}");
    for secret in ["query-secret", "ws-secret", "header-secret"] {
        assert!(!rendered.contains(secret));
    }
}

#[test]
fn tron_invalid_endpoint_configuration_is_config_error() {
    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_tron_rpc(RpcEndpointConfig::new("not-an-url")),
    )
    .err()
    .expect("invalid TRON endpoint must fail configuration");
    assert_eq!(error.code(), ErpcErrorCode::Config);
}

#[tokio::test]
async fn tron_unreachable_endpoint_maps_to_transport_error() {
    let client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc("http://127.0.0.1:1")).unwrap();
    let error = client.tron.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Transport(_)));
}

#[tokio::test]
async fn tron_failures_timeout_and_cancellation_use_existing_categories() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(server.uri())).unwrap();
    let error = client.tron.rpc.eth_chain_id().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .set_body_json(json!({"jsonrpc":"2.0","id":1,"result":MAINNET_CHAIN_ID})),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_tron_rpc(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .unwrap();
    let error = timeout_client
        .tron
        .rpc
        .eth_chain_id()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc":"2.0","id":1,"result":MAINNET_CHAIN_ID
        })))
        .expect(0)
        .mount(&cancellation_server)
        .await;
    let cancellation_client =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(cancellation_server.uri()))
            .unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = cancellation_client
        .tron
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
async fn tron_rejects_wrong_ids_malformed_json_shapes_and_reserved_keys() {
    let bodies = [
        r#"{"jsonrpc":"2.0","id":2,"result":"0x2b6653dc"}"#,
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
            ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(server.uri())).unwrap();
        let error = client.tron.rpc.eth_chain_id().send().await.unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}
