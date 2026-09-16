import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import tokenCatalog from "./token-catalog.json" with { type: "json" };
import dexCatalog from "./dex-catalog.json" with { type: "json" };
import { computeDigest as dexCatalogDigest } from "./dex-catalog.mjs";
import cases from "./fixtures/token-ranking-cases.json" with { type: "json" };
import rpcFixture from "./fixtures/ranking-rpc.json" with { type: "json" };
import {
  CONTENT_DIGEST,
  NATIVE_QUOTE_DEPLOYMENTS,
  RANKINGS,
  RANKING_CONFIG,
  RANKING_METRICS,
  computeRankingConfigDigest,
  collectGlobalMarketCaps,
  collectRankingReceipts,
  computeDigest,
  listTokenRankings,
  normalizeRational,
  replayRankings,
  replayTokenRankings,
  validateRankingReceipts,
  validateRankingArtifact,
  validateRankingConfig,
} from "./token-rankings.mjs";
import { LANGUAGES, renderLanguage } from "./generate-token-rankings.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);

test("canonical ranking source validates with exact metadata and row contracts", () => {
  assert.deepEqual(RANKING_METRICS, ["onchain-total-supply-value-native", "global-circulating-market-cap-usd"]);
  assert.equal(validateRankingArtifact(RANKINGS), true);
  assert.equal(computeDigest(RANKINGS), CONTENT_DIGEST);
  assert.equal(RANKING_CONFIG.sources["eip155:1"].finalizedMaxBlockAgeSeconds, 1800);
  assert.equal(validateRankingConfig(RANKING_CONFIG), true);
  assert.deepEqual(listTokenRankings("unknown"), []);
  assert.deepEqual(listTokenRankings("eip155:1"), RANKINGS.records.filter((row) => row.chainId === "eip155:1"));
});

test("pure replay reduces rationals, orders exact values, and accounts for every deployment", () => {
  const entry = cases.validCases[0];
  const artifact = replayTokenRankings({ candidates: entry.observations }, { chainId: entry.chainId });
  assert.equal(artifact.metadata.status, "partial");
  assert.equal(artifact.records.length, 2);
  assert.deepEqual(artifact.records.map((row) => [row.rank, row.deploymentIds, row.valueNumerator, row.valueDenominator]), [
    [1, ["deployment-0002"], "1", "2"],
    [2, ["deployment-0008"], "1", "2"],
  ]);
  assert.equal(artifact.records[0].quoteDeploymentId, NATIVE_QUOTE_DEPLOYMENTS[entry.chainId]);
  assert.equal(artifact.metadata.coverage[0].totalDeployments, tokenCatalog.deployments.filter((row) => row.chainId === entry.chainId).length);
  assert.equal(artifact.metadata.coverage[0].rankedDeployments + artifact.metadata.coverage[0].unrankedDeployments, artifact.metadata.coverage[0].totalDeployments);
});

test("global metric groups exact provider economic mappings and uses USD fields", () => {
  const entry = cases.validCases[1];
  const artifact = replayTokenRankings({ candidates: entry.observations }, { chainId: entry.chainId, metric: entry.metric });
  assert.equal(artifact.records[0].metric, "global-circulating-market-cap-usd");
  assert.equal(artifact.records[0].quoteCurrency, "USD");
  assert.equal(artifact.records[0].quoteDeploymentId, null);
  assert.deepEqual(artifact.records[0].deploymentIds, ["deployment-0008"]);
  assert.equal(artifact.records[0].sourceAssetId, "provider-usdc");
});

test("legacy decoded RPC summaries are rejected by raw replay", () => {
  assert.throws(() => replayRankings(rpcFixture, { sourceSha: rpcFixture.sourceSha }), /ranking receipts must use the ranking-receipts envelope/u);
  assert.throws(() => normalizeRational("1".repeat(257), "1"), /bounded rational length/u);
});

function solanaRankingEnvelope(receipt = rpcFixture.solanaReceipt, dexCatalogValue = dexCatalog) {
  return {
    schemaVersion: 1,
    artifactKind: "ranking-receipts",
    sourceSha: "50b56e0d4ec84fc5754d44bc4e887f5499f5fe1d",
    configDigest: computeRankingConfigDigest(RANKING_CONFIG),
    tokenCatalogDigest: tokenCatalog.contentDigest,
    dexCatalogDigest: dexCatalogDigest(dexCatalogValue),
    observedAt: receipt.observedAt,
    metric: "onchain-total-supply-value-native",
    status: "partial",
    receipts: [receipt],
  };
}

