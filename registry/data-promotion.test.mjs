import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import tokenCatalog from "./token-catalog.json" with { type: "json" };
import dexCatalog from "./dex-catalog.json" with { type: "json" };
import ranking from "./token-rankings.json" with { type: "json" };
import discoveryConfig from "./discovery-config.json" with { type: "json" };
import rankingConfig from "./ranking-config.json" with { type: "json" };
import { computeDigest as tokenDigest } from "./token-catalog.mjs";
import { computeDigest as dexDigest } from "./dex-catalog.mjs";
import { computeDiscoveryConfigDigest } from "./discovery.mjs";
import { decodeBase58, deriveSolanaPda, EVM_DISCOVERY_SELECTORS, replayDiscoveryReceipts } from "./discovery.mjs";
import { observePools } from "./pool-observer.mjs";
import { replayTokenRankings } from "./token-rankings.mjs";
import { OUTPUTS as RANKING_OUTPUTS, renderLanguage as renderRankingLanguage } from "./generate-token-rankings.mjs";
import {
  DATA_ARTIFACT_FILENAMES,
  CANDIDATE_OUTPUT_PATHS,
  observationEnvelope,
  collectMaintenanceObservation,
  replayMaintenanceObservation,
  discoveredAlias,
  discoveredIdentity,
  verifyDataCi,
  verifyMergedCandidate,
  expectedCandidateChangedPaths,
  executionFromEnvironment,
  run,
} from "./data-promotion.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/data-promotion-cases.json", import.meta.url), "utf8"));
const SOURCE_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const TREE_SHA = execFileSync("git", ["rev-parse", `${SOURCE_SHA}^{tree}`], { encoding: "utf8" }).trim();

const UNAVAILABLE_POOL_ARTIFACT = await observePools({
  config: discoveryConfig,
  tokenCatalog,
  dexCatalog,
  sourceSha: SOURCE_SHA,
  rpcClient: async () => { throw Object.assign(new Error("offline fixture"), { code: "RPC_UNAVAILABLE" }); },
  clock: { now: 1694498816000 },
});

function emptyDiscovery() {
  return {
    schemaVersion: 1,
    artifactKind: "discovery-receipts",
    sourceSha: SOURCE_SHA,
    configDigest: computeDiscoveryConfigDigest(discoveryConfig),
    tokenCatalogDigest: tokenDigest(tokenCatalog),
    dexCatalogDigest: dexDigest(dexCatalog),
    status: "complete",
    workspace: { clean: true, pinned: true, promotable: true },
    coverage: { mode: "bounded", claim: "bounded", scopes: [] },
    receipts: [],
  };
}

function emptyPool(sourceSha = SOURCE_SHA) {
  const artifact = structuredClone(UNAVAILABLE_POOL_ARTIFACT);
  artifact.sourceSha = sourceSha;
  return artifact;
}

function emptyDiscoveryState() {
  return replayDiscoveryReceipts(emptyDiscovery(), { sourceSha: SOURCE_SHA, config: discoveryConfig, tokenCatalog, dexCatalog }).state;
}

function emptyRankingReceipts(sourceSha = SOURCE_SHA) {
  const configDigest = createHash("sha256").update(JSON.stringify(rankingConfig)).digest("hex");
  const observedAt = "2026-09-15T00:00:00Z";
  return {
    schemaVersion: 1,
    artifactKind: "ranking-receipts",
    sourceSha,
    configDigest,
    tokenCatalogDigest: tokenDigest(tokenCatalog),
    dexCatalogDigest: dexDigest(dexCatalog),
    observedAt,
    metric: "onchain-total-supply-value-native",
    status: "partial",
    receipts: Object.values({ ethereum: "eip155:1", avalancheC: "eip155:43114", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }).map((chainId) => ({ chainId, sourceId: `fixture-${chainId.replaceAll(":", "-")}`, observedAt, calls: [], status: "partial" })),
  };
}

function abiWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressWord(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function syntheticAddress(seed, fill) {
  return `0x${String(seed).padStart(40, fill)}`;
}

function qualifiedEvmDiscovery({ chainId, network, factory, count, startSeed, nativeReserves = undefined }) {
  const nativeDeploymentId = chainId === "eip155:1" ? "deployment-0002" : "deployment-0004";
  const nativeAddress = tokenCatalog.deployments.find((entry) => entry.deploymentId === nativeDeploymentId).address;
  const proposals = [];
  const receipts = [];
  const entries = [];
  for (let offset = 0; offset < count; offset += 1) {
    const pairIndex = offset;
    const tokenAddress = syntheticAddress(startSeed + offset, "1");
    const poolAddress = syntheticAddress(startSeed + offset, "2");
    const nativeReserve = nativeReserves?.[offset] ?? (chainId === "eip155:1" ? "20000000000000000000" : "200000000000000000000");
    const tokenReserve = chainId === "eip155:1" ? "100000000000000000000" : "1000000000000000000000";
    const reserves = `${abiWord(tokenReserve)}${abiWord(nativeReserve).slice(2)}`;
    const blockHash = `0x${"ab".repeat(32)}`;
    const row = {
      kind: "evm-pair",
      network,
      status: "success",
      subjectId: `${factory.dexDeploymentId}:${pairIndex}`,
      dexDeploymentId: factory.dexDeploymentId,
      pairIndex,
      address: poolAddress,
      tokens: [tokenAddress, nativeAddress],
      reserves: [tokenReserve, nativeReserve],
      factory: factory.factory,
      blockNumber: "0x100",
      blockHash,
      request: { blockHash },
      raw: {
        allPairs: addressWord(poolAddress),
        pairFactory: addressWord(factory.factory),
        token0: addressWord(tokenAddress),
        token1: addressWord(nativeAddress),
        reserves,
        factoryPair: addressWord(poolAddress),
      },
    };
    entries.push({ pairIndex, tokenAddress, poolAddress, row });
    proposals.push({
      kind: "token",
      chainId,
      address: tokenAddress,
      canonical: { standard: "erc20", decimals: 18 },
      evidence: [{ network, pairIndex }],
    });
    const poolId = discoveredIdentity("pool", chainId, poolAddress, factory.dexDeploymentId);
    proposals.push({
      kind: "pool",
      id: poolId,
      poolDefinitionId: poolId,
      chainId,
      address: poolAddress,
      dexDeploymentId: factory.dexDeploymentId,
      tokens: [tokenAddress, nativeAddress],
      canonical: {
        poolDefinitionId: poolId,
        token1DeploymentId: nativeDeploymentId,
        adapter: { kind: "evm-constant-product-v2", feeNumerator: "3", feeDenominator: "1000" },
      },
      evidence: [{ network, pairIndex }],
    });
    receipts.push(row);
  }
  return { entries, proposals, receipts };
}

function syntheticSolanaAddress(seed) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(seed, 28);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  const digits = [];
  while (value > 0n) {
    digits.push(Number(value % 58n));
    value /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return `${"1".repeat(leading)}${digits.reverse().map((digit) => alphabet[digit]).join("")}`;
}

function writeU128LE(buffer, offset, value) {
  const number = BigInt(value);
  buffer.writeBigUInt64LE(number & ((1n << 64n) - 1n), offset);
  buffer.writeBigUInt64LE(number >> 64n, offset + 8);
}

function solanaBytes(address) {
  const bytes = decodeBase58(address);
  assert.ok(bytes?.length === 32, `expected a 32-byte Solana address: ${address}`);
  return Buffer.from(bytes);
}

function solanaMintAccount(address, tokenProgram, { supply = 1_000_000n, decimals = 6 } = {}) {
  void address;
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(BigInt(supply), 36);
  data[44] = decimals;
  data[45] = 1;
  return { owner: tokenProgram, lamports: 1, executable: false, data: data.toString("base64") };
}

function solanaVaultAccount(mint, authority, tokenProgram, amount, frozen = false) {
  const data = Buffer.alloc(165);
  solanaBytes(mint).copy(data, 0);
  solanaBytes(authority).copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = frozen ? 2 : 1;
  return { owner: tokenProgram, lamports: 1, executable: false, data: data.toString("base64") };
}

function qualifiedSolanaDiscovery({ count, startSeed, dexDeploymentId = "dex-deployment-0003", liquidity = 1n, liquidityHigh = 0n, sqrtPrice = 1n, status = 0, frozenVaultIndex = -1, summaryLiquidity = undefined, summaryVaultFrozen = undefined, summaryStatus = undefined }) {
  const chainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const program = discoveryConfig.solana.programs.find((entry) => entry.dexDeploymentId === dexDeploymentId);
  const nativeMint = tokenCatalog.deployments.find((entry) => entry.deploymentId === "deployment-0006").address;
  const tokenProgram = discoveryConfig.solana.mintPrograms[0];
  const proposals = [];
  const receipts = [];
  const entries = [];
  for (let offset = 0; offset < count; offset += 1) {
    const mint = syntheticSolanaAddress(startSeed + offset);
    const configAddress = syntheticSolanaAddress(startSeed + 400 + offset);
    const vaults = [syntheticSolanaAddress(startSeed + 200 + offset), syntheticSolanaAddress(startSeed + 300 + offset)];
    const poolBytes = Buffer.alloc(program.layout.dataSize);
    Buffer.from(program.layout.discriminator, "hex").copy(poolBytes, 0);
    solanaBytes(configAddress).copy(poolBytes, program.layout.configOffset);
    solanaBytes(mint).copy(poolBytes, program.layout.mintOffsets[0]);
    solanaBytes(nativeMint).copy(poolBytes, program.layout.mintOffsets[1]);
    solanaBytes(vaults[0]).copy(poolBytes, program.layout.vaultOffsets[0]);
    solanaBytes(vaults[1]).copy(poolBytes, program.layout.vaultOffsets[1]);
    poolBytes[program.layout.pda.bumpOffset] = 1;
    if (Number.isSafeInteger(program.layout.seedIndexOffset)) poolBytes.writeUInt16LE(0, program.layout.seedIndexOffset);
    writeU128LE(poolBytes, program.layout.liquidityOffset, (BigInt(liquidityHigh) << 64n) + BigInt(liquidity));
    if (Number.isSafeInteger(program.layout.sqrtPriceOffset)) writeU128LE(poolBytes, program.layout.sqrtPriceOffset, BigInt(sqrtPrice));
    if (Number.isSafeInteger(program.layout.statusOffset)) poolBytes[program.layout.statusOffset] = status;
    const pool = deriveSolanaPda(program.program, poolBytes, program.layout.pda);
    assert.equal(typeof pool, "string");
    const configBytes = Buffer.from([1]);
    const mintAccounts = [solanaMintAccount(mint, tokenProgram), solanaMintAccount(nativeMint, tokenProgram)];
    const vaultAccounts = [
      solanaVaultAccount(mint, pool, tokenProgram, 500_000_000_000n, frozenVaultIndex === 0),
      solanaVaultAccount(nativeMint, pool, tokenProgram, 200_000_000_000n, frozenVaultIndex === 1),
    ];
    const row = {
      kind: "solana-program",
      network: "solana",
      status: "success",
      subjectId: `${program.dexDeploymentId}:${pool}`,
      dexDeploymentId: program.dexDeploymentId,
      address: pool,
      program: program.program,
      mints: [mint, nativeMint],
      vaults,
      contextSlot: 500_000_000,
      raw: {
        poolAccount: { owner: program.program, lamports: 1, executable: false, data: poolBytes.toString("base64") },
        mintAccounts,
        vaultAccounts,
        configAccount: { owner: program.program, lamports: 1, executable: false, data: configBytes.toString("base64") },
      },
      liquidity: String(summaryLiquidity ?? liquidity),
      vaultAmounts: ["500000000000", "200000000000"],
      vaultFrozen: summaryVaultFrozen ?? [frozenVaultIndex === 0, frozenVaultIndex === 1],
      statusByte: summaryStatus ?? status,
    };
    entries.push({ pool, mint, row, poolBytes, vaultAccounts });
    proposals.push({ kind: "token", chainId, address: mint, canonical: { standard: "spl-token", decimals: 6 }, evidence: [{ network: "solana" }] });
    proposals.push({
      kind: "pool",
      chainId,
      address: pool,
      dexDeploymentId: program.dexDeploymentId,
      mints: [mint, nativeMint],
      canonical: { token1DeploymentId: "deployment-0006", adapter: { kind: dexDeploymentId === "dex-deployment-0004" ? "solana-raydium-clmm" : "solana-orca-whirlpool", feeNumerator: null, feeDenominator: null } },
      evidence: [{ network: "solana" }],
    });
    receipts.push(row);
  }
  return { entries, proposals, receipts };
}

function admissionCursorState(factoryEntries) {
  const state = emptyDiscoveryState();
  for (const { factory, count } of factoryEntries) {
    state.factories[factory.dexDeploymentId] = {
      count,
      tailCursor: count,
      backfillCursor: 0,
      backfillNext: 0,
      pendingIndexes: [],
      completedIndexes: Array.from({ length: count }, (_, index) => index),
      lastBlockNumber: null,
      lastBlockHash: null,
    };
  }
  return state;
}

function discoveryObservationWithReceipts(observation, receipts) {
  const discovery = structuredClone(observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.discovery].json);
  discovery.receipts = receipts;
  return discovery;
}

function makeObservation() {
  return observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: emptyRankingReceipts(),
    discoveryConfig,
    rankingConfig,
    discovery: emptyDiscovery(),
    pool: emptyPool(),
    execution: { origin: "local" },
  });
}

function makePaddedObservation(paddingBytes) {
  const base = makeObservation();
  const discovery = emptyDiscovery();
  discovery.padding = "x".repeat(paddingBytes);
  return observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: base.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery,
    pool: base.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
}

function replaySolanaQualification(discoveryResult) {
  const observation = makeObservation();
  const envelope = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery: discoveryObservationWithReceipts(observation, discoveryResult.receipts),
    pool: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
  return replayMaintenanceObservation(envelope, {
    root: process.cwd(),
    config: discoveryConfig,
    rankingConfig,
    testOnly: true,
    replayDiscovery: () => ({ proposals: discoveryResult.proposals, state: emptyDiscoveryState() }),
    replayPool: () => [],
    replayRanking: (raw, { tokenCatalog: candidateTokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: candidateTokenCatalog }),
  });
}

