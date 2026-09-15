#!/usr/bin/env node

/*
 * Resolve the catalog baseline for a pull-request CI run.
 *
 * The baseline is always read from the validated PR base commit. A checkout's
 * current HEAD is useful for ancestry checks, but is never silently used as a
 * baseline. Every ref is passed to git as an argument after strict SHA
 * validation, so this helper is safe to call from a workflow with untrusted
 * event data.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeDigest, validateCatalog } from "./token-catalog.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");
export const CATALOG_PATH = "registry/token-catalog.json";
export const BASELINE_SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/u;

export const BASELINE_STATUS = Object.freeze({
  OK: "OK",
  BASELINE_MISMATCH: "BASELINE_MISMATCH",
  CURRENT_AS_BASELINE: "CURRENT_AS_BASELINE",
  MISSING_HISTORY: "MISSING_HISTORY",
  NOT_ANCESTOR: "NOT_ANCESTOR",
  INVALID_CATALOG: "INVALID_CATALOG",
  INVALID_INPUT: "INVALID_INPUT",
});

function failure(message, code = BASELINE_STATUS.INVALID_INPUT) {
  const error = new Error(message);
  error.name = "CatalogBaselineError";
  error.code = code;
  throw error;
}

export function validateSha(value, label = "commit SHA") {
  if (typeof value !== "string" || !SHA_RE.test(value)) failure(`${label} must be a 40-character lowercase commit SHA`);
  return value;
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
  if (result.error && !allowFailure) failure(`git ${args.join(" ")} failed: ${result.error.message}`, BASELINE_STATUS.MISSING_HISTORY);
  if (result.status !== 0 && !allowFailure) failure(`git ${args.join(" ")} failed: ${String(result.stderr).trim() || `exit ${result.status}`}`, BASELINE_STATUS.MISSING_HISTORY);
  return result;
}

function resultText(result) {
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

export function verifyGitObject(commitSha, { root = REPOSITORY_ROOT, runner = defaultRunner } = {}) {
  validateSha(commitSha);
  const result = runGit(root, ["cat-file", "-e", `${commitSha}^{commit}`], runner, { allowFailure: true });
  if (result.status !== 0) failure(`git commit object is unavailable: ${commitSha}`, BASELINE_STATUS.MISSING_HISTORY);
  return true;
}

export function verifyAncestor(ancestorSha, descendantSha, { root = REPOSITORY_ROOT, runner = defaultRunner } = {}) {
  validateSha(ancestorSha, "ancestor SHA");
  validateSha(descendantSha, "descendant SHA");
  verifyGitObject(ancestorSha, { root, runner });
  verifyGitObject(descendantSha, { root, runner });
  const result = runGit(root, ["merge-base", "--is-ancestor", ancestorSha, descendantSha], runner, { allowFailure: true });
  if (result.status !== 0) failure(`${ancestorSha} is not an ancestor of ${descendantSha}`, BASELINE_STATUS.NOT_ANCESTOR);
  return true;
}

export function currentHead({ root = REPOSITORY_ROOT, runner = defaultRunner } = {}) {
  const result = runGit(root, ["rev-parse", "HEAD"], runner);
  return validateSha(resultText(result), "current HEAD");
}

function catalogFromJson(source, label) {
  let catalog;
  try { catalog = JSON.parse(source); } catch (error) { failure(`cannot parse ${label} as JSON: ${error.message}`, BASELINE_STATUS.INVALID_CATALOG); }
  try { validateCatalog(catalog); } catch (error) { failure(`${label} failed catalog validation: ${error.message}`, BASELINE_STATUS.INVALID_CATALOG); }
  return catalog;
}

export function readCatalogAtCommit(commitSha, { root = REPOSITORY_ROOT, runner = defaultRunner } = {}) {
  validateSha(commitSha, "catalog commit SHA");
  verifyGitObject(commitSha, { root, runner });
  const result = runGit(root, ["show", `${commitSha}:${CATALOG_PATH}`], runner, { allowFailure: true });
  if (result.status !== 0 || !String(result.stdout).trim()) failure(`catalog is unavailable at validated commit ${commitSha}`, BASELINE_STATUS.MISSING_HISTORY);
  return catalogFromJson(result.stdout, `${CATALOG_PATH}@${commitSha}`);
}

export function validateBaselineBinding({ baseSha, pushBeforeSha, dispatchBaseSha, expectedBaseSha = baseSha } = {}) {
  const values = { baseSha, pushBeforeSha, dispatchBaseSha, expectedBaseSha };
  for (const [label, value] of Object.entries(values)) validateSha(value, label);
  const unique = new Set(Object.values(values));
  if (unique.size !== 1) failure(`catalog baseline refs must agree: ${Object.entries(values).map(([label, value]) => `${label}=${value}`).join(", ")}`, BASELINE_STATUS.BASELINE_MISMATCH);
  return true;
}

function semanticBindingDigest(value) {
  return createHash("sha256").update(JSON.stringify({
    baseSha: value.baseSha,
    pushBeforeSha: value.pushBeforeSha,
    dispatchBaseSha: value.dispatchBaseSha,
    headSha: value.headSha,
    catalogDigest: value.catalogDigest,
  })).digest("hex");
}

export function resolveCatalogBaseline({
  root = REPOSITORY_ROOT,
  baseSha,
  pushBeforeSha,
  dispatchBaseSha,
  expectedBaseSha = baseSha,
  headSha,
  currentSha,
  runner = defaultRunner,
} = {}) {
  validateBaselineBinding({ baseSha, pushBeforeSha, dispatchBaseSha, expectedBaseSha });
  const baselineSha = validateSha(baseSha, "base SHA");
  const resolvedHead = validateSha(headSha ?? currentSha ?? currentHead({ root, runner }), "PR head SHA");
  if (baselineSha === resolvedHead) failure("current HEAD cannot be used as the catalog baseline", BASELINE_STATUS.CURRENT_AS_BASELINE);
  const checkoutHead = currentHead({ root, runner });
  if (baselineSha === checkoutHead) failure("checkout HEAD cannot be used as the catalog baseline", BASELINE_STATUS.CURRENT_AS_BASELINE);
  verifyGitObject(baselineSha, { root, runner });
  verifyGitObject(resolvedHead, { root, runner });
  verifyAncestor(baselineSha, resolvedHead, { root, runner });
  const catalog = readCatalogAtCommit(baselineSha, { root, runner });
  const catalogDigest = computeDigest(catalog);
  return Object.freeze({
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: "validated-catalog-baseline",
    baselinePath: CATALOG_PATH,
    baseSha: baselineSha,
    pushBeforeSha: pushBeforeSha,
    dispatchBaseSha: dispatchBaseSha,
    expectedBaseSha,
    headSha: resolvedHead,
    catalogVersion: catalog.catalogVersion,
    catalogAsOfDate: catalog.manualAsOf,
    catalogDigest,
    assetCount: catalog.assets.length,
    deploymentCount: catalog.deployments.length,
    aliasCount: catalog.aliases.length,
    bindingDigest: semanticBindingDigest({ baseSha: baselineSha, pushBeforeSha, dispatchBaseSha, headSha: resolvedHead, catalogDigest }),
  });
}

export const resolveBaseline = resolveCatalogBaseline;
export const loadCatalogBaseline = resolveCatalogBaseline;
export const assertBaselineBinding = validateBaselineBinding;

function parseArguments(argumentsList = process.argv.slice(2)) {
  const options = { baseSha: null, pushBeforeSha: null, dispatchBaseSha: null, expectedBaseSha: null, headSha: null, root: REPOSITORY_ROOT, format: "text" };
  const args = [...argumentsList];
  if (args[0] === "--") args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (["--base-sha", "--push-before-sha", "--dispatch-base-sha", "--expected-base-sha", "--head-sha", "--root"].includes(key)) {
      if (value === undefined || value.startsWith("--")) failure(`${key} requires one value`);
      const name = { "--base-sha": "baseSha", "--push-before-sha": "pushBeforeSha", "--dispatch-base-sha": "dispatchBaseSha", "--expected-base-sha": "expectedBaseSha", "--head-sha": "headSha", "--root": "root" }[key];
      if (options[name] !== null && options[name] !== REPOSITORY_ROOT) failure(`${key} may be provided only once`);
      options[name] = value;
      index += 1;
      continue;
    }
    if (key === "--format=json" || key === "--json") { options.format = "json"; continue; }
    if (key === "--format" && value === "json") { options.format = "json"; index += 1; continue; }
    if (key === "--help") return { ...options, help: true };
    failure(`unknown option ${key}`);
  }
  if (options.baseSha === null || options.pushBeforeSha === null || options.dispatchBaseSha === null) failure("--base-sha, --push-before-sha, and --dispatch-base-sha are required");
  if (options.expectedBaseSha === null) options.expectedBaseSha = options.baseSha;
  if (options.headSha === null) failure("--head-sha is required; the helper never falls back to current HEAD as a baseline");
  validateBaselineBinding(options);
  validateSha(options.headSha, "--head-sha");
  return options;
}

export function usage() {
  return "Usage: node registry/ci-catalog-baseline.mjs --base-sha SHA --push-before-sha SHA --dispatch-base-sha SHA --head-sha SHA [--expected-base-sha SHA] [--format=json|--json] [--root DIR]";
}

export function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) { process.stdout.write(`${usage()}\n`); return null; }
  const report = resolveCatalogBaseline(options);
  if (options.format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`OK: ${report.baseSha} catalog ${report.catalogDigest} (${report.assetCount} assets, ${report.deploymentCount} deployments)\n`);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath !== null && import.meta.url === invokedPath) {
  try { run(); } catch (error) {
    process.stderr.write(`ci-catalog-baseline: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  }
}
