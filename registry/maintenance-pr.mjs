#!/usr/bin/env node

/*
 * Bounded weekly registry/release PR writer.
 *
 * The observer is the only producer of observation data. This module accepts
 * its canonical envelope, validates it against the frozen checkout, runs the
 * observer's pure recomputation, and then writes a small allowlisted commit
 * through an explicitly injected GitHub adapter. Artifact data is parsed as
 * JSON only; it is never imported, evaluated, or treated as a patch.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  recomputeObservationArtifacts,
  validateObservationArtifacts as validateObserverArtifacts,
} from "./observer.mjs";
import {
  CHANGELOG_RELATIVE_PATH,
  loadReleasePlan,
  PACKAGE_VERSION_PATHS,
  prepareRelease,
} from "./release-prep.mjs";
import { validateCatalog } from "./token-catalog.mjs";
import {
  buildDataCandidate,
  CANDIDATE_OUTPUT_PATHS,
  collectMaintenanceObservation,
  computeOutputDigest as dataOutputDigest,
  expectedCandidateChangedPaths,
  normalizeChangedPaths,
  promoteDataCandidate,
  replayMaintenanceObservation,
  verifyDataCi,
  verifyMergedCandidate,
  writeDataMaintenancePr,
} from "./data-promotion.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");

export const OBSERVATION_PATHS = Object.freeze([
  "registry/maintenance-findings.json",
  "registry/source-baseline.json",
  "registry/evidence/maintenance-review.json",
  "registry/evidence/maintenance-review.md",
]);
export const OBSERVER_JSON_PATHS = Object.freeze(OBSERVATION_PATHS.filter((value) => value.endsWith(".json")));
export const RELEASE_OUTPUT_PATHS = Object.freeze([...PACKAGE_VERSION_PATHS, CHANGELOG_RELATIVE_PATH]);
export const OUTPUT_PATHS = Object.freeze([...OBSERVATION_PATHS, ...RELEASE_OUTPUT_PATHS]);
export const DATA_OUTPUT_PATHS = CANDIDATE_OUTPUT_PATHS;
export const TRUSTED_INPUT_PATHS = Object.freeze([
  "registry/token-catalog.json",
  "registry/observer-config.json",
  "registry/maintenance-findings.json",
  "registry/source-baseline.json",
]);

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const BOT_BRANCH = "codex/registry-maintenance";
export const RELEASE_BRANCH = "codex/release-preparation";
export const ALLOWED_BOT_BRANCHES = Object.freeze([BOT_BRANCH, RELEASE_BRANCH]);
export const BOT_BRANCH_REF = `refs/heads/${BOT_BRANCH}`;
export const DEFAULT_BASE_BRANCH = "main";
export const GITHUB_API_VERSION = "2026-03-10";
export const WORKFLOW_DISPATCH_INPUTS = Object.freeze(["expected_head_sha", "base_sha"]);
export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVATION_KIND = "erpc-sdk-weekly-maintenance-observation";
export const MANAGED_BY = "erpc-sdk-weekly-maintenance";
// The CI workflow uploads this exact artifact for a managed data PR.  The
// run-bound suffix is derived from the authenticated API run below; callers
// must never select an artifact by a regexp or a fuzzy name.
export const DATA_CI_ARTIFACT_PREFIX = "ci-data-maintenance-";
export const DATA_CI_OBSERVATION_ENTRY = "maintenance-observation.json";
export const DATA_CI_PROVENANCE_ENTRY = "ci-provenance.json";

const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024;
const MAX_CI_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_CI_ARCHIVE_ENTRIES = 8;
// Keep the compressed archive cap unchanged. The plain default collector's
// pretty discovery receipt measured 10,202,301 bytes, so a finite 16 MiB
// uncompressed bound covers the observation and its provenance envelope.
const MAX_CI_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_CI_TOTAL_BYTES = 16 * 1024 * 1024;
const PREPARED_RELEASE_STATUSES = new Set(["PREPARED_UNPUBLISHED", "PREPARED"]);
const RELEASE_VERSION_PATHS = new Set(RELEASE_OUTPUT_PATHS);
const ALL_OUTPUT_SET = new Set(OUTPUT_PATHS);
const DATA_OUTPUT_SET = new Set(CANDIDATE_OUTPUT_PATHS);
const FAILED_DISPATCH_KEYS = new Set();
const SENSITIVE_KEY_RE = /(?:secret|password|credential|authorization|api[_-]?key|pat|private[_-]?key|(?:access|auth|bearer)[_-]?token)/iu;
const VOLATILE_KEY_RE = /^(?:source(?:Sha|SHA)|expectedSource(?:Sha|SHA)|observedAt|observationTime|timestamp|date|time|block|blockNumber|slot|anchorSlot|contextSlot|retry|retryCount|requestId|requestID|bodySha256|rawBody|rawHash|rawSha|rawBytes|mainSha|unrelatedSha)$/u;
const VOLATILE_TEXT_RE = /(^|\n)(##\s+\d+\.\d+\.\d+\s+[—-]\s+)\d{4}-\d{2}-\d{2}(?=\n|$)/gu;

function fail(message, code = "INVALID_MAINTENANCE_INPUT") {
  const error = new Error(message);
  error.name = "MaintenanceWriterError";
  error.code = code;
  throw error;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase commit SHA`);
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, "ARTIFACT_INVALID");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} keys must be exactly ${expected.join(", ")}`, "ARTIFACT_INVALID");
}

function safeRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || isAbsolute(value)) fail(`${label} must be a repository-relative path`, "PATH_INVALID");
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) fail(`${label} may not contain traversal segments`, "PATH_INVALID");
  return value;
}

function pathInRoot(root, value, label = "path") {
  const base = resolve(root);
  const relativeValue = safeRelativePath(value, label);
  const target = resolve(base, relativeValue);
  const targetRelative = relative(base, target).split(sep).join("/");
  if (targetRelative !== relativeValue || targetRelative.startsWith("../") || isAbsolute(targetRelative)) fail(`${label} escapes the trusted checkout`, "PATH_INVALID");
  return target;
}

function cloneJson(value, label) {
  try { return JSON.parse(JSON.stringify(value)); } catch (error) { fail(`${label} contains non-serializable data: ${error.message}`, "ARTIFACT_INVALID"); }
}

function stableValue(value, key = "") {
  if (VOLATILE_KEY_RE.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry, key)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      const child = stableValue(value[childKey], childKey);
      if (child !== undefined) result[childKey] = child;
    }
    return result;
  }
  return value;
}

/** A fingerprint for semantic maintenance content, excluding run noise. */
export function semanticFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function semanticText(relativePath, text) {
  if (relativePath === CHANGELOG_RELATIVE_PATH) return text.replace(VOLATILE_TEXT_RE, "$1$2<DATE>");
  return text;
}

function outputDigest(files) {
  const semanticFiles = Object.fromEntries(Object.keys(files).sort().map((pathValue) => {
    if (pathValue.endsWith(".json")) {
      try { return [pathValue, stableValue(JSON.parse(files[pathValue]))]; } catch { return [pathValue, semanticText(pathValue, files[pathValue])]; }
    }
    return [pathValue, semanticText(pathValue, files[pathValue])];
  }));
  return semanticFingerprint(semanticFiles);
}

function contentDigest(files) {
  const hash = createHash("sha256");
  for (const pathValue of Object.keys(files).sort()) hash.update(pathValue, "utf8").update("\0", "utf8").update(files[pathValue], "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactSecrets(child);
    return result;
  }
  return value;
}

function readBoundedJson(filePath, label = "artifact", limit = MAX_JSON_BYTES) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) fail(`${label} path is invalid`, "PATH_INVALID");
  let stat;
  try {
    const link = lstatSync(filePath);
    if (link.isSymbolicLink()) fail(`${label} may not be a symbolic link`, "ARTIFACT_INVALID");
    stat = statSync(filePath);
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`, "ARTIFACT_INVALID");
  }
  if (!stat.isFile()) fail(`${label} must be a regular file`, "ARTIFACT_INVALID");
  if (stat.size > limit) fail(`${label} exceeds the ${limit}-byte bound`, "ARTIFACT_TOO_LARGE");
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch (error) { fail(`cannot read ${label}: ${error.message}`, "ARTIFACT_INVALID"); }
  if (Buffer.byteLength(text, "utf8") > limit) fail(`${label} exceeds the ${limit}-byte bound`, "ARTIFACT_TOO_LARGE");
  try { return JSON.parse(text); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`, "ARTIFACT_INVALID"); }
}

function readTrustedJson(root, relativePath, { optional = false, limit = MAX_JSON_BYTES } = {}) {
  const target = pathInRoot(root, relativePath, "trusted input path");
  try {
    return readBoundedJson(target, relativePath, limit);
  } catch (error) {
    if (optional && error?.code === "ARTIFACT_INVALID" && /ENOENT/u.test(error.message)) return null;
    throw error;
  }
}

function readTrustedText(root, relativePath, label = relativePath) {
  const target = pathInRoot(root, relativePath, label);
  let stat;
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink()) fail(`${label} may not be a symbolic link`, "ARTIFACT_INVALID");
    stat = statSync(target);
  } catch (error) { fail(`cannot read ${label}: ${error.message}`, "RELEASE_INVALID"); }
  if (!stat.isFile() || stat.size > MAX_RELEASE_BYTES) fail(`${label} is not a bounded regular file`, "RELEASE_INVALID");
  try { return readFileSync(target, "utf8"); } catch (error) { fail(`cannot read ${label}: ${error.message}`, "RELEASE_INVALID"); }
}

function validateTrustedPrior(prior, catalog) {
  if (prior === null || prior === undefined) return null;
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) fail("trusted prior findings must be an object", "PREVIOUS_FINDINGS_INVALID");
  if (prior.schemaVersion !== OBSERVATION_SCHEMA_VERSION || prior.artifactKind !== "maintenance-findings") fail("trusted prior findings envelope is invalid", "PREVIOUS_FINDINGS_INVALID");
  if (!["complete", "partial"].includes(prior.status)) fail("trusted prior findings status is invalid", "PREVIOUS_FINDINGS_INVALID");
  // Prior findings are intentionally historical: a catalog/runtime update
  // gives the next run a new binding. The observer recomputation decides which
  // historical findings remain carryable against the current catalog/config.
  return cloneJson(prior, "trusted prior findings");
}

