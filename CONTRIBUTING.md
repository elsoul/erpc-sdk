# Contributing

Thank you for contributing to the ERPC SDK.

## Development

Requirements:

- Node.js 22.13 or newer for workspace development
- Corepack
- pnpm 11
- Rust 1.85 or newer with `rustfmt` and `clippy`
- Python 3.11 or newer
- Go 1.22 or newer
- Ruby 3.1 or newer with Bundler

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack:check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo package --package erpc-sdk
python -m pip install -e './packages/python[dev]'
pnpm python:check
pnpm python:test
pnpm python:pack:check
pnpm go:check
pnpm go:test
pnpm go:pack:check
cd packages/ruby
bundle install
cd ../..
pnpm ruby:check
pnpm ruby:test
pnpm ruby:pack:check
```

## Repository hygiene checks

After installing workspace dependencies, install the pinned Git hooks explicitly:

```bash
pnpm lefthook install
bash scripts/tests/check-oss-hygiene.test.sh
bash scripts/tests/run-gitleaks.test.sh
bash scripts/tests/oss-hooks.test.sh
node --test scripts/tests/oss-controls.test.mjs
```

Lefthook is pinned in the workspace lockfile; its dependency install script is
explicitly disabled. `pre-commit` scans staged changes with Gitleaks and scans
staged file contents and the staged host policy with the hygiene gate. Language
globs select the existing TypeScript, Python and Ruby checks and Rust/Go format
checks; those language tools check the working tree. `pre-push` scans Git history
and tracked working-tree files, runs the gate tests, and runs all five languages'
existing checks and tests. Install the development dependencies listed above
before pushing. Fix false positives in the relevant rule with a regression test
and explain the change in the same commit; never use `--no-verify`.

Hook installation is a manual per-checkout action: a newly cloned or separately
managed checkout has no protection until `pnpm lefthook install` is run there.
The hooks protect ordinary local commits and pushes only; GitHub API writes can
bypass local hooks. The dependency-maintenance writer therefore performs its
own fresh pinned Gitleaks scan of the exact observation and candidate bytes
before its first API mutation. The helper offers no scan opt-out or caller
asserted pass path, and hooks remain manually managed and bypassable local
controls.

`scripts/run-gitleaks.sh` downloads the official Gitleaks 8.30.1 binary for
macOS/Linux on x64/arm64. Each platform archive has a pinned SHA256. The wrapper
checks cached archives on every invocation and extracts a fresh executable into
a temporary directory. It needs Git, curl, tar, and `sha256sum` or `shasum`.
Gitleaks is MIT-licensed; the imported detection configuration and hygiene files
retain their Apache-2.0 notices. No Gitleaks GitHub Action is used.

The hygiene gate checks text for cloud account/zone/project IDs, bare 1Password
vault/item IDs, bearer literals, selected credential assignments, single-line
64-element keypair arrays, labelled 64-digit hex keys, PEM private-key headers,
sibling organisation references, developer home paths, and internal-document
filename conventions. It rejects `.env` names, including `.env.example`.
`op://` references are pointers and are allowed, while adjacent bare identifiers
are still checked. The project's exact repository path and its `.git` form are
allowed. Internal designs and assessment records belong in private documentation.

Literal ERPC subdomains are checked against `scripts/oss-public-hosts.txt`.
The apex `erpc.global` is not matched by this check. The list covers the six
ERPC subdomains already used here; it does not restrict user-supplied RPC URLs
or check every URL's destination. The gate is a pattern
scanner, not proof that a file contains no secrets. Its `skip_re` and `self_re`
define the exact content exclusions, including selected binary extensions,
`.lock` files, license text, and the gate and its own fixture script. Gitleaks
adds the default credential rules and the custom rules in `.gitleaks.toml`.
Public blockchain metadata exceptions are rule-specific; other findings in
those files remain subject to scanning. Report suspected exposures privately
using [SECURITY.md](SECURITY.md).

CI runs the same hygiene gate and complete-history Gitleaks scan. Hygiene tests
run in `C` and `en_US.UTF-8` under Linux Bash 5 and macOS Bash 3.2, invoking the
gate with the same interpreter as the test harness. Both jobs are required by
`required-ci`. The mutation tests remove individual detectors, staged-index
reads, checksum enforcement and hook calls to verify that tests detect the loss.

Keep changes focused and include tests for observable behavior. Public APIs
must use explicit exports and strict language-native types. Avoid `any` in
TypeScript library code. Preserve JSON-RPC wire names and positional parameter
order across all implementations.

Do not add automatic retries for transaction submission or other
state-changing methods. Never log API keys or include them in thrown error
messages, fixtures, snapshots, or examples.

## Pull requests

- Explain the user-visible behavior and compatibility impact.
- Update `docs/METHODS.md` when method availability changes.
- Add a changeset or release note when a public API changes once the release
  process is introduced.
- Ensure all checks pass from a clean install.

All releases require explicit human approval.

## Public process and evidence

- Report suspected vulnerabilities through [SECURITY.md](SECURITY.md), not a
  public issue.
- Follow [secret-exposure response](docs/secret-exposure-response.md) guidance
  if a credential, private endpoint, customer data, or signing material may
  have entered a change, log, artifact, or release.
- Use [GOVERNANCE.md](GOVERNANCE.md) for repository roles and approval
  boundaries.
- Use the [public compliance and evidence index](docs/compliance/README.md) and
  [release verification guide](docs/verify-release.md) when a change affects
  component licenses, dependencies, security-sensitive behavior, or release
  evidence.

When those areas change, include the affected language packages and versions,
the evidence or reproduction needed to review the change, and any remaining
uncertainty. Keep credentials, customer context, private incident records, and
unreleased security details out of commits, examples, and public issue
discussion. These prompts improve review context; they do not add a license,
support-period, release, or regulatory requirement.
