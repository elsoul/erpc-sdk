# Contributing

Thank you for contributing to the ERPC SDK.

## Development

Requirements:

- Node.js 22.13 or newer for workspace development
- Corepack
- pnpm 11
- Rust 1.85 or newer with `rustfmt` and `clippy`

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
```

Keep changes focused and include tests for observable behavior. Public APIs
must use explicit exports and strict TypeScript or Rust types. Avoid `any` in
TypeScript library code. Preserve JSON-RPC wire names and positional parameter
order in both implementations.

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
