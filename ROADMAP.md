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

## 0.7 — Token, DEX, pool, and ranking catalogs (PUBLISHED)

The published [`v0.7.0` release](https://github.com/elsoul/erpc-sdk/releases/tag/v0.7.0)
contains the bounded token, DEX, pool, ranking, and reviewed EVM RPC-only quote
features. The canonical [token snapshot](registry/token-catalog.json),
[DEX/pool snapshot](registry/dex-catalog.json), and
[ranking snapshot](registry/token-rankings.json) are the source of record;
dated evidence preserves the historical observations without making a current
coverage claim.

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

Source, schema, adapter, and API changes after the published release remain
manually reviewed. The schedules prepare reviewable work; they do not establish
that a live scheduled run, publication, or release promotion has succeeded.

## Source-only capabilities after 0.7.0

[PR25](https://github.com/elsoul/erpc-sdk/pull/25) merged direct RPC endpoint
overrides (`e19a5532705818a2afdf07f96c7cae2044e6f202`), and
[PR26](https://github.com/elsoul/erpc-sdk/pull/26) merged the documentation
baseline (`691df2852cd8b82e5a9fce4ea07ea7b2cc4791ae`) after the published
release. Those additions remain source-checkout features and do not change the
`0.7.0` package artifacts. The current source checkout is covered by the
common harness and the relevant local implementation checks; CI and independent
final-gate findings remain tracked separately.

### Reviewed EVM swap execution

The source checkout supports both directions of the reviewed Ethereum Uniswap
V2 WETH/USDC and Avalanche LFJ Joe V1 WAVAX/USDC tuples through
`prepareExactInputSwap` and `simulateExactInputSwap`. Quotes use a fresh
configured RPC snapshot; calldata is built locally; results carry an unsigned
neutral EVM envelope and an explicit allowance requirement. The SDK does not
approve, sign, send, wrap native assets, execute Solana CLMM routes, or select a
multi-hop router. Separate client instances can select different dedicated RPC
endpoints for read quotes and preparation or simulation.

The shared swap fixtures and parity verifier define the cross-language behavior
contract. Root's read-only swap preparation observations are recorded in
[`evidence/swap-execution-capabilities-2026-09-16.json`](registry/evidence/swap-execution-capabilities-2026-09-16.json);
CI and independent review records provide gate status.

### Optional Mayan Swift v2 bridge

The source checkout also contains the standalone opt-in
`createMayanSwiftV2BridgeClient` for native issued EURC between Ethereum and
Solana. It exposes `quoteExactInput`, `buildUnsigned`, and `getStatus` for the
two exact catalog directions. `builderEndpoint` and `explorerEndpoint` are
independently configurable, and `builderApiKey` is a separate Mayan build-only
credential. Hosted quotes work without that key; builds require it unless the
caller explicitly opts into a compatible no-auth builder. The ERPC key is never
used as the provider key.

Mayan, solvers, relayers, Wormhole, Explorer, and the Solana-origin Jupiter v6
source swap remain visible external dependencies. The adapter reports
structural checks and does not locally verify provider signatures, transaction
semantics, or settlement. Returned transactions remain unsigned and wallet
policy stays with the caller. This source-only bridge slice is documented in
[`registry/BRIDGE.md`](registry/BRIDGE.md) and its evidence packet.

The shared bridge fixtures and parity verifier define the cross-language
behavior contract. Root's public read-only EURC quote observations are
recorded in
[`evidence/mayan-swift-v2-2026-09-16.json`](registry/evidence/mayan-swift-v2-2026-09-16.json).
CI and independent review records provide gate status; this source-only feature
does not claim settlement or live-funds evidence.

### Solana transaction version boundary

Solana v1 and 4096-byte transaction support were activated on 2026-09-15; v0
and legacy transactions remain unchanged. Existing generic RPC pass-through
supports caller-supplied `maxSupportedTransactionVersion: 1` and serialized v1
payloads. The Mayan adapter has a separate provider contract that accepts only
v0 framing at or below 1232 bytes and rejects v1 until a provider-specific
validation contract is reviewed. See the [official larger transaction sizes
note](https://solana.com/upgrades/larger-transaction-sizes).

## Future work — broader routes and execution

- Add multi-hop routing and further transaction features only after separate
  contracts, test vectors, and money-path review; signing and sending remain
  caller-owned operations.
- Add Solana concentrated-liquidity quote math only after its state, freshness,
  and execution boundaries are reviewed.
- Keep hosted Jupiter and 0x dependencies out of normal SDK swap helpers.
- Treat bridges beyond the reviewed Mayan EURC directions as separate research
  requiring exact source and destination chains, native versus wrapped
  addresses, proof or attestation rules, and relayer dependencies.

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
