#![allow(missing_docs)]

use std::time::Duration;

use erpc_sdk::{
    CancellationToken, ErpcClient, ErpcClientConfig, ErpcError, ErpcErrorCode, RequestOptions,
    SUI_GRPC_WEB_CONTENT_TYPE, SUI_GRPC_WEB_METHODS, SuiGrpcWebEndpointConfig,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
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

#[allow(clippy::cast_sign_loss)]
fn field_i32(tag: u32, value: i32) -> Vec<u8> {
    field_u64(tag, i64::from(value) as u64)
}

fn varint_len(mut value: usize) -> usize {
    let mut length = 1;
    while value >= 0x80 {
        value >>= 7;
        length += 1;
    }
    length
}

fn frame(marker: u8, payload: &[u8]) -> Vec<u8> {
    frame_declared(
        marker,
        u32::try_from(payload.len()).expect("test frame payload fits a u32"),
        payload,
    )
}

fn frame_declared(marker: u8, length: u32, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![marker];
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn response_frames(frames: &[Vec<u8>]) -> Vec<u8> {
    frames.iter().flatten().copied().collect()
}

fn grpc_response(payload: &[u8]) -> Vec<u8> {
    grpc_response_with_trailer(payload, TRAILER)
}

fn grpc_response_with_trailer(payload: &[u8], trailer: &[u8]) -> Vec<u8> {
    response_frames(&[frame(0, payload), frame(0x80, trailer)])
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
    balance_payload_values("0x2::sui::SUI", 42, 40, 2)
}

fn balance_payload_values(coin_type: &str, total: u64, address: u64, coin: u64) -> Vec<u8> {
    let mut balance = field_string(1, coin_type);
    balance.extend(field_u64(3, total));
    balance.extend(field_u64(4, address));
    balance.extend(field_u64(5, coin));
    field_bytes(1, &balance)
}

fn object_payload_values(object_id: &str, version: u64, digest: &str) -> Vec<u8> {
    let mut object = field_string(2, object_id);
    object.extend(field_u64(3, version));
    object.extend(field_string(4, digest));
    field_bytes(1, &object)
}

fn padded_service_info_payload(target_len: usize) -> Vec<u8> {
    let mut payload = service_info_payload();
    let mut filler_len = target_len.saturating_sub(payload.len());
    loop {
        let overhead = varint_len(((99_u32 << 3) | 2) as usize) + varint_len(filler_len);
        let next = target_len
            .checked_sub(payload.len() + overhead)
            .expect("padding target is larger than the base protobuf");
        if next == filler_len {
            break;
        }
        filler_len = next;
    }
    payload.extend(field_bytes(99, &vec![0; filler_len]));
    assert_eq!(payload.len(), target_len);
    payload
}

struct RawChunkedServer {
    uri: String,
    task: JoinHandle<()>,
}

impl RawChunkedServer {
    async fn join(self) {
        let _ = self.task.await;
    }
}

async fn spawn_raw_chunked_server(
    status: u16,
    headers: &[(&str, &str)],
    body: Vec<u8>,
    first_chunk_len: Option<usize>,
    delay_after_first: Option<Duration>,
) -> RawChunkedServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local deterministic HTTP server");
    let uri = format!("http://{}", listener.local_addr().expect("server address"));
    let headers = headers
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect::<Vec<_>>();
    let task = tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        for _ in 0..64 {
            let Ok(read) = stream.read(&mut buffer).await else {
                return;
            };
            if read == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let reason = match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            307 => "Temporary Redirect",
            400 => "Bad Request",
            500 => "Internal Server Error",
            _ => "Status",
        };
        let mut response = format!("HTTP/1.1 {status} {reason}\r\n");
        for (name, value) in &headers {
            response.push_str(name);
            response.push_str(": ");
            response.push_str(value);
            response.push_str("\r\n");
        }
        response.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        if stream.write_all(response.as_bytes()).await.is_err() {
            return;
        }
        if body.is_empty() {
            let _ = stream.write_all(b"0\r\n\r\n").await;
            return;
        }
        let first_len = first_chunk_len.unwrap_or(body.len()).min(body.len()).max(1);
        let chunks = [&body[..first_len], &body[first_len..]];
        for (index, chunk) in chunks.iter().enumerate() {
            if chunk.is_empty() {
                continue;
            }
            let prefix = format!("{:X}\r\n", chunk.len());
            if stream.write_all(prefix.as_bytes()).await.is_err()
                || stream.write_all(chunk).await.is_err()
                || stream.write_all(b"\r\n").await.is_err()
            {
                return;
            }
            let _ = stream.flush().await;
            if index == 0 {
                if let Some(delay) = delay_after_first {
                    tokio::time::sleep(delay).await;
                }
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
    });
    RawChunkedServer { uri, task }
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
    assert!(!format!("{error:?}").contains("secret-body"));

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
async fn malformed_protobuf_balance_overflow_and_sum_mismatch_are_separate_branches() {
    let malformed = vec![0x0a, 0x05, 0x01];
    let cases = [
        ("malformed protobuf", grpc_response(&malformed)),
        (
            "checked component overflow",
            grpc_response(&balance_payload_values(
                "0x2::sui::SUI",
                u64::MAX,
                u64::MAX,
                1,
            )),
        ),
        (
            "component sum mismatch",
            grpc_response(&balance_payload_values("0x2::sui::SUI", 3, 2, 2)),
        ),
    ];
    for (name, body) in cases {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[2]))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(body),
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
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse, "{name}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1, "{name}");
    }
}

