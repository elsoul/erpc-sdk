import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CATALOG as DEX_CATALOG, quoteExactInputFromSnapshot } from "./dex-catalog.mjs";
import { CATALOG as TOKEN_CATALOG } from "./token-catalog.mjs";
import {
  QUOTE_CAPABILITIES,
  QUOTE_CAPABILITY_KEYS,
  computeDigest,
  getQuoteCapability,
  isQuoteCapability,
  validateQuoteCapabilities,
} from "./quote-capabilities.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(ROOT, "fixtures", "quote-capability-cases.json");

function token(id) {
  return TOKEN_CATALOG.deployments.find((entry) => entry.deploymentId === id);
}

test("handwritten quote capabilities bind exact current pool, DEX, token, and fee records", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  assert.deepEqual(QUOTE_CAPABILITY_KEYS, [
    "chainId", "dexDeploymentId", "factoryAddress", "poolDefinitionId", "poolAddress",
    "token0DeploymentId", "token0Address", "token0Decimals",
    "token1DeploymentId", "token1Address", "token1Decimals",
    "adapterKind", "feeNumerator", "feeDenominator",
  ]);
  assert.deepEqual(QUOTE_CAPABILITIES.map((entry) => entry.poolDefinitionId), fixture.capabilityPoolIds);
  assert.equal(validateQuoteCapabilities(), true);
  assert.equal(computeDigest(), computeDigest(QUOTE_CAPABILITIES));
  for (const capability of QUOTE_CAPABILITIES) {
    const pool = DEX_CATALOG.poolDefinitions.find((entry) => entry.poolDefinitionId === capability.poolDefinitionId);
    assert.equal(isQuoteCapability(pool, token(capability.token0DeploymentId), token(capability.token1DeploymentId)), true);
    assert.deepEqual(getQuoteCapability(capability.poolDefinitionId), capability);
  }
});

test("capability lookup is immutable and unknown pools are unsupported", () => {
  const capability = getQuoteCapability("pool-0001");
  assert.throws(() => { capability.token0DeploymentId = "changed"; }, TypeError);
  assert.equal(getQuoteCapability("pool-unknown"), null);
  assert.equal(isQuoteCapability(null, null, null), false);
});

test("capabilities reject catalog rebinds and non ERC20 tuples before RPC", () => {
  const rebound = structuredClone(DEX_CATALOG);
  rebound.poolDefinitions[0].address = "0x1111111111111111111111111111111111111111";
  assert.equal(isQuoteCapability(rebound.poolDefinitions[0], token("deployment-0008"), token("deployment-0002"), { dexCatalog: rebound }), false);
  const token2022 = { ...token("deployment-0008"), standard: "spl-token-2022" };
  assert.equal(isQuoteCapability(DEX_CATALOG.poolDefinitions[0], token2022, token("deployment-0002")), false);
  const unclassifiedCatalog = structuredClone(TOKEN_CATALOG);
  unclassifiedCatalog.assets.find((entry) => entry.assetId === "asset-0007").representationKind = "unclassified";
  assert.equal(isQuoteCapability(DEX_CATALOG.poolDefinitions[0], token("deployment-0008"), token("deployment-0002"), { tokenCatalog: unclassifiedCatalog }), false);
  const knownPairGrowth = structuredClone(DEX_CATALOG.poolDefinitions[0]);
  knownPairGrowth.poolDefinitionId = "pool-9991";
  knownPairGrowth.address = "0x2222222222222222222222222222222222222222";
  assert.equal(isQuoteCapability(knownPairGrowth, token("deployment-0008"), token("deployment-0002")), false);
});

test("quote capability gate preserves exact quote arithmetic for known pairs", () => {
  const snapshot = {
    blockHash: "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb",
    blockNumber: "0x18c7f20",
    blockTimestamp: "0x6aa99537",
    reserve0: "9922163268622",
    reserve1: "4131396377933182743090",
  };
  const quote = quoteExactInputFromSnapshot({
    chainId: "eip155:1",
    poolDefinitionId: "pool-0001",
    inputTokenDeploymentId: "deployment-0002",
    outputTokenDeploymentId: "deployment-0008",
    amountIn: "1000000000000000000",
  }, snapshot, { now: 1789498700 });
  assert.equal(quote.amountOut, "2393866186");
});