function emptyTestOnlyReplayOptions() {
  return {
    root: process.cwd(),
    config: discoveryConfig,
    rankingConfig,
    testOnly: true,
    replayDiscovery: () => ({ proposals: [], state: emptyDiscoveryState() }),
    replayPool: () => [],
    replayRanking: (raw, { tokenCatalog: candidateTokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: candidateTokenCatalog }),
  };
}

test("fixture inventory covers positive and adversarial M2 contracts", () => {
  assert.equal(FIXTURES.fixtureKind, "m2-data-promotion-cases");
  assert.ok(FIXTURES.cases.some((entry) => entry.expect === "additive-review-candidate"));
  assert.ok(FIXTURES.cases.some((entry) => entry.expect === "reject"));
  assert.ok(FIXTURES.cases.some((entry) => entry.caseId === "admission-cap-requeue-and-resume"));
  assert.ok(FIXTURES.cases.some((entry) => entry.caseId === "forged-deferred-proposal"));
  assert.deepEqual(FIXTURES.fixedArtifacts, ["discovery-receipts.json", "pool-receipts.json", "ranking-receipts.json"]);
});

test("empty bound replay is deterministic and emits every five-language data output", () => {
  const observation = makeObservation();
  const first = replayMaintenanceObservation(observation, { root: process.cwd(), config: discoveryConfig, rankingConfig });
  const second = replayMaintenanceObservation(structuredClone(observation), { root: process.cwd(), config: discoveryConfig, rankingConfig });
  assert.equal(first.actionRequired, false);
  assert.equal(first.outputDigest, second.outputDigest);
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
  assert.deepEqual(Object.keys(first.files).sort(), CANDIDATE_OUTPUT_PATHS);
  assert.equal(Object.keys(first.files).length, 19);
});

test("raw artifact byte binding rejects a forged success or edited receipt", () => {
  const observation = makeObservation();
  observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.discovery].json.receipts.push({ status: "success", decoded: true });
  assert.throws(() => replayMaintenanceObservation(observation, { root: process.cwd(), config: discoveryConfig, rankingConfig }), /SHA-256 binding|byte length/u);
});

test("accepts a bounded expanded discovery raw envelope", () => {
  const observation = makePaddedObservation(10 * 1024 * 1024);
  const candidate = replayMaintenanceObservation(observation, emptyTestOnlyReplayOptions());
  assert.equal(candidate.tokenCandidates.length, 0);
  assert.equal(candidate.poolCandidates.length, 0);
});

test("rejects a discovery raw envelope beyond the finite bound", () => {
  const observation = makePaddedObservation(12 * 1024 * 1024);
  assert.throws(() => replayMaintenanceObservation(observation, emptyTestOnlyReplayOptions()), (error) => error?.code === "ARTIFACT_TOO_LARGE");
});

test("collector returns the envelope and reuses explicit raw artifacts", async () => {
  const sourceSha = "50b56e0d4ec84fc5754d44bc4e887f5499f5fe1d";
  const outputDir = mkdtempSync(join(tmpdir(), "erpc-data-collector-output-"));
  const discovery = emptyDiscovery();
  discovery.sourceSha = sourceSha;
  const pool = emptyPool();
  pool.sourceSha = sourceSha;
  try {
    const envelope = await collectMaintenanceObservation({ root: process.cwd(), sourceSha, discoveryReceipts: discovery, poolReceipts: pool, rankingReceipts: emptyRankingReceipts(sourceSha), outputDir, config: discoveryConfig, rankingConfig });
    assert.equal(envelope.kind, "erpc-sdk-data-maintenance-observation");
    assert.ok(envelope.candidate);
    assert.deepEqual(Object.keys(envelope.rawArtifacts).sort(), ["discovery-receipts.json", "pool-receipts.json", "ranking-receipts.json"]);
    assert.deepEqual(readdirSync(outputDir).sort(), ["discovery-receipts.json", "maintenance-observation.json", "pool-receipts.json", "ranking-receipts.json"]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("discovered identities use a full hash and fixed sixteen-hex aliases", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const id = discoveredIdentity("token", "eip155:1", address);
  const alias = discoveredAlias("token", "eip155:1", address);
  assert.match(id, /^discovered-token-[0-9a-f]{64}$/u);
  assert.match(alias, /^DISCOVERED_[0-9A-F]{16}$/u);
});

test("admission keeps only a configured native pair above the hard liquidity floor", () => {
  const observation = makeObservation();
  const tokenAddress = tokenCatalog.deployments.find((entry) => entry.deploymentId === "deployment-0019").address;
  const poolAddress = "0x2222222222222222222222222222222222222222";
  const weth = tokenCatalog.deployments.find((entry) => entry.deploymentId === "deployment-0002").address;
  const blockHash = `0x${"ab".repeat(32)}`;
  const reserves = `${abiWord(100_000_000_000_000_000_000n)}${abiWord(200_000_000_000_000_000_000n).slice(2)}`;
  const factory = discoveryConfig.evm.factories[0];
  const discovery = structuredClone(observation.rawArtifacts["discovery-receipts.json"].json);
  discovery.receipts.push({
    kind: "evm-pair", network: "ethereum", status: "success", subjectId: `${factory.dexDeploymentId}:1`, dexDeploymentId: factory.dexDeploymentId, pairIndex: 1, address: poolAddress, tokens: [tokenAddress, weth], reserves: ["100000000000000000000", "200000000000000000000"], factory: factory.factory, blockNumber: "0x100", blockHash,
    request: { blockHash },
    raw: { allPairs: addressWord(poolAddress), pairFactory: addressWord(factory.factory), token0: addressWord(tokenAddress), token1: addressWord(weth), reserves, factoryPair: addressWord(poolAddress) },
  });
  let rpcId = 1;
  const pairTag = { blockHash, requireCanonical: true };
  const rpcEntry = (method, params, result) => ({
    network: "ethereum",
    endpointId: discoveryConfig.rpc.ethereum.endpointId,
    observedAt: "2026-09-16T00:00:00.000Z",
    request: { jsonrpc: "2.0", id: rpcId, method, params },
    response: { jsonrpc: "2.0", id: rpcId++, result },
  });
  discovery.rpcTranscript = [
    rpcEntry("eth_call", [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.allPairs}${abiWord(1).slice(2)}` }, pairTag], addressWord(poolAddress)),
    rpcEntry("eth_getCode", [poolAddress, pairTag], "0x6000"),
    rpcEntry("eth_call", [{ to: poolAddress, data: EVM_DISCOVERY_SELECTORS.pairFactory }, pairTag], addressWord(factory.factory)),
    rpcEntry("eth_call", [{ to: poolAddress, data: EVM_DISCOVERY_SELECTORS.pairToken0 }, pairTag], addressWord(tokenAddress)),
    rpcEntry("eth_call", [{ to: poolAddress, data: EVM_DISCOVERY_SELECTORS.pairToken1 }, pairTag], addressWord(weth)),
    rpcEntry("eth_call", [{ to: poolAddress, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, pairTag], reserves),
    rpcEntry("eth_call", [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.factoryGetPair}${tokenAddress.slice(2).padStart(64, "0")}${weth.slice(2).padStart(64, "0")}` }, pairTag], addressWord(poolAddress)),
  ];
  const promotedObservation = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: observation.rawArtifacts["ranking-receipts.json"].json,
    discoveryConfig,
    rankingConfig,
    discovery,
    pool: observation.rawArtifacts["pool-receipts.json"].json,
    execution: { origin: "local" },
  });
  assert.equal(Object.hasOwn(discovery.receipts.at(-1).raw, "pairCode"), false);
  // This test uses strict producer replay with the exact recorded getCode
  // request/result. The pool raw row intentionally has no invented pairCode.
  const candidate = replayMaintenanceObservation(promotedObservation, { root: process.cwd(), config: discoveryConfig, rankingConfig, testOnly: true, replayPool: () => [], replayRanking: (raw, { tokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog }) });
  assert.equal(candidate.tokenCandidates.length, 0);
  assert.equal(candidate.poolCandidates.length, 1);
  assert.equal(candidate.poolCandidates[0].quoteEligible, false);
  assert.equal(candidate.deferredCandidates.length, 0);
  assert.equal(candidate.discoveryState.tokenCatalogDigest, candidate.candidateDigests.tokenCatalogDigest);
  assert.equal(candidate.discoveryState.dexCatalogDigest, candidate.candidateDigests.dexCatalogDigest);

  const missingCode = structuredClone(discovery);
  missingCode.rpcTranscript = missingCode.rpcTranscript.filter((entry) => entry.request.method !== "eth_getCode");
  assert.throws(() => replayDiscoveryReceipts(missingCode, { sourceSha: SOURCE_SHA, config: discoveryConfig, tokenCatalog, dexCatalog }), /exact RPC transcript|raw result/u);
  const corruptCode = structuredClone(discovery);
  const codeEntry = corruptCode.rpcTranscript.find((entry) => entry.request.method === "eth_getCode");
  codeEntry.response.result = "0x";
  assert.throws(() => replayDiscoveryReceipts(corruptCode, { sourceSha: SOURCE_SHA, config: discoveryConfig, tokenCatalog, dexCatalog }), /exact RPC transcript|raw result/u);
});

