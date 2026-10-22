#!/usr/bin/env bash
# Offline tests of download/cache integrity. Substitute a local archive pin in
# an isolated copy; never modify the production runner or execute a bad archive.
set -euo pipefail
sh="${BASH:-/bin/bash}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/payload" "$tmp/cache"
cat > "$tmp/payload/gitleaks" <<'BIN'
#!/bin/sh
printf '%s\n' 'fixture binary ran' >> "$FIXTURE_EXECUTIONS"
printf '%s\n' "$*"
BIN
chmod +x "$tmp/payload/gitleaks"
tar -czf "$tmp/good.tar.gz" -C "$tmp/payload" gitleaks
hash=$(shasum -a 256 "$tmp/good.tar.gz"); hash=${hash%% *}
sed "s/sha=[0-9a-f]*/sha=$hash/g" "$root/scripts/run-gitleaks.sh" > "$tmp/runner.sh"
cat > "$tmp/bin/uname" <<'BIN'
#!/bin/sh
case "$1" in -s) echo Linux;; -m) echo x86_64;; esac
BIN
cat > "$tmp/bin/curl" <<'BIN'
#!/bin/sh
[ "${FIXTURE_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then out=$2; shift; fi
  shift
done
cp "$FIXTURE_ARCHIVE" "$out"
BIN
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" XDG_CACHE_HOME="$tmp/cache"
export FIXTURE_ARCHIVE="$tmp/good.tar.gz" FIXTURE_EXECUTIONS="$tmp/executions"
expect() {
  local name="$1" rc="$2" want="$3" out actual
  set +e
  out=$("$sh" "$tmp/runner.sh" protect --staged --redact 2>&1); actual=$?
  set -e
  if [ "$rc" = fail ]; then [ "$actual" -ne 0 ]; else [ "$actual" -eq 0 ]; fi
  [[ "$out" = *"$want"* ]] || { printf 'FAIL %s: %s\n' "$name" "$out"; exit 1; }
  printf 'ok   %s\n' "$name"
}
expect 'verified download forwards arguments' pass 'protect --staged --redact'
export FIXTURE_DOWNLOAD_FAIL=1
expect 'verified cache works offline' pass 'protect --staged --redact'
archive="$XDG_CACHE_HOME/erpc-sdk/gitleaks/8.30.1/gitleaks_8.30.1_linux_x64.tar.gz"
printf corrupt > "$archive"
expect 'tampered cache is rejected' fail 'Gitleaks archive checksum mismatch'
[ "$(wc -l < "$FIXTURE_EXECUTIONS" | tr -d ' ')" = 2 ]
rm "$archive"
expect 'network failure is rejected' fail ''
export FIXTURE_DOWNLOAD_FAIL=0
printf corrupt > "$tmp/bad.tar.gz"
export FIXTURE_ARCHIVE="$tmp/bad.tar.gz"
expect 'bad download is rejected before extraction' fail 'Gitleaks archive checksum mismatch'
[ ! -e "$archive" ]
[ "$(wc -l < "$FIXTURE_EXECUTIONS" | tr -d ' ')" = 2 ]
export FIXTURE_ARCHIVE="$tmp/good.tar.gz"
cat > "$tmp/bin/sha256sum" <<'BIN'
#!/bin/sh
exit 2
BIN
chmod +x "$tmp/bin/sha256sum"
expect 'hash tool failure is rejected' fail ''
[ "$(wc -l < "$FIXTURE_EXECUTIONS" | tr -d ' ')" = 2 ]
printf '6 wrapper checks passed\n'
