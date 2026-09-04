# Releasing the ERPC SDK

One stable `X.Y.Z` version identifies the TypeScript, Rust, Python, and Ruby
packages. Go uses the same version through its subdirectory module tag:

- npm: [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk)
- crates.io: [`erpc-sdk`](https://crates.io/crates/erpc-sdk)
- PyPI: [`erpc-sdk`](https://pypi.org/project/erpc-sdk/)
- Go: [`github.com/elsoul/erpc-sdk/packages/go`](https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go)
- RubyGems: [`erpc-sdk`](https://rubygems.org/gems/erpc-sdk)

Releases are tag-driven, human-approved, and published by
`.github/workflows/release.yml`. A merge to `main` never publishes anything.
The workflow validates the tagged source, publishes each missing registry
version, and creates the GitHub Release only after all registry jobs succeed.
The Go module is released by its matching subdirectory tag and needs no
registry upload.

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

The crate already exists. Configure its trusted publisher with:

| Setting | Value |
| --- | --- |
| GitHub owner | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `crates-io` |

The workflow uses the crates.io authentication action to obtain and revoke a
temporary token through OIDC. Do not store a crates.io token in GitHub.

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

Create `npm`, `crates-io`, `pypi`, and `rubygems` environments. For all four
configure:

- required human reviewers;
- prevention of self-review when two-person approval is required;
- deployment limited to protected `v*` release tags;
- no long-lived registry token secrets.

The publish jobs request `id-token: write` only inside their protected
environment. Source verification has read-only repository permission.

## Prepare a version

1. Choose a stable version and create a normal review branch. For example:

   ```bash
   export ERPC_RELEASE_VERSION=0.5.0
   git switch main
   git pull --ff-only origin main
   git switch -c "release/v${ERPC_RELEASE_VERSION}"
   ```

2. Set the same `X.Y.Z` version in `packages/typescript/package.json`,
   `packages/rust/Cargo.toml`, `packages/python/pyproject.toml`, and
   `packages/python/src/erpc_sdk/__init__.py`, and
   `packages/ruby/lib/erpc_sdk/version.rb`. Update the root `Cargo.lock` with
   the Rust package version. Go has no version file; its version comes from the
   subdirectory tag.
3. Confirm that all package manifests agree before committing:

   ```bash
   node scripts/verify-release.mjs "v${ERPC_RELEASE_VERSION}"
   ```

4. Run `corepack pnpm install` if the pnpm lockfile changes, `cargo update
   --workspace` when Cargo dependencies change, `go mod tidy` when Go
   dependencies change, and update Python or Ruby lock data when their
   dependencies change.
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

The release command deliberately does not modify versions, stage files, or
create a commit. Those remain normal reviewed source changes.

## Release with one command

From a clean local `main` that exactly matches `origin/main`, run:

```bash
export ERPC_RELEASE_VERSION=0.5.0
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

## Monitor and verify the release

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

TypeScript validation includes strict typechecking, unit tests, builds, ESM and
CommonJS entry-point checks, and npm dry-run package inspection. Rust
validation includes formatting, Clippy with warnings denied, tests on the
minimum supported Rust version, rustdoc warnings denied, a release build, and
crate package inspection. Python validation includes Ruff, strict mypy, async
tests, wheel and source-distribution builds, and Twine inspection. Go
validation includes module tidiness, formatting, vet, race-enabled tests, and
package listing on the minimum supported Go version. Ruby validation includes
syntax checks, unit tests on the minimum supported Ruby version, explicit gem
content inspection, and a packaged load-path smoke test.

CI also verifies that all five SDKs expose the same eight ordered RPC method
catalogs. The root tag must match the four versioned package manifests, the
Go tag must point to the same commit, and the release commit must be on `main`.
Invalid tags cannot reach a protected publish job.

## Recovery

Registry versions and release tags are immutable. The workflow checks npm,
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