test("requeues fresh cap-deferred pools and resumes from the persisted grown cursor", async () => {
  const ethereumFactory = discoveryConfig.evm.factories.find((entry) => entry.network === "ethereum");
  const avalancheFactory = discoveryConfig.evm.factories.find((entry) => entry.network === "avalancheC");
  const ethereum = qualifiedEvmDiscovery({ chainId: "eip155:1", network: "ethereum", factory: ethereumFactory, count: 5, startSeed: 1 });
  const avalanche = qualifiedEvmDiscovery({ chainId: "eip155:43114", network: "avalancheC", factory: avalancheFactory, count: 4, startSeed: 11 });
  const allProposals = [...ethereum.proposals, ...avalanche.proposals];
  const allReceipts = [...ethereum.receipts, ...avalanche.receipts];
  const firstObservation = makeObservation();
  const firstDiscovery = discoveryObservationWithReceipts(firstObservation, allReceipts);
  const firstState = admissionCursorState([
    { factory: ethereumFactory, count: ethereum.entries.length },
    { factory: avalancheFactory, count: avalanche.entries.length },
  ]);
  const replayOptions = {
    root: process.cwd(),
    config: discoveryConfig,
    rankingConfig,
    testOnly: true,
    replayDiscovery: () => ({ proposals: allProposals, state: structuredClone(firstState) }),
    replayPool: () => [],
    replayRanking: (raw, { tokenCatalog: candidateTokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: candidateTokenCatalog }),
  };
  const collected = await collectMaintenanceObservation({
    root: process.cwd(),
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    config: discoveryConfig,
    rankingConfig,
    discoveryCollector: async () => firstDiscovery,
    poolReceipts: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    rankingReceipts: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    ...replayOptions,
  });
  const firstCandidate = collected.candidate;
  assert.ok(firstCandidate);

  assert.equal(firstCandidate.poolCandidates.length, 8);
  assert.equal(firstCandidate.tokenCandidates.length, 8);
  assert.equal(firstCandidate.poolCandidates.filter((entry) => entry.pool.chainId === "eip155:1").length, 4);
  assert.equal(firstCandidate.poolCandidates.filter((entry) => entry.pool.chainId === "eip155:43114").length, 4);
  const deferred = firstCandidate.deferredCandidates.find((entry) => entry.reason === "pool-cap" && entry.proposal.kind === "pool");
  assert.ok(deferred);
  const deferredReceipt = allReceipts.find((row) => row.address === deferred.proposal.address && row.dexDeploymentId === deferred.proposal.dexDeploymentId);
  assert.ok(deferredReceipt);
  const deferredFactory = firstCandidate.discoveryState.factories[deferred.proposal.dexDeploymentId];
  assert.ok(deferredFactory.pendingIndexes.includes(deferredReceipt.pairIndex));
  assert.ok(!deferredFactory.completedIndexes.includes(deferredReceipt.pairIndex));
  assert.equal(firstCandidate.discoveryState.tokenCatalogDigest, firstCandidate.candidateDigests.tokenCatalogDigest);
  assert.equal(firstCandidate.discoveryState.dexCatalogDigest, firstCandidate.candidateDigests.dexCatalogDigest);

  const forgedProposal = { ...deferred.proposal, address: syntheticAddress(999, "2") };
  const forgedObservation = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog: firstCandidate.tokenCatalog,
    dexCatalog: firstCandidate.dexCatalog,
    baselineRanking: firstCandidate.rankingSnapshot,
    ranking: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery: discoveryObservationWithReceipts(firstObservation, [deferredReceipt]),
    pool: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
  const forgedCandidate = replayMaintenanceObservation(forgedObservation, {
    ...replayOptions,
    tokenCatalog: firstCandidate.tokenCatalog,
    dexCatalog: firstCandidate.dexCatalog,
    ranking: firstCandidate.rankingSnapshot,
    priorState: firstCandidate.discoveryState,
    replayDiscovery: () => ({ proposals: [forgedProposal], state: structuredClone(firstCandidate.discoveryState) }),
  });
  assert.equal(forgedCandidate.tokenCandidates.length, 0);
  assert.equal(forgedCandidate.poolCandidates.length, 0);
  assert.equal(forgedCandidate.candidateDigests.tokenCatalogDigest, firstCandidate.candidateDigests.tokenCatalogDigest);
  assert.equal(forgedCandidate.candidateDigests.dexCatalogDigest, firstCandidate.candidateDigests.dexCatalogDigest);
  assert.ok(!forgedCandidate.dexCatalog.poolDefinitions.some((entry) => entry.address === forgedProposal.address));

  const deferredToken = allProposals.find((proposal) => proposal.kind === "token" && proposal.address === deferred.proposal.tokens[0]);
  assert.ok(deferredToken);
  const secondObservation = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog: firstCandidate.tokenCatalog,
    dexCatalog: firstCandidate.dexCatalog,
    baselineRanking: firstCandidate.rankingSnapshot,
    ranking: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery: discoveryObservationWithReceipts(firstObservation, [deferredReceipt]),
    pool: firstObservation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
  const resumedState = structuredClone(firstCandidate.discoveryState);
  const resumedFactory = resumedState.factories[deferred.proposal.dexDeploymentId];
  resumedFactory.pendingIndexes = resumedFactory.pendingIndexes.filter((index) => index !== deferredReceipt.pairIndex);
  resumedFactory.completedIndexes = [...new Set([...resumedFactory.completedIndexes, deferredReceipt.pairIndex])].sort((left, right) => left - right);
  const secondCandidate = replayMaintenanceObservation(secondObservation, {
    ...replayOptions,
    tokenCatalog: firstCandidate.tokenCatalog,
    dexCatalog: firstCandidate.dexCatalog,
    ranking: firstCandidate.rankingSnapshot,
    priorState: firstCandidate.discoveryState,
    replayDiscovery: () => ({ proposals: [deferredToken, deferred.proposal], state: resumedState }),
  });

  assert.equal(secondCandidate.poolCandidates.length, 1);
  assert.equal(secondCandidate.tokenCandidates.length, 1);
  assert.equal(secondCandidate.deferredCandidates.length, 0);
  assert.ok(secondCandidate.tokenCatalog.deployments.some((entry) => entry.address === deferredToken.address));
  assert.ok(secondCandidate.dexCatalog.poolDefinitions.some((entry) => entry.address === deferred.proposal.address));
  for (const deployment of firstCandidate.tokenCatalog.deployments) assert.ok(secondCandidate.tokenCatalog.deployments.some((entry) => entry.deploymentId === deployment.deploymentId));
  for (const alias of firstCandidate.tokenCatalog.aliases) assert.ok(secondCandidate.tokenCatalog.aliases.some((entry) => entry.namespace === alias.namespace && entry.name === alias.name && entry.deploymentId === alias.deploymentId));
  for (const pool of firstCandidate.dexCatalog.poolDefinitions) assert.ok(secondCandidate.dexCatalog.poolDefinitions.some((entry) => entry.poolDefinitionId === pool.poolDefinitionId));
  for (const alias of firstCandidate.dexCatalog.aliases) assert.ok(secondCandidate.dexCatalog.aliases.some((entry) => entry.namespace === alias.namespace && entry.name === alias.name && entry.poolDefinitionId === alias.poolDefinitionId && entry.dexDeploymentId === alias.dexDeploymentId));
  const finalFactory = secondCandidate.discoveryState.factories[deferred.proposal.dexDeploymentId];
  assert.ok(!finalFactory.pendingIndexes.includes(deferredReceipt.pairIndex));
  assert.ok(finalFactory.completedIndexes.includes(deferredReceipt.pairIndex));
  assert.equal(secondCandidate.discoveryState.tokenCatalogDigest, secondCandidate.candidateDigests.tokenCatalogDigest);
  assert.equal(secondCandidate.discoveryState.dexCatalogDigest, secondCandidate.candidateDigests.dexCatalogDigest);
});

