import assert from "node:assert/strict";
import test from "node:test";

import registry from "./bridge-capabilities.json" with { type: "json" };
import schema from "./bridge-capabilities.schema.json" with { type: "json" };
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import fixture from "./fixtures/mayan-swift-v2-cases.json" with { type: "json" };
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  BRIDGE_CAPABILITIES_JSON,
  BRIDGE_CAPABILITY_IDS,
  BRIDGE_CAPABILITY_KEYS,
  BRIDGE_RUNTIME_KEYS,
  BridgeCapabilityValidationError,
  canonicalProjection,
  computeDigest,
  getBridgeCapability,
  getBridgeCapabilityForRoute,
  validateBridgeCapabilities,
} from "./bridge-capabilities.mjs";
import { LANGUAGES, renderLanguage } from "./generate-bridge-capabilities.mjs";
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

test("canonical bridge registry has exactly the two reviewed native EURC directions", () => {
  assert.equal(validateBridgeCapabilities(registry), true);
  assert.deepEqual(Object.keys(registry), ["schemaVersion", "asOfDate", "capabilities"]);
  assert.deepEqual(BRIDGE_CAPABILITIES.map((entry) => entry.bridgeCapabilityId), BRIDGE_CAPABILITY_IDS);
  assert.deepEqual(Object.keys(registry.capabilities[0]), BRIDGE_CAPABILITY_KEYS);
  assert.deepEqual(Object.keys(JSON.parse(BRIDGE_CAPABILITIES_JSON)[0]), BRIDGE_RUNTIME_KEYS);
  assert.equal(computeDigest(registry.capabilities), BRIDGE_CAPABILITIES_CONTENT_DIGEST);
  assert.match(BRIDGE_CAPABILITIES_CONTENT_DIGEST, /^[0-9a-f]{64}$/u);
  assert.equal(registry.capabilities[0].sourceTokenStandard, "erc20");
  assert.equal(registry.capabilities[0].destinationTokenStandard, "spl-token");
  assert.equal(registry.capabilities[1].sourceTokenStandard, "spl-token");
  assert.equal(registry.capabilities[1].destinationTokenStandard, "erc20");
});

test("runtime projection omits provenance, preserves fixed dependency order, and is immutable", () => {
  const ethSol = getBridgeCapability("bridge-mayan-swift-v2-eurc-eth-sol");
  assert.equal(ethSol.evidence, undefined);
  assert.equal(ethSol.asOfDate, undefined);
  assert.equal(ethSol.forwarderFunctionSelector, "0x30dedc57");
  assert.equal(getBridgeCapabilityForRoute("eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").bridgeCapabilityId, ethSol.bridgeCapabilityId);
  assert.equal(getBridgeCapability("unknown"), null);
  assert.equal(getBridgeCapabilityForRoute("eip155:43114", "eip155:1"), null);
  assert.throws(() => { ethSol.dependencies.push("unexpected"); }, TypeError);
  const reversed = [...registry.capabilities].reverse();
  assert.equal(computeDigest(reversed), BRIDGE_CAPABILITIES_CONTENT_DIGEST);
  assert.deepEqual(canonicalProjection(reversed), canonicalProjection(registry.capabilities));
});

test("validator rejects aliases, catalog drift, endpoint changes, and unsafe route growth", () => {
  const alias = clone(registry);
  alias.capabilities[0].fromChainId = alias.capabilities[0].sourceChainId;
  assert.throws(() => validateBridgeCapabilities(alias), BridgeCapabilityValidationError);

  const catalog = clone(tokenCatalog);
  catalog.deployments.find((entry) => entry.deploymentId === "deployment-0013").address = "H11111111111111111111111111111111";
  assert.throws(() => validateBridgeCapabilities(registry, { tokenCatalog: catalog }), /address differs/u);

  const endpoint = clone(registry);
  endpoint.capabilities[0].builderEndpoint = "https://tx-builder.mayan.finance/other";
  assert.throws(() => validateBridgeCapabilities(endpoint), /reviewed binding/u);

  const extra = clone(registry);
  extra.capabilities.push(clone(extra.capabilities[0]));
  assert.throws(() => validateBridgeCapabilities(extra), /exactly 2 rows/u);
});

test("schema and renderers keep exact immutable bridge data conventions", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "asOfDate", "capabilities"]);
  assert.equal(schema.$defs.capability.additionalProperties, false);
  assert.deepEqual(LANGUAGES, PARITY_LANGUAGES);
  for (const language of LANGUAGES) {
    const source = renderLanguage(language);
    assert.match(source, /BRIDGE_CAPABILITIES_JSON|bridgeCapabilitiesJSON/u);
    assert.match(source, /BRIDGE_CAPABILITIES_CONTENT_DIGEST|bridgeCapabilitiesContentDigest/u);
    assert.match(source, /BRIDGE_CAPABILITIES_AS_OF_DATE|bridgeCapabilitiesAsOfDate/u);
    assert.match(source, /bridge-mayan-swift-v2-eurc-eth-sol/u);
    assert.match(source, /bridge-mayan-swift-v2-eurc-sol-eth/u);
    if (language === "python") assert.ok(Math.max(...source.split("\n").map((line) => line.length)) <= 100);
  }
});

