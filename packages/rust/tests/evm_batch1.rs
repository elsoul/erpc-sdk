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
async fn direct_polygon_bsc_optimism_transports_are_isolated_on_one_client() {
    let polygon = MockServer::start().await;
    let bsc = MockServer::start().await;
    let optimism = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x89"))
        .expect(1)
        .mount(&polygon)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x38"))
        .expect(1)
        .mount(&bsc)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0xa"))
        .expect(1)
        .mount(&optimism)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("main-key")
            .with_endpoint("https://shared.invalid")
            .with_header("x-global", "global-secret")
            .with_polygon_endpoint("https://hosted.invalid/polygon")
            .with_bsc_endpoint("https://hosted.invalid/bsc")
            .with_optimism_endpoint("https://hosted.invalid/optimism")
            .with_polygon_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/poly%2Fpath/rpc?poly-token=p%2Fq",
                    polygon.uri()
                ))
                .with_header("authorization", "Bearer polygon-secret"),
            )
            .with_bsc_rpc(
                RpcEndpointConfig::new(format!("{}/bsc/path?bsc-token=b%2Fq", bsc.uri()))
                    .with_header("authorization", "Bearer bsc-secret"),
            )
            .with_optimism_rpc(
                RpcEndpointConfig::new(format!("{}/op/path?op-token=o%2Fq", optimism.uri()))
                    .with_header("authorization", "Bearer optimism-secret"),
            ),
    )
    .unwrap();

    assert_eq!(
        client.polygon.rpc.eth_chain_id().send().await.unwrap(),
        "0x89"
    );
    assert_eq!(client.bsc.rpc.eth_chain_id().send().await.unwrap(), "0x38");
    assert_eq!(
        client.optimism.rpc.eth_chain_id().send().await.unwrap(),
        "0xa"
    );

    let cases = [
        (
            polygon.received_requests().await.unwrap(),
            "/poly%2Fpath/rpc",
            "poly-token=p%2Fq",
            "Bearer polygon-secret",
        ),
        (
            bsc.received_requests().await.unwrap(),
            "/bsc/path",
            "bsc-token=b%2Fq",
            "Bearer bsc-secret",
        ),
        (
            optimism.received_requests().await.unwrap(),
            "/op/path",
            "op-token=o%2Fq",
            "Bearer optimism-secret",
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