function singlePoolDexCatalog(poolDefinitionId) {
  const value = structuredClone(dexCatalog);
  value.poolDefinitions = value.poolDefinitions.filter((entry) => entry.poolDefinitionId === poolDefinitionId);
  value.aliases = value.aliases.filter((entry) => entry.poolDefinitionId === null || entry.poolDefinitionId === poolDefinitionId);
  value.contentDigest = dexCatalogDigest(value);
  return value;
}

const CONTROL_SOURCE_SHA = "3".repeat(40);
const CONTROL_NOW = 1_789_498_700;
const CONTROL_SELECTORS = Object.freeze({
  factoryGetPair: "0xe6a43905",
  pairFactory: "0xc45a0155",
  pairToken0: "0x0dfe1681",
  pairToken1: "0xd21220a7",
  pairReserves: "0x0902f1ac",
  totalSupply: "0x18160ddd",
});

function controlledEvmDexCatalog() {
  const value = structuredClone(dexCatalog);
  const poolIds = new Set(["pool-0001", "pool-0002"]);
  const dexIds = new Set(value.poolDefinitions.filter((entry) => poolIds.has(entry.poolDefinitionId)).map((entry) => entry.dexDeploymentId));
  value.dexDeployments = value.dexDeployments.filter((entry) => dexIds.has(entry.dexDeploymentId));
  value.poolDefinitions = value.poolDefinitions.filter((entry) => poolIds.has(entry.poolDefinitionId));
  value.nativeWrapDefinitions = value.nativeWrapDefinitions.filter((entry) => entry.chainId !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  value.aliases = value.aliases.filter((entry) => (entry.dexDeploymentId === null || dexIds.has(entry.dexDeploymentId)) && (entry.poolDefinitionId === null || poolIds.has(entry.poolDefinitionId)));
  value.contentDigest = dexCatalogDigest(value);
  return value;
}

const CONTROL_DEX_CATALOG = controlledEvmDexCatalog();

function controlValue(value, network, fallback) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value[network] ?? fallback;
  return value ?? fallback;
}

function controlHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function controlAddressWord(value) {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function controlWords(...values) {
  return `0x${values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`;
}

function controlledEvmRpc({ now = CONTROL_NOW, latestDelta = 1, timestampOffset = -10, failure = null, solanaFailure = { method: "getGenesisHash", occurrence: 1 }, reservesMode = null } = {}) {
  const specs = new Map();
  for (const [network, chainId, rpcChainId, poolId, initialNumber, hashByte] of [
    ["ethereum", "eip155:1", "0x1", "pool-0001", 100n, "a"],
    ["avalancheC", "eip155:43114", "0xa86a", "pool-0002", 200n, "b"],
  ]) {
    const pool = CONTROL_DEX_CATALOG.poolDefinitions.find((entry) => entry.poolDefinitionId === poolId);
    const dex = CONTROL_DEX_CATALOG.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
    const wrap = CONTROL_DEX_CATALOG.nativeWrapDefinitions.find((entry) => entry.chainId === chainId);
    const nativeIs0 = pool.token0DeploymentId === wrap.wrappedTokenDeploymentId;
    const initial = { number: controlHex(initialNumber), hash: `0x${hashByte.repeat(64)}`, timestamp: controlHex(BigInt(now) + BigInt(controlValue(timestampOffset, network, -10))) };
    const latest = { ...initial, number: controlHex(initialNumber + BigInt(controlValue(latestDelta, network, 1))) };
    specs.set(network, { chainId, rpcChainId, pool, dex, nativeIs0, initial, latest, finalizedReads: 0 });
  }
  const solanaState = { slotReads: 0 };
  return async (network, method, params) => {
    if (network === "solana") {
      if (method === "getGenesisHash") {
        if (solanaFailure?.method === method && solanaFailure.occurrence === 1) throw Object.assign(new Error("controlled Solana outage"), { code: "RPC_UNAVAILABLE" });
        return rpcFixture.solanaReceipt.calls.find((entry) => entry.method === method)?.result;
      }
      if (method === "getSlot") {
        solanaState.slotReads += 1;
        if (solanaFailure?.method === method && solanaState.slotReads === solanaFailure.occurrence) throw Object.assign(new Error("controlled Solana outage"), { code: "RPC_UNAVAILABLE" });
        return 447476294;
      }
      if (method === "getBlockTime") {
        if (solanaFailure?.method === method && solanaFailure.occurrence === 1) throw Object.assign(new Error("controlled Solana outage"), { code: "RPC_UNAVAILABLE" });
        return 1789547056;
      }
      if (method === "getMultipleAccounts" && solanaFailure?.method === method && solanaFailure.occurrence === 1) throw Object.assign(new Error("controlled Solana outage"), { code: "RPC_UNAVAILABLE" });
      throw Object.assign(new Error("controlled Solana fixture has no pool data"), { code: "RPC_ERROR" });
    }
    const spec = specs.get(network);
    if (!spec) throw Object.assign(new Error("unknown controlled network"), { code: "RPC_ERROR" });
    if (method === "eth_chainId") return spec.rpcChainId;
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") {
        spec.finalizedReads += 1;
        if (failure?.network === network && failure.method === method && spec.finalizedReads === failure.occurrence) throw Object.assign(new Error("controlled fixed outage"), { code: "RPC_UNAVAILABLE" });
        return spec.finalizedReads === 1 ? spec.initial : spec.latest;
      }
      if (params[0] === spec.initial.number) return spec.initial;
      throw Object.assign(new Error("unexpected controlled block request"), { code: "RPC_ERROR" });
    }
    if (method === "eth_getCode") return "0x6000";
    if (method !== "eth_call") throw Object.assign(new Error("unexpected controlled RPC method"), { code: "RPC_ERROR" });
    const target = params[0]?.to?.toLowerCase?.();
    const data = params[0]?.data?.toLowerCase?.();
    const pool = spec.pool;
    const dex = spec.dex;
    const token0 = tokenCatalog.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId);
    const token1 = tokenCatalog.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId);
    if (target === dex.programAddress.toLowerCase() && data?.startsWith(CONTROL_SELECTORS.factoryGetPair)) return controlAddressWord(pool.address);
    if (target === pool.address.toLowerCase() && data === CONTROL_SELECTORS.pairFactory) return controlAddressWord(dex.programAddress);
    if (target === pool.address.toLowerCase() && data === CONTROL_SELECTORS.pairToken0) return controlAddressWord(token0.address);
    if (target === pool.address.toLowerCase() && data === CONTROL_SELECTORS.pairToken1) return controlAddressWord(token1.address);
    if (target === pool.address.toLowerCase() && data === CONTROL_SELECTORS.pairReserves) {
      const mode = controlValue(reservesMode, network, "healthy");
      if (mode === "empty") return controlWords(0n, 0n, 0n);
      if (mode === "below-min") return spec.nativeIs0 ? controlWords(10_000_000_000_000_000_000n, 1_000_000_000_000n, 0n) : controlWords(1_000_000_000_000n, 1_000_000_000_000_000_000n, 0n);
      return spec.nativeIs0 ? controlWords(200_000_000_000_000_000_000n, 1_000_000_000_000n, 0n) : controlWords(1_000_000_000_000n, 20_000_000_000_000_000_000n, 0n);
    }
    const pricedToken = spec.nativeIs0 ? token1 : token0;
    if (target === pricedToken.address.toLowerCase() && data === CONTROL_SELECTORS.totalSupply) return controlWords(1_000_000_000_000n);
    throw Object.assign(new Error("unexpected controlled EVM call"), { code: "RPC_ERROR" });
  };
}

async function collectControlledRanking(options = {}) {
  const sourceSha = options.sourceSha ?? CONTROL_SOURCE_SHA;
  const now = options.now ?? CONTROL_NOW;
  const config = options.config ?? RANKING_CONFIG;
  const controlledDexCatalog = options.dexCatalog ?? CONTROL_DEX_CATALOG;
  const raw = await collectRankingReceipts({ sourceSha, now, config, tokenCatalog, dexCatalog: controlledDexCatalog, rpcClient: controlledEvmRpc(options) });
  const replayed = replayRankings(raw, { sourceSha, config, tokenCatalog, dexCatalog: controlledDexCatalog });
  return { raw, replayed, sourceSha, config, dexCatalog: controlledDexCatalog };
}

