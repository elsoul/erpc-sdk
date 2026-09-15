# Token catalog roadmap

Status: the bounded offline token catalog, deterministic code generation, all five package outputs, native parity capture, and the Steiner and Cyan catalog reviews are implemented and recorded as passed on 2026-09-15. This status covers the catalog gate and does not establish overall release or legal readiness.

The weekly maintenance implementation is staged as reviewable tooling:
[`weekly-maintenance.md`](./weekly-maintenance.md),
[`release-plan.json`](./release-plan.json), `release-prep.mjs`,
`maintenance-pr.mjs`, and `ci-catalog-baseline.mjs`. It remains offline and
human-approved; it does not publish packages or create release tags.

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

## Explicitly pending future work

### Weekly releases

Weekly automatic publication, changelog automation, and release scheduling
remain pending a separate human-approved release design and future release
review. The current preparation tools create a candidate and review evidence;
current scripts remain manually invoked.

### Rankings and coverage

Ranking, “top” labels, market data, complete stablecoin coverage, and freshness claims remain pending a source-backed methodology and review. The current catalog is a bounded factual seed.

### RPC-local swap flow

Quotes, routes, and transaction builds must use configured RPC endpoints and local logic. Hosted Jupiter or 0x dependencies are not part of this registry. A production swap implementation remains pending its separate contract, test vectors, and money-path gate.

### Separate bridging research

Bridging remains a separate research track. Any future work must identify exact source and destination chains, native versus wrapped addresses, proof or attestation rules, and relayer dependencies. No bridge stub or activation schedule is implied by the current `economicReferenceAssetId` relationships.

### EU OSS and release readiness

License, dependency, SBOM, security, and release-readiness review must use the EU OSS evidence runbook and state applicability, primary source, as-of date, evidence, gaps, owner, due date, and next review. The packet is planning evidence only and grants no legal endorsement, CE certification, public vulnerability disclosure, regulatory filing, or release authority.

## History

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-09-15 | Initial bounded catalog seed, 39 assets, 60 deployments, and 60 aliases; deterministic five-language emitters and history guard prepared | `token-catalog-2026-09-15.json` |
| 2026-09-15 | Native parity passed across all five compiled packages; 338 public-API query rows and 60 compiled alias-constant checks per language; PayPal USD display-name correction recorded | `token-catalog-2026-09-15.json`, `PROVENANCE.md` |
| 2026-09-15 | Steiner and Cyan catalog reviews passed for the bounded offline registry scope | `token-catalog-2026-09-15.json` |
| 2026-09-15 | Weekly maintenance release preparation, released-tag history checks, PR-base catalog binding, release command regression coverage, and EU OSS planning evidence staged for review | `weekly-maintenance.md`, `release-plan.json`, `evidence/weekly-maintenance-eu-oss-2026-09-15.json` |
