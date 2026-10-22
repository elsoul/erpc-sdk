#![allow(missing_docs)]

mod support;

use std::time::Duration;

use erpc_sdk::{
    BITCOIN_RPC_METHODS, CancellationToken, ErpcClient, ErpcClientConfig, ErpcError, ErpcErrorCode,
    RpcBatchCall, RpcEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, Respond, ResponseTemplate,
    matchers::{method, path},
};

#[allow(clippy::needless_pass_by_value)]
fn rpc_response(id: &Value, result: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
        "error": null,
    }))
}

fn request_id(request: &Request) -> Value {
    request.body_json::<Value>().expect("JSON-RPC body")["id"].clone()
}

#[tokio::test]
async fn facade_routes_bearer_auth_and_accepts_legacy_null_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/base/bitcoin"))
        .respond_with(|request: &Request| rpc_response(&request_id(request), json!(840_000)))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("api-key")
            .with_endpoint(format!("{}/base", server.uri()))
            .with_header("authorization", "Bearer intentionally-wrong")
            .with_header("x-global", "retained"),
    )
    .unwrap();
    assert_eq!(
        client.bitcoin.rpc.endpoint(),
        format!("{}/base/bitcoin", server.uri())
    );
    assert_eq!(
        client.bitcoin.rpc.get_block_count().send().await.unwrap(),
        840_000
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.url.path(), "/base/bitcoin");
    assert!(request.url.query().is_none());
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer api-key"
    );
    assert_eq!(request.headers.get("x-global").unwrap(), "retained");
    assert_eq!(request.body_json::<Value>().unwrap()["jsonrpc"], "2.0");
    assert!(request.body_json::<Value>().unwrap()["id"].is_u64());
    assert_eq!(request.body_json::<Value>().unwrap()["params"], json!([]));
}

#[tokio::test]
async fn direct_bitcoin_endpoint_is_exact_scoped_and_keyless() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/customer/path"))
        .respond_with(|request: &Request| rpc_response(&request_id(request), json!("0000hash")))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_header("x-global", "must-not-inherit")
            .with_bitcoin_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/customer/path?token=a%2Fb&region=eu",
                    server.uri()
                ))
                .with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_best_block_hash()
            .send()
            .await
            .unwrap(),
        "0000hash"
    );

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.path(), "/customer/path");
    assert_eq!(request.url.query(), Some("token=a%2Fb&region=eu"));
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer scoped-secret"
    );
    assert!(!request.headers.contains_key("x-global"));
    assert!(!request.url.as_str().contains("api-key"));
}

#[tokio::test]
async fn bitcoin_is_http_only_and_pending_requests_are_inert() {
    let server = MockServer::start().await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_bitcoin_rpc(RpcEndpointConfig::new(format!("{}/rpc", server.uri()))),
    )
    .unwrap();
    let pending = client.bitcoin.rpc.get_block_count();
    drop(pending);
    assert!(server.received_requests().await.unwrap().is_empty());

    let error = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_bitcoin_rpc(
            RpcEndpointConfig::new(format!("{}/rpc", server.uri()))
                .with_websocket_url("wss://node.example/socket"),
        ),
    )
    .err()
    .expect("Bitcoin websocket configuration must fail");
    assert_eq!(error.code(), ErpcErrorCode::Config);
    assert!(!error.to_string().contains("node.example"));

    let other = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_solana_rpc(RpcEndpointConfig::new(format!("{}/solana", server.uri()))),
    )
    .unwrap();
    let error = other
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ErpcError::NotConfigured(namespace) if namespace == "bitcoin.rpc"
    ));
    assert!(server.received_requests().await.unwrap().is_empty());
}

struct HelperResponder;

impl Respond for HelperResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body = request.body_json::<Value>().expect("JSON-RPC body");
        let result = match body["method"].as_str().expect("method") {
            "estimatesmartfee" => json!({"feerate": 0.000_000_01}),
            "getbestblockhash" | "getblockhash" => json!("0000hash"),
            "getblock" => json!({"hash": "0000hash", "height": 840_000}),
            "getblockchaininfo" => json!({"chain": "main"}),
            "getblockcount" => json!(840_000),
            "getblockheader" => json!({"hash": "0000hash"}),
            "getmempoolinfo" => json!({"size": 1}),
            "getnetworkinfo" => json!({"version": 300_000}),
            "getrawmempool" => json!(["txid"]),
            "getrawtransaction" => json!({"txid": "txid"}),
            "gettxout" => Value::Null,
            "futurebtc" => json!({"forward": true}),
            method => panic!("unexpected method {method}"),
        };
        rpc_response(&body["id"], result)
    }
}

