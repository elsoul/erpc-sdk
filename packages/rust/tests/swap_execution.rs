#![allow(missing_docs)]

use std::time::{SystemTime, UNIX_EPOCH};

use erpc_sdk::{
    DEX_CHAIN_IDS, ErpcClient, ErpcClientConfig, PrepareExactInputSwapRequest,
    SwapExecutionErrorCode, tokens,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, method},
};

const ETH_FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const ETH_ROUTER: &str = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
const ETH_POOL: &str = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
const ETH_USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETH_WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ETH_HASH: &str = "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb";
const ETH_BLOCK: &str = "0x18c7f20";
const SENDER: &str = "0x1111111111111111111111111111111111111111";
const RECIPIENT: &str = "0x2222222222222222222222222222222222222222";
const MIXED_SENDER: &str = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const MIXED_RECIPIENT: &str = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

fn rpc_result(id: u64, result: &Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
}

fn address_word(address: &str) -> Value {
    json!(format!(
        "0x{}{}",
        "00".repeat(12),
        address[2..].to_ascii_lowercase()
    ))
}

fn uint_word(value: u128) -> String {
    format!("{value:064x}")
}

fn uint_word_decimal(value: &str) -> String {
    let value = value.parse::<u128>().expect("test quantity fits u128");
    uint_word(value)
}

fn reserves_word(reserve0: u128, reserve1: u128) -> Value {
    json!(format!(
        "0x{}{}{}",
        uint_word(reserve0),
        uint_word(reserve1),
        uint_word(1),
    ))
}

fn eth_chain_id() -> &'static str {
    DEX_CHAIN_IDS
        .iter()
        .find(|(name, _)| *name == "ethereum")
        .map_or("eip155:1", |(_, chain)| chain)
}

fn config(server: &MockServer) -> ErpcClientConfig {
    ErpcClientConfig::new("key")
        .with_endpoint(server.uri())
        .with_avalanche_endpoint(server.uri())
        .with_account_endpoint(server.uri())
        .with_user_endpoint(server.uri())
}

fn request(
    sender: &str,
    recipient: &str,
    slippage_bps: u64,
    deadline: String,
) -> PrepareExactInputSwapRequest {
    PrepareExactInputSwapRequest {
        chain_id: eth_chain_id().to_owned(),
        pool_definition_id: "pool-0001".to_owned(),
        input_token_deployment_id: tokens::ethereum::WETH.to_owned(),
        output_token_deployment_id: tokens::ethereum::USDC.to_owned(),
        amount_in: "1000000000000000000".to_owned(),
        freshness: None,
        sender: sender.to_owned(),
        recipient: recipient.to_owned(),
        slippage_bps,
        deadline,
    }
}

fn amount_out_response() -> Value {
    json!(format!(
        "0x{}{}{}{}",
        uint_word(32),
        uint_word(2),
        uint_word(1_000_000_000_000_000_000),
        uint_word(2_393_866_186),
    ))
}

