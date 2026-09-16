import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CATALOG } from "./token-catalog.mjs";
import {
  DEFAULT_RPC_ENDPOINTS,
  TOKEN_PROGRAM_IDS,
  computeConfigDigest,
  observeTokenCatalog,
} from "./observer.mjs";
import {
  ALLOWED_BOT_BRANCHES,
  BOT_BRANCH,
  DATA_CI_ARTIFACT_PREFIX,
  DATA_CI_OBSERVATION_ENTRY,
  DATA_CI_PROVENANCE_ENTRY,
  GITHUB_API_VERSION,
  MANAGED_BY,
  RELEASE_BRANCH,
  WORKFLOW_PATH,
  buildMaintenancePayload,
  buildWorkflowDispatch,
  createGhAdapter,
  semanticFingerprint,
  writeMaintenancePr,
  readTrustedState,
} from "./maintenance-pr.mjs";
import { prepareRelease } from "./release-prep.mjs";

const config = JSON.parse(readFileSync(new URL("./observer-config.json", import.meta.url), "utf8"));
const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const BASE_SHA = SOURCE_SHA;
const COMMIT_SHA = "c".repeat(40);

function abiUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value) {
  const bytes = Buffer.from(value, "utf8");
  return `0x${"20".padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0")}`;
}

function makeRpcTransport() {
  return async (request) => {
    const payload = JSON.parse(Buffer.from(request.body, "utf8"));
    if (payload.method === "eth_chainId") return { statusCode: 200, body: JSON.stringify({ result: request.endpointId === "avalanche-c-public" ? "0xa86a" : "0x1" }) };
    if (payload.method === "eth_blockNumber") return { statusCode: 200, body: JSON.stringify({ result: request.endpointId === "avalanche-c-public" ? "0x5aee016" : "0x18c7852" }) };
    if (payload.method === "eth_getCode") return { statusCode: 200, body: JSON.stringify({ result: "0x60006000" }) };
    if (payload.method === "eth_call") {
      const deployment = CATALOG.deployments.find((entry) => entry.address?.toLowerCase() === payload.params[0].to.toLowerCase());
      return { statusCode: 200, body: JSON.stringify({ result: payload.params[0].data === "0x313ce567" ? abiUint(deployment.decimals) : abiString(deployment.symbol) }) };
    }
    if (payload.method === "getGenesisHash") return { statusCode: 200, body: JSON.stringify({ result: DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash }) };
    if (payload.method === "getSlot") return { statusCode: 200, body: JSON.stringify({ result: 447257739 }) };
    if (payload.method === "getAccountInfo") {
      const deployment = CATALOG.deployments.find((entry) => entry.address === payload.params[0]);
      return { statusCode: 200, body: JSON.stringify({ result: { context: { slot: 447257740 }, value: { owner: deployment.standard === "spl-token" ? TOKEN_PROGRAM_IDS.splToken : TOKEN_PROGRAM_IDS.splToken2022, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: deployment.decimals } }, space: 82 }, executable: false, lamports: 1, rentEpoch: 0 } } }) };
    }
    throw new Error(`unexpected RPC method ${payload.method}`);
  };
}

function makeSourceTransport() {
  return async (request) => {
    const source = config.sources.find((entry) => entry.sourceId === request.sourceId);
    return { statusCode: 200, body: source.format === "json" ? JSON.stringify({ reviewedSignals: source.signals.map((signal) => signal.literal) }) : source.signals.map((signal) => signal.literal).join("\n"), finalUrl: source.url, redirects: 0 };
  };
}

async function makeArtifacts({ sourceSha = SOURCE_SHA, baseline = null, workspace = { clean: true, pinned: true } } = {}) {
  return observeTokenCatalog({ config, sourceSha, rpcTransport: makeRpcTransport(), sourceTransport: makeSourceTransport(), baseline, workspace });
}

function makeState({ baseline = null, priorFindings = null } = {}) {
  return { root: process.cwd(), catalog: CATALOG, config, baseline, priorFindings };
}

async function makePayload(options = {}) {
  const artifacts = options.artifacts ?? await makeArtifacts({ sourceSha: options.sourceSha ?? SOURCE_SHA, baseline: options.observationBaseline ?? null });
  const state = options.state ?? makeState({ baseline: options.trustedBaseline ?? null, priorFindings: options.priorFindings ?? null });
  return { artifacts, payload: buildMaintenancePayload({ observation: artifacts, baseSha: options.baseSha ?? BASE_SHA, expectedSourceSha: options.sourceSha ?? SOURCE_SHA, catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState: state }) };
}

