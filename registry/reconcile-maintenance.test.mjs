import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import { CANDIDATE_OUTPUT_PATHS, computeOutputDigest } from "./data-promotion.mjs";
import { PACKAGE_VERSION_PATHS } from "./release-prep.mjs";
import {
  CI_WORKFLOW_PATH,
  DATA_BRANCH,
  DATA_CONTROLLER_WORKFLOW_PATH,
  DATA_CONTROLLER_RUN_PREFIX,
  DATA_OUTPUT_PATHS,
  RELEASE_BRANCH,
  RELEASE_CONTROLLER_WORKFLOW_PATH,
  RELEASE_CONTROLLER_RUN_PREFIX,
  RELEASE_OUTPUT_PATHS,
  reconcileMaintenance,
} from "./reconcile-maintenance.mjs";

const REPOSITORY = "owner/repo";
const ROOT = process.cwd();
const MAIN_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const DATA_HEAD = "b".repeat(40);
const RELEASE_HEAD = "c".repeat(40);
const DATA_CI_ID = 7101;
const RELEASE_CI_ID = 7201;

function digestSeed(label) {
  return createHash("sha256").update(label).digest("hex");
}

function filesFor(paths, label) {
  return Object.fromEntries(paths.map((pathValue) => [pathValue, `${JSON.stringify({ label, path: pathValue })}\n`]));
}

function metadataFor({ kind, branch, headSha, files }) {
  const digest = computeOutputDigest(files);
  return {
    managedBy: kind === "data" ? "erpc-sdk-data-maintenance" : "erpc-sdk-weekly-maintenance",
    branch,
    baseSha: MAIN_SHA,
    parentSha: MAIN_SHA,
    expectedSourceSha: MAIN_SHA,
    headSha,
    semanticFingerprint: digestSeed(`${kind}-semantic`),
    outputDigest: digest,
    contentDigest: digest,
    actualOutputDigest: digest,
    actualContentDigest: digest,
    outputPaths: [...(kind === "data" ? DATA_OUTPUT_PATHS : RELEASE_OUTPUT_PATHS)],
  };
}

function ciRun({ branch, headSha, id, attempt = 1, status = "completed", conclusion = "success", displayTitle = undefined, path = CI_WORKFLOW_PATH, event = "workflow_dispatch" }) {
  return {
    id,
    run_attempt: attempt,
    name: "CI",
    display_title: displayTitle ?? `CI for ${branch}`,
    path,
    event,
    head_branch: branch,
    head_sha: headSha,
    repository: { full_name: REPOSITORY },
    status,
    conclusion,
  };
}

function controllerRun({ kind, id = 8101, attempt = 1, headSha, apply = false, status = "completed", conclusion = "success", event = "workflow_dispatch", displayTitle = undefined, branch = "main" }) {
  const prefix = kind === "data" ? DATA_CONTROLLER_RUN_PREFIX : RELEASE_CONTROLLER_RUN_PREFIX;
  const ciId = kind === "data" ? DATA_CI_ID : RELEASE_CI_ID;
  return {
    id,
    run_attempt: attempt,
    name: kind === "data" ? "Verify and promote maintenance data" : "Weekly release preparation",
    // GitHub exposes the configured run-name in display_title while name is
    // only the workflow name.  Dedup must bind the former.
    display_title: displayTitle ?? `${prefix}-${ciId}-1-${headSha}-${apply ? "apply" : "verify"}`,
    path: kind === "data" ? DATA_CONTROLLER_WORKFLOW_PATH : RELEASE_CONTROLLER_WORKFLOW_PATH,
    event,
    head_branch: branch,
    head_sha: MAIN_SHA,
    repository: { full_name: REPOSITORY },
    status,
    conclusion,
  };
}

