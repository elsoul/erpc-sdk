#![allow(missing_docs)]

mod support;

use std::time::Duration;

use erpc_sdk::{
    AVALANCHE_AVAX_METHODS, AVALANCHE_INDEX_METHODS, AVALANCHE_INFO_METHODS,
    AVALANCHE_P_CHAIN_METHODS, AVALANCHE_PROPOSER_VM_METHODS, AVALANCHE_X_CHAIN_METHODS,
    AssetRequest, CancellationToken, ETHEREUM_RPC_METHODS, ErpcClient, ErpcClientConfig,
    ErpcCloudClient, ErpcCloudClientConfig, ErpcError, ErpcErrorCode, RpcBatchCall,
    RpcEndpointConfig, SOLANA_ANALYTICS_METHODS, SOLANA_DAS_METHODS, SOLANA_HISTORY_METHODS,
    SOLANA_LEADER_METHODS, SOLANA_RPC_METHODS, SlotStatsOptions,
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

fn rpc_result(id: u64, result: &Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    }))
}

async fn mount_rpc_result(
    server: &MockServer,
    id: u64,
    rpc_method: &str,
    params: &Value,
    result: &Value,
) {
    Mock::given(method("POST"))
        .and(path("/"))
        .and(query_param("api-key", "key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": rpc_method,
            "params": params
        })))
        .respond_with(rpc_result(id, result))
        .expect(1)
        .mount(server)
        .await;
}

const OPAQUE_SIGNATURE: &str = "opaque-signature";

fn solana_v1_transaction_options() -> Value {
    json!({
        "commitment": "finalized",
        "encoding": "json",
        "maxSupportedTransactionVersion": 1
    })
}

fn solana_v1_block_options() -> Value {
    json!({
        "commitment": "finalized",
        "encoding": "json",
        "maxSupportedTransactionVersion": 1,
        "rewards": true,
        "transactionDetails": "full"
    })
}

fn solana_zero_transaction_options() -> Value {
    json!({
        "commitment": "finalized",
        "encoding": "json",
        "maxSupportedTransactionVersion": 0
    })
}

fn solana_zero_block_options() -> Value {
    json!({
        "commitment": "finalized",
        "encoding": "json",
        "maxSupportedTransactionVersion": 0,
        "rewards": true,
        "transactionDetails": "full"
    })
}

fn solana_v1_transaction_fixture() -> Value {
    json!({
        "blockTime": 1_700_000_001,
        "meta": {
            "err": null,
            "fee": 5000,
            "unrelatedField": {"preserve": true}
        },
        "slot": 42,
        "transaction": {
            "message": {
                "accountKeys": [],
                "header": {
                    "numReadonlySignedAccounts": 0,
                    "numReadonlyUnsignedAccounts": 0,
                    "numRequiredSignatures": 1
                },
                "instructions": [],
                "recentBlockhash": "opaque-blockhash",
                "transactionConfig": {
                    "computeUnitLimit": 30_000,
                    "loadedAccountsDataSizeLimit": 200_000,
                    "heapSize": null,
                    "priorityFee": null,
                    "unrelatedField": {"preserve": true}
                }
            },
            "signatures": [OPAQUE_SIGNATURE]
        },
        "version": 1,
        "unrelatedResponseField": ["preserve", 7]
    })
}

fn solana_v1_numeric_priority_fee_transaction_fixture() -> Value {
    let mut fixture = solana_v1_transaction_fixture();
    *fixture
        .pointer_mut("/transaction/message/transactionConfig/priorityFee")
        .expect("v1 fixture includes priorityFee") = json!(5000);
    fixture
}

fn solana_v1_block_fixture() -> Value {
    json!({
        "blockHeight": 900,
        "blockTime": 1_700_000_001,
        "blockhash": "opaque-blockhash",
        "parentSlot": 41,
        "previousBlockhash": "opaque-parent-blockhash",
        "rewards": [],
        "transactions": [
            solana_v1_transaction_fixture(),
            solana_v1_numeric_priority_fee_transaction_fixture()
        ],
        "unrelatedBlockField": {"preserve": true}
    })
}