test("requeues a fresh Solana cap-deferred pool in both cursor aliases", () => {
  const solana = qualifiedSolanaDiscovery({ count: 9, startSeed: 1 });
  const observation = makeObservation();
  const state = emptyDiscoveryState();
  const programId = "dex-deployment-0003";
  const allPubkeys = solana.entries.map((entry) => entry.pool);
  state.programs[programId] = {
    partitionCursor: 0,
    pendingPubkeys: [],
    pendingQueue: [],
    completedPubkeys: [...allPubkeys].sort(),
    completePubkeySet: [...allPubkeys].sort(),
    lastContextSlot: 500_000_000,
  };
  const envelope = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery: discoveryObservationWithReceipts(observation, solana.receipts),
    pool: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
  const candidate = replayMaintenanceObservation(envelope, {
    root: process.cwd(),
    config: discoveryConfig,
    rankingConfig,
    testOnly: true,
    replayDiscovery: () => ({ proposals: solana.proposals, state: structuredClone(state) }),
    replayPool: () => [],
    replayRanking: (raw, { tokenCatalog: candidateTokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: candidateTokenCatalog }),
  });

  assert.equal(candidate.poolCandidates.length, 8);
  const deferred = candidate.deferredCandidates.find((entry) => entry.reason === "pool-cap" && entry.proposal.kind === "pool");
  assert.ok(deferred);
  const cursor = candidate.discoveryState.programs[programId];
  assert.ok(cursor.pendingPubkeys.includes(deferred.proposal.address));
  assert.deepEqual(cursor.pendingQueue, cursor.pendingPubkeys);
  assert.ok(!cursor.completedPubkeys.includes(deferred.proposal.address));
  assert.deepEqual(cursor.completePubkeySet, cursor.completedPubkeys);
  assert.equal(candidate.discoveryState.tokenCatalogDigest, candidate.candidateDigests.tokenCatalogDigest);
  assert.equal(candidate.discoveryState.dexCatalogDigest, candidate.candidateDigests.dexCatalogDigest);
});

test("admission selects highest native liquidity per chain before the pool cap", () => {
  const ethereumFactory = discoveryConfig.evm.factories.find((entry) => entry.network === "ethereum");
  const avalancheFactory = discoveryConfig.evm.factories.find((entry) => entry.network === "avalancheC");
  const ethereum = qualifiedEvmDiscovery({
    chainId: "eip155:1",
    network: "ethereum",
    factory: ethereumFactory,
    count: 5,
    startSeed: 31,
    nativeReserves: [100n, 90n, 80n, 70n, 70n].map((value) => (value * 1_000_000_000_000_000_000n).toString()),
  });
  const avalanche = qualifiedEvmDiscovery({
    chainId: "eip155:43114",
    network: "avalancheC",
    factory: avalancheFactory,
    count: 5,
    startSeed: 41,
    nativeReserves: [500n, 400n, 300n, 200n, 200n].map((value) => (value * 1_000_000_000_000_000_000n).toString()),
  });
  const allProposals = [...ethereum.proposals, ...avalanche.proposals];
  const allReceipts = [...ethereum.receipts, ...avalanche.receipts];
  const observation = makeObservation();
  const state = admissionCursorState([
    { factory: ethereumFactory, count: ethereum.entries.length },
    { factory: avalancheFactory, count: avalanche.entries.length },
  ]);
  const envelope = observationEnvelope({
    sourceSha: SOURCE_SHA,
    sourceTreeSha: TREE_SHA,
    baseSha: SOURCE_SHA,
    tokenCatalog,
    dexCatalog,
    baselineRanking: ranking,
    ranking: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.ranking].json,
    discoveryConfig,
    rankingConfig,
    discovery: discoveryObservationWithReceipts(observation, allReceipts),
    pool: observation.rawArtifacts[DATA_ARTIFACT_FILENAMES.pool].json,
    execution: { origin: "local" },
  });
  const candidate = replayMaintenanceObservation(envelope, {
    root: process.cwd(),
    config: discoveryConfig,
    rankingConfig,
    testOnly: true,
    replayDiscovery: () => ({ proposals: allProposals, state: structuredClone(state) }),
    replayPool: () => [],
    replayRanking: (raw, { tokenCatalog: candidateTokenCatalog }) => replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { tokenCatalog: candidateTokenCatalog }),
  });
  const expectedSelected = (dataset) => {
    const rows = new Map(dataset.entries.map((entry) => [entry.poolAddress, entry.row]));
    return dataset.proposals.filter((proposal) => proposal.kind === "pool").sort((left, right) => {
      const leftLiquidity = BigInt(rows.get(left.address).reserves[1]);
      const rightLiquidity = BigInt(rows.get(right.address).reserves[1]);
      if (leftLiquidity !== rightLiquidity) return leftLiquidity > rightLiquidity ? -1 : 1;
      return left.canonical.poolDefinitionId.localeCompare(right.canonical.poolDefinitionId);
    }).slice(0, 4).map((proposal) => proposal.address);
  };
  const selectedEthereum = candidate.poolCandidates.filter((entry) => entry.pool.chainId === "eip155:1").map((entry) => entry.pool.address);
  const selectedAvalanche = candidate.poolCandidates.filter((entry) => entry.pool.chainId === "eip155:43114").map((entry) => entry.pool.address);
  assert.equal(selectedEthereum.length, 4);
  assert.equal(selectedAvalanche.length, 4);
  assert.deepEqual(new Set(selectedEthereum), new Set(expectedSelected(ethereum)));
  assert.deepEqual(new Set(selectedAvalanche), new Set(expectedSelected(avalanche)));
  assert.equal(candidate.deferredCandidates.filter((entry) => entry.reason === "pool-cap" && entry.proposal.kind === "pool").length, 2);
});

