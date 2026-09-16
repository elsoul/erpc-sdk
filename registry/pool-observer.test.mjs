import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import rankingRpcFixture from "./fixtures/ranking-rpc.json" with { type: "json" };
import { DEFAULT_DISCOVERY_CONFIG, EVM_DISCOVERY_SELECTORS } from "./discovery.mjs";
import { computeDigest as computeDexDigest } from "./dex-catalog.mjs";
import { POOL_HEALTH_STATUSES, observePools, replayPoolObservations, validatePoolObservations } from "./pool-observer.mjs";

function abiWord(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function abiAddress(value) { return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`; }

function evmStatusRpc(mode) {
  const pair = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
  const factory = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
  const token0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const token1 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const block = { number: "0x10", hash: "0x" + "ab".repeat(32), timestamp: mode === "stale" ? "0x1" : "0x65000000" };
  const reserves = mode === "empty" ? [0, 0] : mode === "swap-disabled" ? [0, 2] : [1, 2];
  return async (network, method, params) => {
    if (network !== "ethereum") throw Object.assign(new Error("offline"), { code: "RPC_UNAVAILABLE" });
    if (mode === "unreachable") throw Object.assign(new Error("offline"), { code: "RPC_UNAVAILABLE" });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getCode") return mode === "missing" && params[0] === pair ? "0x" : "0x6000";
    const data = params[0].data;
    if (data.startsWith(EVM_DISCOVERY_SELECTORS.factoryGetPair)) return abiAddress(mode === "identity-mismatch" ? "0x0000000000000000000000000000000000000001" : pair);
    if (data === EVM_DISCOVERY_SELECTORS.pairFactory) return abiAddress(mode === "identity-mismatch" ? "0x0000000000000000000000000000000000000001" : factory);
    if (data === EVM_DISCOVERY_SELECTORS.pairToken0) return abiAddress(token0);
    if (data === EVM_DISCOVERY_SELECTORS.pairToken1) return abiAddress(token1);
    if (data === EVM_DISCOVERY_SELECTORS.pairGetReserves) return `${abiWord(reserves[0])}${abiWord(reserves[1]).slice(2)}`;
    throw Object.assign(new Error("unexpected selector"), { code: "RPC_ERROR" });
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_POOL_IDS = new Set(["pool-0003", "pool-0004"]);
const SOLANA_BLOCK_TIME = rankingRpcFixture.solanaReceipt.calls.find((entry) => entry.method === "getBlockTime")?.result;
const SOLANA_CAPTURE_MS = SOLANA_BLOCK_TIME * 1000;

function solanaSeedDexCatalog() {
  const catalog = structuredClone(canonicalDexCatalog);
  const dexIds = new Set(catalog.poolDefinitions.filter((pool) => SOLANA_POOL_IDS.has(pool.poolDefinitionId)).map((pool) => pool.dexDeploymentId));
  catalog.dexDeployments = catalog.dexDeployments.filter((dex) => dexIds.has(dex.dexDeploymentId));
  catalog.poolDefinitions = catalog.poolDefinitions.filter((pool) => SOLANA_POOL_IDS.has(pool.poolDefinitionId));
  catalog.nativeWrapDefinitions = catalog.nativeWrapDefinitions.filter((wrap) => wrap.chainId === SOLANA_CHAIN_ID);
  catalog.aliases = catalog.aliases.filter((alias) => alias.dexDeploymentId === null && (alias.poolDefinitionId === null || SOLANA_POOL_IDS.has(alias.poolDefinitionId)) || dexIds.has(alias.dexDeploymentId) || SOLANA_POOL_IDS.has(alias.poolDefinitionId));
  catalog.contentDigest = computeDexDigest(catalog);
  return catalog;
}

const SOLANA_DEX_CATALOG = solanaSeedDexCatalog();
// Reuse the committed raw Solana account facts from the ranking fixture. The
// clock below is a deterministic replay clock anchored to that receipt.
const SOLANA_RECEIPT = rankingRpcFixture.solanaReceipt;

function solanaFixtureRpc(blockTimeValue = SOLANA_BLOCK_TIME) {
  const calls = SOLANA_RECEIPT.calls;
  return async (network, method, params) => {
    if (network !== "solana") throw Object.assign(new Error("offline fixture"), { code: "RPC_UNAVAILABLE" });
    if (method === "getBlockTime") return blockTimeValue;
    if (method === "getSlot") return calls.find((entry) => entry.method === method)?.result;
    const entry = calls.find((candidate) => candidate.method === method && JSON.stringify(stableJson(candidate.params)) === JSON.stringify(stableJson(params)));
    if (!entry) throw Object.assign(new Error("missing committed Solana fixture request"), { code: "RPC_ERROR" });
    if (method !== "getMultipleAccounts") return entry.result;
    return { ...entry.result, value: entry.result.value.map((account) => account === null ? null : { ...account, executable: false }) };
  };
}

function solanaFixtureOptions(rpcClient = solanaFixtureRpc(SOLANA_BLOCK_TIME)) {
  return {
    rpcClient,
    config: DEFAULT_DISCOVERY_CONFIG,
    tokenCatalog,
    dexCatalog: SOLANA_DEX_CATALOG,
    clock: { now: SOLANA_CAPTURE_MS },
  };
}

function solanaFixtureArtifact(blockTimeValue = SOLANA_BLOCK_TIME) {
  return observePools({ ...solanaFixtureOptions(solanaFixtureRpc(blockTimeValue)), sourceSha: "5".repeat(40) });
}

function expectedPoolTaskCount(catalog) {
  return catalog.dexDeployments.reduce((total, dex) => {
    const activePools = catalog.poolDefinitions.filter((pool) => pool.dexDeploymentId === dex.dexDeploymentId && pool.status !== "retired");
    return total + Math.max(1, activePools.length);
  }, 0);
}

test("pool observer artifact and fixture enumerate independent protocol health states", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/pool-observer-rpc.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.protocols, ["uniswap-v2", "lfj-legacy-constant-product", "orca-whirlpool", "raydium-clmm"]);
  assert.deepEqual(fixture.healthStatuses, POOL_HEALTH_STATUSES);
  const rpc = async () => { throw Object.assign(new Error("offline fixture"), { code: "RPC_UNAVAILABLE" }); };
  const artifact = await observePools({ rpcClient: rpc, config: DEFAULT_DISCOVERY_CONFIG, sourceSha: "0".repeat(40) });
  assert.equal(artifact.observations.length, expectedPoolTaskCount(canonicalDexCatalog));
  assert.ok(artifact.observations.every((entry) => entry.status === "unreachable"));
  assert.equal(artifact.policy.outageRetirement, false);
  assert.equal(validatePoolObservations(artifact), true);
});

test("healthy EVM observations are canonical, transcript-bound, and status-derived", async () => {
  const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  const addressWord = (value) => `0x${value.slice(2).padStart(64, "0")}`;
  const rpc = async (network, method, params) => {
    if (network !== "ethereum") throw Object.assign(new Error("offline"), { code: "RPC_UNAVAILABLE" });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: "0x" + "ab".repeat(32), timestamp: "0x65000000" };
    if (method === "eth_getCode") return "0x6000";
    const data = params[0].data;
    if (data.startsWith(EVM_DISCOVERY_SELECTORS.factoryGetPair)) return addressWord("0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc");
    if (data === EVM_DISCOVERY_SELECTORS.pairFactory) return addressWord("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
    if (data === EVM_DISCOVERY_SELECTORS.pairToken0) return addressWord("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    if (data === EVM_DISCOVERY_SELECTORS.pairToken1) return addressWord("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    if (data === EVM_DISCOVERY_SELECTORS.pairGetReserves) return `${word(1)}${word(2).slice(2)}`;
    throw new Error("unexpected selector");
  };
  const artifact = await observePools({ rpcClient: rpc, sourceSha: "1".repeat(40), clock: { now: 1694498816000 } });
  assert.equal(artifact.observations.find((row) => row.poolDefinitionId === "pool-0001").status, "healthy");
  assert.ok(Array.isArray(artifact.rpcTranscript) && artifact.rpcTranscript.length > 0);
  assert.equal(replayPoolObservations(artifact, { sourceSha: artifact.sourceSha })[0].status, "healthy");
  const missingTranscript = structuredClone(artifact); delete missingTranscript.rpcTranscript;
  assert.throws(() => replayPoolObservations(missingTranscript, { sourceSha: artifact.sourceSha }), /transcript|raw evidence/u);
  const forgedStatus = structuredClone(artifact); forgedStatus.receipts[0].reserves = ["0", "0"];
  assert.throws(() => replayPoolObservations(forgedStatus, { sourceSha: artifact.sourceSha }), /status|reserves/u);
});

test("decoded EVM responses derive every health status from exact RPC evidence", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/pool-observer-rpc.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.decodedResponseCases.evmStatuses, POOL_HEALTH_STATUSES);
  const captureClock = { now: 1694498816000 };
  for (const status of POOL_HEALTH_STATUSES) {
    const artifact = await observePools({ rpcClient: evmStatusRpc(status), sourceSha: "2".repeat(40), clock: captureClock });
    const row = artifact.receipts.find((entry) => entry.poolDefinitionId === "pool-0001");
    assert.equal(row.status, status, status);
    assert.ok(row.errorCode === undefined || typeof row.errorCode === "string");
    const replayed = replayPoolObservations(artifact, { sourceSha: artifact.sourceSha });
    assert.equal(replayed.find((entry) => entry.poolDefinitionId === "pool-0001").status, status, `replay ${status}`);
  }
  const missingProof = await observePools({ rpcClient: evmStatusRpc("healthy"), sourceSha: "2".repeat(40), clock: captureClock });
  const missingProofRow = missingProof.receipts.find((entry) => entry.poolDefinitionId === "pool-0001");
  delete missingProofRow.raw;
  assert.throws(() => replayPoolObservations(missingProof, { sourceSha: missingProof.sourceSha }), /complete raw evidence/u);
});

test("committed Solana decoded replay covers both configured protocols", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/pool-observer-rpc.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.decodedResponseCases.solanaProtocols, ["orca-whirlpool", "raydium-clmm"]);
  const artifact = await solanaFixtureArtifact();
  const replayed = replayPoolObservations(artifact, { sourceSha: artifact.sourceSha, config: DEFAULT_DISCOVERY_CONFIG, tokenCatalog, dexCatalog: SOLANA_DEX_CATALOG });
  assert.deepEqual(replayed.map((entry) => [entry.poolDefinitionId, entry.status]), [["pool-0003", "healthy"], ["pool-0004", "healthy"]]);
  for (const row of artifact.receipts) {
    assert.ok(row.raw.poolAccount.owner.length > 0 && Number.isSafeInteger(row.contextSlot));
    assert.ok(row.raw.mintAccounts.every((account) => typeof account.owner === "string"));
  }
});

test("synthetic Solana replay rejects raw owner, account-order, PDA, and clock mutations", async () => {
  const fresh = await solanaFixtureArtifact();
  const replay = (artifact) => replayPoolObservations(artifact, { sourceSha: artifact.sourceSha, config: DEFAULT_DISCOVERY_CONFIG, tokenCatalog, dexCatalog: SOLANA_DEX_CATALOG });
  const poolId = "pool-0003";
  const rowFor = (artifact) => artifact.receipts.find((entry) => entry.poolDefinitionId === poolId);
  const poolCallFor = (artifact) => artifact.rpcTranscript.find((entry) => entry.request.method === "getMultipleAccounts" && entry.request.params[0]?.length === 1 && entry.request.params[0][0] === rowFor(artifact).poolAddress);
  const relatedCallFor = (artifact) => artifact.rpcTranscript.find((entry) => entry.request.method === "getMultipleAccounts" && entry.request.params[0]?.length === 5 && entry.response.result.value.some((account) => account?.data?.[0] === rowFor(artifact).raw.vaultAccounts[0].data));

  const owner = structuredClone(fresh);
  const ownerRow = rowFor(owner);
  const ownerCall = poolCallFor(owner);
  ownerRow.raw.poolAccount.owner = "11111111111111111111111111111111";
  ownerCall.response.result.value[0].owner = ownerRow.raw.poolAccount.owner;
  assert.throws(() => replay(owner), /program identity mismatch/u);

  const order = structuredClone(fresh);
  const orderCall = relatedCallFor(order);
  [orderCall.response.result.value[0], orderCall.response.result.value[1]] = [orderCall.response.result.value[1], orderCall.response.result.value[0]];
  assert.throws(() => replay(order), /related raw accounts are not bound/u);

  const pda = structuredClone(fresh);
  const pdaRow = rowFor(pda);
  const pdaCall = poolCallFor(pda);
  const pdaBytes = Buffer.from(pdaRow.raw.poolAccount.data, "base64");
  pdaBytes[8] ^= 1;
  pdaRow.raw.poolAccount.data = pdaBytes.toString("base64");
  pdaCall.response.result.value[0].data[0] = pdaRow.raw.poolAccount.data;
  assert.throws(() => replay(pda), /PDA mismatch/u);

  const clock = structuredClone(fresh);
  const clockRow = rowFor(clock);
  const clockEntry = clock.rpcTranscript.find((entry) => entry.request.method === "getBlockTime" && clockRow.request.transcriptIds.includes(entry.request.id));
  assert.ok(clockEntry);
  clockEntry.response.result = clockRow.blockTime + 1;
  assert.throws(() => replay(clock), /block-time response/u);
});

test("synthetic Solana replay requires fresh finite block time at the finalized slot", async () => {
  for (const [label, blockTime] of [["fresh", SOLANA_BLOCK_TIME], ["stale", 1], ["future", SOLANA_BLOCK_TIME + 1000], ["missing", null]]) {
    const artifact = await solanaFixtureArtifact(blockTime);
    const solRows = artifact.receipts;
    if (label === "fresh") assert.ok(solRows.every((entry) => entry.status === "healthy" && Number.isSafeInteger(entry.blockTime)));
    else assert.ok(solRows.every((entry) => entry.status === "stale"));
    const replayed = replayPoolObservations(artifact, { sourceSha: artifact.sourceSha, config: DEFAULT_DISCOVERY_CONFIG, tokenCatalog, dexCatalog: SOLANA_DEX_CATALOG });
    if (label === "fresh") assert.ok(replayed.every((entry) => entry.status === "healthy"));
    else assert.ok(replayed.every((entry) => entry.status === "stale"));
  }
});

test("budgeted runs report explicit unattempted coverage and remain replayable", async () => {
  const artifact = await observePools({ rpcClient: async () => { throw new Error("must not run"); }, sourceSha: "3".repeat(40), runBudgetMs: 0 });
  assert.equal(artifact.coverage.attemptedPoolCount, 0);
  assert.equal(artifact.coverage.unattemptedPoolCount, artifact.receipts.length);
  assert.ok(artifact.receipts.every((row) => row.status === "missing" && row.errorCode === "UNATTEMPTED_BUDGET" && row.unattempted === true));
  assert.equal(replayPoolObservations(artifact, { sourceSha: artifact.sourceSha }).length, artifact.receipts.length);
});

test("grown catalogs use the supplied active-pool set for collection and replay", async () => {
  const canonical = JSON.parse(await readFile(new URL("./dex-catalog.json", import.meta.url), "utf8"));
  const basePool = canonical.poolDefinitions.find((entry) => entry.poolDefinitionId === "pool-0001");
  const grown = {
    ...canonical,
    poolDefinitions: [...canonical.poolDefinitions, { ...basePool, poolDefinitionId: "pool-9001", address: "0x1111111111111111111111111111111111111111" }],
  };
  grown.contentDigest = computeDexDigest(grown);
  const rpc = async () => { throw Object.assign(new Error("fixed offline failure"), { code: "RPC_UNAVAILABLE" }); };
  const artifact = await observePools({ rpcClient: rpc, dexCatalog: grown, sourceSha: "4".repeat(40), clock: { now: 1789550421000 } });
  const expected = expectedPoolTaskCount(grown);
  assert.equal(artifact.receipts.length, expected);
  assert.equal(artifact.coverage.attemptedPoolCount, expected);
  assert.equal(validatePoolObservations(artifact, { dexCatalog: grown }), true);
  const replayed = replayPoolObservations(artifact, { sourceSha: artifact.sourceSha, dexCatalog: grown });
  assert.equal(replayed.length, expected);
  assert.equal(replayed.find((entry) => entry.poolDefinitionId === "pool-9001").status, "unreachable");
});