fn solana_legacy_transaction_fixture() -> Value {
    json!({
        "blockTime": null,
        "meta": {"err": null, "fee": 5000},
        "slot": 42,
        "transaction": {
            "message": {
                "accountKeys": [],
                "instructions": [],
                "recentBlockhash": "legacy-blockhash"
            },
            "signatures": ["legacy-signature"]
        },
        "version": "legacy"
    })
}

fn solana_v0_transaction_fixture() -> Value {
    json!({
        "blockTime": null,
        "meta": {"err": null, "fee": 5000},
        "slot": 42,
        "transaction": {
            "message": {
                "accountKeys": [],
                "addressTableLookups": [],
                "instructions": [],
                "recentBlockhash": "v0-blockhash"
            },
            "signatures": ["v0-signature"]
        },
        "version": 0
    })
}

async fn mount_solana_version_fixtures(server: &MockServer) {
    let v1_transaction_options = solana_v1_transaction_options();
    let v1_block_options = solana_v1_block_options();
    let zero_transaction_options = solana_zero_transaction_options();
    let zero_block_options = solana_zero_block_options();
    let v1_transaction = solana_v1_transaction_fixture();
    let v1_block = solana_v1_block_fixture();
    let legacy_transaction = solana_legacy_transaction_fixture();
    let v0_transaction = solana_v0_transaction_fixture();

    let v1_transaction_params = json!([OPAQUE_SIGNATURE, v1_transaction_options]);
    mount_rpc_result(
        server,
        1,
        "getTransaction",
        &v1_transaction_params,
        &v1_transaction,
    )
    .await;
    let v1_block_params = json!([4242, v1_block_options]);
    mount_rpc_result(server, 2, "getBlock", &v1_block_params, &v1_block).await;
    let zero_transaction_params = json!([OPAQUE_SIGNATURE, zero_transaction_options]);
    mount_rpc_result(
        server,
        3,
        "getTransaction",
        &zero_transaction_params,
        &legacy_transaction,
    )
    .await;
    let omitted_transaction_params = json!([OPAQUE_SIGNATURE]);
    mount_rpc_result(
        server,
        4,
        "getTransaction",
        &omitted_transaction_params,
        &v0_transaction,
    )
    .await;
    let zero_block_params = json!([4242, zero_block_options]);
    mount_rpc_result(server, 5, "getBlock", &zero_block_params, &Value::Null).await;
    let omitted_block_params = json!([4242]);
    mount_rpc_result(server, 6, "getBlock", &omitted_block_params, &Value::Null).await;
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

#[tokio::test]
async fn avalanche_native_and_index_namespaces_preserve_wire_routes() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/ava"))
        .and(query_param("api-key", "test-key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "platform.getHeight"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"height": "123"}
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/ava/ext/index/X/tx"))
        .and(query_param("api-key", "test-key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "index.getContainerByID",
            "params": {"id": "tx-id"}
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"id": "tx-id"}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(config(&server, "test-key")).unwrap();
    assert_eq!(
        client.avalanche.p_chain.get_height().send().await.unwrap(),
        json!({"height": "123"})
    );
    assert_eq!(
        client
            .avalanche
            .index
            .x_chain_transactions
            .get_container_by_id(json!({"id": "tx-id"}))
            .unwrap()
            .send()
            .await
            .unwrap(),
        json!({"id": "tx-id"})
    );
    assert!(matches!(
        client
            .avalanche
            .x_chain
            .batch(vec![RpcBatchCall::without_params("avm.getHeight")]),
        Err(ErpcError::BatchPolicy(_))
    ));
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
    assert_eq!(AVALANCHE_AVAX_METHODS.len(), 4);
    assert_eq!(AVALANCHE_X_CHAIN_METHODS.len(), 11);
    assert_eq!(AVALANCHE_P_CHAIN_METHODS.len(), 26);
    assert_eq!(AVALANCHE_PROPOSER_VM_METHODS.len(), 2);
    assert_eq!(AVALANCHE_INFO_METHODS.len(), 1);
    assert_eq!(AVALANCHE_INDEX_METHODS.len(), 6);
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
async fn direct_rpc_preserves_request_target_and_isolated_headers() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/customer/path"))
        .and(query_param("token", "a/b"))
        .and(query_param("region", "eu"))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": "ok"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_header("x-global", "global-secret")
            .with_solana_rpc(
                RpcEndpointConfig::new(format!(
                    "{}/customer/path?token=a%2Fb&region=eu",
                    server.uri()
                ))
                .with_header("authorization", "Bearer scoped-secret"),
            ),
    )
    .unwrap();
    assert_eq!(client.solana.rpc.get_health().send().await.unwrap(), "ok");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let request_url = requests[0].url.to_string();
    assert!(request_url.contains("/customer/path?token=a%2Fb&region=eu"));
    assert!(!request_url.contains("api-key"));
    assert!(!requests[0].headers.contains_key("x-global"));

    let error = client.ethereum.rpc.eth_chain_id().send().await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::NotConfigured);
    assert!(error.to_string().contains("ethereum.rpc"));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);

    let error = client.price.get_price_feeds(None, None).await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::NotConfigured);
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn mixed_direct_and_legacy_transports_keep_headers_and_routes_scoped() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/customer/solana"))
        .and(header("x-node-scope", "solana-only"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": "ok"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/eth"))
        .and(query_param("api-key", "shared-key"))
        .and(header("x-global", "legacy-only"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": "0x1"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/price_feeds"))
        .and(header("x-global", "legacy-only"))
        .and(header("authorization", "Bearer shared-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("shared-key")
            .with_endpoint(server.uri())
            .with_header("x-global", "legacy-only")
            .with_solana_rpc(
                RpcEndpointConfig::new(format!("{}/customer/solana", server.uri()))
                    .with_header("x-node-scope", "solana-only"),
            ),
    )
    .unwrap();
    assert_eq!(client.solana.rpc.get_health().send().await.unwrap(), "ok");
    assert_eq!(
        client.ethereum.rpc.eth_chain_id().send().await.unwrap(),
        "0x1"
    );
    assert!(
        client
            .price
            .get_price_feeds(None, None)
            .await
            .unwrap()
            .is_empty()
    );

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3);
    let direct = requests
        .iter()
        .find(|request| request.url.path() == "/customer/solana")
        .expect("direct request");
    assert!(direct.headers.contains_key("x-node-scope"));
    assert!(!direct.headers.contains_key("x-global"));
    let legacy = requests
        .iter()
        .find(|request| request.url.path() == "/eth")
        .expect("legacy RPC request");
    assert!(legacy.headers.contains_key("x-global"));
    assert!(!legacy.headers.contains_key("x-node-scope"));
    let rest = requests
        .iter()
        .find(|request| request.url.path() == "/v2/price_feeds")
        .expect("legacy REST request");
    assert!(rest.headers.contains_key("x-global"));
    assert!(!rest.headers.contains_key("x-node-scope"));
}

