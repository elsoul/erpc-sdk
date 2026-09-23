import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/mayan-swift-v2-cases.json" with { type: "json" };
import localFixture from "./fixtures/mayan-swift-v2-local-build-cases.json" with { type: "json" };
import {
  BRIDGE_ERROR_MESSAGES,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  computeDigest,
} from "./bridge-capabilities.mjs";
import {
  BEHAVIOR_KEYS,
  LOCAL_BEHAVIOR_KEYS,
  PARITY_LANGUAGES,
  SNAPSHOT_BEHAVIOR_KEYS,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  BridgeParityError,
  buildExpectedLegacySnapshot,
  buildExpectedSnapshot,
  stableJson,
  validateLocalFixtures,
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
  assert.deepEqual(Object.keys(expected.behavior), SNAPSHOT_BEHAVIOR_KEYS);
  assert.equal(expected.capabilityDigest, BRIDGE_CAPABILITIES_CONTENT_DIGEST);
  assert.equal(expected.capabilityDigest, computeDigest());
  assert.ok(expected.behavior.quote.length > 0);
  assert.ok(expected.behavior.build.length > 0);
  assert.ok(expected.behavior.status.length > 0);
  assert.equal(validateLocalFixtures(localFixture), true);
  for (const method of LOCAL_BEHAVIOR_KEYS) assert.ok(expected.behavior[method].length > 0);
  const errors = fixture.cases.filter((entry) => entry.expected.kind === "sdk-error");
  assert.equal(errors.length, 38);
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

  const missingLocalBehavior = nativeSnapshots();
  delete missingLocalBehavior.typescript.behavior.prepareSourceSwap;
  assert.throws(() => verifySnapshots(missingLocalBehavior), /behavior keys/u);

  assert.equal(stableJson(nativeSnapshots().typescript.behavior), stableJson(nativeSnapshots().ruby.behavior));
});

