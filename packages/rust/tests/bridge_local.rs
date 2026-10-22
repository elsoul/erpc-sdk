#![allow(missing_docs)]

use erpc_sdk::{
    BridgeErrorCode, MayanSwiftV2BridgeClient, MayanSwiftV2BridgeConfig,
    MayanSwiftV2LocalBuildConfig, MayanSwiftV2LocalBuildRequest, MayanSwiftV2LocalContext,
    MayanSwiftV2LocalSourceSwapPlan, MayanSwiftV2Quote, RpcEndpointConfig,
};
use std::collections::HashMap;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate, matchers::method};

const LOCAL_FIXTURE: &str =
    include_str!("../../../registry/fixtures/mayan-swift-v2-local-build-cases.json");

fn usdc_quote() -> MayanSwiftV2Quote {
    let fixture: serde_json::Value = serde_json::from_str(LOCAL_FIXTURE).expect("local fixture");
    serde_json::from_value(fixture["quotes"][2]["normalizedQuote"].clone()).expect("USDC quote")
}

fn b64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

struct RpcResponder {
    responses: HashMap<String, String>,
}

impl Respond for RpcResponder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body = String::from_utf8(request.body.clone()).expect("RPC request UTF-8");
        ResponseTemplate::new(200).set_body_string(
            self.responses
                .get(&body)
                .expect("RPC request body is covered")
                .clone(),
        )
    }
}

#[allow(clippy::too_many_lines)]
async fn malformed_alt_build(malformed: Vec<u8>) -> BridgeErrorCode {
    let fixture: serde_json::Value = serde_json::from_str(LOCAL_FIXTURE).expect("local fixture");
    let build_case = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["caseId"] == "build-usdc-solana-alt-start-index-out-of-range")
        .expect("ALT regression case");
    let quote = {
        let mut quote = serde_json::from_value::<MayanSwiftV2Quote>(
            fixture["quotes"]
                .as_array()
                .expect("quotes")
                .iter()
                .find(|entry| entry["quoteId"] == build_case["quoteId"])
                .expect("ALT quote")["normalizedQuote"]
                .clone(),
        )
        .expect("ALT normalized quote");
        let deadline = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs()
            + 600)
            .to_string();
        quote.raw_signed_quote_json =
            quote
                .raw_signed_quote_json
                .replacen(&quote.deadline, &deadline, 1);
        quote.deadline = deadline;
        quote
    };
    let context = MayanSwiftV2LocalContext {
        quote: quote.clone(),
        swapper_address: build_case["context"]["swapperAddress"]
            .as_str()
            .expect("swapper")
            .to_owned(),
        destination_address: build_case["context"]["destinationAddress"]
            .as_str()
            .expect("destination")
            .to_owned(),
        order_nonce: build_case["context"]["orderNonce"]
            .as_str()
            .expect("nonce")
            .to_owned(),
    };
    let prepare_client =
        MayanSwiftV2BridgeClient::new(MayanSwiftV2BridgeConfig::new()).expect("prepare client");
    let plan = prepare_client
        .prepare_source_swap(context.clone())
        .await
        .expect("direct USDC plan");

    let rpc_server = MockServer::start().await;
    let mut responses = HashMap::new();
    for mock_id in build_case["rpcMockIds"].as_array().expect("RPC IDs") {
        let mock_id = mock_id.as_str().expect("RPC mock ID");
        let mock = fixture["rpcMocks"]
            .as_array()
            .expect("RPC mocks")
            .iter()
            .find(|mock| mock["mockId"] == mock_id)
            .expect("RPC mock");
        let request_body = mock["request"]["body"]
            .as_str()
            .expect("RPC request body")
            .to_owned();
        let mut response: serde_json::Value =
            serde_json::from_str(mock["response"]["body"].as_str().expect("RPC response"))
                .expect("RPC response JSON");
        if request_body.contains("getMultipleAccounts") {
            response["result"]["value"][0]["data"][0] = serde_json::Value::String(b64(&malformed));
        }
        responses.insert(
            request_body,
            serde_json::to_string(&response).expect("RPC response serializes"),
        );
    }
    Mock::given(method("POST"))
        .respond_with(RpcResponder { responses })
        .mount(&rpc_server)
        .await;
    let client = MayanSwiftV2BridgeClient::new(
        MayanSwiftV2BridgeConfig::new().with_local_build(
            MayanSwiftV2LocalBuildConfig::new()
                .with_solana_rpc(RpcEndpointConfig::new(rpc_server.uri())),
        ),
    )
    .expect("build client");
    let error = client
        .build_local_unsigned(MayanSwiftV2LocalBuildRequest {
            quote,
            swapper_address: context.swapper_address,
            destination_address: context.destination_address,
            order_nonce: context.order_nonce,
            source_swap_plan: plan,
        })
        .await
        .expect_err("malformed ALT must be rejected");
    assert_eq!(
        rpc_server
            .received_requests()
            .await
            .expect("received requests")
            .len(),
        3
    );
    error.code()
}

#[tokio::test]
async fn direct_usdc_preparation_is_keyless_and_rpc_free() {
    let mut quote = usdc_quote();
    let deadline = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
        + 600)
        .to_string();
    quote.raw_signed_quote_json =
        quote
            .raw_signed_quote_json
            .replacen(&quote.deadline, &deadline, 1);
    quote.deadline = deadline;
    let client =
        MayanSwiftV2BridgeClient::new(MayanSwiftV2BridgeConfig::new()).expect("bridge client");
    let plan = client
        .prepare_source_swap(MayanSwiftV2LocalContext {
            quote,
            swapper_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            destination_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            order_nonce: "0x112233445566778899aabbccddeeff00".to_owned(),
        })
        .await
        .expect("direct USDC plan");
    assert!(matches!(
        plan.source_swap,
        MayanSwiftV2LocalSourceSwapPlan::None {}
    ));
}

#[tokio::test]
async fn malformed_nonce_is_rejected_before_local_io() {
    let client =
        MayanSwiftV2BridgeClient::new(MayanSwiftV2BridgeConfig::new()).expect("bridge client");
    let mut quote = usdc_quote();
    let deadline = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
        + 600)
        .to_string();
    quote.raw_signed_quote_json =
        quote
            .raw_signed_quote_json
            .replacen(&quote.deadline, &deadline, 1);
    quote.deadline = deadline;
    let error = client
        .prepare_source_swap(MayanSwiftV2LocalContext {
            quote,
            swapper_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            destination_address: "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b".to_owned(),
            order_nonce: "0x00".to_owned(),
        })
        .await
        .expect_err("invalid nonce");
    assert_eq!(error.code(), BridgeErrorCode::LocalPlanInvalid);
}

#[tokio::test]
async fn public_build_rejects_zero_deactivation_empty_alt() {
    let mut data = vec![0_u8; 56];
    data[0] = 1;
    assert_eq!(
        malformed_alt_build(data).await,
        BridgeErrorCode::SourceRpcInvalidResponse
    );
}

#[tokio::test]
async fn public_build_rejects_forged_56_byte_alt_metadata() {
    let mut data = vec![0_u8; 56];
    data[0] = 1;
    data[4..8].fill(0xff);
    data[8..16].fill(0xaa);
    assert_eq!(
        malformed_alt_build(data).await,
        BridgeErrorCode::SourceRpcInvalidResponse
    );
}
