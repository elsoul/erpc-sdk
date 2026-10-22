# Third-party notices

This crate contains original ERPC SDK source under the MIT licence in
`LICENSE`. It also contains the bounded adapted Sui RPC v2 schema projection
in `src/sui_proto.rs`, which remains under Apache-2.0.

## Mysten Labs Sui schema

The Sui projection retains the Mysten Labs copyright and Apache-2.0 SPDX
header. It is an adapted and modified Rust/Prost subset of commit
`aa9ba2c13b2a9348059b38110e64af39849a0377`, limited to the unary read messages
used by this SDK:

- `proto/sui/rpc/v2/ledger_service.proto`
- `proto/sui/rpc/v2/state_service.proto`
- `proto/sui/rpc/v2/object.proto`

The local affected file is `src/sui_proto.rs`. It projects only the selected
service-info, object-identity, and balance messages and does not vendor the
upstream schema tree. The applicable licence text is adjacent at
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). The pinned upstream tree
contains no separate `NOTICE` file to reproduce.

## Prost dependencies

The crate depends on the following released crates for the private Sui
codec/projection implementation. Their declared upstream licence is
Apache-2.0; their source is resolved from Cargo rather than vendored here.

- [`prost 0.14.4`](https://crates.io/crates/prost/0.14.4)
- [`prost-types 0.14.4`](https://crates.io/crates/prost-types/0.14.4)

This notice records source provenance and dependency attribution for the
unreleased Rust source candidate. It is planning evidence and does not issue a
legal compliance, CE, steward, or distribution certification.
