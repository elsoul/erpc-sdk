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

## 0.3 — Rust expansion

- Reuse language-neutral fixtures and compatibility snapshots.
- Provide blocking and async examples.
- Expand structured Rust result types where protocols permit stable shapes.

## 0.4 — Wider language support

- Python package with synchronous and asynchronous clients.
- Go module with context-aware HTTP and WebSocket clients.
- Choose release order from ERPC user demand while keeping method parity.

## Service-dependent expansion

The following SDK work starts only after the corresponding server capability
is publicly available and contract-tested:

- paginated token-account-by-owner V2 queries;
- compressed-state and zero-knowledge RPC;
- preconfirmation subscriptions;
- Ethereum debug, trace, execution-client, and consensus-layer namespaces;
- optional add-on namespaces.

Releases are manually approved. Merging a change never publishes a package.
