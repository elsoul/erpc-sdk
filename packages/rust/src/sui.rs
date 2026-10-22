//! Read-only Sui gRPC-Web client with a bounded public surface.

use std::{marker::PhantomData, sync::Arc};

use crate::{ErpcError, Result, rpc::RequestOptions, sui_grpc_web};
use prost::Message;

/// Exact case-sensitive Sui unary method paths supported by this SDK.
pub const SUI_GRPC_WEB_METHODS: &[&str] = sui_grpc_web::SUI_GRPC_WEB_METHODS;

/// Binary gRPC-Web content type required by the Sui endpoint.
pub const SUI_GRPC_WEB_CONTENT_TYPE: &str = sui_grpc_web::SUI_GRPC_WEB_CONTENT_TYPE;

/// Sui service identity returned by `GetServiceInfo`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SuiServiceInfo {
    /// Full Sui genesis digest used as the chain identifier.
    pub chain_id: String,
    /// Human-readable Sui chain name.
    pub chain: String,
    /// Current epoch number.
    pub epoch: u64,
    /// Current checkpoint height.
    pub checkpoint_height: u64,
    /// Service timestamp in Unix seconds.
    pub timestamp_seconds: i64,
    /// Nanosecond component of the service timestamp.
    pub timestamp_nanos: i32,
    /// Lowest checkpoint retained by the service.
    pub lowest_available_checkpoint: u64,
    /// Lowest checkpoint retained for object queries.
    pub lowest_available_checkpoint_objects: u64,
    /// Optional server version string.
    pub server: Option<String>,
}

/// Sui object identity projection returned by `GetObject`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SuiObjectSummary {
    /// Sui object identifier.
    pub object_id: String,
    /// Object version.
    pub version: u64,
    /// Object digest.
    pub digest: String,
}

/// Sui balance projection returned by `GetBalance`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SuiBalance {
    /// Coin type tag as returned by Sui.
    pub coin_type: String,
    /// Total balance in the exact base unit returned by Sui.
    pub balance: u64,
    /// Address balance component in the exact base unit.
    pub address_balance: u64,
    /// Coin balance component in the exact base unit.
    pub coin_balance: u64,
}

/// Public Sui namespace containing only the binary gRPC-Web client.
#[derive(Clone)]
pub struct SuiClient {
    /// Sui gRPC-Web read client.
    pub grpc: SuiGrpcWebClient,
}

impl SuiClient {
    /// Constructs the namespace from the integrator-owned transport.
    pub(crate) fn new(transport: Arc<sui_grpc_web::SuiGrpcWebTransport>) -> SuiClient {
        Self {
            grpc: SuiGrpcWebClient { transport },
        }
    }
}

/// Read-only Sui gRPC-Web client.
#[derive(Clone)]
pub struct SuiGrpcWebClient {
    transport: Arc<sui_grpc_web::SuiGrpcWebTransport>,
}

impl SuiGrpcWebClient {
    /// Returns the credential-safe configured origin, or an empty string.
    #[must_use]
    pub fn endpoint(&self) -> String {
        self.transport.endpoint()
    }

    /// Creates an inert `GetServiceInfo` request.
    #[must_use]
    pub fn get_service_info(&self) -> PendingSuiGrpcWebRequest<SuiServiceInfo> {
        PendingSuiGrpcWebRequest {
            transport: Arc::clone(&self.transport),
            method: SUI_GRPC_WEB_METHODS[0],
            body: vec![0, 0, 0, 0, 0],
            decoder: decode_service_info,
            marker: PhantomData,
        }
    }

    /// Creates an inert `GetObject` request.
    pub fn get_object(
        &self,
        object_id: impl Into<String>,
        version: Option<u64>,
    ) -> Result<PendingSuiGrpcWebRequest<SuiObjectSummary>> {
        let object_id = object_id.into();
        validate_input(&object_id)?;
        let body = sui_grpc_web::frame_request(&crate::sui_proto::GetObjectRequest {
            object_id,
            version,
        })?;
        Ok(PendingSuiGrpcWebRequest {
            transport: Arc::clone(&self.transport),
            method: SUI_GRPC_WEB_METHODS[1],
            body,
            decoder: decode_object,
            marker: PhantomData,
        })
    }

