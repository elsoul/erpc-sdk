#![allow(missing_docs)]

use std::time::{SystemTime, UNIX_EPOCH};

use erpc_sdk::{
    DEX_CHAIN_IDS, ErpcClient, ErpcClientConfig, ErpcError, ExactInputQuoteRequest, SwapFreshness,
    SwapQuoteError, SwapQuoteErrorCode,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, method, path, query_param},
};

const ETH_FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const ETH_POOL: &str = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
const ETH_USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETH_WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ETH_HASH: &str = "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb";
const ETH_BLOCK: &str = "0x18c7f20";

fn eth_chain_id() -> &'static str {
    DEX_CHAIN_IDS
        .iter()
        .find(|(name, _)| *name == "ethereum")
        .map_or("eip155:1", |(_, chain)| chain)
}

fn rpc_result(id: u64, result: &Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
}

fn address_word(address: &str) -> Value {
    json!(format!("0x{}{}", "00".repeat(12), &address[2..]))
}

fn uint_word(value: u128) -> String {
    format!("{value:064x}")
}

fn reserves_word(reserve0: u128, reserve1: u128) -> Value {
    json!(format!(
        "0x{}{}{}",
        uint_word(reserve0),
        uint_word(reserve1),
        uint_word(1)
    ))
}

async fn mount_eth_trace(
    server: &MockServer,
    timestamp: u64,
    second_latest_hash: Option<&str>,
    malformed_factory_pair: bool,
) {
    let header = json!({
        "number": ETH_BLOCK,
        "hash": ETH_HASH,
        "timestamp": format!("0x{timestamp:x}"),
    });
    let second_header = json!({
        "number": ETH_BLOCK,
        "hash": second_latest_hash.unwrap_or(ETH_HASH),
        "timestamp": format!("0x{timestamp:x}"),
    });
    let pair = if malformed_factory_pair {
        json!(format!("{}00", address_word(ETH_POOL).as_str().unwrap()))
    } else {
        address_word(ETH_POOL)
    };
    let entries = vec![
        ("eth_chainId", json!([]), json!("0x1")),
        (
            "eth_getBlockByNumber",
            json!(["latest", false]),
            header.clone(),
        ),
        (
            "eth_getCode",
            json!([ETH_FACTORY, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            json!("0x6000"),
        ),
        (
            "eth_getCode",
            json!([ETH_POOL, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            json!("0x6000"),
        ),
        (
            "eth_call",
            json!([{"to": ETH_FACTORY, "data": "0xe6a43905000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"}, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            pair,
        ),
        (
            "eth_call",
            json!([{"to": ETH_POOL, "data": "0xc45a0155"}, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            address_word(ETH_FACTORY),
        ),
        (
            "eth_call",
            json!([{"to": ETH_POOL, "data": "0x0dfe1681"}, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            address_word(ETH_USDC),
        ),
        (
            "eth_call",
            json!([{"to": ETH_POOL, "data": "0xd21220a7"}, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            address_word(ETH_WETH),
        ),
        (
            "eth_call",
            json!([{"to": ETH_POOL, "data": "0x0902f1ac"}, {"blockHash": ETH_HASH, "requireCanonical": true}]),
            reserves_word(9_922_163_268_622, 4_131_396_377_933_182_743_090),
        ),
        (
            "eth_getBlockByNumber",
            json!(["latest", false]),
            second_header,
        ),
        ("eth_getBlockByNumber", json!([ETH_BLOCK, false]), header),
    ];
    for (index, (rpc_method, params, result)) in entries.into_iter().enumerate() {
        let id = u64::try_from(index + 1).expect("small request id");
        Mock::given(method("POST"))
            .and(path("/eth"))
            .and(query_param("api-key", "key"))
            .and(body_json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": rpc_method,
                "params": params,
            })))
            .respond_with(rpc_result(id, &result))
            .expect(1)
            .mount(server)
            .await;
    }
}

fn request_body(request: &wiremock::Request) -> String {
    String::from_utf8_lossy(&request.body).into_owned()
}

fn ethereum_request() -> ExactInputQuoteRequest {
    ExactInputQuoteRequest {
        chain_id: eth_chain_id().to_owned(),
        pool_definition_id: "pool-0001".to_owned(),
        input_token_deployment_id: "deployment-0002".to_owned(),
        output_token_deployment_id: "deployment-0008".to_owned(),
        amount_in: "1000000000000000000".to_owned(),
        freshness: None,
    }
}

fn config(server: &MockServer) -> ErpcClientConfig {
    ErpcClientConfig::new("key")
        .with_endpoint(server.uri())
        .with_avalanche_endpoint(server.uri())
        .with_account_endpoint(server.uri())
        .with_user_endpoint(server.uri())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after Unix epoch")
        .as_secs()
}

#[tokio::test]
async fn quote_uses_exact_eip1898_sequence_and_decimal_result() {
    let server = MockServer::start().await;
    let timestamp = now_seconds();
    mount_eth_trace(&server, timestamp, None, false).await;
    let client = ErpcClient::new(config(&server)).expect("client");

    let quote = client
        .swap
        .quote_exact_input(ethereum_request())
        .await
        .expect("quote");
    assert_eq!(quote.quote_kind, "exact-input");
    assert_eq!(quote.amount_in, "1000000000000000000");
    assert_eq!(quote.amount_out, "2393866186");
    assert_eq!(quote.fee.numerator, "3");
    assert_eq!(quote.fee.denominator, "1000");
    assert_eq!(quote.snapshot.block_number, "25984800");
    assert_eq!(quote.snapshot.block_hash, ETH_HASH);
    assert_eq!(quote.snapshot.block_timestamp, timestamp.to_string());

    let requests = server.received_requests().await.expect("requests");
    assert_eq!(requests.len(), 11);
    assert!(request_body(&requests[0]).contains("eth_chainId"));
    assert!(request_body(&requests[1]).contains("latest"));
    assert!(request_body(&requests[2]).contains("requireCanonical"));
    assert!(request_body(&requests[10]).contains(ETH_BLOCK));
}

#[tokio::test]
async fn catalog_validation_fails_before_rpc_and_preserves_precedence() {
    let server = MockServer::start().await;
    let client = ErpcClient::new(config(&server)).expect("client");

    let mut request = ethereum_request();
    request.chain_id = "eip155:999".to_owned();
    assert_eq!(
        client
            .swap
            .quote_exact_input(request)
            .await
            .unwrap_err()
            .code(),
        Some(SwapQuoteErrorCode::UnsupportedChain)
    );
    let mut request = ethereum_request();
    request.input_token_deployment_id = "deployment-0001".to_owned();
    assert_eq!(
        client
            .swap
            .quote_exact_input(request)
            .await
            .unwrap_err()
            .code(),
        Some(SwapQuoteErrorCode::UnsupportedTokenStandard)
    );
    let request = ExactInputQuoteRequest {
        chain_id: DEX_CHAIN_IDS
            .iter()
            .find(|(name, _)| *name == "solana")
            .map_or_else(
                || "solana:unknown".to_owned(),
                |(_, chain)| (*chain).to_owned(),
            ),
        pool_definition_id: "pool-0003".to_owned(),
        input_token_deployment_id: "deployment-0006".to_owned(),
        output_token_deployment_id: "deployment-0013".to_owned(),
        amount_in: "1".to_owned(),
        freshness: None,
    };
    assert_eq!(
        client
            .swap
            .quote_exact_input(request)
            .await
            .unwrap_err()
            .code(),
        Some(SwapQuoteErrorCode::UnsupportedAdapter)
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn stale_header_wins_over_malformed_abi_and_reorg_is_rejected() {
    let server = MockServer::start().await;
    mount_eth_trace(&server, now_seconds() - 1_000, None, true).await;
    let client = ErpcClient::new(config(&server)).expect("client");
    let mut request = ethereum_request();
    request.freshness = Some(SwapFreshness {
        max_block_age_seconds: Some(10),
        ..SwapFreshness::default()
    });
    assert_eq!(
        client
            .swap
            .quote_exact_input(request)
            .await
            .unwrap_err()
            .code(),
        Some(SwapQuoteErrorCode::StateStale)
    );

    let reorg_server = MockServer::start().await;
    mount_eth_trace(
        &reorg_server,
        now_seconds(),
        Some(&format!("0x{}", "f".repeat(64))),
        false,
    )
    .await;
    let reorg_client = ErpcClient::new(config(&reorg_server)).expect("client");
    assert_eq!(
        reorg_client
            .swap
            .quote_exact_input(ethereum_request())
            .await
            .unwrap_err()
            .code(),
        Some(SwapQuoteErrorCode::StateStale)
    );
}

#[tokio::test]
async fn upstream_transport_and_cancellation_errors_keep_their_native_source() {
    let client = ErpcClient::new(
        ErpcClientConfig::new("key")
            .with_endpoint("http://127.0.0.1:1")
            .with_avalanche_endpoint("http://127.0.0.1:1"),
    )
    .expect("client");
    let error = client
        .swap
        .quote_exact_input(ethereum_request())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        SwapQuoteError::Upstream(ErpcError::Transport(_) | ErpcError::Timeout { .. })
    ));

    let cancellation = erpc_sdk::CancellationToken::new();
    cancellation.cancel();
    let error = client
        .swap
        .quote_exact_input_with(&ethereum_request(), Some(&cancellation))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        SwapQuoteError::Upstream(ErpcError::Aborted)
    ));
}
