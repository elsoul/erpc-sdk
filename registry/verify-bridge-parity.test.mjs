import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/mayan-swift-v2-cases.json" with { type: "json" };
import {
  BRIDGE_ERROR_MESSAGES,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  computeDigest,
} from "./bridge-capabilities.mjs";
import {
  BEHAVIOR_KEYS,
  PARITY_LANGUAGES,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  BridgeParityError,
  buildExpectedSnapshot,
  stableJson,
  validateFixtures,
  verifySnapshots,
} from "./verify-bridge-parity.mjs";

function clone(value) {
  return structuredClone(value);
}

function nativeSnapshots() {
  const expected = buildExpectedSnapshot();
  return Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-${language}-fixture-driver`,
  }]));
}

test("bridge fixture is source-complete and fixes secret-free error wording", () => {
  assert.equal(validateFixtures(fixture), true);
  const expected = buildExpectedSnapshot();
  assert.equal(expected.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(expected.snapshotKind, SNAPSHOT_KIND);
  assert.deepEqual(Object.keys(expected.behavior), BEHAVIOR_KEYS);
  assert.equal(expected.capabilityDigest, BRIDGE_CAPABILITIES_CONTENT_DIGEST);
  assert.equal(expected.capabilityDigest, computeDigest());
  assert.ok(expected.behavior.quote.length > 0);
  assert.ok(expected.behavior.build.length > 0);
  assert.ok(expected.behavior.status.length > 0);
  const errors = fixture.cases.filter((entry) => entry.expected.kind === "sdk-error");
  assert.equal(errors.length, 27);
  for (const entry of errors) assert.equal(entry.expected.message, BRIDGE_ERROR_MESSAGES[entry.expected.code], entry.caseId);
});

test("parity compares exact outcome and HTTP trace bytes while ignoring only transport headers", () => {
  const snapshots = nativeSnapshots();
  const expected = snapshots.typescript;
  const quote = expected.behavior.quote.find((entry) => entry.caseId === "quote-eth-sol-synthetic");
  quote.httpTrace[0].headers["user-agent"] = "synthetic-runtime";
  quote.httpTrace[0].headers.host = "tx-builder.mayan.finance";
  quote.httpTrace[0].headers["content-length"] = String(quote.httpTrace[0].body.length);
  assert.equal(verifySnapshots(snapshots).status, "ok");

  const changedBody = nativeSnapshots();
  changedBody.rust.behavior.quote.find((entry) => entry.caseId === "quote-eth-sol-synthetic").httpTrace[0].body += " ";
  assert.throws(() => verifySnapshots(changedBody), /parity mismatch/u);

  const changedMessage = nativeSnapshots();
  changedMessage.go.behavior.build.find((entry) => entry.caseId === "build-auth-required-local").outcome.message = "unsafe";
  assert.throws(() => verifySnapshots(changedMessage), BridgeParityError);

  const credential = nativeSnapshots();
  credential.python.behavior.quote.find((entry) => entry.caseId === "quote-eth-sol-synthetic").httpTrace[0].headers.cookie = "should-never-appear";
  assert.throws(() => verifySnapshots(credential), /unexpected header/u);
});

test("parity requires exactly five native runtimes and rejects reference-only snapshots", () => {
  const expected = buildExpectedSnapshot();
  const reference = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, { ...clone(expected), language }]));
  assert.throws(() => verifySnapshots(reference), /runtime/u);

  const missing = nativeSnapshots();
  delete missing.ruby;
  assert.throws(() => verifySnapshots(missing), /exactly/u);

  const extra = nativeSnapshots();
  extra.swift = clone(extra.go);
  assert.throws(() => verifySnapshots(extra), /exactly/u);

  const duplicateCase = nativeSnapshots();
  duplicateCase.typescript.behavior.status.push(clone(duplicateCase.typescript.behavior.status[0]));
  assert.throws(() => verifySnapshots(duplicateCase), /parity mismatch/u);

  assert.equal(stableJson(nativeSnapshots().typescript.behavior), stableJson(nativeSnapshots().ruby.behavior));
});
