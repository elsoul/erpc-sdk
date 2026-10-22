# Changelog

## Unreleased

## 0.9.0 — 2026-09-26

- Add a read-only TypeScript Base Mainnet facade at `erpc.base.rpc` with only `eth_chainId`, `eth_getBalance`, `eth_call`, and the resolved endpoint. API-key clients default to `https://base.erpc.global`; `baseEndpoint` replaces that authenticated eRPC-compatible host, while `baseRpc` is the exact direct override and receives only its explicitly scoped credentials. No Base raw request, batch, subscription, send, signing, wallet, approval, or broadcast API is added.
- Extend the shared offline token catalog and all five deterministic language projections with exactly three append-only Base deployments: native ETH (`eip155:8453`, 18 decimals, null address), Circle-native USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, 6 decimals), and Circle-issued EURC (`0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42`, 6 decimals). This does not enable a Base DEX, pool, swap, or bridge capability.
- Read Base native ETH with `eth_getBalance` and Base USDC/EURC with `eth_call` using deterministic `balanceOf(address)` calldata. Return raw hex/atomic-unit values and keep decimal presentation caller-owned.
- Include the already-merged, previously unreleased Mayan Swift v2 native-USDC directions between Ethereum and Solana and caller-driven local unsigned construction for the four exact EURC/USDC directions as candidate release content. These existing mainline additions are separate from the Base-balance demo; they do not add a Base bridge and still do not approve, sign, submit, broadcast, or claim settlement.
- Preserve configured-RPC and local logic for normal swap quotes, routes, simulation, and calldata construction with no hosted Jupiter or 0x dependency. The narrowed Base work changes none of those paths.

## 0.8.1 — 2026-09-24

- Fix TypeScript Fetch API invocation in receiver-sensitive runtimes such as Cloudflare Workers for default and provided fetch implementations across JSON-RPC, REST, Cloud, and the existing Mayan client.

## 0.8.0 — 2026-09-17

- Add caller-owned direct JSON-RPC endpoint overrides for Solana, Ethereum, and Avalanche C-Chain across TypeScript, Rust, Python, Go, and Ruby, with exact URL preservation, scoped HTTP headers, explicit WebSocket endpoints, and keyless operation for overridden chains.
- Add unsigned exact-input EVM swap preparation and read-only simulation for both directions of the reviewed Ethereum Uniswap V2 WETH/USDC and Avalanche C-Chain LFJ Joe V1 WAVAX/USDC routes. Normal SDK swaps use configured RPC endpoints and local quote, route-validation, and calldata logic; the SDK does not approve, sign, send, wrap native assets, select multi-hop routes, or call hosted Jupiter or 0x services.
- Add an optional standalone Mayan Swift v2 adapter for native issued EURC between Ethereum mainnet (`0x1abaea1f7c830bd89acc67ec4af516284b1bc33c`) and Solana mainnet (`HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`). It exposes provider-backed quotes, unsigned builds, and indexed status for those two exact directions while disclosing source-USDC conversion and the external Mayan solver and relayer, Wormhole, Explorer, and Solana-origin Jupiter v6 dependencies.
- Keep bridge verification bounded to structural checks: provider signatures, transaction semantics, indexed status, and settlement are not locally verified, and the adapter performs no wallet approval, signing, submission, broadcast, polling, or live-funds action.
- Update release-availability documentation and make swap examples compute future five-minute deadlines instead of copying dated fixture deadlines.

## 0.7.0 — 2026-09-16

- Initial reviewed 2026-09-16 local snapshot: Add an offline token catalog to all five SDKs, covering 44 assets and 65 deployments across Ethereum, Solana, and Avalanche C-Chain, including five address-only unclassified tokens.
- Add shared asset and deployment lookups, chain and currency filters, address and symbol searches, alias constants, and lifecycle metadata backed by deterministic generated data.
- Keep RPC-only, local exact-input quotes for the two reviewed seed EVM pairs: Ethereum Uniswap V2 WETH/USDC and Avalanche C-Chain LFJ Joe V1 WAVAX/USDC; newly discovered pools do not enable quote support.
- Initial reviewed 2026-09-16 local snapshot: Add a shared offline ranking snapshot with 11 rows and partial onchain-total-supply-value-native coverage, using total supply times direct native pool price rather than circulating market cap; add bounded RPC-only discovery with eight-token/eight-pool caps and fresh revalidation.
- Run daily maintenance PRs, hourly 32-pool rotation, and weekly guarded release preparation with opt-in exact-CI/protected-main gates; preserve Rust num-bigint 0.5.1 and rustls 0.23.45 as approved changes.

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
