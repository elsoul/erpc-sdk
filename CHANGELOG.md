# Changelog

## Unreleased

## 0.6.0 — 2026-09-07

- Add first-class AVAX, X-Chain, P-Chain, proposer VM, network information, and
  C/P/X Index API namespaces to the TypeScript, Rust, Python, Go, and Ruby SDKs.
- Keep native method names wire-compatible, route Index calls through their
  explicit chain/container paths, and reject unsupported native batches before
  network I/O.

## 0.5.0 — 2026-09-04

- Add Avalanche C-Chain JSON-RPC and WebSocket namespaces to all five SDKs,
  backed by the dedicated `ava-rpc.erpc.global` endpoint and the shared
  Ethereum-compatible typed method catalog.
- Add an independently configurable Avalanche endpoint while preserving API-key
  redaction, intact batch behavior, and no-retry transport rules.
- Align Python's runtime `__version__` with its package manifest and enforce the
  match during release validation.

## 0.4.0 — 2026-08-29

- Add the dependency-free `erpc-sdk` Ruby gem with synchronous JSON-RPC,
  REST, SSE, WebSocket subscription, account usage, and Cloud read clients.
- Extend ordered method-catalog parity, CI, package inspection, and the
  Trusted Publishing release workflow to Ruby and RubyGems.

## 0.3.0 — 2026-08-28

- Add the `erpc-sdk` Python distribution with asynchronous JSON-RPC, REST,
  streaming, and subscription clients.
- Add the context-aware Go module at
  `github.com/elsoul/erpc-sdk/packages/go`.
- Verify all four language implementations against the same ordered RPC
  method catalogs and transport safety rules.
- Extend CI and the tag-driven release process to Python and Go.

## 0.2.0 — 2026-08-28

- Add `usage.getMonthlyApiKeyUsage` with masked, projected API-key data.
- Add a scoped OAuth Cloud client with capability catalog, credit snapshot, and
  credential-free resource inventory.
- Add user API endpoint configuration, tests, and Cloud documentation.
- Add the async `erpc-sdk` Rust crate with TypeScript namespace and method
  parity, JSON-RPC batching, subscriptions, price streaming, and Cloud reads.
- Add tag-driven, human-approved npm and crates.io release automation.

## 0.1.0

- Publish the initial type-safe TypeScript SDK for ERPC.