function makeAdapter({ branch, branchSha = null, metadata = null, pullRequests = [], changedPaths = [], verifyHead = null, failCreatePullRequest = false } = {}) {
  const calls = [];
  const state = { branchSha, metadata, pullRequests, changedPaths, verifyHead, failCreatePullRequest };
  const adapter = {
    calls,
    state,
    async getBranchSha(name) { calls.push(["getBranchSha", name]); return name === "main" ? BASE_SHA : name === branch ? state.branchSha : null; },
    async getBranchMetadata(name) { calls.push(["getBranchMetadata", name]); return name === branch ? state.metadata : null; },
    async getChangedPaths(name) { calls.push(["getChangedPaths", name]); return name === branch ? state.changedPaths : []; },
    async listPullRequests(input) { calls.push(["listPullRequests", input]); return state.pullRequests; },
    async commitFiles(input) {
      calls.push(["commitFiles", input]);
      if (input.expectedOldSha !== state.branchSha) Object.assign(new Error("compare-and-swap conflict"), { code: "CAS_CONFLICT" });
      state.branchSha = COMMIT_SHA;
      state.metadata = { ...input.metadata, headSha: COMMIT_SHA, parentSha: input.parentSha, actualOutputDigest: input.metadata.outputDigest, actualContentDigest: input.metadata.contentDigest };
      state.changedPaths = Object.keys(input.files);
      return { sha: COMMIT_SHA };
    },
    async createPullRequest(input) {
      calls.push(["createPullRequest", input]);
      if (state.failCreatePullRequest) { state.failCreatePullRequest = false; throw new Error("simulated PR failure after push"); }
      const result = { number: 17, state: "open", head: { ref: branch }, base: { ref: "main" } };
      state.pullRequests = [result];
      return result;
    },
    async updatePullRequest(number, input) { calls.push(["updatePullRequest", number, input]); return { number, state: "open", head: { ref: branch }, base: { ref: "main" } }; },
    async dispatchWorkflow(input) { calls.push(["dispatchWorkflow", input]); return { accepted: true }; },
    async verifyWorkflowRunHead(response, expectedHead, baseSha, ref) { calls.push(["verifyWorkflowRunHead", response, expectedHead, baseSha, ref]); return state.verifyHead ?? { head_sha: expectedHead, head_branch: ref }; },
  };
  return adapter;
}

test("canonical envelope is exact and legacy artifact maps are rejected", async () => {
  const { artifacts } = await makePayload();
  const forged = { ...structuredClone(artifacts), files: {} };
  assert.throws(() => buildMaintenancePayload({ observation: forged, baseSha: BASE_SHA, expectedSourceSha: SOURCE_SHA, catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState: makeState() }), /exactly|observer envelope|ARTIFACT_INVALID/u);
});

test("forged findings and stale source/catalog/config bindings are rejected after recomputation", async () => {
  const { artifacts } = await makePayload();
  const forged = structuredClone(artifacts);
  forged.findings.findings = [{ category: "source-change", subjectId: config.sources[0].sourceId, fingerprint: "1".repeat(64), code: "SOURCE_SIGNALS_CHANGED", severity: "review" }];
  assert.throws(() => buildMaintenancePayload({ observation: forged, baseSha: BASE_SHA, expectedSourceSha: SOURCE_SHA, catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState: makeState() }), /derived|recomputation|artifact|ARTIFACT_INVALID/u);
  assert.throws(() => buildMaintenancePayload({ observation: artifacts, baseSha: BASE_SHA, expectedSourceSha: "d".repeat(40), catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState: makeState() }), /source|ARTIFACT_INVALID/u);
  assert.notEqual(computeConfigDigest(config), "0".repeat(64));
});

test("complete bootstrap writes a genuine 41-source baseline and never an empty placeholder", async () => {
  const { artifacts, payload } = await makePayload();
  assert.equal(payload.baseline.sources.length, 41);
  assert.equal(payload.baseline.sources.every((source) => source.approvedFinalUrls.length === 1 && source.fingerprint.length === 64), true);
  assert.equal(payload.outputPaths.includes("registry/source-baseline.json"), true);
  assert.notDeepEqual(payload.baseline, {});
});

