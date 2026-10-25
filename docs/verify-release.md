# Verify a published release

This is a read-only consumer guide for the release observed on 2026-10-25.
It explains how to compare downloaded bytes with the package-specific digest
recorded by the release evidence. A matching digest is an integrity comparison
against the supplied evidence; it is not, by itself, independent authenticity,
legal compliance, or a universal signature.

## Identify the release

The current GitHub release is
[`non-rust-v0.11.0`](https://github.com/elsoul/erpc-sdk/releases/tag/non-rust-v0.11.0).
Its tag proof records `non-rust-v0.11.0` and the Go module tag
`packages/go/v0.11.0` at source commit
`00343b27668122cffd6d5b2b7517eda96f109d5f`. The release contains these 13
observed assets:

- `elsoul-erpc-sdk-0.11.0.tgz`
- `erpc_sdk-0.11.0-py3-none-any.whl`
- `erpc_sdk-0.11.0.tar.gz`
- `erpc-sdk-0.11.0.gem`
- `npm-proof.json`, `pypi-proof.json`, `rubygems-proof.json`,
  `rust-proof.json`, `go-proof.json`, and `tag-proof.json`
- `release-set-proof-manifest.json`, `go-inventory.json`, and `release-body.md`

There is no Rust crate archive, Go ZIP, standalone `checksums.txt` or
`SHA256SUMS`, SBOM, or minisign file among those GitHub assets. The Rust
`0.11.0` crate is a separate immutable published crate reused from source
`4877b32a32ffb6b82a6620040fe77fc2e73f4386`; the release body records its
published crate digest and reuse. It was not rebuilt or republished for this
release.

The release body also records that the five SDKs consume common data; swap
quote, route, and build operations use configured RPC endpoints and local
logic; and the release adds no hosted Jupiter or 0x dependency. Bridge
integrations retain separate provider dependencies and bounded reviewed routes;
the published `0.11.0` package guides cover Mayan adapter/local unsigned
construction, while the new chain read matrix does not expand bridge
capabilities. These product boundaries do not imply full API, provider,
signing, swap, or bridge parity across the five packages.

## Compare package bytes

Download the archive and its matching proof from the [release asset list](https://github.com/elsoul/erpc-sdk/releases/tag/non-rust-v0.11.0),
then print a local SHA-256 digest. These commands only read public release files
and write local downloads; they do not install or run SDK code or contact a
blockchain RPC endpoint. For example:

```bash
curl -fL \
  https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0/elsoul-erpc-sdk-0.11.0.tgz \
  -o elsoul-erpc-sdk-0.11.0.tgz
shasum -a 256 elsoul-erpc-sdk-0.11.0.tgz
```

Compare the output with the package field for the exact file. The expected
values observed for this release are:

| Package / identity | File | Proof field | Expected SHA-256 |
| --- | --- | --- | --- |
| npm `@elsoul/erpc-sdk@0.11.0` | `elsoul-erpc-sdk-0.11.0.tgz` | `npm-proof.json` → `.descriptor.observedSha256` | `50c6ad17e24050eb6e5a5752b6cfc9d4e5c85d1c3e01e7db03bd2aa45754325a` |
| PyPI wheel `erpc-sdk==0.11.0` | `erpc_sdk-0.11.0-py3-none-any.whl` | `pypi-proof.json` → `.files[]` where `kind` is `pypi-wheel` → `.sha256` | `aa60375f9e37dabb1aa798c4da59c1f5ce558125f952bf52b43f2ab460f7c02e` |
| PyPI sdist `erpc-sdk==0.11.0` | `erpc_sdk-0.11.0.tar.gz` | `pypi-proof.json` → `.files[]` where `kind` is `pypi-sdist` → `.sha256` | `ca9f1b2eedd6e6163ae5b7470e7588bd96e49e06de067c42256203ce6edfa2d2` |
| RubyGems `erpc-sdk-0.11.0` | `erpc-sdk-0.11.0.gem` | `rubygems-proof.json` → `.archive.sha256` | `957aab0bb58254b1cdd8d53d7540216f8d3eea2d30ce058b089c0f3d0eed02ef` |
| Rust crate `erpc-sdk=0.11.0` | `erpc-sdk-0.11.0.crate` from crates.io | `rust-proof.json` → `.archive.sha256` | `fe3e0e224a60921531d09442ecbe68ab9a34ae3ebed7821ab02a309b8b66f7f6` |

The Rust archive is downloaded from its registry rather than the GitHub
release, for example:

```bash
curl -fL https://crates.io/api/v1/crates/erpc-sdk/0.11.0/download \
  -o erpc-sdk-0.11.0.crate
shasum -a 256 erpc-sdk-0.11.0.crate
```

To check both receipt consistency and the npm package bytes with the actual
manifest fields, a consumer can use this small offline check after downloading
the three named files:

```bash
mkdir erpc-sdk-0.11.0-check
cd erpc-sdk-0.11.0-check
release_url='https://github.com/elsoul/erpc-sdk/releases/download/non-rust-v0.11.0'
for file in release-set-proof-manifest.json npm-proof.json elsoul-erpc-sdk-0.11.0.tgz; do
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$file" "$release_url/$file"
done
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

def sha256(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()

manifest = json.loads(Path('release-set-proof-manifest.json').read_text())
receipt = json.loads(Path('npm-proof.json').read_text())
assert manifest['versions']['nonRustVersion'] == '0.11.0'
assert sha256('npm-proof.json') == manifest['receipts']['npm-proof.json']
package = receipt['descriptor']
assert (package['name'], package['version']) == ('@elsoul/erpc-sdk', '0.11.0')
assert package['filename'] == 'elsoul-erpc-sdk-0.11.0.tgz'
assert sha256(package['filename']) == package['observedSha256'] == package['expectedSha256']
print('Downloaded npm bytes match the receipt; receipt bytes match the manifest.')
PY
```

For an exact npm package already installed in a consumer project,
[`npm audit signatures`](https://docs.npmjs.com/cli/commands/npm-audit/) is the
registry-supported fresh signature and provenance check. It requires a
suitable npm client and installed dependencies, and its result is project-wide;
identify `@elsoul/erpc-sdk@0.11.0` in the result. See npm's
[package provenance guidance](https://docs.npmjs.com/viewing-package-provenance/).
Do not replace this with `npm audit fix`. The JSON receipt is release-time
evidence, not a fresh signature check. PyPI's receipt links the wheel and sdist
provenance endpoints above, but this release does not establish one universal
five-package attestation command.

Do not use `release-set-proof-manifest.json`'s `.receipts` values as package
digests. Those values hash the receipt JSON files. Its `receiptArtifacts` and
`snapshot` hashes identify workflow ZIPs and snapshots. Use the package-specific
fields in the table above.

## Read registry-specific evidence

- The npm receipt records the exact package registry response, observed SRI,
  package SHA-256, and package-specific provenance subject. It also records a
  consumer install/import smoke check. Read those fields together; an npm
  receipt is not a signature for every release asset.
- The PyPI receipt has one record for the wheel and one for the sdist. Each
  includes a package digest and a PyPI provenance URL: [wheel provenance](https://pypi.org/integrity/erpc-sdk/0.11.0/erpc_sdk-0.11.0-py3-none-any.whl/provenance)
  and [sdist provenance](https://pypi.org/integrity/erpc-sdk/0.11.0/erpc_sdk-0.11.0.tar.gz/provenance).
  The URLs and receipt fields have package-specific scope.
- The RubyGems and Rust receipts record registry observations and archive
  digests. The Go and tag receipts record module/tag and inventory evidence;
  they do not add a GitHub Go archive or a universal package signature.

For Go, inspect the module through the Go tool or the `go-proof.json` receipt:

```bash
GOPROXY=https://proxy.golang.org \
  go list -m -json github.com/elsoul/erpc-sdk/packages/go@v0.11.0
```

The observed proxy and direct records have the same Go `h1` module sum and the
same 77-file inventory, while their ZIP SHA-256 values differ (`5b61…d14d7`
through the proxy and `13fb…0fa29b` directly). That difference is expected for
separately served ZIP bytes. Never compare a Go `h1:` sum to a raw SHA-256, and
do not require the proxy and direct ZIP bytes to match.

The release manifest and receipts also contain workflow, observer, and
publisher source fields. The non-Rust release identity is the `00343…` commit
above; the PyPI publisher and observer records use their own observed run
commits (`bb078…` and `3351…`). Preserve those distinctions instead of treating
one receipt field as a universal source or authenticity claim.

## Maintainer procedures and limits

[`docs/RELEASING.md`](RELEASING.md) contains maintainer procedures and some
historical candidate passages. It is not a consumer proof and should not be
used to infer the current public version when it conflicts with the current
README, release page, or proof assets. Release actions remain human-approved;
this guide does not publish, replace, yank, tag, or rebuild anything.

Broader SBOM coverage, all-language reproducible-build evidence, expanded
signing, and universal attestation are separate follow-up work. See the
[public compliance and evidence index](compliance/README.md) for dated limits
and open owners.
