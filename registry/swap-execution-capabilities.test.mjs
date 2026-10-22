import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import registry from "./swap-execution-capabilities.json" with { type: "json" };
import schema from "./swap-execution-capabilities.schema.json" with { type: "json" };
import dexCatalog from "./dex-catalog.json" with { type: "json" };
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import fixture from "./fixtures/swap-execution-cases.json" with { type: "json" };
import {
  SWAP_EXECUTION_CAPABILITIES,
  SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
  SWAP_EXECUTION_CAPABILITIES_JSON,
  SWAP_EXECUTION_CAPABILITY_KEYS,
  SWAP_EXECUTION_RUNTIME_KEYS,
  canonicalProjection,
  computeDigest,
  getSwapExecutionCapability,
  getSwapExecutionCapabilityForPool,
  isSwapExecutionCapability,
  validateSwapExecutionCapabilities,
} from "./swap-execution-capabilities.mjs";
import { LANGUAGES, renderLanguage } from "./generate-swap-execution-capabilities.mjs";

const REGISTRY_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);

function clone(value) {
  return structuredClone(value);
}

test("canonical execution capabilities have the exact reviewed two-row shape", async () => {
  assert.equal(validateSwapExecutionCapabilities(registry), true);
  assert.deepEqual(Object.keys(registry), ["schemaVersion", "asOfDate", "capabilities"]);
  assert.deepEqual(SWAP_EXECUTION_CAPABILITIES.map((entry) => entry.swapExecutionCapabilityId), ["swap-execution-0001", "swap-execution-0002"]);
  assert.deepEqual(Object.keys(registry.capabilities[0]), SWAP_EXECUTION_CAPABILITY_KEYS);
  assert.deepEqual(Object.keys(JSON.parse(SWAP_EXECUTION_CAPABILITIES_JSON)[0]), SWAP_EXECUTION_RUNTIME_KEYS);
  assert.equal(computeDigest(registry.capabilities), SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST);
  assert.match(SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.parse(await readFile(path.join(REGISTRY_DIRECTORY, "swap-execution-capabilities.json"), "utf8")).asOfDate, "2026-09-16");
});

test("runtime projection and lookup omit provenance and are immutable", () => {
  const first = getSwapExecutionCapability("swap-execution-0001");
  assert.equal(first.evidence, undefined);
  assert.equal(first.asOfDate, undefined);
  assert.equal(getSwapExecutionCapabilityForPool("pool-0002").swapExecutionCapabilityId, "swap-execution-0002");
  assert.equal(getSwapExecutionCapability("unknown"), null);
  assert.equal(getSwapExecutionCapabilityForPool("unknown"), null);
  assert.throws(() => { first.routerAddress = "0x1111111111111111111111111111111111111111"; }, TypeError);
  const reversed = [...registry.capabilities].reverse();
  assert.equal(computeDigest(reversed), computeDigest(registry.capabilities));
  assert.deepEqual(canonicalProjection(reversed), canonicalProjection(registry.capabilities));
});

test("validator binds routers, factories, pools, tokens, fees, and wrapped-native records", () => {
  const mutations = [
    ["routerAddress", "0x1111111111111111111111111111111111111111", /reviewed binding/u],
    ["factoryAddress", "0x1111111111111111111111111111111111111111", /reviewed binding/u],
    ["token0Address", "0x1111111111111111111111111111111111111111", /reviewed binding/u],
    ["wrappedNativeFunctionSelector", "0x11111111", /reviewed binding/u],
    ["functionSelector", "0x11111111", /functionSelector is unsupported/u],
    ["status", "legacy", /status must be active/u],
  ];
  for (const [field, value, expected] of mutations) {
    const next = clone(registry);
    next.capabilities[0][field] = value;
    assert.throws(() => validateSwapExecutionCapabilities(next), expected, field);
  }
  const poolCatalog = clone(dexCatalog);
  poolCatalog.poolDefinitions.find((entry) => entry.poolDefinitionId === "pool-0001").address = "0x1111111111111111111111111111111111111111";
  assert.throws(() => validateSwapExecutionCapabilities(registry, { dexCatalog: poolCatalog }), /pool (?:address|binding) differs/u);
  const token = clone(tokenCatalog);
  token.deployments.find((entry) => entry.deploymentId === "deployment-0008").standard = "spl-token-2022";
  assert.throws(() => validateSwapExecutionCapabilities(registry, { tokenCatalog: token }), /token0 binding differs/u);
  const extra = clone(registry);
  extra.capabilities[0].unexpected = true;
  assert.throws(() => validateSwapExecutionCapabilities(extra), /keys must be exactly/u);
});