#[tokio::test]
async fn direct_rpc_errors_redact_query_and_scoped_credentials() {
    let server = MockServer::start().await;
    let full_header = "Authorization: Bearer scoped/secret";
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": format!(
                    "{full_header} scoped/secret scoped%2Fsecret a/b a%2Fb"
                ),
                "data": {
                    full_header: "Bearer scoped/secret",
                    "query": "a/b a%2Fb"
                }
            }
        })))
        .mount(&server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_solana_rpc(
            RpcEndpointConfig::new(format!("{}/customer/path?token=a%2Fb", server.uri()))
                .with_header("authorization", "Bearer scoped/secret"),
        ),
    )
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    let rendered = format!("{error:?}");
    for secret in [
        "scoped/secret",
        "scoped%2Fsecret",
        "a/b",
        "a%2Fb",
        full_header,
    ] {
        assert!(!rendered.contains(secret), "leaked {secret}: {rendered}");
    }
    assert!(rendered.contains("[REDACTED]"));
}

#[tokio::test]
async fn malformed_direct_response_does_not_retain_native_error_or_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw("{\"provider\":\"malformed-secret\"", "application/json"),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_solana_rpc(RpcEndpointConfig::new(format!("{}/rpc", server.uri()))),
    )
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    assert!(!error.to_string().contains("malformed-secret"));
    assert!(!format!("{error:?}").contains("malformed-secret"));
    assert!(std::error::Error::source(&error).is_none());
}

