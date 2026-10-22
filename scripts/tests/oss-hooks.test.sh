#!/usr/bin/env bash
# Run the real Lefthook configuration in a disposable repository. Expensive
# language commands and Gitleaks are recording stubs; their implementations
# are tested separately. Hygiene reads the real staged index.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
lefthook="$root/node_modules/.bin/lefthook"
[ -x "$lefthook" ] || { echo 'install pinned dependencies first' >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/scripts/tests" "$tmp/bin"
cp "$root/lefthook.yml" "$tmp/repo/"
cp "$root/scripts/check-oss-hygiene.sh" "$root/scripts/oss-public-hosts.txt" "$tmp/repo/scripts/"
export HOOK_CALLS="$tmp/calls" PATH="$tmp/bin:$root/node_modules/.bin:$PATH"
cat > "$tmp/repo/scripts/run-gitleaks.sh" <<'BIN'
#!/bin/sh
printf 'gitleaks %s\n' "$*" >> "$HOOK_CALLS"
exit "${FIXTURE_GITLEAKS_STATUS:-0}"
BIN
for name in corepack cargo; do
  cat > "$tmp/bin/$name" <<'BIN'
#!/bin/sh
printf '%s %s\n' "${0##*/}" "$*" >> "$HOOK_CALLS"
BIN
  chmod +x "$tmp/bin/$name"
done
for name in check-oss-hygiene run-gitleaks oss-hooks; do
  printf 'printf "selftest %%s\\n" "%s" >> "$HOOK_CALLS"\n' "$name" > "$tmp/repo/scripts/tests/$name.test.sh"
done
cat > "$tmp/repo/scripts/check-go-format.mjs" <<'BIN'
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.HOOK_CALLS, 'go-format\n');
BIN
cp "$tmp/repo/scripts/check-go-format.mjs" "$tmp/repo/scripts/tests/oss-controls.test.mjs"
cd "$tmp/repo"
git init -q
# Isolate hook install from any machine-level configuration.
git config user.name Fixture
git config user.email fixture@example.invalid
"$lefthook" install > "$tmp/install.log" 2>&1
mkdir -p packages/typescript/src packages/rust/src packages/python/src packages/go packages/ruby/lib
for path in packages/typescript/src/a.ts packages/rust/src/a.rs packages/python/src/a.py packages/go/a.go packages/ruby/lib/a.rb; do
  printf '// fixture\n' > "$path"
done
git add .
git commit -qm 'clean fixture' > "$tmp/commit.log" 2>&1 || { cat "$tmp/commit.log"; exit 1; }
for want in 'gitleaks protect --staged --redact --config .gitleaks.toml' 'corepack pnpm check' 'cargo fmt --all -- --check' 'corepack pnpm python:check' 'go-format' 'corepack pnpm ruby:check'; do
  grep -F -- "$want" "$HOOK_CALLS" >/dev/null || { echo "missing hook call: $want"; exit 1; }
done
printf 'account_id = "%s"\n' '0123456789abcdef0123456789abcdef' > sample.txt
git add sample.txt
printf clean > sample.txt
if git commit -qm 'must reject index' > "$tmp/blocked.log" 2>&1; then
  echo 'FAIL pre-commit accepted a staged infrastructure identifier'; exit 1
fi
grep -F 'infrastructure identifier:' "$tmp/blocked.log" >/dev/null
printf clean > sample.txt
git add sample.txt
if FIXTURE_GITLEAKS_STATUS=1 git commit -qm 'must reject scanner failure' > "$tmp/blocked.log" 2>&1; then
  echo 'FAIL pre-commit ignored gitleaks failure'; exit 1
fi
"$lefthook" run pre-push > "$tmp/push.log" 2>&1 || { cat "$tmp/push.log"; exit 1; }
for want in 'gitleaks git --redact --config .gitleaks.toml --log-opts=--all .' 'selftest check-oss-hygiene' 'selftest run-gitleaks' 'selftest oss-hooks' 'corepack pnpm test' 'corepack pnpm rust:test' 'corepack pnpm python:test' 'corepack pnpm go:test' 'corepack pnpm ruby:test'; do
  grep -F -- "$want" "$HOOK_CALLS" >/dev/null || { echo "missing pre-push call: $want"; exit 1; }
done
if FIXTURE_GITLEAKS_STATUS=1 "$lefthook" run pre-push > "$tmp/blocked.log" 2>&1; then
  echo 'FAIL pre-push ignored history scan failure'; exit 1
fi
printf '5 hook integration checks passed\n'