test("replays the persisted Solana raw receipt and preserves the EURC native valuation", () => {
  const envelope = solanaRankingEnvelope();
  const artifact = replayRankings(envelope, { sourceSha: envelope.sourceSha, config: RANKING_CONFIG });
  const expected = rpcFixture.solanaExpected;
  const row = artifact.records.find((entry) => entry.deploymentIds.includes(expected.deploymentId));
  assert.ok(row, "the persisted Solana receipt must produce a EURC ranking row");
  assert.equal(row.valueNumerator, expected.valueNumerator);
  assert.equal(row.valueDenominator, expected.valueDenominator);
  assert.equal(row.observedAt, expected.observedAt);
  assert.equal(row.quoteCurrency, "native");
  assert.equal(row.quoteDeploymentId, NATIVE_QUOTE_DEPLOYMENTS[row.chainId]);
});

test("a frozen Solana vault is unpriced and cannot produce a native valuation", () => {
  const dexCatalogValue = singlePoolDexCatalog("pool-0003");
  const envelope = structuredClone(solanaRankingEnvelope(rpcFixture.solanaReceipt, dexCatalogValue));
  const related = envelope.receipts[0].calls.find((call) => call.method === "getMultipleAccounts" && call.params[0].length === 5);
  assert.ok(related, "the persisted Solana receipt must contain related accounts");
  const frozenVault = Buffer.from(related.result.value[2].data[0], "base64");
  frozenVault[108] = 2;
  related.result.value[2].data[0] = frozenVault.toString("base64");
  related.responseDigest = createHash("sha256").update(JSON.stringify(related.result)).digest("hex");
  const artifact = replayRankings(envelope, { sourceSha: envelope.sourceSha, config: RANKING_CONFIG, dexCatalog: dexCatalogValue });
  assert.equal(artifact.records.some((entry) => entry.deploymentIds.includes(rpcFixture.solanaExpected.deploymentId)), false);
  const unranked = artifact.unranked.find((entry) => entry.deploymentId === rpcFixture.solanaExpected.deploymentId);
  assert.equal(unranked?.reason, "unpriced");
});

test("Raydium uses the reviewed swap-disabled bit and rejects a nonzero seed index", () => {
  const raydiumOnly = singlePoolDexCatalog("pool-0004");
  for (const { statusByte, seedIndex, expectedRecord, expectedReason, expectedError } of [
    { statusByte: 4, seedIndex: 0, expectedRecord: true },
    { statusByte: 16, seedIndex: 0, expectedRecord: false, expectedReason: "unpriced" },
    { statusByte: 0, seedIndex: 1, expectedRecord: false, expectedError: /no valid native pool/u },
  ]) {
    const receipt = structuredClone(rpcFixture.solanaReceipt);
    const poolCall = receipt.calls.find((call) => call.method === "getMultipleAccounts" && call.params[0].length === 1 && call.params[0][0] === "AwaVyGAF3N6K4YRUJk55Ui1GquKhKdD6vTCmVvCzXpKf");
    assert.ok(poolCall, "the persisted Solana receipt must contain the Raydium pool account");
    const poolBytes = Buffer.from(poolCall.result.value[0].data[0], "base64");
    poolBytes[389] = statusByte;
    poolBytes.writeUInt16LE(seedIndex, 391);
    poolCall.result.value[0].data[0] = poolBytes.toString("base64");
    poolCall.responseDigest = createHash("sha256").update(JSON.stringify(poolCall.result)).digest("hex");
    const envelope = solanaRankingEnvelope(receipt, raydiumOnly);
    if (expectedError) {
      assert.throws(() => replayRankings(envelope, { sourceSha: envelope.sourceSha, config: RANKING_CONFIG, dexCatalog: raydiumOnly }), expectedError);
      continue;
    }
    const artifact = replayRankings(envelope, { sourceSha: envelope.sourceSha, config: RANKING_CONFIG, dexCatalog: raydiumOnly });
    const row = artifact.records.find((entry) => entry.deploymentIds.includes(rpcFixture.solanaExpected.deploymentId));
    assert.equal(Boolean(row), expectedRecord, `status byte ${statusByte} and seed index ${seedIndex} should ${expectedRecord ? "remain quotable" : "be excluded"}`);
    if (!expectedRecord) assert.equal(artifact.unranked.find((entry) => entry.deploymentId === rpcFixture.solanaExpected.deploymentId)?.reason, expectedReason);
  }
});