#[tokio::test]
async fn timestamp_presence_zero_default_and_invalid_nanos_are_proven() {
    let valid_without_nanos_timestamp = field_u64(1, 1);
    let mut payload = field_string(1, "chain");
    payload.extend(field_string(2, "mainnet"));
    payload.extend(field_u64(3, 0));
    payload.extend(field_u64(4, 0));
    payload.extend(field_bytes(5, &valid_without_nanos_timestamp));
    payload.extend(field_u64(6, 0));
    payload.extend(field_u64(7, 0));

    let valid_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&payload)),
        )
        .expect(1)
        .mount(&valid_server)
        .await;
    let info = direct_client(valid_server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("omitted timestamp nanos defaults to zero");
    assert_eq!(info.timestamp_seconds, 1);
    assert_eq!(info.timestamp_nanos, 0);
    assert_eq!(info.epoch, 0);
    assert_eq!(info.checkpoint_height, 0);

    for nanos in [-1, 1_000_000_000] {
        let mut timestamp = field_u64(1, 1);
        timestamp.extend(field_i32(2, nanos));
        let mut invalid_payload = field_string(1, "chain");
        invalid_payload.extend(field_string(2, "mainnet"));
        invalid_payload.extend(field_u64(3, 1));
        invalid_payload.extend(field_u64(4, 1));
        invalid_payload.extend(field_bytes(5, &timestamp));
        invalid_payload.extend(field_u64(6, 0));
        invalid_payload.extend(field_u64(7, 0));
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(grpc_response(&invalid_payload)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = direct_client(server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .expect_err("invalid nanos must fail");
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
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

#[tokio::test]
async fn request_presence_golden_bytes_balance_tags_and_inclusive_limit() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[1]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&object_payload_values("0x2", 0, "digest"))),
        )
        .expect(3)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[2]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&balance_payload())),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = direct_client(server.uri());
    client
        .sui
        .grpc
        .get_object("0x2", Some(0))
        .expect("object request")
        .send()
        .await
        .expect("present zero version");
    client
        .sui
        .grpc
        .get_object("0x2", None)
        .expect("object request")
        .send()
        .await
        .expect("absent version");
    client
        .sui
        .grpc
        .get_balance("owner", "coin")
        .expect("balance request")
        .send()
        .await
        .expect("balance");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[0].body,
        vec![0, 0, 0, 0, 7, 0x0a, 3, b'0', b'x', b'2', 0x10, 0]
    );
    assert_eq!(
        requests[1].body,
        vec![0, 0, 0, 0, 5, 0x0a, 3, b'0', b'x', b'2']
    );
    assert_eq!(
        requests[2].body,
        vec![
            0, 0, 0, 0, 13, 0x0a, 5, b'o', b'w', b'n', b'e', b'r', 0x12, 4, b'c', b'o', b'i', b'n'
        ]
    );

    let max_id = "a".repeat(1_048_567);
    client
        .sui
        .grpc
        .get_object(max_id, None)
        .expect("1 MiB framed request is inclusive")
        .send()
        .await
        .expect("large request response");
    let too_large = client
        .sui
        .grpc
        .get_object("a".repeat(1_048_568), None)
        .err()
        .expect("request over the inclusive limit must fail before I/O");
    assert_eq!(too_large.code(), ErpcErrorCode::Config);
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
    assert_eq!(
        server.received_requests().await.unwrap()[3].body.len(),
        1_048_576
    );
}

