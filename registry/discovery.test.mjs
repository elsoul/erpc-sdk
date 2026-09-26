import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_DISCOVERY_CONFIG,
  DISCOVERY_CHAINS,
  EVM_DISCOVERY_SELECTORS,
  SOLANA_DISCOVERY_LAYOUTS,
  TOKEN_CHAIN_IDS,
  deriveDiscoveredId,
  deriveDiscoveredAlias,
  deriveSolanaPoolPda,
  decodeBase58,
  discoverCatalog,
  replayDiscoveryReceipts,
  validateDiscoveryArtifacts,
  validateDiscoveryConfig,
} from "./discovery.mjs";

function clone(value) { return structuredClone(value); }
function word(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function addressWord(value) { return `0x${value.replace(/^0x/iu, "").padStart(64, "0")}`; }
function account(data, owner) { return { owner, executable: false, lamports: 1, rentEpoch: 0, data: [Buffer.from(data).toString("base64"), "base64"] }; }

function fakeRpc({ batchedSolana = false, solanaPoolCount = null, evmPairCount = 1, failEvmPairIndex = null, failSolanaPoolIndex = null, delayEvmAllPairsMs = 0, hangEvmAllPairsIndex = null, evmBlockTimestamp = "0x65000000" } = {}) {
  const calls = [];
  const pairByNetwork = { ethereum: "0x1111111111111111111111111111111111111111", avalancheC: "0x2222222222222222222222222222222222222222" };
  const tokensByNetwork = {
    ethereum: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    avalancheC: ["0xcccccccccccccccccccccccccccccccccccccc", "0xdddddddddddddddddddddddddddddddddddddd"],
  };
  const blockByNetwork = { ethereum: "0x" + "aa".repeat(32), avalancheC: "0x" + "bb".repeat(32) };
  const solanaAccounts = new Map();
  const poolAccounts = new Map();
  const programEntries = [];
  for (const [programIndex, [protocol, program]] of [
    ["orca-whirlpool", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
    ["raydium-clmm", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"],
  ].entries()) {
    const layout = SOLANA_DISCOVERY_LAYOUTS[protocol];
    const poolCount = protocol === "orca-whirlpool" && Number.isSafeInteger(solanaPoolCount) ? solanaPoolCount : batchedSolana && protocol === "orca-whirlpool" ? 2 : 1;
    for (let poolIndex = 0; poolIndex < poolCount; poolIndex += 1) {
      const index = programIndex * 3 + poolIndex;
      const pool = Uint8Array.from({ length: layout.dataSize }, (_, byte) => (byte + index + 1) & 255);
      pool.set(Buffer.from(layout.discriminator, "hex"), 0);
      const sharedMint = batchedSolana && protocol === "orca-whirlpool" && poolIndex === 1;
      const identityBytes = (prefix, seed) => Uint8Array.from({ length: 32 }, (_, byte) => byte === 0 ? prefix : byte === 1 ? seed & 255 : prefix);
      const mintBytes = [identityBytes(11, sharedMint ? 0 : index), identityBytes(31, index)];
      const vaultBytes = [identityBytes(51, index), identityBytes(71, index)];
      const configBytes = identityBytes(91, index);
      pool.set(mintBytes[0], layout.mintOffsets[0]);
      pool.set(mintBytes[1], layout.mintOffsets[1]);
      pool.set(vaultBytes[0], layout.vaultOffsets[0]);
      pool.set(vaultBytes[1], layout.vaultOffsets[1]);
      pool.set(configBytes, layout.configOffset);
      if (protocol === "raydium-clmm") { pool[391] = 0; pool[392] = 0; pool[389] = 0; }
      const mintAddresses = mintBytes.map((bytes) => Buffer.from(bytes).toString("hex")).map((hex) => {
      const bytes = Buffer.from(hex, "hex");
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let digits = [0];
      for (const byte of bytes) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = digits[i] * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } }
      let leading = 0; while (leading < bytes.length && bytes[leading] === 0) leading += 1;
      return "1".repeat(leading) + digits.reverse().map((digit) => alphabet[digit]).join("");
      });
      const vaultAddresses = vaultBytes.map((bytes) => {
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let digits = [0]; for (const byte of bytes) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = digits[i] * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } }
      return digits.reverse().map((digit) => alphabet[digit]).join("");
      });
      const configAddress = (() => {
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let digits = [0]; for (const byte of configBytes) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = digits[i] * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } } return digits.reverse().map((digit) => alphabet[digit]).join("");
      })();
      const poolAddress = deriveSolanaPoolPda(program, pool, DEFAULT_DISCOVERY_CONFIG.solana.programs[programIndex].layout.pda);
      poolAccounts.set(poolAddress, account(pool, program));
      solanaAccounts.set(configAddress, account(Buffer.from([1, 2, 3]), program));
      for (let mintIndex = 0; mintIndex < mintAddresses.length; mintIndex += 1) {
        const mint = Buffer.alloc(82); mint.writeBigUInt64LE(1_000n + BigInt(mintIndex), 36); mint[44] = 6; mint[45] = 1;
        solanaAccounts.set(mintAddresses[mintIndex], account(mint, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
        const vault = Buffer.alloc(165); Buffer.from(mintBytes[mintIndex]).copy(vault, 0); Buffer.from(decodeBase58(poolAddress)).copy(vault, 32); vault.writeBigUInt64LE(100n, 64); vault[108] = 1;
        solanaAccounts.set(vaultAddresses[mintIndex], account(vault, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
      }
      programEntries.push({ protocol, program, poolAddress, account: poolAccounts.get(poolAddress), context: { slot: 447257740 }, mintAddresses, vaultAddresses, configAddress });
    }
  }
  const failSolanaPoolAddress = failSolanaPoolIndex === null ? null : programEntries.filter((entry) => entry.protocol === "orca-whirlpool")[failSolanaPoolIndex]?.poolAddress ?? null;
  const rpc = async (network, method, params) => {
    calls.push({ network, method, params });
    if (network === "solana") {
      if (method === "getGenesisHash") return DEFAULT_DISCOVERY_CONFIG.rpc.solana.expectedGenesisHash;
      if (method === "getSlot") return 447257740;
      if (method === "getProgramAccounts") {
        const entries = programEntries.filter((candidate) => candidate.program === params[0]);
        return { context: { slot: 447257740 }, value: entries.map((entry) => ({ pubkey: entry.poolAddress, account: entry.account })) };
      }
      if (method === "getMultipleAccounts") {
        const pubkeys = params[0];
        return { context: { slot: 447257741 }, value: pubkeys.map((pubkey) => {
          const value = poolAccounts.get(pubkey) ?? solanaAccounts.get(pubkey) ?? null;
          return pubkey === failSolanaPoolAddress && value ? { ...value, owner: "11111111111111111111111111111111" } : value;
        }) };
      }
      throw Object.assign(new Error("unexpected Solana method"), { code: "RPC_ERROR" });
    }
    const chain = network === "ethereum" ? "0x1" : "0xa86a";
    if (method === "eth_chainId") return chain;
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: blockByNetwork[network], timestamp: evmBlockTimestamp };
    if (method === "eth_getCode") return "0x60006000";
    if (method !== "eth_call") throw Object.assign(new Error("unexpected EVM method"), { code: "RPC_ERROR" });
    const data = params[0].data;
    if (data === EVM_DISCOVERY_SELECTORS.allPairsLength) return word(evmPairCount);
    if (data.startsWith(EVM_DISCOVERY_SELECTORS.allPairs)) {
      const pairIndex = Number(BigInt(`0x${data.slice(EVM_DISCOVERY_SELECTORS.allPairs.length)}`));
      if (pairIndex === hangEvmAllPairsIndex) await new Promise(() => {});
      if (delayEvmAllPairsMs > 0) await new Promise((resolve) => setTimeout(resolve, delayEvmAllPairsMs));
      if (pairIndex === failEvmPairIndex) throw Object.assign(new Error("temporarily unavailable"), { code: "RPC_UPSTREAM_ERROR" });
      return addressWord(pairByNetwork[network]);
    }
    if (data === EVM_DISCOVERY_SELECTORS.pairFactory) return addressWord(network === "ethereum" ? "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f" : "0x9ad6c38be94206ca50bb0d90783181662f0cfa10");
    if (data === EVM_DISCOVERY_SELECTORS.pairToken0) return addressWord(tokensByNetwork[network][0]);
    if (data === EVM_DISCOVERY_SELECTORS.pairToken1) return addressWord(tokensByNetwork[network][1]);
    if (data === EVM_DISCOVERY_SELECTORS.pairGetReserves) return `${word(100)}${word(200).slice(2)}`;
    if (data.startsWith(EVM_DISCOVERY_SELECTORS.factoryGetPair)) return addressWord(pairByNetwork[network]);
    if (data === EVM_DISCOVERY_SELECTORS.tokenDecimals) return word(6);
    if (data === EVM_DISCOVERY_SELECTORS.tokenTotalSupply) return word(1_000_000);
    if (data === EVM_DISCOVERY_SELECTORS.tokenSymbol) return `0x${"0".repeat(128)}`;
    throw Object.assign(new Error("unknown selector"), { code: "RPC_ERROR" });
  };
  rpc.calls = calls;
  return rpc;
}