    /// Creates an inert `GetBalance` request.
    pub fn get_balance(
        &self,
        owner: impl Into<String>,
        coin_type: impl Into<String>,
    ) -> Result<PendingSuiGrpcWebRequest<SuiBalance>> {
        let owner = owner.into();
        let coin_type = coin_type.into();
        validate_input(&owner)?;
        validate_input(&coin_type)?;
        let body =
            sui_grpc_web::frame_request(&crate::sui_proto::GetBalanceRequest { owner, coin_type })?;
        Ok(PendingSuiGrpcWebRequest {
            transport: Arc::clone(&self.transport),
            method: SUI_GRPC_WEB_METHODS[2],
            body,
            decoder: decode_balance,
            marker: PhantomData,
        })
    }
}

/// An inert, typed Sui gRPC-Web request.
pub struct PendingSuiGrpcWebRequest<T> {
    transport: Arc<sui_grpc_web::SuiGrpcWebTransport>,
    method: &'static str,
    body: Vec<u8>,
    decoder: fn(&[u8]) -> Result<T>,
    marker: PhantomData<fn() -> T>,
}

impl<T> PendingSuiGrpcWebRequest<T> {
    /// Sends this request with the default timeout and cancellation behavior.
    pub async fn send(self) -> Result<T> {
        self.send_with(RequestOptions::default()).await
    }

    /// Sends this request with caller-provided cancellation options.
    pub async fn send_with(self, options: RequestOptions) -> Result<T> {
        let bytes = self
            .transport
            .execute(self.method, &self.body, &options)
            .await?;
        (self.decoder)(&bytes)
    }
}

fn validate_input(value: &str) -> Result<()> {
    if value.is_empty() || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(ErpcError::Config(
            "Sui input must be non-empty and contain no ASCII control characters".to_owned(),
        ));
    }
    Ok(())
}

fn decode_service_info(bytes: &[u8]) -> Result<SuiServiceInfo> {
    let response =
        crate::sui_proto::GetServiceInfoResponse::decode(bytes).map_err(|_| invalid_response())?;
    let timestamp = response.timestamp.ok_or_else(invalid_response)?;
    let timestamp_nanos = timestamp.nanos;
    if !(0..1_000_000_000).contains(&timestamp_nanos) {
        return Err(invalid_response());
    }
    Ok(SuiServiceInfo {
        chain_id: required(response.chain_id)?,
        chain: required(response.chain)?,
        epoch: required(response.epoch)?,
        checkpoint_height: required(response.checkpoint_height)?,
        timestamp_seconds: timestamp.seconds,
        timestamp_nanos,
        lowest_available_checkpoint: required(response.lowest_available_checkpoint)?,
        lowest_available_checkpoint_objects: required(
            response.lowest_available_checkpoint_objects,
        )?,
        server: response.server,
    })
}

fn decode_object(bytes: &[u8]) -> Result<SuiObjectSummary> {
    let response =
        crate::sui_proto::GetObjectResponse::decode(bytes).map_err(|_| invalid_response())?;
    let object = response.object.ok_or_else(invalid_response)?;
    Ok(SuiObjectSummary {
        object_id: required(object.id)?,
        version: required(object.version)?,
        digest: required(object.digest)?,
    })
}

fn decode_balance(bytes: &[u8]) -> Result<SuiBalance> {
    let response =
        crate::sui_proto::GetBalanceResponse::decode(bytes).map_err(|_| invalid_response())?;
    let balance = response.balance.ok_or_else(invalid_response)?;
    let result = SuiBalance {
        coin_type: required(balance.coin_type)?,
        balance: required(balance.total)?,
        address_balance: required(balance.address)?,
        coin_balance: required(balance.coin)?,
    };
    let components = result
        .address_balance
        .checked_add(result.coin_balance)
        .ok_or_else(invalid_response)?;
    if components != result.balance {
        return Err(invalid_response());
    }
    Ok(result)
}

fn required<T>(value: Option<T>) -> Result<T> {
    value.ok_or_else(invalid_response)
}

fn invalid_response() -> ErpcError {
    ErpcError::InvalidResponse("Sui gRPC-Web response protobuf is invalid".to_owned())
}
