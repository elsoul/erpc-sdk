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

## 0.7 — Token, DEX, pool, and ranking catalogs (UNRELEASED)

The source checkout contains the bounded token, DEX, pool, and ranking
implementation planned for `0.7.0`. A 2026-09-16 local integration populated
the source snapshot with partial three-chain coverage: 44 assets, 65 token
deployments, 12 pools, and 11 ranking records. The current published package
baseline, latest GitHub release, and package manifests remain `0.6.0`, so
these new catalog and quote exports are not available from the currently
published packages.

- Keep token records source-backed and bounded across Ethereum, Solana, and
  Avalanche C-Chain in all five SDKs.
- Expose local asset and deployment lookup, chain and stable-currency filters,
  symbol and address lookup, native-token lookup, and lifecycle metadata.
- Keep `USD`, `EUR`, and `JPY` as explicit stable-currency labels. The bounded
  catalog does not claim complete coverage, ranking, or market data.
- Preserve append-only public IDs and aliases. New tokens discovered by the
  bounded three-chain RPC scan remain unclassified with address-only names and
  symbols, with null `stableCurrency`, `underlyingAssetId`, and
  `economicReferenceAssetId` fields until review.
- Maintain bounded resumable factory/program discovery with 8-token and
  8-pool admission caps. Fresh verified receipts revalidate deferred work;
  outages never retire existing records.
- Provide RPC-only exact-input quotes for Ethereum Uniswap V2 WETH/USDC and
  Avalanche LFJ legacy WAVAX/USDC. Keep Solana Orca Whirlpools and Raydium CLMM
  WSOL/EURC records available for lookup while CLMM quote support is pending.
- Expose offline ranking metadata and list APIs. The native metric is exact
  total supply multiplied by direct native-pool price in native atomic units,
  explicitly separate from circulating market cap. Partial coverage and
  unranked reasons stay visible; global USD market cap is rights-gated and
  disabled by default.
- Keep the populated local snapshot reviewable: token digest
  `5a7ed7f57a8cfaed87c46512586da8123e94fae80f1ce18ebb3861ccb95a9f70`, DEX
  digest `a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8`,
  and ranking digest
  `f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c`.
- Run the installed daily 03:17 UTC discovery/ranking PR, hourly minute-13
  read-only pool monitor with a persisted batch of 32, and Thursday 03:47 UTC
  release-preparation PR workflow. They create or update reviewable work and
  CI; live scheduled success is verified separately.
- Keep `ERPC_ENABLE_AUTOMATIC_DATA_MERGE=OFF` and
  `ERPC_ENABLE_AUTOMATIC_RELEASE=OFF` until the corresponding protections and
  human approvals are in place. Eligible additive data can merge after exact
  CI; a later data merge followed by a version-only PR can then produce paired
  root and Go tags before an explicit publisher dispatch.
- Keep release preparation tied to a reviewed source basis: SDK shipping-code
  changes require a source-basis refresh before automatic preparation can apply.
  See the [weekly maintenance runbook](registry/weekly-maintenance.md).

Initial `0.7.0` feature release work and source, schema, adapter, or API
changes require manual review. The ranking and discovery descriptions above
document source-checkout behavior and the dated local integration; they do not
assert Actions promotion, native runtime parity, or current live automation
success.

## Next phase — routes and transaction execution

- Add route selection and transaction build, signing, sending, and simulation
  only after separate contracts, test vectors, and money-path review.
- Add Solana concentrated-liquidity quote math only after its state, freshness,
  and execution boundaries are reviewed.
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
