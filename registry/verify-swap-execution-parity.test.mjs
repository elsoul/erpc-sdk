import assert from "node:assert/strict";
import test from "node:test";

import {
  BEHAVIOR_KEYS,
  PARITY_LANGUAGES,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  SwapExecutionParityError,
  buildExpectedSnapshot,
  stableJson,
  validateFixtures,
  verifySnapshots,
} from "./verify-swap-execution-parity.mjs";
import { SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST } from "./swap-execution-capabilities.mjs";

function clone(value) {
  return structuredClone(value);
}

function nativeSnapshots() {
  const expected = buildExpectedSnapshot();
  return Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-${language}-test`,
  }]));
}

test("literal execution fixture has both methods, all directions, and complete traces", () => {
  assert.equal(validateFixtures(), true);
  const expected = buildExpectedSnapshot();
  assert.equal(expected.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(expected.snapshotKind, SNAPSHOT_KIND);
  assert.equal(expected.runtime, "canonical-reference");
  assert.deepEqual(Object.keys(expected.behavior), BEHAVIOR_KEYS);
  assert.ok(expected.behavior.prepare.length >= 20);
  assert.ok(expected.behavior.simulate.length >= 10);
  assert.equal(expected.capabilityDigest, SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST);
  assert.ok(expected.behavior.prepare.some((entry) => entry.caseId === "prepare-ethereum-weth-usdc-forward"));
  assert.ok(expected.behavior.prepare.some((entry) => entry.caseId === "prepare-avalanche-usdc-wavax-reverse"));
  assert.ok(expected.behavior.simulate.some((entry) => entry.caseId === "allowance-below-required"));
  assert.ok(expected.behavior.simulate.some((entry) => entry.caseId === "simulation-router-revert"));
  const code3Revert = expected.behavior.simulate.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-router-revert-code3");
  const code3NonRevert = expected.behavior.simulate.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-router-nonrevert-code3");
  assert.equal(code3Revert.outcome.code, "SWAP_SIMULATION_REVERTED");
  assert.deepEqual(code3NonRevert.outcome, { kind: "transport-error", sourcePreserved: true });
  const fullPreparation = expected.behavior.prepare.find((entry) => entry.caseId === "prepare-ethereum-weth-usdc-forward");
  const fullSimulation = expected.behavior.simulate.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-forward");
  assert.equal(fullPreparation.rpcTrace.length, 16);
  assert.equal(fullSimulation.rpcTrace.length, 19);
  assert.equal(fullPreparation.outcome.value.transaction.data, "0x38ed17390000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000008df8dc9700000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb000000000000000000000000000000000000000000000000000000006aa995b00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
});

test("verifier accepts exactly five executed native captures", () => {
  const snapshots = nativeSnapshots();
  const result = verifySnapshots(snapshots);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languages.map((entry) => entry.language), PARITY_LANGUAGES);
  assert.ok(result.languages.every((entry) => entry.prepareCases > 0 && entry.simulateCases > 0));
});

test("verifier rejects reference-only, missing, and extra captures", () => {
  const expected = buildExpectedSnapshot();
  const reference = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, { ...clone(expected), language }]));
  assert.throws(() => verifySnapshots(reference), SwapExecutionParityError);
  const missing = nativeSnapshots();
  delete missing.ruby;
  assert.throws(() => verifySnapshots(missing), /exactly/u);
  const extra = nativeSnapshots();
  extra.swift = clone(extra.go);
  assert.throws(() => verifySnapshots(extra), /exactly/u);
});

test("verifier compares complete outcomes and traces while rebinding metadata only", () => {
  const snapshots = nativeSnapshots();
  const expected = snapshots.typescript;
  const prepare = expected.behavior.prepare.find((entry) => entry.caseId === "prepare-ethereum-weth-usdc-forward");
  assert.equal(prepare.outcome.value.executionCapabilityDigest, SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST);
  assert.equal(prepare.outcome.value.quote.tokenCatalogDigest.length, 64);
  assert.equal(prepare.outcome.value.transaction.data.startsWith("0x38ed1739"), true);
  const outcomeChanged = nativeSnapshots();
  outcomeChanged.rust.behavior.prepare.find((entry) => entry.caseId === "prepare-ethereum-weth-usdc-forward").outcome.value.minimumAmountOut = "1";
  assert.throws(() => verifySnapshots(outcomeChanged), /parity mismatch/u);
  const traceChanged = nativeSnapshots();
  traceChanged.go.behavior.simulate.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-forward").rpcTrace[15].params[0] = "latest-mutated";
  assert.throws(() => verifySnapshots(traceChanged), /parity mismatch/u);
  const metadataChanged = nativeSnapshots();
  metadataChanged.python.capabilityDigest = "0".repeat(64);
  assert.throws(() => verifySnapshots(metadataChanged), /capability digest/u);
  assert.equal(stableJson(snapshots.typescript.behavior), stableJson(snapshots.ruby.behavior));
});
