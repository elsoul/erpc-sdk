#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, ErpcClient, ErpcClientConfig, ErpcError, ErpcErrorCode, RequestOptions,
    SUI_GRPC_WEB_CONTENT_TYPE, SUI_GRPC_WEB_METHODS, SuiGrpcWebEndpointConfig,
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};

const TRAILER: &[u8] = b"grpc-status: 0\r\n";

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

fn grpc_response(payload: &[u8]) -> Vec<u8> {
    grpc_response_with_trailer(payload, TRAILER)
}

fn grpc_response_with_trailer(payload: &[u8], trailer: &[u8]) -> Vec<u8> {
    let mut body = vec![0];
    body.extend_from_slice(
        &u32::try_from(payload.len())
            .expect("Sui test payload length fits the protobuf frame")
            .to_be_bytes(),
    );
    body.extend_from_slice(payload);
    body.push(0x80);
    body.extend_from_slice(
        &u32::try_from(trailer.len())
            .expect("Sui test trailer length fits the protobuf frame")
            .to_be_bytes(),
    );
    body.extend_from_slice(trailer);
    body
}

fn service_info_payload() -> Vec<u8> {
    let mut timestamp = field_u64(1, 1_723_456_789);
    timestamp.extend(field_u64(2, 123));

    let mut payload = field_string(1, "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");
    payload.extend(field_string(2, "mainnet"));
    payload.extend(field_u64(3, u64::MAX));
    payload.extend(field_u64(4, 42));
    payload.extend(field_bytes(5, &timestamp));
    payload.extend(field_u64(6, 0));
    payload.extend(field_u64(7, 0));
    payload.extend(field_string(8, "sui-test"));
    // Unknown protobuf fields must be skipped by the bounded projection.
    payload.extend(field_string(99, "ignored"));
    payload
}

fn object_payload() -> Vec<u8> {
    let mut object = field_string(2, "0x2");
    object.extend(field_u64(3, 7));
    object.extend(field_string(4, "digest"));
    field_bytes(1, &object)
}

fn balance_payload() -> Vec<u8> {
    let mut balance = field_string(1, "0x2::sui::SUI");
    balance.extend(field_u64(3, 42));
    balance.extend(field_u64(4, 40));
    balance.extend(field_u64(5, 2));
    field_bytes(1, &balance)
}

fn direct_client(endpoint: impl Into<String>) -> ErpcClient {
    ErpcClient::new(
        ErpcClientConfig::for_rpc().with_sui_grpc_web(SuiGrpcWebEndpointConfig::new(endpoint)),
    )
    .expect("direct Sui client")
}

#[tokio::test]
async fn service_info_uses_exact_path_frame_and_projects_identity() {
    assert_eq!(
        SUI_GRPC_WEB_METHODS,
        &[
            "/sui.rpc.v2.LedgerService/GetServiceInfo",
            "/sui.rpc.v2.LedgerService/GetObject",
            "/sui.rpc.v2.StateService/GetBalance",
        ]
    );
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .and(header("content-type", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("accept", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("x-grpc-web", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&service_info_payload())),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = direct_client(server.uri());
    assert_eq!(client.sui.grpc.endpoint(), format!("{}/", server.uri()));
    let pending = client.sui.grpc.get_service_info();
    assert!(server.received_requests().await.unwrap().is_empty());
    let info = pending.send().await.expect("service info");
    assert_eq!(info.chain, "mainnet");
    assert_eq!(info.epoch, u64::MAX);
    assert_eq!(info.timestamp_seconds, 1_723_456_789);
    assert_eq!(info.timestamp_nanos, 123);
    assert_eq!(info.server.as_deref(), Some("sui-test"));

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.body.as_slice(), &[0, 0, 0, 0, 0]);
}

#[tokio::test]
async fn object_and_balance_requests_preserve_wire_tags_and_validate_sum() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[1]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&object_payload())),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = direct_client(server.uri());
    let object = client
        .sui
        .grpc
        .get_object("0x2", Some(7))
        .expect("object request")
        .send()
        .await
        .expect("object");
    assert_eq!(object.object_id, "0x2");
    assert_eq!(object.version, 7);
    assert_eq!(object.digest, "digest");
    let object_request = &server.received_requests().await.unwrap()[0].body;
    assert_eq!(
        object_request.as_slice(),
        &[0, 0, 0, 0, 7, 0x0a, 3, b'0', b'x', b'2', 0x10, 7]
    );

    let balance_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[2]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&balance_payload())),
        )
        .expect(1)
        .mount(&balance_server)
        .await;
    let balance = direct_client(balance_server.uri())
        .sui
        .grpc
        .get_balance("0xabc", "0x2::sui::SUI")
        .expect("balance request")
        .send()
        .await
        .expect("balance");
    assert_eq!(balance.balance, 42);
    assert_eq!(balance.address_balance + balance.coin_balance, 42);
}