#[tokio::test]
async fn direct_http_does_not_follow_redirects_or_forward_credentials() {
    let redirect_server = MockServer::start().await;
    let destination_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rpc"))
        .and(header("x-node-secret", "redirect-secret"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("location", format!("{}/target", destination_server.uri())),
        )
        .expect(1)
        .mount(&redirect_server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_solana_rpc(
            RpcEndpointConfig::new(format!("{}/rpc", redirect_server.uri()))
                .with_header("x-node-secret", "redirect-secret"),
        ),
    )
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
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
async fn direct_basic_credentials_redact_decoded_parts_and_variants() {
    let server = MockServer::start().await;
    let component = "Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=";
    let basic_value = format!("Basic {component}");
    let full_header = format!("Authorization: {basic_value}");
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": format!(
                    "{full_header} {component} fixture-user:fixture-password \
                     fixture-user fixture-password fixture-user%3Afixture-password"
                ),
                "data": {
                    full_header.clone(): full_header.clone(),
                    component: component,
                    "fixture-user:fixture-password": "fixture-user:fixture-password",
                    "fixture-user": "fixture-password",
                    "fixture-user%3Afixture-password": "fixture-password"
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_solana_rpc(
            RpcEndpointConfig::new(format!("{}/rpc", server.uri()))
                .with_header("authorization", basic_value),
        ),
    )
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    let display = error.to_string();
    let debug = format!("{error:?}");
    for secret in [
        "Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=",
        "fixture-user:fixture-password",
        "fixture-user%3Afixture-password",
        "fixture-user",
        "fixture-password",
    ] {
        assert!(!display.contains(secret), "leaked {secret}: {display}");
        assert!(!debug.contains(secret), "leaked {secret}: {debug}");
    }
}

#[tokio::test]
async fn direct_non_ascii_header_credentials_are_redacted() {
    let server = MockServer::start().await;
    let secret = "fixture-MiXeD-é-secret";
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": format!(
                    "{secret} fixture-MiXeD-%C3%A9-secret fixture-MiXeD-%c3%a9-secret"
                ),
                "data": {
                    secret: secret,
                    "fixture-MiXeD-%C3%A9-secret": "fixture-MiXeD-%c3%a9-secret",
                    "fixture-MiXeD-%c3%A9-secret": secret
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(
        ErpcClientConfig::for_rpc().with_solana_rpc(
            RpcEndpointConfig::new(format!("{}/rpc", server.uri()))
                .with_header("x-node-secret", secret),
        ),
    )
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    let display = error.to_string();
    let debug = format!("{error:?}");
    for value in [
        secret,
        "fixture-MiXeD-%C3%A9-secret",
        "fixture-MiXeD-%c3%a9-secret",
    ] {
        assert!(!display.contains(value), "leaked {value}: {display}");
        assert!(!debug.contains(value), "leaked {value}: {debug}");
    }
}

#[tokio::test]
async fn direct_redaction_matches_percent_hex_case_without_lowercasing_plaintext() {
    let server = MockServer::start().await;
    let secret = "MiXeD/Secret+";
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": format!(
                    "{secret} MiXeD%2FSecret%2B MiXeD%2fSecret%2b \
                     MiXeD%2FSecret%2b mixed%2fsecret%2b"
                ),
                "data": {
                    "MiXeD/Secret+": "MiXeD/Secret+",
                    "MiXeD%2FSecret%2B": "MiXeD%2fSecret%2b",
                    "MiXeD%2FSecret%2b": "mixed%2fsecret%2b",
                    "mixed%2fsecret%2b": "mixed%2fsecret%2b"
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let client = ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc(
        RpcEndpointConfig::new(format!("{}/rpc", server.uri())).with_header("x-secret", secret),
    ))
    .unwrap();
    let error = client.solana.rpc.get_health().send().await.unwrap_err();
    let rendered = format!("{error:?}");
    for value in [
        secret,
        "MiXeD%2FSecret%2B",
        "MiXeD%2fSecret%2b",
        "MiXeD%2FSecret%2b",
    ] {
        assert!(!rendered.contains(value), "leaked {value}: {rendered}");
    }
    assert!(rendered.contains("mixed%2fsecret%2b"));
}

