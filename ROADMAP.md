# Roadmap

## 0.1 — TypeScript foundation

- TypeScript package managed with pnpm.
- One client configuration and API key for all ERPC products.
- Complete method catalogs for currently exposed Solana and Ethereum RPC.
- Indexed asset, history, leader, validator, and analytics namespaces.
- Price REST and server-sent events.
- Ethereum and enhanced Solana WebSocket subscriptions.
- Token balance API.
- Masked monthly API-key usage.
- Unit, transport, package, and live smoke-test coverage.
- Human-approved npm release workflow using trusted publishing and provenance.

## 0.2 — TypeScript stabilization

- Verify live behavior against every public ERPC route.
- Expand structured result types where protocols permit multiple response
  shapes.
- Add framework examples and migration recipes.
- Promote the npm package to stable after preview feedback and human review.
- Roll out scoped OAuth Cloud reads for monthly usage, capability catalog,
  credit snapshots, and credential-free resource inventory.
- Publish the initial async Rust crate with the same namespaces, method
  catalogs, transport boundaries, Cloud reads, and credential safety rules.

## 0.3 — Python and Go

- Reuse language-neutral fixtures and compatibility snapshots.
- Publish a Python package with asynchronous HTTP, SSE, and WebSocket clients.
- Publish a Go module with context-aware HTTP, SSE, and WebSocket clients.
- Gate all four implementations on ordered method-catalog parity, package
  inspection, credential redaction, batch boundaries, and no-retry behavior.

## 0.4 — Ruby and typed expansion

- Publish a dependency-free Ruby gem with synchronous HTTP, SSE, and WebSocket
  clients and the same transport safety boundaries.
- Gate all five implementations on ordered method-catalog parity.
- Expand structured result types where protocols permit stable shapes.
- Add synchronous Python and blocking Rust convenience clients where demand
  justifies the additional maintenance surface.
- Reuse language-neutral transport and compatibility fixtures.

## Service-dependent expansion

The following SDK work starts only after the corresponding server capability
is publicly available and contract-tested:

- paginated token-account-by-owner V2 queries;
- compressed-state and zero-knowledge RPC;
- preconfirmation subscriptions;
- Ethereum debug, trace, execution-client, and consensus-layer namespaces;
- optional add-on namespaces.

Releases are manually approved. Merging a change never publishes a package.
