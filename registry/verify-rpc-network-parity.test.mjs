import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fixture from "./fixtures/rpc-chain-contract-cases.json" with { type: "json" };

import {
  PARITY_LANGUAGES,
  buildExpectedSnapshot,
  computeFixtureDigest,
  verifySnapshots,
  verifySyntheticSnapshots,
  applyChunkPlan,
  DESCRIPTOR_LIMITS,
  expandDescriptorChunks,
  measureExpandedChunks,
  resolveCaseResponseSource,
  validateDescriptorOracle,
  validateDescriptorShape,
  validateFixtureSchema,
  validateFixtures,
  computeSnapshotPayloadSha256,
  validateObservedCase,
  validateSingleSnapshot,
  normalizeJsonRequestBytes,
} from "./verify-rpc-network-parity.mjs";
import { CONTRACT, expectedScope, stableJson } from "./rpc-network-contract.mjs";

const clone = (value) => structuredClone(value);
const snapshots = (throughCohort = 5) => PARITY_LANGUAGES.map((language) => buildExpectedSnapshot({ language, throughCohort }));

function nativeShapedTestSnapshots(throughCohort) {
  const scope = expectedScope(throughCohort, CONTRACT);
  const networks = new Map(CONTRACT.networks.map((network) => [network.networkId, network]));
  const clients = new Map(CONTRACT.clientContracts.map((client) => [client.clientContractId, client]));
  const methods = new Map(CONTRACT.methodSets.map((methodSet) => [methodSet.methodSetId, methodSet]));
  return PARITY_LANGUAGES.map((language) => {
    const coverage = scope.networkIds.map((networkId) => {
      const network = networks.get(networkId); const client = clients.get(network.clientContractId); const methodSet = methods.get(client.methodSetId);
      return { networkId, clientContractId: client.clientContractId, namespace: client.namespace, methodSetDigest: createHash("sha256").update(stableJson(methodSet)).digest("hex"), routePolicyIds: client.endpointModes.map((mode) => mode.transportProfileId).sort(), portableCasesExecuted: true };
    });
    const behavior = Object.fromEntries(fixture.cases.filter((entry) => scope.networkIds.includes(entry.networkId) && entry.applicability.includes(language)).sort((left, right) => left.caseId.localeCompare(right.caseId)).map((entry) => {
      const client = clients.get(entry.clientContractId); const methodSet = methods.get(client.methodSetId); const capability = methodSet.capabilities?.find((candidate) => candidate.wireOperation === entry.operation.wireOperation);
      const value = structuredClone(entry.expected);
      value.operation = { publicOperation: capability?.publicNames?.[language] ?? entry.operation.publicOperations?.[language] ?? capability?.publicOperation ?? entry.operation.publicOperation, wireOperation: entry.operation.wireOperation, params: structuredClone(entry.operation.params) };
      value.caseKind = entry.caseKind; value.exceptionIds = [...entry.exceptionIds].sort();
      if (entry.caseId === "c1-schedule-pre-cancel") value.endpointDiagnostic = entry.expected.endpointDiagnostic;
      else if (entry.expected.ioCount === 1 && entry.expected.trace.target !== "NO_IO") value.endpointDiagnostic = `${new URL(entry.expected.trace.target).origin}/`; else value.endpointDiagnostic = "";
      if (entry.expected.ioCount === 1 && entry.mockExchange.request.bodyEncoding === "json") value.trace.bodySha256 = normalizeJsonRequestBytes(Buffer.from(entry.mockExchange.request.body, "utf8")).sha256;
      if (language === "rust" && entry.clientContractId === "client-bitcoin-rpc" && entry.exceptionIds.includes("rust-bitcoin-raw-batch-v1") && ["c1-hosted-bitcoin-bearer-no-query-null-error", "c1-direct-bitcoin-exact-target-scoped-header-keyless", "c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"].includes(entry.caseId)) value.surface.forbidden = value.surface.forbidden.filter((item) => !["raw", "request", "batch"].includes(item));
      if (language === "ruby" && entry.exceptionIds.includes("ruby-bitcoin-synchronous-request-v1") && ["life-pre-cancel", "life-first-chunk-cancellation-barrier"].includes(entry.scheduleId)) {
        value.outcome = { kind: "not-applicable", value: "ruby-bitcoin-synchronous-request-v1" }; value.trace = { ioKind: "none", method: "NONE", target: "NO_IO", headers: {}, bodySha256: entry.expected.trace.bodySha256, attempts: 0 }; value.ioCount = 0;
      }
      return [entry.caseId, value];
    }));
    const surface = [...new Set(scope.networkIds.map((networkId) => networks.get(networkId).clientContractId))].sort().map((clientContractId) => {
      const client = clients.get(clientContractId); const methodSet = methods.get(client.methodSetId); const allowed = methodSet.kind === "expanded" ? methodSet.capabilities.map((entry) => entry.publicNames?.[language] ?? entry.publicOperation) : ["legacy-reference"]; const forbidden = [...client.forbiddenCapabilities]; if (language === "rust" && clientContractId === "client-bitcoin-rpc") for (const name of ["raw", "request", "batch"]) { const index = forbidden.indexOf(name); if (index >= 0) forbidden.splice(index, 1); } return { clientContractId, allowed, forbidden: forbidden.sort() };
    });
    return { snapshotVersion: 1, snapshotKind: "rpc-network-native-runtime", language, runtime: "independent-loopback-runtime", contractVersion: CONTRACT.contractVersion, contractDigest: CONTRACT.contentDigest, fixtureDigest: fixture.fixtureDigest, scope, coverage, behavior, surface };
  });
}

test("verifier accepts exactly five explicit synthetic snapshots for every cumulative cohort", () => {
  for (const throughCohort of [1, 2, 3, 4, 5]) {
    const result = verifySyntheticSnapshots(snapshots(throughCohort), { throughCohort });
    assert.equal(result.networkRows, [8, 11, 14, 17, 20][throughCohort - 1]);
    assert.deepEqual(result.languages.map((entry) => entry.language), PARITY_LANGUAGES);
  }
});

test("verifier rejects missing or duplicate runtimes and arbitrary scope", () => {
  assert.throws(() => verifySyntheticSnapshots(snapshots().slice(0, 4)), /exactly 5/u);
  const duplicate = snapshots();
  duplicate[4] = clone(duplicate[0]);
  assert.throws(() => verifySyntheticSnapshots(duplicate), /duplicate|exactly TypeScript/u);
  const wrongScope = snapshots(1);
  wrongScope[0].scope.networkIds = ["rpc-bitcoin-mainnet"];
  assert.throws(() => verifySyntheticSnapshots(wrongScope, { throughCohort: 1 }), /scope/u);
});

test("coverage checks reject missing rows, wrong client, route, and method digests", () => {
  const missing = snapshots();
  missing[0].coverage.pop();
  assert.throws(() => verifySyntheticSnapshots(missing), /coverage count/u);
  const wrongClient = snapshots();
  wrongClient[0].coverage[0].clientContractId = "client-bitcoin-rpc";
  assert.throws(() => verifySyntheticSnapshots(wrongClient), /coverage/u);
  const wrongRoute = snapshots();
  wrongRoute[0].coverage[0].routePolicyIds.push("unexpected-route");
  assert.throws(() => verifySyntheticSnapshots(wrongRoute), /coverage/u);
  const wrongMethodDigest = snapshots();
  wrongMethodDigest[0].coverage[0].methodSetDigest = "0".repeat(64);
  assert.throws(() => verifySyntheticSnapshots(wrongMethodDigest), /coverage/u);
});

test("behavior checks reject rounded Bitcoin values, changed params, and altered Sui bytes", () => {
  const rounded = snapshots();
  rounded[0].behavior["c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values"].numericTuples[0].coefficient = "9007199254740992";
  assert.throws(() => verifySyntheticSnapshots(rounded), /behavior/u);
  const params = snapshots();
  params[1].behavior["c1-hosted-base-root-query-auth"].trace.bodySha256 = "1".repeat(64);
  assert.throws(() => verifySyntheticSnapshots(params), /behavior/u);
  const binary = snapshots();
  binary[2].behavior["c5-sui-binary-limit-descriptor"].binary.sha256 = "2".repeat(64);
  assert.throws(() => verifySyntheticSnapshots(binary), /behavior/u);
});

test("verifier rejects stale digests, renderer-only evidence, and hidden credential attempts", () => {
  const stale = snapshots();
  stale[0].fixtureDigest = "f".repeat(64);
  assert.throws(() => verifySyntheticSnapshots(stale), /digest/u);
  const renderer = snapshots();
  renderer[0].runtime = "canonical-reference";
  assert.throws(() => verifySyntheticSnapshots(renderer), /not native evidence/u);
  const hidden = snapshots();
  hidden[0].behavior["c1-hosted-bitcoin-bearer-no-query-null-error"].trace.headers.authorization = "Bearer fixture-api-key";
  assert.throws(() => verifySyntheticSnapshots(hidden), /credential sentinel/u);
  const hiddenQuery = snapshots();
  hiddenQuery[0].behavior["c1-direct-bitcoin-exact-target-scoped-header-keyless"].trace.target = "https://node.fixture.invalid/rpc?access=fixture-secret";
  assert.throws(() => verifySyntheticSnapshots(hiddenQuery), /credential sentinel/u);
});

