import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import cases from "./fixtures/public-compatibility-cases.json" with { type: "json" };
import baseTokenCatalog from "./token-catalog.json" with { type: "json" };
import baseDexCatalog from "./dex-catalog.json" with { type: "json" };
import baseRanking from "./token-rankings.json" with { type: "json" };
import { computeDigest as tokenDigest, renderLanguage as renderTokenLanguage } from "./token-catalog.mjs";
import { computeDigest as dexDigest } from "./dex-catalog.mjs";
import { renderLanguage as renderDexLanguage } from "./generate-dex-catalog.mjs";
import { replaceRubyLockVersion } from "./ruby-lockfile.mjs";
import { replayTokenRankings } from "./token-rankings.mjs";
import { OUTPUTS as RANKING_OUTPUTS, renderLanguage as renderRankingLanguage } from "./generate-token-rankings.mjs";
import { RELEASE_VERSION_PATHS, verifyPublicCompatibility, TOKEN_DATA_PATHS, DEX_DATA_PATHS } from "./verify-public-compatibility.mjs";

const RELEASE_PATHS = [
  "packages/typescript/package.json",
  "packages/rust/Cargo.toml",
  "packages/python/pyproject.toml",
  "packages/python/src/erpc_sdk/__init__.py",
  "packages/ruby/lib/erpc_sdk/version.rb",
  "packages/ruby/Gemfile.lock",
  "Cargo.lock",
  "CHANGELOG.md",
];

