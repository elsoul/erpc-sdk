//! Private binary gRPC-Web transport for the bounded Sui read API.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{
    Client, Response,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
};
use url::Url;

use crate::{ErpcError, Result, error::invalid_response, error::timeout, rpc::RequestOptions};

/// Binary gRPC-Web content type required by the Sui endpoint.
pub(crate) const SUI_GRPC_WEB_CONTENT_TYPE: &str = "application/grpc-web+proto";

/// Exact case-sensitive unary method paths supported by this transport.
pub(crate) const SUI_GRPC_WEB_METHODS: &[&str] = &[
    "/sui.rpc.v2.LedgerService/GetServiceInfo",
    "/sui.rpc.v2.LedgerService/GetObject",
    "/sui.rpc.v2.StateService/GetBalance",
];

const REQUEST_LIMIT: usize = 1_048_576;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const TRAILER_LIMIT: usize = 8 * 1024;
const FRAME_HEADER_LEN: usize = 5;

const TRANSPORT_SEND_ERROR: &str = "Unable to reach Sui gRPC-Web endpoint";
const TRANSPORT_READ_ERROR: &str = "Unable to read Sui gRPC-Web response";

/// A credential-safe Sui binary gRPC-Web transport.
pub(crate) struct SuiGrpcWebTransport {
    base_url: Url,
    headers: HeaderMap,
    timeout: Duration,
    client: Client,
    configured: bool,
}

impl SuiGrpcWebTransport {
    /// Creates a hosted ERPC transport with bearer authentication.
    pub(crate) fn new_hosted(
        api_key: String,
        base_url: Url,
        headers: HeaderMap,
        timeout: Duration,
        client: Client,
    ) -> crate::Result<SuiGrpcWebTransport> {
        if api_key.is_empty() {
            return Err(ErpcError::Config(
                "Sui gRPC-Web API key is invalid".to_owned(),
            ));
        }
        let mut headers = headers;
        let mut bearer = Vec::with_capacity("Bearer ".len() + api_key.len());
        bearer.extend_from_slice(b"Bearer ");
        bearer.extend(api_key.into_bytes());
        let value = HeaderValue::from_bytes(&bearer)
            .map_err(|_| ErpcError::Config("Sui gRPC-Web API key is invalid".to_owned()))?;
        headers.insert(AUTHORIZATION, value);
        set_protocol_headers(&mut headers);
        Ok(Self {
            base_url,
            headers,
            timeout,
            client,
            configured: true,
        })
    }

    /// Creates a caller-owned direct binary gRPC-Web transport.
    pub(crate) fn new_direct(
        base_url: Url,
        mut headers: HeaderMap,
        timeout: Duration,
        client: Client,
    ) -> SuiGrpcWebTransport {
        set_protocol_headers(&mut headers);
        Self {
            base_url,
            headers,
            timeout,
            client,
            configured: true,
        }
    }

    /// Creates a local, non-networking transport for an unconfigured namespace.
    pub(crate) fn unavailable(timeout: Duration, client: Client) -> SuiGrpcWebTransport {
        Self {
            base_url: Url::parse("http://127.0.0.1/").expect("static unavailable URL"),
            headers: HeaderMap::new(),
            timeout,
            client,
            configured: false,
        }
    }

    /// Returns only the configured origin and a root slash.
    pub(crate) fn endpoint(&self) -> String {
        if !self.configured {
            return String::new();
        }
        let mut endpoint = self.base_url.clone();
        let _ = endpoint.set_username("");
        let _ = endpoint.set_password(None);
        endpoint.set_path("/");
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        endpoint.to_string()
    }

    pub(crate) async fn execute(
        &self,
        method: &'static str,
        body: &[u8],
        options: &RequestOptions,
    ) -> Result<Vec<u8>> {
        self.ensure_configured()?;
        if let Some(cancellation) = &options.cancellation {
            if cancellation.is_cancelled() {
                return Err(ErpcError::Aborted);
            }
        }
        let url = append_method(&self.base_url, method);
        let client = self.client.clone();
        let headers = self.headers.clone();
        let request_body = body.to_vec();
        let operation = async move {
            let response = client
                .post(url)
                .headers(headers)
                .body(request_body)
                .send()
                .await
                .map_err(|_| ErpcError::Transport(TRANSPORT_SEND_ERROR.to_owned()))?;
            if response.status().as_u16() != 200 {
                return Err(ErpcError::Http {
                    status: response.status().as_u16(),
                });
            }
            validate_content_type(&response)?;
            let body = read_bounded_body(response).await?;
            extract_data_frame(&body)
        };
        let timed = tokio::time::timeout(self.timeout, operation);
        if let Some(cancellation) = &options.cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => Err(ErpcError::Aborted),
                result = timed => result.map_err(|_| timeout(self.timeout))?,
            }
        } else {
            timed.await.map_err(|_| timeout(self.timeout))?
        }
    }

    fn ensure_configured(&self) -> Result<()> {
        if self.configured {
            Ok(())
        } else {
            Err(ErpcError::NotConfigured("sui.grpc".to_owned()))
        }
    }
}

impl Clone for SuiGrpcWebTransport {
    fn clone(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            headers: self.headers.clone(),
            timeout: self.timeout,
            client: self.client.clone(),
            configured: self.configured,
        }
    }
}

fn set_protocol_headers(headers: &mut HeaderMap) {
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(SUI_GRPC_WEB_CONTENT_TYPE),
    );
    headers.insert(ACCEPT, HeaderValue::from_static(SUI_GRPC_WEB_CONTENT_TYPE));
    headers.insert(
        reqwest::header::HeaderName::from_static("x-grpc-web"),
        HeaderValue::from_static("1"),
    );
}