/** Read only the four fixed observer inputs from the frozen checkout. */
export function readTrustedState(root = REPOSITORY_ROOT) {
  const trustedRoot = resolve(root);
  const catalog = readTrustedJson(trustedRoot, TRUSTED_INPUT_PATHS[0]);
  const config = readTrustedJson(trustedRoot, TRUSTED_INPUT_PATHS[1]);
  try { validateCatalog(catalog); } catch (error) { fail(`trusted catalog failed validation: ${error.message}`, "CATALOG_INVALID"); }
  const prior = readTrustedJson(trustedRoot, TRUSTED_INPUT_PATHS[2], { optional: true });
  const baseline = readTrustedJson(trustedRoot, TRUSTED_INPUT_PATHS[3], { optional: true });
  return Object.freeze({ root: trustedRoot, catalog, config, priorFindings: validateTrustedPrior(prior, catalog), baseline });
}

function validateCanonicalEnvelope(input) {
  exactKeys(input, ["receipts", "findings", "reviewCandidate"], "observer envelope");
}

function sameStable(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

/** Validate and compare observer artifacts to its canonical pure recomputation. */
export function validateAndRecomputeObservation(input, {
  sourceSha,
  catalog,
  config,
  priorFindings,
  baseline,
} = {}) {
  validateCanonicalEnvelope(input);
  requireSha(sourceSha, "expected source SHA");
  if (!catalog || !config) fail("trusted catalog and observer config are required", "ARTIFACT_INVALID");
  try { validateObserverArtifacts(input, { sourceSha, catalog, config, priorFindings: priorFindings ?? null, baseline: baseline ?? null }); } catch (error) { fail(`observer artifact validation failed: ${error.message}`, error.code ?? "ARTIFACT_INVALID"); }
  let recomputed;
  try { recomputed = recomputeObservationArtifacts(input.receipts, { sourceSha, catalog, config, priorFindings, baseline }); } catch (error) { fail(`observer recomputation failed: ${error.message}`, error.code ?? "ARTIFACT_INVALID"); }
  if (!sameStable(recomputed.findings, input.findings) || !sameStable(recomputed.reviewCandidate, input.reviewCandidate)) fail("observer artifacts do not match trusted pure recomputation", "ARTIFACT_INVALID");
  return Object.freeze({ input: cloneJson(input, "observer envelope"), recomputed });
}

function baselineFromReceipts(receipts, candidate, config) {
  if (!candidate?.baseline?.eligibleBootstrap) return null;
  if (receipts.status !== "complete" || receipts.sources.length !== 41 || receipts.sources.some((source) => source.status !== "success" || typeof source.fingerprint !== "string" || typeof source.finalUrl !== "string")) fail("baseline bootstrap requires a complete genuine 41-source observation", "BASELINE_INVALID");
  const configById = new Map(config.sources.map((source) => [source.sourceId, source]));
  const sources = receipts.sources.map((receipt) => {
    const source = configById.get(receipt.sourceId);
    if (!source || !source.allowedFinalUrls.includes(receipt.finalUrl)) fail(`baseline source ${receipt.sourceId} has an unapproved final URL`, "BASELINE_INVALID");
    requireDigest(receipt.fingerprint, `baseline source ${receipt.sourceId} fingerprint`);
    return { sourceId: receipt.sourceId, fingerprint: receipt.fingerprint, mode: receipt.mode, approvedFinalUrls: [receipt.finalUrl] };
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (sources.length !== 41 || new Set(sources.map((source) => source.sourceId)).size !== 41) fail("baseline bootstrap does not cover exactly 41 unique sources", "BASELINE_INVALID");
  return {
    schemaVersion: 1,
    baselineKind: "source-baseline",
    description: "Human-reviewed source baseline generated from one complete 41-source observer run.",
    sources,
  };
}

function reviewMarkdown(candidate, { catalogDigest, configDigest, baselineWritten }) {
  const lines = [
    "# Weekly maintenance review",
    "",
    `Status: ${candidate.status}`,
    `Action required: ${candidate.actionRequired ? "yes" : "no"}`,
    `Catalog digest: ${catalogDigest}`,
    `Config digest: ${configDigest}`,
    `Source baseline bootstrap: ${baselineWritten ? "eligible" : candidate.baseline.present ? "present" : "not eligible"}`,
    "",
    "## Proposals",
  ];
  if (candidate.proposals.length === 0) lines.push("", "No proposals were generated.");
  else for (const proposal of candidate.proposals) lines.push("", `- **${proposal.category} / ${proposal.subjectId}** — ${proposal.reasonCode}`, `  ${proposal.manualReview}`);
  lines.push("", "Observer proposals are evidence for human review. They do not authorize registry edits, approvals, merges, tags, or publication.", "");
  return lines.join("\n");
}

function readReleaseFiles(root) {
  const files = {};
  for (const relativePath of RELEASE_OUTPUT_PATHS) files[relativePath] = readTrustedText(root, relativePath, `release output ${relativePath}`);
  return files;
}

function gitPreviewCommand(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) fail(`trusted release preview git ${args.join(" ")} failed`, "RELEASE_INVALID");
  return String(result.stdout ?? "").trim();
}

/*
 * Re-run B1's release preparation against a clean clone of the frozen source.
 * The report is evidence, while these bytes are the trusted candidate. This
 * catches edits to descriptions, dependencies, lockfile metadata, and any
 * other content hidden behind an otherwise valid version/path report.
 */
function canonicalPreparedReleaseFiles(root, expectedSourceSha, report, localFiles) {
  const previewRoot = mkdtempSync(join(tmpdir(), "erpc-release-preview-"));
  try {
    const cloned = spawnSync("git", ["clone", "--local", "--no-hardlinks", root, previewRoot], { cwd: root, encoding: "utf8", stdio: "pipe" });
    if (cloned.error || cloned.status !== 0) fail(`cannot create isolated release preview: ${String(cloned.stderr ?? "").trim() || cloned.error?.message || "git clone failed"}`, "RELEASE_INVALID");
    gitPreviewCommand(previewRoot, ["checkout", "--detach", expectedSourceSha]);
    if (gitPreviewCommand(previewRoot, ["rev-parse", "HEAD"]) !== expectedSourceSha) fail("isolated release preview did not reach the expected source", "RELEASE_SOURCE_MISMATCH");
    const escapedVersion = report.selectedVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const localHeading = localFiles[CHANGELOG_RELATIVE_PATH].match(new RegExp(`^##\\s+${escapedVersion}(?:\\s+[—-]\\s+(\\d{4}-\\d{2}-\\d{2}))?\\s*$`, "mu"));
    const releaseDate = report.releaseDate ?? localHeading?.[1];
    if (typeof releaseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate)) fail("release report/local changelog has no valid preparation date", "RELEASE_INVALID");
    const previewReport = prepareRelease({ root: previewRoot, expectedHead: expectedSourceSha, version: report.selectedVersion, releaseDate });
    if (!PREPARED_RELEASE_STATUSES.has(previewReport.status)) fail(`trusted release preview did not produce a prepared candidate: ${previewReport.status}`, "RELEASE_INVALID");
    const changed = gitPreviewCommand(previewRoot, ["diff", "--name-only", expectedSourceSha, "--"]).split(/\r?\n/u).filter(Boolean);
    if (changed.some((pathValue) => !RELEASE_VERSION_PATHS.has(pathValue))) fail("trusted release preview changed an unallowlisted path", "RELEASE_INVALID");
    return readReleaseFiles(previewRoot);
  } finally {
    try { rmSync(previewRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup of this exact temporary directory */ }
  }
}

function assertCheckoutHead(root, expectedSourceSha) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) fail("cannot verify the trusted checkout HEAD", "STALE_HEAD");
  const actual = String(result.stdout ?? "").trim();
  if (actual !== expectedSourceSha) fail(`trusted checkout HEAD ${actual} does not match expected source ${expectedSourceSha}`, "STALE_HEAD");
}

function parseVersionFromText(text, relativePath) {
  if (relativePath === "packages/typescript/package.json") {
    try { return JSON.parse(text).version ?? null; } catch (error) { fail(`cannot parse ${relativePath}: ${error.message}`, "RELEASE_INVALID"); }
  }
  if (relativePath === "packages/rust/Cargo.toml") return text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null;
  if (relativePath === "packages/python/pyproject.toml") return text.match(/^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null;
  if (relativePath === "packages/python/src/erpc_sdk/__init__.py") return text.match(/^__version__\s*=\s*"([^"]+)"$/mu)?.[1] ?? null;
  if (relativePath === "packages/ruby/lib/erpc_sdk/version.rb") return text.match(/^\s*VERSION\s*=\s*"([^"]+)"$/mu)?.[1] ?? null;
  if (relativePath === "Cargo.lock") {
    const blocks = text.split(/^\[\[package\]\]\s*$/mu).slice(1).filter((block) => /^name\s*=\s*"erpc-sdk"\s*$/mu.test(block) && !/^source\s*=/mu.test(block));
    return blocks.length === 1 ? blocks[0].match(/^version\s*=\s*"([^"]+)"$/mu)?.[1] ?? null : null;
  }
  return null;
}