test("Solana qualification reads full u128 liquidity and ignores summary flags", () => {
  const solana = qualifiedSolanaDiscovery({ count: 1, startSeed: 101, liquidity: 0n, liquidityHigh: 1n, summaryLiquidity: "0", summaryVaultFrozen: [true, true] });
  const candidate = replaySolanaQualification(solana);
  assert.equal(candidate.poolCandidates.length, 1);
  assert.equal(candidate.deferredCandidates.length, 0);
});

test("Solana qualification rejects a raw frozen vault even when its summary is clear", () => {
  const solana = qualifiedSolanaDiscovery({ count: 1, startSeed: 111, frozenVaultIndex: 0, summaryVaultFrozen: [false, false] });
  const candidate = replaySolanaQualification(solana);
  assert.equal(candidate.poolCandidates.length, 0);
  assert.ok(candidate.deferredCandidates.some((entry) => entry.reason === "below-native-liquidity-floor"));
});

test("Solana qualification rejects a raw Raydium swap-disabled bit even when its summary is clear", () => {
  const solana = qualifiedSolanaDiscovery({ count: 1, startSeed: 121, dexDeploymentId: "dex-deployment-0004", status: 16, summaryStatus: 0 });
  const candidate = replaySolanaQualification(solana);
  assert.equal(candidate.poolCandidates.length, 0);
  assert.ok(candidate.deferredCandidates.some((entry) => entry.reason === "below-native-liquidity-floor"));
});