const SYNTHETIC_BASE_VERSION = "1.0.0";
const SYNTHETIC_PATCH_VERSION = "1.0.1";

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeRootFile(root, pathValue, content) {
  const target = join(root, pathValue);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function jsonFile(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function replaceFixtureVersion(text, relativePath, version) {
  if (relativePath === "packages/ruby/Gemfile.lock") return replaceRubyLockVersion(text, version);
  if (relativePath === "Cargo.lock") {
    const blocks = text.split(/^\[\[package\]\]\s*$/mu);
    const matches = blocks.map((block, index) => ({ block, index })).filter(({ block }) => /^name\s*=\s*"erpc-sdk"\s*$/mu.test(block) && !/^source\s*=/mu.test(block));
    assert.equal(matches.length, 1, "Cargo.lock local erpc-sdk package must be unique");
    const index = matches[0].index;
    blocks[index] = blocks[index].replace(/(^version\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`);
    return blocks.join("[[package]]");
  }
  const patterns = {
    "packages/typescript/package.json": /(^\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/mu,
    "packages/rust/Cargo.toml": /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu,
    "packages/python/pyproject.toml": /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu,
    "packages/python/src/erpc_sdk/__init__.py": /(^__version__\s*=\s*")[^"]+("\s*$)/mu,
    "packages/ruby/lib/erpc_sdk/version.rb": /(^\s*VERSION\s*=\s*")[^"]+("\s*$)/mu,
  };
  const pattern = patterns[relativePath];
  if (!pattern) throw new Error(`unsupported fixture version path ${relativePath}`);
  assert.equal([...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length, 1, relativePath);
  return text.replace(pattern, `$1${version}$2`);
}

function initializeSyntheticReleaseBaseline(root) {
  for (const relativePath of RELEASE_PATHS.filter((pathValue) => pathValue !== "CHANGELOG.md")) {
    const source = readFileSync(join(root, relativePath), "utf8");
    const result = replaceFixtureVersion(source, relativePath, SYNTHETIC_BASE_VERSION);
    assert.equal(typeof result, "string", `${relativePath} must contain one anchored fixture version`);
    writeRootFile(root, relativePath, result);
  }
}

function renderSnapshotFiles(tokenCatalog, dexCatalog, ranking) {
  const files = {};
  for (const [language, pathValue] of Object.entries(requireTokenOutputs())) files[pathValue] = renderTokenLanguage(language, tokenCatalog);
  for (const [language, pathValue] of Object.entries(requireDexOutputs())) files[pathValue] = renderDexLanguage(language, dexCatalog, { tokenCatalog });
  for (const [language, pathValue] of Object.entries(RANKING_OUTPUTS)) files[pathValue] = renderRankingLanguage(language, ranking, { tokenCatalog });
  return files;
}

function requireTokenOutputs() {
  return Object.fromEntries(TOKEN_DATA_PATHS.filter((pathValue) => pathValue !== "registry/token-catalog.json").map((pathValue) => [pathValue.includes("typescript") ? "typescript" : pathValue.includes("rust") ? "rust" : pathValue.includes("python") ? "python" : pathValue.includes("ruby") ? "ruby" : "go", pathValue]));
}

function requireDexOutputs() {
  return Object.fromEntries(DEX_DATA_PATHS.filter((pathValue) => pathValue !== "registry/dex-catalog.json").map((pathValue) => [pathValue.includes("typescript") ? "typescript" : pathValue.includes("rust") ? "rust" : pathValue.includes("python") ? "python" : pathValue.includes("ruby") ? "ruby" : "go", pathValue]));
}

function makeSnapshot() {
  const root = mkdtempSync(join("/tmp", "erpc-compat-snapshot-"));
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  runGit(root, ["config", "user.name", "compatibility fixture"]);
  const token = structuredClone(baseTokenCatalog);
  const dex = structuredClone(baseDexCatalog);
  const rank = structuredClone(baseRanking);
  const generated = renderSnapshotFiles(token, dex, rank);
  writeRootFile(root, "registry/token-catalog.json", jsonFile(token));
  writeRootFile(root, "registry/dex-catalog.json", jsonFile(dex));
  writeRootFile(root, "registry/token-rankings.json", jsonFile(rank));
  for (const [pathValue, content] of Object.entries(generated)) writeRootFile(root, pathValue, content);
  for (const pathValue of RELEASE_PATHS) writeRootFile(root, pathValue, readFileSync(join(process.cwd(), pathValue), "utf8"));
  initializeSyntheticReleaseBaseline(root);
  writeRootFile(root, "packages/typescript/src/client.ts", readFileSync(join(process.cwd(), "packages/typescript/src/client.ts"), "utf8"));
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, token, dex, rank };
}

function growSnapshot(snapshot, { release = false, code = false } = {}) {
  const { root } = snapshot;
  const token = structuredClone(snapshot.token);
  const dex = structuredClone(snapshot.dex);
  const tokenAddress = "0x1111111111111111111111111111111111111111";
  const tokenId = "discovered-token-fixture-1111";
  token.assets.push({ assetId: tokenId, name: `Unclassified token at ${tokenAddress}`, representationKind: "unclassified", stableCurrency: null, underlyingAssetId: null, economicReferenceAssetId: null, evidence: ["https://ethereum-rpc.publicnode.com"], asOfDate: token.manualAsOf });
  token.deployments.push({ deploymentId: tokenId, assetId: tokenId, chainId: "eip155:1", symbol: tokenAddress, decimals: 18, standard: "erc20", address: tokenAddress, status: "active", replacedByDeploymentId: null, evidence: ["https://ethereum-rpc.publicnode.com"], asOfDate: token.manualAsOf });
  token.aliases.push({ namespace: "ethereum", name: "DISCOVERED_1111111111111111", deploymentId: tokenId });
  token.contentDigest = tokenDigest(token);
  const poolId = "discovered-pool-fixture-2222";
  dex.poolDefinitions.push({ poolDefinitionId: poolId, dexDeploymentId: "dex-deployment-0001", chainId: "eip155:1", address: "0x2222222222222222222222222222222222222222", token0DeploymentId: tokenId, token1DeploymentId: "deployment-0002", adapter: { kind: "evm-constant-product-v2", feeNumerator: "3", feeDenominator: "1000" }, status: "active", replacedByPoolDefinitionId: null, evidence: ["https://ethereum-rpc.publicnode.com"], asOfDate: dex.manualAsOf });
  dex.aliases.push({ namespace: "ethereum", name: "DISCOVERED_POOL_2222222222222222", dexDeploymentId: null, poolDefinitionId: poolId, evidence: ["https://ethereum-rpc.publicnode.com"], asOfDate: dex.manualAsOf });
  dex.contentDigest = dexDigest(dex);
  const rank = replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: token });
  writeRootFile(root, "registry/token-catalog.json", jsonFile(token));
  writeRootFile(root, "registry/dex-catalog.json", jsonFile(dex));
  writeRootFile(root, "registry/token-rankings.json", jsonFile(rank));
  for (const [pathValue, content] of Object.entries(renderSnapshotFiles(token, dex, rank))) writeRootFile(root, pathValue, content);
  if (code) writeRootFile(root, "packages/typescript/src/client.ts", `${readFileSync(join(root, "packages/typescript/src/client.ts"), "utf8")}\n// fixture shipping edit\n`);
  if (release) {
    const versions = {
      "packages/typescript/package.json": (text) => replaceFixtureVersion(text, "packages/typescript/package.json", SYNTHETIC_PATCH_VERSION),
      "packages/rust/Cargo.toml": (text) => replaceFixtureVersion(text, "packages/rust/Cargo.toml", SYNTHETIC_PATCH_VERSION),
      "packages/python/pyproject.toml": (text) => replaceFixtureVersion(text, "packages/python/pyproject.toml", SYNTHETIC_PATCH_VERSION),
      "packages/python/src/erpc_sdk/__init__.py": (text) => replaceFixtureVersion(text, "packages/python/src/erpc_sdk/__init__.py", SYNTHETIC_PATCH_VERSION),
      "packages/ruby/lib/erpc_sdk/version.rb": (text) => replaceFixtureVersion(text, "packages/ruby/lib/erpc_sdk/version.rb", SYNTHETIC_PATCH_VERSION),
    };
    for (const [pathValue, replace] of Object.entries(versions)) writeRootFile(root, pathValue, replace(readFileSync(join(root, pathValue), "utf8")));
    const lock = replaceFixtureVersion(readFileSync(join(root, "Cargo.lock"), "utf8"), "Cargo.lock", SYNTHETIC_PATCH_VERSION);
    writeRootFile(root, "Cargo.lock", lock);
    const rubyLock = replaceFixtureVersion(readFileSync(join(root, "packages/ruby/Gemfile.lock"), "utf8"), "packages/ruby/Gemfile.lock", SYNTHETIC_PATCH_VERSION);
    writeRootFile(root, "packages/ruby/Gemfile.lock", rubyLock);
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(/(##\s+Unreleased[\s\S]*?)(\n##\s+)/u, `$1\n## ${SYNTHETIC_PATCH_VERSION} — 2026-09-16\n\n- Fixture data patch$2`);
    writeRootFile(root, "CHANGELOG.md", changelog);
  }
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "head"]);
  return { ...snapshot, headSha: runGit(root, ["rev-parse", "HEAD"]), token, dex, rank };
}

function releaseOnlySnapshot(snapshot, { fromVersion = SYNTHETIC_BASE_VERSION, toVersion = SYNTHETIC_PATCH_VERSION } = {}) {
  const { root } = snapshot;
  const versions = {
    "packages/typescript/package.json": (text) => text.replace(new RegExp(`("version"\\s*:\\s*")${fromVersion.replaceAll(".", "\\.")}`, "u"), (_, prefix) => `${prefix}${toVersion}`),
    "packages/rust/Cargo.toml": (text) => text.replace(new RegExp(`(^version\\s*=\\s*")${fromVersion.replaceAll(".", "\\.")}`, "mu"), (_, prefix) => `${prefix}${toVersion}`),
    "packages/python/pyproject.toml": (text) => text.replace(new RegExp(`(^version\\s*=\\s*")${fromVersion.replaceAll(".", "\\.")}`, "mu"), (_, prefix) => `${prefix}${toVersion}`),
    "packages/python/src/erpc_sdk/__init__.py": (text) => text.replace(new RegExp(`(__version__\\s*=\\s*")${fromVersion.replaceAll(".", "\\.")}`, "u"), (_, prefix) => `${prefix}${toVersion}`),
    "packages/ruby/lib/erpc_sdk/version.rb": (text) => text.replace(new RegExp(`(VERSION\\s*=\\s*")${fromVersion.replaceAll(".", "\\.")}`, "u"), (_, prefix) => `${prefix}${toVersion}`),
  };
  for (const [pathValue, replace] of Object.entries(versions)) writeRootFile(root, pathValue, replace(readFileSync(join(root, pathValue), "utf8")));
  const lock = replaceFixtureVersion(readFileSync(join(root, "Cargo.lock"), "utf8"), "Cargo.lock", toVersion);
  writeRootFile(root, "Cargo.lock", lock);
  const rubyLock = replaceFixtureVersion(readFileSync(join(root, "packages/ruby/Gemfile.lock"), "utf8"), "packages/ruby/Gemfile.lock", toVersion);
  assert.equal(typeof rubyLock, "string", "packages/ruby/Gemfile.lock");
  writeRootFile(root, "packages/ruby/Gemfile.lock", rubyLock);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(/(##\s+Unreleased[\s\S]*?)(\n##\s+)/u, `$1\n## ${toVersion} — 2026-09-16\n\n- Fixture patch release$2`);
  writeRootFile(root, "CHANGELOG.md", changelog);
  runGit(root, ["add", "."]); runGit(root, ["commit", "--quiet", "-m", "release-only"]);
  return { ...snapshot, headSha: runGit(root, ["rev-parse", "HEAD"]) };
}

function destructiveDataSnapshot(snapshot) {
  const { root } = snapshot;
  const token = structuredClone(snapshot.token);
  token.assets[0].name = `${token.assets[0].name} (destructive fixture edit)`;
  token.contentDigest = tokenDigest(token);
  const dex = structuredClone(snapshot.dex);
  const rank = replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: token });
  writeRootFile(root, "registry/token-catalog.json", jsonFile(token));
  for (const [pathValue, content] of Object.entries(renderSnapshotFiles(token, dex, rank))) writeRootFile(root, pathValue, content);
  runGit(root, ["add", "."]); runGit(root, ["commit", "--quiet", "-m", "destructive-data"]);
  return { ...snapshot, headSha: runGit(root, ["rev-parse", "HEAD"]), token, dex, rank };
}

function shippingSourceSnapshot(snapshot) {
  const { root } = snapshot;
  writeRootFile(root, "packages/typescript/src/client.ts", `${readFileSync(join(root, "packages/typescript/src/client.ts"), "utf8")}\n// fixture shipping edit\n`);
  runGit(root, ["add", "."]); runGit(root, ["commit", "--quiet", "-m", "shipping-source"]);
  return { ...snapshot, headSha: runGit(root, ["rev-parse", "HEAD"]) };
}

function rankingSnapshot(snapshot, rank, message) {
  const { root } = snapshot;
  writeRootFile(root, "registry/token-rankings.json", jsonFile(rank));
  for (const [language, pathValue] of Object.entries(RANKING_OUTPUTS)) writeRootFile(root, pathValue, renderRankingLanguage(language, rank, { tokenCatalog: snapshot.token }));
  runGit(root, ["add", "."]); runGit(root, ["commit", "--quiet", "-m", message]);
  return { ...snapshot, headSha: runGit(root, ["rev-parse", "HEAD"]), rank };
}

test("compatibility fixtures distinguish data merge, feature release, and tag gates", () => {
  assert.equal(cases.fixtureKind, "public-compatibility-cases");
  assert.ok(cases.cases.some((entry) => entry.expect === "data-merge-eligible"));
  assert.ok(cases.cases.some((entry) => entry.expect === "manual-release-required"));
  assert.equal(cases.publishedBaseline.peelCommit, "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc");
  assert.equal(RELEASE_VERSION_PATHS.length, 8);
  assert.equal(RELEASE_PATHS.length, 8);
  assert.deepEqual(cases.releaseFiles.slice().sort(), RELEASE_VERSION_PATHS.slice().sort());
});

test("compatibility gate rejects malformed revision bindings before any scan", () => {
  assert.throws(() => verifyPublicCompatibility({ root: process.cwd(), baseSha: "a", headSha: "b" }), /40-character lowercase SHA/u);
});

test("compatibility report treats current feature history as manual release work", () => {
  const head = "50b56e0d4ec84fc5754d44bc4e887f5499f5fe1d";
  const report = verifyPublicCompatibility({ root: process.cwd(), baseSha: head, headSha: head });
  assert.equal(report.kind, "erpc-sdk-public-compatibility-report");
  assert.equal(report.dataMergeEligible, false);
  assert.equal(report.autoPatchReleaseEligible, false);
  assert.match(report.status, /MANUAL_RELEASE_REQUIRED/u);
});

test("controlled snapshot accepts additive token and pool growth with exact regenerated bytes", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot);
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: snapshot.baseSha, headSha: head.headSha });
    assert.equal(report.valid, true, JSON.stringify({ reasons: report.reasons, generated: report.generated, projections: report.publicProjections }));
    assert.equal(report.dataMergeEligible, true);
    assert.equal(report.dataCoreEligible, true, JSON.stringify({ reasons: report.reasons, releaseCheck: report.releaseCheck, classification: report.classification, changed: report.changedPaths, unexpected: report.publishedUnexpectedPaths }));
    assert.equal(report.autoPatchReleaseEligible, false);
    assert.equal(report.publicProjections.token.preserved, true);
    assert.equal(report.publicProjections.dex.preserved, true);
    assert.deepEqual(report.classification.nonGenerated, []);
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("controlled snapshot rejects shipping code and manifest edits while retaining a valid code report", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot, { code: true });
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: snapshot.baseSha, headSha: head.headSha });
    assert.equal(report.valid, true, JSON.stringify({ reasons: report.reasons, generated: report.generated, projections: report.publicProjections }));
    assert.equal(report.dataMergeEligible, false);
    assert.ok(report.classification.nonGenerated.includes("packages/typescript/src/client.ts"));
    assert.match(report.reasons.join("; "), /shipping\/API\/schema\/emitter/u);
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("controlled paired published baseline permits only the narrow eight-file patch release", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot, { release: true });
    runGit(snapshot.root, ["tag", "v1.0.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({
      root: snapshot.root,
      baseSha: snapshot.baseSha,
      headSha: head.headSha,
      releasedTag: "v1.0.0",
      releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: snapshot.baseSha, publisher: "fixture" },
    });
    assert.equal(report.dataMergeEligible, false);
    assert.equal(report.dataCoreEligible, true, JSON.stringify({ reasons: report.reasons, releaseCheck: report.releaseCheck, classification: report.classification, changed: report.changedPaths, unexpected: report.publishedUnexpectedPaths }));
    assert.equal(report.autoPatchReleaseEligible, true, JSON.stringify({ reasons: report.reasons, releaseCheck: report.releaseCheck, baseline: report.publishedBaseline, unexpected: report.publishedUnexpectedPaths }));
    assert.equal(report.releaseCheck.versionOnly, true);
    assert.equal(report.releaseCheck.cargoLockOnlySdkVersion, true);
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("unrelated Ruby dependency lockfile bytes block version-only patch eligibility", () => {
  const snapshot = makeSnapshot();
  try {
    const prepared = growSnapshot(snapshot, { release: true });
    const lockPath = join(snapshot.root, "packages/ruby/Gemfile.lock");
    const source = readFileSync(lockPath, "utf8");
    const changed = source.replace("minitest (5.27.0)", "minitest (5.27.1)");
    assert.notEqual(changed, source, "fixture must contain the unrelated Ruby dependency entry");
    writeFileSync(lockPath, changed);
    runGit(snapshot.root, ["add", "packages/ruby/Gemfile.lock"]);
    runGit(snapshot.root, ["commit", "--quiet", "-m", "unrelated Ruby dependency lock change"]);
    const finalHead = runGit(snapshot.root, ["rev-parse", "HEAD"]);
    runGit(snapshot.root, ["tag", "v1.0.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({
      root: snapshot.root,
      baseSha: snapshot.baseSha,
      headSha: finalHead,
      releasedTag: "v1.0.0",
      releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: snapshot.baseSha, publisher: "fixture" },
    });
    assert.equal(report.releaseCheck.versions.head["packages/ruby/Gemfile.lock"], SYNTHETIC_PATCH_VERSION);
    assert.equal(report.releaseCheck.sameHeadVersion, true);
    assert.equal(report.releaseCheck.versionOnlyPaths["packages/ruby/Gemfile.lock"], false);
    assert.equal(report.releaseCheck.versionOnly, false);
    assert.equal(report.autoPatchReleaseEligible, false);
    assert.match(report.reasons.join("; "), /narrow eight-file patch\/version rule/u);
    void prepared;
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("release-only preparation after a merged data commit uses the published paired baseline", () => {
  const snapshot = makeSnapshot();
  try {
    const dataHead = growSnapshot(snapshot);
    const releaseHead = releaseOnlySnapshot(dataHead);
    runGit(snapshot.root, ["tag", "v1.0.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({
      root: snapshot.root,
      baseSha: dataHead.headSha,
      headSha: releaseHead.headSha,
      releasedTag: "v1.0.0",
      releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: snapshot.baseSha, publisher: "fixture" },
    });
    assert.equal(report.dataMergeEligible, false);
    assert.equal(report.autoPatchReleaseEligible, true, JSON.stringify({ reasons: report.reasons, releaseCheck: report.releaseCheck, published: report.publishedPublicProjections }));
    assert.equal(report.publishedHistoryPreserved, true);
    assert.equal(report.releaseCheck.versionOnly, true);
    assert.deepEqual(report.releaseCheck.changed.sort(), RELEASE_PATHS.slice().sort());
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("published ranking membership survives a value and ordering refresh before patch release", () => {
  const snapshot = makeSnapshot();
  try {
    const baselineRank = replayTokenRankings({ candidates: [
      { chainId: "eip155:1", deploymentId: "deployment-0008", valueNumerator: "3", valueDenominator: "1", observedAt: "2026-09-15T12:00:00Z", sourceId: "fixture" },
      { chainId: "eip155:1", deploymentId: "deployment-0002", valueNumerator: "2", valueDenominator: "1", observedAt: "2026-09-15T12:00:00Z", sourceId: "fixture" },
    ] }, { tokenCatalog: snapshot.token });
    const published = rankingSnapshot(snapshot, baselineRank, "published ranking baseline");
    const refreshedRank = replayTokenRankings({ candidates: [
      { chainId: "eip155:1", deploymentId: "deployment-0008", valueNumerator: "1", valueDenominator: "1", observedAt: "2026-09-16T12:00:00Z", sourceId: "fixture" },
      { chainId: "eip155:1", deploymentId: "deployment-0002", valueNumerator: "9", valueDenominator: "1", observedAt: "2026-09-16T12:00:00Z", sourceId: "fixture" },
    ] }, { tokenCatalog: snapshot.token });
    const refreshed = rankingSnapshot(published, refreshedRank, "ranking value refresh");
    const release = releaseOnlySnapshot(refreshed);
    runGit(snapshot.root, ["tag", "v1.0.0", published.headSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", published.headSha]);
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: refreshed.headSha, headSha: release.headSha, releasedTag: "v1.0.0", releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: published.headSha, publisher: "fixture" } });
    assert.equal(report.publishedHistoryPreserved, true, JSON.stringify({ reasons: report.reasons, projections: report.publishedPublicProjections }));
    assert.equal(report.autoPatchReleaseEligible, true, JSON.stringify({ reasons: report.reasons, releaseCheck: report.releaseCheck }));
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("a retagged default v0.6.0 commit cannot inherit the pinned published baseline proof", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot);
    runGit(snapshot.root, ["tag", "v0.6.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v0.6.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: snapshot.baseSha, headSha: head.headSha, releasedTag: "v0.6.0" });
    assert.equal(report.publishedBaseline.verified, false);
    assert.match(report.reasons.join("; "), /paired published baseline|pinned/u);
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("destructive catalog or shipping source history since publication blocks automatic patch release", () => {
  const destructive = makeSnapshot();
  try {
    const dataHead = growSnapshot(destructive);
    const destructiveHead = destructiveDataSnapshot(dataHead);
    const releaseHead = releaseOnlySnapshot(destructiveHead);
    runGit(destructive.root, ["tag", "v1.0.0", destructive.baseSha]);
    runGit(destructive.root, ["tag", "packages/go/v1.0.0", destructive.baseSha]);
    const dataReport = verifyPublicCompatibility({ root: destructive.root, baseSha: dataHead.headSha, headSha: releaseHead.headSha, releasedTag: "v1.0.0", releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: destructive.baseSha, publisher: "fixture" } });
    assert.equal(dataReport.autoPatchReleaseEligible, false);
    assert.match(dataReport.reasons.join("; "), /public projections|manual|narrow/u);
  } finally { rmSync(destructive.root, { recursive: true, force: true }); }

  const source = makeSnapshot();
  try {
    const dataHead = growSnapshot(source);
    const sourceHead = shippingSourceSnapshot(dataHead);
    const releaseHead = releaseOnlySnapshot(sourceHead);
    runGit(source.root, ["tag", "v1.0.0", source.baseSha]);
    runGit(source.root, ["tag", "packages/go/v1.0.0", source.baseSha]);
    const report = verifyPublicCompatibility({ root: source.root, baseSha: sourceHead.headSha, headSha: releaseHead.headSha, releasedTag: "v1.0.0", releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: source.baseSha, publisher: "fixture" } });
    assert.equal(report.autoPatchReleaseEligible, false);
    assert.ok(report.publishedUnexpectedPaths.includes("packages/typescript/src/client.ts"));
  } finally { rmSync(source.root, { recursive: true, force: true }); }
});

test("paired tags without verified publisher evidence cannot authorize automatic patch release", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot, { release: true });
    runGit(snapshot.root, ["tag", "v1.0.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: snapshot.baseSha, headSha: head.headSha, releasedTag: "v1.0.0" });
    assert.equal(report.autoPatchReleaseEligible, false);
    assert.match(report.reasons.join("; "), /verified paired published baseline/u);
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});

test("a release manifest edit outside its anchored version span blocks automatic patch eligibility", () => {
  const snapshot = makeSnapshot();
  try {
    const head = growSnapshot(snapshot, { release: true });
    const packagePath = join(snapshot.root, "packages/typescript/package.json");
    writeFileSync(packagePath, `${readFileSync(packagePath, "utf8")}\n// manifest fixture edit\n`);
    runGit(snapshot.root, ["add", "."]);
    runGit(snapshot.root, ["commit", "--quiet", "-m", "manifest-edit"]);
    const finalHead = runGit(snapshot.root, ["rev-parse", "HEAD"]);
    runGit(snapshot.root, ["tag", "v1.0.0", snapshot.baseSha]);
    runGit(snapshot.root, ["tag", "packages/go/v1.0.0", snapshot.baseSha]);
    const report = verifyPublicCompatibility({ root: snapshot.root, baseSha: snapshot.baseSha, headSha: finalHead, releasedTag: "v1.0.0", releaseEvidence: { verified: true, rootTag: "v1.0.0", goTag: "packages/go/v1.0.0", peelCommit: snapshot.baseSha, publisher: "fixture" } });
    assert.equal(report.autoPatchReleaseEligible, false);
    assert.equal(report.releaseCheck.versionOnly, false);
    assert.match(report.reasons.join("; "), /narrow eight-file patch\/version rule/u);
    void head;
  } finally { rmSync(snapshot.root, { recursive: true, force: true }); }
});
