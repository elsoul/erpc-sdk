# Releasing the ERPC SDK

One stable version and one `vX.Y.Z` tag identify both public packages:

- npm: [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk)
- crates.io: [`erpc-sdk`](https://crates.io/crates/erpc-sdk)

Releases are tag-driven, human-approved, and published by
`.github/workflows/release.yml`. A merge to `main` never publishes anything.
The workflow validates the tagged source, publishes each missing registry
version, and creates the GitHub Release only after both registry jobs succeed.

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

### First crates.io publication

crates.io requires the first version of a new crate to be published by a human
before Trusted Publishing can be configured. From a clean, reviewed `main`
checkout whose Rust and TypeScript versions match, the crate owner runs:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo package --locked --package erpc-sdk
cargo publish --locked --package erpc-sdk
```

Use an interactive, short-lived crates.io credential for this bootstrap only.
After the first version exists, configure its trusted publisher:

| Setting | Value |
| --- | --- |
| GitHub owner | `elsoul` |
| Repository | `erpc-sdk` |
| Workflow filename | `release.yml` |
| Environment | `crates-io` |

The workflow uses the official crates.io authentication action to obtain and
revoke a temporary token through OIDC. Revoke the bootstrap token after the
trusted publisher has been verified; do not store it in GitHub.

If the first crate version is published immediately before its shared release
tag, the tag workflow detects that exact crates.io version and safely skips the
duplicate upload. It still publishes a missing npm version and creates the
GitHub Release.

## GitHub Environments

Create `npm` and `crates-io` environments. For both environments configure:

- required human reviewers;
- prevention of self-review when two-person approval is required;
- deployment limited to protected `v*` release tags;
- no long-lived registry token secrets.

The publish jobs request `id-token: write` only inside their protected
environment. The source verification job has read-only repository permission.

## Prepare a version

1. Update `packages/typescript/package.json` and `packages/rust/Cargo.toml` to
   the same stable `X.Y.Z` version.
2. Run `corepack pnpm install` if the pnpm lockfile changes and `cargo update
   --workspace` when a Cargo dependency changes.
3. Update `CHANGELOG.md` and relevant public documentation.
4. Run `corepack pnpm release:check`.
5. Have the version change reviewed and merged to `main`.

The release command deliberately does not modify versions, stage files, or
create a commit. Those remain normal reviewed source changes.

## Release with one command

From a clean local `main` that exactly matches `origin/main`, run:

```bash
corepack pnpm release -- 0.2.0
```

The command:

1. verifies Rust and npm package names and versions;
2. rejects prerelease or malformed versions;
3. requires a clean `main` equal to `origin/main`;
4. rejects an existing local or remote tag;
5. runs the complete TypeScript and Rust release suite;
6. creates annotated tag `v0.2.0` and pushes only that tag.

The pushed tag starts the protected workflow. Approve both registry
environments, then verify the npm package, crates.io crate, generated docs, and
GitHub Release.

## Validation performed by CI

TypeScript validation includes strict typechecking, unit tests, builds, ESM and
CommonJS entry-point checks, and npm dry-run package inspection. Rust
validation includes formatting, Clippy with warnings denied, unit and transport
tests on the minimum supported Rust version, rustdoc warnings denied, release
build, package file listing, and `cargo package` verification.

The tag must exactly match both package versions and its commit must be an
ancestor of `main`. Invalid tags cannot reach either protected publish job.

## Recovery

Registry versions and release tags are immutable. The workflow checks both
registries before publishing, so rerunning a partially successful workflow
skips already-published versions and completes the missing package or GitHub
Release. If the tagged source itself is wrong, prepare a new patch version; do
not move or reuse the old tag.