#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn helper_catalog_and_raw_escape_hatch_match_wire_contract() {
    assert_eq!(
        BITCOIN_RPC_METHODS,
        &[
            "estimatesmartfee",
            "getbestblockhash",
            "getblock",
            "getblockchaininfo",
            "getblockcount",
            "getblockhash",
            "getblockheader",
            "getmempoolinfo",
            "getnetworkinfo",
            "getrawmempool",
            "getrawtransaction",
            "gettxout",
        ]
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(HelperResponder)
        .expect(13)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();

    assert_eq!(
        client
            .bitcoin
            .rpc
            .estimate_smart_fee([6])
            .unwrap()
            .send()
            .await
            .unwrap()["feerate"],
        json!(0.000_000_01)
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_best_block_hash()
            .send()
            .await
            .unwrap(),
        "0000hash"
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_block(json!(["0000hash", 2]))
            .unwrap()
            .send()
            .await
            .unwrap()["height"],
        840_000
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_blockchain_info()
            .send()
            .await
            .unwrap()["chain"],
        "main"
    );
    assert_eq!(
        client.bitcoin.rpc.get_block_count().send().await.unwrap(),
        840_000
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_block_hash([840_000])
            .unwrap()
            .send()
            .await
            .unwrap(),
        "0000hash"
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_block_header(json!(["0000hash", true]))
            .unwrap()
            .send()
            .await
            .unwrap()["hash"],
        "0000hash"
    );
    assert_eq!(
        client.bitcoin.rpc.get_mempool_info().send().await.unwrap()["size"],
        1
    );
    assert_eq!(
        client.bitcoin.rpc.get_network_info().send().await.unwrap()["version"],
        300_000
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_raw_mempool([true])
            .unwrap()
            .send()
            .await
            .unwrap(),
        json!(["txid"])
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_raw_transaction(json!(["txid", true]))
            .unwrap()
            .send()
            .await
            .unwrap()["txid"],
        "txid"
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .get_tx_out(json!(["txid", 0]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        client
            .bitcoin
            .rpc
            .raw::<Value>("futurebtc", Some(json!([1, 2])))
            .send()
            .await
            .unwrap()["forward"],
        true
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[0].body_json::<Value>().unwrap()["params"],
        json!([6])
    );
    assert_eq!(
        requests[1].body_json::<Value>().unwrap()["params"],
        json!([])
    );
    assert_eq!(
        requests[12].body_json::<Value>().unwrap()["method"],
        "futurebtc"
    );
}

#[tokio::test]
async fn bitcoin_batch_is_unsplit_bounded_and_ordered() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let calls = request.body_json::<Value>().unwrap();
            let mut responses = calls
                .as_array()
                .unwrap()
                .iter()
                .map(|call| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": call["id"],
                        "result": call["method"],
                        "error": null,
                    })
                })
                .collect::<Vec<_>>();
            responses.reverse();
            ResponseTemplate::new(200).set_body_json(responses)
        })
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();

    let calls = vec![
        RpcBatchCall::new("first", Vec::<Value>::new()).unwrap(),
        RpcBatchCall::new("second", [1]).unwrap(),
    ];
    assert_eq!(
        client
            .bitcoin
            .rpc
            .batch(calls)
            .unwrap()
            .send()
            .await
            .unwrap(),
        vec![json!("first"), json!("second")]
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let oversized = (0..101)
        .map(|index| RpcBatchCall::without_params(format!("method{index}")))
        .collect();
    let error = client
        .bitcoin
        .rpc
        .batch(oversized)
        .unwrap()
        .send()
        .await
        .unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    assert!(error.to_string().contains("100"));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    assert!(
        client
            .bitcoin
            .rpc
            .batch(Vec::new())
            .unwrap()
            .send()
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn bitcoin_numeric_values_keep_received_tokens_and_count_is_u64() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let id = request_id(request);
                ResponseTemplate::new(200).set_body_raw(
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"tiny\":0.00000001,\"large\":20999999.99999999,\"long\":1.2345678901234567890123456789,\"integer\":9007199254740993}},\"error\":null}}"
                ),
                "application/json",
            )
        })
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();
    let values = client
        .bitcoin
        .rpc
        .raw::<Value>("numeric", None)
        .send()
        .await
        .unwrap();
    assert_eq!(
        values["tiny"].as_number().unwrap().to_string(),
        "0.00000001"
    );
    assert_eq!(
        values["large"].as_number().unwrap().to_string(),
        "20999999.99999999"
    );
    assert_eq!(
        values["long"].as_number().unwrap().to_string(),
        "1.2345678901234567890123456789"
    );
    assert_eq!(
        values["integer"].as_number().unwrap().to_string(),
        "9007199254740993"
    );

    for invalid in ["-1", "1.5", "18446744073709551616"] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(move |request: &Request| {
                let id = request_id(request);
                ResponseTemplate::new(200).set_body_raw(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{invalid},\"error\":null}}"
                    ),
                    "application/json",
                )
            })
            .mount(&server)
            .await;
        let client =
            ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();
        let error = client
            .bitcoin
            .rpc
            .get_block_count()
            .send()
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}

