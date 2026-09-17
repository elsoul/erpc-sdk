# Token, DEX, and pool roadmap

Status: the published
[`v0.7.0` release](https://github.com/elsoul/erpc-sdk/releases/tag/v0.7.0)
contains the bounded offline token, DEX/pool, ranking, and reviewed EVM
RPC-only quote implementation with deterministic five-SDK outputs. The
[token snapshot](./token-catalog.json), [DEX/pool snapshot](./dex-catalog.json),
and [ranking snapshot](./token-rankings.json) are the source of record; dated
evidence preserves historical observations without a current coverage claim.
Direct RPC overrides merged by [PR25](https://github.com/elsoul/erpc-sdk/pull/25)
(`e19a5532705818a2afdf07f96c7cae2044e6f202`), and this documentation baseline
merged by [PR26](https://github.com/elsoul/erpc-sdk/pull/26)
(`691df2852cd8b82e5a9fce4ea07ea7b2cc4791ae`), are source-checkout features after
that release. EVM swap preparation/simulation and the optional Mayan EURC bridge
below are also source-checkout features. Native captures, CI, independent
review, release readiness, and legal readiness are tracked by their respective
source-controlled gates.

The maintenance implementation is installed as reviewable tooling:
[`weekly-maintenance.md`](./weekly-maintenance.md),
[`release-plan.json`](./release-plan.json), `release-prep.mjs`,
`maintenance-pr.mjs`, and `ci-catalog-baseline.mjs`. The installed workflows
schedule daily discovery/ranking maintenance at 03:17 UTC, an hourly minute-13
read-only pool monitor with persisted rotation, and release preparation on
Thursday at 03:47 UTC. Discovery and monitoring read configured RPC endpoints;
release inspection and offline catalog lookups remain local. The bot creates
or updates reviewable work and CI. Package publication and release approval
remain human-invoked actions.

The approved `0.7.0` plan was created from reviewed source basis `1eed9b2`.
Its durable package-change guard requires a reviewed source-basis refresh
whenever SDK shipping code changes before automatic preparation can apply. This
controls preparation and makes no publication claim.

## Current acceptance gates

| Gate | State | Owner / evidence |
| --- | --- | --- |
| Canonical schema, deterministic digest, and history guard | Implemented; central tests pass | Registry owner; `token-catalog.schema.json`, tests, and `--previous` |
| Five generated package outputs | Source-generated package data is defined by the canonical renderers; per-package byte checks remain owner and CI checks | TypeScript, Rust, Python, Go, Ruby owners |
| DEX/pool generated outputs and lookup/quote slice | Implemented across all five SDKs; CI checks the shared native quote cases | [`DEX.md`](./DEX.md), generated outputs, and `dex-catalog.test.mjs` |
| Three-chain discovery and bounded admission | Local review PASS (partial); current records and deferred candidates remain in the canonical snapshot with bounded caps and receipt revalidation | [`discovery.mjs`](./discovery.mjs), [`discovery-config.json`](./discovery-config.json), [`data-promotion.mjs`](./data-promotion.mjs), [`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json) |
| Offline ranking contract | Local review PASS (partial); exact native-unit metric, coverage, and unranked reasons remain in the canonical snapshot | [`token-rankings.mjs`](./token-rankings.mjs), [`token-rankings.json`](./token-rankings.json), [`ranking-config.json`](./ranking-config.json), [`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json) |
| Cross-language catalog gate | Validation is defined by the shared parity verifiers and dated captures; CI and independent review records provide gate status | `verify-token-parity.mjs`, `verify-dex-parity.mjs`, `verify-ranking-parity.mjs`; dated captures in evidence |
| Reviewed EVM swap preparation and simulation | Source-only; shared fixtures and the parity verifier define behavior across SDKs | [`DEX.md`](./DEX.md), swap execution registry, and native parity evidence |
| Optional Mayan Swift v2 native EURC bridge | Source-only; shared fixtures and the parity verifier define behavior across SDKs | [`BRIDGE.md`](./BRIDGE.md), `verify-bridge-parity.mjs`, bridge registry, and provider evidence |
| Independent SDK code/package gate | Review findings and any blockers are tracked by the independent gate; this roadmap makes no final bridge claim | Steiner |
| Cross-domain catalog review gate | Bounded catalog scope is recorded separately from final bridge review | Cyan; final review 2026-09-15 |
| EU OSS planning packet | Applicability, role, classification, support, compliance, and data rights undetermined | [`evidence/weekly-maintenance-eu-oss-2026-09-15.json`](./evidence/weekly-maintenance-eu-oss-2026-09-15.json); human legal owner still to be assigned |

## Near-term maintenance

The canonical [token](./token-catalog.json), [DEX/pool](./dex-catalog.json),
and [ranking](./token-rankings.json) snapshots carry their own records,
digests, dates, and coverage metadata. The local review is partial and does
not substitute for native parity or remote CI.

- Keep asset IDs, deployment IDs, normalized bindings, and aliases immutable.
- Keep newly discovered token candidates unclassified with address-only names
  and symbols and null `stableCurrency`, `underlyingAssetId`, and
  `economicReferenceAssetId` until a source review assigns their meaning.
- Keep discovery bounded at 8 token and 8 pool admissions per run. Direct
  reviewed native-pair floors are 10 ETH, 100 AVAX, and 100 SOL in native
  atomic units. Requeue deferred candidates only from fresh verified receipts;
  an outage never retires an existing record.
- Treat source and RPC receipts as dated evidence. Refreshing a receipt or per-record source date must not alter runtime bytes or the digest; changing a runtime fact or global manual date must.
- Add a new deployment ID for an address migration and preserve the previous record and aliases.
- Refresh native package snapshots only after each package owner runs its own compiled tests, then rerun the central verifier and retain artifact and snapshot hashes.
- Resolve the documented source gaps with a new bounded evidence packet before adding records.

## Operational status

### Weekly workflow and publication

The daily 03:17 UTC discovery/ranking schedule, hourly minute-13 pool monitor,
Thursday 03:47 UTC release-preparation schedule, reviewable PR writers, and CI
dispatch are installed. The pool monitor observes a persisted rotating batch
of 32. These workflows prepare candidates for review; package publication,
release approval, merge, and tag creation remain human-invoked actions.

Automatic data merge and automatic release are opt-in policy variables,
currently `ERPC_ENABLE_AUTOMATIC_DATA_MERGE=OFF` and
`ERPC_ENABLE_AUTOMATIC_RELEASE=OFF`. When the relevant policy and branch
protection are enabled, eligible additive data can merge after exact CI. A
published baseline-to-data merge followed by a version-only PR can then
produce the paired root and Go tags before an explicit publisher dispatch.
No unprotected environment or setting is an approval.

Discovery reads configured Ethereum and Avalanche factory pairs and Solana
program partitions from RPC, verifies address facts, and keeps state bounded
and resumable. The hourly pool monitor is read-only and rotates its persisted
batch; neither path grants new swap execution or bridge support. DEX catalog
checks and the shared native quote cases run in CI from the checked-out source
and fixtures.

### Current DEX and RPC-only quote slice

Only the reviewed seed EVM tuples, Ethereum Uniswap V2 WETH/USDC and
Avalanche LFJ legacy WAVAX/USDC, support configured-RPC exact-input quotes
with local calculation. Solana Orca Whirlpools and Raydium CLMM records use
classic WSOL/EURC for deterministic lookup and pair discovery only.
Native-to-wrapped definitions describe relationships and do not wrap assets
automatically. New catalog records never automatically become quote-enabled.

### Source-only EVM swap execution

The post-release source checkout adds `prepareExactInputSwap` and
`simulateExactInputSwap` for both directions of the reviewed Ethereum Uniswap
V2 WETH/USDC and Avalanche LFJ Joe V1 WAVAX/USDC tuples. Quotes use a fresh
configured RPC snapshot; calldata is built locally; results contain an unsigned
neutral EVM envelope and an explicit allowance requirement. The SDK does not
approve, sign, send, wrap native assets, execute Solana CLMM routes, or select a
multi-hop router. Separate client instances can choose different dedicated RPC
endpoints for read quotes and preparation or simulation.

The shared swap fixtures and parity verifier define the cross-language behavior
contract. Root's read-only preparation evidence is recorded in
[`evidence/swap-execution-capabilities-2026-09-16.json`](./evidence/swap-execution-capabilities-2026-09-16.json);
CI and independent review records provide gate status.

### Source-only Mayan Swift v2 bridge

The standalone opt-in `MayanSwiftV2BridgeClient` covers native issued EURC
between Ethereum and Solana through `quoteExactInput`, `buildUnsigned`, and
`getStatus`. The exact routes, native versus provider-wire standards, source
USDC conversion, Jupiter v6 dependency for Solana-origin orders, and external
Mayan services are recorded in [`BRIDGE.md`](./BRIDGE.md). Endpoints are
customizable; `builderApiKey` is a separate build-only provider credential.
Quotes work without it, while builds require it unless a compatible no-auth
builder is explicitly enabled. The ERPC key is never reused.

The adapter returns unsigned transactions with structural checks only and does
not locally verify provider signatures, transaction semantics, or settlement.
The shared bridge fixtures and parity verifier define the cross-language
behavior contract. Root's public read-only EURC quote observations are recorded
in
[`evidence/mayan-swift-v2-2026-09-16.json`](./evidence/mayan-swift-v2-2026-09-16.json).
CI and independent review records provide gate status; this source-only slice
does not claim live settlement or funds movement.

### Solana transaction version boundary

Solana v1 and 4096-byte transaction support were activated on 2026-09-15; v0
and legacy transactions remain unchanged. Existing generic RPC pass-through
supports caller-supplied `maxSupportedTransactionVersion: 1` and serialized v1
payloads. The Mayan bridge adapter has a separate provider contract that
accepts only v0 framing at or below 1232 bytes and rejects v1 until a
provider-specific validation contract is reviewed. See the [official larger
transaction sizes note](https://solana.com/upgrades/larger-transaction-sizes).

## Explicitly pending future work

### Rankings and coverage

The source checkout exposes offline ranking metadata and list APIs. The native
metric is total supply multiplied by the direct native pool price, represented
as exact rational native atomic units; it is explicitly not circulating market
capitalization. Coverage is explicit, including partial coverage and unranked
reasons. The optional global USD market-cap metric is rights-gated and disabled
by default. Ranking lookups read bundled data only and do not call a vendor API,
RPC endpoint, or current clock. The populated local ranking integration and
fresh raw evidence are recorded in
[`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json).
Use the dated captures and parity verifier for the applicable CI and runtime
review status.

### Broader routes and transaction execution

Multi-hop route selection and further transaction features remain pending
separate contracts, test vectors, and money-path review. Signing and sending
remain caller-owned operations. Solana CLMM quote math and hosted Jupiter or
0x dependencies are not part of normal SDK swap helpers.

### Separate bridging research

Bridges beyond the reviewed Mayan EURC directions remain a separate research
track. Any future work must identify exact source and destination chains,
native versus wrapped addresses, proof or attestation rules, and relayer
dependencies. No bridge activation schedule is implied by token
`economicReferenceAssetId` relationships.

### EU OSS and release readiness

License, dependency, SBOM, security, and release-readiness review must use the EU OSS evidence runbook and state applicability, primary source, as-of date, evidence, gaps, owner, due date, and next review. The packet is planning evidence only and grants no legal endorsement, CE certification, public vulnerability disclosure, regulatory filing, or release authority.

Initial `0.7.0` feature release work and source, schema, adapter, or API
changes require manual review. Snapshot refreshes must preserve the prior
public methods and constants while adding only reviewed additive data.

## History

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-09-15 | PR #10 merged: initial bounded token catalog and five-language outputs | [PR #10](https://github.com/elsoul/erpc-sdk/pull/10), `token-catalog-2026-09-15.json` |
| 2026-09-15 | PR #11 merged: weekly maintenance and release-preparation implementation | [PR #11](https://github.com/elsoul/erpc-sdk/pull/11), `weekly-maintenance.md`, `release-plan.json` |
| 2026-09-15 | PR #12 merged: initial observer findings and maintenance evidence | [PR #12](https://github.com/elsoul/erpc-sdk/pull/12), `maintenance-review.json` |
| 2026-09-15 | Initial bounded catalog seed, 39 assets, 60 deployments, and 60 aliases; deterministic five-language emitters and history guard prepared | `token-catalog-2026-09-15.json` |
| 2026-09-15 | Native parity passed across all five compiled packages; 338 public-API query rows and 60 compiled alias-constant checks per language; PayPal USD display-name correction recorded | `token-catalog-2026-09-15.json`, `PROVENANCE.md` |
| 2026-09-15 | Steiner and Cyan catalog reviews passed for the bounded offline registry scope | `token-catalog-2026-09-15.json` |
| 2026-09-15 | Weekly maintenance release preparation, released-tag history checks, PR-base catalog binding, release command regression coverage, and EU OSS planning evidence installed and recorded | `weekly-maintenance.md`, `release-plan.json`, `evidence/weekly-maintenance-eu-oss-2026-09-15.json` |