test("fresh manual 0.7.1 preparation is canonicalized and rejects an extra package edit", async () => {
  const previewRoot = mkdtempSync(join(tmpdir(), "erpc-maintenance-release-test-"));
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", process.cwd(), previewRoot], { stdio: "pipe" });
    cpSync("registry/release-prep.mjs", join(previewRoot, "registry/release-prep.mjs"));
    cpSync("registry/release-plan.json", join(previewRoot, "registry/release-plan.json"));
    cpSync("registry/observer-config.json", join(previewRoot, "registry/observer-config.json"));
    // The observer capture below uses the populated checkout's catalog. Keep
    // the frozen release fixture bound to the same catalog before preparing
    // its manual release, even when the source catalog is still uncommitted.
    cpSync("registry/token-catalog.json", join(previewRoot, "registry/token-catalog.json"));
    const changelogPath = join(previewRoot, "CHANGELOG.md");
    writeFileSync(changelogPath, readFileSync(changelogPath, "utf8").replace("## Unreleased\n", "## Unreleased\n\n- Exercise a manual patch candidate.\n"));
    execFileSync("git", ["add", "registry/release-prep.mjs", "registry/release-plan.json", "registry/observer-config.json", "registry/token-catalog.json", "CHANGELOG.md"], { cwd: previewRoot, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Maintenance Test", "-c", "user.email=maintenance@example.invalid", "commit", "--quiet", "-m", "Add release preparation helpers"], { cwd: previewRoot, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: previewRoot, encoding: "utf8" }).trim();
    const report = prepareRelease({ root: previewRoot, expectedHead: head, version: "0.7.1", releaseDate: "2026-09-15" });
    const artifacts = await makeArtifacts({ sourceSha: head });
    const trustedState = readTrustedState(previewRoot);
    const payload = buildMaintenancePayload({ observation: artifacts, releaseReport: report, baseSha: head, expectedSourceSha: head, catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState });
    assert.equal(payload.branch, RELEASE_BRANCH);
    assert.equal(payload.outputPaths.filter((pathValue) => pathValue === "CHANGELOG.md" || pathValue.startsWith("packages/") || pathValue === "Cargo.lock").length, 7);
    const packagePath = join(previewRoot, "packages/typescript/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.description = "untrusted extra edit";
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    assert.throws(() => buildMaintenancePayload({ observation: artifacts, releaseReport: report, baseSha: head, expectedSourceSha: head, catalogDigest: artifacts.receipts.catalogDigest, configDigest: artifacts.receipts.configDigest, trustedState: readTrustedState(previewRoot) }), /canonical B1 preparation|RELEASE_INVALID/u);
  } finally {
    rmSync(previewRoot, { recursive: true, force: true });
  }
});

test("complete clean no-action returns no PR without touching the adapter", async () => {
  const first = await makeArtifacts();
  const baseline = { schemaVersion: 1, sources: first.receipts.sources.map((source) => ({ sourceId: source.sourceId, fingerprint: source.fingerprint, mode: source.mode, approvedFinalUrls: [source.finalUrl] })) };
  const { payload } = await makePayload({ artifacts: await makeArtifacts({ baseline }), trustedBaseline: baseline });
  assert.equal(payload.observationAction, false);
  const adapter = makeAdapter({ branch: payload.branch });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false });
  assert.equal(result.status, "NO_ACTION");
  assert.deepEqual(adapter.calls, []);
});

test("stale remote main is rejected before any branch or PR mutation", async () => {
  const { payload } = await makePayload();
  const adapter = makeAdapter({ branch: payload.branch });
  const original = adapter.getBranchSha;
  adapter.getBranchSha = async (name) => name === "main" ? "d".repeat(40) : original(name);
  await assert.rejects(() => writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false }), { code: "STALE_MAIN" });
  assert.equal(adapter.calls.some((call) => call[0] === "commitFiles" || call[0] === "createPullRequest" || call[0] === "updatePullRequest"), false);
});

test("successful reads persist a PR that clears a previously stored finding", async () => {
  const first = await makeArtifacts();
  const baseline = { schemaVersion: 1, sources: first.receipts.sources.map((source) => ({ sourceId: source.sourceId, fingerprint: source.fingerprint, mode: source.mode, approvedFinalUrls: [source.finalUrl] })) };
  const priorFindings = { schemaVersion: 1, artifactKind: "maintenance-findings", status: "complete", catalogDigest: "0".repeat(64), configDigest: "1".repeat(64), findings: [{ category: "source-change", subjectId: config.sources[0].sourceId, fingerprint: "2".repeat(64), code: "SOURCE_SIGNALS_CHANGED", severity: "review" }] };
  const artifacts = await makeArtifacts({ baseline });
  const { payload } = await makePayload({ artifacts, trustedBaseline: baseline, priorFindings });
  assert.equal(payload.observation.reviewCandidate.actionRequired, false);
  assert.equal(payload.priorFindingsChanged, true);
  assert.equal(payload.actionRequired, true);
  const adapter = makeAdapter({ branch: payload.branch });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(result.status, "CREATED");
  assert.equal(adapter.calls.some((call) => call[0] === "commitFiles"), true);
});

test("new branch commits allowlisted files, creates PR, and verifies CI against the bot commit", async () => {
  const { payload } = await makePayload();
  const adapter = makeAdapter({ branch: payload.branch });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false });
  assert.equal(result.status, "CREATED");
  assert.equal(result.headSha, COMMIT_SHA);
  const dispatch = adapter.calls.find((call) => call[0] === "dispatchWorkflow")[1];
  assert.equal(dispatch.ref, BOT_BRANCH);
  assert.equal(dispatch.inputs.expected_head_sha, COMMIT_SHA);
  assert.equal(dispatch.inputs.base_sha, BASE_SHA);
  assert.equal(new Set(adapter.state.changedPaths).size <= 4, true);
});

