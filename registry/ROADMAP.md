# Token catalog roadmap

Status: the bounded offline token catalog, deterministic code generation, all five package outputs, native parity capture, and the Steiner and Cyan catalog reviews are implemented and recorded as passed on 2026-09-15. The catalog is on `main` and planned for the unreleased `0.7.0` package. The current published package baseline, latest GitHub release, and package manifests remain `0.6.0`. This status covers the catalog gate and does not establish overall release or legal readiness.

The weekly maintenance implementation is installed as reviewable tooling:
[`weekly-maintenance.md`](./weekly-maintenance.md),
[`release-plan.json`](./release-plan.json), `release-prep.mjs`,
`maintenance-pr.mjs`, and `ci-catalog-baseline.mjs`. The installed workflows
schedule an observation PR for Tuesday at 03:17 UTC and a release-preparation
PR for Thursday at 03:47 UTC. Their observer reads configured RPC endpoints
and reviewed HTTP sources online; release inspection and the catalog runtime
remain offline. The bot creates or updates reviewable PRs and CI. Package
publication and release approval remain human-invoked actions.

## Current acceptance gates

| Gate | State | Owner / evidence |
| --- | --- | --- |
| Canonical schema, deterministic digest, and history guard | Implemented; central tests pass | Registry owner; `token-catalog.schema.json`, tests, and `--previous` |
| Five generated package outputs | Implemented; all five byte checks and package validations passed | TypeScript, Rust, Python, Go, Ruby owners |
| Cross-language catalog gate | PASS: native snapshots match all records, metadata, behavior probes, and alias constants | `verify-token-parity.mjs`; final digest and receipts in evidence |
| Independent SDK code/package gate | PASS | Steiner |
| Cross-domain catalog review gate | PASS (bounded catalog scope) | Cyan; final review 2026-09-15 |
| EU OSS planning packet | Applicability, role, classification, support, compliance, and data rights undetermined | [`evidence/weekly-maintenance-eu-oss-2026-09-15.json`](./evidence/weekly-maintenance-eu-oss-2026-09-15.json); human legal owner still to be assigned |

## Near-term maintenance

- Keep asset IDs, deployment IDs, normalized bindings, and aliases immutable.
- Treat source and RPC receipts as dated evidence. Refreshing a receipt or per-record source date must not alter runtime bytes or the digest; changing a runtime fact or global manual date must.
- Add a new deployment ID for an address migration and preserve the previous record and aliases.
- Refresh native package snapshots only after each package owner runs its own compiled tests, then rerun the central verifier and retain artifact and snapshot hashes.
- Resolve the documented source gaps with a new bounded evidence packet before adding records.

## Operational status

### Weekly workflow and publication

The Tuesday observation and Thursday release-preparation schedules, changelog
candidate updates, reviewable PR writers, and CI dispatch are installed. They
prepare evidence and candidates for review; package publication, release
approval, merge, and tag creation remain human-invoked actions.

## Explicitly pending future work

### Rankings and coverage

Ranking, “top” labels, market data, complete stablecoin coverage, and freshness claims remain pending a source-backed methodology and review. The current catalog is a bounded factual seed.

### DEX, pools, and RPC-local swap flow

DEX and pool records plus quotes, routes, and transaction builds remain pending
their separate contract, test vectors, and money-path gate. They must use
configured RPC endpoints and local logic. Hosted Jupiter or 0x dependencies are
not part of this registry.

### Separate bridging research

Bridging remains a separate research track. Any future work must identify exact source and destination chains, native versus wrapped addresses, proof or attestation rules, and relayer dependencies. No bridge stub or activation schedule is implied by the current `economicReferenceAssetId` relationships.

### EU OSS and release readiness

License, dependency, SBOM, security, and release-readiness review must use the EU OSS evidence runbook and state applicability, primary source, as-of date, evidence, gaps, owner, due date, and next review. The packet is planning evidence only and grants no legal endorsement, CE certification, public vulnerability disclosure, regulatory filing, or release authority.

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
