#!/usr/bin/env node

/*
 * Offline release preparation.
 *
 * This module deliberately treats a release as a candidate tree operation. It
 * does not resolve dependencies, contact a registry, create tags, push a
 * branch, or publish anything. The writer used by the maintenance workflow
 * consumes the report produced here and performs its own source/head checks.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeDigest as computeDexDigest, validateCatalog as validateDexCatalog } from "./dex-catalog.mjs";
import { OUTPUTS as DEX_GENERATED_OUTPUTS } from "./generate-dex-catalog.mjs";
import { OUTPUTS as RANKING_GENERATED_OUTPUTS } from "./generate-token-rankings.mjs";
import { computeDigest, validateCatalog } from "./token-catalog.mjs";
import { computeDigest as computeRankingDigest, validateRankingArtifact } from "./token-rankings.mjs";
import { verifyPublicCompatibility } from "./verify-public-compatibility.mjs";
import { normalizeRubyLockVersion, replaceRubyLockVersion, rubyLockVersion } from "./ruby-lockfile.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");
export const BASELINE_VERSION = "0.6.0";
export const APPROVED_VERSION = "0.7.0";
export const APPROVED_SOURCE_SHA = "38e0d27d5dbc852ae7518d5d4e1d622abbcbbd36";
export const PAIRED_TAG_PEEL = "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc";
export const RELEASE_PLAN_RELATIVE_PATH = "registry/release-plan.json";
export const CHANGELOG_RELATIVE_PATH = "CHANGELOG.md";
export const RELEASE_BASELINE_TAGS = Object.freeze({ root: "v0.6.0", go: "packages/go/v0.6.0", peelCommit: PAIRED_TAG_PEEL });

export const APPROVED_NOTES = Object.freeze([
  "Initial reviewed 2026-09-16 local snapshot: Add an offline token catalog to all five SDKs, covering 44 assets and 65 deployments across Ethereum, Solana, and Avalanche C-Chain, including five address-only unclassified tokens.",
  "Add shared asset and deployment lookups, chain and currency filters, address and symbol searches, alias constants, and lifecycle metadata backed by deterministic generated data.",
  "Keep RPC-only, local exact-input quotes for the two reviewed seed EVM pairs: Ethereum Uniswap V2 WETH/USDC and Avalanche C-Chain LFJ Joe V1 WAVAX/USDC; newly discovered pools do not enable quote support.",
  "Initial reviewed 2026-09-16 local snapshot: Add a shared offline ranking snapshot with 11 rows and partial onchain-total-supply-value-native coverage, using total supply times direct native pool price rather than circulating market cap; add bounded RPC-only discovery with eight-token/eight-pool caps and fresh revalidation.",
  "Run daily maintenance PRs, hourly 32-pool rotation, and weekly guarded release preparation with opt-in exact-CI/protected-main gates; preserve Rust num-bigint 0.5.1 and rustls 0.23.45 as approved changes.",
]);

export const PACKAGE_VERSION_PATHS = Object.freeze([
  "packages/typescript/package.json",
  "packages/rust/Cargo.toml",
  "packages/python/pyproject.toml",
  "packages/python/src/erpc_sdk/__init__.py",
  "packages/ruby/lib/erpc_sdk/version.rb",
  "packages/ruby/Gemfile.lock",
  "Cargo.lock",
]);

export const CATALOG_RUNTIME_PATHS = Object.freeze([
  "registry/token-catalog.json",
  "packages/typescript/src/generated/token_catalog.ts",
  "packages/rust/src/generated/token_catalog.rs",
  "packages/python/src/erpc_sdk/_token_catalog_data.py",
  "packages/go/token_catalog_generated.go",
  "packages/ruby/lib/erpc_sdk/generated/token_catalog.rb",
]);

export const DEX_CATALOG_SOURCE_PATH = "registry/dex-catalog.json";
export const DEX_CATALOG_GENERATED_PATHS = Object.freeze(Object.values(DEX_GENERATED_OUTPUTS));
export const DEX_CATALOG_RUNTIME_PATHS = Object.freeze([
  DEX_CATALOG_SOURCE_PATH,
  ...DEX_CATALOG_GENERATED_PATHS,
]);
export const RANKING_CATALOG_SOURCE_PATH = "registry/token-rankings.json";
export const RANKING_CATALOG_GENERATED_PATHS = Object.freeze(Object.values(RANKING_GENERATED_OUTPUTS));
export const RANKING_CATALOG_RUNTIME_PATHS = Object.freeze([RANKING_CATALOG_SOURCE_PATH, ...RANKING_CATALOG_GENERATED_PATHS]);
const ALL_CATALOG_RUNTIME_PATHS = new Set([...CATALOG_RUNTIME_PATHS, ...DEX_CATALOG_RUNTIME_PATHS, ...RANKING_CATALOG_RUNTIME_PATHS]);

export const PREPARATION_OUTPUT_PATHS = Object.freeze([
  ...PACKAGE_VERSION_PATHS,
  CHANGELOG_RELATIVE_PATH,
]);

export const STATUS = Object.freeze({
  NO_RELEASE_CHANGE: "NO_RELEASE_CHANGE",
  PATCH_READY: "PATCH_READY",
  MANUAL_VERSION_REQUIRED: "MANUAL_VERSION_REQUIRED",
  PREPARED_UNPUBLISHED: "PREPARED_UNPUBLISHED",
  PREPARED: "PREPARED",
  BLOCKED_TAG_HISTORY: "BLOCKED_TAG_HISTORY",
  VERSION_DRIFT: "VERSION_DRIFT",
  STALE_HEAD: "STALE_HEAD",
  CHANGELOG_REQUIRED: "CHANGELOG_REQUIRED",
  INVALID_PLAN: "INVALID_PLAN",
  DIRTY_WORKTREE: "DIRTY_WORKTREE",
  INVALID_INPUT: "INVALID_INPUT",
});
export const STATUS_CODES = STATUS;

// Public data compatibility is a separate gate from version preparation.  It
// is re-exported here for release tooling that already depends on this module;
// preparation itself remains a read-only version/changelog operation.
export { verifyPublicCompatibility };

const TAG_PREFIXES = Object.freeze({ root: "v", go: "packages/go/v" });
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function fail(message, code = STATUS.INVALID_INPUT) {
  const error = new Error(message);
  error.code = code;
  error.name = "ReleasePreparationError";
  throw error;
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function semanticDigest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

export function parseStableVersion(value) {
  if (typeof value !== "string" || !STABLE_VERSION_RE.test(value)) {
    fail(`version must use stable X.Y.Z format without leading zeroes: ${value}`);
  }
  const [, major, minor, patch] = value.match(STABLE_VERSION_RE);
  return Object.freeze({ value, major: Number(major), minor: Number(minor), patch: Number(patch) });
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseStableVersion(left) : left;
  const b = typeof right === "string" ? parseStableVersion(right) : right;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function nextPatchVersion(value) {
  const parsed = typeof value === "string" ? parseStableVersion(value) : value;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function validSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase commit SHA`);
  return value;
}

export function validDate(value, label = "release date") {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail(`${label} must be a real calendar date`);
  return value;
}

function repositoryPath(root, candidate, label = "path", { allowMissing = true } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\\") || candidate.includes("\0")) {
    fail(`${label} must be a repository-relative path`);
  }
  if (isAbsolute(candidate)) fail(`${label} must be repository-relative`);
  const absolute = resolve(root, candidate);
  const prefix = `${resolve(root)}${sep}`;
  if (absolute !== resolve(root) && !absolute.startsWith(prefix)) fail(`${label} escapes the repository`);
  if (!allowMissing && !existsSync(absolute)) fail(`${label} does not exist: ${candidate}`);
  return absolute;
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: options.env,
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function invokeRunner(runner, command, args, options) {
  const result = runner(command, args, options);
  if (typeof result === "string") return { status: 0, stdout: result, stderr: "" };
  return {
    status: result?.status ?? result?.exitCode ?? 0,
    stdout: result?.stdout ?? result?.output ?? "",
    stderr: result?.stderr ?? "",
    error: result?.error,
  };
}

function runGit(root, args, runner = defaultRunner, { allowFailure = false } = {}) {
  const result = invokeRunner(runner, "git", args, { cwd: root });
  if (result.error && !allowFailure) fail(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) fail(`git ${args.join(" ")} failed: ${asText(result.stderr).trim() || `exit ${result.status}`}`);
  return result;
}

function gitText(root, args, runner, options = {}) {
  return asText(runGit(root, args, runner, options).stdout).trim();
}

function readText(root, relativePath, label = relativePath) {
  const target = repositoryPath(root, relativePath, label, { allowMissing: false });
  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function readJson(root, relativePath, label = relativePath) {
  let parsed;
  try {
    parsed = JSON.parse(readText(root, relativePath, label));
  } catch (error) {
    if (error.code === STATUS.INVALID_INPUT) throw error;
    fail(`cannot parse ${label} as JSON: ${error.message}`);
  }
  return parsed;
}

function planForRoot(root) {
  const target = repositoryPath(root, RELEASE_PLAN_RELATIVE_PATH, "release plan");
  if (!existsSync(target)) fail("registry/release-plan.json is required; approved version defaults are disabled", STATUS.INVALID_PLAN);
  const plan = readJson(root, RELEASE_PLAN_RELATIVE_PATH);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("release-plan.json must be an object", STATUS.INVALID_PLAN);
  if (plan.sourceSha !== APPROVED_SOURCE_SHA || plan.approvedSourceSha !== APPROVED_SOURCE_SHA || plan.baselineVersion !== BASELINE_VERSION || plan.targetVersion !== APPROVED_VERSION) {
    fail("release-plan.json provenance does not match the approved 0.7.0 plan", STATUS.INVALID_PLAN);
  }
  if ((plan.basisSha !== undefined && plan.basisSha !== APPROVED_SOURCE_SHA)
    || (plan.basisSHA !== undefined && plan.basisSHA !== APPROVED_SOURCE_SHA)
    || (plan.version !== undefined && plan.version !== APPROVED_VERSION)) {
    fail("release-plan.json basis/version does not match the approved 0.7.0 plan", STATUS.INVALID_PLAN);
  }
  if (!Array.isArray(plan.approvedNotes) || plan.approvedNotes.length !== APPROVED_NOTES.length || plan.approvedNotes.some((note, index) => note !== APPROVED_NOTES[index])) {
    fail("release-plan.json approved notes do not match the approved 0.7.0 plan", STATUS.INVALID_PLAN);
  }
  if (plan.notes !== undefined && (JSON.stringify(plan.notes) !== JSON.stringify(plan.approvedNotes))) fail("release-plan.json notes do not match approved notes", STATUS.INVALID_PLAN);
  if (!plan.packageChangeProvenanceGuard || plan.packageChangeProvenanceGuard.unexpectedPackageCodeChangesInvalidatePlan !== true) {
    fail("release-plan.json is missing its package-change provenance guard", STATUS.INVALID_PLAN);
  }
  if (JSON.stringify(plan.catalogRuntimePaths) !== JSON.stringify(CATALOG_RUNTIME_PATHS)) fail("release-plan.json token catalog runtime paths do not match the approved paths", STATUS.INVALID_PLAN);
  if (JSON.stringify(plan.dexCatalogRuntimePaths) !== JSON.stringify(DEX_CATALOG_RUNTIME_PATHS)) fail("release-plan.json DEX catalog runtime paths do not match the approved paths", STATUS.INVALID_PLAN);
  if (JSON.stringify(plan.rankingCatalogRuntimePaths) !== JSON.stringify(RANKING_CATALOG_RUNTIME_PATHS)) fail("release-plan.json ranking catalog runtime paths do not match the approved paths", STATUS.INVALID_PLAN);
  return plan;
}

export const loadReleasePlan = (root = REPOSITORY_ROOT) => planForRoot(resolve(root));

function getHead(root, runner) {
  return validSha(gitText(root, ["rev-parse", "HEAD"], runner), "HEAD");
}

function isClean(root, runner) {
  return gitText(root, ["status", "--porcelain", "--untracked-files=all"], runner, { allowFailure: false }) === "";
}

function listChangedPaths(root, expectedHead, runner) {
  const result = runGit(root, ["diff", "--name-only", expectedHead, "--"], runner, { allowFailure: true });
  if (result.status !== 0) fail(`git diff --name-only failed: ${asText(result.stderr).trim() || `exit ${result.status}`}`, STATUS.INVALID_INPUT);
  const names = asText(result.stdout).split(/\r?\n/u).filter(Boolean);
  const status = runGit(root, ["status", "--porcelain", "--untracked-files=all"], runner, { allowFailure: true });
  if (status.status !== 0) fail(`git status failed: ${asText(status.stderr).trim() || `exit ${status.status}`}`, STATUS.INVALID_INPUT);
  for (const line of asText(status.stdout).split(/\r?\n/u).filter(Boolean)) {
    const candidate = line.slice(3).trim();
    if (candidate && !names.includes(candidate)) names.push(candidate);
  }
  return names.sort();
}

function listChangedBetween(root, from, to, runner) {
  const result = runGit(root, ["diff", "--name-only", `${from}`, `${to}`, "--"], runner, { allowFailure: true });
  if (result.status !== 0) fail(`git diff --name-only failed: ${asText(result.stderr).trim() || `exit ${result.status}`}`, STATUS.INVALID_INPUT);
  return asText(result.stdout).split(/\r?\n/u).filter(Boolean).sort();
}

function isShippingPackageCode(relativePath) {
  if (!relativePath.startsWith("packages/")) return false;
  if (ALL_CATALOG_RUNTIME_PATHS.has(relativePath)) return false;
  if (relativePath.endsWith("/README.md") || relativePath.includes("/docs/")) return false;
  if (relativePath.includes("/test/") || relativePath.includes("/tests/")) return false;
  return true;
}

function gitFile(root, commitSha, relativePath, runner) {
  const result = runGit(root, ["show", `${commitSha}:${relativePath}`], runner, { allowFailure: true });
  return result.status === 0 ? asText(result.stdout) : null;
}

function gitHistoricalFile(root, commitSha, relativePath, runner) {
  const listing = runGit(root, ["ls-tree", "--name-only", commitSha, "--", relativePath], runner, { allowFailure: true });
  if (listing.status !== 0) fail(`cannot inspect historical ${relativePath} at ${commitSha}`, STATUS.INVALID_INPUT);
  const paths = asText(listing.stdout).split(/\r?\n/u).filter(Boolean);
  if (!paths.includes(relativePath)) return { present: false, source: null };
  const result = runGit(root, ["show", `${commitSha}:${relativePath}`], runner, { allowFailure: true });
  if (result.status !== 0) fail(`cannot read historical ${relativePath} at ${commitSha}`, STATUS.INVALID_INPUT);
  return { present: true, source: asText(result.stdout) };
}

function parseTokenCatalogSource(source, label) {
  try {
    const catalog = JSON.parse(source);
    validateCatalog(catalog);
    return catalog;
  } catch (error) {
    fail(`${label} failed validation: ${error.message}`, STATUS.INVALID_INPUT);
  }
}

function tokenCatalogAtCommit(root, commitSha, runner) {
  const historical = gitHistoricalFile(root, commitSha, "registry/token-catalog.json", runner);
  if (!historical.present) fail(`token catalog is unavailable at ${commitSha}`, STATUS.INVALID_INPUT);
  return parseTokenCatalogSource(historical.source, `token catalog at ${commitSha}`);
}

function catalogDigestAtCommit(root, commitSha, runner) {
  const historical = gitHistoricalFile(root, commitSha, "registry/token-catalog.json", runner);
  if (!historical.present) return null;
  return computeDigest(parseTokenCatalogSource(historical.source, `catalog at released commit ${commitSha}`));
}

function dexCatalogDigestAtCommit(root, commitSha, runner) {
  const historical = gitHistoricalFile(root, commitSha, DEX_CATALOG_SOURCE_PATH, runner);
  if (!historical.present) return null;
  try {
    const catalog = JSON.parse(historical.source);
    validateDexCatalog(catalog, { tokenCatalog: tokenCatalogAtCommit(root, commitSha, runner) });
    return computeDexDigest(catalog);
  } catch (error) {
    fail(`DEX catalog at released commit ${commitSha} failed validation: ${error.message}`, STATUS.INVALID_INPUT);
  }
}

function runtimeEffects(root, baselineSha, expectedHead, actualHead, currentCatalog, changedPaths, runner) {
  const baselineCatalogDigest = catalogDigestAtCommit(root, baselineSha, runner);
  const catalogDigestChanged = baselineCatalogDigest === null || baselineCatalogDigest !== currentCatalog.digest;
  const changedGeneratedPaths = [];
  for (const relativePath of CATALOG_RUNTIME_PATHS.slice(1)) {
    if (!changedPaths.includes(relativePath)) continue;
    const before = gitFile(root, baselineSha, relativePath, runner);
    const after = expectedHead === actualHead ? (() => {
      try { return readFileSync(repositoryPath(root, relativePath, "runtime output", { allowMissing: false }), "utf8"); } catch { return null; }
    })() : gitFile(root, expectedHead, relativePath, runner);
    if (before !== after) changedGeneratedPaths.push(relativePath);
  }
  return { baselineCatalogDigest, catalogDigestChanged, changedGeneratedPaths, changedRuntimePaths: [...(catalogDigestChanged && changedPaths.includes("registry/token-catalog.json") ? ["registry/token-catalog.json"] : []), ...changedGeneratedPaths] };
}

function dexRuntimeEffects(root, baselineSha, expectedHead, actualHead, currentCatalog, changedPaths, runner) {
  const baselineCatalogDigest = dexCatalogDigestAtCommit(root, baselineSha, runner);
  const catalogDigestChanged = baselineCatalogDigest === null || baselineCatalogDigest !== currentCatalog.digest;
  const changedGeneratedPaths = [];
  for (const relativePath of DEX_CATALOG_GENERATED_PATHS) {
    if (!changedPaths.includes(relativePath)) continue;
    const before = gitFile(root, baselineSha, relativePath, runner);
    const after = expectedHead === actualHead ? (() => {
      try { return readFileSync(repositoryPath(root, relativePath, "DEX runtime output", { allowMissing: false }), "utf8"); } catch { return null; }
    })() : gitFile(root, expectedHead, relativePath, runner);
    if (before !== after) changedGeneratedPaths.push(relativePath);
  }
  return {
    baselineCatalogDigest,
    baselineCatalogPresent: baselineCatalogDigest !== null,
    catalogDigestChanged,
    changedGeneratedPaths,
    changedRuntimePaths: [
      ...(catalogDigestChanged && changedPaths.includes(DEX_CATALOG_SOURCE_PATH) ? [DEX_CATALOG_SOURCE_PATH] : []),
      ...changedGeneratedPaths,
    ],
  };
}

function normalizeVersionSource(text, relativePath) {
  try {
    if (relativePath === "packages/typescript/package.json") {
      return replaceExactly(text, /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/mu, "$1<VERSION>$2", `${relativePath} version`);
    }
    if (relativePath === "packages/rust/Cargo.toml") {
      return replaceExactly(text, /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu, "$1<VERSION>$2", `${relativePath} version`);
    }
    if (relativePath === "packages/python/pyproject.toml") {
      return replaceExactly(text, /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu, "$1<VERSION>$2", `${relativePath} version`);
    }
    if (relativePath === "packages/python/src/erpc_sdk/__init__.py") {
      return replaceExactly(text, /(^__version__\s*=\s*")[^"]+("\s*$)/mu, "$1<VERSION>$2", `${relativePath} version`);
    }
    if (relativePath === "packages/ruby/lib/erpc_sdk/version.rb") {
      return replaceExactly(text, /(^\s*VERSION\s*=\s*")[^"]+("\s*$)/mu, "$1<VERSION>$2", `${relativePath} version`);
    }
    if (relativePath === "packages/ruby/Gemfile.lock") {
      return normalizeRubyLockVersion(text);
    }
    if (relativePath === "Cargo.lock") {
      return normalizeCargoLockVersion(text, "<VERSION>");
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeCargoLockVersion(text, replacementVersion) {
  const headings = [...text.matchAll(/^\[\[package\]\]\r?$/gmu)];
  const matches = [];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    if (/^name\s*=\s*"erpc-sdk"\s*$/mu.test(block) && !/^source\s*=/mu.test(block)) matches.push({ start, end, block });
  }
  if (matches.length !== 1) return null;
  const match = matches[0];
  const nextBlock = replaceExactly(match.block, /(^version\s*=\s*")[^"]+("\s*$)/mu, `$1${replacementVersion}$2`, "Cargo.lock erpc-sdk version");
  return text.slice(0, match.start) + nextBlock + text.slice(match.end);
}

function managedVersionOnlyChange(root, relativePath, fromSha, toSha, runner, { targetIsWorkingTree = false } = {}) {
  if (!PACKAGE_VERSION_PATHS.includes(relativePath)) return false;
  const before = gitFile(root, fromSha, relativePath, runner);
  const after = targetIsWorkingTree ? (() => {
    try { return readFileSync(repositoryPath(root, relativePath, "version source", { allowMissing: false }), "utf8"); } catch { return null; }
  })() : gitFile(root, toSha, relativePath, runner);
  if (before === null || after === null || before === after) return false;
  const normalizedBefore = normalizeVersionSource(before, relativePath);
  const normalizedAfter = normalizeVersionSource(after, relativePath);
  return normalizedBefore !== null && normalizedAfter !== null && normalizedBefore === normalizedAfter;
}

function classifyShippingPaths(root, changedPaths, fromSha, toSha, runner, { targetIsWorkingTree = false } = {}) {
  return changedPaths.filter((relativePath) => {
    if (ALL_CATALOG_RUNTIME_PATHS.has(relativePath)) return false;
    if (managedVersionOnlyChange(root, relativePath, fromSha, toSha, runner, { targetIsWorkingTree })) return false;
    if (relativePath === "Cargo.lock") return true;
    return isShippingPackageCode(relativePath);
  }).sort();
}

function isReleaseRelevantPath(relativePath) {
  return ALL_CATALOG_RUNTIME_PATHS.has(relativePath)
    || PACKAGE_VERSION_PATHS.includes(relativePath)
    || relativePath === CHANGELOG_RELATIVE_PATH
    || isShippingPackageCode(relativePath);
}

function planApplies(root, expectedHead, plan, runner) {
  if (expectedHead === plan.sourceSha) return { applies: true, changedPaths: [] };
  const ancestor = runGit(root, ["merge-base", "--is-ancestor", plan.sourceSha, expectedHead], runner, { allowFailure: true });
  if (ancestor.status !== 0) return { applies: false, changedPaths: [] };
  const changedPaths = listChangedBetween(root, plan.sourceSha, expectedHead, runner);
  const unexpected = classifyShippingPaths(root, changedPaths, plan.sourceSha, expectedHead, runner);
  return { applies: unexpected.length === 0, changedPaths, unexpectedPaths: unexpected };
}

function parseVersionFromText(file, relativePath) {
  if (relativePath === "packages/typescript/package.json") {
    let value;
    try { value = JSON.parse(file).version; } catch (error) { fail(`cannot parse ${relativePath}: ${error.message}`); }
    return typeof value === "string" ? value : null;
  }
  if (relativePath === "packages/rust/Cargo.toml") return file.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null;
  if (relativePath === "packages/python/pyproject.toml") return file.match(/^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null;
  if (relativePath === "packages/python/src/erpc_sdk/__init__.py") return file.match(/^__version__\s*=\s*"([^"]+)"$/mu)?.[1] ?? null;
  if (relativePath === "packages/ruby/lib/erpc_sdk/version.rb") return file.match(/^\s*VERSION\s*=\s*"([^"]+)"$/mu)?.[1] ?? null;
  if (relativePath === "packages/ruby/Gemfile.lock") return rubyLockVersion(file);
  return null;
}

function cargoLockVersion(file) {
  const blocks = file.split(/^\[\[package\]\]\s*$/mu).slice(1);
  const matches = blocks.filter((block) => /^name\s*=\s*"erpc-sdk"\s*$/mu.test(block));
  const sourceLess = matches.filter((block) => !/^source\s*=/mu.test(block));
  if (matches.length !== 1 || sourceLess.length !== 1) return { version: null, error: "Cargo.lock must contain exactly one source-less erpc-sdk package" };
  return { version: sourceLess[0].match(/^version\s*=\s*"([^"]+)"$/mu)?.[1] ?? null, error: null };
}

function readVersions(root) {
  const versions = {};
  const errors = [];
  for (const relativePath of PACKAGE_VERSION_PATHS) {
    if (relativePath === "Cargo.lock") continue;
    const value = parseVersionFromText(readText(root, relativePath), relativePath);
    versions[relativePath] = value;
    if (!value) errors.push(`${relativePath} has no uniquely anchored package version`);
  }
  const lock = cargoLockVersion(readText(root, "Cargo.lock"));
  versions["Cargo.lock"] = lock.version;
  if (lock.error || !lock.version) errors.push(lock.error || "Cargo.lock has no source-less erpc-sdk version");
  const unique = [...new Set(Object.values(versions).filter((value) => value !== null))];
  if (unique.length > 1) errors.push(`package versions differ: ${unique.join(", ")}`);
  return { versions, unique, errors };
}

function parseChangelog(text, version = null) {
  const heading = /^##\s+Unreleased\s*$/mu;
  const match = heading.exec(text);
  if (!match) return { hasUnreleased: false, body: "", substantive: false, hasVersion: false };
  const bodyStart = match.index + match[0].length;
  const next = /^##\s+/mu.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);
  const substantive = body.split(/\r?\n/u).some((line) => /^\s*[-*+]\s+\S/u.test(line) || /^\s*\d+[.)]\s+\S/u.test(line));
  const escaped = version?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return {
    hasUnreleased: true,
    body,
    substantive,
    hasVersion: version ? new RegExp(`^##\\s+${escaped}(?:\\s+—.*)?$`, "mu").test(text) : false,
    bodyStart,
    bodyEnd,
    nextHeadingIndex: next?.index ?? null,
  };
}

function tagName(prefix, version) {
  return `${prefix}${version}`;
}

function tagExists(root, tag, runner) {
  return runGit(root, ["rev-parse", "--verify", `refs/tags/${tag}`], runner, { allowFailure: true }).status === 0;
}

function tagPeel(root, tag, runner) {
  const result = runGit(root, ["rev-parse", "--verify", `${tag}^{commit}`], runner, { allowFailure: true });
  return result.status === 0 ? asText(result.stdout).trim() : null;
}

function tagHistory(root, expectedHead, runner) {
  const warnings = [];
  const problems = [];
  const versions = new Set();
  const validPaired = [];
  const refResult = runGit(root, ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"], runner, { allowFailure: true });
  if (refResult.status !== 0) fail(`git tag enumeration failed: ${asText(refResult.stderr).trim() || `exit ${refResult.status}`}`, STATUS.INVALID_INPUT);
  const refs = asText(refResult.stdout).trim();
  const listedRefs = new Set(refs.split(/\r?\n/u).filter(Boolean));
  for (const ref of refs.split(/\r?\n/u).filter(Boolean)) {
    const match = /^(?:v|packages\/go\/v)(\d+\.\d+\.\d+)$/u.exec(ref);
    if (match && STABLE_VERSION_RE.test(match[1])) versions.add(match[1]);
  }
  // A mocked runner may expose only rev-parse; always inspect the released
  // baseline even when for-each-ref returns no output. Candidate versions are
  // represented only when an actual tag exists, so absent 0.7.0 tags cannot
  // become a fictitious "latest" history entry.
  versions.add(BASELINE_VERSION);
  const baseline = parseStableVersion(BASELINE_VERSION);
  const pairs = [];
  for (const version of [...versions].sort(compareVersions)) {
    const rootTag = tagName(TAG_PREFIXES.root, version);
    const goTag = tagName(TAG_PREFIXES.go, version);
    const rootExists = tagExists(root, rootTag, runner);
    const goExists = tagExists(root, goTag, runner);
    const rootPeel = rootExists ? tagPeel(root, rootTag, runner) : null;
    const goPeel = goExists ? tagPeel(root, goTag, runner) : null;
    if (listedRefs.has(rootTag) && (!rootExists || rootPeel === null)) problems.push(`listed tag ${rootTag} could not be resolved`);
    if (listedRefs.has(goTag) && (!goExists || goPeel === null)) problems.push(`listed tag ${goTag} could not be resolved`);
    const pair = { version, rootTag, goTag, rootExists, goExists, rootPeel, goPeel, paired: rootExists && goExists && rootPeel === goPeel };
    pairs.push(pair);
    const parsed = parseStableVersion(version);
    if (parsed.major < baseline.major || (parsed.major === baseline.major && parsed.minor < baseline.minor) || compareVersions(version, BASELINE_VERSION) < 0) {
      if (rootExists && !goExists) warnings.push(`lower historical root-only tag ${rootTag}`);
      continue;
    }
    if (version === BASELINE_VERSION) {
      if (!rootExists || !goExists || rootPeel !== PAIRED_TAG_PEEL || goPeel !== PAIRED_TAG_PEEL) {
        problems.push(`baseline tags ${rootTag} and ${goTag} must both peel to ${PAIRED_TAG_PEEL}`);
      } else {
        const ancestor = runGit(root, ["merge-base", "--is-ancestor", PAIRED_TAG_PEEL, expectedHead], runner, { allowFailure: true });
        if (ancestor.status !== 0) problems.push(`baseline tag ${rootTag} is not an ancestor of expected head ${expectedHead}`);
        else validPaired.push({ ...pair, peelCommit: PAIRED_TAG_PEEL });
      }
      continue;
    }
    if ((rootExists || goExists) && (!rootExists || !goExists || rootPeel !== goPeel)) {
      problems.push(`higher tag pair ${rootTag}/${goTag} is missing or mismatched`);
    }
    if (rootExists && goExists && rootPeel === goPeel) {
      const ancestor = runGit(root, ["merge-base", "--is-ancestor", rootPeel, expectedHead], runner, { allowFailure: true });
      if (ancestor.status !== 0) problems.push(`higher tag pair ${rootTag}/${goTag} is off the expected-head history`);
      else validPaired.push({ ...pair, peelCommit: rootPeel });
    }
  }
  validPaired.sort((left, right) => compareVersions(left.version, right.version));
  const latestPaired = validPaired.at(-1) ?? null;
  return {
    pairs,
    warnings,
    problems,
    highestVersion: latestPaired?.version ?? null,
    latestPaired,
  };
}

export const inspectTagHistory = tagHistory;

function boundedCatalogDigest(root) {
  const target = repositoryPath(root, "registry/token-catalog.json", "canonical catalog", { allowMissing: false });
  const catalog = JSON.parse(readFileSync(target, "utf8"));
  validateCatalog(catalog);
  return {
    digest: computeDigest(catalog),
    catalogVersion: catalog.catalogVersion,
    asOfDate: catalog.manualAsOf,
    assetCount: catalog.assets.length,
    deploymentCount: catalog.deployments.length,
    aliasCount: catalog.aliases.length,
  };
}

function boundedDexCatalogDigest(root) {
  const target = repositoryPath(root, DEX_CATALOG_SOURCE_PATH, "canonical DEX catalog", { allowMissing: false });
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(target, "utf8"));
    const tokenTarget = repositoryPath(root, "registry/token-catalog.json", "canonical token catalog", { allowMissing: false });
    const referencedTokenCatalog = parseTokenCatalogSource(readFileSync(tokenTarget, "utf8"), "canonical token catalog");
    validateDexCatalog(catalog, { tokenCatalog: referencedTokenCatalog });
  } catch (error) {
    fail(`canonical DEX catalog failed validation: ${error.message}`, STATUS.INVALID_INPUT);
  }
  return {
    digest: computeDexDigest(catalog),
    catalogVersion: catalog.catalogVersion,
    asOfDate: catalog.manualAsOf,
    dexDeploymentCount: catalog.dexDeployments.length,
    poolDefinitionCount: catalog.poolDefinitions.length,
    nativeWrapDefinitionCount: catalog.nativeWrapDefinitions.length,
    aliasCount: catalog.aliases.length,
  };
}

function boundedRankingCatalogDigest(root) {
  const target = repositoryPath(root, RANKING_CATALOG_SOURCE_PATH, "canonical ranking catalog", { allowMissing: true });
  if (!existsSync(target)) return { present: false, digest: null, status: null, metric: null, recordCount: 0, unrankedCount: 0, sourceCount: 0 };
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(target, "utf8"));
    const tokenTarget = repositoryPath(root, "registry/token-catalog.json", "canonical token catalog", { allowMissing: false });
    const referencedTokenCatalog = parseTokenCatalogSource(readFileSync(tokenTarget, "utf8"), "canonical token catalog");
    validateRankingArtifact(artifact, { tokenCatalog: referencedTokenCatalog });
  } catch (error) {
    fail(`canonical ranking artifact failed validation: ${error.message}`, STATUS.INVALID_INPUT);
  }
  return {
    present: true,
    digest: computeRankingDigest(artifact),
    status: artifact.metadata.status,
    metric: artifact.metadata.metric,
    recordCount: artifact.records.length,
    unrankedCount: artifact.unranked.length,
    sourceCount: artifact.metadata.sourceIds.length,
  };
}

function rankingCatalogDigestAtCommit(root, commitSha, runner) {
  const historical = gitHistoricalFile(root, commitSha, RANKING_CATALOG_SOURCE_PATH, runner);
  if (!historical.present) return null;
  try {
    const artifact = JSON.parse(historical.source);
    const tokenCatalog = tokenCatalogAtCommit(root, commitSha, runner);
    validateRankingArtifact(artifact, { tokenCatalog });
    return computeRankingDigest(artifact);
  } catch (error) {
    fail(`ranking artifact at released commit ${commitSha} failed validation: ${error.message}`, STATUS.INVALID_INPUT);
  }
}

function rankingRuntimeEffects(root, baselineSha, expectedHead, actualHead, currentRanking, changedPaths, runner) {
  const baselineDigest = rankingCatalogDigestAtCommit(root, baselineSha, runner);
  const changed = currentRanking.present !== false && (baselineDigest === null || baselineDigest !== currentRanking.digest);
  const changedGeneratedPaths = [];
  for (const relativePath of RANKING_CATALOG_GENERATED_PATHS) {
    if (!changedPaths.includes(relativePath)) continue;
    const before = gitFile(root, baselineSha, relativePath, runner);
    const after = expectedHead === actualHead
      ? (() => {
        try { return readFileSync(repositoryPath(root, relativePath, "ranking runtime output", { allowMissing: false }), "utf8"); } catch { return null; }
      })()
      : gitFile(root, expectedHead, relativePath, runner);
    if (before !== after) changedGeneratedPaths.push(relativePath);
  }
  return {
    baselineCatalogDigest: baselineDigest,
    catalogDigestChanged: changed,
    changedGeneratedPaths,
    changedRuntimePaths: [
      ...(changed ? [RANKING_CATALOG_SOURCE_PATH] : []),
      ...changedGeneratedPaths,
    ],
  };
}

function statusReport(root, expectedHead, options, runner) {
  validSha(expectedHead, "--expected-head");
  const requestedVersion = options.version ?? undefined;
  const actualHead = getHead(root, runner);
  const stale = actualHead !== expectedHead;
  const clean = isClean(root, runner);
  const plan = planForRoot(root);
  const planState = planApplies(root, expectedHead, plan, runner);
  const workingChangedPaths = listChangedPaths(root, expectedHead, runner);
  // A scheduled run normally checks out a clean main commit. In that case
  // HEAD-relative diff is empty even though the source commit may contain the
  // approved catalog change. Use the source-to-expected history as the
  // release-change view; a dirty candidate keeps its working-tree paths.
  const changedPaths = workingChangedPaths.length > 0 ? workingChangedPaths : planState.changedPaths;
  const versions = readVersions(root);
  const currentVersion = versions.unique.length === 1 ? versions.unique[0] : null;
  if (currentVersion !== null) parseStableVersion(currentVersion);
  const changelogPath = options.changelogFile ?? CHANGELOG_RELATIVE_PATH;
  repositoryPath(root, changelogPath, "changelog file", { allowMissing: false });
  const changelog = parseChangelog(readText(root, changelogPath), requestedVersion ?? currentVersion ?? APPROVED_VERSION);
  const tags = tagHistory(root, expectedHead, runner);
  const releasedBaselinePaths = tags.problems.length === 0 && tags.latestPaired
    ? listChangedBetween(root, tags.latestPaired.peelCommit, expectedHead, runner)
    : [];
  const catalog = boundedCatalogDigest(root);
  const dexCatalog = boundedDexCatalogDigest(root);
  const rankingCatalog = boundedRankingCatalogDigest(root);
  const releaseViewPaths = workingChangedPaths.length > 0
    ? [...new Set([...releasedBaselinePaths, ...workingChangedPaths])].sort()
    : releasedBaselinePaths;
  const runtime = tags.latestPaired
    ? runtimeEffects(root, tags.latestPaired.peelCommit, expectedHead, actualHead, catalog, releaseViewPaths, runner)
    : { baselineCatalogDigest: null, catalogDigestChanged: true, changedGeneratedPaths: [], changedRuntimePaths: [] };
  const dexRuntime = tags.latestPaired
    ? dexRuntimeEffects(root, tags.latestPaired.peelCommit, expectedHead, actualHead, dexCatalog, releaseViewPaths, runner)
    : { baselineCatalogDigest: null, baselineCatalogPresent: false, catalogDigestChanged: true, changedGeneratedPaths: [], changedRuntimePaths: [] };
  const rankingRuntime = tags.latestPaired
    ? rankingRuntimeEffects(root, tags.latestPaired.peelCommit, expectedHead, actualHead, rankingCatalog, releaseViewPaths, runner)
    : { baselineCatalogDigest: null, catalogDigestChanged: true, changedGeneratedPaths: [], changedRuntimePaths: [] };
  const releaseSemanticPaths = [
    ...releaseViewPaths.filter((file) => !ALL_CATALOG_RUNTIME_PATHS.has(file)),
    ...runtime.changedRuntimePaths,
    ...dexRuntime.changedRuntimePaths,
    ...rankingRuntime.changedRuntimePaths,
  ];
  const relevantChangedPaths = releaseSemanticPaths.filter(isReleaseRelevantPath);
  const runtimeOnly = relevantChangedPaths.length > 0 && relevantChangedPaths.every((file) => ALL_CATALOG_RUNTIME_PATHS.has(file));
  const releaseRuntimeOnly = (runtime.changedRuntimePaths.length + dexRuntime.changedRuntimePaths.length + rankingRuntime.changedRuntimePaths.length) > 0
      && releaseSemanticPaths.filter(isReleaseRelevantPath).every((file) => ALL_CATALOG_RUNTIME_PATHS.has(file));
  const historyShippingChanges = planState.unexpectedPaths ?? [];
  const currentUnexpectedPackageChanges = classifyShippingPaths(root, workingChangedPaths, expectedHead, expectedHead, runner, { targetIsWorkingTree: true });
  const releasedShippingChanges = tags.latestPaired
    ? classifyShippingPaths(root, releasedBaselinePaths, tags.latestPaired.peelCommit, expectedHead, runner, { targetIsWorkingTree: expectedHead === actualHead })
    : [];
  const shippingChanges = [...new Set([...releasedShippingChanges, ...currentUnexpectedPackageChanges])].sort();
  const planCanSupplyVersion = planState.applies && currentUnexpectedPackageChanges.length === 0;
  const effectiveBaselineVersion = tags.latestPaired?.version ?? BASELINE_VERSION;
  const semanticReleaseChanged = releaseSemanticPaths.some(isReleaseRelevantPath);
  const selectedVersion = requestedVersion ?? (planCanSupplyVersion && compareVersions(plan.targetVersion, effectiveBaselineVersion) > 0
    ? plan.targetVersion
    : ((runtimeOnly || releaseRuntimeOnly) ? nextPatchVersion(effectiveBaselineVersion) : null));
  if (selectedVersion !== null) parseStableVersion(selectedVersion);

  let status = STATUS.NO_RELEASE_CHANGE;
  const reasons = [];
  if (stale) {
    status = STATUS.STALE_HEAD;
    reasons.push(`expected HEAD ${expectedHead} but found ${actualHead}`);
  } else if (tags.problems.length > 0) {
    status = STATUS.BLOCKED_TAG_HISTORY;
    reasons.push(...tags.problems);
  } else if (versions.errors.length > 0) {
    status = versions.errors.some((error) => error.includes("differ")) ? STATUS.VERSION_DRIFT : STATUS.INVALID_INPUT;
    reasons.push(...versions.errors);
  } else if (currentVersion !== null && compareVersions(currentVersion, effectiveBaselineVersion) < 0) {
    status = STATUS.VERSION_DRIFT;
    reasons.push(`current package version ${currentVersion} is lower than released baseline ${effectiveBaselineVersion}`);
  } else if (requestedVersion === undefined && !planCanSupplyVersion && (shippingChanges.length > 0 || currentUnexpectedPackageChanges.length > 0)) {
    status = STATUS.MANUAL_VERSION_REQUIRED;
    reasons.push("package code or manifest changes are outside the approved release plan; provide --version");
  } else if (requestedVersion !== undefined
    && compareVersions(requestedVersion, effectiveBaselineVersion) > 0
    && !changelog.hasVersion
    && changelog.hasUnreleased
    && changelog.substantive) {
    status = STATUS.PATCH_READY;
    reasons.push(`explicit manual version ${requestedVersion} has meaningful Unreleased notes and is ready for preparation`);
  } else if ((runtimeOnly || releaseRuntimeOnly)
    && (currentVersion === null || compareVersions(currentVersion, effectiveBaselineVersion) <= 0)) {
    status = STATUS.PATCH_READY;
    reasons.push(`catalog runtime changed after released ${effectiveBaselineVersion}; candidate ${selectedVersion ?? nextPatchVersion(effectiveBaselineVersion)} is available`);
  } else if (releaseViewPaths.length > 0 && !semanticReleaseChanged && currentVersion === effectiveBaselineVersion) {
    status = STATUS.NO_RELEASE_CHANGE;
    reasons.push("catalog evidence or documentation changed without a runtime catalog effect; no release candidate is required");
  } else if (currentVersion !== null && compareVersions(currentVersion, BASELINE_VERSION) > 0) {
    if (!changelog.hasVersion) {
      status = STATUS.CHANGELOG_REQUIRED;
      reasons.push(`changelog has no ${currentVersion} release section`);
    } else {
      const targetTags = tags.pairs.find((pair) => pair.version === currentVersion);
      status = targetTags?.paired ? STATUS.PREPARED : STATUS.PREPARED_UNPUBLISHED;
      reasons.push(targetTags?.paired ? "versioned files and changelog are prepared and both release tags exist" : "versioned files and changelog are prepared; paired release tags are absent");
    }
  } else if (releaseViewPaths.length === 0) {
    status = STATUS.NO_RELEASE_CHANGE;
    reasons.push("working tree has no changes from expected HEAD and packages remain at the released baseline");
  } else if (runtimeOnly) {
    status = STATUS.PATCH_READY;
    reasons.push("only canonical catalog/runtime generated files changed; an approved semver patch may be prepared");
  } else if (planCanSupplyVersion && releasedBaselinePaths.length > 0) {
    status = STATUS.PATCH_READY;
    reasons.push("released baseline differs through the approved catalog plan; a semver candidate may be prepared");
  } else if (selectedVersion === null && (shippingChanges.length > 0 || !planCanSupplyVersion)) {
    status = STATUS.MANUAL_VERSION_REQUIRED;
    reasons.push("package code changed outside the approved 0.7.0 plan; provide --version");
  } else if (!planCanSupplyVersion && shippingChanges.length === 0) {
    status = STATUS.MANUAL_VERSION_REQUIRED;
    reasons.push("approved release plan provenance does not cover this source history; provide --version");
  } else {
    status = STATUS.NO_RELEASE_CHANGE;
    reasons.push("no release version or catalog-only patch is present");
  }
  return {
    schemaVersion: 1,
    kind: "erpc-sdk-release-prep-report",
    mode: options.mode ?? "inspect",
    status,
    prepareAllowed: status === STATUS.PATCH_READY,
    expectedHead,
    actualHead,
    clean,
    baselineVersion: BASELINE_VERSION,
    selectedVersion,
    currentVersion,
    changedPaths,
    releasedBaselinePaths,
    runtime,
    dexRuntime,
    rankingRuntime,
    releaseSemanticPaths,
    runtimeOnly,
    releaseRuntimeOnly,
    releasedBaseline: tags.latestPaired ? { version: tags.latestPaired.version, peelCommit: tags.latestPaired.peelCommit } : null,
    shippingChanges,
    catalog,
    dexCatalog,
    rankingCatalog,
    ranking: rankingCatalog,
    plan: {
      id: plan.planId ?? "erpc-sdk-0.7.0-weekly-maintenance",
      sourceSha: plan.sourceSha,
      approvedSourceSha: plan.approvedSourceSha,
      catalogRuntimePaths: [...plan.catalogRuntimePaths],
      dexCatalogRuntimePaths: [...plan.dexCatalogRuntimePaths],
      rankingCatalogRuntimePaths: [...plan.rankingCatalogRuntimePaths],
      applies: planCanSupplyVersion,
      changedSinceSource: planState.changedPaths,
      unexpectedPackageChanges: [...new Set([...(planState.unexpectedPaths ?? []), ...currentUnexpectedPackageChanges])].sort(),
    },
    versions,
    changelog: {
      path: changelogPath,
      hasUnreleased: changelog.hasUnreleased,
      hasVersion: changelog.hasVersion,
      hasNotes: changelog.substantive,
    },
    tags,
    latestActualPairedTag: tags.latestPaired,
    reasons,
    contentFingerprint: semanticDigest({
      status,
      selectedVersion,
      currentVersion,
      semanticReleasePaths: releaseSemanticPaths,
      catalogDigest: catalog.digest,
      runtime: { catalogDigestChanged: runtime.catalogDigestChanged, changedGeneratedPaths: runtime.changedGeneratedPaths },
      dexCatalogDigest: dexCatalog.digest,
      dexRuntime: { catalogDigestChanged: dexRuntime.catalogDigestChanged, changedGeneratedPaths: dexRuntime.changedGeneratedPaths },
      rankingCatalogDigest: rankingCatalog.digest,
      rankingRuntime: { catalogDigestChanged: rankingRuntime.catalogDigestChanged, changedGeneratedPaths: rankingRuntime.changedGeneratedPaths },
      changelog: { hasVersion: changelog.hasVersion, hasNotes: changelog.substantive },
    }),
  };
}

function replaceExactly(text, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) fail(`${label} must have exactly one anchored replacement (found ${matches.length})`);
  // Let String.replace expand capture references ($1, $2, ...) while the
  // match count above keeps the operation anchored and unique.
  return text.replace(pattern, replacement);
}

function replacePackageVersion(root, relativePath, version) {
  const text = readText(root, relativePath);
  if (relativePath === "packages/typescript/package.json") {
    return replaceExactly(text, /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/mu, `$1${version}$2`, `${relativePath} version`);
  }
  if (relativePath === "packages/rust/Cargo.toml") {
    return replaceExactly(text, /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`, `${relativePath} version`);
  }
  if (relativePath === "packages/python/pyproject.toml") {
    return replaceExactly(text, /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`, `${relativePath} version`);
  }
  if (relativePath === "packages/python/src/erpc_sdk/__init__.py") {
    return replaceExactly(text, /(^__version__\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`, `${relativePath} version`);
  }
  if (relativePath === "packages/ruby/lib/erpc_sdk/version.rb") {
    return replaceExactly(text, /(^\s*VERSION\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`, `${relativePath} version`);
  }
  if (relativePath === "packages/ruby/Gemfile.lock") {
    const result = replaceRubyLockVersion(text, version);
    if (result === null) fail(`${relativePath} local erpc-sdk spec must be unique and valid`);
    return result;
  }
  if (relativePath === "Cargo.lock") {
    const result = normalizeCargoLockVersion(text, version);
    if (result === null) fail("Cargo.lock source-less erpc-sdk package must be unique");
    return result;
  }
  fail(`unsupported package version path ${relativePath}`);
}

function ensureTrailingNewline(text, original) {
  if (original.endsWith("\n") && !text.endsWith("\n")) return `${text}\n`;
  return text;
}

function changelogCandidate(root, relativePath, version, releaseDate, approvedNotes, { appendWhenSubstantive = false } = {}) {
  const original = readText(root, relativePath);
  const parsed = parseChangelog(original, version);
  if (!parsed.hasUnreleased) fail("CHANGELOG.md must contain an anchored ## Unreleased section", STATUS.CHANGELOG_REQUIRED);
  if (parsed.hasVersion) return original;
  const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
  const unreleasedBody = parsed.body;
  const existingNotes = unreleasedBody.replace(/^\s+$/gmu, "").replace(/^\s*$/mu, "").trimEnd();
  const approvedText = approvedNotes.map((note) => `- ${note}`).join(lineEnding);
  const notes = parsed.substantive
    ? appendWhenSubstantive ? `${existingNotes}${lineEnding}${approvedText}` : existingNotes
    : approvedText;
  const block = `${lineEnding}## ${version} — ${releaseDate}${lineEnding}${lineEnding}${notes.trimEnd()}${lineEnding}${lineEnding}`;
  const insertion = parsed.bodyStart + unreleasedBody.length;
  const result = original.slice(0, insertion) + block + original.slice(insertion);
  return ensureTrailingNewline(result, original);
}

function prepareWrites(root, version, releaseDate, changelogPath, plan) {
  const outputs = new Map();
  for (const relativePath of PACKAGE_VERSION_PATHS) {
    const original = readText(root, relativePath);
    const next = replacePackageVersion(root, relativePath, version);
    outputs.set(relativePath, ensureTrailingNewline(next, original));
  }
  const changelogOriginal = readText(root, changelogPath);
  outputs.set(changelogPath, changelogCandidate(root, changelogPath, version, releaseDate, plan.approvedNotes ?? APPROVED_NOTES, { appendWhenSubstantive: plan.appendNotes === true }));
  const changed = [...outputs.entries()].filter(([relativePath, text]) => text !== readText(root, relativePath));
  return { outputs, changed };
}

function assertOutputAllowlist(changedPaths, changelogPath) {
  const allowed = new Set([...PACKAGE_VERSION_PATHS, changelogPath]);
  for (const relativePath of changedPaths) {
    if (!allowed.has(relativePath)) fail(`planned preparation output is outside the allowlist: ${relativePath}`);
  }
}

function reportTarget(root, reportPath) {
  const target = repositoryPath(root, reportPath, "report path");
  const normalizedTarget = relative(root, target).split(sep).join("/");
  if (PREPARATION_OUTPUT_PATHS.includes(normalizedTarget) || normalizedTarget === RELEASE_PLAN_RELATIVE_PATH) fail("report path may not overwrite a managed release or plan file");
  // lstat (rather than existsSync) sees dangling symlinks. The writer must
  // reject every pre-existing directory entry before any candidate bytes are
  // written, otherwise a dangling link could redirect the report outside the
  // checkout when it is created.
  try {
    lstatSync(target);
    fail("report path already exists; refusing to overwrite an existing source or artifact");
  } catch (error) {
    if (error?.code !== "ENOENT" || error?.name !== "Error") throw error;
  }
  const parent = resolve(target, "..");
  if (!existsSync(parent) || !statSync(parent).isDirectory()) fail("report path parent must already exist");
  const realRoot = realpathSync(root);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) fail("report path parent escapes the repository");
  return { target, normalizedTarget };
}

function writeReport(root, reportPath, report) {
  const { target, normalizedTarget } = reportTarget(root, reportPath);
  // Exclusive creation adds a no-overwrite/no-follow guard for races between
  // lstat and write (O_EXCL rejects a symlink at the target path).
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return normalizedTarget;
}

export function inspectRelease(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const runner = options.runner ?? defaultRunner;
  const expectedHead = validSha(options.expectedHead ?? getHead(root, runner), "expected head");
  return statusReport(root, expectedHead, { ...options, mode: "inspect" }, runner);
}

export function prepareRelease(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const runner = options.runner ?? defaultRunner;
  const requestedChangelogPath = options.changelogFile ?? CHANGELOG_RELATIVE_PATH;
  if (requestedChangelogPath !== CHANGELOG_RELATIVE_PATH) fail(`preparation may write only ${CHANGELOG_RELATIVE_PATH}`, STATUS.INVALID_INPUT);
  if (options.report) reportTarget(root, options.report);
  const expectedHead = validSha(options.expectedHead ?? getHead(root, runner), "expected head");
  const before = statusReport(root, expectedHead, { ...options, mode: "prepare" }, runner);
  if (before.status === STATUS.STALE_HEAD) fail(before.reasons.join("; "), STATUS.STALE_HEAD);
  if (before.status === STATUS.BLOCKED_TAG_HISTORY) fail(before.reasons.join("; "), STATUS.BLOCKED_TAG_HISTORY);
  if (before.status === STATUS.VERSION_DRIFT) fail(before.reasons.join("; "), STATUS.VERSION_DRIFT);
  const explicitVersion = options.version ?? undefined;
  if (before.status === STATUS.NO_RELEASE_CHANGE && explicitVersion === undefined && before.selectedVersion === null) {
    const report = { ...before, mode: "prepare", writtenFiles: [], idempotent: true, releaseDate: null };
    if (options.report) report.reportPath = writeReport(root, options.report, report);
    return report;
  }
  if (!before.clean) {
    // A repeated invocation over the candidate produced by this tool is a
    // stable no-op. It may be dirty only in the exact managed output set and
    // must already contain the target version plus release section; unrelated
    // edits still fail the clean-worktree lease below.
    const repeatable = (before.status === STATUS.PREPARED_UNPUBLISHED || before.status === STATUS.PREPARED)
      && before.changedPaths.length > 0
      && before.changedPaths.every((file) => PREPARATION_OUTPUT_PATHS.includes(file));
    if (repeatable) return { ...before, mode: "prepare", writtenFiles: [], idempotent: true, releaseDate: options.releaseDate ?? null };
    fail("prepare requires a clean working tree", STATUS.DIRTY_WORKTREE);
  }
  const plan = planForRoot(root);
  const effectiveBaselineVersion = before.releasedBaseline?.version ?? BASELINE_VERSION;
  const version = explicitVersion ?? before.selectedVersion;
  if (version === null) {
    fail("manual stable --version is required because the approved release plan does not apply", STATUS.MANUAL_VERSION_REQUIRED);
  }
  parseStableVersion(version);
  if (compareVersions(version, effectiveBaselineVersion) <= 0) fail(`release version ${version} must be greater than baseline ${effectiveBaselineVersion}`, STATUS.MANUAL_VERSION_REQUIRED);
  const releaseDate = validDate(options.releaseDate ?? currentDate());
  const changelogPath = options.changelogFile ?? CHANGELOG_RELATIVE_PATH;
  if (changelogPath !== CHANGELOG_RELATIVE_PATH) fail(`preparation may write only ${CHANGELOG_RELATIVE_PATH}`, STATUS.INVALID_INPUT);
  repositoryPath(root, changelogPath, "changelog file", { allowMissing: false });
  const approvedPlanCandidate = before.plan.applies
    && version === plan.targetVersion
    && compareVersions(plan.targetVersion, effectiveBaselineVersion) > 0;
  const runtimePatchCandidate = before.runtimeOnly || before.releaseRuntimeOnly;
  if (!approvedPlanCandidate && !runtimePatchCandidate && !before.changelog.hasNotes) {
    fail("manual release preparation requires meaningful existing Unreleased notes", STATUS.CHANGELOG_REQUIRED);
  }
  const runtimeNotes = [];
  if (before.runtime.changedRuntimePaths.length > 0) {
    runtimeNotes.push(`Refresh the offline token catalog runtime data for catalog ${before.catalog.catalogVersion} (${before.catalog.digest}), covering ${before.catalog.assetCount} assets and ${before.catalog.deploymentCount} deployments across the five SDKs.`);
  }
  if (before.dexRuntime.changedRuntimePaths.length > 0) {
    runtimeNotes.push(`Refresh the offline DEX and pool catalog runtime data for catalog ${before.dexCatalog.catalogVersion} (${before.dexCatalog.digest}), covering ${before.dexCatalog.dexDeploymentCount} DEX deployments, ${before.dexCatalog.poolDefinitionCount} pools, and ${before.dexCatalog.nativeWrapDefinitionCount} native-wrap definitions across the five SDKs.`);
  }
  if (before.rankingRuntime.changedRuntimePaths.length > 0) {
    runtimeNotes.push(`Refresh the token ranking runtime data (${before.rankingCatalog.digest}), covering ${before.rankingCatalog.recordCount} ranked and ${before.rankingCatalog.unrankedCount} unranked deployment rows.`);
  }
  const notesForCandidate = approvedPlanCandidate ? (plan.approvedNotes ?? APPROVED_NOTES) : runtimePatchCandidate ? runtimeNotes : APPROVED_NOTES;
  const writes = prepareWrites(root, version, releaseDate, changelogPath, { ...plan, approvedNotes: notesForCandidate, appendNotes: runtimePatchCandidate });
  assertOutputAllowlist(writes.changed.map(([relativePath]) => relativePath), changelogPath);
  if (options.report) reportTarget(root, options.report);
  // A preparation is a compare-and-swap operation against the requested
  // source commit. Recheck both HEAD and cleanliness after all candidate
  // bytes have been computed, immediately before writing.
  const currentHead = getHead(root, runner);
  if (currentHead !== expectedHead) fail(`HEAD changed during preparation: expected ${expectedHead}, found ${currentHead}`, STATUS.STALE_HEAD);
  if (!isClean(root, runner)) fail("working tree changed during preparation", STATUS.DIRTY_WORKTREE);
  const writtenFiles = [];
  for (const [relativePath, text] of writes.changed) {
    writeFileSync(repositoryPath(root, relativePath, "preparation output"), text, "utf8");
    writtenFiles.push(relativePath);
  }
  const after = statusReport(root, expectedHead, { ...options, mode: "prepare", version, changelogFile: changelogPath }, runner);
  if (![STATUS.PREPARED_UNPUBLISHED, STATUS.PREPARED].includes(after.status)) {
    fail(`prepared candidate failed post-write validation: ${after.status}${after.reasons.length ? ` (${after.reasons.join("; ")})` : ""}`, after.status);
  }
  const report = {
    ...after,
    releaseDate,
    writtenFiles,
    planProvenance: {
      sourceSha: plan.sourceSha,
      targetVersion: plan.targetVersion,
      approvedNotes: [...(plan.approvedNotes ?? APPROVED_NOTES)],
      packageChangeProvenanceGuard: plan.packageChangeProvenanceGuard,
    },
  };
  if (options.report) report.reportPath = writeReport(root, options.report, report);
  return report;
}

export const inspect = inspectRelease;
export const prepare = prepareRelease;

export function parseArguments(argumentsList = process.argv.slice(2)) {
  const options = {
    mode: null,
    expectedHead: null,
    version: null,
    releaseDate: null,
    changelogFile: CHANGELOG_RELATIVE_PATH,
    report: null,
    format: "text",
    root: REPOSITORY_ROOT,
  };
  const args = [...argumentsList];
  const seen = new Set();
  if (args[0] === "--") args.shift();
  options.mode = args.shift() ?? null;
  if (options.mode === "--help" || options.mode === "help") return { ...options, mode: "help" };
  if (!(["inspect", "prepare"].includes(options.mode))) fail("usage: node registry/release-prep.mjs inspect|prepare --expected-head SHA [--version X.Y.Z] [--release-date YYYY-MM-DD] [--changelog-file PATH] [--report PATH] [--format=json]", STATUS.INVALID_INPUT);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === "--expected-head") { if (seen.has(argument) || next === undefined) fail("--expected-head requires one SHA"); seen.add(argument); options.expectedHead = next; index += 1; continue; }
    if (argument === "--version") { if (seen.has(argument) || next === undefined) fail("--version requires one stable version"); seen.add(argument); options.version = next; index += 1; continue; }
    if (argument === "--release-date") { if (seen.has(argument) || next === undefined) fail("--release-date requires one date"); seen.add(argument); options.releaseDate = next; index += 1; continue; }
    if (argument === "--changelog-file") { if (seen.has(argument) || next === undefined) fail("--changelog-file requires one path"); seen.add(argument); options.changelogFile = next; index += 1; continue; }
    if (argument === "--report") { if (seen.has(argument) || next === undefined) fail("--report requires one path"); seen.add(argument); options.report = next; index += 1; continue; }
    if (argument === "--format=json" || argument === "--json") { if (seen.has("--format")) fail("--format may be provided only once"); seen.add("--format"); options.format = "json"; continue; }
    if (argument === "--format") { if (seen.has(argument) || next !== "json") fail("--format accepts only json"); seen.add(argument); options.format = "json"; index += 1; continue; }
    if (argument === "--root") { if (seen.has(argument) || next === undefined) fail("--root requires one directory"); seen.add(argument); options.root = next; index += 1; continue; }
    fail(`unknown option ${argument}`);
  }
  if (options.expectedHead === null) fail("--expected-head is required");
  validSha(options.expectedHead, "--expected-head");
  if (options.version !== null) parseStableVersion(options.version);
  if (options.releaseDate !== null) validDate(options.releaseDate);
  return options;
}

export function usage() {
  return "Usage: node registry/release-prep.mjs inspect|prepare --expected-head SHA [--version X.Y.Z] [--release-date YYYY-MM-DD] [--changelog-file CHANGELOG.md] [--report PATH] [--format=json] [--root DIR]";
}

export async function run(argumentsList = process.argv.slice(2)) {
  try {
    const options = parseArguments(argumentsList);
    if (options.mode === "help") { process.stdout.write(`${usage()}\n`); return null; }
    const report = options.mode === "prepare" ? prepareRelease(options) : inspectRelease(options);
    if (options.report && !report.reportPath) report.reportPath = writeReport(resolve(options.root), options.report, report);
    if (options.format === "json" || options.report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${report.status}: ${report.reasons.join("; ")}\n`);
    return report;
  } catch (error) {
    if (error.name === "ReleasePreparationError") throw error;
    throw new Error(error.message, { cause: error });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`release-prep: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
