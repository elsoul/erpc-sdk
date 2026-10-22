#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 ELSOUL LABO B.V.
# SPDX-License-Identifier: Apache-2.0
#
# Modified for the SDK: isolated fixtures, diagnostic assertions and index tests.
# Self-test for scripts/check-oss-hygiene.sh: every rule must actually block a
# known-bad sample and must not block a known-good one. A hygiene gate that is
# never tested quietly stops catching things.
#
#   scripts/tests/check-oss-hygiene.test.sh
set -uo pipefail

# Run the gate, and this harness's own re-exec below, under the SAME bash
# that was used to start it -- never whatever `#!/usr/bin/env bash` finds on
# PATH. On a machine with a newer bash on PATH the CI job named "gates under
# bash 3.2" ran only this harness under 3.2 while the gate itself ran under
# bash 5, which does not share 3.2's collation behaviour. That is why two
# locale defects passed locally and failed only on the runner.
sh="${BASH:-/bin/bash}"

# A gate must behave the same whatever locale the caller has. Outside the C
# locale a bash range follows collation order: `[A-Z]` matches lowercase too,
# and `[!A-Za-z0-9._-]` stops matching accented letters. That silently turned
# two live rules into no-ops while this suite passed on a developer machine
# with no LANG set and failed only on the runner. So the suite runs itself
# once per locale and every case must pass in both.
if [ -z "${ERPC_TEST_LOCALE:-}" ]; then
  utf8=""
  # Deliberately not `locale -a | grep -q`: under `set -o pipefail` the -q
  # exit closes the pipe, `locale` dies of SIGPIPE and the pipeline reports
  # failure, so every locale looked absent. Match the captured list instead.
  all_locales="$(locale -a 2>/dev/null || true)"
  for cand in en_US.UTF-8 en_US.utf8; do
    case "
$all_locales
" in
      *"
$cand
"*) utf8="$cand"; break;;
    esac
  done
  if [ -z "$utf8" ]; then
    echo "no dictionary-collation UTF-8 locale on this machine, so the" >&2
    echo "locale-independence of the gate cannot be verified here." >&2
    exit 1
  fi
  rc=0
  for loc in C "$utf8"; do
    printf '== locale %s ==\n' "$loc"
    ERPC_TEST_LOCALE="$loc" LC_ALL="$loc" LANG="$loc" "$sh" "$0" "$@" || rc=1
  done
  exit "$rc"
fi

source_root="$(git rev-parse --show-toplevel)" || exit 2
sh="${BASH:-/bin/bash}"
tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT
repo_root="$tmp/repo"
mkdir -p "$repo_root/scripts"
cp "$source_root/scripts/check-oss-hygiene.sh" "$repo_root/scripts/"
cp "$source_root/scripts/oss-public-hosts.txt" "$repo_root/scripts/"
git -C "$repo_root" init -q || exit 2
cd "$repo_root" || exit 2
gate="$repo_root/scripts/check-oss-hygiene.sh"

pass=0
fail=0

# Runs the gate on one sample file placed at $rel inside the repo working tree.
# expect = "block" or "allow".
check() {
  local name="$1" expect="$2" rel="$3" content="$4"
  local abs="$repo_root/$rel"
  mkdir -p "$(dirname "$abs")"
  printf '%s\n' "$content" > "$abs"
  local out rc
  out="$("$sh" "$gate" "$rel" 2>&1)"; rc=$?
  rm -f "$abs"
  rmdir -p "$(dirname "$abs")" 2>/dev/null || true
  if { [ "$expect" != allow ] && [ "$rc" -eq 1 ] && [[ "$out" = *"$expect"* ]]; } || { [ "$expect" = allow ] && [ "$rc" -eq 0 ]; }; then
    pass=$((pass + 1))
    printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL %s (expected %s, exit %s)\n%s\n' "$name" "$expect" "$rc" "$out"
  fi
}

sample_dir="tmp-hygiene-test"

# --- must block -------------------------------------------------------------

check "internal design document by filename" "internal document:" "docs/architecture.md" \
  "# Architecture"

check "internal assessment by filename" "internal document:" "$sample_dir/eu-oss-assessment.md" \
  "# assessment"

check "non-public erpc.global host" "non-public erpc.global host:" "$sample_dir/a.rs" \
  'const URL: &str = "https://admin-internal.erpc.global/v1";'

check "cloudflare account identifier" "infrastructure identifier:" "$sample_dir/b.toml" \
  'account_id = "8a313f35be0eb4e99ad5bed9cb7aa99d"'