test("existing managed branch and PR are reused on semantic repeats", async () => {
  const { payload } = await makePayload();
  const existingPr = { number: 4, state: "open", head: { ref: payload.branch }, base: { ref: "main" } };
  const adapter = makeAdapter({ branch: payload.branch, branchSha: COMMIT_SHA, metadata: { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: COMMIT_SHA, semanticFingerprint: payload.semanticFingerprint, outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths }, pullRequests: [existingPr], changedPaths: payload.outputPaths });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false });
  assert.equal(result.status, "REUSED");
  assert.equal(adapter.calls.some((call) => call[0] === "commitFiles" || call[0] === "updatePullRequest" || call[0] === "dispatchWorkflow"), false);
});

test("dry-run never dispatches a matching open candidate", async () => {
  const { payload } = await makePayload();
  const head = COMMIT_SHA;
  const existingPr = { number: 22, state: "open", head: { ref: payload.branch }, base: { ref: "main" } };
  const adapter = makeAdapter({ branch: payload.branch, branchSha: head, metadata: { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: head, semanticFingerprint: payload.semanticFingerprint, outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths }, pullRequests: [existingPr], changedPaths: payload.outputPaths });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: true });
  assert.equal(result.status, "DRY_RUN");
  assert.equal(adapter.calls.some((call) => call[0] === "dispatchWorkflow" || call[0] === "verifyWorkflowRunHead"), false);
});

test("current open candidate wins over closed history, while merged same semantics is unchanged", async () => {
  const { payload } = await makePayload();
  const head = COMMIT_SHA;
  const metadata = { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: head, semanticFingerprint: payload.semanticFingerprint, outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths };
  const closed = { number: 27, state: "closed", head: { ref: payload.branch }, base: { ref: "main" }, body: `Semantic fingerprint: \`${payload.semanticFingerprint}\`` };
  const open = { number: 28, state: "open", head: { ref: payload.branch }, base: { ref: "main" } };
  const withBoth = makeAdapter({ branch: payload.branch, branchSha: head, metadata, pullRequests: [closed, open], changedPaths: payload.outputPaths });
  assert.equal((await writeMaintenancePr({ adapter: withBoth, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false })).status, "REUSED");
  const merged = { number: 29, state: "merged", head: { ref: payload.branch }, base: { ref: "main" }, body: `Semantic fingerprint: \`${payload.semanticFingerprint}\`` };
  const withMerged = makeAdapter({ branch: payload.branch, branchSha: head, metadata, pullRequests: [merged], changedPaths: payload.outputPaths });
  const result = await writeMaintenancePr({ adapter: withMerged, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(result.status, "NO_CHANGE_HISTORY");
  assert.equal(withMerged.calls.some((call) => call[0] === "commitFiles"), false);
  const changed = structuredClone(payload);
  changed.semanticFingerprint = "f".repeat(64);
  const withChangedMerged = makeAdapter({ branch: payload.branch, branchSha: head, metadata, pullRequests: [merged], changedPaths: payload.outputPaths });
  const changedResult = await writeMaintenancePr({ adapter: withChangedMerged, payload: changed, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(changedResult.status, "CREATED");
  assert.equal(withChangedMerged.calls.some((call) => call[0] === "commitFiles"), true);
});

test("closed candidate with unchanged managed semantics is not recreated", async () => {
  const { payload } = await makePayload();
  const closedPr = { number: 19, state: "closed", head: { ref: payload.branch }, base: { ref: "main" }, body: `Semantic fingerprint: \`${payload.semanticFingerprint}\`` };
  const head = COMMIT_SHA;
  const adapter = makeAdapter({ branch: payload.branch, branchSha: head, metadata: { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: head, semanticFingerprint: payload.semanticFingerprint, outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths }, pullRequests: [closedPr], changedPaths: payload.outputPaths });
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false });
  assert.equal(result.status, "NO_CHANGE_HISTORY");
  assert.equal(adapter.calls.some((call) => call[0] === "commitFiles" || call[0] === "createPullRequest" || call[0] === "updatePullRequest" || call[0] === "dispatchWorkflow"), false);
});

test("CAS conflict and human branch edits refuse mutation", async () => {
  const { payload } = await makePayload();
  const conflictHead = "e".repeat(40);
  const conflict = makeAdapter({ branch: payload.branch, branchSha: conflictHead, metadata: { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: conflictHead, semanticFingerprint: "f".repeat(64), outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths }, changedPaths: payload.outputPaths });
  conflict.commitFiles = async () => { throw Object.assign(new Error("CAS conflict"), { code: "CAS_CONFLICT" }); };
  await assert.rejects(() => writeMaintenancePr({ adapter: conflict, payload, frozenMainSha: BASE_SHA, dryRun: false }), { code: "CAS_CONFLICT" });
  const human = makeAdapter({ branch: payload.branch, branchSha: "e".repeat(40), metadata: null });
  await assert.rejects(() => writeMaintenancePr({ adapter: human, payload, frozenMainSha: BASE_SHA, dryRun: false }), { code: "HUMAN_BRANCH_EDIT" });
});

test("retry after a failed PR call reuses the pushed managed branch", async () => {
  const { payload } = await makePayload();
  const adapter = makeAdapter({ branch: payload.branch, failCreatePullRequest: true });
  await assert.rejects(() => writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false }));
  const firstCommitCount = adapter.calls.filter((call) => call[0] === "commitFiles").length;
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(result.status, "CREATED");
  assert.equal(adapter.calls.filter((call) => call[0] === "commitFiles").length, firstCommitCount);
});