test("verifier keeps finite applicability and Ruby lifecycle exceptions explicit", () => {
  const rust = snapshots();
  assert.ok(Object.hasOwn(rust[1].behavior, "c1-rust-bitcoin-legacy-raw-batch-remains"));
  assert.equal(Object.hasOwn(rust[0].behavior, "c1-rust-bitcoin-legacy-raw-batch-remains"), false);
  const ruby = rust.find((entry) => entry.language === "ruby");
  assert.ok(Object.hasOwn(ruby.behavior, "c1-ruby-bitcoin-synchronous-request-exception"));
  const python = rust.find((entry) => entry.language === "python");
  assert.equal(Object.hasOwn(python.behavior, "c1-ruby-bitcoin-synchronous-request-exception"), false);
});

test("production CLI rejects all five expected-template outputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-synthetic-cli-"));
  const files = [];
  for (const language of PARITY_LANGUAGES) {
    const file = path.join(directory, `${language}.json`);
    await writeFile(file, JSON.stringify(buildExpectedSnapshot({ language })));
    files.push(file);
  }
  const args = ["registry/verify-rpc-network-parity.mjs", "--all", ...files.flatMap((file) => ["--snapshot", file])];
  const result = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /expected-template|not native evidence/u);
});

test("production CLI rejects missing language and incomplete native coverage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-native-cli-"));
  const independent = nativeShapedTestSnapshots(1);
  const files = [];
  for (const [index, snapshot] of independent.entries()) {
    const file = path.join(directory, `${snapshot.language}.json`);
    await writeFile(file, JSON.stringify(snapshot));
    if (index < 4) files.push(file);
  }
  const duplicateArgs = ["registry/verify-rpc-network-parity.mjs", "--through-cohort", "1", "--snapshot", files[0], "--snapshot", files[1], "--snapshot", files[2], "--snapshot", files[3], "--snapshot", files[0]];
  const duplicate = spawnSync(process.execPath, duplicateArgs, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(duplicate.status, 0);
  assert.match(`${duplicate.stdout}${duplicate.stderr}`, /duplicate|exactly TypeScript/u);
  const incomplete = clone(independent);
  incomplete[0].coverage.pop();
  const incompleteFiles = [];
  for (const snapshot of incomplete) {
    const file = path.join(directory, `incomplete-${snapshot.language}.json`);
    await writeFile(file, JSON.stringify(snapshot));
    incompleteFiles.push(file);
  }
  const incompleteArgs = ["registry/verify-rpc-network-parity.mjs", "--through-cohort", "1", ...incompleteFiles.flatMap((file) => ["--snapshot", file])];
  const incompleteResult = spawnSync(process.execPath, incompleteArgs, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(incompleteResult.status, 0);
  assert.match(`${incompleteResult.stdout}${incompleteResult.stderr}`, /coverage count/u);
});

test("production native-shaped all-network validation requires capture evidence", () => {
  const nativeShaped = snapshots().map((snapshot) => ({ ...snapshot, snapshotKind: "rpc-network-native-runtime", runtime: "recorded-package-runtime" }));
  assert.throws(() => verifySnapshots(nativeShaped), /missing capture evidence/u);
  const c1 = snapshots(1).map((snapshot) => ({ ...snapshot, snapshotKind: "rpc-network-native-runtime", runtime: "recorded-package-runtime" }));
  assert.equal(verifySnapshots(c1, { throughCohort: 1 }).networkRows, 8);
});

test("production CLI rejects fabricated native evidence with an unbound payload hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-evidence-cli-"));
  const manifestSha256 = createHash("sha256").update("fixed-source-manifest\n").digest("hex");
  const captured = evidenceBackedSnapshots().map((snapshot) => ({ ...snapshot, evidence: { ...snapshot.evidence, sourceIdentity: snapshot.language === "rust" ? snapshot.evidence.sourceIdentity : { ...snapshot.evidence.sourceIdentity, sourceManifestSha256: manifestSha256 }, snapshotSha256: "a".repeat(64), capture: { ...snapshot.evidence.capture, snapshotSha256: "a".repeat(64) } } }));
  const files = [];
  const args = ["registry/verify-rpc-network-parity.mjs", "--all"];
  for (const snapshot of captured) {
    const file = path.join(directory, `${snapshot.language}.json`); await writeFile(file, JSON.stringify(snapshot)); files.push(file); args.push("--snapshot", file);
  }
  for (const language of ["typescript", "python", "go", "ruby"]) {
    const manifest = path.join(directory, `${language}.manifest`); await writeFile(manifest, "fixed-source-manifest\n"); args.push("--source-manifest", `${language}=${manifest}`);
  }
  const result = spawnSync(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /computed payload binding/u);
});

test("production-shaped snapshot structure derives native operation and surface fields", () => {
  const captured = nativeShapedTestSnapshots(1);
  const result = verifySnapshots(captured, { throughCohort: 1 });
  assert.equal(result.networkRows, 8);
  assert.equal(captured.find((snapshot) => snapshot.language === "typescript").runtime, "independent-loopback-runtime");
  assert.equal(captured.find((snapshot) => snapshot.language === "rust").behavior["c1-hosted-bitcoin-bearer-no-query-null-error"].operation.publicOperation, "get_blockchain_info");
});

test("Rust all-network native evidence requires the accepted immutable artifact identity", () => {
  const captured = nativeShapedTestSnapshots(5).map((snapshot) => ({
    ...snapshot,
    evidence: {
      kind: snapshot.language === "rust" ? "rust-immutable-artifact-v1" : "native-capture-v1",
      command: "local-capture-command",
      exitCode: 0,
      sourceIdentity: snapshot.language === "rust"
        ? { kind: "rust-crate-v1", version: "0.11.0", sourceCommit: "4877b32a32ffb6b82a6620040fe77fc2e73f4386", crateSha256: "fe3e0e224a60921531d09442ecbe68ab9a34ae3ebed7821ab02a309b8b66f7f6", crateSizeBytes: 254463 }
        : { kind: "frozen-source-manifest-v1", version: "0.11.0", sourceManifestSha256: "c".repeat(64) },
      consumer: { command: "fresh-consumer", exitCode: 0, status: "success" },
      capture: { command: "native-capture", exitCode: 0, snapshotSha256: computeSnapshotPayloadSha256(snapshot), networkCount: 20, caseCount: Object.keys(snapshot.behavior).length },
      snapshotSha256: computeSnapshotPayloadSha256(snapshot),
    },
  }));
  captured.find((snapshot) => snapshot.language === "rust").evidence.sourceIdentity.crateSha256 = "b".repeat(64);
  assert.throws(() => verifySnapshots(captured, { sourceManifestSha256ByLanguage: { typescript: "c".repeat(64), python: "c".repeat(64), go: "c".repeat(64), ruby: "c".repeat(64) } }), /immutable artifact identity/u);
});

function evidenceBackedSnapshots() {
  return nativeShapedTestSnapshots(5).map((snapshot) => {
    const payloadSha256 = computeSnapshotPayloadSha256(snapshot);
    const sourceIdentity = snapshot.language === "rust"
      ? { kind: "rust-crate-v1", version: "0.11.0", sourceCommit: "4877b32a32ffb6b82a6620040fe77fc2e73f4386", crateSha256: "fe3e0e224a60921531d09442ecbe68ab9a34ae3ebed7821ab02a309b8b66f7f6", crateSizeBytes: 254463 }
      : { kind: "frozen-source-manifest-v1", version: "0.11.0", sourceManifestSha256: "c".repeat(64) };
    return {
      ...snapshot,
      evidence: {
        kind: snapshot.language === "rust" ? "rust-immutable-artifact-v1" : "native-capture-v1",
        command: "fixed-capture-command",
        exitCode: 0,
        sourceIdentity,
        consumer: { command: "fixed-consumer", exitCode: 0, status: "success" },
        capture: { command: "fixed-capture", exitCode: 0, snapshotSha256: payloadSha256, networkCount: 20, caseCount: Object.keys(snapshot.behavior).length },
        snapshotSha256: payloadSha256,
      },
    };
  });
}

