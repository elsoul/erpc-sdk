#![allow(missing_docs)]

use erpc_sdk::{
    BridgeErrorCode, MayanSwiftV2BridgeClient, MayanSwiftV2BridgeConfig, MayanSwiftV2BuildRequest,
    MayanSwiftV2QuoteRequest, MayanSwiftV2StatusRequest, MayanSwiftV2UnsignedTransaction,
};
use serde_json::Value;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

const FIXTURE: &str = include_str!("../../../registry/fixtures/mayan-swift-v2-cases.json");
const SOLANA_FEE_PAYER: &str = "So11111111111111111111111111111111111111112";
const SOLANA_DESTINATION: &str = SOLANA_FEE_PAYER;

fn fixture_case(case_id: &str) -> Value {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("bridge fixture JSON");
    fixture["cases"]
        .as_array()
        .expect("bridge fixture cases")
        .iter()
        .find(|case| case["caseId"] == case_id)
        .cloned()
        .expect("bridge fixture case")
}

fn quote_request(case_id: &str) -> MayanSwiftV2QuoteRequest {
    serde_json::from_value(fixture_case(case_id)["request"].clone()).expect("quote request")
}

fn rpc_response(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "application/json")
        .set_body_string(body)
}

fn client(server: &MockServer) -> MayanSwiftV2BridgeClient {
    MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(server.uri())
            .with_explorer_endpoint(server.uri()),
    )
    .expect("bridge client")
}

#[tokio::test]
async fn quote_preserves_signed_object_and_provider_number_lexeme() {
    let server = MockServer::start().await;
    let case = fixture_case("quote-eth-sol-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            case["providerBody"].as_str().expect("provider body"),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let quote = client(&server)
        .quote_exact_input(quote_request("quote-eth-sol-synthetic"))
        .await
        .expect("quote");
    assert_eq!(quote.len(), 1);
    assert_eq!(quote[0].quote_kind, "mayan-swift-v2");
    assert_eq!(quote[0].amount_in, "100000000");
    assert_eq!(quote[0].expected_amount_out, "99557029");
    assert_eq!(quote[0].source_swap.provider_minimum_amount, "114.5000");
    assert!(
        quote[0]
            .raw_signed_quote_json
            .contains("\"unknownSignedField\":\"keep-me\"")
    );
    assert!(
        quote[0]
            .raw_signed_quote_json
            .contains("\"minMiddleAmount\":114.5000")
    );
}

#[tokio::test]
async fn usdc_quote_uses_direct_source_and_nullable_router_fields() {
    let server = MockServer::start().await;
    let case = fixture_case("quote-usdc-eth-sol-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            case["providerBody"].as_str().expect("provider body"),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let quote = client(&server)
        .quote_exact_input(quote_request("quote-usdc-eth-sol-synthetic"))
        .await
        .expect("USDC quote")
        .pop()
        .expect("one quote");
    assert!(!quote.source_swap.required);
    assert_eq!(
        quote.source_swap.input_token_deployment_id,
        "deployment-0008"
    );
    assert_eq!(
        quote.source_swap.intermediate_token_address,
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    );
    assert_eq!(quote.source_swap.provider_minimum_amount, "100.0000");
    assert!(quote.source_swap.router_kind.is_none());
    assert!(quote.source_swap.router_address.is_none());
    assert!(
        !quote
            .dependencies
            .iter()
            .any(|dependency| dependency == "mayan-hosted-source-swap-builder")
    );
    assert!(
        quote
            .raw_signed_quote_json
            .contains("A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM")
    );
}

#[tokio::test]
async fn usdc_evm_build_uses_direct_selector_and_source_allowance() {
    let quote_server = MockServer::start().await;
    let quote_case = fixture_case("quote-usdc-eth-sol-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            quote_case["providerBody"].as_str().expect("quote body"),
        ))
        .expect(1)
        .mount(&quote_server)
        .await;
    let quote = client(&quote_server)
        .quote_exact_input(quote_request("quote-usdc-eth-sol-synthetic"))
        .await
        .expect("USDC quote")
        .pop()
        .expect("one quote");

    let build_server = MockServer::start().await;
    let build_case = fixture_case("build-usdc-eth-sol-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            build_case["providerBody"].as_str().expect("build body"),
        ))
        .expect(1)
        .mount(&build_server)
        .await;
    let build = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(build_server.uri())
            .with_explorer_endpoint(build_server.uri())
            .with_allow_unauthenticated_build(true),
    )
    .expect("bridge build client")
    .build_unsigned(MayanSwiftV2BuildRequest {
        quote,
        swapper_address: "0x2222222222222222222222222222222222222222".to_owned(),
        destination_address: SOLANA_DESTINATION.to_owned(),
        refund_address: None,
    })
    .await
    .expect("USDC build");
    let MayanSwiftV2UnsignedTransaction::Evm(transaction) = build.transaction else {
        panic!("USDC Ethereum build must return an EVM transaction");
    };
    assert!(transaction.data.starts_with("0xe4269fc4"));
    let allowance = build.allowance.expect("Ethereum allowance");
    assert_eq!(allowance.token_deployment_id, "deployment-0008");
    assert_eq!(
        allowance.token_address,
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    );
    assert_eq!(allowance.required_amount, "100000000");
}

