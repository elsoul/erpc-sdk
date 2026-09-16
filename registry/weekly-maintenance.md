# Catalog maintenance runbook

This runbook describes the installed catalog maintenance workflows for the SDK
repository. They observe the bounded source-checkout data, prepare reviewable
pull requests, and run CI. They do not approve, merge, tag, publish, or
activate a release; package publication remains human-invoked.

## Cadence and ownership

The workflows are installed on `main` with these UTC schedules:

| Workflow | Schedule | Reviewable PR | Network behavior |
| --- | --- | --- | --- |
| [`registry-maintenance.yml`](../.github/workflows/registry-maintenance.yml) | Daily 03:17 UTC | Discovery/ranking findings on `codex/registry-maintenance` | Reads configured RPC endpoints and reviewed HTTP sources online; catalog/runtime checks are local |
| [`pool-monitor.yml`](../.github/workflows/pool-monitor.yml) | Hourly at minute 13 | Read-only pool observation artifact | Reads a persisted rotating batch of 32 configured pools; never mutates canonical data |
| [`release-preparation.yml`](../.github/workflows/release-preparation.yml) | Thursday 03:47 UTC | Release preparation on `codex/release-preparation` | Reads configured RPC endpoints and reviewed HTTP sources online; release inspection and catalog reads are local |

The daily collector performs bounded three-chain factory/program discovery and
ranking collection for review. The hourly pool monitor is read-only and uses a
persisted rotating batch of 32. Neither workflow silently writes canonical
rankings or enables a new swap or bridge path. DEX catalog checks and shared
native quote cases run in CI against the checked-out source and fixtures.

These workflows also support an explicit manual dispatch. A run stays quiet
while the observed state is unchanged; otherwise it reports a changed catalog,
a prepared candidate, a failed check, or a required human action. The bot
creates or updates reviewable PRs and dispatches CI for review. It does not
approve, merge, tag, or publish.

Automatic effects are opt-in policy paths and are currently off:
`ERPC_ENABLE_AUTOMATIC_DATA_MERGE=OFF` and
`ERPC_ENABLE_AUTOMATIC_RELEASE=OFF`. When the corresponding policy variables
and branch protections are enabled, eligible additive data can merge only
after exact CI. A later published baseline-to-data merge followed by a
version-only PR can produce the paired root and Go tags, after which an
explicit publisher dispatch is still required. An unprotected publishing
environment is never an approval, and this runbook does not claim that a live
scheduled run has succeeded. This documentation does not perform settings,
tag, merge, or publication actions.