function validateReleaseReport(report, {
  root,
  expectedSourceSha,
  expectedCatalogDigest,
  expectedConfigDigest,
} = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) fail("release report must be an object", "RELEASE_INVALID");
  if (report.kind !== "erpc-sdk-release-prep-report") fail("release report kind is invalid", "RELEASE_INVALID");
  if (!PREPARED_RELEASE_STATUSES.has(report.status)) fail(`release report status ${report.status ?? "missing"} is not prepared`, "RELEASE_INVALID");
  requireSha(report.expectedHead, "release report expected head");
  if (report.expectedHead !== expectedSourceSha) fail("release report is not bound to expected source SHA", "RELEASE_SOURCE_MISMATCH");
  if (report.actualHead !== undefined && report.actualHead !== expectedSourceSha) fail("release report actual head is stale", "RELEASE_SOURCE_MISMATCH");
  if (typeof report.selectedVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(report.selectedVersion)) fail("release report selected version is invalid", "RELEASE_INVALID");
  if (!report.plan || typeof report.plan !== "object" || typeof report.plan.sourceSha !== "string" || !SHA_RE.test(report.plan.sourceSha)) fail("release report plan provenance is invalid", "RELEASE_INVALID");
  if (report.planProvenance?.targetVersion !== undefined && (typeof report.planProvenance.targetVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(report.planProvenance.targetVersion))) fail("release report approved plan target version is invalid", "RELEASE_INVALID");
  if (report.planProvenance?.sourceSha !== undefined && report.planProvenance.sourceSha !== report.plan.sourceSha) fail("release report plan source provenance is inconsistent", "RELEASE_INVALID");
  let trustedPlan;
  try { trustedPlan = loadReleasePlan(root); } catch (error) { fail(`trusted release plan validation failed: ${error.message}`, "RELEASE_INVALID"); }
  if (report.plan.sourceSha !== trustedPlan.sourceSha || (report.planProvenance?.targetVersion !== undefined && report.planProvenance.targetVersion !== trustedPlan.targetVersion)) fail("release report does not match the trusted approved plan provenance", "RELEASE_INVALID");
  if (report.baselineVersion !== undefined && (typeof report.baselineVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(report.baselineVersion))) fail("release report baseline version is invalid", "RELEASE_INVALID");
  if (!report.changelog || report.changelog.path !== CHANGELOG_RELATIVE_PATH || report.changelog.hasVersion !== true) fail("release report changelog preparation is incomplete", "RELEASE_INVALID");
  if (!report.catalog || report.catalog.digest !== expectedCatalogDigest) fail("release report catalog binding is stale", "RELEASE_CATALOG_MISMATCH");
  if (report.configDigest !== undefined && report.configDigest !== expectedConfigDigest) fail("release report config binding is stale", "RELEASE_CONFIG_MISMATCH");
  if (!Array.isArray(report.writtenFiles) || report.writtenFiles.some((pathValue) => !RELEASE_VERSION_PATHS.has(pathValue))) fail("release report contains a path outside the exact preparation allowlist", "RELEASE_INVALID");
  const files = readReleaseFiles(root);
  for (const relativePath of PACKAGE_VERSION_PATHS) if (parseVersionFromText(files[relativePath], relativePath) !== report.selectedVersion) fail(`${relativePath} is not prepared at ${report.selectedVersion}`, "RELEASE_INVALID");
  const escapedVersion = report.selectedVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^##\\s+${escapedVersion}(?:\\s+[—-]\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "mu").test(files[CHANGELOG_RELATIVE_PATH])) fail(`CHANGELOG.md lacks the prepared ${report.selectedVersion} section`, "RELEASE_INVALID");
  const canonicalFiles = canonicalPreparedReleaseFiles(root, expectedSourceSha, report, files);
  for (const relativePath of RELEASE_OUTPUT_PATHS) if (files[relativePath] !== canonicalFiles[relativePath]) fail(`release output ${relativePath} differs from canonical B1 preparation`, "RELEASE_INVALID");
  return Object.freeze({ report: cloneJson(report, "release report"), files });
}

function releaseSemantic(report, files) {
  return {
    status: report.status,
    version: report.selectedVersion,
    plan: { sourceSha: report.plan.sourceSha, approvedTargetVersion: report.planProvenance?.targetVersion ?? null },
    selectedVersion: report.selectedVersion,
    files: Object.fromEntries(Object.keys(files).sort().map((pathValue) => [pathValue, semanticText(pathValue, files[pathValue])])),
  };
}

function payloadFiles({ observation, state, release }) {
  const candidate = observation.reviewCandidate;
  const baseline = baselineFromReceipts(observation.receipts, candidate, state.config);
  const files = {
    [OBSERVATION_PATHS[0]]: `${JSON.stringify(observation.findings, null, 2)}\n`,
    [OBSERVATION_PATHS[2]]: `${JSON.stringify(candidate, null, 2)}\n`,
    [OBSERVATION_PATHS[3]]: reviewMarkdown(candidate, { catalogDigest: observation.findings.catalogDigest, configDigest: observation.findings.configDigest, baselineWritten: baseline !== null }),
  };
  if (baseline !== null) files[OBSERVATION_PATHS[1]] = `${JSON.stringify(baseline, null, 2)}\n`;
  if (release) Object.assign(files, release.files);
  for (const pathValue of Object.keys(files)) if (!ALL_OUTPUT_SET.has(pathValue)) fail(`writer output is outside the allowlist: ${pathValue}`, "PATH_INVALID");
  return { files, baseline };
}

/** Build the exact reviewable output plan without writing the checkout. */
export function buildMaintenancePayload({
  observation,
  releaseReport = null,
  baseSha,
  expectedSourceSha,
  configDigest,
  catalogDigest,
  root = REPOSITORY_ROOT,
  trustedState = undefined,
} = {}) {
  requireSha(baseSha, "frozen main SHA");
  requireSha(expectedSourceSha, "expected source SHA");
  requireDigest(catalogDigest, "catalog digest");
  if (configDigest !== undefined && configDigest !== null) requireDigest(configDigest, "config digest");
  const state = trustedState ?? readTrustedState(root);
  if (state.catalog.contentDigest !== catalogDigest) fail("catalog digest does not match the frozen checkout", "OBSERVATION_CATALOG_MISMATCH");
  const recomputed = validateAndRecomputeObservation(observation, { sourceSha: expectedSourceSha, catalog: state.catalog, config: state.config, priorFindings: state.priorFindings, baseline: state.baseline });
  const canonical = recomputed.recomputed;
  if (canonical.receipts.catalogDigest !== catalogDigest) fail("recomputed observation catalog digest is stale", "OBSERVATION_CATALOG_MISMATCH");
  if (configDigest !== undefined && configDigest !== null && canonical.receipts.configDigest !== configDigest) fail("recomputed observation config digest is stale", "OBSERVATION_CONFIG_MISMATCH");
  if (releaseReport) assertCheckoutHead(state.root, expectedSourceSha);
  const release = releaseReport ? validateReleaseReport(releaseReport, { root: state.root, expectedSourceSha, expectedCatalogDigest: catalogDigest, expectedConfigDigest: canonical.receipts.configDigest }) : null;
  const outputs = payloadFiles({ observation: canonical, state, release });
  const observationAction = canonical.reviewCandidate.actionRequired === true || canonical.reviewCandidate.baseline?.eligibleBootstrap === true;
  const priorFindingValues = state.priorFindings?.findings ?? [];
  const priorFindingsChanged = !sameStable(priorFindingValues, canonical.findings.findings);
  const actionRequired = observationAction || priorFindingsChanged || release !== null;
  const branch = release !== null ? RELEASE_BRANCH : BOT_BRANCH;
  const semantic = semanticFingerprint({ branch, observation: { findings: canonical.findings, reviewCandidate: canonical.reviewCandidate }, release: release ? releaseSemantic(release.report, release.files) : null, outputDigest: outputDigest(outputs.files) });
  return Object.freeze({
    schemaVersion: 1,
    kind: "erpc-sdk-weekly-maintenance-payload",
    branch,
    baseBranch: DEFAULT_BASE_BRANCH,
    baseSha,
    expectedSourceSha,
    catalogDigest,
    configDigest: canonical.receipts.configDigest,
    trustedRoot: state.root,
    observation: canonical,
    release: release?.report ?? null,
    files: Object.freeze(outputs.files),
    outputPaths: Object.freeze(Object.keys(outputs.files).sort()),
    baseline: outputs.baseline,
    observationAction,
    priorFindingsChanged,
    actionRequired,
    semanticFingerprint: semantic,
    outputDigest: outputDigest(outputs.files),
    contentDigest: contentDigest(outputs.files),
  });
}

export function buildPullRequestBody({ payload, observation, releaseReport, baseSha, expectedSourceSha, configDigest, catalogDigest, root = REPOSITORY_ROOT } = {}) {
  const value = payload ?? buildMaintenancePayload({ observation, releaseReport, baseSha, expectedSourceSha, configDigest, catalogDigest, root });
  if (!value || value.kind !== "erpc-sdk-weekly-maintenance-payload") fail("payload must be produced by buildMaintenancePayload");
  const lines = [
    "## Weekly SDK maintenance",
    "",
    "This reviewable candidate was assembled from one bounded observer run and the frozen checkout.",
    "",
    `- Semantic fingerprint: \`${value.semanticFingerprint}\``,
    `- Catalog digest: \`${value.catalogDigest}\``,
    `- Config digest: \`${value.configDigest}\``,
    `- Frozen main SHA: \`${value.baseSha}\``,
    `- Candidate source SHA: \`${value.expectedSourceSha}\``,
    `- Branch: \`${value.branch}\``,
    `- Release preparation: \`${value.release?.status ?? "not requested"}\``,
    "- Allowlisted outputs:",
  ];
  for (const pathValue of value.outputPaths) lines.push(`  - \`${pathValue}\``);
  lines.push("", "CI is dispatched manually against the bot branch with the bot commit as `expected_head_sha` and frozen main as `base_sha`. Approval, merge, tag, and publication remain human actions.", "");
  return lines.join("\n");
}

export function buildWorkflowDispatch({ branch = BOT_BRANCH, expectedHeadSha = undefined, expectedSourceSha = undefined, baseSha, workflowPath = WORKFLOW_PATH } = {}) {
  if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail(`workflow dispatch branch must be one of: ${ALLOWED_BOT_BRANCHES.join(", ")}`, "WORKFLOW_POLICY");
  const head = expectedHeadSha ?? expectedSourceSha;
  requireSha(head, "workflow expected head SHA");
  requireSha(baseSha, "workflow base SHA");
  if (head === baseSha) fail("workflow expected head must be the bot commit, distinct from frozen main", "WORKFLOW_POLICY");
  if (workflowPath !== WORKFLOW_PATH) fail(`workflow path must be ${WORKFLOW_PATH}`, "WORKFLOW_POLICY");
  return Object.freeze({ workflowPath, ref: branch, inputs: { expected_head_sha: head, base_sha: baseSha }, apiVersion: GITHUB_API_VERSION });
}

function responseValue(response, keys) {
  for (const key of keys) if (response?.[key] !== undefined) return response[key];
  return null;
}

function responseSha(response, label) {
  const value = typeof response === "string" ? response : responseValue(response, ["sha", "headSha", "commitSha", "object_sha", "objectSha"]);
  return requireSha(value, label);
}

function assertWritePreconditions(payload) {
  const receiptWorkspace = payload.observation?.receipts?.workspace;
  const candidateWorkspace = payload.observation?.reviewCandidate?.workspace;
  for (const workspace of [receiptWorkspace, candidateWorkspace]) {
    if (!workspace || workspace.clean !== true || workspace.pinned !== true || workspace.promotable !== true) fail("write promotion requires a clean, pinned, promotable observer checkout", "WORKSPACE_NOT_PROMOTABLE");
  }
  if (!payload.release && payload.expectedSourceSha !== payload.baseSha) fail("main-based maintenance source and frozen base must agree", "BASELINE_MISMATCH");
  if (payload.trustedRoot) {
    assertCheckoutHead(payload.trustedRoot, payload.expectedSourceSha);
  }
}

async function callAdapter(adapter, method, ...args) {
  if (typeof adapter?.[method] !== "function") fail(`GitHub adapter is missing ${method}`, "GITHUB_ADAPTER_INVALID");
  return adapter[method](...args);
}