test("production evidence binds the canonical payload and exact applicable counts", () => {
  const sourceManifests = { typescript: "c".repeat(64), python: "c".repeat(64), go: "c".repeat(64), ruby: "c".repeat(64) };
  const valid = evidenceBackedSnapshots();
  assert.equal(verifySnapshots(valid, { sourceManifestSha256ByLanguage: sourceManifests }).networkRows, 20);
  for (const mutate of [
    (candidate) => { candidate[0].evidence.capture.caseCount = 20; },
    (candidate) => { candidate[0].evidence.capture.caseCount = fixture.cases.length; },
    (candidate) => { candidate[0].evidence.capture.caseCount -= 1; },
    (candidate) => { candidate[0].evidence.capture.caseCount += 1; },
    (candidate) => { delete candidate[0].behavior[Object.keys(candidate[0].behavior)[0]]; },
    (candidate) => { candidate[0].evidence.snapshotSha256 = "a".repeat(64); candidate[0].evidence.capture.snapshotSha256 = "a".repeat(64); },
  ]) {
    const candidate = clone(valid);
    mutate(candidate);
    assert.throws(() => verifySnapshots(candidate, { sourceManifestSha256ByLanguage: sourceManifests }), /payload binding|applicable behavior|key set|case count/u);
  }
  const wrongManifest = clone(valid);
  wrongManifest.find((snapshot) => snapshot.language === "python").evidence.sourceIdentity.sourceManifestSha256 = "d".repeat(64);
  assert.throws(() => verifySnapshots(wrongManifest, { sourceManifestSha256ByLanguage: sourceManifests }), /source manifest hash/u);
});

test("single-snapshot validation requires caller-bound non-Rust manifest hashes while Rust keeps its artifact identity", () => {
  const manifestSha256 = createHash("sha256").update("caller-validated-source-manifest\n").digest("hex");
  const typescript = evidenceBackedSnapshots().find((snapshot) => snapshot.language === "typescript");
  typescript.evidence.sourceIdentity.sourceManifestSha256 = manifestSha256;
  assert.throws(() => validateSingleSnapshot(typescript, { language: "typescript" }), /explicit source-manifest input/u);
  assert.throws(() => validateSingleSnapshot(typescript, { language: "typescript", sourceManifestSha256: "d".repeat(64) }), /source manifest hash/u);
  const typescriptResult = validateSingleSnapshot(typescript, { language: "typescript", sourceManifestSha256: manifestSha256 });
  assert.equal(typescriptResult.status, "ok");
  assert.equal(typescriptResult.evidenceKind, "validated supplied snapshot semantics only; any source-manifest binding uses a caller-supplied expected hash; actual manifest/source inventory, artifact bytes and SDK execution require external evidence");
  const rust = evidenceBackedSnapshots().find((snapshot) => snapshot.language === "rust");
  const rustResult = validateSingleSnapshot(rust, { language: "rust" });
  assert.equal(rustResult.status, "ok");
  assert.equal(rustResult.evidenceKind, "validated supplied snapshot semantics only; any source-manifest binding uses a caller-supplied expected hash; actual manifest/source inventory, artifact bytes and SDK execution require external evidence");
});

test("test-only semantic positive uses independently authored observations", () => {
  assert.equal(validateObservedCase({
    caseId: "c1-hosted-base-root-query-auth",
    language: "typescript",
    observation: {
      operation: { publicOperation: "eth_chainId", wireOperation: "eth_chainId", params: [] },
      caseKind: "request-response",
      exceptionIds: [],
      outcome: { kind: "success", value: "0x2105" },
      trace: { method: "POST", target: "https://base.erpc.global/", headers: { "content-type": "application/json" }, bodySha256: "0c9aa844c076fa980a9e1cd9b81cda7dcc8fac60a40184dd914a64d6723dffbc", attempts: 1, ioKind: "performed" },
      endpointDiagnostic: "https://base.erpc.global/",
      ioCount: 1,
      surface: { allowed: ["eth_chainId", "eth_getBalance", "eth_call"], forbidden: ["raw", "request", "batch", "websocket", "subscription", "send", "swap", "bridge"] },
      numericTuples: [],
      binary: null,
    },
  }), true);
  assert.equal(validateObservedCase({
    caseId: "c1-unconfigured-namespace-fails-locally-with-zero-io",
    language: "typescript",
    observation: {
      operation: { publicOperation: "getBlockCount", wireOperation: "getblockcount", params: [] },
      caseKind: "error",
      exceptionIds: [],
      outcome: { kind: "error", category: "not-configured", message: "bitcoin.rpc is not configured" },
      trace: { method: "NONE", target: "NO_IO", headers: {}, bodySha256: "16fc4acceddf521ce456f397608e06d1efba2663fe1cb54f8671bcb52aa8ebbf", attempts: 0, ioKind: "none" },
      endpointDiagnostic: "",
      ioCount: 0,
      surface: { allowed: ["getBlockCount"], forbidden: [] },
      numericTuples: [],
      binary: null,
    },
  }), true);
  assert.equal(validateObservedCase({
    caseId: "c1-ruby-bitcoin-synchronous-request-exception",
    language: "ruby",
    observation: {
      operation: { publicOperation: "cancellation", wireOperation: "cancellation", params: [] },
      caseKind: "transport",
      exceptionIds: ["ruby-bitcoin-synchronous-request-v1"],
      outcome: { kind: "not-applicable", value: "ruby-bitcoin-synchronous-request-v1" },
      trace: { method: "NONE", target: "NO_IO", headers: {}, bodySha256: "40a833cd84a0226ae11b33b196bcfba2126707d55f3ddd1b6ea673e752e239a8", attempts: 0, ioKind: "none" },
      endpointDiagnostic: "",
      ioCount: 0,
      surface: { allowed: ["ruby-bitcoin-synchronous-request-v1"], forbidden: [] },
      numericTuples: [],
      binary: null,
    },
  }), true);
});

test("lossless JSON request normalization sorts objects, preserves arrays and numeric lexemes", () => {
  const first = normalizeJsonRequestBytes(Buffer.from('{"b":"x","a":{"z":"x","y":2},"arr":[3,2],"n":1}', "utf8"));
  const equivalent = normalizeJsonRequestBytes(Buffer.from(' { "n":1, "arr":[3,2], "a":{"y":2,"z":"\\u0078"}, "b":"x" } ', "utf8"));
  assert.equal(first.sha256, equivalent.sha256);
  assert.equal(first.bytes.toString(), '{"a":{"y":2,"z":"x"},"arr":[3,2],"b":"x","n":1}');
  assert.notEqual(first.sha256, normalizeJsonRequestBytes(Buffer.from('{"b":"x","a":{"z":"x","y":2},"arr":[2,3],"n":1}', "utf8")).sha256);
  assert.notEqual(normalizeJsonRequestBytes(Buffer.from('{"n":1}', "utf8")).sha256, normalizeJsonRequestBytes(Buffer.from('{"n":1.0}', "utf8")).sha256);
  assert.throws(() => normalizeJsonRequestBytes(Buffer.from('{"a":1,"\\u0061":2}', "utf8")), /duplicate decoded member/u);
  assert.throws(() => normalizeJsonRequestBytes(Buffer.from('{"a":1} trailing', "utf8")), /trailing content/u);
  const fixtureCase = fixture.cases.find((entry) => entry.caseId === "c1-hosted-base-root-query-auth");
  assert.notEqual(fixtureCase.expected.trace.bodySha256, normalizeJsonRequestBytes(Buffer.from(fixtureCase.mockExchange.request.body, "utf8")).sha256);
});

test("B descriptors reproduce the fixed boundary goldens and reject unsafe preflight", () => {
  assert.equal(fixture.oracleGoldens.length, 56);
  for (const id of ["btc-decoded-entity-inclusive", "btc-container-depth-inclusive", "btc-json-token-budget-inclusive", "sui-request-bytes-inclusive", "sui-request-bytes-over"]) {
    const golden = fixture.oracleGoldens.find((entry) => entry.goldenId === id);
    validateDescriptorShape(golden.descriptor);
    const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(golden.descriptor), golden.chunkPlan, golden.measurement.decodedLength), golden.family);
    assert.equal(validateDescriptorOracle(id, measured, golden.measurement), true);
  }
  const unsafe = structuredClone(fixture.oracleGoldens.find((entry) => entry.goldenId === "btc-json-token-budget-inclusive").descriptor);
  unsafe.elementCount = 999995;
  assert.throws(() => validateDescriptorShape(unsafe), /elementCount|decodedLength|jsonTokenCount|construction/u);
  let iterated = false;
  function* source() { iterated = true; yield Buffer.from("x"); }
  assert.throws(() => [...applyChunkPlan(source(), { kind: "explicit-v1", lengths: [0] }, 1)], /chunk plan/u);
  assert.equal(iterated, false);
  assert.equal(DESCRIPTOR_LIMITS.maxChunkBytes, 65536);
  const changedGolden = structuredClone(fixture);
  changedGolden.oracleGoldens[0].measurement.sha256 = "f".repeat(64);
  assert.notEqual(computeFixtureDigest(changedGolden), fixture.fixtureDigest);
});

