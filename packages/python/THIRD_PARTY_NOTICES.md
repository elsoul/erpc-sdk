# Third party notices

The original ERPC SDK source remains available under the package `LICENSE`
(MIT). The package also contains a modified, bounded Sui schema projection
under Apache-2.0 and a local Timestamp projection carrying Google's
BSD-3-Clause terms. These component terms travel together as
`MIT AND Apache-2.0 AND BSD-3-Clause`.

## Sui schema projection

The handwritten Python codec is [src/erpc_sdk/_sui_proto.py](src/erpc_sdk/_sui_proto.py),
adapted from MystenLabs/sui-apis commit
`aa9ba2c13b2a9348059b38110e64af39849a0377`:

- `proto/sui/rpc/v2/ledger_service.proto`
- `proto/sui/rpc/v2/state_service.proto`
- `proto/sui/rpc/v2/object.proto`
- `proto/google/protobuf/timestamp.proto`

It is a modified, handwritten bounded projection of only three read-only
unary methods and Timestamp. Unrelated schema fields and all general
protobuf/gRPC runtime functionality are omitted. The codec is not generated
by upstream tooling and adds no Prost, protobuf, or gRPC runtime dependency.

The adapted source retains `Copyright (c) Mysten Labs, Inc.`. The Timestamp
projection retains `Copyright 2008 Google Inc. All rights reserved.`.

The pinned upstream components are:

- [`ledger_service.proto`](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/ledger_service.proto)
- [`state_service.proto`](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/state_service.proto)
- [`object.proto`](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/sui/rpc/v2/object.proto)
- [`timestamp.proto`](https://github.com/MystenLabs/sui-apis/blob/aa9ba2c13b2a9348059b38110e64af39849a0377/proto/google/protobuf/timestamp.proto)

The Mysten projection retains its Apache-2.0 source identity and the Google
Timestamp projection retains Google's complete BSD-3-Clause header adjacent
to the local implementation. The exact texts are distributed at
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) and
[`LICENSES/BSD-3-Clause-Google-Protobuf.txt`](LICENSES/BSD-3-Clause-Google-Protobuf.txt).

The pinned upstream tree contained no separate NOTICE path at this commit.
This project notice records provenance and does not modify the upstream grants.