test("discovery config and deterministic address-only IDs are stable", async () => {
  assert.equal(validateDiscoveryConfig(DEFAULT_DISCOVERY_CONFIG), true);
  assert.deepEqual(DISCOVERY_CHAINS, {
    ethereum: TOKEN_CHAIN_IDS.ethereum,
    avalancheC: TOKEN_CHAIN_IDS.avalancheC,
    solana: TOKEN_CHAIN_IDS.solana,
  });
  assert.equal(Object.hasOwn(DISCOVERY_CHAINS, "base"), false);
  assert.equal(DEFAULT_DISCOVERY_CONFIG.limits.maxAdmissionTokens, 8);
  assert.equal(DEFAULT_DISCOVERY_CONFIG.limits.maxAdmissionPools, 8);
  assert.equal(DEFAULT_DISCOVERY_CONFIG.admission.tokenPolicy, "qualified-pool-dependencies");
  assert.equal(deriveDiscoveredId("token", TOKEN_CHAIN_IDS.ethereum, "0xABC"), deriveDiscoveredId("token", TOKEN_CHAIN_IDS.ethereum, "0xabc"));
  assert.match(deriveDiscoveredId("token", TOKEN_CHAIN_IDS.ethereum, "0xabc"), /^discovered-token-[0-9a-f]{64}$/u);
  assert.match(deriveDiscoveredAlias("token", TOKEN_CHAIN_IDS.ethereum, "0xabc"), /^DISCOVERED_[0-9A-F]{16}$/u);
  assert.match(deriveDiscoveredAlias("pool", TOKEN_CHAIN_IDS.solana, "PoolAddress", "dex-deployment-0003"), /^DISCOVERED_POOL_[0-9A-F]{16}$/u);
  const fixture = JSON.parse(await readFile(new URL("./fixtures/discovery-cases.json", import.meta.url), "utf8"));
  assert.ok(fixture.cases.some((entry) => entry.caseId === "evm-unknown-tail-pair"));
});