test("B production pipeline enumerates every approved oracle golden with no skips", () => {
  assert.equal(fixture.oracleGoldens.length, 56);
  const failures = [];
  for (const golden of fixture.oracleGoldens) {
    try {
      validateDescriptorShape(golden.descriptor);
      const planned = applyChunkPlan(expandDescriptorChunks(golden.descriptor), golden.chunkPlan, golden.measurement.decodedLength);
      const measured = measureExpandedChunks(planned, golden.family);
      validateDescriptorOracle(golden.goldenId, measured, golden.measurement);
    } catch (error) {
      failures.push({ id: golden.goldenId, message: error.message });
    }
  }
  if (failures.length > 0) assert.fail(`oracle pipeline ${56 - failures.length}/56 passed; failures=${JSON.stringify(failures)}`);
});

test("C5 Sui raw vectors bind the depth and repeated Timestamp contracts", () => {
  const byId = new Map(fixture.oracleGoldens.map((entry) => [entry.goldenId, entry]));
  const expected = [
    ["sui-get-object-embedded-depth100", "success", 233, "669d5760dab7fbb014b89baf34c3875c9b3f8903ac8b1c86ac351a9c0d6cdb5f"],
    ["sui-get-object-embedded-depth101", "invalid-response", 235, "a5575c242bf636cefef88c5239f0a1dcbce3aef71c6b81f86fc9fc2d9f842361"],
    ["sui-get-service-info-timestamp-merge-final-zero", "success", 64, "119888cf16fc18a73106370c83ff72d6d7657ea4ab9ac9ca3612b96335bce532"],
    ["sui-get-service-info-timestamp-merge-final-invalid", "invalid-response", 64, "0a236e0c8ecc68d0b4e8708aa258842f19571bbc8c9e395ec5aee3b6100de3fe"],
  ];
  for (const [id, outcome, length, sha256] of expected) {
    const golden = byId.get(id);
    assert.ok(golden, id);
    assert.equal(golden.descriptor.kind, "sui-raw-bytes-v1");
    assert.equal(golden.measurement.decodedLength, length);
    assert.equal(golden.measurement.sha256, sha256);
    assert.equal(golden.outcome.kind, outcome === "success" ? "success" : "error");
    if (outcome !== "success") assert.equal(golden.outcome.category, "invalid-response");
    assert.equal(validateDescriptorOracle(id, measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(golden.descriptor), golden.chunkPlan, length), "sui-grpc-web"), golden.measurement), true);
  }
  assert.equal(fixture.suiGrpcWeb.golden.filter((entry) => entry.id.startsWith("sui-get-object-embedded-")).length, 2);
  assert.equal(fixture.suiGrpcWeb.golden.filter((entry) => entry.id.startsWith("sui-get-service-info-timestamp-merge-")).length, 2);

  // Decode the raw bytes independently of the descriptor expander so these
  // vectors remain portable evidence rather than a producer self-check.
  const readVarint = (bytes, offset) => {
    let value = 0n; let shift = 0n; let index = offset;
    while (index < bytes.length) {
      const byte = bytes[index++]; value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [value, index];
      shift += 7n;
      if (shift > 63n) throw new Error("varint overflow");
    }
    throw new Error("truncated varint");
  };
  const dataPayload = (goldenId) => {
    const bytes = Buffer.from(byId.get(goldenId).descriptor.value, "hex");
    const declared = bytes.readUInt32BE(1);
    assert.equal(bytes[0], 0);
    assert.equal(bytes.length, 5 + declared + 5 + bytes.readUInt32BE(5 + declared + 1));
    return bytes.subarray(5, 5 + declared);
  };
  const objectNestedGroupCount = (goldenId) => {
    const payload = dataPayload(goldenId);
    assert.equal(payload[0], 0x0a);
    const [objectLength, objectOffset] = readVarint(payload, 1);
    const object = payload.subarray(objectOffset, objectOffset + Number(objectLength));
    return {
      starts: object.filter((byte) => byte === 0x2b).length,
      ends: object.filter((byte) => byte === 0x2c).length,
    };
  };
  assert.deepEqual(objectNestedGroupCount("sui-get-object-embedded-depth100"), { starts: 99, ends: 99 });
  assert.deepEqual(objectNestedGroupCount("sui-get-object-embedded-depth101"), { starts: 100, ends: 100 });
  const timestampNanos = (goldenId) => {
    const payload = dataPayload(goldenId); const nanos = [];
    let offset = 0;
    while (offset < payload.length) {
      const [tag, afterTag] = readVarint(payload, offset); offset = afterTag;
      const field = Number(tag >> 3n); const wire = Number(tag & 7n);
      if (wire === 2) {
        const [length, afterLength] = readVarint(payload, offset); offset = afterLength;
        const nested = payload.subarray(offset, offset + Number(length)); offset += Number(length);
        if (field === 5) {
          let timestampOffset = 0; let nanosValue;
          while (timestampOffset < nested.length) {
            const [timestampTag, afterTimestampTag] = readVarint(nested, timestampOffset); timestampOffset = afterTimestampTag;
            const [value, afterValue] = readVarint(nested, timestampOffset); timestampOffset = afterValue;
            if (timestampTag === 0x10n) nanosValue = Number(value);
          }
          assert.notEqual(nanosValue, undefined);
          nanos.push(nanosValue);
        }
      } else if (wire === 0) {
        [, offset] = readVarint(payload, offset);
      } else {
        throw new Error("unexpected fixture wire type");
      }
    }
    return nanos;
  };
  assert.deepEqual(timestampNanos("sui-get-service-info-timestamp-merge-final-zero"), [1_000_000_000, 0]);
  assert.deepEqual(timestampNanos("sui-get-service-info-timestamp-merge-final-invalid"), [0, 1_000_000_000]);
});

test("B snapshots descriptor and rechunk plans before iteration and carries scanner state across chunks", () => {
  const numeric = fixture.oracleGoldens.find((entry) => entry.goldenId === "btc-numeric-lexeme-inclusive");
  const descriptor = clone(numeric.descriptor);
  const iterator = expandDescriptorChunks(descriptor);
  descriptor.prefix = "mutated-after-iterator-created";
  descriptor.repeatCount = 0;
  const measured = measureExpandedChunks(applyChunkPlan(iterator, numeric.chunkPlan, numeric.measurement.decodedLength), numeric.family);
  assert.equal(validateDescriptorOracle(numeric.goldenId, measured, numeric.measurement), true);

  const plan = { kind: "fixed-v1", chunkBytes: 1 };
  const planned = applyChunkPlan(expandDescriptorChunks(numeric.descriptor), plan, numeric.measurement.decodedLength);
  plan.chunkBytes = 65536;
  const splitMeasured = measureExpandedChunks(planned, numeric.family);
  assert.equal(validateDescriptorOracle(numeric.goldenId, splitMeasured, numeric.measurement), true);

  const sui = fixture.suiGrpcWeb.framingCases.find((entry) => entry.id === "sui-trailer-first");
  const suiMeasured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(sui.descriptor), { kind: "fixed-v1", chunkBytes: 1 }, sui.measurement.decodedLength), "sui-grpc-web");
  assert.equal(validateDescriptorOracle(sui.id, suiMeasured, sui.measurement), true);
});

test("B rejects unsafe descriptor and chunk plans before the producer yields", () => {
  const zeroArray = clone(fixture.oracleGoldens.find((entry) => entry.goldenId === "btc-json-token-budget-inclusive").descriptor);
  zeroArray.elementCount = 999995;
  assert.throws(() => expandDescriptorChunks(zeroArray), /elementCount|decodedLength|jsonTokenCount|construction/u);
  let iterated = false;
  function* source() { iterated = true; yield Buffer.from("x"); }
  assert.throws(() => applyChunkPlan(source(), { kind: "explicit-v1", lengths: [0] }, 1), /chunk plan/u);
  assert.equal(iterated, false);
});

test("B fixed case IDs reject a rehashed producer mutation", () => {
  const golden = fixture.oracleGoldens.find((entry) => entry.goldenId === "btc-decoded-entity-inclusive");
  const descriptor = clone(golden.descriptor);
  descriptor.repeatCount -= 1;
  descriptor.decodedLength -= 1;
  const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(descriptor), golden.chunkPlan, descriptor.decodedLength), golden.family);
  descriptor.sha256 = measured.sha256;
  assert.throws(() => validateDescriptorOracle(golden.goldenId, measured, { ...golden.measurement, ...measured }), /approved oracle/u);
});

test("B production fixture validation rejects a copied and rehashed golden", () => {
  const changed = clone(fixture);
  const golden = changed.oracleGoldens.find((entry) => entry.goldenId === "btc-u64-max");
  golden.descriptor.value = golden.descriptor.value.replace("18446744073709551615", "18446744073709551614");
  golden.descriptor.sha256 = createHash("sha256").update(Buffer.from(golden.descriptor.value, "utf8")).digest("hex");
  const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(golden.descriptor), golden.chunkPlan, golden.measurement.decodedLength), golden.family);
  golden.measurement = { ...golden.measurement, ...measured };
  changed.fixtureDigest = computeFixtureDigest(changed);
  assert.throws(() => validateFixtures(changed), /approved oracle/u);
});

