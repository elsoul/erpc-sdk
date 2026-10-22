import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/u, "");
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github/workflows/release.yml");
const REPOSITORY = "elsoul/erpc-sdk";
const REPOSITORY_ID = "1429568627";
const SOURCE_SHA = "b".repeat(40);
const WORKFLOW_ID = 123;
const CI_RUN_ID = 42;
const CI_RUN_ATTEMPT = 3;
const CI_JOB_ID = 9001;
const CI_EVENT = "push";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const CI_RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/${CI_RUN_ID}`;

function leadingSpaces(value) {
  return value.match(/^\s*/u)?.[0].length ?? 0;
}

function extractRunBlock(stepName) {
  const lines = readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(stepIndex, -1, `workflow step is missing: ${stepName}`);
  const stepIndent = leadingSpaces(lines[stepIndex]);
  const commandIndex = lines.findIndex((line, index) => index > stepIndex && leadingSpaces(line) === stepIndent + 2 && /^(?:run|uses):/u.test(line.trim()));
  assert.notEqual(commandIndex, -1, `workflow command is missing: ${stepName}`);
  const command = lines[commandIndex].trim();
  if (!/^run:\s*\|\s*$/u.test(command)) {
    assert.match(command, /^run:\s+/u, `${stepName} must execute a shell command`);
    return command.replace(/^run:\s+/u, "");
  }
  const raw = [];
  for (let index = commandIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && leadingSpaces(line) <= leadingSpaces(lines[commandIndex])) break;
    raw.push(line);
  }
  const nonBlank = raw.filter((line) => line.trim() !== "");
  const blockIndent = nonBlank.length === 0 ? 0 : Math.min(...nonBlank.map(leadingSpaces));
  return raw.map((line) => line.slice(Math.min(blockIndent, line.length))).join("\n");
}

function writeFixtureCommands(directory) {
  const gh = join(directory, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
const path = args.find(value => value.startsWith("/repos/")) ?? ""
const mode = process.env.FIXTURE_MODE
const repository = ${JSON.stringify(REPOSITORY)}
const repositoryId = ${JSON.stringify(REPOSITORY_ID)}
const sourceSha = ${JSON.stringify(SOURCE_SHA)}
const workflowId = ${WORKFLOW_ID}
const runId = ${CI_RUN_ID}
const attempt = ${CI_RUN_ATTEMPT}
const jobId = ${CI_JOB_ID}
const workflowPath = ${JSON.stringify(CI_WORKFLOW_PATH)}
const logFile = process.env.FIXTURE_LOG
if (logFile) appendFileSync(logFile, JSON.stringify({ args }) + "\\n")
if (args.some(value => ["POST", "PUT", "PATCH", "DELETE"].includes(value.toUpperCase()))) {
  process.stderr.write("fixture rejected a mutating gh request\\n")
  process.exit(9)
}
if (mode === "api-failure") {
  process.stderr.write("fixture API failure\\n")
  process.exit(7)
}
const makeRun = (overrides = {}) => ({
  id: runId, run_attempt: attempt, run_number: 100, status: "completed", conclusion: "success", event: process.env.CI_EVENT || "push",
  path: workflowPath, workflow_id: workflowId, name: "CI", head_sha: sourceSha, head_branch: "main",
  repository: { full_name: repository, id: Number(repositoryId) }, head_repository: { full_name: repository, id: Number(repositoryId) },
  html_url: ${JSON.stringify(CI_RUN_URL)}, created_at: "2026-10-22T10:00:00Z", updated_at: "2026-10-22T10:10:00Z", ...overrides,
})
let value
if (mode === "malformed") process.stdout.write("not-json\\n")
else if (path.includes("/actions/workflows/" + workflowId + "/runs")) {
  if (mode === "older-green-newer-failed") value = { total_count: 2, workflow_runs: [makeRun({ id: 41, run_attempt: 1, run_number: 99, created_at: "2026-10-22T09:00:00Z" }), makeRun({ status: "completed", conclusion: "failure", run_number: 100 })] }
  else {
    const current = makeRun()
    if (mode === "wrong-repository") current.repository = { full_name: "other/example", id: 999999 }
    if (mode === "wrong-repository-id") current.repository.id = 999999
    if (mode === "wrong-workflow") current.path = ".github/workflows/other.yml"
    if (mode === "wrong-workflow-id") current.workflow_id = 999
    if (mode === "wrong-branch") current.head_branch = "codex/release-preparation"
    if (mode === "wrong-event") current.event = "pull_request"
    if (mode === "wrong-source") current.head_sha = "f".repeat(40)
    if (mode === "wrong-attempt") current.run_attempt = attempt + 1
    if (["pending", "failed", "cancelled", "skipped"].includes(mode)) {
      current.status = mode === "pending" ? "in_progress" : "completed"
      current.conclusion = mode === "pending" ? null : mode === "cancelled" ? "cancelled" : mode === "skipped" ? "skipped" : "failure"
    }
    value = { total_count: 1, workflow_runs: [current] }
  }
} else if (path.includes("/actions/runs/" + runId + "/attempts/" + attempt + "/jobs")) {
  const job = { id: jobId, run_id: runId, name: "required-ci", status: "completed", conclusion: "success", head_sha: sourceSha, workflow_name: "CI", html_url: ${JSON.stringify(CI_RUN_URL)} + "/job/" + jobId }
  if (mode === "missing-job") value = { total_count: 0, jobs: [] }
  else if (mode === "duplicate-job") value = { total_count: 2, jobs: [job, { ...job, id: jobId + 1 }] }
  else if (mode === "wrong-job-name") value = { total_count: 1, jobs: [{ ...job, name: "required-ci-copy" }] }
  else if (mode === "wrong-job-source") value = { total_count: 1, jobs: [{ ...job, head_sha: "f".repeat(40) }] }
  else if (mode === "wrong-job-run") value = { total_count: 1, jobs: [{ ...job, run_id: 999 }] }
  else if (mode === "truncated") value = { total_count: 2, jobs: [job] }
  else if (["pending", "failed", "cancelled", "skipped"].includes(mode)) {
    const run = makeRun()
    value = { total_count: 1, jobs: [{ ...job, status: run.status, conclusion: run.conclusion }] }
  } else value = { total_count: 1, jobs: [job] }
} else if (path.includes("/actions/runs/" + runId)) {
  value = makeRun()
} else if (path.includes("/actions/workflows/ci.yml")) {
  value = {
    badge_url: "https://github.com/" + repository + "/workflows/CI/badge.svg",
    created_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/" + repository + "/actions/workflows/ci.yml",
    id: workflowId,
    name: "CI",
    node_id: "W_kwDOExample",
    path: workflowPath,
    state: "active",
    updated_at: "2026-10-22T00:00:00Z",
    url: "https://api.github.com/repos/" + repository + "/actions/workflows/ci.yml",
  }
} else {
  process.stderr.write("unexpected fixture API path: " + path + "\\n")
  process.exit(2)
}
if (value !== undefined) process.stdout.write(JSON.stringify(value) + "\\n")
`);
  chmodSync(gh, 0o755);
  const log = join(directory, "gh.jsonl");
  writeFileSync(log, "");
  return log;
}

