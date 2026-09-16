#!/usr/bin/env node

/*
 * Read-only trusted-main reconciliation for the two maintenance controllers.
 *
 * This selector only proves that a current main checkout has one exact,
 * authenticated candidate and one latest successful CI run.  The optional
 * dispatch asks the receiving workflow to perform its own full replay and
 * protected-main checks; this module never merges or writes a branch.
 */

import { existsSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANDIDATE_OUTPUT_PATHS,
  computeOutputDigest,
} from "./data-promotion.mjs";
import {
  createGhAdapter,
  DATA_CI_ARTIFACT_PREFIX,
} from "./maintenance-pr.mjs";
import { PACKAGE_VERSION_PATHS } from "./release-prep.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");

export const RECONCILE_SCHEMA_VERSION = 1;
export const RECONCILE_KIND = "erpc-sdk-maintenance-reconciliation";
export const MAIN_BRANCH = "main";
export const DATA_BRANCH = "codex/registry-maintenance";
export const RELEASE_BRANCH = "codex/release-preparation";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const DATA_CONTROLLER_WORKFLOW_PATH = ".github/workflows/data-promotion.yml";
export const RELEASE_CONTROLLER_WORKFLOW_PATH = ".github/workflows/release-preparation.yml";
export const DATA_MANAGED_BY = "erpc-sdk-data-maintenance";
export const RELEASE_MANAGED_BY = "erpc-sdk-weekly-maintenance";
export const DATA_OUTPUT_PATHS = Object.freeze([...CANDIDATE_OUTPUT_PATHS]);
export const RELEASE_OUTPUT_PATHS = Object.freeze([...PACKAGE_VERSION_PATHS, "CHANGELOG.md"].sort());
export const DATA_CI_SOURCE_ARTIFACT_PREFIX = "ci-source-binding-";
export const DATA_CONTROLLER_RUN_PREFIX = "erpc-data-ci";
export const RELEASE_CONTROLLER_RUN_PREFIX = "erpc-release-ci";
export const REQUIRED_CI_JOBS = Object.freeze(["required-ci"]);

const SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ACTIVE_RUN_STATES = new Set(["queued", "requested", "waiting", "pending", "in_progress", "in-progress"]);
const COMPLETED_RUN_STATES = new Set(["completed", "done"]);
const MAX_GH_OUTPUT_BYTES = 4 * 1024 * 1024;