test("managed PR, exact CI, and merge controller complete a mocked positive flow", async () => {
  const base = makeObservation();
  const candidate = replayMaintenanceObservation(base, { root: process.cwd(), config: discoveryConfig, rankingConfig });
  const headSha = "3".repeat(40);
  const treeSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const repository = "owner/repo";
  const calls = [];
  let main = candidate.baseSha;
  const changedSubset = await expectedCandidateChangedPaths(candidate, { root: process.cwd() });
  const writerObservation = structuredClone(base);
  writerObservation.execution = { origin: "workflow_dispatch", githubRunId: 10, githubRunAttempt: 1 };
  const adapter = {
    async getMainSha() { calls.push("main"); return main; },
    async getBranch() { return null; },
    async commitFiles(input) { calls.push(["commit", input.expectedOldSha]); return { sha: headSha, tree: { sha: treeSha } }; },
    async getChangedPaths() { return changedSubset; },
    async getBranchFiles() { return candidate.files; },
    async listPullRequests() { return []; },
    async createPullRequest(input) { calls.push("pr"); return { number: 7, ...input }; },
    async dispatchWorkflow(input) { calls.push("dispatch"); return { id: 19, ...input }; },
    async verifyWorkflowRunHead() { return { id: 19, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch" }; },
    async getMergePolicy() { return { protected: true, strict: true, upToDate: true, actorAllowed: true, requiredChecks: ["required-ci"] }; },
    async mergePullRequest() { calls.push("merge"); main = mergeSha; return { sha: mergeSha }; },
    async getCommit(commitSha) { calls.push("commit-read"); return commitSha === headSha ? { sha: headSha, tree: { sha: treeSha } } : { sha: mergeSha, parents: [{ sha: candidate.baseSha }, { sha: headSha }], tree: { sha: treeSha } }; },
  };
  const written = await (await import("./data-promotion.mjs")).writeDataMaintenancePr({ candidate, observation: writerObservation, adapter, repo: repository, apply: true });
  assert.equal(written.status, "CREATED");
  assert.equal(written.payload.headSha, headSha);
  const mergeCandidate = { ...candidate, headSha, expectedTree: treeSha };
  const pr = { number: 7, state: "open", managedBy: "erpc-sdk-data-maintenance", metadata: { managedBy: "erpc-sdk-data-maintenance", sourceSha: candidate.sourceSha, baseSha: candidate.baseSha, outputDigest: candidate.outputDigest, contentDigest: candidate.outputDigest, semanticFingerprint: candidate.semanticFingerprint, outputPaths: CANDIDATE_OUTPUT_PATHS }, head: { ref: "codex/registry-maintenance", sha: headSha, repo: { full_name: repository } }, base: { ref: "main", sha: candidate.baseSha, repo: { full_name: repository } } };
  pr.metadata.contentDigest = candidate.outputDigest;
  const run = { id: 19, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, base_sha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] };
  const provenance = { headSha, baseSha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", runId: 19, runAttempt: 1 };
  const promotionObservation = structuredClone(base);
  promotionObservation.execution = { origin: "workflow_dispatch", githubRunId: 11, githubRunAttempt: 1 };
  const preview = await (await import("./data-promotion.mjs")).promoteDataCandidate({ candidate: mergeCandidate, observation: promotionObservation, pr, run, provenance, adapter, repo: repository, apply: false });
  assert.equal(preview.status, "DRY_RUN");
  assert.equal(preview.eligible, true);
  const promoted = await (await import("./data-promotion.mjs")).promoteDataCandidate({ candidate: mergeCandidate, observation: promotionObservation, pr, run, provenance, adapter, repo: repository, apply: true, expectedHead: headSha, baseSha: candidate.baseSha });
  assert.equal(promoted.status, "MERGED");
  assert.equal(promoted.mergeSha, mergeSha);
  assert.ok(calls.includes("dispatch"));
  assert.ok(calls.indexOf("commit-read") < calls.indexOf("merge"));
});

test("rank-only promotion accepts the actual six-file Git diff", async () => {
  const candidate = replayMaintenanceObservation(makeObservation(), { root: process.cwd(), config: discoveryConfig, rankingConfig });
  assert.equal(candidate.changes.tokenCatalog, false);
  assert.equal(candidate.changes.dexCatalog, false);
  assert.equal(candidate.changes.ranking, true);
  assert.equal(candidate.discoveryState.tokenCatalogDigest, candidate.candidateDigests.tokenCatalogDigest);
  assert.equal(candidate.discoveryState.dexCatalogDigest, candidate.candidateDigests.dexCatalogDigest);
  const snapshotRoot = mkdtempSync(join(tmpdir(), "erpc-data-rank-only-"));
  const writeSnapshotFile = (pathValue, content) => {
    const target = join(snapshotRoot, pathValue);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const runGit = (args) => execFileSync("git", args, { cwd: snapshotRoot, encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: snapshotRoot });
    runGit(["config", "user.email", "rank-only@example.invalid"]);
    runGit(["config", "user.name", "rank-only fixture"]);
    for (const [pathValue, content] of Object.entries(candidate.files)) writeSnapshotFile(pathValue, content);
    const baseRankingFiles = {
      "registry/token-rankings.json": `${JSON.stringify(ranking, null, 2)}\n`,
      ...Object.fromEntries(Object.entries(RANKING_OUTPUTS).map(([language, pathValue]) => [pathValue, renderRankingLanguage(language, ranking, { tokenCatalog })])),
    };
    for (const [pathValue, content] of Object.entries(baseRankingFiles)) writeSnapshotFile(pathValue, content);
    runGit(["add", "."]); runGit(["commit", "--quiet", "-m", "base"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);
    const baseTreeSha = runGit(["rev-parse", "HEAD^{tree}"]);
    for (const [pathValue, content] of Object.entries(candidate.files)) writeSnapshotFile(pathValue, content);
    runGit(["add", "."]); runGit(["commit", "--quiet", "-m", "rankings"]);
    const headSha = runGit(["rev-parse", "HEAD"]);
    const actualChanged = runGit(["diff", "--name-only", `${baseSha}..${headSha}`]).split(/\r?\n/u).filter(Boolean).sort();
    const expectedRankOnly = ["registry/token-rankings.json", ...Object.values(RANKING_OUTPUTS)].sort();
    assert.deepEqual(actualChanged, expectedRankOnly);
    // Promotion replays against the frozen base checkout.  Keep this
    // controlled worktree at that exact tree while the adapter exposes the
    // separate managed PR head below.
    execFileSync("git", ["checkout", baseSha, "--", "."], { cwd: snapshotRoot });
    const baseFiles = Object.fromEntries(CANDIDATE_OUTPUT_PATHS.map((pathValue) => [pathValue, readFileSync(join(snapshotRoot, pathValue), "utf8")]));
    // The base map is captured from the committed base tree before the head
    // write; rank-only changes therefore exercise the same bytes that a real
    // GitHub compare endpoint reports.
    for (const pathValue of expectedRankOnly) baseFiles[pathValue] = baseRankingFiles[pathValue];
    const promotionDiscovery = emptyDiscovery();
    promotionDiscovery.sourceSha = baseSha;
    const promotionPool = emptyPool();
    promotionPool.sourceSha = baseSha;
    const promotionRanking = emptyRankingReceipts(baseSha);
    const promotionObservation = observationEnvelope({ sourceSha: baseSha, sourceTreeSha: baseTreeSha, baseSha, tokenCatalog, dexCatalog, baselineRanking: ranking, ranking: promotionRanking, discoveryConfig, rankingConfig, discovery: promotionDiscovery, pool: promotionPool, execution: { origin: "workflow_dispatch", githubRunId: 12, githubRunAttempt: 1 } });
    const promotedCandidate = replayMaintenanceObservation(promotionObservation, { root: snapshotRoot, config: discoveryConfig, rankingConfig });
    assert.equal(promotedCandidate.rankingDigest, candidate.rankingDigest);
    const pr = {
      number: 42,
      state: "open",
      managedBy: "erpc-sdk-data-maintenance",
      metadata: { managedBy: "erpc-sdk-data-maintenance", sourceSha: promotedCandidate.sourceSha, baseSha, outputDigest: promotedCandidate.outputDigest, contentDigest: promotedCandidate.outputDigest, semanticFingerprint: promotedCandidate.semanticFingerprint, outputPaths: CANDIDATE_OUTPUT_PATHS },
      head: { ref: "codex/registry-maintenance", sha: headSha, repo: { full_name: "owner/repo" } },
      base: { ref: "main", sha: baseSha, repo: { full_name: "owner/repo" } },
    };
    const run = { id: 77, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, base_sha: baseSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] };
    const provenance = { headSha, baseSha, workflowPath: ".github/workflows/ci.yml", runId: 77, runAttempt: 1 };
    const adapter = {
      async getBaseFiles() { return baseFiles; },
      async getChangedPaths() { return actualChanged; },
      async getBranchFiles() { return candidate.files; },
      async getMergePolicy() { return { protected: true, strict: true, upToDate: true, actorAllowed: true, requiredChecks: ["required-ci"] }; },
    };
    const report = await (await import("./data-promotion.mjs")).promoteDataCandidate({ candidate: promotedCandidate, observation: promotionObservation, pr, run, provenance, adapter, repo: "owner/repo", root: snapshotRoot, expectedHead: headSha, baseSha, apply: false });
    assert.equal(report.status, "DRY_RUN");
    assert.equal(report.eligible, true);
    assert.deepEqual(report.changedPaths, expectedRankOnly);
    assert.deepEqual(report.expectedChangedPaths, expectedRankOnly);
  } finally { rmSync(snapshotRoot, { recursive: true, force: true }); }
});

test("promotion refuses missing exact-check helpers and a main race before merge", async () => {
  const candidate = replayMaintenanceObservation(makeObservation(), { root: process.cwd(), config: discoveryConfig, rankingConfig });
  const headSha = "a".repeat(40);
  const pr = {
    number: 43,
    state: "open",
    managedBy: "erpc-sdk-data-maintenance",
    metadata: { managedBy: "erpc-sdk-data-maintenance", sourceSha: candidate.sourceSha, baseSha: candidate.baseSha, outputDigest: candidate.outputDigest, contentDigest: candidate.outputDigest, semanticFingerprint: candidate.semanticFingerprint, outputPaths: CANDIDATE_OUTPUT_PATHS },
    head: { ref: "codex/registry-maintenance", sha: headSha, repo: { full_name: "owner/repo" } },
    base: { ref: "main", sha: candidate.baseSha, repo: { full_name: "owner/repo" } },
  };
  const run = { id: 78, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, base_sha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] };
  const provenance = { headSha, baseSha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", runId: 78, runAttempt: 1 };
  await assert.rejects(() => (async () => {
    const module = await import("./data-promotion.mjs");
    return module.promoteDataCandidate({ candidate: { ...candidate, headSha }, pr, run, provenance, adapter: {}, repo: "owner/repo", expectedHead: headSha, baseSha: candidate.baseSha, apply: false });
  })(), /exact PR diff and branch file checks/u);
  const changedSubset = await expectedCandidateChangedPaths({ ...candidate, headSha }, { root: process.cwd() });
  const promotionObservation = structuredClone(makeObservation());
  promotionObservation.execution = { origin: "workflow_dispatch", githubRunId: 13, githubRunAttempt: 1 };
  let mainReads = 0;
  let mergeCalls = 0;
  const adapter = {
    async getChangedPaths() { return changedSubset; },
    async getBranchFiles() { return candidate.files; },
    async getMergePolicy() { return { protected: true, strict: true, upToDate: true, actorAllowed: true, requiredChecks: ["required-ci"] }; },
    async getMainSha() { return mainReads++ === 0 ? candidate.baseSha : "f".repeat(40); },
    async getCommit() { return { sha: headSha, tree: { sha: "b".repeat(40) } }; },
    async mergePullRequest() { mergeCalls += 1; return { sha: "c".repeat(40) }; },
  };
  await assert.rejects(() => (async () => {
    const module = await import("./data-promotion.mjs");
    return module.promoteDataCandidate({ candidate: { ...candidate, headSha }, observation: promotionObservation, pr, run, provenance, adapter, repo: "owner/repo", expectedHead: headSha, baseSha: candidate.baseSha, apply: true });
  })(), /main moved/u);
  assert.equal(mergeCalls, 0);
});

test("source tree reads are mandatory and option mismatches fail closed", () => {
  const observation = makeObservation();
  assert.throws(() => replayMaintenanceObservation({ ...observation, sourceTreeSha: "0".repeat(40) }, { root: process.cwd(), config: discoveryConfig, rankingConfig }), /sourceTreeSha/u);
  assert.throws(() => replayMaintenanceObservation(observation, { root: process.cwd(), sourceTreeSha: "0".repeat(40), config: discoveryConfig, rankingConfig }), /sourceTreeSha/u);
});

test("workflow collection derives a strict GitHub origin from the environment", () => {
  const environment = { GITHUB_ACTIONS: "true", GITHUB_SHA: SOURCE_SHA, GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "3", GITHUB_EVENT_NAME: "workflow_dispatch" };
  assert.deepEqual(executionFromEnvironment({ sourceSha: SOURCE_SHA }, environment), { origin: "workflow_dispatch", githubRunId: 101, githubRunAttempt: 3 });
  assert.throws(() => executionFromEnvironment({ sourceSha: "f".repeat(40) }, environment), /GITHUB_SHA/u);
  assert.throws(() => executionFromEnvironment({ sourceSha: SOURCE_SHA }, { ...environment, GITHUB_EVENT_NAME: "push" }), /schedule or workflow_dispatch/u);
});

test("promote CLI treats --report as output and blocks missing authenticated artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "erpc-data-cli-"));
  const reportPath = join(directory, "promotion-report.json");
  const applyReportPath = join(directory, "promotion-apply-report.json");
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const stub = join(directory, "gh");
  writeFileSync(stub, `#!/usr/bin/env node
const path = process.argv[3] ?? "";
if (path.endsWith("/actions/runs/1")) process.stdout.write(JSON.stringify({ id: 1, run_attempt: 1, head_sha: "${headSha}", head_branch: "codex/registry-maintenance", ref: "refs/heads/codex/registry-maintenance", event: "workflow_dispatch", path: ".github/workflows/ci.yml", repository: { full_name: "owner/repo" } }));
else if (path.includes("/actions/runs/1/jobs")) process.stdout.write(JSON.stringify({ jobs: [] }));
else if (path.includes("/actions/runs/1/artifacts")) process.stdout.write(JSON.stringify({ artifacts: [] }));
else process.stdout.write(JSON.stringify({}));
`);
  chmodSync(stub, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${directory}:${oldPath}`;
  const args = ["promote", "--pr", "1", "--ci-run-id", "1", "--ci-run-attempt", "1", "--expected-head", headSha, "--base-sha", baseSha, "--repo", "owner/repo", "--root", directory, "--report", reportPath];
  try {
    const result = await run(args);
    assert.equal(result.status, "BLOCKED");
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).status, "BLOCKED");
    await assert.rejects(() => run(args), /already exists/u);
    await assert.rejects(() => run([...args.slice(0, -1), applyReportPath, "--apply"]), { code: "CI_ARTIFACT_MISSING" });
  } finally {
    process.env.PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("merge controller rejects a spoofed repository or non-exact merge parents", async () => {
  const candidate = replayMaintenanceObservation(makeObservation(), { root: process.cwd(), config: discoveryConfig, rankingConfig });
  const headSha = "6".repeat(40);
  const treeSha = "7".repeat(40);
  const run = { id: 21, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, base_sha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", jobs: [{ name: "required-ci", conclusion: "success" }] };
  const provenance = { headSha, baseSha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", runId: 21, runAttempt: 1 };
  const pr = { number: 8, state: "open", managedBy: "erpc-sdk-data-maintenance", metadata: { managedBy: "erpc-sdk-data-maintenance", sourceSha: candidate.sourceSha, baseSha: candidate.baseSha, outputDigest: candidate.outputDigest, contentDigest: candidate.outputDigest, semanticFingerprint: candidate.semanticFingerprint, outputPaths: CANDIDATE_OUTPUT_PATHS }, head: { ref: "codex/registry-maintenance", sha: headSha, repo: { full_name: "owner/repo" } }, base: { ref: "main", sha: candidate.baseSha, repo: { full_name: "attacker/repo" } } };
  await assert.rejects(() => (async () => {
    const module = await import("./data-promotion.mjs");
    return module.promoteDataCandidate({ candidate: { ...candidate, headSha, expectedTree: treeSha }, pr, run, provenance, adapter: {}, repo: "owner/repo", apply: false });
  })(), /same repository/u);
  await assert.rejects(() => verifyMergedCandidate({ mergeSha: "8".repeat(40), expectedBase: candidate.baseSha, expectedHead: headSha, expectedTree: treeSha, mergeCommit: { sha: "8".repeat(40), parents: [{ sha: candidate.baseSha }, { sha: "9".repeat(40) }], tree: { sha: treeSha } } }), /exact base and managed head/u);
  const goodRun = { id: 31, run_attempt: 1, status: "completed", conclusion: "success", head_sha: headSha, base_sha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", jobs: [{ name: "required-ci", status: "completed", conclusion: "success" }] };
  const goodProvenance = { headSha, baseSha: candidate.baseSha, workflowPath: ".github/workflows/ci.yml", runId: 31, runAttempt: 1 };
  assert.throws(() => verifyDataCi({ candidate: { ...candidate, headSha }, run: { ...goodRun, status: "in_progress", conclusion: null }, provenance: goodProvenance }), /completed successfully/u);
  assert.throws(() => verifyDataCi({ candidate: { ...candidate, headSha }, run: goodRun, provenance: goodProvenance, expectedRunId: 32 }), /run ID/u);
});