#[tokio::test]
async fn response_body_limit_is_inclusive_and_measured_after_chunked_accumulation() {
    let trailer_len = TRAILER.len();
    let exact_payload_len = 8 * 1024 * 1024 - 5 - 5 - trailer_len;
    let exact = grpc_response(&padded_service_info_payload(exact_payload_len));
    assert_eq!(exact.len(), 8 * 1024 * 1024);
    let exact_server = spawn_raw_chunked_server(
        200,
        &[("content-type", SUI_GRPC_WEB_CONTENT_TYPE)],
        exact,
        Some(1),
        None,
    )
    .await;
    let info = direct_client(exact_server.uri.clone())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("exactly 8 MiB chunked response is inclusive");
    assert_eq!(info.chain, "mainnet");
    exact_server.join().await;

    let over = grpc_response(&padded_service_info_payload(exact_payload_len + 1));
    assert_eq!(over.len(), 8 * 1024 * 1024 + 1);
    let over_server = spawn_raw_chunked_server(
        200,
        &[("content-type", SUI_GRPC_WEB_CONTENT_TYPE)],
        over,
        Some(1),
        None,
    )
    .await;
    let error = direct_client(over_server.uri.clone())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("chunked response over 8 MiB must fail");
    assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    over_server.join().await;
}

