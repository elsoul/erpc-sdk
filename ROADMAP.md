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

## 0.5 — Avalanche C-Chain

- Expose Avalanche C-Chain JSON-RPC and WebSocket namespaces in all five SDKs.
- Reuse the Ethereum-compatible typed catalog while keeping the dedicated
  Avalanche endpoint independently configurable.
- Cover endpoint routing, credential redaction, and live C-Chain identity in
  automated tests.

## 0.6 — Avalanche native chains

- Expose C-Chain AVAX, X-Chain, P-Chain, proposer VM, and network information
  methods in all five SDKs.
- Expose explicit C/P/X block and X-Chain transaction Index API routes.
- Keep native API batching disabled locally while preserving C-Chain EVM batch
  behavior.

## 0.7 — Canonical token catalog (UNRELEASED)

The bounded catalog is present on `main` and planned for `0.7.0`. The current
published package baseline, latest GitHub release, and package manifests remain
`0.6.0`, so the catalog is not available from the currently published package.

- Bundle 39 assets, 60 deployments, and 60 aliases across Ethereum, Solana,
  and Avalanche C-Chain in all five SDKs.
- Expose local asset and deployment lookup, chain and stable-currency filters,
  symbol and address lookup, native-token lookup, and lifecycle metadata.
- Keep `USD`, `EUR`, and `JPY` as explicit stable-currency labels. The bounded
  catalog does not claim complete coverage, ranking, or market data.
- Run the installed Tuesday 03:17 UTC observation PR and Thursday 03:47 UTC
  release-preparation PR workflows. They create or update reviewable PRs and
  CI; package publication remains a human-invoked release action.

## Next phase — DEX, pools, and local swaps

- Define DEX and pool records and a reviewed quote, route, and transaction-build
  contract using configured RPC endpoints and local logic.
- Keep hosted Jupiter and 0x dependencies out of the SDK registry.
- Keep bridging as separate research covering exact source and destination
  chains, native versus wrapped addresses, proof or attestation rules, and
  relayer dependencies.

## Service-dependent expansion

The following SDK work starts only after the corresponding server capability
is publicly available and contract-tested:

- paginated token-account-by-owner V2 queries;
- compressed-state and zero-knowledge RPC;
- preconfirmation subscriptions;
- Ethereum debug, trace, execution-client, and consensus-layer namespaces;
- optional add-on namespaces.

Releases are manually approved and publication is human-invoked. Merging a
change never publishes a package.
