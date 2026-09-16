# Token, DEX, and pool roadmap

Status: the source checkout contains the bounded offline token, DEX/pool, and
ranking implementation with deterministic generation and five-SDK outputs. A
2026-09-16 local integration populated the canonical source snapshot with
partial three-chain coverage. These features remain planned for the unreleased
`0.7.0` package. The current published package baseline, latest GitHub release,
and package manifests remain `0.6.0`; remote CI, native runtime parity, live
automation, release readiness, and legal readiness remain separate gates.

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
| Five generated package outputs | Implemented; all five byte checks and package validations passed | TypeScript, Rust, Python, Go, Ruby owners |
| DEX/pool generated outputs and lookup/quote slice | Implemented across all five SDKs; CI checks the shared native quote cases | [`DEX.md`](./DEX.md), generated outputs, and `dex-catalog.test.mjs` |
| Three-chain discovery and bounded admission | Local review PASS (partial): 5 tokens and 8 pools admitted with 8-token/8-pool caps, resumable cursors, and deferred revalidation | [`discovery.mjs`](./discovery.mjs), [`discovery-config.json`](./discovery-config.json), [`data-promotion.mjs`](./data-promotion.mjs), [`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json) |
| Offline ranking contract | Local review PASS (partial): 11 records and 54 explicit unranked rows; native total-supply × direct native-pool price uses exact rationals | [`token-rankings.mjs`](./token-rankings.mjs), [`token-rankings.json`](./token-rankings.json), [`ranking-config.json`](./ranking-config.json), [`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json) |
| Cross-language catalog gate | PASS for the populated 2026-09-16 token, DEX, and ranking snapshots; remote CI remains pending | `verify-token-parity.mjs`, `verify-dex-parity.mjs`, `verify-ranking-parity.mjs`; dated captures in evidence |
| Independent SDK code/package gate | PASS | Steiner |
| Cross-domain catalog review gate | PASS (bounded catalog scope) | Cyan; final review 2026-09-15 |
| EU OSS planning packet | Applicability, role, classification, support, compliance, and data rights undetermined | [`evidence/weekly-maintenance-eu-oss-2026-09-15.json`](./evidence/weekly-maintenance-eu-oss-2026-09-15.json); human legal owner still to be assigned |

## Near-term maintenance

The current source snapshot contains 44 assets, 65 token deployments, 65
aliases, 12 pools, and 16 DEX aliases. Candidate digests are token
`5a7ed7f57a8cfaed87c46512586da8123e94fae80f1ce18ebb3861ccb95a9f70`, DEX
`a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8`, and
ranking `f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c`.
The local review is partial and does not substitute for native parity or remote
CI.

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
[`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json);
remote CI and native runtime parity remain pending review.

### Routes and transaction execution

Route selection, transaction building, signing, simulation, and sending remain
pending separate contracts, test vectors, and money-path review. Solana CLMM
quote math and bridging also remain future work. Hosted Jupiter and 0x
dependencies are not part of this registry.

### Separate bridging research

Bridging remains a separate research track. Any future work must identify exact source and destination chains, native versus wrapped addresses, proof or attestation rules, and relayer dependencies. No bridge stub or activation schedule is implied by the current `economicReferenceAssetId` relationships.

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