#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn framing_and_trailer_matrix_rejects_unsafe_shapes_and_accepts_safe_metadata() {
    let valid_data = frame(0, &service_info_payload());
    let valid_trailer = frame(0x80, TRAILER);
    let mut data_then_trailer = valid_data.clone();
    data_then_trailer.extend_from_slice(&valid_trailer);
    let mut two_data = valid_data.clone();
    two_data.extend_from_slice(&valid_data);
    two_data.extend_from_slice(&valid_trailer);
    let mut trailer_then_data = valid_trailer.clone();
    trailer_then_data.extend_from_slice(&valid_data);
    let mut nonterminal_trailer = valid_data.clone();
    nonterminal_trailer.extend_from_slice(&valid_trailer);
    nonterminal_trailer.extend_from_slice(&valid_data);
    let mut duplicate_trailer_frame = data_then_trailer.clone();
    duplicate_trailer_frame.extend_from_slice(&valid_trailer);
    let mut extra_bytes = data_then_trailer.clone();
    extra_bytes.push(0);
    let mut truncated_trailer_header = valid_data.clone();
    truncated_trailer_header.extend_from_slice(&[0x80, 0, 0]);
    let payload = service_info_payload();
    let payload_len = u32::try_from(payload.len()).expect("test payload fits a u32");
    let mut data_declared_short = frame_declared(0, payload_len - 1, &payload);
    data_declared_short.extend_from_slice(&valid_trailer);
    let mut data_declared_long = frame_declared(0, payload_len + 1, &payload);
    data_declared_long.extend_from_slice(&valid_trailer);
    let mut trailer_declared_short = valid_data.clone();
    let trailer_len = u32::try_from(TRAILER.len()).expect("test trailer fits a u32");
    trailer_declared_short.extend_from_slice(&frame_declared(0x80, trailer_len - 1, TRAILER));
    let mut overflow_data = vec![0, 0xff, 0xff, 0xff, 0xff];
    overflow_data.extend_from_slice(&valid_trailer);
    let mut overflow_trailer = valid_data.clone();
    overflow_trailer.extend_from_slice(&[0x80, 0xff, 0xff, 0xff, 0xff]);
    let oversized_trailer = frame(0x80, &vec![b'x'; 8 * 1024 + 1]);
    let mut missing_trailer = valid_data.clone();
    let data_only = valid_data.clone();
    missing_trailer.truncate(missing_trailer.len() - 1);
    let mut compressed_data = data_then_trailer.clone();
    compressed_data[0] = 1;
    let mut compressed_trailer = data_then_trailer.clone();
    compressed_trailer[valid_data.len()] = 0x81;

    let rejected = [
        ("compressed data", compressed_data),
        ("compressed trailer", compressed_trailer),
        ("missing trailer", missing_trailer),
        ("data frame without trailer", data_only),
        ("trailer first", trailer_then_data),
        ("multiple data frames", two_data),
        ("nonterminal trailer", nonterminal_trailer),
        ("duplicate trailer frames", duplicate_trailer_frame),
        ("extra bytes", extra_bytes),
        ("truncated trailer header", truncated_trailer_header),
        ("data length too short", data_declared_short),
        ("data length too long", data_declared_long),
        ("trailer length mismatch", trailer_declared_short),
        ("overflow data length", overflow_data),
        ("overflow trailer length", overflow_trailer),
        ("trailer over 8 KiB", {
            let mut body = valid_data.clone();
            body.extend_from_slice(&oversized_trailer);
            body
        }),
    ];
    for (name, body) in rejected {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(body),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = direct_client(server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse, "{name}");
    }

    let safe_trailer = b"grpc-status: 0\r\nx-safe: retained\r\n";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response_with_trailer(
                    &service_info_payload(),
                    safe_trailer,
                )),
        )
        .expect(1)
        .mount(&server)
        .await;
    let info = direct_client(server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("safe lowercase metadata is validated then discarded");
    assert_eq!(info.server.as_deref(), Some("sui-test"));

    let exact_trailer_value = "a".repeat(8 * 1024 - TRAILER.len() - 10);
    let exact_trailer = format!("grpc-status: 0\r\nx-safe: {exact_trailer_value}\r\n");
    assert_eq!(exact_trailer.len(), 8 * 1024);
    let exact_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response_with_trailer(
                    &service_info_payload(),
                    exact_trailer.as_bytes(),
                )),
        )
        .expect(1)
        .mount(&exact_server)
        .await;
    direct_client(exact_server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("exactly 8 KiB trailer is inclusive");
}