test("B strict UTF-8 outcome survives chunk splits", () => {
  const golden = fixture.oracleGoldens.find((entry) => entry.goldenId === "btc-invalid-utf8");
  const bytes = Buffer.from(golden.descriptor.value, "hex");
  const beforeInvalid = bytes.subarray(0, 34);
  const invalidAndTail = bytes.subarray(34);
  const measured = measureExpandedChunks(applyChunkPlan([beforeInvalid, invalidAndTail.subarray(0, 1), invalidAndTail.subarray(1)], { kind: "explicit-v1", lengths: [34, 1, 2] }, bytes.length), golden.family);
  assert.deepEqual(measured.scanOutcome, { kind: "invalid-utf8", firstInvalidByteOffset: 34, reason: "invalid-leading-byte" });
  const valid = measureExpandedChunks([Buffer.from("7b2278223a22e2", "hex"), Buffer.from("82", "hex"), Buffer.from("ac227d", "hex")], "bitcoin-json");
  assert.deepEqual(valid.scanOutcome, { kind: "valid-utf8" });
});

test("Rust legacy UTF-8 replacement is a finite raw-golden binding", () => {
  const strict = fixture.cases.find((entry) => entry.caseId === "btc-strict-utf8-invalid");
  const legacy = fixture.cases.find((entry) => entry.caseId === "btc-rust-legacy-utf8-replacement");
  assert.deepEqual(strict.applicability, ["typescript", "python", "go", "ruby"]);
  assert.deepEqual(strict.exceptionIds, ["rust-bitcoin-decode-domain-v1"]);
  assert.deepEqual(legacy.applicability, ["rust"]);
  assert.deepEqual(legacy.exceptionIds, ["rust-bitcoin-decode-domain-v1"]);
  assert.equal(legacy.responseDescriptor.oracleGoldenId, "btc-invalid-utf8");
  assert.deepEqual(legacy.expected.outcome, { kind: "success", value: "\uFFFD" });
  const wrongResult = clone(fixture); wrongResult.cases.find((entry) => entry.caseId === legacy.caseId).expected.outcome.value = "replacement"; wrongResult.fixtureDigest = computeFixtureDigest(wrongResult); assert.throws(() => validateFixtures(wrongResult), /legacy UTF-8 replacement|relational/u);
  const wrongGolden = clone(fixture); wrongGolden.cases.find((entry) => entry.caseId === legacy.caseId).responseDescriptor.oracleGoldenId = "btc-u64-max"; wrongGolden.fixtureDigest = computeFixtureDigest(wrongGolden); assert.throws(() => validateFixtures(wrongGolden), /oracle response|legacy UTF-8 replacement|relational/u);
});

test("B keeps each lifecycle branch concrete and binds delay and barrier semantics", () => {
  assert.equal(fixture.lifecycleSchedules.length, 8);
  assert.equal(new Set(fixture.lifecycleSchedules.map((entry) => entry.kind)).size, 8);
  const delay = fixture.lifecycleSchedules.filter((entry) => ["withhold-headers", "first-chunk-then-delay"].includes(entry.kind));
  assert.deepEqual(delay.map((entry) => [entry.timeoutMs, entry.delayMs]), [[40, 250], [40, 250]]);
  const barrier = fixture.lifecycleSchedules.find((entry) => entry.kind === "first-chunk-cancellation-barrier");
  assert.deepEqual(Object.keys(barrier.barrier).sort(), ["cancelObserved", "firstChunkSignal", "release"]);
  const altered = clone(fixture);
  altered.lifecycleSchedules.find((entry) => entry.kind === "withhold-headers").delayMs = 41;
  assert.throws(() => buildExpectedSnapshot({ language: "typescript", fixture: altered }), /fixtureDigest mismatch|40ms\/250ms/u);
});

test("B semantic fixture digest ignores ID-set order but remains mutation-sensitive", () => {
  const reordered = clone(fixture);
  reordered.cases.reverse();
  reordered.oracleGoldens.reverse();
  reordered.lifecycleSchedules.reverse();
  reordered.suiGrpcWeb.golden.reverse();
  reordered.suiGrpcWeb.boundaryCases.reverse();
  reordered.suiGrpcWeb.framingCases.reverse();
  assert.equal(computeFixtureDigest(reordered), fixture.fixtureDigest);
  reordered.oracleGoldens[0].measurement.sha256 = "f".repeat(64);
  assert.notEqual(computeFixtureDigest(reordered), fixture.fixtureDigest);
});

test("B schema and runtime reject the same closed-union negative corpus", () => {
  const negatives = [];
  const descriptorExtra = clone(fixture); descriptorExtra.oracleGoldens[0].descriptor.unexpected = true; negatives.push(descriptorExtra);
  const descriptorMissing = clone(fixture); descriptorMissing.oracleGoldens[0].descriptor = { kind: "json-number-token-v1" }; negatives.push(descriptorMissing);
  const mutationMissing = clone(fixture); mutationMissing.suiGrpcWeb.framingCases[0].descriptor.operations = [{ kind: "set-byte", offset: 0 }]; negatives.push(mutationMissing);
  const barrierMissing = clone(fixture); barrierMissing.lifecycleSchedules[5].barrier = { firstChunkSignal: "x" }; negatives.push(barrierMissing);
  const numericExtra = clone(fixture); numericExtra.oracleGoldens[0].measurement.numericTokens = [{ offset: 0, rawLength: 1, rawTokenSha256: "0".repeat(64), coefficientDigits: 1, explicitExponent: null, canonicalTuple: null, invalidReason: null, unexpected: 1 }]; negatives.push(numericExtra);
  for (const candidate of negatives) {
    assert.throws(() => validateFixtureSchema(candidate));
    assert.throws(() => validateFixtures(candidate));
  }
});

test("B every portable case resolves its supplied response bytes and coverage", () => {
  const schedules = new Set();
  const networks = new Set();
  const methods = new Map();
  for (const entry of fixture.cases) {
    const source = resolveCaseResponseSource(entry, fixture);
    const family = entry.networkId === "rpc-sui-mainnet" ? "sui-grpc-web" : "bitcoin-json";
    const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(source.descriptor), source.chunkPlan, source.measurement.decodedLength), family);
    validateDescriptorOracle(source.goldenId ?? `${entry.caseId}.response`, measured, source.measurement);
    if (source.kind === "inline-v1") {
      const actualBytes = entry.mockExchange.response.bodyEncoding === "hex" ? Buffer.from(entry.mockExchange.response.body, "hex") : Buffer.from(entry.mockExchange.response.body, "utf8");
      assert.equal(measureExpandedChunks([actualBytes], family).sha256, measured.sha256, `${entry.caseId} detached inline bytes`);
    } else {
      assert.equal(entry.mockExchange.response.body, source.goldenId, `${entry.caseId} detached oracle reference`);
    }
    networks.add(entry.networkId);
    if (!methods.has(entry.networkId)) methods.set(entry.networkId, new Set());
    methods.get(entry.networkId).add(entry.operation.wireOperation);
    if (entry.scheduleId) schedules.add(entry.scheduleId);
    assert.doesNotMatch(entry.mockExchange.response.body, /"vector"\s*:/u, `${entry.caseId} label-only body`);
  }
  assert.equal(networks.size, 20);
  assert.equal(schedules.size, 8);
  for (const required of ["status", "block", "query"]) assert.ok(methods.get("rpc-near-mainnet")?.has(required), `missing Near ${required}`);
  for (const required of ["eth_chainId", "eth_getBalance", "eth_call"]) assert.ok(methods.get("rpc-tron-mainnet")?.has(required), `missing Tron ${required}`);
  assert.ok(methods.get("rpc-base-mainnet")?.has("eth_call"), "missing Base eth_call");
  assert.ok(methods.get("rpc-arbitrum-one-mainnet")?.has("eth_getBalance"), "missing Arbitrum eth_getBalance");
});

test("C5 NEAR fixtures carry the approved typed status, block, and account bodies", () => {
  const byId = new Map(fixture.cases.filter((entry) => entry.networkId === "rpc-near-mainnet").map((entry) => [entry.caseId, entry]));
  const status = JSON.parse(byId.get("near-status-method-coverage").mockExchange.response.body).result;
  assert.deepEqual(Object.keys(status).sort(), ["chain_id", "genesis_hash", "latest_protocol_version", "protocol_version", "sync_info", "unknown_status_number", "version"]);
  assert.equal(status.sync_info.latest_block_height, 123456789012345);
  assert.equal(status.version.version, "1.0.0");
  const block = JSON.parse(byId.get("near-block-method-coverage").mockExchange.response.body).result;
  assert.equal(block.author, "fixture.near");
  assert.equal(block.header.height, 123456789012345);
  assert.equal(block.header.timestamp_nanosec, "1704067200000000000");
  assert.deepEqual(block.chunks, []);
  const account = JSON.parse(byId.get("c5-near-tron-sui-native-protocol-contracts").mockExchange.response.body).result;
  assert.equal(account.amount, "1000000000000000000");
  assert.equal(account.storage_usage, 42);
  assert.equal(account.block_height, 123456789012345);
  assert.deepEqual(byId.get("near-block-method-coverage").operation.params, { finality: "final" });
  assert.deepEqual(byId.get("c5-near-tron-sui-native-protocol-contracts").operation.params, { request_type: "view_account", account_id: "alice.near", finality: "final" });
  assert.doesNotMatch(JSON.stringify(fixture.cases.filter((entry) => entry.networkId === "rpc-near-mainnet")), /fixed-view-account|method coverage|"status":"fixture"/u);
});