#[tokio::test]
async fn avalanche_direct_c_chain_is_separate_from_native_transport() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/customer/avax"))
        .and(query_param("token", "a/b"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_chainId",
            "params": []
        })))
        .respond_with(rpc_result(1, &json!("0xa86a")))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/ava"))
        .and(query_param("api-key", "key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "platform.getHeight"
        })))
        .respond_with(rpc_result(1, &json!({"height": "123"})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/ava/ext/index/X/tx"))
        .and(query_param("api-key", "key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "index.getContainerByID",
            "params": {"id": "tx-id"}
        })))
        .respond_with(rpc_result(1, &json!({"id": "tx-id"})))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_endpoint(server.uri())
            .with_avalanche_endpoint(server.uri())
            .with_avalanche_c_rpc(RpcEndpointConfig::new(format!(
                "{}/customer/avax?token=a%2Fb",
                server.uri()
            ))),
    )
    .unwrap();
    assert_eq!(
        client.avalanche.rpc.eth_chain_id().send().await.unwrap(),
        "0xa86a"
    );
    assert_eq!(
        client.avalanche.p_chain.get_height().send().await.unwrap(),
        json!({"height": "123"})
    );
    assert_eq!(
        client
            .avalanche
            .index
            .x_chain_transactions
            .get_container_by_id(json!({"id": "tx-id"}))
            .unwrap()
            .send()
            .await
            .unwrap(),
        json!({"id": "tx-id"})
    );
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().any(|request| {
        let url = request.url.to_string();
        url.contains("/customer/avax?token=a%2Fb") && !url.contains("api-key")
    }));
    assert!(requests.iter().any(|request| request.url.path() == "/ava"));
}