#[tokio::test]
async fn trailer_status_grammar_requires_one_lowercase_decimal_zero() {
    let trailers: &[(&str, &[u8])] = &[
        ("missing", b"x-safe: value\r\n"),
        ("duplicate", b"grpc-status: 0\r\ngrpc-status: 0\r\n"),
        ("nonzero", b"grpc-status: 7\r\n"),
        ("plus", b"grpc-status: +0\r\n"),
        ("alphabetic", b"grpc-status: zero\r\n"),
        ("negative", b"grpc-status: -0\r\n"),
        ("empty", b"grpc-status: \r\n"),
        ("uppercase status", b"Grpc-Status: 0\r\n"),
        ("uppercase metadata", b"grpc-status: 0\r\nX-Safe: value\r\n"),
        ("malformed line", b"grpc-status: 0\r\nmissing-colon\r\n"),
        ("invalid utf8", b"grpc-status: 0\r\n\xff\r\n"),
        ("control value", b"grpc-status: 0\r\nx-safe: bad\x01\r\n"),
    ];
    for (name, trailer) in trailers {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(grpc_response_with_trailer(&service_info_payload(), trailer)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = direct_client(server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse, "{name}");
    }
}

#[tokio::test]
async fn status_and_content_type_must_be_exact_and_errors_discard_upstream_secrets() {
    for status in [201, 204, 206, 299, 400, 500] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_raw(b"http-secret-body", "text/plain"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = direct_client(server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .unwrap_err();
        assert!(matches!(error, ErpcError::Http { status: value } if value == status));
        assert!(!error.to_string().contains("http-secret-body"));
        assert!(!format!("{error:?}").contains("http-secret-body"));
    }

    let content_types = [
        (
            "absent",
            ResponseTemplate::new(200).set_body_raw(data_body(), ""),
        ),
        (
            "native grpc",
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/grpc")
                .set_body_bytes(data_body()),
        ),
        (
            "grpc web text",
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/grpc-web-text")
                .set_body_bytes(data_body()),
        ),
        (
            "json",
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_bytes(data_body()),
        ),
        (
            "duplicate",
            ResponseTemplate::new(200)
                .append_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .append_header("content-type", "application/grpc")
                .set_body_bytes(data_body()),
        ),
        (
            "comma ambiguity",
            ResponseTemplate::new(200)
                .insert_header(
                    "content-type",
                    format!("{SUI_GRPC_WEB_CONTENT_TYPE}, application/grpc"),
                )
                .set_body_bytes(data_body()),
        ),
    ];
    for (name, response) in content_types {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(response)
            .expect(1)
            .mount(&server)
            .await;
        let error = direct_client(server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse, "{name}");
    }
}

fn data_body() -> Vec<u8> {
    grpc_response(&service_info_payload())
}

#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn protobuf_required_presence_zero_values_and_unknown_fields_are_checked() {
    let mut zero_timestamp = field_u64(1, 0);
    zero_timestamp.extend(field_u64(2, 0));
    let mut zero_info = field_string(1, "");
    zero_info.extend(field_string(2, ""));
    zero_info.extend(field_u64(3, 0));
    zero_info.extend(field_u64(4, 0));
    zero_info.extend(field_bytes(5, &zero_timestamp));
    zero_info.extend(field_u64(6, 0));
    zero_info.extend(field_u64(7, 0));
    zero_info.extend(field_string(99, "unknown"));
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&zero_info)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let info = direct_client(server.uri())
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("present zero values are valid");
    assert!(info.chain_id.is_empty());
    assert!(info.chain.is_empty());
    assert_eq!(info.epoch, 0);
    assert_eq!(info.timestamp_nanos, 0);
    assert!(info.server.is_none());

    let object_server = MockServer::start().await;
    let mut object = object_payload_values("", 0, "");
    object.extend(field_string(99, "unknown"));
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[1]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&object)),
        )
        .expect(1)
        .mount(&object_server)
        .await;
    let object = direct_client(object_server.uri())
        .sui
        .grpc
        .get_object("id", None)
        .expect("object request")
        .send()
        .await
        .expect("present object zeros are valid");
    assert!(object.object_id.is_empty());
    assert_eq!(object.version, 0);
    assert!(object.digest.is_empty());

    let balance_server = MockServer::start().await;
    let mut balance = balance_payload_values("", 0, 0, 0);
    balance.extend(field_string(99, "unknown"));
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[2]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(grpc_response(&balance)),
        )
        .expect(1)
        .mount(&balance_server)
        .await;
    let balance = direct_client(balance_server.uri())
        .sui
        .grpc
        .get_balance("owner", "coin")
        .expect("balance request")
        .send()
        .await
        .expect("present balance zeros are valid");
    assert!(balance.coin_type.is_empty());
    assert_eq!(balance.balance, 0);

    let complete_service_info =
        |include_chain_id: bool, include_chain: bool, include_timestamp: bool| {
            let mut value = Vec::new();
            if include_chain_id {
                value.extend(field_string(1, "chain-id"));
            }
            if include_chain {
                value.extend(field_string(2, "mainnet"));
            }
            value.extend(field_u64(3, 1));
            value.extend(field_u64(4, 2));
            if include_timestamp {
                let timestamp = field_u64(1, 1);
                value.extend(field_bytes(5, &timestamp));
            }
            value.extend(field_u64(6, 3));
            value.extend(field_u64(7, 4));
            value.extend(field_string(8, "server"));
            value.extend(field_string(99, "unknown"));
            value
        };
    let missing_cases = [
        ("chain id", complete_service_info(false, true, true)),
        ("chain", complete_service_info(true, false, true)),
        ("timestamp", complete_service_info(true, true, false)),
    ];
    for (name, payload) in missing_cases {
        let missing_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(SUI_GRPC_WEB_METHODS[0]))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(grpc_response(&payload)),
            )
            .expect(1)
            .mount(&missing_server)
            .await;
        let error = direct_client(missing_server.uri())
            .sui
            .grpc
            .get_service_info()
            .send()
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse, "{name}");
    }
}