check "bearer token literal" "bearer token literal:" "$sample_dir/c.sh" \
  'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef"'

check "credential assignment" "credential assignment:" "$sample_dir/d.sh" \
  'export OP_SERVICE_ACCOUNT_TOKEN=ops_abcdefghijklmnopqrstuvwxyz0123456789'

check "solana keypair array" "looks like a Solana keypair array:" "$sample_dir/e.json" \
  "[$(python3 -c 'print(",".join(["7"]*64))')]"

check "labelled hex private key" "looks like a private key:" "$sample_dir/f.rs" \
  'let private_key = "0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3b4a0d4e5c6f7a8";'

check "PEM private key block" "PEM private key block" "$sample_dir/g.pem" \
  '-----BEGIN EC PRIVATE KEY-----'

check "sibling private repository reference" "internal reference:" "$sample_dir/h.md" \
  'See elsoul/internal-ops for the runbook.'

check "this repository is not an internal reference" allow "$sample_dir/h2.md" \
  'Clone it from https://github.com/elsoul/erpc-sdk'

check "reviewer team is not an own-repository reference" "internal reference:" "$sample_dir/h2b.md" \
  'Reviewers: @elsoul/erpc-sdk-maintainers'

check "a sibling sharing this repository's prefix is still blocked" "internal reference:" "$sample_dir/h2c.md" \
  'See elsoul/erpc-sdk-internal for the runbook.'

check "mixed-case internal host" "non-public erpc.global host:" "$sample_dir/h3.rs" \
  'const U: &str = "https://ops-internal.ERPC.global/";'

check "internal docs path reference" "internal reference:" "$sample_dir/i.md" \
  'The record lives in .claude/docs/erpc-sdk-management/README.md'

check "developer home path" "internal reference:" "$sample_dir/j.sh" \
  'cp /Users/someone/secrets.txt .'

check "bare 1Password vault identifier" "bare 1Password identifier:" "$sample_dir/op1.md" \
  'The signing key lives in vault 4xq7zj2mn8d5r3vb6kwth9pcyf.'

check "bare 1Password item identifier" "bare 1Password identifier:" "$sample_dir/op2.md" \
  'Rotate item gk2m9r4xtp7vn6bq3zdw8scylh after use.'

check "1Password dashboard URL with both identifiers" "bare 1Password identifier:" "$sample_dir/op2b.md" \
  'See https://my.1password.com/vaults/4xq7zj2mn8d5r3vb6kwth9pcyf/items/gk2m9r4xtp7vn6bq3zdw8scylh'

check "the words vault ID before the identifier" "bare 1Password identifier:" "$sample_dir/op2c.md" \
  '1Password vault ID 4xq7zj2mn8d5r3vb6kwth9pcyf.'

check "an op:// reference carrying both ids is a pointer, not a leak" allow "$sample_dir/op3.toml" \
  'identity_ref = "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/keypair"'

check "an op:// reference with a hyphenated item name" allow "$sample_dir/op3b.toml" \
  'ref = "op://myvault/myitem-abcdefghijklmnopqrstuvwxyz/field"'

check "uppercase base32 beside the word vault is not an identifier" allow "$sample_dir/op4.md" \
  'A base32 blob vault = MFRGGZDFMZTWQ2LKNNWG23TPOB is in prose.'

check "a commit hash beside the word vault is not an identifier" allow "$sample_dir/op5.md" \
  'vault at commit 3f2a9c1e4b7d8a6f5c2e0b9d4a1f6c3e8b5d2a70 today.'

check "committed dotenv" ".env files must not be committed" "$sample_dir/.env" \
  'TOKEN=abc'

# --- must allow -------------------------------------------------------------

check "published host" allow "$sample_dir/k.rs" \
  'const AUTH: &str = "https://user-api.erpc.global/v3/user";'

check "op secret reference" allow "$sample_dir/l.toml" \
  'identity_ref = "op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/keypair"'

check "public contract address" allow "$sample_dir/m.rs" \
  'const EURC: &str = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";'

check "env var name without a value" allow "$sample_dir/n.yml" \
  'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'

check "ordinary rust file" allow "$sample_dir/o.rs" \
  'pub fn main() { println!("hello"); }'

check "undeclared snapshot mirror host" "non-public erpc.global host:" "$sample_dir/p.rs" \
  'const SNAP: &str = "https://solana-snapshot-ams.erpc.global";'