fn append_method(base_url: &Url, method: &str) -> Url {
    let mut url = base_url.clone();
    let prefix = url.path().trim_end_matches('/');
    let method = method.trim_start_matches('/');
    let joined = if prefix.is_empty() {
        format!("/{method}")
    } else {
        format!("{prefix}/{method}")
    };
    url.set_path(&joined);
    url
}

fn validate_content_type(response: &Response) -> Result<()> {
    let mut values = response.headers().get_all(CONTENT_TYPE).iter();
    let Some(value) = values.next() else {
        return Err(invalid_response(
            "Sui gRPC-Web response content type is invalid",
        ));
    };
    if values.next().is_some()
        || value.to_str().is_err()
        || value.to_str().ok() != Some(SUI_GRPC_WEB_CONTENT_TYPE)
    {
        return Err(invalid_response(
            "Sui gRPC-Web response content type is invalid",
        ));
    }
    Ok(())
}

async fn read_bounded_body(response: Response) -> Result<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ErpcError::Transport(TRANSPORT_READ_ERROR.to_owned()))?;
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| invalid_response("Sui gRPC-Web response is too large"))?;
        if next_len > RESPONSE_LIMIT {
            return Err(invalid_response("Sui gRPC-Web response is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn extract_data_frame(body: &[u8]) -> Result<Vec<u8>> {
    if body.len() < FRAME_HEADER_LEN * 2 {
        return Err(invalid_response("Sui gRPC-Web response framing is invalid"));
    }
    if body[0] != 0 {
        return Err(invalid_response("Sui gRPC-Web response framing is invalid"));
    }
    let data_len = frame_length(body, 0)?;
    let trailer_offset = FRAME_HEADER_LEN
        .checked_add(data_len)
        .ok_or_else(|| invalid_response("Sui gRPC-Web response framing is invalid"))?;
    if trailer_offset.checked_add(FRAME_HEADER_LEN).is_none()
        || trailer_offset + FRAME_HEADER_LEN > body.len()
        || body[trailer_offset] != 0x80
    {
        return Err(invalid_response("Sui gRPC-Web response framing is invalid"));
    }
    let trailer_len = frame_length(body, trailer_offset)?;
    if trailer_len > TRAILER_LIMIT {
        return Err(invalid_response(
            "Sui gRPC-Web response trailer is too large",
        ));
    }
    let trailer_start = trailer_offset + FRAME_HEADER_LEN;
    let trailer_end = trailer_start
        .checked_add(trailer_len)
        .ok_or_else(|| invalid_response("Sui gRPC-Web response framing is invalid"))?;
    if trailer_end != body.len() {
        return Err(invalid_response("Sui gRPC-Web response framing is invalid"));
    }
    validate_trailer(&body[trailer_start..trailer_end])?;
    Ok(body[FRAME_HEADER_LEN..trailer_offset].to_vec())
}

fn frame_length(body: &[u8], offset: usize) -> Result<usize> {
    let end = offset
        .checked_add(FRAME_HEADER_LEN)
        .ok_or_else(|| invalid_response("Sui gRPC-Web response framing is invalid"))?;
    if end > body.len() {
        return Err(invalid_response("Sui gRPC-Web response framing is invalid"));
    }
    let len = u32::from_be_bytes([
        body[offset + 1],
        body[offset + 2],
        body[offset + 3],
        body[offset + 4],
    ]);
    usize::try_from(len).map_err(|_| invalid_response("Sui gRPC-Web response framing is invalid"))
}

fn validate_trailer(trailer: &[u8]) -> Result<()> {
    let trailer = std::str::from_utf8(trailer)
        .map_err(|_| invalid_response("Sui gRPC-Web response trailer is invalid"))?;
    if !trailer.ends_with("\r\n") {
        return Err(invalid_response("Sui gRPC-Web response trailer is invalid"));
    }
    let mut status_seen = false;
    for line in trailer.split_terminator("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            return Err(invalid_response("Sui gRPC-Web response trailer is invalid"));
        };
        if !is_header_name(name)
            || value
                .chars()
                .any(|character| character.is_control() && character != '\t')
        {
            return Err(invalid_response("Sui gRPC-Web response trailer is invalid"));
        }
        let value = value.trim_matches([' ', '\t']);
        if name == "grpc-status" {
            if status_seen || value != "0" {
                return Err(invalid_response("Sui gRPC-Web response status is invalid"));
            }
            status_seen = true;
        }
    }
    if !status_seen {
        return Err(invalid_response("Sui gRPC-Web response status is missing"));
    }
    Ok(())
}

fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || b"!#$%&'*+-.^_|~".contains(&byte)
                || byte == 96
        })
}

/// Frames one protobuf message as one uncompressed gRPC-Web request.
pub(crate) fn frame_request<M: prost::Message>(message: &M) -> Result<Vec<u8>> {
    let payload = message.encode_to_vec();
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| ErpcError::Config("Sui gRPC-Web request is too large".to_owned()))?;
    let frame_len = payload
        .len()
        .checked_add(FRAME_HEADER_LEN)
        .ok_or_else(|| ErpcError::Config("Sui gRPC-Web request is too large".to_owned()))?;
    if frame_len > REQUEST_LIMIT {
        return Err(ErpcError::Config(
            "Sui gRPC-Web request is too large".to_owned(),
        ));
    }
    let mut frame = Vec::with_capacity(frame_len);
    frame.push(0);
    frame.extend_from_slice(&payload_len.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}
