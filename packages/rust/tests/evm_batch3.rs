#![allow(missing_docs)]

use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
use serde_json::{Value, json};
use wiremock::{Mock, MockServer, Request, ResponseTemplate, matchers::method};

fn request_body(request: &Request) -> Value {
    request.body_json().expect("JSON-RPC request body")
}

fn chain_response(request: &Request, chain_id: &str) -> ResponseTemplate {
    let body = request_body(request);
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": chain_id,
    }))
}

#[tokio::test]
async fn direct_hyperliquid_arc_robinhood_transports_are_isolated_on_one_client() {
    let hyperliquid = MockServer::start().await;
    let arc = MockServer::start().await;
    let robinhood = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x3e7"))
        .expect(1)
        .mount(&hyperliquid)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x13b2"))
        .expect(1)
        .mount(&arc)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x1237"))
        .expect(1)
        .mount(&robinhood)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("main-key")
            .with_endpoint("https://shared.invalid")
            .with_header("x-global", "global-secret")
            .with_hyperliquid_endpoint("https://hosted.invalid/hyperliquid")
            .with_arc_endpoint("https://hosted.invalid/arc")
            .with_robinhood_endpoint("https://hosted.invalid/robinhood")
            .with_hyperliquid_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/hyper%2Fpath/rpc?hyper-token=h%2Fq",
                    hyperliquid.uri()
                ))
                .with_header("authorization", "Bearer hyper-secret"),
            )
            .with_arc_rpc(
                RpcEndpointConfig::new(format!("{}/arc/path?arc-token=a%2Fq", arc.uri()))
                    .with_header("authorization", "Bearer arc-secret"),
            )
            .with_robinhood_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/robinhood/path?robin-token=r%2Fq",
                    robinhood.uri()
                ))
                .with_header("authorization", "Bearer robin-secret"),
            ),
    )
    .unwrap();

    assert_eq!(
        client.hyperliquid.rpc.eth_chain_id().send().await.unwrap(),
        "0x3e7"
    );
    assert_eq!(
        client.arc.rpc.eth_chain_id().send().await.unwrap(),
        "0x13b2"
    );
    assert_eq!(
        client.robinhood.rpc.eth_chain_id().send().await.unwrap(),
        "0x1237"
    );

    let cases = [
        (
            hyperliquid.received_requests().await.unwrap(),
            "/hyper%2Fpath/rpc",
            "hyper-token=h%2Fq",
            "Bearer hyper-secret",
        ),
        (
            arc.received_requests().await.unwrap(),
            "/arc/path",
            "arc-token=a%2Fq",
            "Bearer arc-secret",
        ),
        (
            robinhood.received_requests().await.unwrap(),
            "/robinhood/path",
            "robin-token=r%2Fq",
            "Bearer robin-secret",
        ),
    ];
    for (requests, path, query, authorization) in cases {
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.url.path(), path);
        assert_eq!(request.url.query(), Some(query));
        assert_eq!(request.headers.get("authorization").unwrap(), authorization);
        assert!(!request.headers.contains_key("x-global"));
        assert!(!request.url.as_str().contains("api-key"));
    }
}