function runProof(script, mode, { releaseEvent = "workflow_dispatch", ciEvent = CI_EVENT } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "erpc-release-workflow-proof-"));
  try {
    const log = writeFixtureCommands(directory);
    const runnerTemp = join(directory, "runner");
    mkdirSync(runnerTemp, { recursive: true });
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FIXTURE_MODE: mode,
      FIXTURE_LOG: log,
      CI_EVENT: ciEvent,
      EVENT_NAME: releaseEvent,
      GITHUB_EVENT_NAME: releaseEvent,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: SOURCE_SHA,
      REPOSITORY,
      EXPECTED_REPOSITORY: REPOSITORY,
      REPOSITORY_ID,
      EXPECTED_REPOSITORY_ID: REPOSITORY_ID,
      EXPECTED_COMMIT: SOURCE_SHA,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
      RUNNER_TEMP: runnerTemp,
      FOUNDATION_SOURCE_SHA: SOURCE_SHA,
      CI_WORKFLOW_FILE: join(runnerTemp, "foundation-ci-workflow.json"),
      CI_RUNS_FILE: join(runnerTemp, "foundation-ci-runs.json"),
      CI_SELECTION_FILE: join(runnerTemp, "foundation-ci-selection.json"),
      CI_RECHECK_FILE: join(runnerTemp, "foundation-ci-recheck.json"),
      CI_JOBS_FILE: join(runnerTemp, "foundation-ci-jobs.json"),
      CI_EVIDENCE_FILE: join(runnerTemp, "foundation-ci-evidence.json"),
      GH_TOKEN: "fixture-token",
      GITHUB_TOKEN: "fixture-token",
    };
    const result = spawnSync("/bin/bash", [], { cwd: REPOSITORY_ROOT, env, input: script, encoding: "utf8" });
    const calls = readFileSync(log, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const CI_PROOF_STEP = "Verify bounded CI proof for this immutable release";

test("the exact-source CI gate parses and remains on the pre-publication dependency path", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  assert.match(workflow, /publication-validation:[\s\S]*?Verify bounded CI proof for this immutable release/u);
  for (const job of ["npm", "pypi", "rubygems", "rust-reuse", "tags", "proof-aggregate", "github-release"]) {
    const block = workflow.match(new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [A-Za-z0-9_-]+:|\\n?$)`, "u"))?.[0] ?? "";
    assert.match(block, /publication-validation/u, `${job} must depend on the exact CI gate`);
  }
  const goProof = workflow.match(/\n  go-proof:[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|\n?$)/u)?.[0] ?? "";
  const tags = workflow.match(/\n  tags:[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|\n?$)/u)?.[0] ?? "";
  assert.match(goProof, /needs:\s+tags/u, "go-proof must depend on tags");
  assert.match(tags, /publication-validation/u, "tags must depend on the exact CI gate");
});

test("exact-source CI accepts main push and manual release invocations with one current required-ci job", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  for (const { releaseEvent, ciEvent } of [{ releaseEvent: "push", ciEvent: "push" }, { releaseEvent: "workflow_dispatch", ciEvent: "workflow_dispatch" }]) {
    const result = runProof(script, "success", { releaseEvent, ciEvent });
    assert.equal(result.status, 0, `${releaseEvent}/${ciEvent}: ${result.stderr}`);
    assert.ok(result.calls.length > 0);
    assert.equal(result.calls.every(({ args }) => args[0] === "api" && !args.some((arg) => ["POST", "PUT", "PATCH", "DELETE"].includes(arg.toUpperCase()))), true);
  }
});

test("exact-source CI fails closed for identity, state, attempt, job, and API failures", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  const modes = [
    "wrong-repository", "wrong-repository-id", "wrong-workflow", "wrong-workflow-id", "wrong-branch", "wrong-event", "wrong-source", "wrong-attempt",
    "missing-job", "duplicate-job", "wrong-job-name", "wrong-job-source", "wrong-job-run", "pending", "failed", "cancelled", "skipped", "truncated", "older-green-newer-failed", "malformed", "api-failure",
  ];
  for (const mode of modes) {
    const result = runProof(script, mode);
    assert.notEqual(result.status, 0, `${mode}: expected gate failure, got ${result.status}; ${result.stderr}`);
  }
});