#[tokio::test]
async fn hosted_and_direct_configuration_rejects_credentials_fragments_and_redacts_errors() {
    let invalid_hosted = [
        "https://username:password@example.invalid/prefix",
        "https://@example.invalid/prefix",
        "https://user%3Asecret@example.invalid/prefix",
        "https://example.invalid/prefix#fragment-secret",
        "https://example.invalid/#",
    ];
    for endpoint in invalid_hosted {
        let config = ErpcClientConfig::new("api-key-secret").with_sui_endpoint(endpoint);
        let debug = format!("{config:?}");
        for secret in ["api-key-secret", "password", "username", "fragment-secret"] {
            assert!(!debug.contains(secret), "hosted config leaked {secret}");
        }
        let error = ErpcClient::new(config)
            .err()
            .expect("hosted userinfo/fragment must be rejected");
        assert_eq!(error.code(), ErpcErrorCode::Config);
        let rendered = format!("{error:?}");
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("fragment-secret"));
        assert!(!error.to_string().contains("username"));
    }

    let invalid_direct = [
        "https://username:password@example.invalid/prefix",
        "https://example.invalid/prefix#fragment-secret",
    ];
    for endpoint in invalid_direct {
        let error = ErpcClient::new(
            ErpcClientConfig::for_rpc().with_sui_grpc_web(SuiGrpcWebEndpointConfig::new(endpoint)),
        )
        .err()
        .expect("direct userinfo/fragment must be rejected");
        assert_eq!(error.code(), ErpcErrorCode::Config);
        assert!(!format!("{error:?}").contains("password"));
        assert!(!error.to_string().contains("fragment-secret"));
    }
}