test("capability helper rejects catalog growth and non-ERC20 tuples", () => {
  const pool = dexCatalog.poolDefinitions.find((entry) => entry.poolDefinitionId === "pool-0001");
  const input = tokenCatalog.deployments.find((entry) => entry.deploymentId === "deployment-0008");
  const output = tokenCatalog.deployments.find((entry) => entry.deploymentId === "deployment-0002");
  assert.equal(isSwapExecutionCapability(pool, input, output), true);
  assert.equal(isSwapExecutionCapability(pool, output, input), true);
  assert.equal(isSwapExecutionCapability({ ...pool, poolDefinitionId: "pool-9991" }, input, output), false);
  assert.equal(isSwapExecutionCapability(pool, { ...input, standard: "spl-token-2022" }, output), false);
  const unclassifiedCatalog = clone(tokenCatalog);
  unclassifiedCatalog.assets.find((entry) => entry.assetId === input.assetId).representationKind = "unclassified";
  assert.equal(isSwapExecutionCapability(pool, input, output, { tokenCatalog: unclassifiedCatalog }), false);
});

test("schema is strict and all five renderers expose only immutable JSON-string data", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "asOfDate", "capabilities"]);
  assert.equal(schema.$defs.capability.additionalProperties, false);
  assert.deepEqual(LANGUAGES, ["typescript", "rust", "python", "go", "ruby"]);
  for (const language of LANGUAGES) {
    const source = renderLanguage(language);
    const dataName = language === "go" ? "swapExecutionCapabilities" : "SWAP_EXECUTION_CAPABILITIES";
    assert.match(source, new RegExp(`${dataName}_JSON|${dataName}JSON`, "u"));
    assert.match(source, new RegExp(`${dataName}_CONTENT_DIGEST|${dataName}ContentDigest`, "u"));
    assert.match(source, new RegExp(`${dataName}_AS_OF_DATE|${dataName}AsOfDate`, "u"));
    assert.match(source, /swap-execution-0001/u);
    assert.match(source, /swap-execution-0002/u);
  }
});

test("Steiner final-router code-3 regressions preserve the prior successful trace", () => {
  assert.equal(fixture.cases.length, 44);
  const revert = fixture.cases.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-router-revert-code3");
  const nonRevert = fixture.cases.find((entry) => entry.caseId === "simulate-ethereum-weth-usdc-router-nonrevert-code3");
  const priorRevert = fixture.cases.find((entry) => entry.caseId === "simulation-router-revert");
  const priorNonRevert = fixture.cases.find((entry) => entry.caseId === "simulation-other-provider-error");
  assert.equal(revert.mutation, "routerRevertCode3");
  assert.equal(nonRevert.mutation, "routerNonRevertCode3");
  assert.deepEqual(revert.rpcResponses, priorRevert.rpcResponses);
  assert.deepEqual(revert.rpcTrace, priorRevert.rpcTrace);
  assert.deepEqual(nonRevert.rpcResponses, priorNonRevert.rpcResponses);
  assert.deepEqual(nonRevert.rpcTrace, priorNonRevert.rpcTrace);
  assert.deepEqual(revert.outcome, { kind: "sdk-error", code: "SWAP_SIMULATION_REVERTED" });
  assert.deepEqual(nonRevert.outcome, { kind: "transport-error", sourcePreserved: true });
});
