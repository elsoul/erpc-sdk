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
async fn direct_kaia_soneium_monad_transports_are_isolated_on_one_client() {
    let kaia = MockServer::start().await;
    let soneium = MockServer::start().await;
    let monad = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x2019"))
        .expect(1)
        .mount(&kaia)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x74c"))
        .expect(1)
        .mount(&soneium)
        .await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| chain_response(request, "0x8f"))
        .expect(1)
        .mount(&monad)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("main-key")
            .with_endpoint("https://shared.invalid")
            .with_header("x-global", "global-secret")
            .with_kaia_endpoint("https://hosted.invalid/kaia")
            .with_soneium_endpoint("https://hosted.invalid/soneium")
            .with_monad_endpoint("https://hosted.invalid/monad")
            .with_kaia_rpc(
                RpcEndpointConfig::new(format!("{}/kaia%2Fpath/rpc?kaia-token=k%2Fq", kaia.uri()))
                    .with_header("authorization", "Bearer kaia-secret"),
            )
            .with_soneium_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/soneium/path?soneium-token=s%2Fq",
                    soneium.uri()
                ))
                .with_header("authorization", "Bearer soneium-secret"),
            )
            .with_monad_rpc(
                RpcEndpointConfig::new(format!("{}/monad/path?monad-token=m%2Fq", monad.uri()))
                    .with_header("authorization", "Bearer monad-secret"),
            ),
    )
    .unwrap();

    assert_eq!(
        client.kaia.rpc.eth_chain_id().send().await.unwrap(),
        "0x2019"
    );
    assert_eq!(
        client.soneium.rpc.eth_chain_id().send().await.unwrap(),
        "0x74c"
    );
    assert_eq!(
        client.monad.rpc.eth_chain_id().send().await.unwrap(),
        "0x8f"
    );

    let cases = [
        (
            kaia.received_requests().await.unwrap(),
            "/kaia%2Fpath/rpc",
            "kaia-token=k%2Fq",
            "Bearer kaia-secret",
        ),
        (
            soneium.received_requests().await.unwrap(),
            "/soneium/path",
            "soneium-token=s%2Fq",
            "Bearer soneium-secret",
        ),
        (
            monad.received_requests().await.unwrap(),
            "/monad/path",
            "monad-token=m%2Fq",
            "Bearer monad-secret",
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
