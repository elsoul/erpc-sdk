# Canonical token catalog

This directory owns the bounded, source-backed token catalog consumed by the TypeScript, Rust, Python, Go, and Ruby SDKs. It is an offline data source. It does not make a complete-coverage, ranking, or top-N claim, and it does not call an RPC, require an API key, or bundle a third-party token database.

`token-catalog.json` is the canonical source. Its asset and deployment records retain `evidence` and `asOfDate` for source review. Generated SDK records contain the runtime fields below and omit per-record provenance; only the catalog-wide `asOfDate` and `contentDigest` are emitted as metadata.

## Runtime API

Each package exposes the same six practical lookup operations, with language-appropriate naming and value types:

1. `getTokenAsset(assetId)` returns an asset by its opaque ID.
2. `getTokenDeployment(deploymentId)` returns a deployment by its opaque ID.
3. `listTokenDeployments({ chainId, stableCurrency })` lists records with optional exact filters and every lifecycle status visible.
4. `findTokenDeploymentsBySymbol(chainId, symbol)` returns exact-case symbol matches ordered by deployment ID.
5. `findTokenDeploymentByAddress(chainId, address)` resolves EVM addresses case-insensitively and Solana addresses byte-for-byte.
6. `getNativeTokenDeployment(chainId)` returns the native deployment whose address is `null`.

Alias constants are grouped under the fixed namespaces `ethereum`, `solana`, and `avalancheC`. Alias names are uppercase ASCII so they remain portable across language emitters. `assetId` and `deploymentId` are opaque strings; callers must not infer a chain, issuer, or symbol from their spelling.

Every deployment includes `assetId`, `deploymentId`, `name`, `representationKind`, `stableCurrency`, `underlyingAssetId`, `economicReferenceAssetId`, `chainId`, `symbol`, `decimals`, `standard`, `address`, `status`, and `replacedByDeploymentId`. Native ETH, AVAX, and SOL use `address: null`. EVM addresses are stored lowercase. The classic WSOL mint and the Token-2022 WSOL mint are distinct deployments.

## Generate and check

The generator imports the canonical model and writes one hardcoded package data file per invocation. It refuses unknown options, `--output`, `--language all` in write mode, and a missing target parent. A package owner may create a missing directory inside that package before invoking the generator. If the bytes are already current, the generator leaves the file untouched.

```sh
# Write exactly one package output.
node registry/generate-token-catalog.mjs --language typescript

# Compare one output without writing.
node registry/generate-token-catalog.mjs --check --language rust

# Compare every output without writing.
node registry/generate-token-catalog.mjs --check --language all

# Validate that the current catalog preserves an older snapshot's history.
node registry/generate-token-catalog.mjs \
  --check --language all --previous /path/to/previous-token-catalog.json
```

`--previous` rejects deletion of a historical asset ID, deletion or rebinding of a historical deployment ID, and deletion or retargeting of a historical alias. Asset metadata may be corrected while its asset ID remains present. A deployment binding is the tuple `assetId + chainId + standard + normalized address`; an address migration receives a new deployment ID while the old record remains available for history.

The generated paths are fixed by the model:

| Language | Output |
| --- | --- |
| TypeScript | `packages/typescript/src/generated/token_catalog.ts` |
| Rust | `packages/rust/src/generated/token_catalog.rs` |
| Python | `packages/python/src/erpc_sdk/_token_catalog_data.py` |
| Go | `packages/go/token_catalog_generated.go` |
| Ruby | `packages/ruby/lib/erpc_sdk/generated/token_catalog.rb` |

## Native parity

Renderer byte equality checks that one source renderer produced the expected text. The recorded cross-language catalog gate has a passing native capture: all five compiled packages supplied 39 assets, 60 deployments, 60 aliases, 338 public-API query rows, and 60 compiled alias-constant checks per language. Steiner and Cyan both recorded PASS for this bounded catalog on 2026-09-15. The dated commands, artifact hashes, and snapshot hashes are in [`evidence/token-catalog-2026-09-15.json`](./evidence/token-catalog-2026-09-15.json) and `/private/tmp/erpc-token-native-snapshots/PROVENANCE.md`.

The verifier requires an explicit snapshot envelope containing all five languages. Each language snapshot includes:

```json
{
  "snapshotVersion": 1,
  "snapshotKind": "native-runtime",
  "language": "typescript",
  "runtime": "typescript-package-test-run",
  "metadata": {
    "version": "1.0.0",
    "asOfDate": "2026-09-15",
    "contentDigest": "<64 lowercase hex characters>",
    "chainIds": {
      "ethereum": "eip155:1",
      "solana": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "avalancheC": "eip155:43114"
    }
  },
  "assets": [],
  "deployments": [],
  "aliases": [],
  "behavior": {
    "lookupAsset": [],
    "lookupDeployment": [],
    "nativeDeployment": [],
    "symbol": [],
    "address": [],
    "alias": [],
    "list": []
  }
}
```

The arrays use the runtime field names above. Behavior probes report IDs or ordered ID lists for asset/deployment lookup, native lookup, symbol lookup, address lookup, alias lookup, and filtered listing. The verifier sorts records by opaque IDs and compares all records, aliases, metadata, and probes. The `runtime` value describes the capture; it is not proof that a process ran, so callers must provide honest outputs from executed package code.

```sh
node registry/verify-token-parity.mjs \
  --snapshots /path/to/native-runtime-parity.json --json
```

With no explicit snapshot input the verifier fails. This keeps the central check from silently falling back to renderer output. The `runtime` marker in a snapshot is descriptive metadata and cannot prove execution by itself; the capture commands and artifact hashes must be retained with the review evidence. The central verifier deliberately does not install toolchains or access a network.

## Manual maintenance

When adding or correcting a fact:

1. Confirm the issuer or primary project source and add the URL to the record and [`SOURCES.md`](./SOURCES.md).
2. Record the manual date and any RPC block or Solana slot in [`evidence/token-catalog-2026-09-15.json`](./evidence/token-catalog-2026-09-15.json). Receipts stay in evidence and do not enter runtime records or the digest.
3. Preserve existing IDs, bindings, and aliases. Use a new deployment ID for a changed address.
4. Keep the current canonical file valid while editing a candidate. Copy it to a temporary file, edit only the candidate, then validate and digest that candidate before replacing the canonical file:

   ```sh
   cp registry/token-catalog.json /tmp/token-catalog-candidate.json
   # edit /tmp/token-catalog-candidate.json and add source evidence
   node --input-type=module -e '
   import fs from "node:fs";
   import { computeDigest, validateCatalog, compareHistory } from "./registry/token-catalog.mjs";
   const candidate = JSON.parse(fs.readFileSync("/tmp/token-catalog-candidate.json", "utf8"));
   const current = JSON.parse(fs.readFileSync("./registry/token-catalog.json", "utf8"));
   candidate.contentDigest = computeDigest(candidate);
   validateCatalog(candidate);
   compareHistory(candidate, current);
   fs.writeFileSync("/tmp/token-catalog-candidate.json", JSON.stringify(candidate, null, 2) + "\n");
   console.log(candidate.contentDigest);
   '
   diff -u registry/token-catalog.json /tmp/token-catalog-candidate.json
   # after review, replace the canonical file and generate/check each package
   ```

   The candidate workflow matters because importing the model validates the current canonical JSON at module load. It also makes the immutable-history comparison explicit before the replacement.
5. Run `node registry/token-catalog.test.mjs`, the package tests, and the explicit native parity verifier.
6. Keep the previous catalog snapshot and run `--previous` before handing the change to the independent gates.

The common fixture in [`fixtures/token-catalog-cases.json`](./fixtures/token-catalog-cases.json) covers code generation, behavior, history, and invalid mutations. It includes literal escaping cases for quotes, backslashes, Unicode, backticks, `${...}`, and Ruby `#{...}` markers. The emitters treat those values as data.

## Evidence and gaps

The evidence packet records the 60 vetted deployment facts as source text, 17 detailed root receipts, 57 independently checked contract or mint rows, three native units, network identities, methods, pinned block or slot observations, lifecycle notes, and source URLs. Evidence is a dated observation rather than a freshness guarantee.

Known lifecycle details include EURT retired, GYEN and ZUSD winding down by 2026-11-11, EURA winding down before 2027-03-01, and Monerium EURe v1 retained as legacy and still supported. Do not treat legacy as inactive, and do not naively aggregate the EURe v1/v2 balance lineage.

The packet leaves USDT.e and DAI.e Avalanche provenance, LFRAX/frxUSD migrations, EUROe exact deployment provenance, EURI issuer address provenance, JPYC Prepaid, Solana USDe, Avalanche PYUSD/RLUSD, and several additional stablecoins open. See [`SOURCES.md`](./SOURCES.md) and [`ROADMAP.md`](./ROADMAP.md). The bounded offline catalog, deterministic tooling, native parity, Steiner review, and Cyan review are recorded as passed on 2026-09-15. EU OSS classification remains undetermined.