test("bounded replay discovers unknown EVM tokens and pools without trusting symbol", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const rpc = fakeRpc();
  const artifacts = await discoverCatalog({ config, rpcClient: rpc, sourceSha: "a".repeat(40), workspace: { clean: true, pinned: true }, clock: { now: 1694498816000, sleep: async () => {} } });
  assert.ok(artifacts.proposals.proposals.some((entry) => entry.kind === "token"));
  assert.ok(artifacts.proposals.proposals.some((entry) => entry.kind === "pool"));
  assert.ok(artifacts.proposals.proposals.every((entry) => entry.canonical.symbol === entry.address || entry.kind === "pool"));
  assert.ok(artifacts.proposals.proposals.every((entry) => entry.alias.startsWith("DISCOVERED_")));
  assert.equal(artifacts.receipts.coverage.claim, "bounded");
  validateDiscoveryArtifacts(artifacts, { config });
  const replay = replayDiscoveryReceipts(artifacts.receipts, { config, sourceSha: "a".repeat(40) });
  assert.deepEqual(replay, artifacts.proposals.proposals);
});

test("batched Solana pool replay binds each account index and keeps shared-token evidence deterministic", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/discovery-rpc.json", import.meta.url), "utf8"));
  assert.equal(fixture.replayContracts.solanaProgramBatch.poolAccountBatch, true);
  assert.equal(fixture.replayContracts.solanaProgramBatch.relatedAccountBatch, true);
  assert.equal(fixture.replayContracts.solanaProgramBatch.sharedUnknownMint, true);
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const artifacts = await discoverCatalog({ config, rpcClient: fakeRpc({ batchedSolana: true }), sourceSha: "d".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const solanaRows = artifacts.receipts.receipts.filter((row) => row.kind === "solana-program" && row.status === "success" && row.address);
  const orcaRows = solanaRows.filter((row) => row.dexDeploymentId === "dex-deployment-0003");
  assert.equal(orcaRows.length, 2);
  assert.ok(orcaRows.every((row) => row.request.poolAccountAddresses.length === 2 && row.request.poolAccountAddresses[row.request.poolAccountIndex] === row.address));
  assert.ok(orcaRows.every((row) => row.request.relatedAccountBindings.length === 5 && row.request.relatedAccountBindings.every((binding) => binding.addresses[binding.index] === binding.address && Number.isSafeInteger(binding.contextSlot))));
  const sharedMint = orcaRows[0].mints[0];
  assert.equal(orcaRows[1].mints[0], sharedMint);
  const sharedProposals = artifacts.proposals.proposals.filter((proposal) => proposal.kind === "token" && proposal.address === sharedMint);
  assert.equal(sharedProposals.length, 1);
  assert.equal(sharedProposals[0].evidence[0].pool, orcaRows[0].address);
  const replay = replayDiscoveryReceipts(artifacts.receipts, { config, sourceSha: artifacts.receipts.sourceSha });
  assert.deepEqual(replay, artifacts.proposals.proposals);
});

test("dirty live evidence is never promotable and wrong identity is isolated", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  let first = true;
  const rpc = async (network, method, params) => {
    const value = await fakeRpc()(network, method, params);
    if (network === "avalancheC" && method === "eth_chainId") return "0x1";
    if (network === "ethereum" && method === "eth_getBlockByNumber" && first) { first = false; return { number: "0x100", hash: "0x" + "cc".repeat(32), timestamp: "0x65000000" }; }
    return value;
  };
  const artifacts = await discoverCatalog({ config, rpcClient: rpc, sourceSha: "b".repeat(40), workspace: { clean: false, pinned: true }, liveEvidence: true, clock: { now: 1694498816000, sleep: async () => {} } });
  assert.equal(artifacts.receipts.workspace.promotable, false);
  assert.ok(artifacts.receipts.receipts.some((entry) => entry.status === "failed" || entry.code === "NETWORK_IDENTITY_MISMATCH"));
});