test("new candidate is retryable after an older closed history entry and a post-push PR failure", async () => {
  const { payload } = await makePayload();
  const head = COMMIT_SHA;
  const oldClosed = { number: 31, state: "closed", head: { ref: payload.branch }, base: { ref: "main" }, body: `Semantic fingerprint: \`${"f".repeat(64)}\`` };
  const metadata = { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: head, semanticFingerprint: payload.semanticFingerprint, outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths };
  const adapter = makeAdapter({ branch: payload.branch, branchSha: head, metadata, pullRequests: [oldClosed], changedPaths: payload.outputPaths, failCreatePullRequest: true });
  await assert.rejects(() => writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false }));
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(result.status, "CREATED");
  assert.equal(adapter.calls.filter((call) => call[0] === "createPullRequest").length, 2);
});

test("a failed dispatch never overrides a later --no-dispatch retry", async () => {
  const { payload } = await makePayload();
  const adapter = makeAdapter({ branch: payload.branch });
  adapter.dispatchWorkflow = async () => { throw new Error("simulated workflow dispatch failure"); };
  await assert.rejects(() => writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: true }));
  const dispatchesBefore = adapter.calls.filter((call) => call[0] === "dispatchWorkflow").length;
  const result = await writeMaintenancePr({ adapter, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false });
  assert.equal(result.status, "REUSED");
  assert.equal(adapter.calls.filter((call) => call[0] === "dispatchWorkflow").length, dispatchesBefore);
});

test("unexpected changed paths and returned CI heads are refused", async () => {
  const { payload } = await makePayload();
  const badPaths = makeAdapter({ branch: payload.branch, branchSha: COMMIT_SHA, metadata: { managedBy: MANAGED_BY, branch: payload.branch, baseSha: BASE_SHA, parentSha: BASE_SHA, headSha: COMMIT_SHA, semanticFingerprint: "f".repeat(64), outputDigest: payload.outputDigest, actualOutputDigest: payload.outputDigest, contentDigest: payload.contentDigest, actualContentDigest: payload.contentDigest, outputPaths: payload.outputPaths }, changedPaths: [...payload.outputPaths, "packages/typescript/src/index.ts"] });
  await assert.rejects(() => writeMaintenancePr({ adapter: badPaths, payload, frozenMainSha: BASE_SHA, dryRun: false, dispatch: false }), { code: "HUMAN_BRANCH_EDIT" });
  const badRun = makeAdapter({ branch: payload.branch, verifyHead: { head_sha: "d".repeat(40), head_branch: payload.branch } });
  await assert.rejects(() => writeMaintenancePr({ adapter: badRun, payload, frozenMainSha: BASE_SHA, dryRun: false }), { code: "WORKFLOW_HEAD_MISMATCH" });
  const mismatchedRunId = makeAdapter({ branch: payload.branch });
  mismatchedRunId.dispatchWorkflow = async (workflow) => { mismatchedRunId.calls.push(["dispatchWorkflow", workflow]); return { workflow_run_id: 123, base_sha: BASE_SHA }; };
  mismatchedRunId.verifyWorkflowRunHead = async (...args) => { mismatchedRunId.calls.push(["verifyWorkflowRunHead", ...args]); return { id: 122, head_sha: COMMIT_SHA, head_branch: payload.branch }; };
  await assert.rejects(() => writeMaintenancePr({ adapter: mismatchedRunId, payload, frozenMainSha: BASE_SHA, dryRun: false }), { code: "WORKFLOW_HEAD_MISMATCH" });
});

test("semantic fingerprints ignore source SHA, block, raw hash, and date-only noise", () => {
  const left = semanticFingerprint({ sourceSha: SOURCE_SHA, blockNumber: "0x1", bodySha256: "1".repeat(64), observedAt: "2026-09-15T00:00:00Z", value: 1, note: "same" });
  const right = semanticFingerprint({ sourceSha: "d".repeat(40), blockNumber: "0x2", bodySha256: "2".repeat(64), observedAt: "2026-09-16T00:00:00Z", value: 1, note: "same" });
  assert.equal(left, right);
});