test("synthetic fixtures cover both directions, provider bodies, exact raw lexemes, and all behavior groups", () => {
  assert.equal(validateFixtures(fixture), true);
  assert.equal(fixture.cases.length, 36);
  const expected = buildExpectedSnapshot();
  assert.equal(expected.snapshotVersion, SNAPSHOT_VERSION);
  assert.equal(expected.snapshotKind, SNAPSHOT_KIND);
  assert.deepEqual(Object.keys(expected.behavior), BEHAVIOR_KEYS);
  assert.ok(expected.behavior.quote.length >= 10);
  assert.ok(expected.behavior.build.length >= 10);
  assert.ok(expected.behavior.status.length >= 5);
  const quote = fixture.cases.find((entry) => entry.caseId === "quote-eth-sol-synthetic");
  assert.equal(quote.source, "synthetic");
  assert.match(quote.expected.value[0].rawSignedQuoteJson, /"minMiddleAmount":114\.5000/u);
  assert.equal(quote.httpTrace[0].method, "POST");
  assert.equal(quote.httpTrace[0].headers["content-type"], "application/json");
  const build = fixture.cases.find((entry) => entry.caseId === "build-eth-sol-synthetic");
  assert.ok(build.httpTrace[0].body.startsWith('{"quote":'));
  assert.ok(build.httpTrace[0].body.includes(quote.expected.value[0].rawSignedQuoteJson));
  for (const entry of fixture.cases) {
    for (const trace of entry.httpTrace) {
      assert.equal(Object.hasOwn(trace.headers, "authorization"), false);
      assert.equal(Object.hasOwn(trace.headers, "cookie"), false);
    }
  }
});

test("Steiner bridge regressions isolate destination-chain validation and zero quote margin", () => {
  const wrongEvmDestination = fixture.cases.find((entry) => entry.caseId === "build-eth-sol-wrong-evm-destination");
  const wrongSolanaDestination = fixture.cases.find((entry) => entry.caseId === "build-sol-eth-wrong-solana-destination");
  assert.equal(wrongEvmDestination.expected.code, "BRIDGE_INVALID_ARGUMENT");
  assert.equal(wrongSolanaDestination.expected.code, "BRIDGE_INVALID_ARGUMENT");
  assert.deepEqual(wrongEvmDestination.httpTrace, []);
  assert.deepEqual(wrongSolanaDestination.httpTrace, []);
  assert.match(wrongEvmDestination.request.destinationAddress, /^0x[0-9a-f]{40}$/u);
  assert.match(wrongSolanaDestination.request.destinationAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);

  const zeroMargin = fixture.cases.find((entry) => entry.caseId === "quote-eth-sol-zero-validity-margin");
  assert.deepEqual(zeroMargin.config, { minimumQuoteValiditySeconds: 0 });
  assert.equal(zeroMargin.nowSeconds + 30, Number(zeroMargin.expected.value[0].deadline));
  assert.equal(zeroMargin.providerBody.includes('"deadline64":"1789600030"'), true);
  assert.equal(zeroMargin.expected.value[0].rawSignedQuoteJson.includes('"deadline64":"1789600030"'), true);
});

test("successful build fixtures retain the exact provider body and framing failure stays isolated", () => {
  const successfulBuilds = fixture.cases.filter((entry) => entry.method === "build" && entry.expected.kind === "success");
  assert.deepEqual(successfulBuilds.map((entry) => entry.caseId).sort(), ["build-eth-sol-synthetic", "build-sol-eth-synthetic"]);
  for (const entry of successfulBuilds) {
    assert.equal(entry.providerBody, entry.expected.value.rawProviderBuildJson, entry.caseId);
    assert.equal(JSON.parse(entry.providerBody).success, true, entry.caseId);
  }
  const framingFailure = fixture.cases.find((entry) => entry.caseId === "build-solana-framing-violation");
  assert.equal(JSON.parse(framingFailure.providerBody).transaction.transaction, "AA==");
  assert.equal(framingFailure.expected.kind, "sdk-error");
});

function nativeSnapshots() {
  const expected = buildExpectedSnapshot();
  return Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-${language}-test`,
  }]));
}

test("parity verifier accepts exactly five executed native snapshots", () => {
  const result = verifySnapshots(nativeSnapshots());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languages.map((entry) => entry.language), PARITY_LANGUAGES);
  assert.ok(result.languages.every((entry) => entry.quoteCases > 0 && entry.buildCases > 0 && entry.statusCases > 0));
  assert.equal(stableJson(result.languages).length > 0, true);
});

test("parity verifier rejects reference-only, missing, extra, changed, and credential-bearing captures", () => {
  const expected = buildExpectedSnapshot();
  const reference = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, { ...clone(expected), language }]));
  assert.throws(() => verifySnapshots(reference), BridgeParityError);

  const missing = nativeSnapshots();
  delete missing.ruby;
  assert.throws(() => verifySnapshots(missing), /exactly/u);

  const extra = nativeSnapshots();
  extra.swift = clone(extra.go);
  assert.throws(() => verifySnapshots(extra), /exactly/u);

  const changed = nativeSnapshots();
  changed.rust.behavior.quote.find((entry) => entry.caseId === "quote-eth-sol-synthetic").outcome.value[0].amountIn = "1";
  assert.throws(() => verifySnapshots(changed), /parity mismatch/u);

  const credential = nativeSnapshots();
  credential.go.behavior.quote[0].httpTrace[0].headers.authorization = "Bearer should-never-appear";
  assert.throws(() => verifySnapshots(credential), /unexpected header/u);
});