test("replay binds every success to its exact transcript request and derives cursors", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const artifacts = await discoverCatalog({ config, rpcClient: fakeRpc(), sourceSha: "c".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const forgedTranscript = clone(artifacts.receipts);
  forgedTranscript.rpcTranscript.forEach((entry) => { entry.request.method = "getHealth"; entry.request.params = []; });
  assert.throws(() => replayDiscoveryReceipts(forgedTranscript, { config, sourceSha: forgedTranscript.sourceSha }), /exact RPC|transcript/u);
  const forgedState = clone(artifacts.receipts);
  forgedState.state.factories["dex-deployment-0001"].backfillNext = forgedState.state.factories["dex-deployment-0001"].count;
  const replay = replayDiscoveryReceipts(forgedState, { config, sourceSha: forgedState.sourceSha });
  assert.notEqual(replay.state.factories["dex-deployment-0001"].backfillNext, forgedState.state.factories["dex-deployment-0001"].count);
});

test("failed EVM backfill indexes rotate while remaining in the retry queue", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const first = await discoverCatalog({ config, rpcClient: fakeRpc({ evmPairCount: 3, failEvmPairIndex: 0 }), sourceSha: "e".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const firstCursor = first.state.factories["dex-deployment-0001"];
  assert.equal(firstCursor.backfillNext, 1);
  assert.ok(firstCursor.pendingIndexes.includes(0));
  assert.ok(!firstCursor.completedIndexes.includes(0));
  const second = await discoverCatalog({ config, state: first.state, rpcClient: fakeRpc({ evmPairCount: 3, failEvmPairIndex: 0 }), sourceSha: "e".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const secondCursor = second.state.factories["dex-deployment-0001"];
  assert.equal(secondCursor.backfillNext, 2);
  assert.ok(secondCursor.pendingIndexes.includes(0));
  assert.ok(secondCursor.completedIndexes.includes(1));
});

test("forged EVM scanned failures require an exact pinned allPairs request", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const artifact = await discoverCatalog({ config, rpcClient: fakeRpc({ evmPairCount: 3, failEvmPairIndex: 0 }), sourceSha: "a".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const forged = clone(artifact.receipts);
  const factory = forged.receipts.find((row) => row.kind === "evm-factory" && row.dexDeploymentId === "dex-deployment-0001");
  factory.scannedIndexes.push(2);
  factory.failedIndexes.push(2);
  assert.throws(() => replayDiscoveryReceipts(forged, { config, sourceSha: forged.sourceSha }), /allPairs|exact|cursor/u);
});

test("partial known-token metadata failures return the verified replay proposal set", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const knownToken = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const addressWord = (value) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
  const base = fakeRpc();
  const rpc = async (network, method, params) => {
    if (network === "ethereum" && method === "eth_getCode" && params[0] === knownToken) throw Object.assign(new Error("metadata unavailable"), { code: "RPC_UNAVAILABLE" });
    if (network === "ethereum" && method === "eth_call" && params[0]?.data === EVM_DISCOVERY_SELECTORS.pairToken0) return addressWord(knownToken);
    return base(network, method, params);
  };
  const artifacts = await discoverCatalog({ config, rpcClient: rpc, sourceSha: "e".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  assert.equal(artifacts.receipts.status, "partial");
  const replayed = replayDiscoveryReceipts(artifacts.receipts, { config, sourceSha: artifacts.receipts.sourceSha });
  assert.deepEqual(artifacts.proposals.proposals, replayed);
  assert.ok(artifacts.proposals.proposals.some((proposal) => proposal.kind === "pool" && proposal.token0Address === knownToken));
  assert.ok(!artifacts.proposals.proposals.some((proposal) => proposal.kind === "token" && proposal.address === knownToken));
});

test("budget exhaustion claims only recorded EVM allPairs attempts and keeps queued work", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  config.limits.maxConcurrentRequests = 1;
  config.limits.runBudgetMs = 1500;
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 2; factory.pairScan.maxPairsPerRun = 3; }
  const started = Date.now();
  const clock = { now: () => started + (Date.now() - started), sleep: async () => {} };
  const artifacts = await discoverCatalog({ config, rpcClient: fakeRpc({ evmPairCount: 3, hangEvmAllPairsIndex: 1, evmBlockTimestamp: `0x${Math.floor(started / 1000).toString(16)}` }), runBudgetMs: 1500, sourceSha: "d".repeat(40), clock, workspace: { clean: true, pinned: true } });
  const factoryReceipt = artifacts.receipts.receipts.find((row) => row.kind === "evm-factory" && row.dexDeploymentId === "dex-deployment-0001");
  assert.deepEqual(factoryReceipt.scannedIndexes, [0]);
  assert.deepEqual(factoryReceipt.failedIndexes, [0]);
  assert.ok(factoryReceipt.scannedIndexes.every((index) => artifacts.receipts.rpcTranscript.some((entry) => entry.network === "ethereum" && entry.request.method === "eth_call" && entry.request.params[0].data === `${EVM_DISCOVERY_SELECTORS.allPairs}${index.toString(16).padStart(64, "0")}`)));
  assert.equal(artifacts.state.factories["dex-deployment-0001"].backfillNext, 1);
  assert.ok(artifacts.receipts.receipts.some((row) => row.kind === "evm-pair" && row.status === "skipped" && row.code === "UNATTEMPTED_BUDGET"));
  assert.doesNotThrow(() => replayDiscoveryReceipts(artifacts.receipts, { config, sourceSha: artifacts.receipts.sourceSha }));
});

test("failed Solana keys rotate with later GPA partitions while retaining retry evidence", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const firstRpc = fakeRpc({ batchedSolana: true, failSolanaPoolIndex: 0 });
  const first = await discoverCatalog({ config, rpcClient: firstRpc, sourceSha: "f".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const firstProgram = first.state.programs["dex-deployment-0003"];
  assert.equal(firstProgram.partitionCursor, 1);
  assert.equal(firstProgram.pendingPubkeys.length, 1);
  const failedAddress = firstProgram.pendingPubkeys[0];
  assert.ok(failedAddress);
  const secondRpc = fakeRpc({ batchedSolana: true, failSolanaPoolIndex: 0 });
  const second = await discoverCatalog({ config, state: first.state, rpcClient: secondRpc, sourceSha: "f".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const secondProgram = second.state.programs["dex-deployment-0003"];
  assert.equal(secondProgram.partitionCursor, 2);
  assert.deepEqual(secondProgram.pendingPubkeys, [failedAddress]);
  assert.ok(secondRpc.calls.some((call) => call.network === "solana" && call.method === "getProgramAccounts"));
});

test("Solana replay preserves every GPA key beyond the account batch and rotates mixed failures", async () => {
  const config = clone(DEFAULT_DISCOVERY_CONFIG);
  config.limits.maxMultipleAccounts = 2;
  for (const factory of config.evm.factories) { factory.pairScan.tail = 1; factory.pairScan.backfill = 1; factory.pairScan.maxPairsPerRun = 1; }
  const completeRpc = fakeRpc({ solanaPoolCount: 5 });
  const complete = await discoverCatalog({ config, rpcClient: completeRpc, sourceSha: "b".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const completeProgram = complete.state.programs["dex-deployment-0003"];
  const completePartition = complete.receipts.receipts.find((row) => row.dexDeploymentId === "dex-deployment-0003" && row.queue === "gpa");
  assert.equal(completePartition.gpaPubkeys.length, 5);
  assert.equal(completeProgram.completedPubkeys.length, 2);
  assert.deepEqual(completeProgram.pendingPubkeys, completePartition.gpaPubkeys.slice(2));

  const mixed = await discoverCatalog({ config, rpcClient: fakeRpc({ solanaPoolCount: 5, failSolanaPoolIndex: 0 }), sourceSha: "c".repeat(40), clock: { now: 1694498816000, sleep: async () => {} }, workspace: { clean: true, pinned: true } });
  const mixedProgram = mixed.state.programs["dex-deployment-0003"];
  const mixedPartition = mixed.receipts.receipts.find((row) => row.dexDeploymentId === "dex-deployment-0003" && row.queue === "gpa");
  assert.equal(mixedProgram.completedPubkeys.length, 1);
  assert.equal(mixedProgram.pendingPubkeys.length, 4);
  assert.deepEqual(mixedProgram.pendingPubkeys.slice(0, 3), mixedPartition.gpaPubkeys.slice(2));
  assert.equal(mixedProgram.pendingPubkeys[3], mixedPartition.gpaPubkeys[0]);
});

test("Token-2022 framing rejects malformed records and accepts bounded close-authority framing", async () => {
  const { decodeSolanaMintAccount, validToken2022Framing } = await import("./discovery.mjs");
  const short = Buffer.alloc(83); short[45] = 1; short[82] = 1;
  assert.equal(validToken2022Framing(short, 82, 1), false);
  const close = Buffer.alloc(202); close[45] = 1; close[165] = 1; close.writeUInt16LE(3, 166); close.writeUInt16LE(32, 168);
  assert.equal(validToken2022Framing(close, 82, 1), true);
  const zeroLengthLegal = Buffer.alloc(170); zeroLengthLegal[45] = 1; zeroLengthLegal[165] = 1; zeroLengthLegal.writeUInt16LE(42, 166); zeroLengthLegal.writeUInt16LE(0, 168);
  assert.equal(validToken2022Framing(zeroLengthLegal, 82, 1), true);
  const truncated = Buffer.alloc(171); truncated[45] = 1; truncated[165] = 1; truncated.writeUInt16LE(42, 166); truncated.writeUInt16LE(2, 168); truncated[170] = 1;
  assert.equal(validToken2022Framing(truncated, 82, 1), false);
  const valid = Buffer.alloc(166); valid[45] = 1; valid[165] = 1;
  assert.equal(validToken2022Framing(valid, 82, 1), true);
  assert.throws(() => decodeSolanaMintAccount("1".repeat(32), { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", lamports: 1, executable: false, data: [short.toString("base64"), "base64"] }, ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]));
});

test("standalone mint scan remains disabled at the CLI boundary", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./discover-catalog.mjs", import.meta.url)), "--discover-mints"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option --discover-mints/u);
});
