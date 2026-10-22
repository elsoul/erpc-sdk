import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const REPOSITORY_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/u, "");
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github/workflows/release.yml");
const REPOSITORY = "owner/repo";
const MERGE_SHA = "a".repeat(40);
const CI_HEAD_SHA = "b".repeat(40);
const CI_BASE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const CI_RUN_ID = "42";
const CI_RUN_ATTEMPT = "3";

function leadingSpaces(value) {
  return value.match(/^\s*/u)?.[0].length ?? 0;
}

function extractRunBlock(stepName) {
  const lines = readFileSync(WORKFLOW_PATH, "utf8").split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(stepIndex, -1, `workflow step is missing: ${stepName}`);
  const stepIndent = leadingSpaces(lines[stepIndex]);
  const runIndex = lines.findIndex((line, index) => index > stepIndex && leadingSpaces(line) === stepIndent + 2 && /^run:\s*\|\s*$/u.test(line.trim()));
  assert.notEqual(runIndex, -1, `run block is missing: ${stepName}`);
  const raw = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && leadingSpaces(line) <= leadingSpaces(lines[runIndex])) break;
    raw.push(line);
  }
  const nonBlank = raw.filter((line) => line.trim() !== "");
  const blockIndent = Math.min(...nonBlank.map(leadingSpaces));
  return raw.map((line) => line.slice(Math.min(blockIndent, line.length))).join("\n");
}

function writeFixtureCommands(directory) {
  const gh = join(directory, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const path = process.argv[3] ?? ""
const mode = process.env.FIXTURE_MODE
const repository = ${JSON.stringify(REPOSITORY)}
const mergeSha = ${JSON.stringify(MERGE_SHA)}
const ciHeadSha = ${JSON.stringify(CI_HEAD_SHA)}
const ciBaseSha = ${JSON.stringify(CI_BASE_SHA)}
const treeSha = ${JSON.stringify(TREE_SHA)}
const runId = ${JSON.stringify(CI_RUN_ID)}
const runAttempt = ${JSON.stringify(CI_RUN_ATTEMPT)}
const run = {
  id: Number(runId),
  run_attempt: Number(runAttempt),
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  path: ".github/workflows/ci.yml",
  head_sha: ciHeadSha,
  head_branch: "codex/release-preparation",
  repository: { full_name: repository },
}
if (mode === "manual-wrong-attempt") run.run_attempt = Number(runAttempt) + 1
if (mode === "manual-wrong-event") run.event = "push"
if (mode === "manual-wrong-head") run.head_sha = "f".repeat(40)
let value
if (path.includes("/check-runs?")) {
  if (mode === "push-missing") value = { check_runs: [] }
  else if (mode === "push-wrong-sha") value = { check_runs: [{ name: "required-ci", head_sha: "f".repeat(40), status: "completed", conclusion: "success" }] }
  else if (mode === "push-failure") value = { check_runs: [{ name: "required-ci", head_sha: mergeSha, status: "completed", conclusion: "failure" }] }
  else if (mode === "push-in-progress") value = { check_runs: [{ name: "required-ci", head_sha: mergeSha, status: "in_progress", conclusion: null }] }
  else value = { check_runs: [{ name: "required-ci", head_sha: mergeSha, status: "completed", conclusion: "success" }] }
} else if (path.includes("/actions/runs/" + runId + "/jobs?")) {
  value = { jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] }
} else if (path.includes("/actions/runs/" + runId)) {
  value = run
} else if (path.includes("/commits/" + mergeSha)) {
  const parents = mode === "manual-reversed-parents"
    ? [{ sha: ciHeadSha }, { sha: ciBaseSha }]
    : [{ sha: ciBaseSha }, { sha: ciHeadSha }]
  const commitTree = mode === "manual-malformed-tree" ? "not-a-sha" : treeSha
  value = { sha: mergeSha, parents, commit: { tree: { sha: commitTree } } }
} else {
  process.stderr.write("unexpected fixture API path: " + path + "\\n")
  process.exit(2)
}
process.stdout.write(JSON.stringify(value) + "\\n")
`);
  chmodSync(gh, 0o755);
  const sleep = join(directory, "sleep");
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
  chmodSync(sleep, 0o755);
}

function runProof(script, mode, { event = "push", manual = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "erpc-release-workflow-proof-"));
  writeFixtureCommands(directory);
  const runnerTemp = join(directory, "runner");
  mkdirSync(runnerTemp, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FIXTURE_MODE: mode,
    EVENT_NAME: event,
    REPOSITORY,
    EXPECTED_COMMIT: MERGE_SHA,
    CI_RUN_ID: manual ? CI_RUN_ID : "",
    CI_RUN_ATTEMPT: manual ? CI_RUN_ATTEMPT : "",
    CI_HEAD_SHA: manual ? CI_HEAD_SHA : "",
    CI_BASE_SHA: manual ? CI_BASE_SHA : "",
    RUNNER_TEMP: runnerTemp,
    GH_TOKEN: "fixture-token",
    GITHUB_TOKEN: "fixture-token",
  };
  return spawnSync("/bin/bash", [], { cwd: REPOSITORY_ROOT, env, input: script, encoding: "utf8" });
}

const CI_PROOF_STEP = "Verify bounded CI proof for this immutable release";

test("the workflow CI-proof run block parses as shell with real heredoc boundaries", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  assert.match(script, /<<'NODE'/u);
  assert.match(script, /^NODE$/mu);
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("push CI proof accepts only the exact required-ci success and fails closed", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  for (const [mode, expectedStatus] of [
    ["push-success", 0],
    ["push-wrong-sha", 1],
    ["push-missing", 1],
    ["push-failure", 1],
    ["push-in-progress", 1],
  ]) {
    const result = runProof(script, mode);
    assert.equal(result.status, expectedStatus, `${mode}: ${result.stderr}`);
  }
});

test("manual CI proof accepts REST commit.commit.tree and rejects binding mismatches", () => {
  const script = extractRunBlock(CI_PROOF_STEP);
  assert.equal(runProof(script, "manual-valid", { event: "workflow_dispatch", manual: true }).status, 0);
  for (const mode of ["manual-wrong-attempt", "manual-reversed-parents", "manual-wrong-event", "manual-wrong-head", "manual-malformed-tree"]) {
    const result = runProof(script, mode, { event: "workflow_dispatch", manual: true });
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
  }
});