function fail(message, code = "RECONCILE_INVALID") {
  const error = new Error(message);
  error.name = "MaintenanceReconcileError";
  error.code = code;
  throw error;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase SHA`, "RECONCILE_INVALID");
  return value;
}

function repositoryName(value) {
  if (typeof value === "string") return value;
  return value?.full_name ?? value?.fullName ?? value?.nameWithOwner ?? value?.name_with_owner ?? null;
}

function requireRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail("--repo must be owner/name", "USAGE");
  return value;
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (objectValue(value)?.items && Array.isArray(value.items)) return value.items;
  if (objectValue(value)?.workflow_runs && Array.isArray(value.workflow_runs)) return value.workflow_runs;
  if (objectValue(value)?.artifacts && Array.isArray(value.artifacts)) return value.artifacts;
  return [];
}

function branchHead(value) {
  return value?.sha ?? value?.headSha ?? value?.head_sha ?? value?.head?.sha ?? null;
}

function branchRef(value) {
  return value?.ref ?? value?.branch ?? value?.headRef ?? value?.head_ref ?? value?.headRefName ?? null;
}

function pullHeadRef(value) {
  return value?.head?.ref ?? value?.headRef ?? value?.head_ref ?? value?.headRefName ?? null;
}

function pullBaseRef(value) {
  return value?.base?.ref ?? value?.baseRef ?? value?.base_ref ?? value?.baseRefName ?? null;
}

function pullHeadSha(value) {
  return value?.head?.sha ?? value?.headSha ?? value?.head_sha ?? value?.headRefOid ?? value?.head_ref_oid ?? null;
}

function pullBaseSha(value) {
  return value?.base?.sha ?? value?.baseSha ?? value?.base_sha ?? value?.baseRefOid ?? value?.base_ref_oid ?? null;
}

function pullState(value) {
  return String(value?.state ?? "").toLowerCase();
}

function sameRepository(value, repository) {
  const head = repositoryName(value?.headRepository ?? value?.head_repository ?? value?.head?.repo);
  const base = repositoryName(value?.baseRepository ?? value?.base_repository ?? value?.base?.repo);
  return value?.isCrossRepository !== true && head === repository && base === repository;
}

function runRepository(value) {
  return repositoryName(value?.repository ?? value?.head_repository ?? value?.headRepository);
}

function runPath(value) {
  return value?.path ?? value?.workflowPath ?? value?.workflow_path ?? null;
}

function runEvent(value) {
  return value?.event ?? value?.eventName ?? null;
}

function runHead(value) {
  return value?.head_sha ?? value?.headSha ?? value?.head?.sha ?? null;
}

function runBranch(value) {
  const branch = value?.head_branch ?? value?.headBranch;
  return branch ?? (value?.ref === `refs/heads/${MAIN_BRANCH}` ? MAIN_BRANCH : value?.ref ?? null);
}

function runId(value) {
  const result = value?.id ?? value?.runId ?? value?.run_id ?? value?.workflow_run_id ?? value?.workflowRunId ?? value?.workflow_run?.id ?? value?.workflowRun?.id ?? null;
  return Number.isSafeInteger(Number(result)) && Number(result) > 0 ? Number(result) : null;
}

function runAttempt(value) {
  const result = value?.run_attempt ?? value?.runAttempt ?? value?.attempt ?? value?.workflow_run_attempt ?? value?.workflowRunAttempt ?? null;
  return Number.isSafeInteger(Number(result)) && Number(result) > 0 ? Number(result) : null;
}

function runStatus(value) {
  return String(value?.status ?? "").toLowerCase();
}

function runConclusion(value) {
  return String(value?.conclusion ?? "").toLowerCase();
}

function runName(value) {
  return value?.display_title ?? value?.displayTitle ?? value?.name ?? value?.runName ?? value?.run_name ?? null;
}

function runSort(left, right) {
  const idOrder = (runId(right) ?? 0) - (runId(left) ?? 0);
  if (idOrder !== 0) return idOrder;
  const attemptOrder = (runAttempt(right) ?? 0) - (runAttempt(left) ?? 0);
  if (attemptOrder !== 0) return attemptOrder;
  const rightTime = Date.parse(right?.updated_at ?? right?.updatedAt ?? right?.created_at ?? right?.createdAt ?? "") || 0;
  const leftTime = Date.parse(left?.updated_at ?? left?.updatedAt ?? left?.created_at ?? left?.createdAt ?? "") || 0;
  return rightTime - leftTime;
}

function normalizeChangedPaths(value) {
  const paths = Array.isArray(value) ? value : value?.paths ?? value?.files?.map((entry) => entry?.filename) ?? null;
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string")) fail("adapter changed paths are invalid", "RECONCILE_READ_FAILED");
  const sorted = [...paths].sort();
  if (new Set(sorted).size !== sorted.length) fail("adapter changed paths contain duplicates", "RECONCILE_READ_FAILED");
  return sorted;
}

function exactPathSet(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry) => typeof entry !== "string")) return false;
  return [...value].sort().join("\0") === expected.join("\0") && new Set(value).size === value.length;
}

function exactFileMap(value, expected) {
  if (!objectValue(value) || Object.keys(value).sort().join("\0") !== expected.join("\0")) return false;
  return expected.every((pathValue) => typeof value[pathValue] === "string");
}

function artifactName(value) {
  return typeof value === "string" ? value : value?.name ?? null;
}

function artifactRunId(value) {
  const result = value?.workflow_run?.id ?? value?.workflowRun?.id ?? value?.workflow_run_id ?? value?.workflowRunId;
  return result === undefined || result === null ? null : Number(result);
}

function exactArtifact(artifacts, expectedName, expectedRunId) {
  return artifacts.filter((entry) => artifactName(entry) === expectedName && entry?.expired !== true && artifactRunId(entry) === expectedRunId);
}

function controllerRunName(kind, id, attempt, head, apply) {
  const prefix = kind === "data" ? DATA_CONTROLLER_RUN_PREFIX : RELEASE_CONTROLLER_RUN_PREFIX;
  return `${prefix}-${id}-${attempt}-${head}-${apply ? "apply" : "verify"}`;
}

function controllerWorkflowPath(kind) {
  return kind === "data" ? DATA_CONTROLLER_WORKFLOW_PATH : RELEASE_CONTROLLER_WORKFLOW_PATH;
}

function isMainRun(value) {
  const ref = value?.head_branch ?? value?.headBranch ?? value?.ref ?? null;
  return ref === MAIN_BRANCH || ref === `refs/heads/${MAIN_BRANCH}`;
}

function fixedReason(reason, extra = {}) {
  return { status: "SKIP", reason, ...extra };
}

function currentHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 1024 });
  if (result.error || result.status !== 0) fail("trusted-main checkout HEAD could not be read", "TRUSTED_MAIN_INVALID");
  return requireSha(String(result.stdout ?? "").trim(), "trusted-main checkout HEAD");
}

function ghJson(repo, args, { root, env, input = undefined } = {}) {
  const result = spawnSync("gh", args, { cwd: root, env, input, encoding: "utf8", stdio: "pipe", maxBuffer: MAX_GH_OUTPUT_BYTES });
  if (result.error || result.status !== 0) fail("trusted GitHub read failed", "GITHUB_READ_FAILED");
  try { return JSON.parse(String(result.stdout ?? "")); } catch { fail("trusted GitHub read returned invalid JSON", "GITHUB_READ_FAILED"); }
}

function createReconcileAdapter({ repo, root, env }) {
  const base = createGhAdapter({ repo, root, env });
  const apiHeader = "X-GitHub-Api-Version: 2026-03-10";
  return {
    ...base,
    async listWorkflowRuns({ workflowPath, branch, event = undefined } = {}) {
      const query = new URLSearchParams({ branch, per_page: "100" });
      if (event !== undefined) query.set("event", event);
      const pathValue = `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowPath)}/runs?${query.toString()}`;
      return asArray(ghJson(repo, ["api", pathValue, "--header", apiHeader], { root, env }));
    },
    async listWorkflowArtifacts(workflowRunId) {
      const id = Number(workflowRunId);
      if (!Number.isSafeInteger(id) || id < 1) fail("workflow run ID is invalid", "RECONCILE_INVALID");
      const pathValue = `/repos/${repo}/actions/runs/${id}/artifacts?per_page=100`;
      return asArray(ghJson(repo, ["api", pathValue, "--header", apiHeader], { root, env }));
    },
    async dispatchController({ workflowPath, ref = MAIN_BRANCH, inputs } = {}) {
      if (ref !== MAIN_BRANCH || !objectValue(inputs)) fail("controller dispatch must target main", "RECONCILE_INVALID");
      const pathValue = `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowPath)}/dispatches`;
      const body = JSON.stringify({ ref, inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value)])) });
      const response = ghJson(repo, ["api", pathValue, "--method", "POST", "--header", apiHeader, "--input", "-"], { root, env, input: `${body}\n` });
      const responseId = runId(response);
      if (responseId === null) fail("controller dispatch did not return a workflow run ID", "DISPATCH_INVALID");
      return { ...response, workflowRunId: responseId };
    },
  };
}

function validateBranchMetadata(metadata, { kind, branch, headSha, expectedMainSha }) {
  const expectedManagedBy = kind === "data" ? DATA_MANAGED_BY : RELEASE_MANAGED_BY;
  const expectedPaths = kind === "data" ? DATA_OUTPUT_PATHS : RELEASE_OUTPUT_PATHS;
  if (!objectValue(metadata) || metadata.managedBy !== expectedManagedBy || metadata.branch !== branch) return "BRANCH_METADATA_INVALID";
  if (metadata.baseSha !== expectedMainSha || metadata.parentSha !== expectedMainSha || metadata.headSha !== headSha) return "BRANCH_PROVENANCE_STALE";
  if (metadata.expectedSourceSha !== undefined && metadata.sourceSha !== undefined && metadata.expectedSourceSha !== metadata.sourceSha) return "BRANCH_SOURCE_STALE";
  const sourceSha = metadata.expectedSourceSha ?? metadata.sourceSha;
  if (sourceSha !== expectedMainSha || !SHA_RE.test(String(sourceSha))) return "BRANCH_SOURCE_STALE";
  if (!exactPathSet(metadata.outputPaths, expectedPaths)) return "BRANCH_OUTPUT_PATHS_INVALID";
  for (const key of ["semanticFingerprint", "outputDigest", "contentDigest"]) if (typeof metadata[key] !== "string" || !/^[0-9a-f]{64}$/u.test(metadata[key])) return "BRANCH_METADATA_INVALID";
  if (metadata.actualOutputDigest !== undefined && metadata.actualOutputDigest !== metadata.outputDigest) return "BRANCH_OUTPUT_DIGEST_INVALID";
  if (metadata.actualContentDigest !== undefined && metadata.actualContentDigest !== metadata.contentDigest) return "BRANCH_CONTENT_DIGEST_INVALID";
  return null;
}

async function inspectCi(adapter, { kind, branch, headSha, repository }) {
  if (typeof adapter.listWorkflowRuns !== "function") return fixedReason("CI_RUNS_UNAVAILABLE");
  const workflowRuns = asArray(await adapter.listWorkflowRuns({ workflowPath: CI_WORKFLOW_PATH, branch, event: "workflow_dispatch" }));
  const matches = workflowRuns.filter((run) => runPath(run) === CI_WORKFLOW_PATH
    && runEvent(run) === "workflow_dispatch"
    && runBranch(run) === branch
    && runHead(run) === headSha
    && runRepository(run) === repository);
  if (matches.length === 0) return fixedReason("CI_RUN_ABSENT");
  const identities = new Set(matches.map((run) => `${runId(run)}\0${runAttempt(run)}`));
  if (identities.size !== matches.length) return fixedReason("CI_RUN_AMBIGUOUS");
  matches.sort(runSort);
  const listed = matches[0];
  const id = runId(listed);
  const attempt = runAttempt(listed);
  if (id === null || attempt === null) return fixedReason("CI_RUN_BINDING_INVALID");
  let run = listed;
  if (typeof adapter.getWorkflowRun === "function") {
    const fetched = await adapter.getWorkflowRun(id, attempt);
    if (runId(fetched) !== id || runAttempt(fetched) !== attempt) return fixedReason("CI_RUN_BINDING_INVALID", { runId: id, runAttempt: attempt });
    run = { ...listed, ...fetched };
  }
  if (runPath(run) !== CI_WORKFLOW_PATH || runEvent(run) !== "workflow_dispatch" || runBranch(run) !== branch || runHead(run) !== headSha || runRepository(run) !== repository) return fixedReason("CI_RUN_BINDING_INVALID", { runId: id, runAttempt: attempt });
  const status = runStatus(run);
  const conclusion = runConclusion(run);
  if (!COMPLETED_RUN_STATES.has(status)) return fixedReason(ACTIVE_RUN_STATES.has(status) ? "CI_RUN_PENDING" : "CI_RUN_FAILED", { runId: id, runAttempt: attempt, status, conclusion });
  if (conclusion !== "success") return fixedReason("CI_RUN_FAILED", { runId: id, runAttempt: attempt, status, conclusion });
  const jobs = Array.isArray(run.jobs) ? run.jobs : Array.isArray(run.checkRuns) ? run.checkRuns : [];
  const requiredJobs = Array.isArray(run.requiredJobs) && run.requiredJobs.length > 0 ? run.requiredJobs : [...REQUIRED_CI_JOBS];
  for (const required of requiredJobs) {
    const job = jobs.find((entry) => (entry?.name ?? entry?.context ?? entry?.checkName) === required);
    if (!job || String(job.status ?? "").toLowerCase() !== "completed" || String(job.conclusion ?? "").toLowerCase() !== "success") return fixedReason("CI_REQUIRED_JOB_FAILED", { runId: id, runAttempt: attempt, requiredJob: required });
  }
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : asArray(typeof adapter.listWorkflowArtifacts === "function" ? await adapter.listWorkflowArtifacts(id) : []);
  const sourceName = `${DATA_CI_SOURCE_ARTIFACT_PREFIX}${headSha}-${id}-${attempt}`;
  if (exactArtifact(artifacts, sourceName, id).length !== 1) return fixedReason("CI_SOURCE_ARTIFACT_MISSING", { runId: id, runAttempt: attempt, artifact: sourceName });
  if (kind === "data") {
    const dataName = `${DATA_CI_ARTIFACT_PREFIX}${headSha}-${id}-${attempt}`;
    if (exactArtifact(artifacts, dataName, id).length !== 1) return fixedReason("CI_DATA_ARTIFACT_MISSING", { runId: id, runAttempt: attempt, artifact: dataName });
  }
  return {
    status: "READY",
    runId: id,
    runAttempt: attempt,
    headSha,
    branch,
    workflowPath: CI_WORKFLOW_PATH,
    conclusion,
    requiredJobs,
    sourceArtifact: sourceName,
  };
}

async function inspectCandidate(adapter, { kind, branch, repository, expectedMainSha }) {
  const expectedPaths = kind === "data" ? DATA_OUTPUT_PATHS : RELEASE_OUTPUT_PATHS;
  if (typeof adapter.getBranchSha !== "function" || typeof adapter.getBranchMetadata !== "function" || typeof adapter.listPullRequests !== "function") return fixedReason("ADAPTER_READ_UNAVAILABLE", { kind, branch });
  const branchSha = await adapter.getBranchSha(branch);
  if (branchSha === null || branchSha === undefined) return fixedReason("BRANCH_ABSENT", { kind, branch });
  try { requireSha(branchSha, `${branch} head SHA`); } catch { return fixedReason("BRANCH_HEAD_INVALID", { kind, branch }); }
  const listed = asArray(await adapter.listPullRequests({ head: branch, base: MAIN_BRANCH, state: "open" }));
  const branchRows = listed.filter((entry) => pullHeadRef(entry) === branch && pullBaseRef(entry) === MAIN_BRANCH && pullState(entry) === "open" && entry?.merged !== true);
  const sameRepoRows = branchRows.filter((entry) => sameRepository(entry, repository));
  if (sameRepoRows.length === 0) return fixedReason(branchRows.length > 0 ? "PR_WRONG_REPOSITORY" : "PR_ABSENT", { kind, branch, headSha: branchSha });
  const exactRows = sameRepoRows.filter((entry) => pullHeadSha(entry) === branchSha && pullBaseSha(entry) === expectedMainSha);
  if (exactRows.length === 0) return fixedReason("PR_BINDING_STALE", { kind, branch, headSha: branchSha });
  if (exactRows.length !== 1) return fixedReason("PR_AMBIGUOUS", { kind, branch, headSha: branchSha });
  const pull = exactRows[0];
  const prNumber = Number(pull.number);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return fixedReason("PR_BINDING_INVALID", { kind, branch, headSha: branchSha });
  let metadata;
  try { metadata = await adapter.getBranchMetadata(branch); } catch { return fixedReason("BRANCH_METADATA_INVALID", { kind, branch, headSha: branchSha }); }
  const metadataReason = validateBranchMetadata(metadata, { kind, branch, headSha: branchSha, expectedMainSha });
  if (metadataReason !== null) return fixedReason(metadataReason, { kind, branch, headSha: branchSha });
  let changed;
  let files;
  try {
    changed = normalizeChangedPaths(await adapter.getChangedPaths(branch, { baseSha: expectedMainSha, headSha: branchSha }));
    if (changed.some((pathValue) => !expectedPaths.includes(pathValue))) return fixedReason("BRANCH_UNEXPECTED_PATH", { kind, branch, headSha: branchSha, changedPaths: changed });
    files = await adapter.getBranchFiles(branch, expectedPaths, { headSha: branchSha });
  } catch { return fixedReason("BRANCH_FILES_UNAVAILABLE", { kind, branch, headSha: branchSha }); }
  if (!exactFileMap(files, expectedPaths)) return fixedReason("BRANCH_FILES_INVALID", { kind, branch, headSha: branchSha });
  const contentDigest = computeOutputDigest(files);
  if (contentDigest !== metadata.contentDigest) return fixedReason("BRANCH_CONTENT_DIGEST_INVALID", { kind, branch, headSha: branchSha });
  if (kind === "data") {
    if (contentDigest !== metadata.outputDigest) return fixedReason("BRANCH_DIGEST_INVALID", { kind, branch, headSha: branchSha });
  } else if (metadata.actualOutputDigest !== metadata.outputDigest || metadata.actualContentDigest !== metadata.contentDigest) {
    return fixedReason("BRANCH_DIGEST_INVALID", { kind, branch, headSha: branchSha });
  }
  const ci = await inspectCi(adapter, { kind, branch, headSha: branchSha, repository });
  if (ci.status !== "READY") return { ...ci, kind, branch, headSha: branchSha, prNumber };
  return {
    status: "READY",
    kind,
    branch,
    headSha: branchSha,
    baseSha: expectedMainSha,
    prNumber,
    outputPaths: expectedPaths,
    changedPaths: changed,
    metadata: {
      managedBy: metadata.managedBy,
      baseSha: metadata.baseSha,
      sourceSha: metadata.expectedSourceSha ?? metadata.sourceSha,
      parentSha: metadata.parentSha,
      headSha: metadata.headSha,
      outputDigest: metadata.outputDigest,
      contentDigest: metadata.contentDigest,
      semanticFingerprint: metadata.semanticFingerprint,
    },
    ci,
  };
}

async function inspectControllers(adapter, { repository }) {
  if (typeof adapter.listWorkflowRuns !== "function") return { status: "SKIP", reason: "CONTROLLER_RUNS_UNAVAILABLE" };
  const results = await Promise.all([DATA_CONTROLLER_WORKFLOW_PATH, RELEASE_CONTROLLER_WORKFLOW_PATH].map(async (workflowPath) => ({
    workflowPath,
    // Controller activity can originate from workflow_run, schedule, or an
    // explicit dispatch.  The CI candidate query above stays restricted to
    // workflow_dispatch; this lease check must see every controller event.
    runs: asArray(await adapter.listWorkflowRuns({ workflowPath, branch: MAIN_BRANCH })),
  })));
  const runs = results.flatMap((entry) => entry.runs.map((run) => ({ ...run, workflowPath: entry.workflowPath })));
  const relevant = runs.filter((run) => isMainRun(run) && (runRepository(run) === null || runRepository(run) === repository));
  const active = relevant.filter((run) => ACTIVE_RUN_STATES.has(runStatus(run)));
  if (active.length > 0) return { status: "SKIP", reason: "CONTROLLER_RUNNING", workflowPath: active[0].workflowPath, runId: runId(active[0]), runAttempt: runAttempt(active[0]) };
  return { status: "READY", runs: relevant };
}

function controllerDecision(runs, { kind, ci, headSha, apply }) {
  const expectedName = controllerRunName(kind, ci.runId, ci.runAttempt, headSha, apply);
  const expectedWorkflowPath = controllerWorkflowPath(kind);
  const matching = runs.filter((run) => runName(run) === expectedName
    && (run.workflowPath === expectedWorkflowPath || runPath(run) === expectedWorkflowPath)).sort(runSort);
  if (matching.length === 0) return { status: "READY", runName: expectedName };
  const latest = matching[0];
  const status = runStatus(latest);
  const conclusion = runConclusion(latest);
  if (ACTIVE_RUN_STATES.has(status)) return { status: "SKIP", reason: "CONTROLLER_RUNNING", runName: expectedName, runId: runId(latest), runAttempt: runAttempt(latest) };
  if (COMPLETED_RUN_STATES.has(status) && conclusion === "success") return { status: "SKIP", reason: "CONTROLLER_ALREADY_SUCCEEDED", runName: expectedName, runId: runId(latest), runAttempt: runAttempt(latest) };
  if (COMPLETED_RUN_STATES.has(status) && conclusion === "skipped") return { status: "READY", runName: expectedName };
  if (COMPLETED_RUN_STATES.has(status)) return { status: "SKIP", reason: "CONTROLLER_FAILED_MANUAL_RETRY", runName: expectedName, runId: runId(latest), runAttempt: runAttempt(latest), conclusion };
  return { status: "SKIP", reason: "CONTROLLER_STATE_INVALID", runName: expectedName };
}

function desiredApply(kind, env) {
  return kind === "data" ? env.ERPC_ENABLE_AUTOMATIC_DATA_MERGE === "true" : env.ERPC_ENABLE_AUTOMATIC_RELEASE === "true";
}

function dispatchInputs(candidate, apply) {
  const inputs = {
    pr_number: String(candidate.prNumber),
    ci_run_id: String(candidate.ci.runId),
    ci_run_attempt: String(candidate.ci.runAttempt),
    expected_head_sha: candidate.headSha,
    base_sha: candidate.baseSha,
    apply: apply ? "true" : "false",
  };
  if (candidate.kind === "release") inputs.mode = "reconcile";
  return inputs;
}

function sameCandidateBinding(left, right) {
  if (!left || !right || left.status !== "READY" || right.status !== "READY") return false;
  return left.kind === right.kind
    && left.branch === right.branch
    && left.prNumber === right.prNumber
    && left.headSha === right.headSha
    && left.baseSha === right.baseSha
    && left.ci?.runId === right.ci?.runId
    && left.ci?.runAttempt === right.ci?.runAttempt;
}

function requireDispatchRunId(response) {
  const id = runId(response);
  if (id === null) fail("controller dispatch did not return a workflow run ID", "DISPATCH_INVALID");
  return id;
}

function writeReport(reportPath, report) {
  if (typeof reportPath !== "string" || reportPath.length === 0 || reportPath.includes("\0")) fail("--report path is invalid", "USAGE");
  const target = resolve(reportPath);
  if (existsSync(target)) fail("report path already exists; refusing to overwrite", "REPORT_EXISTS");
  const parent = resolve(target, "..");
  if (!existsSync(parent) || !statSync(parent).isDirectory()) fail("report parent directory must exist", "USAGE");
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink()) fail("report path may not be a symbolic link", "USAGE");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

export async function reconcileMaintenance({
  root = REPOSITORY_ROOT,
  repo = process.env.GITHUB_REPOSITORY,
  expectedMainSha = undefined,
  adapter = undefined,
  dispatch = false,
  env = process.env,
} = {}) {
  const trustedRoot = resolve(root);
  const repository = requireRepository(repo);
  const localHeadSha = currentHead(trustedRoot);
  const trustedMainSha = requireSha(expectedMainSha ?? env.EXPECTED_MAIN_SHA ?? localHeadSha, "expected main SHA");
  const baseReport = {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    kind: RECONCILE_KIND,
    repository,
    expectedMainSha: trustedMainSha,
    localHeadSha,
    dispatchRequested: dispatch === true,
    flags: {
      automaticDataMerge: env.ERPC_ENABLE_AUTOMATIC_DATA_MERGE === "true",
      automaticRelease: env.ERPC_ENABLE_AUTOMATIC_RELEASE === "true",
    },
    candidates: {},
    selected: null,
    dispatch: null,
  };
  if (localHeadSha !== trustedMainSha) return { ...baseReport, status: "NO_ACTION", reason: "TRUSTED_MAIN_HEAD_STALE" };
  const client = adapter ?? createReconcileAdapter({ repo: repository, root: trustedRoot, env });
  let liveMainSha;
  try { liveMainSha = requireSha(await client.getMainSha(), "live main SHA"); } catch { return { ...baseReport, status: "NO_ACTION", reason: "LIVE_MAIN_UNAVAILABLE" }; }
  if (liveMainSha !== trustedMainSha) return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "LIVE_MAIN_STALE" };
  for (const [kind, branch] of [["data", DATA_BRANCH], ["release", RELEASE_BRANCH]]) {
    try { baseReport.candidates[kind] = await inspectCandidate(client, { kind, branch, repository, expectedMainSha: trustedMainSha }); } catch { baseReport.candidates[kind] = fixedReason("CANDIDATE_READ_FAILED", { kind, branch }); }
  }
  let controllers;
  try { controllers = await inspectControllers(client, { repository }); } catch { return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "CONTROLLER_READ_FAILED" }; }
  if (controllers.status !== "READY") return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: controllers.reason, controller: controllers };
  let selected = null;
  let decision = null;
  let selectedApply = false;
  let blockedCandidate = null;
  for (const kind of ["data", "release"]) {
    const candidate = baseReport.candidates[kind];
    if (candidate?.status !== "READY") continue;
    const apply = desiredApply(kind, env);
    const candidateDecision = controllerDecision(controllers.runs, { kind, ci: candidate.ci, headSha: candidate.headSha, apply });
    baseReport.candidates[kind] = { ...candidate, controller: candidateDecision };
    if (candidateDecision.status === "READY") {
      selected = candidate;
      decision = candidateDecision;
      selectedApply = apply;
      break;
    }
    if (blockedCandidate === null) blockedCandidate = { candidate, decision: candidateDecision, apply };
  }
  if (!selected) {
    const blocked = blockedCandidate;
    const blockedReport = blocked ? {
      kind: blocked.candidate.kind,
      branch: blocked.candidate.branch,
      prNumber: blocked.candidate.prNumber,
      headSha: blocked.candidate.headSha,
      baseSha: blocked.candidate.baseSha,
      ci: blocked.candidate.ci,
      apply: blocked.apply,
      runName: blocked.decision.runName,
    } : null;
    return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: blocked?.decision.reason ?? "NO_RECONCILABLE_CANDIDATE", selected: blockedReport, controller: blocked?.decision ?? controllers };
  }
  const apply = selectedApply;
  let selectedReport = { kind: selected.kind, branch: selected.branch, prNumber: selected.prNumber, headSha: selected.headSha, baseSha: selected.baseSha, ci: selected.ci, apply, runName: decision.runName };
  if (!dispatch) return { ...baseReport, liveMainSha, status: "READY", actionRequired: true, selected: selectedReport, controller: decision };

  // Re-read the candidate tuple immediately before the dispatch lease.  A
  // force-pushed branch, retargeted PR, or newer CI attempt must never reuse
  // the earlier report's inputs.
  let refreshed;
  try {
    refreshed = await inspectCandidate(client, { kind: selected.kind, branch: selected.branch, repository, expectedMainSha: trustedMainSha });
  } catch {
    return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "CANDIDATE_CHANGED_BEFORE_DISPATCH", selected: selectedReport, controller: decision };
  }
  if (!sameCandidateBinding(selected, refreshed)) return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "CANDIDATE_CHANGED_BEFORE_DISPATCH", selected: selectedReport, recheckedCandidate: refreshed, controller: decision };
  selected = refreshed;
  selectedReport = { kind: selected.kind, branch: selected.branch, prNumber: selected.prNumber, headSha: selected.headSha, baseSha: selected.baseSha, ci: selected.ci, apply, runName: decision.runName };

  let latestControllers;
  try { latestControllers = await inspectControllers(client, { repository }); } catch { return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "CONTROLLER_READ_FAILED", selected: selectedReport, controller: decision }; }
  if (latestControllers.status !== "READY") return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: latestControllers.reason, selected: selectedReport, controller: latestControllers };
  const latestDecision = controllerDecision(latestControllers.runs, { kind: selected.kind, ci: selected.ci, headSha: selected.headSha, apply });
  if (latestDecision.status !== "READY") return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: latestDecision.reason, selected: selectedReport, controller: latestDecision };

  let beforeLocal;
  let beforeLive;
  try {
    beforeLocal = currentHead(trustedRoot);
    if (beforeLocal !== trustedMainSha) return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "TRUSTED_MAIN_HEAD_MOVED", selected: selectedReport, controller: latestDecision };
    beforeLive = requireSha(await client.getMainSha(), "live main SHA before dispatch");
  } catch {
    return { ...baseReport, liveMainSha, status: "NO_ACTION", reason: "LIVE_MAIN_UNAVAILABLE", selected: selectedReport, controller: latestDecision };
  }
  if (beforeLive !== trustedMainSha) return { ...baseReport, liveMainSha: beforeLive, status: "NO_ACTION", reason: "LIVE_MAIN_MOVED", selected: selectedReport, controller: latestDecision };
  const workflowPath = controllerWorkflowPath(selected.kind);
  const inputs = dispatchInputs(selected, apply);
  let response;
  let controllerRunId;
  try {
    if (typeof client.dispatchController === "function") response = await client.dispatchController({ workflowPath, ref: MAIN_BRANCH, inputs });
    else if (typeof client.dispatchWorkflow === "function") response = await client.dispatchWorkflow({ workflowPath, ref: MAIN_BRANCH, inputs });
    else fail("controller dispatch is unavailable", "DISPATCH_UNAVAILABLE");
    controllerRunId = requireDispatchRunId(response);
  } catch (error) {
    const reason = ["DISPATCH_UNAVAILABLE", "DISPATCH_INVALID"].includes(error?.code) ? error.code : "DISPATCH_FAILED";
    return { ...baseReport, liveMainSha, status: "NO_ACTION", reason, selected: selectedReport, controller: latestDecision };
  }
  return {
    ...baseReport,
    liveMainSha,
    status: "DISPATCHED",
    actionRequired: true,
    selected: selectedReport,
    controller: latestDecision,
    dispatch: { workflowPath, ref: MAIN_BRANCH, inputs, workflowRunId: controllerRunId },
  };
}

export const reconcile = reconcileMaintenance;

function parseArguments(argumentsList = process.argv.slice(2)) {
  const options = { dispatch: false, repo: process.env.GITHUB_REPOSITORY ?? null, report: null, root: REPOSITORY_ROOT, expectedMainSha: undefined, help: false };
  const args = [...argumentsList];
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dispatch") { if (options.dispatch) fail("--dispatch may be provided only once", "USAGE"); options.dispatch = true; continue; }
    if (argument === "--help") { options.help = true; continue; }
    const map = new Map([["--repo", "repo"], ["--report", "report"], ["--root", "root"], ["--expected-main-sha", "expectedMainSha"]]);
    const property = map.get(argument);
    if (property) {
      if (seen.has(argument) || args[index + 1] === undefined || args[index + 1].startsWith("--")) fail(`${argument} requires one value`, "USAGE");
      seen.add(argument);
      options[property] = args[index + 1];
      index += 1;
      continue;
    }
    fail(`unknown option ${argument}`, "USAGE");
  }
  if (options.help) return options;
  options.repo = requireRepository(options.repo);
  if (options.expectedMainSha !== undefined) requireSha(options.expectedMainSha, "--expected-main-sha");
  return options;
}

export function usage() {
  return "Usage: node registry/reconcile-maintenance.mjs [--dispatch] --repo OWNER/REPO [--expected-main-sha SHA] [--report PATH] [--root DIR]";
}

export async function run(argumentsList = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argumentsList);
  if (options.help) { process.stdout.write(`${usage()}\n`); return null; }
  const report = await reconcileMaintenance({ ...options, env: environment });
  if (options.report) writeReport(options.report, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`reconcile-maintenance: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = error.code === "USAGE" ? 64 : 1;
  });
}
