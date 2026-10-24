# Third-party notices

Original ERPC SDK source remains under MIT. The bounded Sui gRPC-Web codec in `sui_proto.go` is a handwritten, modified projection of the pinned MystenLabs Sui API schema at commit `aa9ba2c13b2a9348059b38110e64af39849a0377`, with the Google Timestamp terms retained for the Timestamp projection.

The Sui projection is dependency-free and implements only the three read-only unary methods in `sui.go`/`sui_grpc_web.go`; unrelated schema fields and runtime APIs are intentionally omitted. Copyright (c) Mysten Labs, Inc. The Google Timestamp projection retains: Copyright 2008 Google Inc. All rights reserved. The aggregate distribution expression is `MIT AND Apache-2.0 AND BSD-3-Clause`. See `LICENSES/Apache-2.0.txt` and `LICENSES/BSD-3-Clause-Google-Protobuf.txt`.

Pinned upstream paths:

- [ledger_service.proto](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/ledger_service.proto)
- [state_service.proto](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/state_service.proto)
- [object.proto](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/object.proto)
- [timestamp.proto](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/google/protobuf/timestamp.proto)

The upstream Sui source is Apache-2.0; the Timestamp file carries Google's BSD-3-Clause header. No protobuf or gRPC runtime dependency is added. No separate upstream NOTICE file was present at the pinned source revision. This project notice records provenance and does not modify the upstream grants.