async function readRefSha(adapter, branch, { allowMissing = false } = {}) {
  let value;
  try { value = await callAdapter(adapter, "getBranchSha", branch); } catch (error) {
    if (allowMissing && (error?.status === 404 || error?.code === 404 || /not found/iu.test(error.message ?? ""))) return null;
    throw error;
  }
  if (value === null || value === undefined) {
    if (allowMissing) return null;
    fail(`${branch} ref does not exist`, "GITHUB_API_FAILED");
  }
  return responseSha(value, `${branch} ref SHA`);
}

async function ensureMainLease(adapter, frozenMainSha, baseBranch = DEFAULT_BASE_BRANCH) {
  const latest = await readRefSha(adapter, baseBranch);
  if (latest !== frozenMainSha) fail(`${baseBranch} moved from frozen ${frozenMainSha} to ${latest}; refusing mutation`, "STALE_MAIN");
  return latest;
}

function managedMetadata(payload) {
  return {
    managedBy: MANAGED_BY,
    branch: payload.branch,
    baseSha: payload.baseSha,
    expectedSourceSha: payload.expectedSourceSha,
    catalogDigest: payload.catalogDigest,
    configDigest: payload.configDigest,
    semanticFingerprint: payload.semanticFingerprint,
    outputDigest: payload.outputDigest,
    contentDigest: payload.contentDigest,
    outputPaths: [...payload.outputPaths],
  };
}

function validateManagedMetadata(metadata, payload, branchHead) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("existing bot branch has no managed provenance", "HUMAN_BRANCH_EDIT");
  if (metadata.managedBy !== MANAGED_BY || metadata.branch !== payload.branch) fail("bot branch provenance is not owned by this writer", "HUMAN_BRANCH_EDIT");
  requireSha(metadata.baseSha, "managed bot branch base SHA");
  requireSha(metadata.parentSha, "managed bot branch parent SHA");
  if (metadata.parentSha !== metadata.baseSha) fail("managed bot branch parent does not match its frozen base", "HUMAN_BRANCH_EDIT");
  requireSha(metadata.headSha, "managed bot branch recorded head SHA");
  if (metadata.headSha !== branchHead) fail("bot branch changed outside its recorded managed head", "HUMAN_BRANCH_EDIT");
  requireDigest(metadata.semanticFingerprint, "managed bot branch semantic fingerprint");
  requireDigest(metadata.outputDigest, "managed bot branch output provenance");
  requireDigest(metadata.contentDigest, "managed bot branch byte content provenance");
  const actualOutputDigest = metadata.actualOutputDigest ?? metadata.actualSemanticDigest;
  requireDigest(actualOutputDigest, "managed bot branch actual semantic digest");
  if (actualOutputDigest !== metadata.outputDigest) fail("managed bot branch content differs from its recorded output digest", "HUMAN_BRANCH_EDIT");
  const actualContentDigest = metadata.actualContentDigest ?? metadata.actualByteDigest;
  requireDigest(actualContentDigest, "managed bot branch actual byte digest");
  if (actualContentDigest !== metadata.contentDigest) fail("managed bot branch bytes differ from their recorded content digest", "HUMAN_BRANCH_EDIT");
  if (!Array.isArray(metadata.outputPaths) || metadata.outputPaths.length === 0 || metadata.outputPaths.some((pathValue) => !ALL_OUTPUT_SET.has(pathValue)) || new Set(metadata.outputPaths).size !== metadata.outputPaths.length || [...metadata.outputPaths].sort().join("\0") !== metadata.outputPaths.join("\0")) fail("bot branch provenance contains an invalid output path set", "HUMAN_BRANCH_EDIT");
  return metadata;
}

function branchCandidate(candidates, branch) {
  return candidates.find((candidate) => {
    const head = candidate?.head?.ref ?? candidate?.headRef ?? candidate?.headRefName ?? candidate?.branch;
    const base = candidate?.base?.ref ?? candidate?.baseRef ?? candidate?.baseRefName ?? candidate?.base;
    return head === branch && (base === undefined || base === DEFAULT_BASE_BRANCH) && String(candidate?.state ?? "open").toLowerCase() === "open";
  }) ?? null;
}

function historicalBranchCandidate(candidates, branch) {
  return candidates.find((candidate) => {
    const head = candidate?.head?.ref ?? candidate?.headRef ?? candidate?.headRefName ?? candidate?.branch;
    const base = candidate?.base?.ref ?? candidate?.baseRef ?? candidate?.baseRefName ?? candidate?.base;
    return head === branch && (base === undefined || base === DEFAULT_BASE_BRANCH) && ["closed", "merged"].includes(String(candidate?.state ?? "").toLowerCase());
  }) ?? null;
}