function makeFixture({
  data = true,
  release = false,
  dataCi = {},
  releaseCi = {},
  dataArtifacts = undefined,
  releaseArtifacts = undefined,
  controllers = [],
  liveMainSha = MAIN_SHA,
  dataHead = DATA_HEAD,
  releaseHead = RELEASE_HEAD,
  dataPrNumber = 101,
  releasePrNumber = 102,
  dispatchResult = { workflow_run_id: 9101 },
  onCall = undefined,
} = {}) {
  const dataFiles = filesFor(CANDIDATE_OUTPUT_PATHS, "data");
  const releaseFiles = filesFor(RELEASE_OUTPUT_PATHS, "release");
  const dataRun = ciRun({ branch: DATA_BRANCH, headSha: dataHead, id: DATA_CI_ID, ...dataCi });
  const releaseRun = ciRun({ branch: RELEASE_BRANCH, headSha: releaseHead, id: RELEASE_CI_ID, ...releaseCi });
  const state = {
    liveMainSha,
    dataHead: data ? dataHead : null,
    releaseHead: release ? releaseHead : null,
    dataFiles,
    releaseFiles,
    dataMetadata: data ? metadataFor({ kind: "data", branch: DATA_BRANCH, headSha: dataHead, files: dataFiles }) : null,
    releaseMetadata: release ? metadataFor({ kind: "release", branch: RELEASE_BRANCH, headSha: releaseHead, files: releaseFiles }) : null,
    dataPrNumber,
    releasePrNumber,
    dataCi: data ? dataRun : null,
    releaseCi: release ? releaseRun : null,
    dataArtifacts: dataArtifacts ?? [
      { name: `ci-source-binding-${dataHead}-${DATA_CI_ID}-1`, expired: false, workflow_run: { id: DATA_CI_ID } },
      { name: `ci-data-maintenance-${dataHead}-${DATA_CI_ID}-1`, expired: false, workflow_run: { id: DATA_CI_ID } },
    ],
    releaseArtifacts: releaseArtifacts ?? [
      { name: `ci-source-binding-${releaseHead}-${RELEASE_CI_ID}-1`, expired: false, workflow_run: { id: RELEASE_CI_ID } },
    ],
    controllers,
    dispatchResult,
  };
  const calls = [];
  const adapter = {
    calls,
    async getMainSha() {
      calls.push(["getMainSha"]);
      return state.liveMainSha;
    },
    async getBranchSha(branch) {
      calls.push(["getBranchSha", branch]);
      return branch === DATA_BRANCH ? state.dataHead : branch === RELEASE_BRANCH ? state.releaseHead : branch === "main" ? MAIN_SHA : null;
    },
    async getBranchMetadata(branch) {
      calls.push(["getBranchMetadata", branch]);
      return branch === DATA_BRANCH ? structuredClone(state.dataMetadata) : branch === RELEASE_BRANCH ? structuredClone(state.releaseMetadata) : null;
    },
    async getChangedPaths(branch) {
      calls.push(["getChangedPaths", branch]);
      return branch === DATA_BRANCH ? [...DATA_OUTPUT_PATHS] : branch === RELEASE_BRANCH ? [...RELEASE_OUTPUT_PATHS] : [];
    },
    async getBranchFiles(branch) {
      calls.push(["getBranchFiles", branch]);
      return branch === DATA_BRANCH ? structuredClone(state.dataFiles) : structuredClone(state.releaseFiles);
    },
    async listPullRequests({ head }) {
      calls.push(["listPullRequests", head]);
      if (head === DATA_BRANCH && state.dataHead !== null) return [{
        number: state.dataPrNumber,
        state: "open",
        merged: false,
        head: { ref: DATA_BRANCH, sha: state.dataHead, repo: { full_name: REPOSITORY } },
        base: { ref: "main", sha: MAIN_SHA, repo: { full_name: REPOSITORY } },
      }];
      if (head === RELEASE_BRANCH && state.releaseHead !== null) return [{
        number: state.releasePrNumber,
        state: "open",
        merged: false,
        head: { ref: RELEASE_BRANCH, sha: state.releaseHead, repo: { full_name: REPOSITORY } },
        base: { ref: "main", sha: MAIN_SHA, repo: { full_name: REPOSITORY } },
      }];
      return [];
    },
    async listWorkflowRuns({ workflowPath, branch, event }) {
      calls.push(["listWorkflowRuns", workflowPath, branch, event]);
      if (workflowPath === CI_WORKFLOW_PATH) {
        if (branch === DATA_BRANCH && state.dataCi) return [structuredClone(state.dataCi)];
        if (branch === RELEASE_BRANCH && state.releaseCi) return [structuredClone(state.releaseCi)];
        return [];
      }
      return state.controllers.filter((run) => run.path === workflowPath && (event === undefined || run.event === event)).map((run) => structuredClone(run));
    },
    async getWorkflowRun(id, attempt) {
      calls.push(["getWorkflowRun", id, attempt]);
      const run = [state.dataCi, state.releaseCi].find((entry) => entry?.id === id);
      if (!run) return {};
      return {
        ...structuredClone(run),
        // The exact run identity is returned by the API detail endpoint.
        id,
        run_attempt: attempt,
        jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }],
      };
    },
    async listWorkflowArtifacts(id) {
      calls.push(["listWorkflowArtifacts", id]);
      if (id === DATA_CI_ID) return structuredClone(state.dataArtifacts);
      if (id === RELEASE_CI_ID) return structuredClone(state.releaseArtifacts);
      return [];
    },
    async dispatchController(input) {
      calls.push(["dispatchController", structuredClone(input)]);
      onCall?.("dispatchController", input, state);
      return structuredClone(state.dispatchResult);
    },
  };
  return { adapter, state, calls };
}