#[tokio::test]
async fn hosted_and_direct_headers_override_conflicts_and_preserve_safe_prefix_query() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/tenant/sui.rpc.v2.LedgerService/GetServiceInfo"))
        .and(header("authorization", "Bearer hosted-secret"))
        .and(header("content-type", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("accept", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("x-grpc-web", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&server)
        .await;
    let hosted = ErpcClient::new(
        ErpcClientConfig::new("hosted-secret")
            .with_sui_endpoint(format!("{}/tenant?api-key=query-secret", server.uri()))
            .with_header("authorization", "Bearer global-wrong")
            .with_header("content-type", "application/grpc")
            .with_header("accept", "application/grpc")
            .with_header("x-grpc-web", "0")
            .with_header("x-global", "retained"),
    )
    .expect("hosted configuration");
    assert_eq!(hosted.sui.grpc.endpoint(), format!("{}/", server.uri()));
    hosted
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("hosted service info");
    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(
        request.url.path(),
        "/tenant/sui.rpc.v2.LedgerService/GetServiceInfo"
    );
    assert_eq!(request.url.query(), None);
    assert_eq!(request.headers.get("x-global").unwrap(), "retained");
    assert!(!request.url.as_str().contains("hosted-secret"));
    assert!(!request.url.as_str().contains("query-secret"));

    let direct_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(
            "/tenant%2Fone/sui.rpc.v2.LedgerService/GetServiceInfo",
        ))
        .and(header("authorization", "Bearer direct-secret"))
        .and(header("content-type", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("accept", SUI_GRPC_WEB_CONTENT_TYPE))
        .and(header("x-grpc-web", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&direct_server)
        .await;
    let direct = ErpcClient::new(
        ErpcClientConfig::new("global-secret")
            .with_header("x-global", "global-secret")
            .with_sui_grpc_web(
                SuiGrpcWebEndpointConfig::new(format!(
                    "{}/tenant%2Fone?token=a%2Fb",
                    direct_server.uri()
                ))
                .with_header("authorization", "Bearer direct-secret")
                .with_header("content-type", "application/grpc")
                .with_header("accept", "application/grpc")
                .with_header("x-grpc-web", "0"),
            ),
    )
    .expect("direct configuration");
    direct
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("direct service info");
    let request = &direct_server.received_requests().await.unwrap()[0];
    assert_eq!(
        request.url.path(),
        "/tenant%2Fone/sui.rpc.v2.LedgerService/GetServiceInfo"
    );
    assert_eq!(request.url.query(), Some("token=a%2Fb"));
    assert!(!request.headers.contains_key("x-global"));
    assert!(
        !request
            .headers
            .values()
            .any(|value| value == "global-secret")
    );
}

#[tokio::test]
async fn direct_root_and_edge_prefixes_append_exact_case_sensitive_paths() {
    let root_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(SUI_GRPC_WEB_METHODS[0]))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&root_server)
        .await;
    direct_client(format!("{}/", root_server.uri()))
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("root prefix");

    let edge_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/sui/sui.rpc.v2.LedgerService/GetServiceInfo"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&edge_server)
        .await;
    direct_client(format!("{}/sui/", edge_server.uri()))
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("trailing slash edge prefix");
}

#[tokio::test]
async fn object_and_balance_missing_required_nested_fields_are_invalid() {
    let mut object_without_id = field_u64(3, 1);
    object_without_id.extend(field_string(4, "digest"));
    let mut balance_without_total = field_string(1, "0x2::sui::SUI");
    balance_without_total.extend(field_u64(4, 1));
    balance_without_total.extend(field_u64(5, 1));
    let cases = [
        (SUI_GRPC_WEB_METHODS[1], field_bytes(1, &object_without_id)),
        (
            SUI_GRPC_WEB_METHODS[2],
            field_bytes(1, &balance_without_total),
        ),
    ];
    for (method_path, payload) in cases {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(method_path))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                    .set_body_bytes(grpc_response(&payload)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let error = if method_path == SUI_GRPC_WEB_METHODS[1] {
            direct_client(server.uri())
                .sui
                .grpc
                .get_object("0x2", None)
                .expect("object request")
                .send()
                .await
                .unwrap_err()
        } else {
            direct_client(server.uri())
                .sui
                .grpc
                .get_balance("owner", "coin")
                .expect("balance request")
                .send()
                .await
                .unwrap_err()
        };
        assert_eq!(error.code(), ErpcErrorCode::InvalidResponse);
    }
}

#[tokio::test]
async fn redirect_is_rejected_without_following_or_retrying_and_sibling_isolation_holds() {
    let redirect_server = MockServer::start().await;
    let destination_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("location", format!("{}/target", destination_server.uri()))
                .set_body_raw(b"redirect-secret", "text/plain"),
        )
        .expect(1)
        .mount(&redirect_server)
        .await;
    let client = direct_client(redirect_server.uri());
    let error = client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("redirect must be rejected");
    assert!(matches!(error, ErpcError::Http { status: 307 }));
    assert_eq!(redirect_server.received_requests().await.unwrap().len(), 1);
    assert!(
        destination_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!error.to_string().contains("redirect-secret"));

    let hosted_redirect = MockServer::start().await;
    let hosted_destination = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("location", format!("{}/target", hosted_destination.uri())),
        )
        .expect(1)
        .mount(&hosted_redirect)
        .await;
    let hosted_client = ErpcClient::new(
        ErpcClientConfig::new("hosted-secret").with_sui_endpoint(hosted_redirect.uri()),
    )
    .expect("hosted redirect configuration");
    let error = hosted_client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("hosted redirect must be rejected");
    assert!(matches!(error, ErpcError::Http { status: 307 }));
    assert_eq!(hosted_redirect.received_requests().await.unwrap().len(), 1);
    assert!(
        hosted_destination
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );

    let unconfigured =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_solana_rpc("http://127.0.0.1:9"))
            .expect("sibling direct configuration");
    let error = unconfigured
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("unconfigured Sui must be inert");
    assert!(matches!(error, ErpcError::NotConfigured(namespace) if namespace == "sui.grpc"));

    let sui_only_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&sui_only_server)
        .await;
    let sui_only =
        ErpcClient::new(ErpcClientConfig::for_rpc().with_sui_grpc_web(sui_only_server.uri()))
            .expect("Sui-only direct configuration");
    sui_only
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect("configured Sui");
    let error = sui_only.near.rpc.status().send().await.unwrap_err();
    assert!(matches!(error, ErpcError::NotConfigured(namespace) if namespace == "near.rpc"));
}