function candidateFingerprint(candidate) {
  const direct = candidate?.semanticFingerprint ?? candidate?.metadata?.semanticFingerprint;
  if (direct) return direct;
  return String(candidate?.body ?? "").match(/semantic fingerprint:\s*`?([0-9a-f]{64})/iu)?.[1] ?? null;
}

async function listPullRequests(adapter, branch, baseBranch) {
  if (typeof adapter.listPullRequests !== "function") return [];
  const result = await adapter.listPullRequests({ head: branch, base: baseBranch, state: "all" });
  return Array.isArray(result) ? result : result?.items ?? result?.pullRequests ?? [];
}

async function dispatchAndVerify(adapter, { branch, botHead, frozenMainSha, baseBranch = DEFAULT_BASE_BRANCH, dispatch, semanticKey = "" }) {
  if (!dispatch) return null;
  await ensureMainLease(adapter, frozenMainSha, baseBranch);
  const workflow = buildWorkflowDispatch({ branch, expectedHeadSha: botHead, baseSha: frozenMainSha });
  const retryKey = `${branch}:${semanticKey}`;
  try {
    const dispatched = await callAdapter(adapter, "dispatchWorkflow", workflow);
    if (typeof adapter.verifyWorkflowRunHead !== "function") fail("GitHub adapter must verify the dispatched workflow run head", "GITHUB_ADAPTER_INVALID");
    const verified = await callAdapter(adapter, "verifyWorkflowRunHead", dispatched, botHead, frozenMainSha, branch);
    const dispatchId = responseValue(dispatched, ["id", "run_id", "runId", "workflow_run_id", "workflowRunId"]);
    const verifiedId = responseValue(verified, ["id", "run_id", "runId", "workflow_run_id", "workflowRunId"]);
    if (dispatchId !== null && dispatchId !== undefined && (verifiedId === null || verifiedId === undefined || String(dispatchId) !== String(verifiedId))) fail("workflow verification did not bind to the dispatched run", "WORKFLOW_HEAD_MISMATCH");
    FAILED_DISPATCH_KEYS.delete(retryKey);
    return { ...workflow, response: redactSecrets(dispatched), run: redactSecrets(verifyRunHeadValue(verified, botHead, branch)) };
  } catch (error) {
    FAILED_DISPATCH_KEYS.add(retryKey);
    throw error;
  }
}

function commitMessage(payload) {
  return [
    payload.release ? "chore: prepare SDK release" : "chore: update canonical registry maintenance evidence",
    "",
    `ERPC-Maintenance-Managed-By: ${MANAGED_BY}`,
    `ERPC-Maintenance-Branch: ${payload.branch}`,
    `ERPC-Maintenance-Base-SHA: ${payload.baseSha}`,
    `ERPC-Maintenance-Source-SHA: ${payload.expectedSourceSha}`,
    `ERPC-Maintenance-Catalog-Digest: ${payload.catalogDigest}`,
    `ERPC-Maintenance-Config-Digest: ${payload.configDigest}`,
    `ERPC-Maintenance-Semantic-Fingerprint: ${payload.semanticFingerprint}`,
    `ERPC-Maintenance-Output-Digest: ${payload.outputDigest}`,
    `ERPC-Maintenance-Content-Digest: ${payload.contentDigest}`,
    `ERPC-Maintenance-Output-Paths: ${payload.outputPaths.join(",")}`,
  ].join("\n");
}

function extractRunHead(value) {
  return typeof value === "string" ? value : responseValue(value, ["head_sha", "headSha", "headCommitSha", "commitSha"]);
}

function verifyRunHeadValue(value, expectedHeadSha, branch) {
  const head = extractRunHead(value);
  if (head === null || head === undefined) fail("workflow run returned no verifiable head SHA", "WORKFLOW_HEAD_MISMATCH");
  if (head !== expectedHeadSha) fail(`workflow run head ${head} does not match bot commit ${expectedHeadSha}`, "WORKFLOW_HEAD_MISMATCH");
  if (value && typeof value === "object") {
    const ref = value.head_branch ?? value.headBranch ?? value.ref;
    if (ref !== undefined && ref !== branch && ref !== `refs/heads/${branch}`) fail("workflow run ref does not match bot branch", "WORKFLOW_HEAD_MISMATCH");
  }
  return value;
}

/** Write a reviewable PR using an adapter with compare-and-swap commits. */
export async function writeMaintenancePr({ adapter, payload, frozenMainSha, dryRun = true, dispatch = true, baseBranch = DEFAULT_BASE_BRANCH } = {}) {
  if (!adapter || typeof adapter !== "object") fail("a GitHub adapter is required", "GITHUB_ADAPTER_INVALID");
  if (!payload || payload.kind !== "erpc-sdk-weekly-maintenance-payload") fail("payload must be produced by buildMaintenancePayload");
  requireSha(frozenMainSha, "frozen main SHA");
  if (payload.baseSha !== frozenMainSha) fail("payload base SHA must equal frozen main SHA", "BASELINE_MISMATCH");
  if (baseBranch !== DEFAULT_BASE_BRANCH) fail(`base branch must be ${DEFAULT_BASE_BRANCH}`, "BRANCH_POLICY");
  if (!ALLOWED_BOT_BRANCHES.includes(payload.branch)) fail("payload branch is outside the fixed branch policy", "BRANCH_POLICY");
  if (!payload.actionRequired) return { status: "NO_ACTION", noPr: true, branch: payload.branch, semanticFingerprint: payload.semanticFingerprint, dispatched: false };
  assertWritePreconditions(payload);

  const branch = payload.branch;
  await ensureMainLease(adapter, frozenMainSha, baseBranch);
  const beforeSha = await readRefSha(adapter, branch, { allowMissing: true });
  const existingMetadata = beforeSha === null ? null : validateManagedMetadata(await callAdapter(adapter, "getBranchMetadata", branch), payload, beforeSha);
  if (beforeSha !== null && typeof adapter.getChangedPaths === "function") {
    const diffBaseSha = existingMetadata?.baseSha ?? frozenMainSha;
    const changed = await callAdapter(adapter, "getChangedPaths", branch, { baseSha: diffBaseSha });
    const paths = Array.isArray(changed) ? changed : changed?.paths ?? changed?.files?.map((file) => file.filename) ?? [];
    for (const pathValue of paths) if (!ALL_OUTPUT_SET.has(pathValue)) fail(`managed bot branch contains an unexpected changed path: ${pathValue}`, "HUMAN_BRANCH_EDIT");
  }
  const candidates = await listPullRequests(adapter, branch, baseBranch);
  const existingPr = branchCandidate(candidates, branch);
  const historicalPr = historicalBranchCandidate(candidates, branch);
  const branchAlreadyMatches = existingMetadata?.semanticFingerprint === payload.semanticFingerprint && (existingMetadata.outputDigest === undefined || existingMetadata.outputDigest === payload.outputDigest);
  if (historicalPr && !existingPr && candidateFingerprint(historicalPr) === payload.semanticFingerprint) return { status: "NO_CHANGE_HISTORY", branch, headSha: beforeSha, pullRequest: redactSecrets(historicalPr), semanticFingerprint: payload.semanticFingerprint, dispatched: false };
  if (branchAlreadyMatches && existingPr) {
    if (dryRun) return { status: "DRY_RUN", branch, oldHead: beforeSha, pullRequest: redactSecrets(existingPr), metadata: managedMetadata(payload), semanticFingerprint: payload.semanticFingerprint, outputPaths: payload.outputPaths, workflow: null };
    const retryKey = `${branch}:${payload.semanticFingerprint}`;
    let workflow = null;
    let shouldDispatch = dispatch && FAILED_DISPATCH_KEYS.has(retryKey);
    if (dispatch && typeof adapter.findWorkflowRun === "function") {
      const priorRun = await callAdapter(adapter, "findWorkflowRun", beforeSha, branch, frozenMainSha);
      if (priorRun) {
        verifyRunHeadValue(priorRun, beforeSha, branch);
        shouldDispatch = false;
      } else shouldDispatch = true;
    }
    if (shouldDispatch) workflow = await dispatchAndVerify(adapter, { branch, botHead: beforeSha, frozenMainSha, baseBranch, dispatch: true, semanticKey: payload.semanticFingerprint });
    return { status: "REUSED", branch, headSha: beforeSha, pullRequest: redactSecrets(existingPr), semanticFingerprint: payload.semanticFingerprint, dispatched: workflow !== null, workflow };
  }

  if (dryRun) return { status: "DRY_RUN", branch, oldHead: beforeSha, metadata: managedMetadata(payload), semanticFingerprint: payload.semanticFingerprint, outputPaths: payload.outputPaths, workflow: dispatch && beforeSha !== null ? buildWorkflowDispatch({ branch, expectedHeadSha: beforeSha, baseSha: payload.baseSha }) : null };

  let botHead = beforeSha;
  let commitResult = null;
  if (!branchAlreadyMatches) {
    await ensureMainLease(adapter, frozenMainSha, baseBranch);
    const metadata = managedMetadata(payload);
    try {
      commitResult = await callAdapter(adapter, "commitFiles", { branch, parentSha: frozenMainSha, expectedOldSha: beforeSha, baseSha: frozenMainSha, files: payload.files, message: commitMessage(payload), metadata });
    } catch (error) {
      if (error?.code === "CAS_CONFLICT" || error?.status === 409 || error?.status === 422) fail(error.message ?? "bot branch compare-and-swap conflict", "CAS_CONFLICT");
      throw error;
    }
    botHead = responseSha(commitResult, "created bot commit SHA");
  }
  if (botHead === null) fail("writer did not obtain a bot commit SHA", "GITHUB_API_FAILED");
  if (typeof adapter.getChangedPaths === "function") {
    const changed = await callAdapter(adapter, "getChangedPaths", branch, { baseSha: frozenMainSha, headSha: botHead });
    const paths = Array.isArray(changed) ? changed : changed?.paths ?? changed?.files?.map((file) => file.filename) ?? [];
    for (const pathValue of paths) if (!ALL_OUTPUT_SET.has(pathValue)) fail(`bot commit changed an unallowlisted path: ${pathValue}`, "EXACT_DIFF_ALLOWLIST");
  }

  await ensureMainLease(adapter, frozenMainSha, baseBranch);
  const body = buildPullRequestBody({ payload });
  const title = payload.release ? `chore: prepare SDK ${payload.release.selectedVersion} release` : "chore: weekly SDK registry maintenance";
  let pullRequest = existingPr;
  if (pullRequest) {
    if (typeof adapter.updatePullRequest !== "function") fail("GitHub adapter must provide updatePullRequest", "GITHUB_ADAPTER_INVALID");
    pullRequest = await callAdapter(adapter, "updatePullRequest", pullRequest.number ?? pullRequest.id, { title, body, head: branch, base: baseBranch, metadata: managedMetadata(payload) });
  } else pullRequest = await callAdapter(adapter, "createPullRequest", { title, body, head: branch, base: baseBranch, metadata: managedMetadata(payload) });

  const workflow = await dispatchAndVerify(adapter, { branch, botHead, frozenMainSha, baseBranch, dispatch, semanticKey: payload.semanticFingerprint });
  return { status: existingPr ? "UPDATED" : "CREATED", branch, headSha: botHead, commit: redactSecrets(commitResult), pullRequest: redactSecrets(pullRequest), semanticFingerprint: payload.semanticFingerprint, workflow };
}

export const createMaintenancePr = writeMaintenancePr;
export const runMaintenanceWriter = writeMaintenancePr;

function ghResult(args, { root = REPOSITORY_ROOT, allowFailure = false, env = process.env, input = undefined } = {}) {
  const result = spawnSync("gh", args, { cwd: root, env, encoding: "utf8", input, stdio: "pipe" });
  const normalized = { status: result.status === null ? 1 : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  if (!allowFailure && (normalized.error || normalized.status !== 0)) fail(`GitHub CLI request failed: ${normalized.stderr.trim() || normalized.error?.message || `exit ${normalized.status}`}`, "GITHUB_API_FAILED");
  return normalized;
}

function ghBinary(args, { root = REPOSITORY_ROOT, env = process.env, outputPath } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) fail("GitHub binary output path is required", "PATH_INVALID");
  let descriptor;
  try { descriptor = openSync(outputPath, "wx", 0o600); } catch (error) { fail(`cannot create bounded GitHub binary output: ${error.message}`, "PATH_INVALID"); }
  let result;
  try {
    // `gh api` writes response bytes to stdout.  It has no portable
    // `--output` option, so bind stdout directly to a private descriptor and
    // keep the response out of a UTF-8 string buffer.
    result = spawnSync("gh", args, { cwd: root, env, stdio: ["pipe", descriptor, "pipe"] });
  } finally {
    try { closeSync(descriptor); } catch { /* descriptor cleanup is best effort */ }
  }
  const status = result?.status === null ? 1 : result?.status ?? 1;
  if (result?.error || status !== 0) fail(`GitHub binary request failed: ${String(result?.stderr ?? "").trim() || result?.error?.message || `exit ${status}`}`, "GITHUB_API_FAILED");
  return { status, outputPath };
}

function archiveListing(zipPath) {
  const namesResult = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 });
  if (namesResult.error || namesResult.status !== 0) fail("maintenance CI artifact is not a readable ZIP", "GITHUB_API_FAILED");
  const names = String(namesResult.stdout ?? "").split(/\r?\n/u).filter(Boolean);
  if (names.length === 0 || names.length > MAX_CI_ARCHIVE_ENTRIES || new Set(names).size !== names.length) fail("maintenance CI artifact entry count is outside the fixed bound", "GITHUB_API_FAILED");
  if (names.some((name) => name.endsWith("/") || name.includes("\0") || name.split("/").some((part) => part === ".." || part === "."))) fail("maintenance CI artifact contains an unsafe entry name", "GITHUB_API_FAILED");
  const detailsResult = spawnSync("unzip", ["-l", zipPath], { encoding: "utf8", stdio: "pipe", maxBuffer: 128 * 1024 });
  if (detailsResult.error || detailsResult.status !== 0) fail("maintenance CI artifact listing could not be verified", "GITHUB_API_FAILED");
  const sizes = new Map();
  for (const line of String(detailsResult.stdout ?? "").split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(?:\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+(.+?)\s*$/u);
    if (!match) continue;
    const size = Number(match[1]);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CI_ENTRY_BYTES) fail("maintenance CI artifact entry exceeds its uncompressed bound", "ARTIFACT_TOO_LARGE");
    sizes.set(match[2], size);
  }
  if (sizes.size !== names.length || names.some((name) => !sizes.has(name))) fail("maintenance CI artifact listing is incomplete", "GITHUB_API_FAILED");
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_CI_TOTAL_BYTES) fail("maintenance CI artifact exceeds its total uncompressed bound", "ARTIFACT_TOO_LARGE");
  return { names, sizes };
}

function readArchiveJson(zipPath, name, expectedSize) {
  const result = spawnSync("unzip", ["-p", zipPath, name], { encoding: null, stdio: "pipe", maxBuffer: MAX_CI_ENTRY_BYTES + 1 });
  if (result.error || result.status !== 0) fail(`maintenance CI artifact entry ${name} could not be read`, "GITHUB_API_FAILED");
  const bytes = Buffer.from(result.stdout ?? Buffer.alloc(0));
  if (bytes.byteLength !== expectedSize || bytes.byteLength > MAX_CI_ENTRY_BYTES) fail(`maintenance CI artifact entry ${name} changed while reading`, "GITHUB_API_FAILED");
  try { return { value: JSON.parse(bytes.toString("utf8")), bytes }; } catch (error) { fail(`maintenance CI artifact entry ${name} is not valid JSON: ${error.message}`, "ARTIFACT_INVALID"); }
}

function ghRepoValue(repo) {
  const value = repo ?? process.env.GITHUB_REPOSITORY;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) fail("GITHUB_REPOSITORY or --repo owner/name is required", "GITHUB_API_FAILED");
  return value;
}

function ghJson(args, { root = REPOSITORY_ROOT, env = process.env, input = undefined, allowFailure = false } = {}) {
  const result = ghResult(args, { root, env, input, allowFailure });
  if (result.status !== 0) return null;
  if (!result.stdout.trim()) return { status: result.status };
  try { return JSON.parse(result.stdout); } catch (error) { fail(`GitHub API returned invalid JSON: ${error.message}`, "GITHUB_API_FAILED"); }
}

function apiArgs(method, pathValue, body = undefined) {
  const args = ["api", pathValue, "--header", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`];
  if (method) args.push("--method", method);
  if (body !== undefined) args.push("--input", "-");
  return { args, input: body === undefined ? undefined : `${JSON.stringify(body)}\n` };
}

function parseTrailer(message, name) {
  return String(message ?? "").match(new RegExp(`^ERPC-Maintenance-${name}: ([^\\r\\n]+)$`, "mu"))?.[1] ?? null;
}