test("non-Bitcoin success envelopes omit error while Bitcoin null-error coverage remains", () => {
  const repaired = ["arbitrum-get-balance-method-coverage", "base-eth-call-method-coverage", "tron-eth-call-method-coverage", "tron-get-balance-method-coverage", "near-status-method-coverage", "near-block-method-coverage", "c5-near-tron-sui-native-protocol-contracts"];
  for (const caseId of repaired) assert.doesNotMatch(fixture.cases.find((entry) => entry.caseId === caseId).mockExchange.response.body, /"error":null/u);
  assert.match(fixture.cases.find((entry) => entry.caseId === "c1-hosted-bitcoin-bearer-no-query-null-error").mockExchange.response.body, /"error":null/u);
  const candidate = clone(fixture); const entry = candidate.cases.find((item) => item.caseId === "base-eth-call-method-coverage"); const body = entry.mockExchange.response.body.replace(/\}$/u, ',"error":null}'); entry.mockExchange.response.body = body; entry.responseDescriptor.descriptor.value = body; entry.responseDescriptor.descriptor.decodedLength = Buffer.byteLength(body); entry.responseDescriptor.descriptor.sha256 = createHash("sha256").update(Buffer.from(body)).digest("hex"); entry.responseDescriptor.measurement.decodedLength = entry.responseDescriptor.descriptor.decodedLength; entry.responseDescriptor.measurement.sha256 = entry.responseDescriptor.descriptor.sha256; candidate.fixtureDigest = computeFixtureDigest(candidate); assert.throws(() => validateFixtures(candidate), /omit error/u);
});

test("final fixture batch binds legacy exclusions, redaction data, and Sui setup inputs", () => {
  for (const id of ["btc-explicit-exponent-over", "btc-explicit-negative-exponent-over", "btc-long-coefficient-over"]) {
    const entry = fixture.cases.find((candidate) => candidate.caseId === id);
    assert.deepEqual(entry.applicability, ["typescript", "python", "go", "ruby"]);
    assert.deepEqual(entry.exceptionIds, ["rust-bitcoin-decode-domain-v1"]);
  }
  const redaction = fixture.cases.find((entry) => entry.caseId === "c1-path-query-header-and-api-key-redaction");
  const redactionResponse = JSON.parse(redaction.mockExchange.response.body);
  assert.equal(redactionResponse.id, 15); assert.equal(redactionResponse.error.code, -32000); assert.equal(redaction.expected.numericTuples.length, 2);
  const errorData = fixture.cases.find((entry) => entry.caseId === "btc-error-data-lossless-redaction");
  assert.equal(errorData.setup.headers["x-fixture-scoped"], "fixture-secret"); assert.equal(errorData.mockExchange.request.headers["x-fixture-scoped"], "fixture-secret"); assert.equal(errorData.expected.numericTuples.length, 2);
  const suiIds = ["sui-framing-sui-compressed-frame", "sui-framing-sui-data-and-terminal-trailer", "sui-framing-sui-duplicate-trailer", "sui-framing-sui-missing-trailer", "sui-framing-sui-trailer-first", "sui-framing-sui-two-data-frames", "sui-framing-sui-unknown-marker", "sui-request-bytes-inclusive-case", "sui-request-bytes-over-case", "sui-response-bytes-inclusive-case", "sui-response-bytes-over-case", "sui-trailer-bytes-inclusive-case", "sui-trailer-bytes-over-case"];
  for (const id of suiIds) { const entry = fixture.cases.find((candidate) => candidate.caseId === id); assert.equal(entry.setup.endpoint, "https://sui.fixture.invalid/prefix?fixture=1"); assert.deepEqual(entry.setup.headers, { "x-fixture-scoped": "fixture-header" }); }
  const wrongRedactionId = clone(fixture); const wrongRedaction = wrongRedactionId.cases.find((entry) => entry.caseId === redaction.caseId); const wrongBody = JSON.parse(wrongRedaction.mockExchange.response.body); wrongBody.id = 16; wrongRedaction.mockExchange.response.body = JSON.stringify(wrongBody); wrongRedaction.responseDescriptor.descriptor.value = wrongRedaction.mockExchange.response.body; wrongRedaction.responseDescriptor.descriptor.decodedLength = Buffer.byteLength(wrongRedaction.mockExchange.response.body); wrongRedaction.responseDescriptor.descriptor.sha256 = createHash("sha256").update(Buffer.from(wrongRedaction.mockExchange.response.body)).digest("hex"); wrongRedaction.responseDescriptor.measurement = { decodedLength: wrongRedaction.responseDescriptor.descriptor.decodedLength, sha256: wrongRedaction.responseDescriptor.descriptor.sha256 }; wrongRedactionId.fixtureDigest = computeFixtureDigest(wrongRedactionId); assert.throws(() => validateFixtures(wrongRedactionId), /matching-ID|approved credential probe|relational/u);
  const wrongHeader = clone(fixture); wrongHeader.cases.find((entry) => entry.caseId === "btc-error-data-lossless-redaction").setup.headers["x-fixture-scoped"] = "other-secret"; wrongHeader.fixtureDigest = computeFixtureDigest(wrongHeader); assert.throws(() => validateFixtures(wrongHeader), /scoped secret binding|relational/u);
  const wrongSuiQuery = clone(fixture); wrongSuiQuery.cases.find((entry) => entry.caseId === "sui-framing-sui-compressed-frame").setup.endpoint = "https://sui.fixture.invalid/prefix"; wrongSuiQuery.fixtureDigest = computeFixtureDigest(wrongSuiQuery); assert.throws(() => validateFixtures(wrongSuiQuery), /Sui target|setup query|Sui setup must bind/u);
  const missingSuiHeader = clone(fixture); delete missingSuiHeader.cases.find((entry) => entry.caseId === "sui-framing-sui-compressed-frame").setup.headers["x-fixture-scoped"]; missingSuiHeader.fixtureDigest = computeFixtureDigest(missingSuiHeader); assert.throws(() => validateFixtures(missingSuiHeader), /Sui setup must bind/u);
  const changedSuiHeader = clone(fixture); changedSuiHeader.cases.find((entry) => entry.caseId === "sui-framing-sui-compressed-frame").setup.headers["x-fixture-scoped"] = "wrong-header"; changedSuiHeader.fixtureDigest = computeFixtureDigest(changedSuiHeader); assert.throws(() => validateFixtures(changedSuiHeader), /Sui setup must bind/u);
  const extraSuiHeader = clone(fixture); extraSuiHeader.cases.find((entry) => entry.caseId === "sui-request-bytes-over-case").setup.headers["x-extra"] = "unexpected"; extraSuiHeader.fixtureDigest = computeFixtureDigest(extraSuiHeader); assert.throws(() => validateFixtures(extraSuiHeader), /Sui setup must bind/u);
  const noIoMissingSuiHeader = clone(fixture); delete noIoMissingSuiHeader.cases.find((entry) => entry.caseId === "sui-request-bytes-over-case").setup.headers["x-fixture-scoped"]; noIoMissingSuiHeader.fixtureDigest = computeFixtureDigest(noIoMissingSuiHeader); assert.throws(() => validateFixtures(noIoMissingSuiHeader), /Sui setup must bind/u);
  const wrongSuiModePerformed = clone(fixture); Object.assign(wrongSuiModePerformed.cases.find((entry) => entry.caseId === "sui-framing-sui-compressed-frame").setup, { mode: "unconfigured", endpoint: null, headers: {} }); wrongSuiModePerformed.fixtureDigest = computeFixtureDigest(wrongSuiModePerformed); assert.throws(() => validateFixtures(wrongSuiModePerformed), /Sui setup must bind/u);
  const wrongSuiModeNoIo = clone(fixture); Object.assign(wrongSuiModeNoIo.cases.find((entry) => entry.caseId === "sui-request-bytes-over-case").setup, { mode: "unconfigured", endpoint: null, headers: {} }); wrongSuiModeNoIo.fixtureDigest = computeFixtureDigest(wrongSuiModeNoIo); assert.throws(() => validateFixtures(wrongSuiModeNoIo), /Sui setup must bind/u);
  const wrongBinary = clone(fixture); wrongBinary.cases.find((entry) => entry.caseId === "sui-golden-object-absent").expected.binary = { encoding: "hex", decodedLength: 36, sha256: "23caf0333090cc43b63f3aa9244e9d8e4feaadcfa2d37c30566bf9d46a407535" }; wrongBinary.fixtureDigest = computeFixtureDigest(wrongBinary); assert.throws(() => validateFixtures(wrongBinary), /binary projection does not match its resolved response source measurement/u);
});

