// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// This file is an adapted and modified bounded Rust/Prost projection of the
// Mysten Labs Sui RPC v2 schema. It is intentionally limited to the three
// read-only unary methods implemented by this SDK. The source is pinned to
// commit aa9ba2c13b2a9348059b38110e64af39849a0377 and was adapted from:
//   proto/sui/rpc/v2/ledger_service.proto
//   proto/sui/rpc/v2/state_service.proto
//   proto/sui/rpc/v2/object.proto

//! Private, bounded Sui gRPC-Web protobuf projection.

use prost::Message;
use prost_types::Timestamp;

/// Selected service identity fields returned by Sui.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct GetServiceInfoResponse {
    #[prost(string, optional, tag = "1")]
    pub(crate) chain_id: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub(crate) chain: Option<String>,
    #[prost(uint64, optional, tag = "3")]
    pub(crate) epoch: Option<u64>,
    #[prost(uint64, optional, tag = "4")]
    pub(crate) checkpoint_height: Option<u64>,
    #[prost(message, optional, tag = "5")]
    pub(crate) timestamp: Option<Timestamp>,
    #[prost(uint64, optional, tag = "6")]
    pub(crate) lowest_available_checkpoint: Option<u64>,
    #[prost(uint64, optional, tag = "7")]
    pub(crate) lowest_available_checkpoint_objects: Option<u64>,
    #[prost(string, optional, tag = "8")]
    pub(crate) server: Option<String>,
}

/// Request for the selected object identity projection.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct GetObjectRequest {
    #[prost(string, optional, tag = "1")]
    pub(crate) object_id: Option<String>,
    #[prost(uint64, optional, tag = "2")]
    pub(crate) version: Option<u64>,
}

/// Response containing one selected object.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct GetObjectResponse {
    #[prost(message, optional, tag = "1")]
    pub(crate) object: Option<Object>,
}

/// Bounded object identity projection.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct Object {
    #[prost(string, optional, tag = "2")]
    pub(crate) id: Option<String>,
    #[prost(uint64, optional, tag = "3")]
    pub(crate) version: Option<u64>,
    #[prost(string, optional, tag = "4")]
    pub(crate) digest: Option<String>,
}

/// Request for one owner's balance in one coin type.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct GetBalanceRequest {
    #[prost(string, optional, tag = "1")]
    pub(crate) owner: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub(crate) coin_type: Option<String>,
}

/// Response containing one balance.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct GetBalanceResponse {
    #[prost(message, optional, tag = "1")]
    pub(crate) balance: Option<Balance>,
}

/// Bounded balance projection. The non-contiguous tags are part of Sui's IDL.
#[derive(Clone, PartialEq, Message)]
pub(crate) struct Balance {
    #[prost(string, optional, tag = "1")]
    pub(crate) coin_type: Option<String>,
    #[prost(uint64, optional, tag = "3")]
    pub(crate) total: Option<u64>,
    #[prost(uint64, optional, tag = "4")]
    pub(crate) address: Option<u64>,
    #[prost(uint64, optional, tag = "5")]
    pub(crate) coin: Option<u64>,
}