/** A real GitHub adapter using the gh CLI's HTTPS API client. */
export function createGhAdapter({ repo = process.env.GITHUB_REPOSITORY, root = REPOSITORY_ROOT, env = process.env } = {}) {
  const repoValue = ghRepoValue(repo);
  const [owner, repository] = repoValue.split("/");
  const dispatchedRuns = new Map();
  const apiPath = (pathValue) => `/repos/${owner}/${repository}${pathValue.startsWith("/") ? pathValue : `/${pathValue}`}`;
  const graphql = (body) => ghJson(["api", "graphql", "--header", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`, "--input", "-"], { root, env, input: `${JSON.stringify(body)}\n` });
  const updateRefCas = (branch, beforeOid, afterOid) => {
    const lookup = graphql({ query: "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}", variables: { owner, name: repository } });
    const repositoryId = lookup?.data?.repository?.id;
    if (typeof repositoryId !== "string") fail("cannot resolve the repository GraphQL id", "GITHUB_API_FAILED");
    // The refreshed commit is intentionally based on the new frozen main, so
    // it is a sibling of the old bot commit. The beforeOid guard authenticates
    // the old managed head; force is restricted to this one bot ref.
    const response = graphql({ query: "mutation($repositoryId:ID!,$refUpdates:[RefUpdate!]!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:$refUpdates}){clientMutationId}}", variables: { repositoryId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid, afterOid, force: true }] } });
    if (response?.errors?.length || !response?.data?.updateRefs) fail("bot branch compare-and-swap was rejected", "CAS_CONFLICT");
    return response.data.updateRefs;
  };
  const api = (pathValue, method = undefined, body = undefined, { allowFailure = false } = {}) => {
    const prepared = apiArgs(method, apiPath(pathValue), body);
    return ghJson(prepared.args, { root, env, input: prepared.input, allowFailure });
  };
  const readFilesAt = async (headSha, paths, { allowMissing = false } = {}) => {
    requireSha(headSha, "commit SHA");
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((pathValue) => !safeRelativePath(pathValue))) fail("commit file paths are invalid", "PATH_INVALID");
    const tree = api(`/git/trees/${headSha}?recursive=1`);
    if (tree?.truncated === true) fail("managed branch tree is truncated", "HUMAN_BRANCH_EDIT");
    const entries = new Map((tree?.tree ?? []).filter((entry) => entry?.type === "blob" && typeof entry.path === "string").map((entry) => [entry.path, entry]));
    const files = {};
    for (const pathValue of paths) {
      const entry = entries.get(pathValue);
      if (!entry?.sha) {
        if (allowMissing) { files[pathValue] = null; continue; }
        fail(`managed branch output ${pathValue} is missing`, "HUMAN_BRANCH_EDIT");
      }
      if (entry.mode !== undefined && entry.mode !== "100644") fail(`managed branch output ${pathValue} is not a regular blob`, "HUMAN_BRANCH_EDIT");
      const blob = api(`/git/blobs/${entry.sha}`);
      if (blob?.encoding !== "base64" || typeof blob.content !== "string") fail(`managed branch output ${pathValue} is not a base64 blob`, "HUMAN_BRANCH_EDIT");
      const bytes = Buffer.from(blob.content.replace(/\s+/gu, ""), "base64");
      if (bytes.byteLength > MAX_JSON_BYTES) fail(`managed branch output ${pathValue} exceeds the bounded content limit`, "HUMAN_BRANCH_EDIT");
      files[pathValue] = bytes.toString("utf8");
    }
    return files;
  };
  const readBranchFiles = (headSha, paths) => readFilesAt(headSha, paths);
  return {
    async getBranchSha(branch = DEFAULT_BASE_BRANCH) {
      if (![DEFAULT_BASE_BRANCH, ...ALLOWED_BOT_BRANCHES].includes(branch)) fail("branch read is outside the fixed policy", "BRANCH_POLICY");
      const response = api(`/git/ref/heads/${branch}`, undefined, undefined, { allowFailure: true });
      if (response === null) return null;
      return responseSha(response.object ?? response, `${branch} ref SHA`);
    },
    async getMainSha() {
      return this.getBranchSha(DEFAULT_BASE_BRANCH);
    },
    async getPullRequest(number) {
      if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) fail("pull request number is invalid", "GITHUB_API_FAILED");
      const result = ghResult(["pr", "view", String(number), "--repo", repoValue, "--json", "number,state,merged,mergeCommit,headRefName,baseRefName,headRefOid,baseRefOid,headRepository,baseRepository,body"], { root, env });
      try {
        const value = JSON.parse(result.stdout);
        return {
          ...value,
          number: Number(value.number),
          head: { ref: value.headRefName, sha: value.headRefOid, repo: { full_name: value.headRepository?.full_name ?? value.headRepository?.fullName ?? value.headRepository?.nameWithOwner } },
          base: { ref: value.baseRefName, sha: value.baseRefOid, repo: { full_name: value.baseRepository?.full_name ?? value.baseRepository?.fullName ?? value.baseRepository?.nameWithOwner } },
        };
      } catch (error) { fail(`GitHub PR response was not valid JSON: ${error.message}`, "GITHUB_API_FAILED"); }
    },
    async getBranchMetadata(branch) {
      if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail("branch metadata read is outside the fixed policy", "BRANCH_POLICY");
      const ref = api(`/git/ref/heads/${branch}`);
      if (!ref) return null;
      const sha = responseSha(ref.object ?? ref, `${branch} ref SHA`);
      const commit = api(`/git/commits/${sha}`);
      const message = commit?.message ?? commit?.commit?.message ?? "";
      const parents = commit?.parents ?? commit?.commit?.parents ?? [];
      const metadata = {
        managedBy: parseTrailer(message, "Managed-By"),
        branch: parseTrailer(message, "Branch"),
        baseSha: parseTrailer(message, "Base-SHA"),
        expectedSourceSha: parseTrailer(message, "Source-SHA"),
        catalogDigest: parseTrailer(message, "Catalog-Digest"),
        configDigest: parseTrailer(message, "Config-Digest"),
        semanticFingerprint: parseTrailer(message, "Semantic-Fingerprint"),
        outputDigest: parseTrailer(message, "Output-Digest"),
        contentDigest: parseTrailer(message, "Content-Digest"),
        outputPaths: String(parseTrailer(message, "Output-Paths") ?? "").split(",").filter(Boolean),
        headSha: sha,
        parentSha: parents.length === 1 ? responseSha(parents[0], "managed bot branch parent SHA") : null,
      };
      if (parents.length !== 1 || metadata.parentSha !== metadata.baseSha) fail("managed bot branch parent does not match its frozen base provenance", "HUMAN_BRANCH_EDIT");
      const outputSet = metadata.managedBy === "erpc-sdk-data-maintenance" ? DATA_OUTPUT_SET : ALL_OUTPUT_SET;
      if (metadata.outputPaths.length === 0 || metadata.outputPaths.some((pathValue) => !outputSet.has(pathValue)) || new Set(metadata.outputPaths).size !== metadata.outputPaths.length || [...metadata.outputPaths].sort().join("\0") !== metadata.outputPaths.join("\0")) fail("managed bot branch declared output paths are invalid", "HUMAN_BRANCH_EDIT");
      const changedPaths = await this.getChangedPaths(branch, { baseSha: metadata.baseSha });
      if (changedPaths.some((pathValue) => !metadata.outputPaths.includes(pathValue))) fail("managed bot branch changed a path outside its declared output set", "HUMAN_BRANCH_EDIT");
      const files = await readBranchFiles(sha, metadata.outputPaths);
      metadata.actualOutputDigest = metadata.managedBy === "erpc-sdk-data-maintenance" ? dataOutputDigest(files) : outputDigest(files);
      metadata.actualContentDigest = contentDigest(files);
      if (metadata.actualOutputDigest !== metadata.outputDigest) fail("managed bot branch content differs from its recorded output digest", "HUMAN_BRANCH_EDIT");
      if (metadata.actualContentDigest !== metadata.contentDigest) fail("managed bot branch bytes differ from their recorded content digest", "HUMAN_BRANCH_EDIT");
      return metadata;
    },
    async getBranchFiles(branch, paths, { headSha = undefined } = {}) {
      if (!ALLOWED_BOT_BRANCHES.includes(branch) || !Array.isArray(paths) || paths.some((pathValue) => !safeRelativePath(pathValue))) fail("branch file read is outside the maintenance policy", "BRANCH_POLICY");
      const sha = headSha ?? await this.getBranchSha(branch);
      requireSha(sha, "managed branch head SHA");
      return readBranchFiles(sha, paths);
    },
    async getBaseFiles(baseSha, paths) {
      if (baseSha !== undefined) requireSha(baseSha, "candidate base SHA");
      if (!Array.isArray(paths) || paths.some((pathValue) => !safeRelativePath(pathValue))) fail("base file read is outside the maintenance policy", "BRANCH_POLICY");
      return readFilesAt(baseSha, paths, { allowMissing: true });
    },
    async getChangedPaths(branch, { baseSha, headSha = undefined } = {}) {
      if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail("branch diff is outside the fixed policy", "BRANCH_POLICY");
      requireSha(baseSha, "branch diff base SHA");
      const head = headSha ?? await this.getBranchSha(branch);
      requireSha(head, "branch diff head SHA");
      const response = api(`/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(head)}`);
      return (response?.files ?? []).map((file) => safeRelativePath(file.filename, "GitHub changed path"));
    },
    async commitFiles({ branch, parentSha, expectedOldSha = null, baseSha, files, message, metadata = undefined }) {
      if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail("cannot write an unapproved maintenance branch", "BRANCH_POLICY");
      requireSha(parentSha, "commit parent SHA");
      requireSha(baseSha, "commit base SHA");
      if (!files || typeof files !== "object" || Array.isArray(files)) fail("commit files must be an object", "ARTIFACT_INVALID");
      const entries = [];
      const parentCommit = api(`/git/commits/${parentSha}`);
      const baseTree = responseSha(parentCommit?.tree ?? parentCommit?.treeSha, "commit base tree SHA");
      for (const [pathValue, content] of Object.entries(files)) {
        const outputSet = metadata?.managedBy === "erpc-sdk-data-maintenance" ? DATA_OUTPUT_SET : ALL_OUTPUT_SET;
        if (!outputSet.has(pathValue)) fail(`commit path is outside the operational allowlist: ${pathValue}`, "EXACT_DIFF_ALLOWLIST");
        if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES) fail(`commit content for ${pathValue} is invalid or too large`, "ARTIFACT_TOO_LARGE");
        const blob = api("/git/blobs", "POST", { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
        entries.push({ path: pathValue, mode: "100644", type: "blob", sha: responseSha(blob, `${pathValue} blob SHA`) });
      }
      const tree = api("/git/trees", "POST", { base_tree: baseTree, tree: entries });
      const treeSha = responseSha(tree, "created tree SHA");
      const commit = api("/git/commits", "POST", { message, tree: treeSha, parents: [parentSha] });
      const commitSha = responseSha(commit, "created commit SHA");
      const current = await this.getBranchSha(branch);
      if ((expectedOldSha ?? null) !== (current ?? null)) fail("bot branch changed during commit compare-and-swap", "CAS_CONFLICT");
      const ref = current === null
        ? api("/git/refs", "POST", { ref: `refs/heads/${branch}`, sha: commitSha })
        : updateRefCas(branch, current, commitSha);
      return { ...commit, sha: commitSha, ref };
    },
    async listPullRequests({ head = BOT_BRANCH, base = DEFAULT_BASE_BRANCH } = {}) {
      if (!ALLOWED_BOT_BRANCHES.includes(head) || base !== DEFAULT_BASE_BRANCH) fail("pull request query is outside the maintenance policy", "BRANCH_POLICY");
      const result = ghResult(["pr", "list", "--repo", repoValue, "--state", "all", "--head", head, "--base", base, "--limit", "20", "--json", "number,state,headRefName,baseRefName,body,title"], { root, env });
      try { return JSON.parse(result.stdout); } catch (error) { fail(`GitHub PR list returned invalid JSON: ${error.message}`, "GITHUB_API_FAILED"); }
    },
    async createPullRequest({ title, body, head, base }) {
      if (!ALLOWED_BOT_BRANCHES.includes(head) || base !== DEFAULT_BASE_BRANCH) fail("pull request head/base is outside the maintenance policy", "BRANCH_POLICY");
      return ghResult(["pr", "create", "--repo", repoValue, "--title", title, "--head", head, "--base", base, "--body", body], { root, env }).stdout.trim();
    },
    async updatePullRequest(number, { title, body, head, base }) {
      if (!ALLOWED_BOT_BRANCHES.includes(head) || base !== DEFAULT_BASE_BRANCH) fail("pull request head/base is outside the maintenance policy", "BRANCH_POLICY");
      return ghResult(["pr", "edit", String(number), "--repo", repoValue, "--title", title, "--body", body], { root, env }).stdout.trim();
    },
    async dispatchWorkflow(workflow) {
      if (!ALLOWED_BOT_BRANCHES.includes(workflow.ref) || workflow.workflowPath !== WORKFLOW_PATH) fail("workflow dispatch is outside the maintenance policy", "WORKFLOW_POLICY");
      const response = api(`/actions/workflows/${encodeURIComponent(WORKFLOW_PATH)}/dispatches`, "POST", { ref: workflow.ref, inputs: workflow.inputs });
      const runId = responseValue(response, ["workflow_run_id", "workflowRunId", "run_id", "runId", "id"]);
      if (runId !== null && runId !== undefined) dispatchedRuns.set(String(runId), { expectedHeadSha: workflow.inputs.expected_head_sha, baseSha: workflow.inputs.base_sha, branch: workflow.ref });
      return response;
    },
    async verifyWorkflowRunHead(response, expectedHeadSha, expectedBaseSha, branch) {
      requireSha(expectedHeadSha, "workflow expected head SHA");
      requireSha(expectedBaseSha, "workflow expected base SHA");
      if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail("workflow verification branch is outside the policy", "WORKFLOW_POLICY");
      const runId = responseValue(response, ["workflow_run_id", "workflowRunId", "run_id", "runId", "id"]);
      if (runId === null || runId === undefined) fail("workflow dispatch response did not identify a run", "WORKFLOW_HEAD_MISMATCH");
      const dispatched = dispatchedRuns.get(String(runId));
      if (dispatched && (dispatched.expectedHeadSha !== expectedHeadSha || dispatched.baseSha !== expectedBaseSha || dispatched.branch !== branch)) fail("workflow dispatch provenance does not match verification request", "WORKFLOW_HEAD_MISMATCH");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const run = api(`/actions/runs/${encodeURIComponent(String(runId))}`);
        if (run) {
          const returnedId = responseValue(run, ["id", "workflow_run_id", "run_id", "runId"]);
          const returnedBase = run.inputs?.base_sha ?? run.base_sha ?? run.baseSha ?? response?.inputs?.base_sha ?? response?.base_sha;
          if (returnedId === null || returnedId === undefined || String(returnedId) !== String(runId)) fail("workflow API returned a different run identity", "WORKFLOW_HEAD_MISMATCH");
          if (run.head_sha !== expectedHeadSha || (run.head_branch !== undefined && run.head_branch !== branch) || (run.ref !== undefined && run.ref !== `refs/heads/${branch}`) || (run.event !== undefined && run.event !== "workflow_dispatch")) fail("workflow run does not match the dispatched bot commit/ref/event", "WORKFLOW_HEAD_MISMATCH");
          if (dispatched ? dispatched.baseSha !== expectedBaseSha : returnedBase !== expectedBaseSha) fail("workflow run is not associated with the requested frozen base", "WORKFLOW_HEAD_MISMATCH");
          return run;
        }
        if (attempt < 9) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      fail("dispatched workflow run head could not be verified", "WORKFLOW_HEAD_MISMATCH");
    },
    async getWorkflowRun(runId, expectedAttempt = undefined) {
      if (!Number.isSafeInteger(Number(runId)) || Number(runId) < 1) fail("workflow run ID is invalid", "GITHUB_API_FAILED");
      const run = api(`/actions/runs/${encodeURIComponent(String(runId))}`);
      const actualId = responseValue(run, ["id", "workflow_run_id", "run_id", "runId"]);
      const actualAttempt = responseValue(run, ["run_attempt", "runAttempt", "workflow_run_attempt", "workflowRunAttempt"]);
      if (String(actualId) !== String(runId) || !Number.isSafeInteger(Number(actualAttempt)) || (expectedAttempt !== undefined && Number(actualAttempt) !== Number(expectedAttempt))) fail("workflow run identity or attempt is not exact", "WORKFLOW_PROVENANCE_INVALID");
      const jobs = api(`/actions/runs/${encodeURIComponent(String(runId))}/jobs?per_page=100`);
      return { ...run, jobs: jobs?.jobs ?? [], run_attempt: Number(actualAttempt) };
    },
    async getMaintenanceObservation(runId, expectedAttempt = undefined, context = {}) {
      const run = await this.getWorkflowRun(runId, expectedAttempt);
      const actualRunId = run?.id ?? run?.run_id ?? run?.workflow_run_id ?? run?.runId;
      const actualAttempt = run?.run_attempt ?? run?.runAttempt ?? run?.workflow_run_attempt ?? run?.workflowRunAttempt;
      if (!Number.isSafeInteger(Number(actualRunId)) || Number(actualRunId) !== Number(runId) || !Number.isSafeInteger(Number(actualAttempt)) || (expectedAttempt !== undefined && Number(actualAttempt) !== Number(expectedAttempt))) fail("CI run identity is not exact", "WORKFLOW_PROVENANCE_INVALID");
      const runHead = run?.head_sha ?? run?.headSha;
      requireSha(runHead, "CI run head SHA");
      if (context.expectedHead !== undefined && runHead !== context.expectedHead) fail("CI run head does not match the requested PR head", "CI_HEAD_MISMATCH");
      if (run?.event !== "workflow_dispatch") fail("data maintenance CI run must be an explicit workflow_dispatch", "CI_EVENT_INVALID");
      const runWorkflow = run?.path ?? run?.workflowPath ?? run?.workflow_path;
      if (runWorkflow !== WORKFLOW_PATH) fail("CI run is not the managed data workflow", "CI_PROVENANCE_INVALID");
      const runBranch = run?.head_branch ?? run?.headBranch;
      if (runBranch !== BOT_BRANCH || run?.ref !== undefined && run.ref !== `refs/heads/${BOT_BRANCH}`) fail("CI run is not bound to the managed data branch", "CI_HEAD_MISMATCH");
      const runRepo = run?.repository?.full_name ?? run?.repository?.fullName ?? run?.head_repository?.full_name ?? run?.headRepository?.full_name;
      if (runRepo !== repoValue) fail("CI run repository is not the configured repository", "CI_PROVENANCE_INVALID");
      const artifacts = api(`/actions/runs/${encodeURIComponent(String(runId))}/artifacts?per_page=100`);
      const list = artifacts?.artifacts ?? [];
      if (!Array.isArray(list)) fail("GitHub artifacts response is invalid", "GITHUB_API_FAILED");
      const expectedName = `${DATA_CI_ARTIFACT_PREFIX}${runHead}-${Number(runId)}-${Number(actualAttempt)}`;
      const matches = list.filter((entry) => entry?.name === expectedName);
      if (matches.length === 0) return null;
      if (matches.length !== 1) fail("multiple exact CI maintenance artifacts were returned for the requested run", "CI_PROVENANCE_INVALID");
      const artifact = matches[0];
      if (artifact.expired === true) fail("exact CI maintenance artifact is expired", "CI_ARTIFACT_MISSING");
      const artifactRunId = artifact.workflow_run?.id ?? artifact.workflowRun?.id ?? artifact.workflow_run_id ?? artifact.workflowRunId;
      if (!Number.isSafeInteger(Number(artifactRunId)) || Number(artifactRunId) !== Number(runId)) fail("CI maintenance artifact is not bound to the requested run", "CI_PROVENANCE_INVALID");
      const artifactId = artifact.id;
      if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) < 1) fail("CI maintenance artifact ID is invalid", "CI_PROVENANCE_INVALID");
      const directory = mkdtempSync(join(tmpdir(), "erpc-maintenance-artifact-"));
      const zipPath = join(directory, "artifact.zip");
      try {
        ghBinary(["api", apiPath(`/actions/artifacts/${encodeURIComponent(String(artifactId))}/zip`), "--header", `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`], { root, env, outputPath: zipPath });
        const archiveSize = statSync(zipPath).size;
        if (!Number.isSafeInteger(archiveSize) || archiveSize <= 0 || archiveSize > MAX_CI_ARCHIVE_BYTES) fail("CI maintenance artifact compressed size is outside the fixed bound", "ARTIFACT_TOO_LARGE");
        const listing = archiveListing(zipPath);
        const exactEntries = [DATA_CI_OBSERVATION_ENTRY, DATA_CI_PROVENANCE_ENTRY].sort();
        if (listing.names.sort().join("\0") !== exactEntries.join("\0")) fail("CI maintenance artifact must contain exactly the bound observation and provenance entries", "CI_PROVENANCE_INVALID");
        const observationEntry = readArchiveJson(zipPath, DATA_CI_OBSERVATION_ENTRY, listing.sizes.get(DATA_CI_OBSERVATION_ENTRY));
        const provenanceEntry = readArchiveJson(zipPath, DATA_CI_PROVENANCE_ENTRY, listing.sizes.get(DATA_CI_PROVENANCE_ENTRY));
        const provenance = provenanceEntry.value;
        if (!provenance || typeof provenance !== "object" || Array.isArray(provenance) || provenance.kind !== "erpc-sdk-ci-provenance") fail("CI maintenance provenance artifact kind is invalid", "CI_PROVENANCE_INVALID");
        const provenanceHead = provenance.headSha ?? provenance.head_sha ?? provenance.testedHeadSha ?? provenance.tested_head_sha;
        const provenanceSource = provenance.sourceSha ?? provenance.source_sha;
        const provenanceBase = provenance.baseSha ?? provenance.base_sha;
        const provenanceWorkflow = provenance.workflowPath ?? provenance.workflow_path ?? provenance.workflow;
        const provenanceRun = provenance.runId ?? provenance.run_id ?? provenance.workflowRunId ?? provenance.workflow_run_id;
        const provenanceAttempt = provenance.runAttempt ?? provenance.run_attempt ?? provenance.workflowRunAttempt ?? provenance.workflow_run_attempt;
        const provenanceEvent = provenance.event ?? provenance.eventName;
        const observationDigest = provenance.observationSha256 ?? provenance.observationSHA256 ?? provenance.observationDigest ?? provenance.observationSha;
        const observationLength = provenance.observationByteLength ?? provenance.observationBytes ?? provenance.observationLength;
        requireSha(provenanceHead, "CI provenance head SHA");
        requireSha(provenanceSource, "CI provenance source SHA");
        requireSha(provenanceBase, "CI provenance base SHA");
        if (provenanceHead !== runHead || provenanceSource !== runHead || provenanceWorkflow !== WORKFLOW_PATH || Number(provenanceRun) !== Number(runId) || Number(provenanceAttempt) !== Number(actualAttempt) || provenanceEvent !== "workflow_dispatch" || provenance.ref !== undefined && provenance.ref !== `refs/heads/${BOT_BRANCH}`) fail("CI provenance artifact does not identify the exact run/head/workflow", "CI_PROVENANCE_INVALID");
        if (context.expectedBase !== undefined && provenanceBase !== context.expectedBase) fail("CI provenance artifact base SHA does not match the requested base", "CI_BASE_MISMATCH");
        if (typeof observationDigest !== "string" || !DIGEST_RE.test(observationDigest) || observationDigest !== createHash("sha256").update(observationEntry.bytes).digest("hex")) fail("CI provenance artifact does not bind the original observation bytes", "CI_PROVENANCE_INVALID");
        if (!Number.isSafeInteger(observationLength) || observationLength !== observationEntry.bytes.byteLength) fail("CI provenance artifact observation byte length is invalid", "CI_PROVENANCE_INVALID");
        return { run, observation: observationEntry.value, provenance };
      } finally {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort cleanup of this exact temporary directory */ }
      }
    },
    async getCommit(commitSha) {
      requireSha(commitSha, "commit SHA");
      const commit = api(`/git/commits/${encodeURIComponent(commitSha)}`);
      return { ...commit, sha: commit?.sha ?? commitSha, parents: commit?.parents ?? [], tree: commit?.tree ?? { sha: commit?.treeSha } };
    },
    async getMergePolicy({ base = DEFAULT_BASE_BRANCH } = {}) {
      if (base !== DEFAULT_BASE_BRANCH) fail(`merge policy base must be ${DEFAULT_BASE_BRANCH}`, "BRANCH_POLICY");
      const protection = api(`/branches/${encodeURIComponent(base)}/protection`, undefined, undefined, { allowFailure: true });
      const rules = api(`/rulesets?includes_parents=true`, undefined, undefined, { allowFailure: true });
      const requiredChecks = protection?.required_status_checks?.contexts ?? protection?.required_status_checks?.checks?.map((check) => check.context ?? check.name) ?? [];
      const strict = protection?.required_status_checks?.strict === true;
      const protectedBranch = protection !== null && protection !== undefined;
      const matchingRule = Array.isArray(rules) ? rules.find((rule) => rule?.target === "branch" && rule?.enforcement === "active" && (!rule.conditions?.ref_name?.include || rule.conditions.ref_name.include.some((pattern) => pattern === "refs/heads/main" || pattern === "~DEFAULT_BRANCH"))) : null;
      // A list endpoint's ruleset summary does not prove that this actor is
      // subject to the rule or that the rule covers main.  The supported
      // automatic path therefore requires classic branch protection with
      // enforce-admins enabled; an unrelated ruleset can never authorize it.
      const actorAllowed = protectedBranch && protection?.enforce_admins?.enabled === true;
      return { protected: protectedBranch, strict, upToDate: protection?.required_status_checks?.strict === true, actorAllowed, requiredChecks, ruleset: matchingRule };
    },
    async mergePullRequest({ number, expectedHead, expectedBase } = {}) {
      if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) fail("merge pull request number is invalid", "GITHUB_API_FAILED");
      requireSha(expectedHead, "merge expected head SHA");
      requireSha(expectedBase, "merge expected base SHA");
      // The REST merge endpoint accepts `sha` and therefore atomically binds
      // the merge request to the exact managed PR head. `gh pr merge` without
      // --match-head-commit can merge a newer human commit after a race.
      const response = api(`/pulls/${encodeURIComponent(String(number))}/merge`, "PUT", { sha: expectedHead, merge_method: "merge" });
      if (response?.merged !== true) fail("GitHub refused the exact-head PR merge", "MERGE_HEAD_MISMATCH");
      const mergeSha = response?.merge_commit_sha ?? response?.mergeCommitSha ?? response?.sha;
      requireSha(mergeSha, "GitHub merge commit SHA");
      return { ...response, sha: mergeSha, expectedBase };
    },
    async findWorkflowRun(expectedHeadSha, branch) {
      requireSha(expectedHeadSha, "workflow expected head SHA");
      if (!ALLOWED_BOT_BRANCHES.includes(branch)) fail("workflow lookup branch is outside the policy", "WORKFLOW_POLICY");
      const runs = api(`/actions/workflows/${encodeURIComponent(WORKFLOW_PATH)}/runs?event=workflow_dispatch&per_page=20`);
      return runs?.workflow_runs?.find((run) => run.head_sha === expectedHeadSha && (run.head_branch === branch || run.ref === `refs/heads/${branch}`)) ?? null;
    },
  };
}

export function parseArguments(argumentsList = process.argv.slice(2)) {
  const options = { observation: null, release: null, baseSha: null, sourceSha: null, catalogDigest: null, configDigest: null, repo: null, root: REPOSITORY_ROOT, dryRun: true, noDispatch: false, format: "text", help: false };
  const args = [...argumentsList];
  const seen = new Set();
  if (args[0] === "--") args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") { options.help = true; continue; }
    const value = args[index + 1];
    const valueOptions = { "--observation": "observation", "--release": "release", "--base-sha": "baseSha", "--source-sha": "sourceSha", "--catalog-digest": "catalogDigest", "--config-digest": "configDigest", "--repo": "repo", "--root": "root" };
    if (Object.hasOwn(valueOptions, key)) {
      if (seen.has(key) || value === undefined || value.startsWith("--")) fail(`${key} requires one value`, "USAGE");
      seen.add(key); options[valueOptions[key]] = value; index += 1; continue;
    }
    if (key === "--write") { options.dryRun = false; continue; }
    if (key === "--no-dispatch") { options.noDispatch = true; continue; }
    if (key === "--format=json") { options.format = "json"; continue; }
    if (key === "--format" && value === "json") { options.format = "json"; index += 1; continue; }
    fail(`unknown option ${key}`, "USAGE");
  }
  if (options.help) return options;
  if (options.observation === null || options.baseSha === null || options.sourceSha === null || options.catalogDigest === null) fail("--observation, --base-sha, --source-sha, and --catalog-digest are required", "USAGE");
  return options;
}

export function usage() {
  return "Usage: node registry/maintenance-pr.mjs --observation PATH --base-sha SHA --source-sha SHA --catalog-digest SHA [--config-digest SHA] [--release PATH] [--write] [--no-dispatch] [--format=json]";
}

export async function run(argumentsList = process.argv.slice(2)) {
  if (["collect", "replay", "write-pr", "promote", "verify-merged"].includes(argumentsList[0])) {
    // M2 uses a separate data envelope and exact generated-output allowlist;
    // keep the historical observer writer below intact for legacy workflows.
    const dataModule = await import("./data-promotion.mjs");
    return dataModule.run(argumentsList);
  }
  const options = parseArguments(argumentsList);
  if (options.help) { process.stdout.write(`${usage()}\n`); return null; }
  const root = resolve(options.root);
  const state = readTrustedState(root);
  const observation = readBoundedJson(resolve(options.observation), "same-run observation");
  const release = options.release ? readBoundedJson(resolve(options.release), "same-run release report", MAX_RELEASE_BYTES) : null;
  const payload = buildMaintenancePayload({ observation, releaseReport: release, baseSha: options.baseSha, expectedSourceSha: options.sourceSha, catalogDigest: options.catalogDigest, configDigest: options.configDigest ?? undefined, root, trustedState: state });
  let result = { ...payload, writer: { dryRun: options.dryRun, noDispatch: options.noDispatch, branch: payload.branch } };
  if (!options.dryRun) {
    const adapter = createGhAdapter({ repo: options.repo ?? process.env.GITHUB_REPOSITORY, root });
    const writeResult = await writeMaintenancePr({ adapter, payload, frozenMainSha: options.baseSha, dryRun: false, dispatch: !options.noDispatch });
    result = { ...result, result: writeResult };
  }
  if (options.format === "json") process.stdout.write(`${JSON.stringify(redactSecrets(result), null, 2)}\n`);
  else process.stdout.write(`${result.result?.status ?? (payload.actionRequired ? "READY" : "NO_ACTION")}: ${payload.branch} ${payload.semanticFingerprint}\n`);
  return result;
}

// Re-export the M2 controller surface from the established maintenance entry
// point so workflow callers do not need to know which policy module owns a
// particular stage.
export {
  buildDataCandidate,
  collectMaintenanceObservation,
  promoteDataCandidate,
  replayMaintenanceObservation,
  verifyDataCi,
  verifyMergedCandidate,
  writeDataMaintenancePr,
};

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath !== null && import.meta.url === invokedPath) {
  try { process.exitCode = 0; await run(); } catch (error) {
    process.stderr.write(`maintenance-pr: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = error.code === "USAGE" ? 64 : 1;
  }
}