#[tokio::test]
async fn normalized_source_token_mutations_are_closed_and_rejected_locally() {
    for (case_id, expected_value) in [
        (
            "build-eurc-normalized-source-token-usdc-tamper",
            "deployment-0008",
        ),
        (
            "build-usdc-normalized-source-token-eurc-tamper",
            "deployment-0011",
        ),
    ] {
        let case = fixture_case(case_id);
        let mutation = case["quoteMutation"]
            .as_object()
            .expect("source token mutation descriptor");
        let mut keys = mutation.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        assert_eq!(keys, vec!["kind", "path", "value"]);
        assert_eq!(mutation["kind"], "normalized-set");
        assert_eq!(mutation["path"], "sourceTokenDeploymentId");
        assert_eq!(mutation["value"], expected_value);

        let quote_case_id = case["quoteCaseId"].as_str().expect("quote case ID");
        let quote_case = fixture_case(quote_case_id);
        let quote_server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(rpc_response(
                quote_case["providerBody"].as_str().expect("quote body"),
            ))
            .expect(1)
            .mount(&quote_server)
            .await;
        let mut quote = client(&quote_server)
            .quote_exact_input(quote_request(quote_case_id))
            .await
            .expect("base quote")
            .pop()
            .expect("one quote");
        quote.source_token_deployment_id = expected_value.to_owned();

        let error = MayanSwiftV2BridgeClient::new(
            MayanSwiftV2BridgeConfig::new()
                .with_builder_endpoint("http://127.0.0.1:1")
                .with_explorer_endpoint("http://127.0.0.1:1")
                .with_allow_unauthenticated_build(true),
        )
        .expect("bridge client")
        .build_unsigned(MayanSwiftV2BuildRequest {
            quote,
            swapper_address: case["request"]["swapperAddress"]
                .as_str()
                .expect("swapper address")
                .to_owned(),
            destination_address: case["request"]["destinationAddress"]
                .as_str()
                .expect("destination address")
                .to_owned(),
            refund_address: None,
        })
        .await
        .expect_err("cross-asset normalized quote mutation must fail locally");
        assert_eq!(error.code(), BridgeErrorCode::QuoteMismatch);
    }
}

#[tokio::test]
async fn solana_build_validates_v0_framing_and_returns_structural_envelope() {
    let server = MockServer::start().await;
    let quote_case = fixture_case("quote-sol-eth-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            quote_case["providerBody"].as_str().expect("quote body"),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let quote = client(&server)
        .quote_exact_input(quote_request("quote-sol-eth-synthetic"))
        .await
        .expect("quote")
        .pop()
        .expect("one quote");

    let build_case = fixture_case("build-sol-eth-synthetic");
    let build_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            build_case["providerBody"].as_str().expect("build body"),
        ))
        .expect(1)
        .mount(&build_server)
        .await;
    let build = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(build_server.uri())
            .with_explorer_endpoint(build_server.uri())
            .with_allow_unauthenticated_build(true),
    )
    .expect("bridge build client")
    .build_unsigned(MayanSwiftV2BuildRequest {
        quote,
        swapper_address: SOLANA_FEE_PAYER.to_owned(),
        destination_address: "0x3333333333333333333333333333333333333333".to_owned(),
        refund_address: None,
    })
    .await
    .expect("build");
    assert_eq!(build.build_kind, "mayan-swift-v2-unsigned");
    assert!(build.allowance.is_none());
    assert_eq!(build.validation.level, "structural");
    assert!(!build.validation.quote_signature_locally_verified);
}

#[tokio::test]
async fn duplicate_provider_keys_are_rejected_without_normalization() {
    let server = MockServer::start().await;
    let case = fixture_case("quote-duplicate-key");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            case["providerBody"].as_str().expect("provider body"),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let error = client(&server)
        .quote_exact_input(quote_request("quote-duplicate-key"))
        .await
        .expect_err("duplicate key must fail");
    assert_eq!(error.code(), BridgeErrorCode::ProviderInvalidResponse);
}