test("actual capture fixture corrections bind gettxout object output and Sui absent-version metadata", () => {
  const getTxOut = fixture.cases.find((entry) => entry.caseId === "c1-bitcoin-twelve-named-methods-and-result-shapes");
  assert.equal(getTxOut.mockExchange.request.body.includes('"id":3'), true);
  assert.equal(getTxOut.mockExchange.response.body, '{"jsonrpc":"2.0","id":3,"result":{"fixture":"gettxout"}}');
  assert.deepEqual(getTxOut.expected.outcome.value, { fixture: "gettxout" });
  assert.equal(getTxOut.responseDescriptor.measurement.decodedLength, 56);
  assert.equal(getTxOut.responseDescriptor.measurement.sha256, "8d607d8a2873ebdcba6ec573d26ada21db8182c3b93b9604e80e7abaa1326588");
  const absent = fixture.cases.find((entry) => entry.caseId === "sui-golden-object-absent");
  assert.deepEqual(absent.expected.binary, { encoding: "hex", decodedLength: 43, sha256: "f881c1052c1abe9e959312d83035c96f6db3bec7765cc64719c01a18770ad57b" });
  const stringSuccess = clone(fixture); const mutated = stringSuccess.cases.find((entry) => entry.caseId === getTxOut.caseId); const body = '{"jsonrpc":"2.0","id":3,"result":"ok"}'; mutated.mockExchange.response.body = body; mutated.expected.outcome.value = "ok"; mutated.responseDescriptor.descriptor.value = body; mutated.responseDescriptor.descriptor.decodedLength = Buffer.byteLength(body); mutated.responseDescriptor.descriptor.sha256 = createHash("sha256").update(Buffer.from(body)).digest("hex"); mutated.responseDescriptor.measurement = { decodedLength: mutated.responseDescriptor.descriptor.decodedLength, sha256: mutated.responseDescriptor.descriptor.sha256 }; stringSuccess.fixtureDigest = computeFixtureDigest(stringSuccess); assert.throws(() => validateFixtures(stringSuccess), /relational tuple|approved|binary/u);
});

test("C2-C4 fixtures execute every sealed EVM read for each network", () => {
  const networks = [...new Set(fixture.cases.filter((entry) => entry.cohort >= 2 && entry.cohort <= 4).map((entry) => entry.networkId))];
  const required = new Set(["eth_chainId", "eth_getBalance", "eth_call"]);
  for (const networkId of networks) {
    const methods = new Set(fixture.cases.filter((entry) => entry.networkId === networkId).map((entry) => entry.operation.wireOperation));
    for (const method of required) assert.ok(methods.has(method), `${networkId} is missing executable ${method}`);
    assert.equal(fixture.cases.filter((entry) => entry.networkId === networkId && required.has(entry.operation.wireOperation)).length, 3);
  }
});

test("native lifecycle setup distinguishes configured pre-cancel from absent namespace", () => {
  const preCancel = fixture.cases.find((entry) => entry.caseId === "c1-schedule-pre-cancel");
  assert.equal(preCancel.setup.mode, "direct");
  assert.equal(preCancel.setup.endpoint, "https://node.fixture.invalid/rpc");
  assert.equal(preCancel.expected.endpointDiagnostic, "https://node.fixture.invalid/");
  const unconfigured = fixture.cases.find((entry) => entry.caseId === "c1-unconfigured-namespace-fails-locally-with-zero-io");
  assert.equal(unconfigured.setup.mode, "unconfigured");
  assert.equal(unconfigured.setup.endpoint, null);
  assert.equal(unconfigured.expected.endpointDiagnostic, "");
  const swapped = clone(fixture);
  swapped.cases.find((entry) => entry.caseId === "c1-schedule-pre-cancel").setup.mode = "unconfigured";
  swapped.fixtureDigest = computeFixtureDigest(swapped);
  assert.throws(() => validateFixtures(swapped), /configured direct endpoint/u);
  const wrongSibling = clone(fixture);
  wrongSibling.cases.find((entry) => entry.caseId === "c1-unconfigured-namespace-fails-locally-with-zero-io").setup = { mode: "direct", apiKey: null, endpoint: "https://node.fixture.invalid/rpc", headers: {} };
  wrongSibling.fixtureDigest = computeFixtureDigest(wrongSibling);
  assert.throws(() => validateFixtures(wrongSibling), /selected namespace as unconfigured/u);
});

test("method coverage maps and singleton surfaces follow the wire-selected capability", () => {
  const expected = {
    "arbitrum-get-balance-method-coverage": "eth_getBalance",
    "base-eth-call-method-coverage": "eth_call",
    "tron-eth-call-method-coverage": "eth_call",
    "tron-get-balance-method-coverage": "eth_getBalance",
  };
  for (const [caseId, typescriptName] of Object.entries(expected)) {
    const entry = fixture.cases.find((candidate) => candidate.caseId === caseId);
    assert.equal(entry.operation.publicOperations.typescript, typescriptName);
    assert.equal(entry.expected.surface.allowed[0], typescriptName);
  }
  const mapMutation = clone(fixture);
  mapMutation.cases.find((entry) => entry.caseId === "base-eth-call-method-coverage").operation.publicOperations.typescript = "eth_getBalance";
  mapMutation.fixtureDigest = computeFixtureDigest(mapMutation);
  assert.throws(() => validateFixtures(mapMutation), /wire-selected capability/u);
  const surfaceMutation = clone(fixture);
  surfaceMutation.cases.find((entry) => entry.caseId === "tron-get-balance-method-coverage").expected.surface.allowed = ["eth_chainId"];
  surfaceMutation.fixtureDigest = computeFixtureDigest(surfaceMutation);
  assert.throws(() => validateFixtures(surfaceMutation), /singleton surface/u);
  const optionalMapBypass = clone(fixture);
  const bypassCase = optionalMapBypass.cases.find((entry) => entry.caseId === "arbitrum-get-balance-method-coverage");
  delete bypassCase.operation.publicOperations;
  bypassCase.expected.surface.allowed = ["eth_call"];
  optionalMapBypass.fixtureDigest = computeFixtureDigest(optionalMapBypass);
  assert.throws(() => validateFixtures(optionalMapBypass), /singleton surface/u);
});

test("Rust Bitcoin per-case surface removes only the approved raw superset labels", () => {
  const rust = nativeShapedTestSnapshots(1).find((snapshot) => snapshot.language === "rust");
  const typescript = nativeShapedTestSnapshots(1).find((snapshot) => snapshot.language === "typescript");
  for (const caseId of ["c1-hosted-bitcoin-bearer-no-query-null-error", "c1-direct-bitcoin-exact-target-scoped-header-keyless", "c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"]) {
    const forbidden = rust.behavior[caseId].surface.forbidden;
    assert.equal(forbidden.includes("raw"), false);
    assert.equal(forbidden.includes("request"), false);
    assert.equal(forbidden.includes("batch"), false);
    assert.equal(forbidden.includes("subscription"), true);
    assert.deepEqual(typescript.behavior[caseId].surface.forbidden.filter((item) => ["raw", "request", "batch"].includes(item)), ["raw", "request", "batch"]);
  }
  const missing = clone(fixture); missing.cases.find((entry) => entry.caseId === "btc-gettxout-null-result").exceptionIds = []; missing.fixtureDigest = computeFixtureDigest(missing); assert.throws(() => validateFixtures(missing), /relational|exception/u);
});

test("B case-path mutations reject detached refs, IDs, and Sui targets", () => {
  const wrongRef = clone(fixture);
  const refCase = wrongRef.cases.find((entry) => entry.responseDescriptor.kind === "oracle-ref-v1");
  refCase.mockExchange.response.body = "btc-u64-max";
  wrongRef.fixtureDigest = computeFixtureDigest(wrongRef);
  assert.throws(() => validateFixtures(wrongRef), /response descriptor reference|oracle response body|approved oracle/u);
  const wrongId = clone(fixture);
  const idCase = wrongId.cases.find((entry) => entry.caseId === "btc-u64-maximum-integer-projection");
  const request = JSON.parse(idCase.mockExchange.request.body); request.id = 99; idCase.mockExchange.request.body = JSON.stringify(request); idCase.mockExchange.request.bodySha256 = createHash("sha256").update(Buffer.from(idCase.mockExchange.request.body)).digest("hex"); idCase.expected.trace.bodySha256 = idCase.mockExchange.request.bodySha256; wrongId.fixtureDigest = computeFixtureDigest(wrongId);
  assert.throws(() => validateFixtures(wrongId), {
    message: "btc-u64-maximum-integer-projection relational tuple differs from its approved case binding",
  });
  const wrongTarget = clone(fixture);
  const sui = wrongTarget.cases.find((entry) => entry.caseKind === "binary"); sui.mockExchange.request.target = sui.mockExchange.request.target.replace("/prefix/sui.", "/prefix//sui."); wrongTarget.fixtureDigest = computeFixtureDigest(wrongTarget);
  assert.throws(() => validateFixtures(wrongTarget), /double-slash|trace target|Sui target|fixtureDigest/u);
  const wrongStatus = clone(fixture);
  const statusCase = wrongStatus.cases.find((entry) => entry.responseDescriptor.kind === "oracle-ref-v1"); statusCase.mockExchange.response.status = 500; wrongStatus.fixtureDigest = computeFixtureDigest(wrongStatus);
  assert.throws(() => validateFixtures(wrongStatus), /status|HTTP|fixtureDigest/u);
});