#[tokio::test]
async fn bitcoin_rpc_errors_redact_credentials_and_strict_namespaces_remain_strict() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/bitcoin"))
        .respond_with(|request: &Request| {
            let id = request_id(request);
            ResponseTemplate::new(200).set_body_raw(
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32000,\"message\":\"bad api-secret\",\"data\":{{\"nested\":\"api-secret\"}}}}}}"
                ),
                "application/json",
            )
        })
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/eth"))
        .respond_with(|request: &Request| {
            let id = request_id(request);
            ResponseTemplate::new(200).set_body_raw(
                format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":\"ok\",\"error\":null}}"),
                "application/json",
            )
        })
        .expect(1)
        .mount(&server)
        .await;
    let client =
        ErpcClient::new(ErpcClientConfig::new("api-secret").with_endpoint(server.uri())).unwrap();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::Rpc);
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("api-secret"));
    assert!(rendered.contains("[REDACTED]"));
    let error = client.ethereum.rpc.eth_chain_id().send().await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
}

#[tokio::test]
async fn bitcoin_failures_do_not_retry_and_timeout_or_cancel_cleanly() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Http { status: 503 }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let endpoint = support::delayed_body_server(
        r#"{"jsonrpc":"2.0","id":1,"result":1,"error":null}"#,
        Duration::from_millis(500),
    )
    .await;
    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_endpoint(endpoint)
            .with_timeout(Duration::from_millis(50)),
    )
    .unwrap();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let endpoint = support::delayed_body_server(
        r#"{"jsonrpc":"2.0","id":1,"result":1,"error":null}"#,
        Duration::from_millis(500),
    )
    .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(endpoint)).unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send_with(erpc_sdk::RequestOptions {
            cancellation: Some(cancellation),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ErpcError::Aborted));
}

#[tokio::test]
async fn bitcoin_redirects_are_not_followed() {
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
        ErpcClientConfig::new("redirect-secret")
            .with_endpoint(redirect_server.uri())
            .with_header("x-global", "retained"),
    )
    .unwrap();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
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
async fn bitcoin_null_error_without_result_is_invalid() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let id = request_id(request);
            ResponseTemplate::new(200).set_body_raw(
                format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":null}}"),
                "application/json",
            )
        })
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();
    let error = client
        .bitcoin
        .rpc
        .get_block_count()
        .send()
        .await
        .unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
}

#[tokio::test]
async fn bitcoin_batch_null_errors_are_accepted_and_ids_are_validated() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            let calls = request.body_json::<Value>().unwrap();
            let first = &calls.as_array().unwrap()[0]["id"];
            ResponseTemplate::new(200).set_body_json(json!([
                {"jsonrpc":"2.0","id":first,"result":"ok","error":null},
                {"jsonrpc":"2.0","id":first,"result":"duplicate","error":null}
            ]))
        })
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::new("key").with_endpoint(server.uri())).unwrap();
    let error = client
        .bitcoin
        .rpc
        .batch(vec![
            RpcBatchCall::without_params("a"),
            RpcBatchCall::without_params("b"),
        ])
        .unwrap()
        .send()
        .await
        .unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
}