test("workflow dispatch uses only the two fixed branches and the required API version", () => {
  const head = "c".repeat(40);
  for (const branch of ALLOWED_BOT_BRANCHES) {
    const workflow = buildWorkflowDispatch({ branch, expectedHeadSha: head, baseSha: BASE_SHA });
    assert.equal(workflow.apiVersion, GITHUB_API_VERSION);
    assert.deepEqual(Object.keys(workflow.inputs).sort(), ["base_sha", "expected_head_sha"]);
  }
  assert.throws(() => buildWorkflowDispatch({ branch: "codex/weekly-maintenance", expectedHeadSha: head, baseSha: BASE_SHA }), /fixed|branch|policy/u);
  assert.equal(RELEASE_BRANCH, "codex/release-preparation");
});

function installGhStub(directory) {
  const scriptPath = join(directory, "gh");
  writeFileSync(scriptPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const inputIndex = args.indexOf("--input");
const body = inputIndex >= 0 ? JSON.parse(readFileSync(0, "utf8")) : null;
const path = args[0] === "api" ? args[1] : "";
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, body }) + "\\n");
const oldHead = process.env.FAKE_OLD_HEAD ?? "a".repeat(40);
const baseHead = process.env.FAKE_BASE_HEAD ?? "b".repeat(40);
const nextHead = process.env.FAKE_NEXT_HEAD ?? "c".repeat(40);
const blobSha = "d".repeat(40);
const treeSha = "e".repeat(40);
if (path === "graphql") {
  if (body.query.includes("updateRefs")) process.stdout.write(JSON.stringify({ data: { updateRefs: { clientMutationId: "test" } } }));
  else process.stdout.write(JSON.stringify({ data: { repository: { id: "repo-node-id" } } }));
} else if (path.endsWith("/dispatches")) process.stdout.write(JSON.stringify({ workflow_run_id: Number(process.env.FAKE_RUN_ID ?? "123"), run_url: "https://example.invalid/run", html_url: "https://example.invalid/run" }));
else if (path.includes("/actions/runs/")) process.stdout.write(JSON.stringify({ id: Number(process.env.FAKE_RETURNED_RUN_ID ?? process.env.FAKE_RUN_ID ?? "123"), head_sha: process.env.FAKE_RUN_HEAD ?? nextHead, head_branch: "codex/registry-maintenance", event: "workflow_dispatch", inputs: { base_sha: baseHead } }));
else if (path.includes("/git/commits/") && !path.endsWith("/git/commits")) {
  const message = ["chore", "", "ERPC-Maintenance-Managed-By: erpc-sdk-weekly-maintenance", "ERPC-Maintenance-Branch: codex/registry-maintenance", "ERPC-Maintenance-Base-SHA: " + baseHead, "ERPC-Maintenance-Source-SHA: " + baseHead, "ERPC-Maintenance-Catalog-Digest: " + "1".repeat(64), "ERPC-Maintenance-Config-Digest: " + "2".repeat(64), "ERPC-Maintenance-Semantic-Fingerprint: " + "3".repeat(64), "ERPC-Maintenance-Output-Digest: " + (process.env.FAKE_OUTPUT_DIGEST ?? "4".repeat(64)), "ERPC-Maintenance-Content-Digest: " + (process.env.FAKE_CONTENT_DIGEST ?? "5".repeat(64)), "ERPC-Maintenance-Output-Paths: " + (process.env.FAKE_OUTPUT_PATHS ?? "registry/maintenance-findings.json")].join("\\n");
  if (process.env.FAKE_METADATA_MODE) process.stdout.write(JSON.stringify({ message, parents: [{ sha: baseHead }], tree: { sha: treeSha } }));
  else process.stdout.write(JSON.stringify({ tree: { sha: treeSha } }));
} else if (path.includes("/git/ref/heads/")) process.stdout.write(JSON.stringify({ object: { sha: oldHead } }));
else if (path.includes("/compare/")) process.stdout.write(JSON.stringify({ files: [{ filename: process.env.FAKE_COMPARE_PATH ?? "registry/maintenance-findings.json" }] }));
else if (path.includes("/git/trees/")) process.stdout.write(JSON.stringify({ tree: (process.env.FAKE_OUTPUT_PATHS ?? "registry/maintenance-findings.json").split(",").map((name) => ({ path: name, type: "blob", sha: blobSha })) }));
else if (path.includes("/git/blobs/")) process.stdout.write(JSON.stringify({ encoding: "base64", content: Buffer.from(process.env.FAKE_CONTENT_JSON ?? "{}\\n").toString("base64") }));
else if (path.endsWith("/git/blobs")) process.stdout.write(JSON.stringify({ sha: blobSha }));
else if (path.endsWith("/git/trees")) process.stdout.write(JSON.stringify({ sha: treeSha }));
else if (path.endsWith("/git/commits")) process.stdout.write(JSON.stringify({ sha: nextHead }));
else if (path.endsWith("/git/refs")) process.stdout.write(JSON.stringify({ ref: "refs/heads/codex/registry-maintenance" }));
else process.stdout.write(JSON.stringify({}));
`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("real gh adapter uses force-enabled beforeOid CAS for refreshed sibling commits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "erpc-maintenance-gh-cas-"));
  try {
    const logPath = join(directory, "gh.jsonl");
    installGhStub(directory);
    const oldHead = "a".repeat(40);
    const baseHead = "b".repeat(40);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_GH_LOG: logPath, FAKE_OLD_HEAD: oldHead, FAKE_BASE_HEAD: baseHead, FAKE_NEXT_HEAD: "c".repeat(40) };
    const adapter = createGhAdapter({ repo: "owner/repo", root: directory, env });
    await adapter.commitFiles({ branch: BOT_BRANCH, parentSha: baseHead, expectedOldSha: oldHead, baseSha: baseHead, files: { "registry/maintenance-findings.json": "{}\n" }, message: "test" });
    const calls = readFileSync(logPath, "utf8").trim().split(/\n/u).map((line) => JSON.parse(line));
    const update = calls.find((call) => call.body?.query?.includes("updateRefs"));
    assert.equal(update.body.variables.refUpdates[0].beforeOid, oldHead);
    assert.equal(update.body.variables.refUpdates[0].afterOid, "c".repeat(40));
    assert.equal(update.body.variables.refUpdates[0].force, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real gh adapter authenticates declared output paths and rejects retained-trailer content edits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "erpc-maintenance-gh-content-"));
  try {
    const outputPaths = ["registry/evidence/maintenance-review.json", "registry/maintenance-findings.json"].sort();
    const files = { [outputPaths[0]]: "{}\n", [outputPaths[1]]: "{}\n" };
    const semantic = semanticFingerprint({ [outputPaths[0]]: {}, [outputPaths[1]]: {} });
    const bytes = createHash("sha256");
    for (const pathValue of outputPaths) bytes.update(pathValue, "utf8").update("\0", "utf8").update(files[pathValue], "utf8").update("\0", "utf8");
    const contentDigest = bytes.digest("hex");
    installGhStub(directory);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_METADATA_MODE: "1", FAKE_OLD_HEAD: "a".repeat(40), FAKE_BASE_HEAD: "b".repeat(40), FAKE_OUTPUT_DIGEST: semantic, FAKE_CONTENT_DIGEST: contentDigest, FAKE_OUTPUT_PATHS: outputPaths.join(","), FAKE_CONTENT_JSON: "{}\n" };
    const adapter = createGhAdapter({ repo: "owner/repo", root: directory, env });
    const metadata = await adapter.getBranchMetadata(BOT_BRANCH);
    assert.deepEqual(metadata.outputPaths, outputPaths);
    assert.equal(metadata.actualContentDigest, contentDigest);
    env.FAKE_CONTENT_JSON = "{\"edited\":true}\n";
    await assert.rejects(() => adapter.getBranchMetadata(BOT_BRANCH), { code: "HUMAN_BRANCH_EDIT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real gh adapter binds workflow_run_id, head, ref, and requested base", async () => {
  const directory = mkdtempSync(join(tmpdir(), "erpc-maintenance-gh-run-"));
  try {
    installGhStub(directory);
    const baseHead = "b".repeat(40);
    const botHead = "c".repeat(40);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_BASE_HEAD: baseHead, FAKE_NEXT_HEAD: botHead, FAKE_RUN_ID: "123" };
    const adapter = createGhAdapter({ repo: "owner/repo", root: directory, env });
    const workflow = buildWorkflowDispatch({ branch: BOT_BRANCH, expectedHeadSha: botHead, baseSha: baseHead });
    const response = await adapter.dispatchWorkflow(workflow);
    const run = await adapter.verifyWorkflowRunHead(response, botHead, baseHead, BOT_BRANCH);
    assert.equal(run.id, 123);
    env.FAKE_RETURNED_RUN_ID = "122";
    await assert.rejects(() => adapter.verifyWorkflowRunHead(response, botHead, baseHead, BOT_BRANCH), { code: "WORKFLOW_HEAD_MISMATCH" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real gh adapter fetches only the exact bounded CI observation artifact with portable unzip dates", { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "erpc-maintenance-gh-artifact-"));
  const badDirectory = mkdtempSync(join(tmpdir(), "erpc-maintenance-gh-artifact-bad-"));
  try {
    const runId = 901;
    const runAttempt = 2;
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    // Exercise the finite 16 MiB CI entry bound with a synthetic payload;
    // default sizing is captured separately from a plain collector run.
    const observation = { schemaVersion: 1, kind: "erpc-sdk-data-maintenance-observation", sourceSha: headSha, baseSha, padding: "x".repeat(12 * 1024 * 1024) };
    const observationBytes = Buffer.from(JSON.stringify(observation), "utf8");
    const provenance = {
      schemaVersion: 1,
      kind: "erpc-sdk-ci-provenance",
      headSha,
      testedHeadSha: headSha,
      sourceSha: headSha,
      baseSha,
      workflowPath: WORKFLOW_PATH,
      runId,
      runAttempt,
      event: "workflow_dispatch",
      observationSha256: createHash("sha256").update(observationBytes).digest("hex"),
      observationByteLength: observationBytes.byteLength,
    };
    writeFileSync(join(directory, DATA_CI_OBSERVATION_ENTRY), observationBytes);
    writeFileSync(join(directory, DATA_CI_PROVENANCE_ENTRY), `${JSON.stringify(provenance)}\n`);
    const zipPath = join(directory, "artifact.zip");
    execFileSync("zip", ["-q", zipPath, DATA_CI_OBSERVATION_ENTRY, DATA_CI_PROVENANCE_ENTRY], { cwd: directory });
    writeFileSync(join(badDirectory, DATA_CI_OBSERVATION_ENTRY), observationBytes);
    writeFileSync(join(badDirectory, DATA_CI_PROVENANCE_ENTRY), `${JSON.stringify({ ...provenance, observationSha256: "c".repeat(64) })}\n`);
    const badZipPath = join(badDirectory, "artifact.zip");
    execFileSync("zip", ["-q", badZipPath, DATA_CI_OBSERVATION_ENTRY, DATA_CI_PROVENANCE_ENTRY], { cwd: badDirectory });
    const scriptPath = join(directory, "gh");
    writeFileSync(scriptPath, `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = process.argv[3] ?? "";