The first successful workflow and its idempotent rerun were manual dispatches:
[`run 35006595913`](https://github.com/elsoul/erpc-sdk/actions/runs/35006595913)
and
[`run 35007810328`](https://github.com/elsoul/erpc-sdk/actions/runs/35007810328).
The first run used source SHA
`c3d0de8d1f4d77a96eb6a169290ed096ad2a2645`; the idempotent rerun used latest
`main` SHA
`75f01b3ed2e3d9749d3f4fd7f4faf60e89562da1`. These are dated manual-dispatch
evidence; they do not show that a scheduled run occurred. The first run
reported 55 matching observations, two Avalanche symbol differences, three
RPC errors, and 35 of 41 sources usable. Its result was partial and had no
eligible source-baseline bootstrap.

The initial reviewed source-checkout snapshot on 2026-09-16 used frozen commit
`5ef97abd66f40a2db77a4f85595cf64d1032f7c8` and local execution provenance. It
admitted 5 tokens and 8 pools, produced 11 ranking records, and retained 54
explicit unranked rows. The candidate digests are token
`5a7ed7f57a8cfaed87c46512586da8123e94fae80f1ce18ebb3861ccb95a9f70`, DEX
`a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8`, and
ranking `f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c`.
See the [local integration review](./evidence/discovery-ranking-review-2026-09-16.json)
and its [raw evidence](./evidence/discovery-receipts-2026-09-16.json). This
capture has no GitHub run provenance and is not a promotion approval.

Root and Rydia own the catalog observation. Bahamut owns the workflow details.
Sephiroth owns release preparation. A human legal owner is still to be
assigned; engineering review is due before acceptance of a release candidate.
The next manual review is due 2026-10-15 or earlier after a material event.

On 2026-09-15, a read-only settings check returned `protection_rules[]` for
each of the four release environments (`npm`, `crates-io`, `pypi`, and
`rubygems`) and `rulesets[]` for `main`; no settings were changed. These
responses are evidence of the observed API state only and do not assert active
reviewer or ruleset protection.

## Source-checkout behavior

[`discovery.mjs`](./discovery.mjs) reads verified address facts from the three
configured RPC networks: Ethereum and Avalanche factory pair indexes and
Solana program partitions. New token proposals remain `unclassified`, use
address-only names and symbols, and keep `stableCurrency`,
`underlyingAssetId`, and `economicReferenceAssetId` as `null` until reviewed.
Admission is capped at 8 tokens and 8 pools per run. Direct reviewed native
pairs use WETH, WAVAX, or classic WSOL, with native liquidity floors of 10 ETH,
100 AVAX, and 100 SOL in native atomic units.

Discovery state is bounded and resumable. A cap- or dependency-deferred pool
returns to the pending cursor only when a fresh verified proposal and receipt
identify the same pair index or pool pubkey; the next collector revalidates it
through RPC. Public IDs and aliases are append-only, and an RPC outage does
not retire an existing record. See [`data-promotion.mjs`](./data-promotion.mjs)
and [`discovery-config.json`](./discovery-config.json) for the source
configuration and replay boundary.

Ranking uses total supply multiplied by the direct native pool price, encoded as
exact rational native atomic units. It is explicitly not circulating market
capitalization. Partial coverage and unranked reasons remain in ranking
metadata. The optional global USD market-cap metric is rights-gated and
disabled by default; no vendor market-cap redistribution is implied. Offline
catalog and ranking list APIs read bundled data only and do not call an
external vendor API, RPC endpoint, or current clock. The current bundled
snapshot is partial; its observed ranking metadata and digest are recorded in
[`token-rankings.json`](./token-rankings.json) and the local integration review.

## Stage 1: inspect the source and baseline

Use the expected source commit explicitly. Release inspection is offline and
read-only unless `--report` is supplied. The observer stage separately reads
configured RPC endpoints and reviewed HTTP sources online.

```sh
node registry/release-prep.mjs inspect \
  --expected-head "$(git rev-parse HEAD)" --format=json
```

The command validates stable semantic versions, the unique source-less
`erpc-sdk` package entry in `Cargo.lock`, the immutable baseline tag pair, and
the approved plan provenance. Release changes are compared from the highest
actual paired stable tag that is an ancestor of the frozen head. Baseline
`v0.6.0` and
`packages/go/v0.6.0` must peel to
`d77169fbf9e927d51113af7a2ee51a5c9b10f3fc` and be ancestors of the expected
head. A higher tag must have both namespaces, the same peeled commit, and an
ancestor relationship. A lower historical root-only tag produces a warning;
it does not become a release baseline. After a valid `0.7.0` pair exists, a
later catalog runtime change is prepared as `0.7.1` through the same rule.
The comparison uses the catalog digest and generated runtime bytes. A source
evidence or per-record `asOfDate` refresh with an unchanged digest and
unchanged runtime output does not create a release candidate.

The approved plan's package-change guard intentionally rejects SDK shipping code
outside its reviewed source basis. Whenever SDK shipping code changes, refresh
that reviewed source basis before automatic preparation can apply. Documentation
and other non-shipping operations may advance the source head while the plan
remains applicable.

The principal status values are:

| Status | Meaning |
| --- | --- |
| `NO_RELEASE_CHANGE` | Packages remain at the released baseline and no catalog-only patch is present. |
| `PATCH_READY` | The released baseline contains the approved catalog/runtime change or only catalog runtime files changed; an approved semver candidate can be prepared. |
| `MANUAL_VERSION_REQUIRED` | New package code or manifest changes since the latest paired release are outside the approved plan. |
| `PREPARED_UNPUBLISHED` | All package versions and release notes are prepared, with no paired target tags. |
| `PREPARED` | The candidate already has a matching paired tag history. |
| `BLOCKED_TAG_HISTORY` | A higher or baseline tag is missing, mismatched, or off the expected history. |
| `VERSION_DRIFT` | The six managed version values do not agree. |
| `STALE_HEAD` | Checkout HEAD differs from `--expected-head`. |
| `CHANGELOG_REQUIRED` | A versioned candidate has no matching release section. |

The JSON report also contains `prepareAllowed`. It is `true` only for
`PATCH_READY`; it is `false` for date-only `NO_RELEASE_CHANGE`, already
prepared candidates, and blocked or manual-required states.

## Stage 2: prepare a candidate

Preparation is a compare-and-swap operation against a clean expected-head
checkout. It performs no dependency installation or resolver call.

```sh
node registry/release-prep.mjs prepare \
  --expected-head "$EXPECTED_HEAD" \
  --version 0.7.0 \
  --release-date 2026-09-15 \
  --changelog-file CHANGELOG.md --format=json
```

When the source commit and package-change provenance match
[`release-plan.json`](./release-plan.json), `--version` may be omitted and the
approved `0.7.0` plan supplies it. Later unexpected package code changes
invalidate that default until the reviewed source basis is refreshed. This
preparation rule does not publish a package or create a release tag.

The `--changelog-file` option is accepted only for `CHANGELOG.md`; other paths
are refused. The preparation allowlist is exactly the five package version sources,
`Cargo.lock`'s unique source-less `erpc-sdk` version, and `CHANGELOG.md`:

```text
packages/typescript/package.json
packages/rust/Cargo.toml
packages/python/pyproject.toml
packages/python/src/erpc_sdk/__init__.py
packages/ruby/lib/erpc_sdk/version.rb
Cargo.lock
CHANGELOG.md
```

An optional `--report` output must stay inside the checkout, use an existing
parent, and target a new file. Traversal, source overwrites, dangling links,
and parent links that resolve outside the checkout are rejected before any
managed output is written.

Anchored replacement is required for every managed value. Unrelated bytes,
dependency versions, lockfile sources, and line endings are preserved. An
empty `## Unreleased` section receives the two approved notes. Existing
Unreleased notes remain intact. An existing target section is reused so a
second run does not create duplicate headings or date-only churn.

Use a temporary candidate checkout for tests and review. Do not change package
versions in the source workspace while implementing or testing this tooling.

## Stage 3: observe and write a reviewable PR

The observer emits one canonical envelope with exactly `receipts`, `findings`,
and `reviewCandidate`. The corresponding operational destinations are limited
to these files:

```json
{ "receipts": {}, "findings": {}, "reviewCandidate": {} }
```

```text
registry/maintenance-findings.json
registry/source-baseline.json
registry/evidence/maintenance-review.json
registry/evidence/maintenance-review.md
```

`maintenance-pr.mjs` validates the same-run source SHA, token-catalog digest, and
trusted `observer-config.json` digest with the observer's strict validator. It
treats JSON and Markdown as data; it never imports artifact paths or executes
a patch. Canonical records and generated SDK files are not observer outputs.

The bot branches are fixed and purpose-specific: `codex/registry-maintenance`
for observation findings and `codex/release-preparation` for release
preparation. Before a branch or pull-request mutation, the writer rechecks
that remote `main` still equals the frozen base SHA. Existing branch updates
require recorded managed-head and semantic provenance and an exact
compare-and-swap lease. A branch with human edits or missing provenance is
refused. The semantic fingerprint excludes observation dates, transport/raw
hashes, and unrelated main SHAs; unchanged open or closed candidates therefore
do not churn.

The only workflow dispatch is the existing `.github/workflows/ci.yml` at the
bot branch ref, with these inputs:

```json
{
  "expected_head_sha": "<bot branch commit>",
  "base_sha": "<frozen main commit>"
}
```

Dispatch uses GitHub API version `2026-03-10`. A dispatch response is not proof
of execution; when run details are available, the writer verifies the run
head against both input SHAs. The writer never approves, merges, tags, or
publishes.

The intended writer token is isolated to `contents`, `pull_requests`, and
`actions:write`. The observer receives no such credential. API calls use
structured arguments or request bodies; untrusted shell interpolation and
PAT/App credentials are not part of this workflow.

## Stage 4: catalog CI baseline

CI must provide the actual pull-request base SHA, the push-before SHA, the
validated dispatch base SHA, and the PR head SHA:

```sh
node registry/ci-catalog-baseline.mjs \
  --base-sha "$BASE_SHA" \
  --push-before-sha "$PUSH_BEFORE_SHA" \
  --dispatch-base-sha "$DISPATCH_BASE_SHA" \
  --head-sha "$HEAD_SHA" --format=json
```

All three base values must be equal validated commit objects. The base must be
an ancestor of the PR head. The helper reads the previous catalog only with
`git show <base-sha>:registry/token-catalog.json`, validates its complete
history, and recomputes its digest. It refuses missing history, mismatched
refs, a base equal to the current checkout/PR head, and a non-ancestor head. It
never uses the current checkout catalog as a fallback baseline.

## Recovery and evidence

If a run reports `STALE_HEAD`, refetch and restart from a newly frozen main
SHA. For a human-edited bot branch, preserve the branch for review and create
no replacement automatically; record the managed-head mismatch, then remove or
repair it through the normal human workflow. For a missing tag or invalid
version, stop at inspection and assign a human release owner. A failed or
partial observer run is recorded as partial; it is not promoted to a native
capture claim.

The persisted EU OSS packet is planning evidence only. Applicability, company
role, product classification, support commitments, compliance status, and data
rights remain `UNDETERMINED`. Engineering owners are Root/Rydia for observation,
Bahamut for workflow, and Sephiroth for preparation. The human legal owner and
due date require assignment. The packet cites the European Commission CRA
open-source page (updated 2026-07-31), the Commission reporting page (updated
2026-09-11), and Database Directive 96/9/EC. Full EUR-Lex automated retrieval
remains a challenge gap. No legal certification, CE claim, regulatory filing,
or bulk source-text copy is issued by this process.

Existing temporary drivers are historical native-capture evidence for the token
catalog. DEX native runtime captures are produced and checked by the CI parity
jobs. The source-checkout ranking contract is offline and its populated
canonical integration remains subject to fresh collection and review. Actual
package publication, route selection, transaction building/signing/sending,
Solana CLMM quotes, and bridging remain separate future work. DEX catalog CI
checks do not grant discovery facts a new swap or bridge capability.