async fn mount_call(server: &MockServer, id: u64, rpc_method: &str, params: Value, result: Value) {
    Mock::given(method("POST"))
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

#[allow(clippy::too_many_lines)]
async fn mount_preparation(server: &MockServer, timestamp: u64) {
    let header = json!({
        "number": ETH_BLOCK,
        "hash": ETH_HASH,
        "timestamp": format!("0x{timestamp:x}"),
    });
    let selector = json!({"blockHash": ETH_HASH, "requireCanonical": true});
    let factory_pair_data = format!(
        "0xe6a43905{}{}",
        &address_word(ETH_USDC).as_str().expect("USDC word")[2..],
        &address_word(ETH_WETH).as_str().expect("WETH word")[2..],
    );
    let router_amounts_data = format!(
        "0xd06ca61f{}{}{}{}{}",
        uint_word(1_000_000_000_000_000_000),
        uint_word(64),
        uint_word(2),
        &address_word(ETH_WETH).as_str().expect("WETH word")[2..],
        &address_word(ETH_USDC).as_str().expect("USDC word")[2..],
    );
    let entries = vec![
        ("eth_chainId", json!([]), json!("0x1")),
        (
            "eth_getBlockByNumber",
            json!(["latest", false]),
            header.clone(),
        ),
        (
            "eth_getCode",
            json!([ETH_FACTORY, selector.clone()]),
            json!("0x6000"),
        ),
        (
            "eth_getCode",
            json!([ETH_POOL, selector.clone()]),
            json!("0x6000"),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_FACTORY, "data": factory_pair_data},
                selector.clone()
            ]),
            address_word(ETH_POOL),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_POOL, "data": "0xc45a0155"},
                selector.clone()
            ]),
            address_word(ETH_FACTORY),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_POOL, "data": "0x0dfe1681"},
                selector.clone()
            ]),
            address_word(ETH_USDC),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_POOL, "data": "0xd21220a7"},
                selector.clone()
            ]),
            address_word(ETH_WETH),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_POOL, "data": "0x0902f1ac"},
                selector.clone()
            ]),
            reserves_word(9_922_163_268_622, 4_131_396_377_933_182_743_090),
        ),
        (
            "eth_getBlockByNumber",
            json!(["latest", false]),
            header.clone(),
        ),
        ("eth_getBlockByNumber", json!([ETH_BLOCK, false]), header),
        (
            "eth_getCode",
            json!([ETH_ROUTER, selector.clone()]),
            json!("0x6000"),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_ROUTER, "data": "0xc45a0155"},
                selector.clone()
            ]),
            address_word(ETH_FACTORY),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_ROUTER, "data": "0xad5c4648"},
                selector.clone()
            ]),
            address_word(ETH_WETH),
        ),
        (
            "eth_call",
            json!([
                {"to": ETH_ROUTER, "data": router_amounts_data},
                selector
            ]),
            amount_out_response(),
        ),
        (
            "eth_getBlockByNumber",
            json!(["latest", false]),
            json!({
                "number": ETH_BLOCK,
                "hash": ETH_HASH,
                "timestamp": format!("0x{timestamp:x}"),
            }),
        ),
    ];
    for (index, (rpc_method, params, result)) in entries.into_iter().enumerate() {
        mount_call(
            server,
            u64::try_from(index + 1).expect("small test ID"),
            rpc_method,
            params,
            result,
        )
        .await;
    }
}

fn allowance_data(owner: &str, spender: &str) -> String {
    format!(
        "0xdd62ed3e{}{}",
        &address_word(owner).as_str().expect("owner word")[2..],
        &address_word(spender).as_str().expect("spender word")[2..],
    )
}

fn swap_data(slippage_bps: u64, deadline: &str, recipient: &str) -> String {
    let minimum = match slippage_bps {
        0 => 2_393_866_186,
        50 => 2_381_896_855,
        _ => panic!("test slippage not encoded"),
    };
    format!(
        "0x38ed1739{}{}{}{}{}{}{}{}",
        uint_word(1_000_000_000_000_000_000),
        uint_word(minimum),
        uint_word(160),
        &address_word(recipient).as_str().expect("recipient word")[2..],
        uint_word_decimal(deadline),
        uint_word(2),
        &address_word(ETH_WETH).as_str().expect("WETH word")[2..],
        &address_word(ETH_USDC).as_str().expect("USDC word")[2..],
    )
}

#[tokio::test]
async fn preparation_uses_sixteen_reads_and_builds_local_router_calldata() {
    let server = MockServer::start().await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    mount_preparation(&server, now - 1).await;
    let deadline = (now + 3_600).to_string();
    let mut request = request(MIXED_SENDER, MIXED_RECIPIENT, 50, deadline.clone());
    let client = ErpcClient::new(config(&server)).expect("client");
    let prepared = client
        .swap
        .prepare_exact_input_swap(&mut request)
        .await
        .expect("preparation");

    assert_eq!(prepared.preparation_kind, "evm-router-v2-exact-input");
    assert_eq!(prepared.execution_capability_id, "swap-execution-0001");
    assert_eq!(prepared.minimum_amount_out, "2381896855");
    assert_eq!(prepared.slippage_bps, 50);
    assert_eq!(prepared.deadline, deadline);
    assert_eq!(prepared.recipient, MIXED_RECIPIENT.to_ascii_lowercase());
    assert_eq!(prepared.path.len(), 2);
    assert_eq!(prepared.path[0].address, ETH_WETH);
    assert_eq!(prepared.path[1].address, ETH_USDC);
    assert_eq!(prepared.transaction.chain_id, eth_chain_id());
    assert_eq!(prepared.transaction.from, MIXED_SENDER.to_ascii_lowercase());
    assert_eq!(prepared.transaction.to, ETH_ROUTER);
    assert_eq!(prepared.transaction.value, "0");
    assert_eq!(
        prepared.transaction.data,
        swap_data(50, &deadline, MIXED_RECIPIENT)
    );
    assert_eq!(prepared.allowance.owner, MIXED_SENDER.to_ascii_lowercase());
    assert_eq!(prepared.allowance.spender, ETH_ROUTER);
    assert_eq!(prepared.allowance.required_amount, "1000000000000000000");

    let received = server.received_requests().await.expect("requests");
    assert_eq!(received.len(), 16);
}