async function inspect(fixture, options = {}) {
  return reconcileMaintenance({
    root: ROOT,
    repo: REPOSITORY,
    expectedMainSha: MAIN_SHA,
    adapter: fixture.adapter,
    env: {},
    ...options,
  });
}

test("no candidate is a read-only no-action result", async () => {
  const fixture = makeFixture({ data: false, release: false });
  const result = await inspect(fixture);
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.reason, "NO_RECONCILABLE_CANDIDATE");
  assert.equal(fixture.calls.some((call) => call[0] === "dispatchController"), false);
});

test("exact data candidate is selected ahead of a release candidate", async () => {
  const fixture = makeFixture({ release: true });
  const result = await inspect(fixture);
  assert.equal(result.status, "READY");
  assert.equal(result.selected.kind, "data");
  assert.equal(result.selected.prNumber, fixture.state.dataPrNumber);
  assert.equal(result.selected.ci.runId, DATA_CI_ID);
  assert.equal(result.selected.runName, `erpc-data-ci-${DATA_CI_ID}-1-${DATA_HEAD}-verify`);
  assert.equal(fixture.calls.some((call) => call[0] === "listWorkflowRuns" && call[3] === undefined), true);
});

test("a completed data controller lets a ready release candidate proceed", async () => {
  const dataController = controllerRun({ kind: "data", headSha: DATA_HEAD });
  const fixture = makeFixture({ release: true, controllers: [dataController] });
  const result = await inspect(fixture);
  assert.equal(result.status, "READY");
  assert.equal(result.selected.kind, "release");
  assert.equal(result.candidates.data.controller.reason, "CONTROLLER_ALREADY_SUCCEEDED");
});

test("latest failed CI blocks an older successful run from being reused", async () => {
  const fixture = makeFixture({ dataCi: { id: DATA_CI_ID + 1, status: "completed", conclusion: "failure" } });
  fixture.state.dataArtifacts = [];
  const result = await inspect(fixture);
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.candidates.data.reason, "CI_RUN_FAILED");
});

test("latest pending CI blocks reconciliation without falling back", async () => {
  const fixture = makeFixture({ dataCi: { id: DATA_CI_ID + 1, status: "in_progress", conclusion: "" } });
  const result = await inspect(fixture);
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.candidates.data.reason, "CI_RUN_PENDING");
});

test("wrong repository and missing source artifacts are fixed skips", async () => {
  const wrongRepo = makeFixture();
  wrongRepo.adapter.listPullRequests = async () => [{
    number: wrongRepo.state.dataPrNumber,
    state: "open",
    head: { ref: DATA_BRANCH, sha: DATA_HEAD, repo: { full_name: "attacker/repo" } },
    base: { ref: "main", sha: MAIN_SHA, repo: { full_name: REPOSITORY } },
  }];
  const wrongResult = await inspect(wrongRepo);
  assert.equal(wrongResult.candidates.data.reason, "PR_WRONG_REPOSITORY");

  const missing = makeFixture({ dataArtifacts: [] });
  const missingResult = await inspect(missing);
  assert.equal(missingResult.candidates.data.reason, "CI_SOURCE_ARTIFACT_MISSING");
});

test("stale branch base or head binding is rejected before CI inspection", async () => {
  const staleBase = makeFixture();
  staleBase.adapter.listPullRequests = async () => [{
    number: staleBase.state.dataPrNumber,
    state: "open",
    head: { ref: DATA_BRANCH, sha: DATA_HEAD, repo: { full_name: REPOSITORY } },
    base: { ref: "main", sha: "d".repeat(40), repo: { full_name: REPOSITORY } },
  }];
  const baseResult = await inspect(staleBase);
  assert.equal(baseResult.candidates.data.reason, "PR_BINDING_STALE");

  const staleHead = makeFixture();
  staleHead.adapter.listPullRequests = async () => [{
    number: staleHead.state.dataPrNumber,
    state: "open",
    head: { ref: DATA_BRANCH, sha: "e".repeat(40), repo: { full_name: REPOSITORY } },
    base: { ref: "main", sha: MAIN_SHA, repo: { full_name: REPOSITORY } },
  }];
  const headResult = await inspect(staleHead);
  assert.equal(headResult.candidates.data.reason, "PR_BINDING_STALE");
});

test("active controller events from workflow_run and schedule hold the shared lease", async () => {
  const fixture = makeFixture({ controllers: [
    controllerRun({ kind: "data", headSha: DATA_HEAD, status: "in_progress", conclusion: "", event: "workflow_run" }),
  ] });
  const result = await inspect(fixture);
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.reason, "CONTROLLER_RUNNING");
  assert.equal(fixture.calls.some((call) => call[0] === "listWorkflowRuns" && call[3] === undefined), true);
});