test("B case IDs must equal the approved relational set in both directions", () => {
  assert.equal(validateFixtures(fixture), true);
  for (const entry of fixture.cases) {
    const missing = clone(fixture);
    missing.cases = missing.cases.filter((candidate) => candidate.caseId !== entry.caseId);
    missing.fixtureDigest = computeFixtureDigest(missing);
    assert.throws(() => validateFixtures(missing), {
      message: `fixture is missing approved relational case ${entry.caseId}`,
    });
  }

  const duplicate = clone(fixture);
  const duplicateCase = clone(duplicate.cases[0]);
  duplicate.cases.push(duplicateCase);
  duplicate.fixtureDigest = computeFixtureDigest(duplicate);
  assert.throws(() => validateFixtures(duplicate), {
    message: `duplicate fixture case ${duplicateCase.caseId}`,
  });

  const unknown = clone(fixture);
  const unknownCase = clone(unknown.cases[0]);
  unknownCase.caseId = "unknown-approved-case";
  unknown.cases.push(unknownCase);
  unknown.fixtureDigest = computeFixtureDigest(unknown);
  assert.throws(() => validateFixtures(unknown), {
    message: "unknown-approved-case is not an approved relational case",
  });
});

test("B protocol and exception relations reject rehashed case mutations", () => {
  const swapped = clone(fixture);
  const inclusive = swapped.cases.find((entry) => entry.caseId === "sui-request-bytes-inclusive-case");
  inclusive.expected.outcome = { kind: "error", category: "config", message: "request exceeds 1 MiB" };
  inclusive.expected.ioCount = 0; inclusive.expected.trace = { method: "NONE", target: "NO_IO", headers: {}, bodySha256: "0".repeat(64), attempts: 0, ioKind: "none" };
  swapped.fixtureDigest = computeFixtureDigest(swapped);
  assert.throws(() => validateFixtures(swapped), /exact 1 MiB Sui request|successful POST|relational/u);
  const detachedNull = clone(fixture);
  detachedNull.cases = detachedNull.cases.filter((entry) => entry.caseId !== "btc-gettxout-null-result");
  detachedNull.fixtureDigest = computeFixtureDigest(detachedNull);
  assert.throws(() => validateFixtures(detachedNull), {
    message: "fixture is missing approved relational case btc-gettxout-null-result",
  });
  const missingRustException = clone(fixture);
  const resource = missingRustException.cases.find((entry) => entry.caseId === "btc-decoded-entity-over");
  resource.exceptionIds = [];
  missingRustException.fixtureDigest = computeFixtureDigest(missingRustException);
  assert.throws(() => validateFixtures(missingRustException), /Rust exclusion|exception|ordinary/u);
});

test("B all remaining R4 relational mutations reject after digest refresh", () => {
  const mutateAndReject = (mutate, pattern = /fixture|case|exception|trace|status|outcome|schema|method|relational/u) => { const candidate = clone(fixture); mutate(candidate); candidate.fixtureDigest = computeFixtureDigest(candidate); assert.throws(() => validateFixtures(candidate), pattern); };
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.caseId === "c1-hosted-base-root-query-auth").applicability = ["typescript"]; }, /ordinary|language|applicability/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.caseId === "btc-decoded-entity-over").exceptionIds = ["rust-bitcoin-direct-diagnostic-v1"]; }, /exception/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.caseId === "btc-decoded-entity-over").exceptionIds.push("ruby-bitcoin-synchronous-request-v1"); }, /exception/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.networkId === "rpc-bsc-mainnet").cohort = 5; }, /cohort/u);
  mutateAndReject((candidate) => { const entry = candidate.cases.find((item) => item.networkId === "rpc-base-mainnet"); entry.clientContractId = "client-bitcoin-rpc"; }, /client|network/u);
  mutateAndReject((candidate) => { const entry = candidate.cases.find((item) => item.caseId === "c1-hosted-base-root-query-auth"); entry.operation.wireOperation = "eth_call"; }, /operation|method|JSON/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.expected.ioCount === 1).expected.trace.target = "https://evil.invalid/"; }, /trace target/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.expected.ioCount === 1).expected.trace.headers.evil = "x"; }, /trace header/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.expected.ioCount === 1).expected.trace.attempts = 0; }, /attempt/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.responseDescriptor.kind === "oracle-ref-v1").mockExchange.response.status = 500; }, /status|HTTP/u);
  mutateAndReject((candidate) => { candidate.cases.find((entry) => entry.responseDescriptor.kind === "oracle-ref-v1" && entry.expected.outcome.kind === "error").expected.outcome = { kind: "success", value: "drift" }; }, /outcome|golden|relational/u);
  mutateAndReject((candidate) => { candidate.suiGrpcWeb.methodPaths[0] = "/wrong"; }, /methodPaths/u);
  mutateAndReject((candidate) => { delete candidate.cases[0].mockExchange.request.bodyEncoding; }, /schema|bodyEncoding/u);
});

test("Rydia R4 replay rejects every coordinated semantic drift after digest refresh", () => {
  const mutateResponseDescriptor = (candidate) => {
    const entry = candidate.cases.find((item) => item.caseId === "c1-hosted-base-root-query-auth");
    const body = entry.mockExchange.response.body.replace("0x2105", "0x9999");
    const bytes = Buffer.from(body, "utf8"); const hash = createHash("sha256").update(bytes).digest("hex");
    entry.mockExchange.response.body = body; entry.responseDescriptor.descriptor.value = body; entry.responseDescriptor.descriptor.decodedLength = bytes.length; entry.responseDescriptor.descriptor.sha256 = hash; entry.responseDescriptor.measurement = { decodedLength: bytes.length, sha256: hash };
  };
  const mutations = [
    (candidate) => { candidate.cases.find((entry) => entry.caseId === "c1-hosted-base-root-query-auth").expected.outcome.value = "drifted-value"; },
    mutateResponseDescriptor,
    (candidate) => { const entry = candidate.cases.find((item) => item.caseId === "c1-hosted-base-root-query-auth"); entry.mockExchange.request.target = "https://evil.fixture.invalid/?api-key=fixture-api-key"; entry.expected.trace.target = "https://evil.fixture.invalid/"; },
    (candidate) => { const entry = candidate.cases.find((item) => item.caseId === "c1-hosted-base-root-query-auth"); entry.mockExchange.request.headers["x-unapproved"] = "x"; entry.expected.trace.headers["x-unapproved"] = "x"; },
    (candidate) => { candidate.cases.find((entry) => entry.caseId === "c1-hosted-base-root-query-auth").expected.endpointDiagnostic = "https://another.fixture.invalid/"; },
    (candidate) => { candidate.suiGrpcWeb.golden[0].expected.chain = "other-chain"; },
    (candidate) => { candidate.suiGrpcWeb.boundaryCases.find((entry) => entry.id === "sui-request-bytes-inclusive").outcome = "invalid-response"; },
    (candidate) => { candidate.suiGrpcWeb.boundaryCases[0].id = "renamed-sui-boundary"; },
    (candidate) => { candidate.suiGrpcWeb.framingCases.find((entry) => entry.id === "sui-data-and-terminal-trailer").outcome = "invalid-response"; },
    (candidate) => { candidate.suiGrpcWeb.framingCases[0].id = "renamed-sui-framing"; },
    (candidate) => { candidate.lifecycleSchedules.find((entry) => entry.id === "life-immediate-response").outcome = "transport"; },
    (candidate) => { candidate.lifecycleSchedules.find((entry) => entry.id === "life-immediate-response").bodyClosed = false; },
    (candidate) => { const schedule = candidate.lifecycleSchedules.find((entry) => entry.id === "life-immediate-response"); schedule.id = "life-immediate-renamed"; candidate.cases.find((entry) => entry.scheduleId === "life-immediate-response").scheduleId = schedule.id; },
    (candidate) => { candidate.lifecycleSchedules.find((entry) => entry.id === "life-withhold-headers").outcome = "transport"; },
    (candidate) => { const entry = candidate.cases.find((item) => item.scheduleId === "life-redirect-to-second-server"); entry.mockExchange.response.status = 418; },
  ];
  for (const mutate of mutations) { const candidate = clone(fixture); mutate(candidate); candidate.fixtureDigest = computeFixtureDigest(candidate); assert.throws(() => validateFixtures(candidate), /relational|semantic|tuple|status|outcome|golden|schedule|HTTP/u); }
});
