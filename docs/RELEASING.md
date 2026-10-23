# Releasing the ERPC SDK

The historical aligned release process uses one stable `X.Y.Z` version for the
TypeScript, Rust, Python, and Ruby packages. Go uses the same version through
its subdirectory module tag. The historical reviewed snapshot was split while
the Rust Bitcoin API was released separately (`0.10.0` Rust and `0.9.0`
non-Rust). The current reviewed foundation cohort is a separate manual
main-only process:

- Rust receipt: existing `0.10.0`, read-only in the foundation workflow
- TypeScript, Python, Ruby, and Go cohort: `0.9.1`

The legacy aggregate release check and tag workflow require one shared version.
They must not be used to publish this mixed-version snapshot; the aggregate
check is expected to fail until all package cohorts are aligned again.

Package links:

- npm: [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk)
- crates.io: [`erpc-sdk`](https://crates.io/crates/erpc-sdk)
- PyPI: [`erpc-sdk`](https://pypi.org/project/erpc-sdk/)
- Go: [`github.com/elsoul/erpc-sdk/packages/go`](https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go)
- RubyGems: [`erpc-sdk`](https://rubygems.org/gems/erpc-sdk)

The historical aligned-version release command is tag-oriented and human
approved. The current `.github/workflows/release.yml` is a separate manual
foundation for the first non-Rust proof cohort; it has no push, schedule, or
release-published trigger. A merge to `main` never publishes anything.

## Manual non-Rust 0.9.1 foundation release

The approved first proof cohort keeps Rust `0.10.0` as a read-only existing
receipt and prepares TypeScript, Python, Ruby, and Go as `0.9.1`:

- npm: `@elsoul/erpc-sdk@0.9.1`
- PyPI: `erpc-sdk==0.9.1` wheel and source distribution
- RubyGems: `erpc-sdk` `0.9.1` on the `ruby` platform
- Go: `packages/go/v0.9.1`
- GitHub Release tag: `non-rust-v0.9.1`

The foundation has two manual modes in `.github/workflows/release.yml`.
Preparation checks the exact `main` commit, builds the npm tarball, Python
wheel/source distribution, and Ruby gem once, freezes the Go regular-file
inventory, verifies the pre-existing Rust receipt, and emits a stable
content-addressed approval plan. The plan contains artifact names, hashes,
file listings, registry preflight, tags, the exact release body, and authorized
effects. Run and artifact IDs are kept in a separate binding so reruns do not
change the plan digest.

Publish mode requires the preparation run ID/attempt, both immutable artifact
IDs, and the reviewed plan SHA-256. It downloads and rechecks those exact
artifacts before any OIDC request. npm, PyPI, and RubyGems use their scoped
short-lived trusted-publishing jobs; existing matching artifacts are verified
without credentials, and each registry gets at most one upload attempt. The
Rust job only verifies `0.10.0` from its original source and checksum.

After all package proofs succeed, the workflow creates the two lightweight refs
`non-rust-v0.9.1` and `packages/go/v0.9.1` only when absent or already bound to
the approved commit. It then verifies the public Go proxy/checksum and creates
the GitHub Release titled `SDK release state: non-Rust 0.9.1 / Rust 0.10.0`
with the reviewed body and assets. A failed or ambiguous package, tag, Go, or
asset proof blocks the Release; retries reconcile public state without moving
tags or overwriting assets.

Preparation has read-only contents permission and no OIDC path. Only the
publisher jobs receive `id-token: write`; only the tag/Release jobs receive
`contents: write`. No static registry token, cargo authentication, weekly
schedule, or merge-triggered publication is configured. The release body
states that Bitcoin HTTP JSON-RPC remains Rust-only and that this cohort adds
no swap or bridge behavior.

## Manual Rust 0.10.0 release

Rust `0.10.0` is released through the manual
`.github/workflows/release-rust.yml` workflow. The other package versions stay
at the historical snapshot version; the current foundation cohort is `0.9.1`.
This workflow does not create tags, GitHub Releases, or releases for another
language.

Dispatch it from `main` with the exact commit and version that were reviewed:

1. Set `expected_commit` to the 40-character SHA of the intended `main` commit
   and `expected_version` to `0.10.0`.
2. Leave `publish` set to `false` for the first dispatch. Inspect the uploaded
   crate archive and validation evidence, including its SHA-256.
3. Have the release owner review and record that exact archive SHA-256, then
   dispatch the same commit and version with `publish` set to `true` and
   `approved_sha256` set to the reviewed hash.
4. Approve the protected `crates-io` environment when prompted. The workflow
   checks the exact crates.io version before authentication, uses the pinned
   short-lived OIDC action only when the version is absent, and proves the
   downloaded registry archive after the upload.

The workflow rechecks repository identity, event, `main` ref, commit, version,
and checkout in both jobs. It packages with Rust `1.85.0` from a clean source,
binds evidence to the source SHA and run, and requires the crate checksum,
provenance marker, BTC source/tests, README, and LICENSE to match. A matching
already-published version is verified without obtaining a new token. A failed
or timed-out upload is inspected and verified before any human chooses a
future dispatch; the workflow never retries an upload automatically.

This manual path is the current release process. A weekly release schedule is
future work and is not enabled. Do not run the legacy `corepack pnpm release:check`
or tag-driven aggregate publication while the package versions are split.

## One-off recovery of the published 0.9.1 cohort

The accepted uploads from publication run `39871872971` are reconciled by the
manual `.github/workflows/reconcile-foundation.yml` workflow. This workflow is
an observer and reconciliation controller; it has no registry authentication,
OIDC permission, npm/PyPI/RubyGems upload command, package build, or scheduled
trigger. A missing or ambiguous public version stops the run. Read-only
propagation probes may retry exact HTTP 404 responses for at most ten minutes;
HTTP errors, malformed metadata, hash mismatches, yanked files, and failed
attestation checks stop the run.

Keep the two commit identities separate throughout recovery:

- **M**, `4677d67d14c8fbb17ada3ba824d1623180c6b4d9`, is the approved package
  source, original publisher source, preparation/public provenance source,
  Go inventory source, and target for both `non-rust-v0.9.1` and
  `packages/go/v0.9.1`.
- **C** is the exact reviewed `main` commit containing this recovery workflow
  and the approved recovery tests/docs. Dispatch input
  `expected_control_commit` must equal the event SHA, workflow SHA, clean
  checkout, and `main` at every write boundary. The M-to-C tree delta contains
  only the three approved paths; C is never substituted into package or
  publisher provenance claims.

The run first rechecks C CI and the original successful preparation
`39862319930/1`, bundle `12461868771`, binding `12463070497`, and plan digest
`779aa1c48dc9ba2178fcfe021e102a12df85e4098c66120b1a3d2e8d7ca1911c`. It also
records publication run `39871872971/1` as its actual completed failure and
retains its job outcomes. Each exact public npm, PyPI, and RubyGems archive is
downloaded and matched to the approved digest. npm uses the canonical exact
version metadata and, only after an exact-version 404, the matching
`versions["0.9.1"]` entry from the canonical full packument. npm audit
signatures and both PyPI attestations are cryptographically verified against
M and the original `release.yml@refs/heads/main` publisher. The existing Rust
0.10.0 receipt remains read-only.

Ruby recovery uses the downloaded, hash-checked gem file with a fresh
`GEM_HOME`, `GEM_PATH`, cache, and empty gem configuration. It allows only
declared runtime dependencies from `https://rubygems.org/` and does not use a
local-only install or dependency suppression. Ruby 3.1 and 3.4 consumers must
load `erpc-sdk` 0.9.1, `base64` 0.2.0, and `digest-keccak` 0.0.7 from the
fresh gem directory, require the SDK, and pass deterministic Base64/Keccak
smoke checks. Credential variables and credential files must be absent; the
receipt records `credentialObserved=false`.

Only after all package and Rust receipts pass may the workflow create missing
lightweight tags at M, or accept existing exact M tags. It then verifies the Go
proxy/direct origins, checksums, and frozen M inventory. The final GitHub
Release keeps the approved title/body and exactly fifteen public assets. An
immutable recovery-context Actions artifact records C, the observer run, M,
the original preparation/publication identities, and the plan digest outside
that public asset set. Existing Release assets are downloaded and compared
before any missing asset is uploaded; mismatches are hard failures and no
overwrite or force update is allowed.

This is a bounded reconciliation of the already approved exact 0.9.1
publication. It does not rebuild packages, change versions or dependencies,
publish a replacement, release the unreleased Rust candidate, or create a
weekly release controller. Release, license, dependency, SBOM, security, and
EU OSS applicability conclusions remain evidence packets for human review;
they do not certify legal compliance, CE conformity, or regulatory authority.

## One-time bootstrap

These settings are required only when a registry is introduced or its trusted
publisher is replaced. They are not repeated for every release. A pending
publisher becomes a normal trusted publisher after its first successful
publication.

### npm Trusted Publishing

Open the existing npm package settings and configure a GitHub Actions trusted
publisher with these exact values:

| Setting | Value |
| --- | --- |
| Organization or user | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

Do not add an `NPM_TOKEN` secret. npm exchanges the workflow identity for a
short-lived publishing credential.

### crates.io Trusted Publishing

The foundation workflow never authenticates to crates.io. It verifies the
existing Rust `0.10.0` registry receipt and archive read-only. Any Rust
publication uses only the separate manual `release-rust.yml` workflow with the
named human reviewer and its pinned short-lived OIDC action. Do not configure
or store a crates.io token for the foundation workflow.

### First PyPI publication

Before the first Python release, create a pending trusted publisher at
PyPI's account publishing page with these exact values:

| Setting | Value |
| --- | --- |
| PyPI project name | `erpc-sdk` |
| GitHub owner | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `pypi` |

The pending publisher creates the project when the first trusted workflow run
publishes it. Do not add a PyPI API token secret.

### First RubyGems publication

Before the first Ruby release, create a pending trusted publisher from the
RubyGems.org profile page with these exact values:

| Setting | Value |
| --- | --- |
| Ruby gem name | `erpc-sdk` |
| GitHub owner | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `rubygems` |

The pending publisher creates the gem on the first trusted workflow run and
then becomes its regular trusted publisher. Do not add a RubyGems API key to
GitHub.

## GitHub Environments

For the historical aligned release process, create `npm`, `crates-io`,
`pypi`, and `rubygems` environments with the legacy tag restrictions. The
current foundation process uses manual `workflow_dispatch` from `main` and
the `npm`, `pypi`, and `rubygems` environments only. For every environment in
use, configure:

- required human reviewers;
- prevention of self-review when two-person approval is required;
- historical aligned deployments limited to protected `v*` release tags;
- foundation deployments limited to the reviewed manual `main` workflow;
- no long-lived registry token secrets.

The current Rust `crates-io` environment is used only by `release-rust.yml`,
which is manually dispatched from `main` and must retain its named human
reviewer and no long-lived secret. The foundation workflow has no Rust
publisher job.

The publish jobs request `id-token: write` only inside their protected
environment. Source verification has read-only repository permission.

## Legacy aligned-version release preparation

1. Choose a stable version and create a normal review branch. For example:

   ```bash
   export ERPC_RELEASE_VERSION=0.6.0
   git switch main
   git pull --ff-only origin main
   git switch -c "release/v${ERPC_RELEASE_VERSION}"
   ```

2. Set the same `X.Y.Z` version in `packages/typescript/package.json`,
   `packages/rust/Cargo.toml`, `packages/python/pyproject.toml`, and
   `packages/python/src/erpc_sdk/__init__.py`, and
   `packages/ruby/lib/erpc_sdk/version.rb`. Update the root `Cargo.lock` and
   `packages/ruby/Gemfile.lock` local package entries with the matching
   package version. Go has no version file; its version comes from the
   subdirectory tag.
3. Confirm that all package manifests agree before committing:

   ```bash
   node scripts/verify-release.mjs "v${ERPC_RELEASE_VERSION}"
   ```

4. Do not update dependencies as part of a version-only release. Keep the
   committed lock data and frozen Ruby install intact. Run `corepack pnpm
   install` if the pnpm lockfile changes, `cargo update --workspace` when
   Cargo dependencies change, and `go mod tidy` when Go dependencies change.
   Apart from the SDK version entries above, update Python or Ruby lock data
   only when separately reviewed dependency changes require it.
5. Update `CHANGELOG.md` and relevant public documentation.
6. Install each language's development dependencies and run:

   ```bash
   corepack pnpm release:check
   git diff --check
   ```

7. Commit and push the branch, open a pull request, and wait for every required
   check. With the GitHub CLI, the checks can be monitored with:

   ```bash
   gh pr checks PR_NUMBER --watch --interval 10
   ```

8. Have the version change reviewed and merged to `main`. Do not tag a pull
   request branch or an unmerged commit.

The release command deliberately does not modify versions, lockfiles, stage
files, or create a commit. Those remain normal reviewed source changes.

The eight release preparation outputs are the five package version sources,
`Cargo.lock`, `packages/ruby/Gemfile.lock`, and `CHANGELOG.md`. The local Ruby
lock must contain the unique `PATH` `erpc-sdk` entry with `remote: .` at the
same version as `packages/ruby/lib/erpc_sdk/version.rb`; a dependency refresh
or disabling Bundler's frozen install is outside release preparation.

## Legacy aligned-version release with one command

From a clean local `main` that exactly matches `origin/main`, run:

```bash
export ERPC_RELEASE_VERSION=0.6.0
git switch main
git pull --ff-only origin main
git status --short --branch
corepack pnpm release -- "$ERPC_RELEASE_VERSION"
```

Stop if `git status` reports a modified or untracked file, or if `main` is not
tracking `origin/main`. Never delete or move an existing release tag to make
this command pass.

The command:

1. verifies all package identities and shared versions;
2. rejects prerelease or malformed versions;
3. requires a clean `main` equal to `origin/main`;
4. rejects existing local or remote release tags;
5. runs the complete five-language release suite;
6. creates annotated tags `vX.Y.Z` and `packages/go/vX.Y.Z`;
7. atomically pushes both tags.

The root tag starts the protected workflow. Approve the registry environments,
then verify npm, crates.io, PyPI, RubyGems, the Go package documentation,
generated Rust documentation, and the GitHub Release.

## Monitor and verify a legacy aligned-version release

Find the run whose branch is `vX.Y.Z`, then watch it to completion:

```bash
gh run list --workflow release.yml --limit 5
gh run watch RUN_ID --interval 10
```

All publish jobs and `Create GitHub Release` must succeed. Confirm the four
registry uploads using the versions currently recorded in the manifests:

```bash
node scripts/check-registry-version.mjs npm
node scripts/check-registry-version.mjs crates
node scripts/check-registry-version.mjs pypi
node scripts/check-registry-version.mjs rubygems
```

Confirm the Go module, GitHub Release, and both tags separately:

```bash
GOPROXY=https://proxy.golang.org go list -m -json \
  "github.com/elsoul/erpc-sdk/packages/go@v${ERPC_RELEASE_VERSION}"
gh release view "v${ERPC_RELEASE_VERSION}"
git rev-list -n 1 "v${ERPC_RELEASE_VERSION}"
git rev-list -n 1 "packages/go/v${ERPC_RELEASE_VERSION}"
git rev-parse origin/main
```

The three commit IDs printed by the last three Git commands must be identical.
Registry metadata can take a short time to propagate even after its publish
job succeeds; retry the read-only checks before treating that delay as a
failure.

## Validation performed by CI

The checks below describe the legacy aligned-version path. The current Rust
workflow runs only the Rust cohort and does not assert that the other package
versions match it.

TypeScript validation includes strict typechecking, unit tests, builds, ESM and
CommonJS entry-point checks, and npm dry-run package inspection. Rust
validation includes formatting, Clippy with warnings denied, tests on the
minimum supported Rust version, rustdoc warnings denied, a release build, and
crate package inspection. Python validation includes Ruff, strict mypy, async
tests, wheel and source-distribution builds, and Twine inspection. Go
validation includes module tidiness, formatting, vet, race-enabled tests, and
package listing on the minimum supported Go version. Ruby validation includes
syntax checks, unit tests on the minimum supported Ruby version, explicit gem
content inspection, a packaged load-path smoke test, and the anchored local
`Gemfile.lock` version check.

CI also verifies that all five SDKs expose the same fourteen ordered RPC method
catalogs. The root tag must match the four versioned package manifests, the
Go tag must point to the same commit, and the release commit must be on `main`.
Invalid tags cannot reach a protected publish job.

## Legacy workflow recovery

For the exact published 0.9.1 cohort, use **One-off recovery of the published
0.9.1 cohort** above. Do not rerun `.github/workflows/release.yml`, request a
new registry credential, or upload a replacement archive for that recovery.

For the historical aligned workflow, registry versions and release tags are immutable. That workflow checks npm,
crates.io, PyPI, and RubyGems before publishing, so rerunning a partially
successful workflow skips versions already present and completes missing
publications or the GitHub Release:

```bash
gh run rerun RUN_ID
gh run watch RUN_ID --interval 10
```

If a protected environment is awaiting approval, approve that deployment
instead of starting another release. If registry authentication fails, repair
the trusted publisher or environment configuration and rerun the same workflow.
If the tagged source itself is wrong, prepare a new patch version; do not move
or reuse an old tag.

## End-of-release cleanup

Generated package artifacts and test caches are ignored by Git and can remain
after a successful local validation. Preview repository state, remove only the
known generated paths, and confirm that tracked files are untouched:

```bash
git status --short --branch
rm -rf \
  target \
  packages/typescript/dist \
  packages/python/dist \
  packages/python/.pytest_cache \
  packages/python/.mypy_cache \
  packages/python/.ruff_cache \
  packages/python/tests/__pycache__ \
  packages/ruby/pkg \
  .ruff_cache
git status --short --branch
```

Dependency directories such as `node_modules` and virtual environments are not
release artifacts. Keep them for continued development, or remove their exact
paths separately when ending an isolated work session. Do not use a broad
`git clean` command in a working tree that may contain local configuration.
