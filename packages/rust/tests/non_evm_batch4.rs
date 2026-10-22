#![allow(missing_docs)]

use erpc_sdk::{
    ErpcClient, ErpcClientConfig, RpcEndpointConfig, SUI_GRPC_WEB_CONTENT_TYPE,
    SuiGrpcWebEndpointConfig,
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, Request, ResponseTemplate,
    matchers::{header, method, path},
};

fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            return bytes;
        }
    }
}

fn field_bytes(tag: u32, value: &[u8]) -> Vec<u8> {
    let mut bytes = varint(u64::from((tag << 3) | 2));
    bytes.extend_from_slice(&varint(value.len() as u64));
    bytes.extend_from_slice(value);
    bytes
}

fn field_string(tag: u32, value: &str) -> Vec<u8> {
    field_bytes(tag, value.as_bytes())
}

fn field_u64(tag: u32, value: u64) -> Vec<u8> {
    let mut bytes = varint(u64::from(tag << 3));
    bytes.extend_from_slice(&varint(value));
    bytes
}

fn sui_service_info_payload() -> Vec<u8> {
    let mut timestamp = field_u64(1, 1_723_456_789);
    timestamp.extend(field_u64(2, 123));
    let mut payload = field_string(1, "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");
    payload.extend(field_string(2, "mainnet"));
    payload.extend(field_u64(3, 42));
    payload.extend(field_u64(4, 900));
    payload.extend(field_bytes(5, &timestamp));
    payload.extend(field_u64(6, 0));
    payload.extend(field_u64(7, 0));
    payload
}

fn grpc_response(payload: &[u8]) -> Vec<u8> {
    let trailer = b"grpc-status: 0\r\n";
    let mut body = vec![0];
    body.extend_from_slice(
        &u32::try_from(payload.len())
            .expect("Sui test payload fits in a gRPC-Web frame")
            .to_be_bytes(),
    );
    body.extend_from_slice(payload);
    body.push(0x80);
    body.extend_from_slice(
        &u32::try_from(trailer.len())
            .expect("Sui test trailer fits in a gRPC-Web frame")
            .to_be_bytes(),
    );
    body.extend_from_slice(trailer);
    body
}

fn near_status_response(request: &Request) -> ResponseTemplate {
    let body: Value = request.body_json().expect("NEAR request");
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": {
            "chain_id": "mainnet",
            "genesis_hash": "near-genesis",
            "latest_protocol_version": 1,
            "protocol_version": 1,
            "sync_info": {
                "latest_block_hash": "near-block",
                "latest_block_height": 7,
                "latest_block_time": "123",
                "latest_state_root": "near-state",
                "syncing": false
            },
            "version": {"version": "1", "build": "test"}
        }
    }))
}

fn tron_chain_response(request: &Request) -> ResponseTemplate {
    let body: Value = request.body_json().expect("TRON request");
    ResponseTemplate::new(200).set_body_json(json!({
        "jsonrpc": "2.0",
        "id": body["id"],
        "result": "0x2b6653dc"
    }))
}

fn direct_config(
    near_server: &MockServer,
    tron_server: &MockServer,
    sui_server: &MockServer,
) -> ErpcClientConfig {
    ErpcClientConfig::new("global-secret")
        .with_header("x-global", "global-secret")
        .with_near_rpc(
            RpcEndpointConfig::new(format!(
                "{}/near%2Ftenant?near-query=near-value",
                near_server.uri()
            ))
            .with_header("authorization", "Bearer near-secret"),
        )
        .with_tron_rpc(
            RpcEndpointConfig::new(format!(
                "{}/customer%2Ftron/jsonrpc?tron-query=tron-value",
                tron_server.uri()
            ))
            .with_header("authorization", "Bearer tron-secret"),
        )
        .with_sui_grpc_web(
            SuiGrpcWebEndpointConfig::new(format!(
                "{}/tenant%2Fsui?sui-query=sui-value",
                sui_server.uri()
            ))
            .with_header("x-sui-scope", "sui-secret"),
        )
}

#[tokio::test]
async fn heterogeneous_direct_routes_keep_paths_headers_and_responses_isolated() {
    let near_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/near%2Ftenant"))
        .and(header("authorization", "Bearer near-secret"))
        .respond_with(near_status_response)
        .expect(1)
        .mount(&near_server)
        .await;

    let tron_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/customer%2Ftron/jsonrpc"))
        .and(header("authorization", "Bearer tron-secret"))
        .respond_with(tron_chain_response)
        .expect(1)
        .mount(&tron_server)
        .await;

    let sui_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(
            "/tenant%2Fsui/sui.rpc.v2.LedgerService/GetServiceInfo",
        ))
        .and(header("x-sui-scope", "sui-secret"))
        .and(header("content-type", SUI_GRPC_WEB_CONTENT_TYPE))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&sui_service_info_payload())),
        )
        .expect(1)
        .mount(&sui_server)
        .await;

    let client = ErpcClient::new(direct_config(&near_server, &tron_server, &sui_server))
        .expect("heterogeneous direct client");

    let near = client.near.rpc.status().send().await.expect("NEAR status");
    assert_eq!(near.chain_id, "mainnet");
    let tron = client
        .tron
        .rpc
        .eth_chain_id()
        .send()
        .await
        .expect("TRON chain id");
    assert_eq!(tron, "0x2b6653dc");
    let sui = client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("Sui service info");
    assert_eq!(sui.chain, "mainnet");

    let near_request = &near_server.received_requests().await.unwrap()[0];
    assert_eq!(near_request.url.path(), "/near%2Ftenant");
    assert_eq!(near_request.url.query(), Some("near-query=near-value"));
    assert_eq!(
        near_request.headers.get("authorization").unwrap(),
        "Bearer near-secret"
    );
    assert!(!near_request.headers.contains_key("x-global"));
    assert!(!near_request.url.as_str().contains("api-key"));

    let tron_request = &tron_server.received_requests().await.unwrap()[0];
    assert_eq!(tron_request.url.path(), "/customer%2Ftron/jsonrpc");
    assert_eq!(tron_request.url.query(), Some("tron-query=tron-value"));
    assert_eq!(
        tron_request.headers.get("authorization").unwrap(),
        "Bearer tron-secret"
    );
    assert!(!tron_request.headers.contains_key("x-global"));
    assert!(!tron_request.url.as_str().contains("api-key"));

    let sui_request = &sui_server.received_requests().await.unwrap()[0];
    assert_eq!(
        sui_request.url.path(),
        "/tenant%2Fsui/sui.rpc.v2.LedgerService/GetServiceInfo"
    );
    assert_eq!(sui_request.url.query(), Some("sui-query=sui-value"));
    assert_eq!(
        sui_request.headers.get("x-sui-scope").unwrap(),
        "sui-secret"
    );
    assert_eq!(
        sui_request.headers.get("content-type").unwrap(),
        SUI_GRPC_WEB_CONTENT_TYPE
    );
    assert!(!sui_request.headers.contains_key("x-global"));
    assert!(!sui_request.headers.contains_key("authorization"));
    assert!(!sui_request.url.as_str().contains("api-key"));
}
