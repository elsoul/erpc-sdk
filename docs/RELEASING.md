# Releasing the ERPC SDK

One stable `X.Y.Z` version identifies the TypeScript, Rust, and Python
packages. Go uses the same version through its subdirectory module tag:

- npm: [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk)
- crates.io: [`erpc-sdk`](https://crates.io/crates/erpc-sdk)
- PyPI: [`erpc-sdk`](https://pypi.org/project/erpc-sdk/)
- Go: [`github.com/elsoul/erpc-sdk/packages/go`](https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go)

Releases are tag-driven, human-approved, and published by
`.github/workflows/release.yml`. A merge to `main` never publishes anything.
The workflow validates the tagged source, publishes each missing registry
version, and creates the GitHub Release only after all registry jobs succeed.
The Go module is released by its matching subdirectory tag and needs no
registry upload.

## One-time bootstrap

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

## GitHub Environments

Create `npm`, `crates-io`, and `pypi` environments. For all three configure:

- required human reviewers;
- prevention of self-review when two-person approval is required;
- deployment limited to protected `v*` release tags;
- no long-lived registry token secrets.

The publish jobs request `id-token: write` only inside their protected
environment. Source verification has read-only repository permission.

## Prepare a version

1. Set the same stable `X.Y.Z` version in
   `packages/typescript/package.json`, `packages/rust/Cargo.toml`, and
   `packages/python/pyproject.toml`. Update `Cargo.lock` with the Rust package
   version.
2. Run `corepack pnpm install` if the pnpm lockfile changes, `cargo update
   --workspace` when Cargo dependencies change, `go mod tidy` when Go
   dependencies change, and update Python dependency bounds when necessary.
3. Update `CHANGELOG.md` and relevant public documentation.
4. Install each language's development dependencies and run
   `corepack pnpm release:check`.
5. Have the version change reviewed and merged to `main`.

The release command deliberately does not modify versions, stage files, or
create a commit. Those remain normal reviewed source changes.

## Release with one command

From a clean local `main` that exactly matches `origin/main`, run:

```bash
corepack pnpm release -- 0.3.0
```

The command:

1. verifies all package identities and shared versions;
2. rejects prerelease or malformed versions;
3. requires a clean `main` equal to `origin/main`;
4. rejects existing local or remote release tags;
5. runs the complete four-language release suite;
6. creates annotated tags `v0.3.0` and `packages/go/v0.3.0`;
7. atomically pushes both tags.

The root tag starts the protected workflow. Approve the registry environments,
then verify npm, crates.io, PyPI, the Go package documentation, generated Rust
documentation, and the GitHub Release.

## Validation performed by CI

TypeScript validation includes strict typechecking, unit tests, builds, ESM and
CommonJS entry-point checks, and npm dry-run package inspection. Rust
validation includes formatting, Clippy with warnings denied, tests on the
minimum supported Rust version, rustdoc warnings denied, a release build, and
crate package inspection. Python validation includes Ruff, strict mypy, async
tests, wheel and source-distribution builds, and Twine inspection. Go
validation includes module tidiness, formatting, vet, race-enabled tests, and
package listing on the minimum supported Go version.

CI also verifies that all four SDKs expose the same eight ordered RPC method
catalogs. The root tag must match the three versioned package manifests, the
Go tag must point to the same commit, and the release commit must be on `main`.
Invalid tags cannot reach a protected publish job.

## Recovery

Registry versions and release tags are immutable. The workflow checks npm,
crates.io, and PyPI before publishing, so rerunning a partially successful
workflow skips versions already present and completes missing publications or
the GitHub Release. If the tagged source itself is wrong, prepare a new patch
version; do not move or reuse an old tag.