#[tokio::test]
async fn direct_prefix_query_and_headers_are_preserved_without_global_credentials() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(
            "/tenant%2Fone/sui.rpc.v2.LedgerService/GetServiceInfo",
        ))
        .and(header("authorization", "Bearer scoped-secret"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&service_info_payload())),
        )
        .expect(1)
        .mount(&server)
        .await;
    let target = format!("{}/tenant%2Fone?token=a%2Fb", server.uri());
    let config = ErpcClientConfig::new("global-secret")
        .with_header("x-global", "global-secret")
        .with_sui_grpc_web(
            SuiGrpcWebEndpointConfig::new(target)
                .with_header("authorization", "Bearer scoped-secret"),
        );
    let client = ErpcClient::new(config).expect("direct Sui client");
    assert_eq!(client.sui.grpc.endpoint(), format!("{}/", server.uri()));
    client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("service info");
    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(
        request.url.path(),
        "/tenant%2Fone/sui.rpc.v2.LedgerService/GetServiceInfo"
    );
    assert_eq!(request.url.query(), Some("token=a%2Fb"));
    assert!(!request.headers.contains_key("x-global"));
    assert!(!request.url.as_str().contains("global-secret"));
}

#[tokio::test]
async fn nonzero_status_and_invalid_content_type_are_sanitized() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response_with_trailer(
                    &service_info_payload(),
                    b"grpc-status: 7\r\ngrpc-message: secret-body\r\n",
                )),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = direct_client(server.uri());
    let error = client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("nonzero status must fail");
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    assert!(!error.to_string().contains("secret-body"));

    let wrong_type_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/grpc")
                .set_body_bytes(grpc_response(&service_info_payload())),
        )
        .expect(1)
        .mount(&wrong_type_server)
        .await;
    let error = direct_client(wrong_type_server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("native gRPC must fail");
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
}

#[tokio::test]
async fn malformed_balance_and_timestamp_are_rejected_without_conversion() {
    let server = MockServer::start().await;
    let mut malformed = field_string(1, "0x2::sui::SUI");
    let mut balance = field_string(1, "0x2::sui::SUI");
    balance.extend(field_u64(3, u64::MAX));
    balance.extend(field_u64(4, u64::MAX));
    balance.extend(field_u64(5, 1));
    malformed.extend(field_bytes(1, &balance));
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[2]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&malformed)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let error = direct_client(server.uri())
        .sui
        .grpc
        .get_balance("owner", "coin")
        .expect("balance request")
        .send()
        .await
        .expect_err("overflow must fail");
    assert!(matches!(error, ErpcError::InvalidResponse(_)));

    let timestamp_server = MockServer::start().await;
    let mut timestamp = field_u64(1, 1);
    timestamp.extend(field_u64(2, 1_000_000_000));
    let mut payload = field_string(1, "chain");
    payload.extend(field_string(2, "mainnet"));
    payload.extend(field_u64(3, 1));
    payload.extend(field_u64(4, 1));
    payload.extend(field_bytes(5, &timestamp));
    payload.extend(field_u64(6, 0));
    payload.extend(field_u64(7, 0));
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&payload)),
        )
        .expect(1)
        .mount(&timestamp_server)
        .await;
    let error = direct_client(timestamp_server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("invalid nanos must fail");
    assert!(matches!(error, ErpcError::InvalidResponse(_)));
}

#[tokio::test]
async fn pre_cancelled_and_dropped_requests_do_not_issue_network_calls() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&service_info_payload())),
        )
        .expect(0)
        .mount(&server)
        .await;
    let client = direct_client(server.uri());
    drop(client.sui.grpc.get_service_info());
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = client
        .sui
        .grpc
        .get_service_info()
        .send_with(RequestOptions {
            cancellation: Some(cancellation),
        })
        .await
        .expect_err("pre-cancellation must abort");
    assert!(matches!(error, ErpcError::Aborted));
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(server.received_requests().await.unwrap().is_empty());
}