const runId = ${runId};
const runAttempt = ${runAttempt};
const headSha = "${headSha}";
const expectedName = "${DATA_CI_ARTIFACT_PREFIX}" + headSha + "-" + runId + "-" + runAttempt;
if (path.endsWith("/actions/runs/" + runId)) process.stdout.write(JSON.stringify({ id: runId, run_attempt: runAttempt, head_sha: headSha, head_branch: "codex/registry-maintenance", ref: "refs/heads/codex/registry-maintenance", event: "workflow_dispatch", path: "${WORKFLOW_PATH}", repository: { full_name: "owner/repo" } }));
else if (path.includes("/actions/runs/" + runId + "/jobs")) process.stdout.write(JSON.stringify({ jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] }));
else if (path.includes("/actions/runs/" + runId + "/artifacts")) process.stdout.write(JSON.stringify({ artifacts: [{ id: 123, name: expectedName, expired: false, workflow_run: { id: runId } }] }));
else if (path.includes("/actions/artifacts/123/zip")) process.stdout.write(readFileSync(process.env.FAKE_ZIP));
else process.stdout.write(JSON.stringify({}));
    `);
    chmodSync(scriptPath, 0o755);
    const realUnzip = execFileSync("which", ["unzip"], { encoding: "utf8" }).trim();
    const unzipPath = join(directory, "unzip");
    const unzipMarker = join(directory, "unzip-invocations");
    writeFileSync(unzipMarker, "");
    writeFileSync(unzipPath, `#!/usr/bin/env node