# Additional boundaries and same-line exceptions.
check "git clone URL" allow "$sample_dir/clone.md" 'https://github.com/elsoul/erpc-sdk.git'
check "op pointer does not hide adjacent bare id" "bare 1Password identifier:" "$sample_dir/op-mixed.md" \
  'op://vault/item/field vault 4xq7zj2mn8d5r3vb6kwth9pcyf'
check "dotenv path precedes binary suffix skip" ".env files must not be committed" "$sample_dir/.env.png" 'placeholder'
check "public mixed-case host" allow "$sample_dir/host.md" 'https://EDGE.ERPC.global'
check "nearby test file is not exempt" "credential assignment:" "scripts/tests/nearby.test.sh" \
  'OP_CONNECT_TOKEN=abcdefghijklmnopqrstuvwxyz'
check "extra suffix on self-test is not exempt" "credential assignment:" "scripts/tests/check-oss-hygiene.test.sh.extra" \
  'OP_CONNECT_TOKEN=abcdefghijklmnopqrstuvwxyz'

# Check command status AND the diagnostic, including operational errors.
expect_run() {
  local name="$1" expected_rc="$2" want="$3" out rc
  shift 3
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq "$expected_rc" ] && [[ "$out" = *"$want"* ]]; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (exit %s, expected %s / %s)\n%s\n' "$name" "$rc" "$expected_rc" "$want" "$out"
  fi
}
git add scripts || exit 2
bad='OP_CONNECT_TOKEN=abcdefghijklmnopqrstuvwxyz'
weird=$'fixture with space\nand newline.txt'
printf '%s\n' "$bad" > "$weird"
git add -- "$weird" || exit 2
printf '%s\n' clean > "$weird"
expect_run "unborn index scans staged bytes with unusual filename" 1 "credential assignment:" "$sh" "$gate" --staged
rm "$weird"
expect_run "missing worktree still scans index" 1 "credential assignment:" "$sh" "$gate" --staged
printf '%s\n' clean > "$weird"
git add -- "$weird" || exit 2
printf '%s\n' "$bad" > "$weird"
expect_run "unstaged bytes do not contaminate staged scan" 0 "" "$sh" "$gate" --staged
expect_run "all tracked mode sees worktree content" 1 "credential assignment:" "$sh" "$gate"
git -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm fixture || exit 2
expect_run "clean index never falls back to worktree" 0 "" "$sh" "$gate" --staged
# Rename into a denied document name must check the new path.
printf '%s\n' clean > "$weird"
git mv -- "$weird" architecture.md || exit 2
expect_run "staged rename checks new path" 1 "internal document:" "$sh" "$gate" --staged
git rm -fq architecture.md || exit 2
expect_run "staged deletion has no content" 0 "" "$sh" "$gate" --staged
printf '%s\n' 'https://ops-internal.erpc.global' > host.txt
git add host.txt || exit 2
printf '%s\n' ops-internal.erpc.global >> scripts/oss-public-hosts.txt
expect_run "staged policy ignores unstaged grant" 1 "non-public erpc.global host:" "$sh" "$gate" --staged
git add scripts/oss-public-hosts.txt || exit 2
expect_run "staged explicit host grant" 0 "" "$sh" "$gate" --staged
: > scripts/oss-public-hosts.txt
expect_run "empty policy fails closed" 2 "could not read the host allowlist" "$sh" "$gate" host.txt
printf '%s\n' '*.erpc.global' > scripts/oss-public-hosts.txt
expect_run "malformed policy fails closed" 2 "invalid host allowlist entry" "$sh" "$gate" host.txt
printf 'edge.erpc.global\ninvalid' > scripts/oss-public-hosts.txt
expect_run "malformed final policy line without newline fails closed" 2 "invalid host allowlist entry" "$sh" "$gate" host.txt
printf 'edge.erpc.global\ninternal.worker.erpc.global' > scripts/oss-public-hosts.txt
printf '%s\n' 'https://internal.worker.erpc.global' > host.txt
expect_run "invalid final policy line cannot grant a host" 2 "invalid host allowlist entry" "$sh" "$gate" host.txt
printf 'edge.erpc.global' > scripts/oss-public-hosts.txt
printf '%s\n' 'https://edge.erpc.global' > host.txt
expect_run "valid final policy line needs no newline" 0 "" "$sh" "$gate" host.txt
rm scripts/oss-public-hosts.txt
expect_run "missing policy fails closed" 2 "scripts/oss-public-hosts.txt" "$sh" "$gate" host.txt

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