#[tokio::test]
async fn status_maps_indexed_state_and_normalizes_evm_hash() {
    let server = MockServer::start().await;
    let case = fixture_case("status-eth-completed-synthetic");
    Mock::given(method("GET"))
        .respond_with(rpc_response(
            case["providerBody"].as_str().expect("status body"),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let status = client(&server)
        .get_status(MayanSwiftV2StatusRequest {
            source_chain_id: "eip155:1".to_owned(),
            source_transaction_hash:
                "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
        })
        .await
        .expect("status");
    assert_eq!(status.state, "completed");
    assert_eq!(status.provider_client_status, "COMPLETED");
    assert_eq!(
        status.source_transaction_hash,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
}

#[tokio::test]
async fn unauthenticated_build_fails_locally_before_provider_io() {
    let server = MockServer::start().await;
    let quote_case = fixture_case("quote-eth-sol-synthetic");
    Mock::given(method("POST"))
        .respond_with(rpc_response(
            quote_case["providerBody"].as_str().expect("quote body"),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let quote = client(&server)
        .quote_exact_input(quote_request("quote-eth-sol-synthetic"))
        .await
        .expect("quote")
        .pop()
        .expect("one quote");
    let no_build_client = client(&server);
    let error = no_build_client
        .build_unsigned(MayanSwiftV2BuildRequest {
            quote,
            swapper_address: "0x2222222222222222222222222222222222222222".to_owned(),
            destination_address: SOLANA_DESTINATION.to_owned(),
            refund_address: None,
        })
        .await
        .expect_err("auth required");
    assert_eq!(error.code(), BridgeErrorCode::ProviderAuthRequired);
    assert_eq!(server.received_requests().await.expect("requests").len(), 1);
}

#[tokio::test]
async fn loopback_provider_redirect_is_not_followed() {
    let redirect_server = MockServer::start().await;
    let destination_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/quote"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/quote", destination_server.uri())),
        )
        .expect(1)
        .mount(&redirect_server)
        .await;
    let error = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(redirect_server.uri())
            .with_explorer_endpoint(redirect_server.uri()),
    )
    .expect("bridge client")
    .quote_exact_input(quote_request("quote-eth-sol-synthetic"))
    .await
    .expect_err("redirect must be rejected");
    assert_eq!(error.code(), BridgeErrorCode::ProviderTransport);
    assert_eq!(
        redirect_server
            .received_requests()
            .await
            .expect("requests")
            .len(),
        1
    );
    assert!(
        destination_server
            .received_requests()
            .await
            .expect("requests")
            .is_empty()
    );
}

#[tokio::test]
async fn builder_key_is_scoped_to_build_requests() {
    let quote_server = MockServer::start().await;
    let explorer_server = MockServer::start().await;
    let build_server = MockServer::start().await;
    let quote_case = fixture_case("quote-eth-sol-synthetic");
    Mock::given(method("POST"))
        .and(path("/quote"))
        .respond_with(rpc_response(
            quote_case["providerBody"].as_str().expect("quote body"),
        ))
        .expect(1)
        .mount(&quote_server)
        .await;
    let explorer_case = fixture_case("status-eth-completed-synthetic");
    Mock::given(method("GET"))
        .and(path(
            "/swap/trx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ))
        .respond_with(rpc_response(
            explorer_case["providerBody"].as_str().expect("status body"),
        ))
        .expect(1)
        .mount(&explorer_server)
        .await;
    let build_case = fixture_case("build-eth-sol-synthetic");
    Mock::given(method("POST"))
        .and(path("/build"))
        .respond_with(rpc_response(
            build_case["providerBody"].as_str().expect("build body"),
        ))
        .expect(1)
        .mount(&build_server)
        .await;
    let config = MayanSwiftV2BridgeConfig::new()
        .with_builder_endpoint(quote_server.uri())
        .with_explorer_endpoint(explorer_server.uri())
        .with_builder_api_key("synthetic-builder-key");
    let bridge = MayanSwiftV2BridgeClient::new(config).expect("bridge client");
    let quote = bridge
        .quote_exact_input(quote_request("quote-eth-sol-synthetic"))
        .await
        .expect("quote")
        .pop()
        .expect("one quote");
    let bridge = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(build_server.uri())
            .with_explorer_endpoint(explorer_server.uri())
            .with_builder_api_key("synthetic-builder-key")
            .with_allow_unauthenticated_build(true),
    )
    .expect("build client");
    let _ = bridge
        .build_unsigned(MayanSwiftV2BuildRequest {
            quote,
            swapper_address: "0x2222222222222222222222222222222222222222".to_owned(),
            destination_address: SOLANA_DESTINATION.to_owned(),
            refund_address: None,
        })
        .await
        .expect("build");
    let status_bridge = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new()
            .with_builder_endpoint(build_server.uri())
            .with_explorer_endpoint(explorer_server.uri())
            .with_builder_api_key("synthetic-builder-key"),
    )
    .expect("status client");
    let _ = status_bridge
        .get_status(MayanSwiftV2StatusRequest {
            source_chain_id: "eip155:1".to_owned(),
            source_transaction_hash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        })
        .await
        .expect("status");
    let quote_requests = quote_server
        .received_requests()
        .await
        .expect("quote requests");
    let explorer_requests = explorer_server
        .received_requests()
        .await
        .expect("explorer requests");
    let build_requests = build_server
        .received_requests()
        .await
        .expect("build requests");
    assert!(!quote_requests[0].headers.contains_key("x-api-key"));
    assert!(!explorer_requests[0].headers.contains_key("x-api-key"));
    assert_eq!(build_requests.len(), 1);
    assert_eq!(
        build_requests[0]
            .headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok()),
        Some("synthetic-builder-key")
    );
}