const { appendFileSync, writeSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const real = ${JSON.stringify(realUnzip)};
const marker = ${JSON.stringify(unzipMarker)};
const args = process.argv.slice(2);
appendFileSync(marker, args[0] + "\\n");
const result = spawnSync(real, args, { encoding: null, maxBuffer: 16 * 1024 * 1024 + 1 });
if (result.status === 0 && args[0] === "-l") {
  const listing = Buffer.from(result.stdout ?? "").toString("utf8").replace(/\\b\\d{2}-\\d{2}-\\d{4}\\b/gu, "2026-09-16");
  writeSync(1, listing);
} else {
  if (result.stdout?.length) writeSync(1, result.stdout);
}
if (result.stderr?.length) writeSync(2, result.stderr);
process.exit(result.status ?? 1);
`);
    chmodSync(unzipPath, 0o755);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_ZIP: zipPath };
    const adapter = createGhAdapter({ repo: "owner/repo", root: directory, env });
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    try {
      const result = await adapter.getMaintenanceObservation(runId, runAttempt, { expectedHead: headSha, expectedBase: baseSha });
      assert.deepEqual(result.observation, observation);
      assert.equal(result.provenance.observationByteLength, observationBytes.byteLength);
      assert.match(readFileSync(unzipMarker, "utf8"), /-l\n/u, "portable date wrapper was not invoked for the detailed listing");
      env.FAKE_ZIP = badZipPath;
      await assert.rejects(() => adapter.getMaintenanceObservation(runId, runAttempt, { expectedHead: headSha, expectedBase: baseSha }), { code: "CI_PROVENANCE_INVALID" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(badDirectory, { recursive: true, force: true });
  }
});