test("successful controller runs are deduplicated while skipped runs remain retryable", async () => {
  const succeeded = makeFixture({ controllers: [controllerRun({ kind: "data", headSha: DATA_HEAD })] });
  const successResult = await inspect(succeeded);
  assert.equal(successResult.status, "NO_ACTION");
  assert.equal(successResult.reason, "CONTROLLER_ALREADY_SUCCEEDED");

  const skipped = makeFixture({ controllers: [controllerRun({ kind: "data", headSha: DATA_HEAD, conclusion: "skipped" })] });
  const skippedResult = await inspect(skipped);
  assert.equal(skippedResult.status, "READY");
  assert.equal(skippedResult.selected.kind, "data");
});

test("flags off dispatch a verify request with the exact main inputs", async () => {
  const fixture = makeFixture({ dispatchResult: { workflow_run_id: 9301 } });
  const result = await inspect(fixture, { dispatch: true });
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.dispatch.workflowRunId, 9301);
  assert.equal(result.dispatch.ref, "main");
  assert.deepEqual(result.dispatch.inputs, {
    pr_number: String(fixture.state.dataPrNumber),
    ci_run_id: String(DATA_CI_ID),
    ci_run_attempt: "1",
    expected_head_sha: DATA_HEAD,
    base_sha: MAIN_SHA,
    apply: "false",
  });
  const dispatched = fixture.calls.find((call) => call[0] === "dispatchController");
  assert.equal(dispatched[1].workflowPath, DATA_CONTROLLER_WORKFLOW_PATH);
  assert.equal(dispatched[1].ref, "main");
});

test("enabled data merge requests apply through the same receiver gate", async () => {
  const fixture = makeFixture({ dispatchResult: { workflow_run_id: 9302 } });
  const result = await inspect(fixture, { dispatch: true, env: { ERPC_ENABLE_AUTOMATIC_DATA_MERGE: "true" } });
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.selected.apply, true);
  assert.equal(result.dispatch.inputs.apply, "true");
});

test("release dispatch includes reconcile mode and uses the release flag", async () => {
  const fixture = makeFixture({ data: false, release: true, dispatchResult: { workflow_run_id: 9303 } });
  const result = await inspect(fixture, { dispatch: true, env: { ERPC_ENABLE_AUTOMATIC_RELEASE: "true" } });
  assert.equal(result.status, "DISPATCHED");
  assert.equal(result.selected.kind, "release");
  assert.equal(result.dispatch.workflowPath, RELEASE_CONTROLLER_WORKFLOW_PATH);
  assert.equal(result.dispatch.inputs.mode, "reconcile");
  assert.equal(result.dispatch.inputs.apply, "true");
});

test("a changed branch head or CI attempt aborts the final dispatch recheck", async () => {
  const fixture = makeFixture({ dispatchResult: { workflow_run_id: 9304 } });
  let branchReads = 0;
  const originalGetBranchSha = fixture.adapter.getBranchSha;
  fixture.adapter.getBranchSha = async (branch) => {
    const result = await originalGetBranchSha(branch);
    if (branch === DATA_BRANCH) {
      branchReads += 1;
      if (branchReads >= 2) return "f".repeat(40);
    }
    return result;
  };
  const result = await inspect(fixture, { dispatch: true });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.reason, "CANDIDATE_CHANGED_BEFORE_DISPATCH");
  assert.equal(fixture.calls.some((call) => call[0] === "dispatchController"), false);

  const attemptFixture = makeFixture({ dispatchResult: { workflow_run_id: 9305 } });
  let detailReads = 0;
  const originalGetWorkflowRun = attemptFixture.adapter.getWorkflowRun;
  attemptFixture.adapter.getWorkflowRun = async (id, attempt) => {
    detailReads += 1;
    const run = await originalGetWorkflowRun(id, attempt);
    if (detailReads >= 2) return { ...run, run_attempt: attempt + 1 };
    return run;
  };
  const attemptResult = await inspect(attemptFixture, { dispatch: true });
  assert.equal(attemptResult.status, "NO_ACTION");
  assert.equal(attemptFixture.calls.some((call) => call[0] === "dispatchController"), false);
});

test("dispatch responses without a positive workflow run ID are rejected", async () => {
  const fixture = makeFixture({ dispatchResult: {} });
  const result = await inspect(fixture, { dispatch: true });
  assert.equal(result.status, "NO_ACTION");
  assert.equal(result.reason, "DISPATCH_INVALID");
});