#[test]
fn direct_url_validation_requires_safe_absolute_targets() {
    for value in [
        "https:opaque?token=direct-secret",
        "https://user:direct-secret@example.invalid/rpc",
        "https://@example.invalid/rpc",
        "http://:123/rpc",
        "https://example.invalid/rpc#",
        "https://example.invalid/rpc?token=direct-secret#fragment",
    ] {
        let error = ErpcClient::new(
            ErpcClientConfig::for_rpc().with_solana_rpc(RpcEndpointConfig::new(value)),
        )
        .err()
        .expect("invalid direct URL must fail");
        assert_eq!(error.code(), ErpcErrorCode::Config);
        assert!(!error.to_string().contains("direct-secret"));
    }
    let config = RpcEndpointConfig::new("https://example.invalid/rpc?token=direct-secret")
        .with_header("authorization", "Bearer header-secret");
    let rendered = format!("{config:?}");
    assert!(!rendered.contains("direct-secret"));
    assert!(!rendered.contains("header-secret"));
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
async fn solana_transaction_methods_preserve_v1_payloads_and_version_options() {
    let server = MockServer::start().await;
    mount_solana_version_fixtures(&server).await;

    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let received_v1_transaction = client
        .solana
        .rpc
        .get_transaction(json!([OPAQUE_SIGNATURE, solana_v1_transaction_options()]))
        .unwrap()
        .send()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received_v1_transaction, solana_v1_transaction_fixture());

    let received_v1_block = client
        .solana
        .rpc
        .get_block(json!([4242, solana_v1_block_options()]))
        .unwrap()
        .send()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received_v1_block, solana_v1_block_fixture());

    let received_legacy = client
        .solana
        .rpc
        .get_transaction(json!([OPAQUE_SIGNATURE, solana_zero_transaction_options()]))
        .unwrap()
        .send()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received_legacy, solana_legacy_transaction_fixture());
    assert!(
        received_legacy
            .pointer("/transaction/message/transactionConfig")
            .is_none()
    );

    let received_v0 = client
        .solana
        .rpc
        .get_transaction([OPAQUE_SIGNATURE])
        .unwrap()
        .send()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received_v0, solana_v0_transaction_fixture());
    assert!(
        received_v0
            .pointer("/transaction/message/transactionConfig")
            .is_none()
    );

    assert!(
        client
            .solana
            .rpc
            .get_block(json!([4242, solana_zero_block_options()]))
            .unwrap()
            .send()
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        client
            .solana
            .rpc
            .get_block([4242])
            .unwrap()
            .send()
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn solana_transaction_submission_and_simulation_forward_large_base64_once() {
    let server = MockServer::start().await;
    // Synthetic opaque transport fixture for 4096 zero bytes: this is NOT a valid
    // signed transaction and is NOT proof of chain acceptance.
    let transaction = format!("{}==", "A".repeat(5462));
    assert_eq!(transaction.len(), 5464);
    assert_eq!((transaction.len() / 4) * 3 - 2, 4096);
    let options = json!({"encoding": "base64"});

    let send_params = json!([transaction.clone(), options.clone()]);
    let send_result = json!("synthetic-signature");
    mount_rpc_result(&server, 1, "sendTransaction", &send_params, &send_result).await;
    let simulate_params = json!([transaction.clone(), options]);
    let simulate_result = json!({"err": null, "logs": [], "unrelatedField": "preserve"});
    mount_rpc_result(
        &server,
        2,
        "simulateTransaction",
        &simulate_params,
        &simulate_result,
    )
    .await;

    let client = ErpcClient::new(config(&server, "key")).unwrap();
    assert_eq!(
        client
            .solana
            .rpc
            .send_transaction(json!([transaction.clone(), options.clone()]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        "synthetic-signature"
    );
    assert_eq!(
        client
            .solana
            .rpc
            .simulate_transaction(json!([transaction, options]))
            .unwrap()
            .send()
            .await
            .unwrap(),
        simulate_result
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn solana_transaction_version_rpc_error_surfaces_once_without_fallback() {
    let server = MockServer::start().await;
    let error_data = json!({
        "maxSupportedTransactionVersion": 1,
        "unrelatedField": {"preserve": true}
    });
    Mock::given(method("POST"))
        .and(path("/"))
        .and(query_param("api-key", "key"))
        .and(body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": ["opaque-signature", {"maxSupportedTransactionVersion": 0}]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32015,
                "message": "Transaction version is unsupported",
                "data": error_data.clone()
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = ErpcClient::new(config(&server, "key")).unwrap();
    let error = client
        .solana
        .rpc
        .get_transaction(json!(["opaque-signature", {"maxSupportedTransactionVersion": 0}]))
        .unwrap()
        .send()
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ErpcError::JsonRpc {
            code: -32015,
            ref message,
            ref data
        } if message == "Transaction version is unsupported" && data == &Some(error_data)
    ));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
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