test("collector emits a bound request/response transcript and tampering is ignored", async () => {
  const head = { number: "0x18c7f20", hash: "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb", timestamp: "0x6aa99537" };
  const addressWord = (address) => "0x" + address.slice(2).padStart(64, "0");
  const words = (...values) => "0x" + values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("");
  const provider = async (method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return head;
    if (method === "eth_getCode") return "0x6001600055";
    if (method !== "eth_call") throw new Error("unexpected method");
    const target = params[0].to.toLowerCase();
    const callData = params[0].data.toLowerCase();
    if (target === "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f" && callData.startsWith("0xe6a43905")) return addressWord("0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc");
    if (target === "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc" && callData === "0xc45a0155") return addressWord("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
    if (target === "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc" && callData === "0x0dfe1681") return addressWord("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    if (target === "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc" && callData === "0xd21220a7") return addressWord("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    if (target === "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc" && callData === "0x0902f1ac") return words("9922163268622", "4131396377933182743090", "0");
    if (target === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" && callData === "0x18160ddd") return words("1000000000000");
    return words("0");
  };
  const raw = await collectRankingReceipts({ chainId: "eip155:1", rpc: { ethereum: provider }, now: 1789498700, sourceSha: "2".repeat(40) });
  assert.equal(validateRankingReceipts(raw), true);
  assert.ok(raw.receipts[0].calls.every((call) => call.requestDigest));
  const tampered = structuredClone(raw);
  tampered.receipts[0].calls.find((call) => call.method === "eth_call" && call.params[0].data === "0x0902f1ac").result = words("1", "1", "0");
  assert.throws(() => replayRankings(tampered, { sourceSha: "2".repeat(40) }), /ranking transcript replay failed/u);
});

test("collector persists only fixed RPC error codes and rehashed receipts replay safely", async () => {
  const sourceSha = "50b56e0d4ec84fc5754d44bc4e887f5499f5fe1d";
  const secret = "https://rpc.invalid/?api-key=DO_NOT_RETAIN_TEST_SECRET";
  const raw = await collectRankingReceipts({
    sourceSha,
    rpcClient: async () => { throw new Error(secret); },
    now: 1789498700,
  });
  const encoded = JSON.stringify(raw);
  assert.doesNotMatch(encoded, /DO_NOT_RETAIN_TEST_SECRET/u);
  assert.doesNotMatch(encoded, /https:\/\/rpc\.invalid/u);
  for (const receipt of raw.receipts) {
    assert.ok(receipt.calls.length > 0);
    for (const call of receipt.calls) {
      assert.deepEqual(call.error, { code: "RPC_UNAVAILABLE" });
      assert.equal(Object.keys(call.error).sort().join(","), "code");
      assert.equal(call.errorDigest, createHash("sha256").update(JSON.stringify(call.error)).digest("hex"));
    }
  }

  const leaked = JSON.parse(encoded);
  leaked.receipts[0].calls[0].error = { name: "Error", message: secret, code: null };
  leaked.receipts[0].calls[0].errorDigest = createHash("sha256").update(JSON.stringify(leaked.receipts[0].calls[0].error)).digest("hex");
  assert.throws(() => validateRankingReceipts(leaked), /error code is not fixed and allowlisted/u);

  const rehashed = JSON.parse(encoded);
  for (const receipt of rehashed.receipts) {
    for (const call of receipt.calls) {
      call.errorDigest = createHash("sha256").update(JSON.stringify(call.error)).digest("hex");
    }
  }
  const replayed = replayRankings(rehashed, { sourceSha });
  assert.equal(validateRankingArtifact(replayed), true);
  assert.equal(replayed.metadata.status, "partial");
});

test("default collection and strict replay isolate a later EVM transport failure to its chain", async () => {
  const { raw, replayed } = await collectControlledRanking({ failure: { network: "ethereum", method: "eth_getBlockByNumber", occurrence: 2 } });
  const ethereumReceipt = raw.receipts.find((entry) => entry.chainId === "eip155:1");
  assert.equal(ethereumReceipt.status, "partial");
  assert.ok(ethereumReceipt.calls.some((call) => call.method === "eth_getBlockByNumber" && call.error?.code === "RPC_UNAVAILABLE"));
  assert.equal(replayed.records.some((entry) => entry.chainId === "eip155:1"), false);
  assert.ok(replayed.unranked.some((entry) => entry.chainId === "eip155:1" && entry.reason === "unavailable"));
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:43114" && entry.deploymentIds.includes("deployment-0009")));
});

test("default collection and strict replay isolate a later Solana transport failure to its chain", async () => {
  const { raw, replayed } = await collectControlledRanking({ solanaFailure: { method: "getSlot", occurrence: 2 } });
  const solanaReceipt = raw.receipts.find((entry) => entry.chainId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(solanaReceipt.status, "partial");
  assert.ok(solanaReceipt.calls.some((call) => call.method === "getSlot" && call.error?.code === "RPC_UNAVAILABLE"));
  assert.equal(replayed.records.some((entry) => entry.chainId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
  assert.ok(replayed.unranked.some((entry) => entry.chainId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && entry.reason === "unavailable"));
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:1" && entry.deploymentIds.includes("deployment-0008")));
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:43114" && entry.deploymentIds.includes("deployment-0009")));
});

test("strict replay isolates a genuine finalized-head lag without losing another healthy chain", async () => {
  const { replayed } = await collectControlledRanking({ latestDelta: { ethereum: 4, avalancheC: 1 } });
  assert.equal(replayed.records.some((entry) => entry.chainId === "eip155:1"), false);
  assert.ok(replayed.unranked.some((entry) => entry.chainId === "eip155:1" && entry.reason === "stale"));
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:43114" && entry.deploymentIds.includes("deployment-0009")));
});

test("strict replay isolates a stale capture timestamp without using stale valuations", async () => {
  const { replayed } = await collectControlledRanking({ timestampOffset: { ethereum: -2000, avalancheC: -10 } });
  assert.equal(replayed.records.some((entry) => entry.chainId === "eip155:1"), false);
  assert.ok(replayed.unranked.some((entry) => entry.chainId === "eip155:1" && entry.reason === "stale"));
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:43114" && entry.deploymentIds.includes("deployment-0009")));
});

test("verified all-unpriced EVM sources remain explicit unranked rows", async () => {
  for (const [mode, reason] of [["empty", "unpriced"], ["below-min", "below-min-native-liquidity"]]) {
    const { replayed } = await collectControlledRanking({ reservesMode: { ethereum: mode, avalancheC: "healthy" } });
    assert.equal(replayed.records.some((entry) => entry.chainId === "eip155:1"), false, mode);
    assert.ok(replayed.unranked.some((entry) => entry.chainId === "eip155:1" && entry.deploymentId === "deployment-0008" && entry.reason === reason), mode);
    assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:43114" && entry.deploymentIds.includes("deployment-0009")), mode);
  }
});

test("an unrelated fixed failure marker cannot hide healthy transcript values", async () => {
  const { raw, sourceSha, config, dexCatalog: controlledDexCatalog } = await collectControlledRanking();
  const forged = structuredClone(raw);
  const ethereumReceipt = forged.receipts.find((entry) => entry.chainId === "eip155:1");
  const params = [{ to: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef" }, { blockHash: ethereumReceipt.blockHash, requireCanonical: true }];
  const error = { code: "RPC_UNAVAILABLE" };
  ethereumReceipt.calls.push({ method: "eth_call", params, requestDigest: createHash("sha256").update(JSON.stringify(params)).digest("hex"), error, errorDigest: createHash("sha256").update(JSON.stringify(error)).digest("hex") });
  ethereumReceipt.status = "partial";
  const replayed = replayRankings(forged, { sourceSha, config, tokenCatalog, dexCatalog: controlledDexCatalog });
  assert.ok(replayed.records.some((entry) => entry.chainId === "eip155:1" && entry.deploymentIds.includes("deployment-0008")));
  assert.equal(replayed.unranked.some((entry) => entry.chainId === "eip155:1" && entry.deploymentId === "deployment-0008" && entry.reason === "unavailable"), false);
});

test("mismatched raw EVM header claims remain hard failures", async () => {
  const { raw, sourceSha, config, dexCatalog: controlledDexCatalog } = await collectControlledRanking();
  const forged = structuredClone(raw);
  const ethereumReceipt = forged.receipts.find((entry) => entry.chainId === "eip155:1");
  ethereumReceipt.latestBlockNumber = controlHex(BigInt(ethereumReceipt.latestBlockNumber) + 1n);
  assert.throws(() => replayRankings(forged, { sourceSha, config, tokenCatalog, dexCatalog: controlledDexCatalog }), /ranking transcript replay failed/u);
});

test("fabricated all-error receipts are not accepted as source outages", async () => {
  const { raw, sourceSha, config, dexCatalog: controlledDexCatalog } = await collectControlledRanking();
  const forged = structuredClone(raw);
  const ethereumReceipt = forged.receipts.find((entry) => entry.chainId === "eip155:1");
  const params = [];
  const error = { code: "RPC_UNAVAILABLE" };
  ethereumReceipt.calls = [{ method: "eth_call", params, requestDigest: createHash("sha256").update(JSON.stringify(params)).digest("hex"), error, errorDigest: createHash("sha256").update(JSON.stringify(error)).digest("hex") }];
  ethereumReceipt.status = "partial";
  assert.throws(() => replayRankings(forged, { sourceSha, config, tokenCatalog, dexCatalog: controlledDexCatalog }), /ranking transcript replay failed/u);
});

test("native and both Solana WSOL mints remain explicit excluded rows", () => {
  const artifact = replayTokenRankings({ candidates: [] }, { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
  const excluded = artifact.unranked.filter((row) => row.reason === "excluded-native").map((row) => row.deploymentId);
  assert.ok(excluded.includes("deployment-0005"));
  assert.ok(excluded.includes("deployment-0006"));
  assert.ok(excluded.includes("deployment-0007"));
  assert.equal(artifact.metadata.coverage[0].rankedDeployments + artifact.metadata.coverage[0].unrankedDeployments, artifact.metadata.coverage[0].totalDeployments);
});

test("rights denied global provider stays unranked and never falls back to a vendor dataset", async () => {
  const artifact = await collectGlobalMarketCaps({ chainId: "eip155:1" }, tokenCatalog);
  assert.equal(artifact.metadata.metric, "global-circulating-market-cap-usd");
  assert.equal(artifact.records.length, 0);
  assert.ok(artifact.unranked.some((entry) => entry.reason === "rights-denied"));
  assert.equal(artifact.provenance[0].rights, "unconfigured");
});

test("licensed global mappings compare EVM case-insensitively and Solana case-sensitively", async () => {
  const solanaId = "deployment-0013";
  const solana = tokenCatalog.deployments.find((entry) => entry.deploymentId === solanaId);
  const config = structuredClone(RANKING_CONFIG);
  config.globalCirculatingMarketCap = { enabled: true, sourceId: "licensed-test", rights: "licensed", mappings: [{ assetId: solana.assetId, chainId: solana.chainId, deployments: [{ deploymentId: solanaId, address: solana.address }] }] };
  const provider = async () => ({ valueNumerator: "10", valueDenominator: "1", observedAt: "2026-09-15T12:00:00Z", sourceAssetId: "provider-eurc" });
  const good = await collectGlobalMarketCaps({ chainId: solana.chainId, config, provider }, tokenCatalog);
  assert.equal(good.records[0].valueNumerator, "10");
  const changed = structuredClone(config);
  changed.globalCirculatingMarketCap.mappings[0].deployments[0].address = solana.address.slice(0, -1) + (solana.address.endsWith("1") ? "2" : "1");
  await assert.rejects(() => collectGlobalMarketCaps({ chainId: solana.chainId, config: changed, provider }, tokenCatalog), /global mapping is not exact/u);
});

test("all five ranking renderers are deterministic and carry immutable nested records", () => {
  const artifact = replayTokenRankings({ candidates: [{ chainId: "eip155:1", deploymentId: "deployment-0008", valueNumerator: "1", valueDenominator: "2", observedAt: "2026-09-15T12:00:00Z", sourceId: "render-test" }] }, { chainId: "eip155:1" });
  for (const language of LANGUAGES) {
    const source = renderLanguage(language, artifact);
    assert.equal(source, renderLanguage(language, artifact));
    assert.match(source, /deployment-0008/u);
    assert.match(source, /value_numerator|valueNumerator|ValueNumerator/u);
  }
});

test("Python ranking renderer wraps the permitted 256-digit value and round-trips it", async () => {
  const numerator = `1${"0".repeat(255)}`;
  const artifact = replayTokenRankings({ candidates: [{ chainId: "eip155:1", deploymentId: "deployment-0008", valueNumerator: numerator, valueDenominator: "1", observedAt: "2026-09-15T12:00:00Z", sourceId: "large-render-test" }] }, { chainId: "eip155:1" });
  const source = renderLanguage("python", artifact);
  assert.ok(source.split("\n").every((line) => line.length <= 100));
  const directory = await mkdtemp(path.join(tmpdir(), "erpc-ranking-python-render-"));
  const modulePath = path.join(directory, "ranking_data.py");
  try {
    await writeFile(modulePath, source, "utf8");
    const script = "import importlib.util, sys\nspec = importlib.util.spec_from_file_location('ranking_data', sys.argv[1])\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nassert module.TOKEN_RANKINGS[0].value_numerator == '1' + '0' * 255\n";
    const python = process.env.PYTHON ?? "python3";
    const result = spawnSync(python, ["-c", script, modulePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ranking generator is import safe and accepts only one language writes", () => {
  const script = path.join(ROOT, "generate-token-rankings.mjs");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(" + JSON.stringify(script) + ")"], { encoding: "utf8" });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  const allWrite = spawnSync(process.execPath, [script, "--language", "all"], { encoding: "utf8" });
  assert.notEqual(allWrite.status, 0);
  assert.match(allWrite.stderr, /all is supported only with --check/u);
});

test("ranking CLI rejects unknown chain or metric", () => {
  const script = path.join(ROOT, "rank-token-catalog.mjs");
  const unknownChain = spawnSync(process.execPath, [script, "--chain-id", "unknown:chain", "--format=json"], { encoding: "utf8" });
  assert.notEqual(unknownChain.status, 0);
  assert.match(unknownChain.stderr, /configured chain ID/u);
  const unknownMetric = spawnSync(process.execPath, [script, "--metric", "vendor-market-cap", "--format=json"], { encoding: "utf8" });
  assert.notEqual(unknownMetric.status, 0);
  assert.match(unknownMetric.stderr, /ranking metric is invalid/u);
});

test("explicit external receipt output is atomic and non-clobbering", async () => {
  const script = path.join(ROOT, "rank-token-catalog.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "erpc-ranking-cli-"));
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "ranking-receipts.json");
  const raw = {
    schemaVersion: 1,
    artifactKind: "ranking-receipts",
    sourceSha: null,
    configDigest: computeRankingConfigDigest(RANKING_CONFIG),
    tokenCatalogDigest: tokenCatalog.contentDigest,
    dexCatalogDigest: dexCatalog.contentDigest,
    observedAt: "2026-09-16T06:50:42Z",
    metric: "onchain-total-supply-value-native",
    status: "partial",
    receipts: [],
  };
  await writeFile(input, JSON.stringify(raw), "utf8");
  const created = spawnSync(process.execPath, [script, "--snapshot", input, "--receipts", output, "--format=json"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), raw);
  const existing = path.join(directory, "existing.json");
  await writeFile(existing, "sentinel", "utf8");
  const refused = spawnSync(process.execPath, [script, "--snapshot", input, "--receipts", existing, "--format=json"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refuses to overwrite/u);
  assert.equal(await readFile(existing, "utf8"), "sentinel");
  const link = path.join(directory, "link.json");
  await symlink(existing, link);
  const refusedLink = spawnSync(process.execPath, [script, "--snapshot", input, "--receipts", link, "--format=json"], { encoding: "utf8" });
  assert.notEqual(refusedLink.status, 0);
  assert.match(refusedLink.stderr, /refuses to overwrite/u);
  assert.equal(await readlink(link), existing);
  await rm(directory, { recursive: true, force: true });
});