#[allow(clippy::too_many_lines)]
#[tokio::test]
async fn timeout_and_cancellation_cover_response_headers_and_delayed_body() {
    let timeout_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&timeout_server)
        .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_sui_grpc_web(timeout_server.uri())
            .with_timeout(Duration::from_millis(40)),
    )
    .expect("timeout configuration");
    let error = timeout_client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("timeout before response headers");
    assert!(matches!(error, ErpcError::Timeout { .. }));

    let cancellation_server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(250))
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(1)
        .mount(&cancellation_server)
        .await;
    let cancellation_client = direct_client(cancellation_server.uri());
    let cancellation = CancellationToken::new();
    let pending = cancellation_client.sui.grpc.get_service_info();
    let task = tokio::spawn({
        let cancellation = cancellation.clone();
        async move {
            pending
                .send_with(RequestOptions {
                    cancellation: Some(cancellation),
                })
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancellation.cancel();
    let error = task
        .await
        .expect("cancellation task")
        .expect_err("cancellation before response headers");
    assert!(matches!(error, ErpcError::Aborted));

    let delayed_body = spawn_raw_chunked_server(
        200,
        &[("content-type", SUI_GRPC_WEB_CONTENT_TYPE)],
        data_body(),
        Some(1),
        Some(Duration::from_millis(250)),
    )
    .await;
    let delayed_client = direct_client(delayed_body.uri.clone());
    let cancellation = CancellationToken::new();
    let pending = delayed_client.sui.grpc.get_service_info();
    let task = tokio::spawn({
        let cancellation = cancellation.clone();
        async move {
            pending
                .send_with(RequestOptions {
                    cancellation: Some(cancellation),
                })
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    cancellation.cancel();
    let error = task
        .await
        .expect("body cancellation task")
        .expect_err("cancellation during body");
    assert!(matches!(error, ErpcError::Aborted));
    delayed_body.join().await;

    let delayed_timeout = spawn_raw_chunked_server(
        200,
        &[("content-type", SUI_GRPC_WEB_CONTENT_TYPE)],
        data_body(),
        Some(1),
        Some(Duration::from_millis(250)),
    )
    .await;
    let timeout_client = ErpcClient::new(
        ErpcClientConfig::for_rpc()
            .with_sui_grpc_web(delayed_timeout.uri.clone())
            .with_timeout(Duration::from_millis(40)),
    )
    .expect("body timeout configuration");
    let error = timeout_client
        .sui
        .grpc
        .get_service_info()
        .send()
        .await
        .expect_err("timeout during body");
    assert!(matches!(error, ErpcError::Timeout { .. }));
    delayed_timeout.join().await;
}

#[tokio::test]
async fn input_validation_and_pending_requests_are_inert() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", SUI_GRPC_WEB_CONTENT_TYPE)
                .set_body_bytes(data_body()),
        )
        .expect(0)
        .mount(&server)
        .await;
    let client = direct_client(server.uri());
    drop(client.sui.grpc.get_service_info());
    assert!(client.sui.grpc.get_object("", None).is_err());
    assert!(client.sui.grpc.get_balance("owner\n", "coin").is_err());
    assert!(client.sui.grpc.get_balance("owner", "").is_err());
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(server.received_requests().await.unwrap().is_empty());
}