test("USDC allowance is route-specific and a wrong token is rejected by the verifier", () => {
  const snapshots = nativeSnapshots();
  const build = snapshots.typescript.behavior.build.find((entry) => entry.caseId === "build-usdc-eth-sol-synthetic");
  assert.ok(build);
  if (!build || build.outcome.kind !== "success") return;
  assert.equal(build.outcome.value.allowance.tokenDeploymentId, "deployment-0008");
  assert.equal(build.outcome.value.allowance.tokenAddress, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  build.outcome.value.allowance.tokenDeploymentId = "deployment-0011";
  build.outcome.value.allowance.tokenAddress = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
  assert.throws(() => verifySnapshots(snapshots), BridgeParityError);
});

test("normalized source-token tampering is covered for EURC and USDC without provider I/O", () => {
  for (const [caseId, quoteCaseId, value] of [
    ["build-eurc-normalized-source-token-usdc-tamper", "quote-eth-sol-synthetic", "deployment-0008"],
    ["build-usdc-normalized-source-token-eurc-tamper", "quote-usdc-eth-sol-synthetic", "deployment-0011"],
  ]) {
    const entry = fixture.cases.find((candidate) => candidate.caseId === caseId);
    assert.ok(entry);
    assert.equal(entry.method, "build");
    assert.equal(entry.quoteCaseId, quoteCaseId);
    assert.deepEqual(entry.request, {
      swapperAddress: "0x2222222222222222222222222222222222222222",
      destinationAddress: "So11111111111111111111111111111111111111112",
    });
    assert.deepEqual(entry.quoteMutation, { kind: "normalized-set", path: "sourceTokenDeploymentId", value });
    assert.deepEqual(entry.httpTrace, []);
    assert.deepEqual(entry.expected, {
      kind: "sdk-error",
      code: "BRIDGE_QUOTE_MISMATCH",
      message: "Bridge quote does not match the request",
    });
  }

  const snapshots = nativeSnapshots();
  for (const caseId of ["build-eurc-normalized-source-token-usdc-tamper", "build-usdc-normalized-source-token-eurc-tamper"]) {
    const expected = snapshots.typescript.behavior.build.find((entry) => entry.caseId === caseId);
    assert.ok(expected);
    assert.deepEqual(expected.httpTrace, []);
    assert.deepEqual(expected.outcome, fixture.cases.find((entry) => entry.caseId === caseId).expected);
  }
  assert.equal(verifySnapshots(snapshots).status, "ok");
});

test("local fixture keeps closed rejection descriptors and v2 parity metadata", () => {
  assert.equal(localFixture.cases.length, 87);
  assert.equal(localFixture.cases.filter((entry) => entry.expected.kind === "success" && entry.method === "prepareSourceSwap").length, 7);
  assert.equal(localFixture.cases.filter((entry) => entry.expected.kind === "success" && entry.method === "buildLocalUnsigned").length, 6);
  assert.ok(localFixture.cases.some((entry) => entry.mutation?.kind === "boundary"));
  assert.ok(localFixture.cases.some((entry) => entry.mutation?.kind === "rpc-envelope-set" && entry.mutation.path === "jsonrpc"));
  const envelopeCases = localFixture.cases.filter((entry) => entry.mutation?.kind === "rpc-envelope-set");
  assert.ok(envelopeCases.every((entry) => entry.rpcMockIds.length === 1 && entry.rpcTrace.length === 1));
  assert.ok(envelopeCases.every((entry) => entry.mutation.path !== "method"));
  assert.ok(envelopeCases.some((entry) => entry.mutation.path === "id" && entry.mutation.value === 999));
  assert.ok(localFixture.cases.some((entry) => entry.mutation?.path === "swapInstruction.accounts[13].pubkey"));
  assert.ok(localFixture.cases.some((entry) => entry.caseId === "build-usdc-solana-alt-same-slot-active-prefix" && entry.expected.kind === "success"));
  assert.ok(localFixture.cases.some((entry) => entry.caseId === "build-eurc-solana-raydium-same-slot-inactive-index" && entry.expected.code === "BRIDGE_LOCAL_BUILD_INVALID"));
  const unsupportedLocalConfig = clone(localFixture);
  unsupportedLocalConfig.cases.find((entry) => entry.caseId === "build-usdc-solana-alt-same-slot-active-prefix").config.localBuild.altValidation = "test-only";
  assert.throws(() => validateLocalFixtures(unsupportedLocalConfig), /localBuild keys/u);
  const raydiumPrepare = localFixture.cases.find((entry) => entry.caseId === "prepare-eurc-solana-to-ethereum-raydium");
  const raydiumBuild = localFixture.cases.find((entry) => entry.caseId === "build-eurc-solana-to-ethereum-raydium");
  const sizeBoundary = localFixture.cases.find((entry) => entry.caseId === "build-solana-final-size-cap");
  assert.equal(raydiumPrepare?.expected.kind, "success");
  assert.equal(raydiumBuild?.expected.kind, "success");
  assert.equal(raydiumBuild?.mutation, null);
  assert.equal(raydiumBuild?.expected.value.transaction.transactionBase64.length > 0, true);
  assert.equal(raydiumBuild?.expected.value.construction.sourceRpcEvidence.lookupTables.length, 2);
  const populatedAlt = localFixture.rpcMocks.find((mock) => mock.mockId === "rpc-solana-accounts-raydium");
  const emptyAlt = localFixture.rpcMocks.find((mock) => mock.mockId === "rpc-solana-accounts-raydium-empty");
  assert.equal(Buffer.from(JSON.parse(populatedAlt.response.body).result.value[1].data[0], "base64").length, 5880);
  assert.equal(Buffer.from(JSON.parse(emptyAlt.response.body).result.value[0].data[0], "base64").length, 56);
  assert.equal(sizeBoundary?.expected.kind, "sdk-error");
  assert.deepEqual(sizeBoundary?.mutation, { kind: "boundary", path: "solana.finalTransactionBytes", value: "1233" });
  assert.notDeepEqual(raydiumBuild?.rpcMockIds, sizeBoundary?.rpcMockIds);
  const snapshots = nativeSnapshots();
  assert.equal(snapshots.typescript.snapshotVersion, 2);
  assert.equal(typeof snapshots.typescript.localFixtureDigest, "string");
  assert.equal(verifySnapshots(snapshots).status, "ok");
  const changed = nativeSnapshots();
  changed.typescript.behavior.buildLocalUnsigned[0].rpcTrace.push({
    method: "POST",
    url: "https://rpc.example/",
    headers: {},
    body: null,
  });
  assert.throws(() => verifySnapshots(changed), /parity mismatch/u);
});

test("legacy v1 snapshots require explicit opt-in", () => {
  const expected = buildExpectedLegacySnapshot();
  const snapshots = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-${language}-legacy-test`,
  }]));
  assert.throws(() => verifySnapshots(snapshots), /allowLegacyV1 opt-in/u);
  assert.equal(verifySnapshots(snapshots, undefined, undefined, undefined, undefined, { allowLegacyV1: true }).snapshotVersion, 1);
});