#[tokio::test]
async fn simulation_checks_allowance_then_calls_router_and_final_latest() {
    let server = MockServer::start().await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    mount_preparation(&server, now - 1).await;
    let deadline = (now + 3_600).to_string();
    mount_call(
        &server,
        17,
        "eth_call",
        json!([
            {
                "to": ETH_WETH,
                "data": allowance_data(SENDER, ETH_ROUTER),
            },
            {"blockHash": ETH_HASH, "requireCanonical": true}
        ]),
        json!(format!("0x{}", uint_word(2_000_000_000_000_000_000_u128))),
    )
    .await;
    mount_call(
        &server,
        18,
        "eth_call",
        json!([
            {
                "from": SENDER,
                "to": ETH_ROUTER,
                "data": swap_data(50, &deadline, RECIPIENT),
                "value": "0x0",
            },
            {"blockHash": ETH_HASH, "requireCanonical": true}
        ]),
        amount_out_response(),
    )
    .await;
    mount_call(
        &server,
        19,
        "eth_getBlockByNumber",
        json!(["latest", false]),
        json!({
            "number": ETH_BLOCK,
            "hash": ETH_HASH,
            "timestamp": format!("0x{:x}", now - 1),
        }),
    )
    .await;

    let client = ErpcClient::new(config(&server)).expect("client");
    let simulated = client
        .swap
        .simulate_exact_input_swap(request(SENDER, RECIPIENT, 50, deadline))
        .await
        .expect("simulation");
    assert_eq!(simulated.simulation_kind, "evm-call");
    assert_eq!(simulated.current_allowance, "2000000000000000000");
    assert_eq!(simulated.amounts, ["1000000000000000000", "2393866186"]);
    assert_eq!(simulated.amount_out, "2393866186");

    let received = server.received_requests().await.expect("requests");
    assert_eq!(received.len(), 19);
}

#[tokio::test]
async fn invalid_execution_scalars_fail_before_rpc() {
    let server = MockServer::start().await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let client = ErpcClient::new(config(&server)).expect("client");
    let error = client
        .swap
        .prepare_exact_input_swap(request(
            "0x0000000000000000000000000000000000000000",
            RECIPIENT,
            50,
            (now + 3_600).to_string(),
        ))
        .await
        .expect_err("zero sender must fail");
    assert_eq!(error.code(), Some(SwapExecutionErrorCode::InvalidArgument));
    assert!(
        server
            .received_requests()
            .await
            .expect("requests")
            .is_empty()
    );
}

#[tokio::test]
async fn insufficient_allowance_stops_before_router_simulation() {
    let server = MockServer::start().await;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    mount_preparation(&server, now - 1).await;
    mount_call(
        &server,
        17,
        "eth_call",
        json!([
            {
                "to": ETH_WETH,
                "data": allowance_data(SENDER, ETH_ROUTER),
            },
            {"blockHash": ETH_HASH, "requireCanonical": true}
        ]),
        json!(format!("0x{}", uint_word(0))),
    )
    .await;

    let client = ErpcClient::new(config(&server)).expect("client");
    let error = client
        .swap
        .simulate_exact_input_swap(request(SENDER, RECIPIENT, 50, (now + 3_600).to_string()))
        .await
        .expect_err("insufficient allowance must fail");
    assert_eq!(
        error.code(),
        Some(SwapExecutionErrorCode::InsufficientAllowance)
    );
    assert_eq!(
        server.received_requests().await.expect("requests").len(),
        17
    );
}
