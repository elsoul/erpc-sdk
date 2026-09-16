/* Read-only online health for the four configured DEX deployments. */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import dexCatalog from "./dex-catalog.json" with { type: "json" };
import {
  TOKEN_CHAIN_IDS,
  TOKEN_PROGRAM_IDS,
  createBoundedRpcClient,
  computeDiscoveryConfigDigest,
  decodeBase58,
  encodeBase58,
  EVM_DISCOVERY_SELECTORS,
  SOLANA_DISCOVERY_LAYOUTS,
  verifySolanaPoolPda,
  DEFAULT_DISCOVERY_CONFIG,
  validateDiscoveryConfig,
  validToken2022Framing,
  transcriptResultEquals,
  transcriptMultipleAccountMatches,
} from "./discovery.mjs";
import { computeDigest as computeTokenDigest, normalizeAddress as normalizeTokenAddress, validateCatalog as validateTokenCatalog } from "./token-catalog.mjs";
import { computeDigest as computeDexDigest, validateCatalog as validateDexCatalog } from "./dex-catalog.mjs";

export const POOL_OBSERVER_SCHEMA_VERSION = 1;
export const POOL_OBSERVER_ARTIFACT_FILENAMES = Object.freeze({ observations: "pool-observations.json", receipts: "pool-receipts.json" });
export const POOL_HEALTH_STATUSES = Object.freeze([
  "healthy",
  "empty",
  "swap-disabled",
  "missing",
  "identity-mismatch",
  "stale",
  "unreachable",
]);
export const POOL_ERROR_CODES = Object.freeze([
  "POOL_NOT_CONFIGURED",
  "NETWORK_IDENTITY_MISMATCH",
  "SOLANA_GENESIS_MISMATCH",
  "SOLANA_SLOT_INVALID",
  "SOLANA_BLOCK_TIME_INVALID",
  "SOLANA_CONTEXT_BELOW_ANCHOR",
  "POOL_ACCOUNT_MISSING",
  "SOLANA_ACCOUNT_INVALID",
  "SOLANA_CONFIG_INVALID",
  "TOKEN_BINDING_INVALID",
  "POOL_TOKEN_BINDING_MISMATCH",
  "POOL_IDENTITY_MISMATCH",
  "FINALIZED_REORG",
  "EVM_CODE_MISSING",
  "IDENTITY_MISMATCH",
  "STALE",
  "UNATTEMPTED_ROTATION",
  "UNATTEMPTED_BUDGET",
  "RPC_UNAVAILABLE",
  "RPC_TIMEOUT",
  "RPC_RUN_BUDGET_EXCEEDED",
  "RPC_RATE_LIMITED",
  "RPC_UPSTREAM_ERROR",
  "RPC_INVALID_JSON",
  "RPC_RESULT_INVALID",
  "RPC_BODY_LIMIT",
  "RPC_ERROR",
]);
export const POOL_OBSERVER_LIMITS = Object.freeze({
  runBudgetMs: 60_000,
  maxConcurrentRequests: 4,
  maxMultipleAccounts: 64,
});

const EVM_CHAINS = new Set([TOKEN_CHAIN_IDS.ethereum, TOKEN_CHAIN_IDS.avalancheC]);
const SOLANA_CHAIN = TOKEN_CHAIN_IDS.solana;
const NETWORK_BY_CHAIN = Object.freeze({ [TOKEN_CHAIN_IDS.ethereum]: "ethereum", [TOKEN_CHAIN_IDS.avalancheC]: "avalancheC", [TOKEN_CHAIN_IDS.solana]: "solana" });
const HEX_BYTES = /^0x[0-9a-f]*$/iu;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/iu;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/iu;
const FINALIZED_AGE_LIMIT_SECONDS = Object.freeze({ ethereum: 1800, avalancheC: 120 });
const FINALIZED_FUTURE_SKEW_SECONDS = 90;
// A finalized slot and the account contexts used for one observation should
// come from the same short read window.  This fixed bound prevents a forged
// transcript from pairing a current block time with an arbitrarily old/new
// account snapshot while allowing normal RPC propagation between calls.
const SOLANA_CONTEXT_MAX_SPREAD_SLOTS = 2048;
const POOL_ERROR_CODE_SET = new Set(POOL_ERROR_CODES);
const RPC_ERROR_CODE_SET = new Set([
  "RPC_UNAVAILABLE",
  "RPC_TIMEOUT",
  "RPC_RUN_BUDGET_EXCEEDED",
  "RPC_RATE_LIMITED",
  "RPC_UPSTREAM_ERROR",
  "RPC_INVALID_JSON",
  "RPC_RESULT_INVALID",
  "RPC_BODY_LIMIT",
  "RPC_ERROR",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  const normalize = (entry) => Array.isArray(entry) ? entry.map(normalize) : isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])])) : entry;
  return JSON.stringify(normalize(value));
}

function transcriptCallMatches(transcript, network, method, params, result) {
  return transcript.some((entry) => entry?.network === network && entry.request?.method === method && stableStringify(entry.request?.params) === stableStringify(params) && transcriptResultEquals(entry.response?.result, result));
}

function transcriptBlockMatches(transcript, network, params, row) {
  return transcript.some((entry) => {
    if (entry?.network !== network || entry.request?.method !== "eth_getBlockByNumber" || stableStringify(entry.request?.params) !== stableStringify(params)) return false;
    const value = entry.response?.result;
    if (!isRecord(value) || (value.hash ?? value.blockHash)?.toLowerCase() !== String(row.blockHash).toLowerCase() || value.number !== row.blockNumber) return false;
    if (row.blockTimestamp === undefined) return true;
    try { return typeof value.timestamp === "string" && BigInt(value.timestamp) === BigInt(row.blockTimestamp); } catch { return false; }
  });
}

function blockTag(hash) {
  return { blockHash: hash, requireCanonical: true };
}

function errorCode(error) {
  return fixedErrorCode(typeof error?.code === "string" ? error.code : "RPC_UNAVAILABLE");
}

function fixedErrorCode(value) {
  if (typeof value === "string" && POOL_ERROR_CODE_SET.has(value)) return value;
  // Preserve only the fixed RPC class in a replay artifact.  Numeric JSON-RPC
  // codes and upstream messages are deliberately never copied into evidence.
  return RPC_ERROR_CODE_SET.has(value) ? value : "RPC_ERROR";
}

function transcriptErrorCode(entry) {
  const value = entry?.response?.error;
  if (!isRecord(value)) return null;
  return fixedErrorCode(value.code ?? value.data?.code);
}

function networkEntries(transcript, network) {
  return transcript.filter((entry) => entry?.network === network);
}

function scopeTranscript(transcript, row) {
  const ids = row?.request?.transcriptIds;
  const network = NETWORK_BY_CHAIN[row?.chainId];
  const endpointId = row?.request?.transcriptEndpointId;
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  return transcript.filter((entry) => {
    if (network && entry?.network !== network) return false;
    if (endpointId !== undefined && entry?.endpointId !== endpointId) return false;
    return wanted === null || wanted.has(entry?.request?.id);
  });
}

function captureSeconds(artifact, transcript) {
  const observed = transcript.map((entry) => typeof entry?.observedAt === "string" ? Date.parse(entry.observedAt) / 1000 : NaN).filter((value) => Number.isFinite(value));
  const valid = observed.length > 0 ? observed : [typeof artifact?.capturedAt === "string" ? Date.parse(artifact.capturedAt) / 1000 : NaN].filter((value) => Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function assertReplayAnchorFresh(anchor, network, artifact, transcript, config) {
  const captured = captureSeconds(artifact, transcript);
  if (captured === null) throw new Error("pool capture clock is missing");
  assertAnchorFresh(anchor, network, { clock: { now: captured * 1000 }, freshness: config.freshness });
}

function solanaBlockTime(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function assertSolanaBlockTimeFresh(value, clock, config) {
  const blockTime = solanaBlockTime(value);
  if (blockTime === null) throw Object.assign(new Error("Solana block time is missing or invalid"), { code: "SOLANA_BLOCK_TIME_INVALID" });
  const age = BigInt(nowSeconds(clock)) - BigInt(blockTime);
  const maxAge = BigInt(config.freshness?.solana?.maxSlotAgeSeconds ?? 120);
  const futureSkew = BigInt(config.freshness?.solana?.maxFutureSkewSeconds ?? 90);
  if (age > maxAge || age < -futureSkew) throw Object.assign(new Error("Solana block time is stale"), { code: "STALE" });
  return blockTime;
}

function assertSolanaContextCoherent(slot, lowerBound, finalizedSlot) {
  if (!Number.isSafeInteger(slot) || slot < lowerBound || slot > finalizedSlot + SOLANA_CONTEXT_MAX_SPREAD_SLOTS) throw Object.assign(new Error("Solana account context is not coherent with the finalized slot"), { code: "SOLANA_CONTEXT_BELOW_ANCHOR" });
  return slot;
}

function transcriptMultipleAccountEntry(transcript, { network = "solana", addresses, commitment = "finalized" }) {
  if (!Array.isArray(addresses)) return null;
  return transcript.find((entry) => entry?.network === network && entry.request?.method === "getMultipleAccounts" && stableStringify(entry.request?.params?.[0]) === stableStringify(addresses) && entry.request?.params?.[1]?.commitment === commitment && isRecord(entry.response?.result) && isRecord(entry.response.result.context) && Array.isArray(entry.response.result.value) && entry.response.result.value.length === addresses.length);
}

function expectedPoolTasks(dexCatalogValue) {
  const tasks = [];
  for (const dex of [...dexCatalogValue.dexDeployments].sort((left, right) => left.dexDeploymentId.localeCompare(right.dexDeploymentId))) {
    const pools = dexCatalogValue.poolDefinitions.filter((entry) => entry.dexDeploymentId === dex.dexDeploymentId && entry.status !== "retired").sort((left, right) => left.poolDefinitionId.localeCompare(right.poolDefinitionId));
    if (pools.length === 0) tasks.push(`${dex.dexDeploymentId}\u0000`);
    else for (const pool of pools) tasks.push(`${dex.dexDeploymentId}\u0000${pool.poolDefinitionId}`);
  }
  return tasks;
}

function rowTaskKey(row) {
  return `${row?.dexDeploymentId ?? ""}\u0000${row?.poolDefinitionId ?? ""}`;
}

function validateCoverageEnvelope(artifact, rows, dexCatalogValue) {
  const expected = expectedPoolTasks(dexCatalogValue);
  const expectedSet = new Set(expected);
  const actual = rows.map(rowTaskKey);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((key) => !expectedSet.has(key)) || expected.some((key) => !actual.includes(key))) throw new Error("pool receipt coverage is not the complete canonical active-pool set");
  const coverage = artifact.coverage;
  const unattemptedRows = rows.filter((row) => ["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode));
  if (!isRecord(coverage) || coverage.mode !== "bounded" || coverage.claim !== "bounded" || !Number.isSafeInteger(coverage.poolCount) || coverage.poolCount !== rows.length || !Number.isSafeInteger(coverage.attemptedPoolCount) || !Number.isSafeInteger(coverage.unattemptedPoolCount) || coverage.attemptedPoolCount < 0 || coverage.unattemptedPoolCount < 0 || coverage.attemptedPoolCount + coverage.unattemptedPoolCount !== rows.length || coverage.unattemptedPoolCount !== unattemptedRows.length || coverage.attemptedPoolCount !== rows.length - unattemptedRows.length || !Number.isSafeInteger(coverage.cursor) || coverage.cursor < 0 || coverage.cursor >= Math.max(1, expected.length)) throw new Error("pool receipt coverage envelope is invalid");
  if (unattemptedRows.some((row) => row.status !== "missing" || row.unattempted !== true || !["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode))) throw new Error("unattempted pool receipt is not explicitly marked as bounded coverage");
  if (rows.some((row) => row.errorCode === "NOT_OBSERVED")) throw new Error("NOT_OBSERVED is not a valid raw pool receipt state");
}

function hasRpcError(transcript, network) {
  return networkEntries(transcript, network).map(transcriptErrorCode).find((code) => code !== null) ?? null;
}

function responseResult(transcript, network, method, predicate = () => true) {
  return transcript.find((entry) => entry?.network === network && entry.request?.method === method && Object.hasOwn(entry.response ?? {}, "result") && predicate(entry.response.result));
}

function deriveEvmNonOperationalStatus(row, transcript, config, artifact, tokenCatalogValue = tokenCatalog, dexCatalogValue = dexCatalog) {
  const network = NETWORK_BY_CHAIN[row.chainId];
  const entries = networkEntries(transcript, network);
  if (entries.length === 0) throw new Error("pool receipt has no network transcript");
  const rpcCode = hasRpcError(transcript, network);
  if (rpcCode !== null) return rpcCode === "RPC_RUN_BUDGET_EXCEEDED" ? "missing" : "unreachable";
  const chain = responseResult(transcript, network, "eth_chainId");
  if (!chain || String(chain.response.result).toLowerCase() !== expectedRpcChain(network)) return "identity-mismatch";
  const headers = entries.filter((entry) => entry.request?.method === "eth_getBlockByNumber" && Object.hasOwn(entry.response ?? {}, "result"));
  const finalized = headers.find((entry) => entry.request?.params?.[0] === "finalized");
  if (!finalized) throw new Error("pool receipt is missing the finalized block response");
  const anchor = blockHeader(finalized.response.result);
  try { assertReplayAnchorFresh(anchor, network, artifact, transcript, config); } catch { return "stale"; }
  const reread = headers.find((entry) => entry.request?.params?.[0] === row.blockNumber);
  if (reread) {
    try {
      const value = blockHeader(reread.response.result);
      if (value.hash !== anchor.hash || value.number !== anchor.number) return "stale";
    } catch { return "stale"; }
  }
  const poolCode = responseResult(transcript, network, "eth_getCode", (value) => typeof value === "string" && value.length > 2 && row.poolAddress && true);
  if (poolCode && (poolCode.response.result === "0x" || poolCode.response.result === "0x0")) return "missing";
  const codeValues = entries.filter((entry) => entry.request?.method === "eth_getCode").map((entry) => entry.response?.result);
  if (codeValues.some((value) => typeof value === "string" && /^0x$/iu.test(value))) return "missing";
  const pool = row.poolDefinitionId ? dexCatalogValue.poolDefinitions.find((entry) => entry.poolDefinitionId === row.poolDefinitionId) : null;
  const dex = pool ? dexCatalogValue.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId) : null;
  const token0 = pool ? tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId) : null;
  const token1 = pool ? tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId) : null;
  if (pool && dex && token0?.address && token1?.address) {
    const expectedCalls = new Map([
      [`${dex.programAddress.toLowerCase()}\u0000${EVM_DISCOVERY_SELECTORS.factoryGetPair}${token0.address.slice(2).toLowerCase().padStart(64, "0")}${token1.address.slice(2).toLowerCase().padStart(64, "0")}`, pool.address.toLowerCase()],
      [`${pool.address.toLowerCase()}\u0000${EVM_DISCOVERY_SELECTORS.pairFactory}`, dex.programAddress.toLowerCase()],
      [`${pool.address.toLowerCase()}\u0000${EVM_DISCOVERY_SELECTORS.pairToken0}`, token0.address.toLowerCase()],
      [`${pool.address.toLowerCase()}\u0000${EVM_DISCOVERY_SELECTORS.pairToken1}`, token1.address.toLowerCase()],
    ]);
    for (const entry of entries.filter((candidate) => candidate.request?.method === "eth_call" && Object.hasOwn(candidate.response ?? {}, "result"))) {
      const call = entry.request.params?.[0];
      const key = `${call?.to?.toLowerCase?.() ?? ""}\u0000${typeof call?.data === "string" ? call.data.toLowerCase() : ""}`;
      const expected = expectedCalls.get(key);
      if (!expected) continue;
      try { if (wordAddress(entry.response.result) !== expected) return "identity-mismatch"; } catch { return "identity-mismatch"; }
    }
    const tag = blockTag(row.blockHash ?? anchor.hash);
    const reserveEntry = entries.find((entry) => entry.request?.method === "eth_call" && stableStringify(entry.request?.params) === stableStringify([{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, tag]) && Object.hasOwn(entry.response ?? {}, "result"));
    if (!reserveEntry) throw new Error("pool receipt is missing the exact reserves response");
    try {
      const reserves = [wordQuantity(reserveEntry.response.result, 0), wordQuantity(reserveEntry.response.result, 1)];
      return reserves[0] === 0n && reserves[1] === 0n ? "empty" : reserves[0] === 0n || reserves[1] === 0n ? "swap-disabled" : "healthy";
    } catch { return "identity-mismatch"; }
  }
  // A complete successful transcript without row raw evidence describes an
  // operational result, never an outage or a baseline placeholder.
  return "healthy";
}

function deriveSolanaNonOperationalStatus(row, transcript, config, artifact, tokenCatalogValue = tokenCatalog, dexCatalogValue = dexCatalog) {
  const network = "solana";
  const entries = networkEntries(transcript, network);
  if (entries.length === 0) throw new Error("pool receipt has no Solana transcript");
  const rpcCode = hasRpcError(transcript, network);
  if (rpcCode !== null) return rpcCode === "RPC_RUN_BUDGET_EXCEEDED" ? "missing" : "unreachable";
  const expectedGenesis = config.rpc.solana.expectedGenesisHash ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const genesis = responseResult(transcript, network, "getGenesisHash");
  if (!genesis || genesis.response.result !== expectedGenesis) return "identity-mismatch";
  const slotEntry = entries.find((entry) => entry.request?.method === "getSlot" && Object.hasOwn(entry.response ?? {}, "result"));
  if (!slotEntry) throw new Error("pool receipt is missing the finalized Solana slot response");
  const slotValue = typeof slotEntry.response.result === "number" ? slotEntry.response.result : typeof slotEntry.response.result === "string" && /^\d+$/u.test(slotEntry.response.result) ? Number(slotEntry.response.result) : NaN;
  if (!Number.isSafeInteger(slotValue) || slotValue < Number(config.solana.anchor.minContextSlot)) return "stale";
  if (!isRecord(row.request) || !Number.isSafeInteger(row.request.blockTimeSlot)) return "stale";
  const blockTimeSlot = row.request.blockTimeSlot;
  if (blockTimeSlot !== Math.max(Number(config.solana.anchor.minContextSlot), slotValue)) return "stale";
  const blockTimeEntry = entries.find((entry) => entry.request?.method === "getBlockTime" && stableStringify(entry.request?.params) === stableStringify([blockTimeSlot]) && Object.hasOwn(entry.response ?? {}, "result"));
  const blockTimeValue = blockTimeEntry ? solanaBlockTime(blockTimeEntry.response.result) : null;
  if (blockTimeValue === null) return "stale";
  const capture = captureSeconds(artifact, transcript);
  if (capture === null) throw new Error("Solana block-time capture clock is missing");
  try { assertSolanaBlockTimeFresh(blockTimeValue, { now: capture * 1000 }, config); } catch { return "stale"; }
  if (row.blockTime !== undefined && row.blockTime !== blockTimeValue) throw new Error("pool receipt block time does not match exact RPC response");
  const pool = row.poolDefinitionId ? dexCatalogValue.poolDefinitions.find((entry) => entry.poolDefinitionId === row.poolDefinitionId) : null;
  const dex = pool ? dexCatalogValue.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId) : null;
  const program = row.dexDeploymentId ? config.solana.programs.find((entry) => entry.dexDeploymentId === row.dexDeploymentId) : null;
  if (!pool || !dex || !program || row.poolAddress !== pool.address || !row.poolAddress) return "identity-mismatch";
  const layout = { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol] ?? {}, ...program.layout };
  const poolAddresses = Array.isArray(row.request.poolAccountAddresses) && row.request.poolAccountAddresses.length > 0 ? row.request.poolAccountAddresses : [row.poolAddress];
  const poolIndex = Number.isSafeInteger(row.request?.poolAccountIndex) ? row.request.poolAccountIndex : poolAddresses.indexOf(row.poolAddress);
  const poolEntry = transcriptMultipleAccountEntry(transcript, { addresses: poolAddresses });
  if (!poolEntry || poolIndex < 0 || poolIndex >= poolAddresses.length) throw new Error("pool receipt is missing the exact Solana pool account response");
  const poolResult = poolEntry.response?.result;
  const minContextSlot = Number.isSafeInteger(row.request.minContextSlot) ? row.request.minContextSlot : config.solana.anchor.minContextSlot;
  if (!isRecord(poolResult) || !isRecord(poolResult.context) || !Number.isSafeInteger(poolResult.context.slot)) return "stale";
  try { assertSolanaContextCoherent(poolResult.context.slot, Math.max(minContextSlot, blockTimeSlot), blockTimeSlot); } catch { return "stale"; }
  if (!Array.isArray(poolResult.value) || poolResult.value.length !== poolAddresses.length) return "identity-mismatch";
  const poolAccount = poolResult.value[poolIndex];
  if (poolAccount === null || poolAccount === undefined) return "missing";
  let parsed;
  try { parsed = solanaPoolData({ ...poolAccount, __pubkey: row.poolAddress }, { ...program, program: dex.programAddress }, layout); } catch { return "identity-mismatch"; }
  const token0 = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId);
  const token1 = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId);
  if (!token0?.address || !token1?.address || parsed.mints[0] !== token0.address || parsed.mints[1] !== token1.address) return "identity-mismatch";
  const relatedAddresses = [parsed.mints[0], parsed.mints[1], parsed.vaults[0], parsed.vaults[1], parsed.config];
  const relatedEntry = transcriptMultipleAccountEntry(transcript, { addresses: relatedAddresses });
  if (!relatedEntry) throw new Error("pool receipt is missing the exact Solana related account response");
  const relatedResult = relatedEntry.response?.result;
  if (!isRecord(relatedResult) || !isRecord(relatedResult.context) || !Number.isSafeInteger(relatedResult.context.slot)) return "stale";
  try { assertSolanaContextCoherent(relatedResult.context.slot, poolResult.context.slot, blockTimeSlot); } catch { return "stale"; }
  if (!Array.isArray(relatedResult.value) || relatedResult.value.length !== relatedAddresses.length || relatedResult.value.some((entry) => !entry)) return "identity-mismatch";
  try {
    const mint0 = parseMint(relatedResult.value[0], config.solana.mintPrograms);
    const mint1 = parseMint(relatedResult.value[1], config.solana.mintPrograms);
    const vault0 = parseVault(relatedResult.value[2], config.solana.mintPrograms, parsed.mints[0], row.poolAddress, relatedResult.value[0].owner);
    const vault1 = parseVault(relatedResult.value[3], config.solana.mintPrograms, parsed.mints[1], row.poolAddress, relatedResult.value[1].owner);
    if (relatedResult.value[4].owner !== dex.programAddress || !accountData(relatedResult.value[4])?.length) return "identity-mismatch";
    const hasLiquidity = parsed.liquidity === null ? vault0.amount !== "0" && vault1.amount !== "0" : BigInt(parsed.liquidity) > 0n;
    const swapDisabled = parsed.statusByte !== null && (parsed.statusByte & (layout.swapDisabledMask ?? 0)) !== 0;
    return vault0.amount === "0" && vault1.amount === "0" && !hasLiquidity ? "empty" : vault0.amount === "0" || vault1.amount === "0" || !hasLiquidity || swapDisabled || vault0.frozen || vault1.frozen ? "swap-disabled" : "healthy";
  } catch { return "identity-mismatch"; }
}

function assertNonOperationalEvidence(row, transcript, config, artifact, tokenCatalogValue = tokenCatalog, dexCatalogValue = dexCatalog) {
  const derived = EVM_CHAINS.has(row.chainId)
    ? deriveEvmNonOperationalStatus(row, transcript, config, artifact, tokenCatalogValue, dexCatalogValue)
    : deriveSolanaNonOperationalStatus(row, transcript, config, artifact, tokenCatalogValue, dexCatalogValue);
  if (derived !== row.status) throw new Error(`pool receipt status is not derived from RPC evidence (${row.status} versus ${derived})`);
  if (["missing", "identity-mismatch", "stale", "unreachable"].includes(derived) && (typeof row.errorCode !== "string" || !POOL_ERROR_CODE_SET.has(row.errorCode))) throw new Error("pool receipt error code is not fixed and allowlisted");
  if (derived === "unreachable") {
    const network = NETWORK_BY_CHAIN[row.chainId];
    const code = hasRpcError(transcript, network);
    if (code === null || (row.errorCode !== code && !(RPC_ERROR_CODE_SET.has(row.errorCode) && row.errorCode === "RPC_ERROR"))) throw new Error("unreachable pool receipt is not bound to its exact RPC error");
  }
}

function validateTranscript(transcript) {
  if (!Array.isArray(transcript)) throw new Error("pool RPC transcript is required");
  const seen = new Set();
  for (const entry of transcript) {
    if (!isRecord(entry) || !["ethereum", "avalancheC", "solana"].includes(entry.network) || !isRecord(entry.request) || !isRecord(entry.response) || typeof entry.observedAt !== "string" || !Number.isFinite(Date.parse(entry.observedAt)) || entry.request.jsonrpc !== "2.0" || !Number.isSafeInteger(entry.request.id) || entry.response.jsonrpc !== "2.0" || entry.response.id !== entry.request.id || !Array.isArray(entry.request.params)) throw new Error("pool RPC transcript correlation is invalid");
    if (Object.hasOwn(entry.response, "error") && (!isRecord(entry.response.error) || Object.keys(entry.response.error).some((key) => key !== "code") || typeof entry.response.error.code !== "string" || !POOL_ERROR_CODE_SET.has(entry.response.error.code))) throw new Error("pool RPC transcript error code is not fixed and allowlisted");
    const key = `${entry.network}\u0000${entry.endpointId}\u0000${entry.request.id}`;
    if (seen.has(key)) throw new Error("pool RPC transcript request id is duplicated");
    seen.add(key);
  }
}

function hexBytes(value) {
  if (typeof value !== "string" || !HEX_BYTES.test(value) || value.length % 2 !== 0) throw Object.assign(new Error("invalid bytes"), { code: "IDENTITY_MISMATCH" });
  return value.toLowerCase();
}

function word(result, index = 0) {
  const value = hexBytes(result);
  const start = 2 + index * 64;
  if (value.length < start + 64) throw Object.assign(new Error("invalid ABI result"), { code: "IDENTITY_MISMATCH" });
  return value.slice(start, start + 64);
}

function wordAddress(result, index = 0) {
  const encoded = word(result, index);
  if (!/^0{24}$/u.test(encoded.slice(0, 24))) throw Object.assign(new Error("invalid ABI address"), { code: "IDENTITY_MISMATCH" });
  const address = `0x${encoded.slice(-40)}`.toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw Object.assign(new Error("invalid ABI address"), { code: "IDENTITY_MISMATCH" });
  return address;
}

function wordQuantity(result, index = 0) {
  const bytes = hexBytes(result);
  if (index === 0 && bytes.length > 2 && bytes.length <= 66) return BigInt(bytes);
  return BigInt(`0x${word(result, index)}`);
}

function readU128LE(data, offset) {
  if (!Buffer.isBuffer(data) || offset < 0 || data.length < offset + 16) return null;
  return (data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n)).toString();
}

function blockHeader(value) {
  const hash = value?.hash ?? value?.blockHash;
  if (!isRecord(value) || typeof hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(hash) || typeof value.number !== "string" || !HEX_QUANTITY.test(value.number) || typeof value.timestamp !== "string" || !HEX_QUANTITY.test(value.timestamp)) throw Object.assign(new Error("invalid finalized block"), { code: "STALE" });
  return { hash: hash.toLowerCase(), number: BigInt(value.number), timestamp: BigInt(value.timestamp) };
}

function nowSeconds(clock) {
  const value = typeof clock === "function" ? clock() : typeof clock?.now === "function" ? clock.now() : clock?.now;
  const number = value === undefined ? Date.now() : Number(value);
  return Math.floor((Number.isFinite(number) ? number : Date.now()) / 1000);
}

function nowMillis(clock) {
  const value = typeof clock === "function" ? clock() : typeof clock?.now === "function" ? clock.now() : clock?.now;
  const number = value === undefined ? Date.now() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function expectedRpcChain(network) {
  return network === "ethereum" ? "0x1" : "0xa86a";
}

function assertAnchorFresh(anchor, network, options = {}) {
  const age = BigInt(nowSeconds(options.clock)) - anchor.timestamp;
  const maxAge = BigInt(options.maxFinalizedAgeSeconds?.[network] ?? options.freshness?.[network]?.maxFinalizedAgeSeconds ?? FINALIZED_AGE_LIMIT_SECONDS[network]);
  if (age > maxAge || age < -BigInt(options.maxFinalizedFutureSkewSeconds ?? options.freshness?.[network]?.maxFutureSkewSeconds ?? FINALIZED_FUTURE_SKEW_SECONDS)) throw Object.assign(new Error("finalized block is stale"), { code: "STALE" });
}

function tokenByAddress(catalog) {
  return new Map(catalog.deployments.filter((entry) => entry.address !== null).map((entry) => [`${entry.chainId}\u0000${normalizeTokenAddress(entry.chainId, entry.address)}`, entry]));
}

function boundedRaw(value, maxBytes = 16 * 1024) {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes <= 1024) return value;
    return { encoding: "gzip-base64", data: gzipSync(Buffer.from(value)).toString("base64"), sha256: createHash("sha256").update(value).digest("hex"), bytes, bounded: bytes <= maxBytes };
  }
  return value;
}

function validateRawCode(value) {
  if (typeof value === "string") { if (hexBytes(value).length <= 2) throw new Error("raw bytecode is empty"); return; }
  if (isRecord(value) && value.encoding === "gzip-base64" && typeof value.data === "string" && typeof value.sha256 === "string" && typeof value.bytes === "number") {
    const decoded = gunzipSync(Buffer.from(value.data, "base64"));
    if (decoded.length !== value.bytes || createHash("sha256").update(decoded).digest("hex") !== value.sha256 || decoded.length === 0) throw new Error("raw bytecode digest mismatch");
    return;
  }
  throw new Error("raw bytecode is not independently replayable");
}

function rawAccount(account) {
  const bytes = accountData(account);
  if (!bytes) return null;
  return { owner: account.owner, lamports: Number.isSafeInteger(Number(account.lamports)) ? Number(account.lamports) : null, executable: account.executable === true, data: bytes.toString("base64") };
}

function observationRow(dex, pool, status, fields = {}) {
  return {
    dexDeploymentId: dex.dexDeploymentId,
    protocolId: dex.protocolId,
    chainId: dex.chainId,
    poolDefinitionId: pool?.poolDefinitionId ?? null,
    poolAddress: pool?.address ?? null,
    status,
    ...fields,
  };
}

async function observeEvm(dex, pool, client, options, tokenMap, tokenCatalogValue = tokenCatalog, config = DEFAULT_DISCOVERY_CONFIG) {
  const network = NETWORK_BY_CHAIN[dex.chainId];
  if (!pool) return observationRow(dex, null, "missing", { errorCode: "POOL_NOT_CONFIGURED" });
  let anchor;
  try {
    const chainId = await client(network, "eth_chainId", []);
    if (String(chainId).toLowerCase() !== expectedRpcChain(network)) return observationRow(dex, pool, "identity-mismatch", { errorCode: "NETWORK_IDENTITY_MISMATCH" });
    anchor = blockHeader(await client(network, "eth_getBlockByNumber", ["finalized", false]));
  } catch (error) {
    const code = errorCode(error);
    return observationRow(dex, pool, ["UNATTEMPTED_BUDGET", "RPC_RUN_BUDGET_EXCEEDED"].includes(code) ? "missing" : code === "STALE" ? "stale" : "unreachable", { errorCode: ["UNATTEMPTED_BUDGET", "RPC_RUN_BUDGET_EXCEEDED"].includes(code) ? "UNATTEMPTED_BUDGET" : code, ...(["UNATTEMPTED_BUDGET", "RPC_RUN_BUDGET_EXCEEDED"].includes(code) ? { unattempted: true } : {}) });
  }
  try { assertAnchorFresh(anchor, network, { ...options, freshness: config.freshness }); } catch (error) { return observationRow(dex, pool, "stale", { errorCode: errorCode(error), blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash }); }
  const tag = blockTag(anchor.hash);
  try {
    const [factoryCode, poolCode] = await Promise.all([
      client(network, "eth_getCode", [dex.programAddress, tag]),
      client(network, "eth_getCode", [pool.address, tag]),
    ]);
    if (hexBytes(factoryCode).length <= 2 || hexBytes(poolCode).length <= 2) return observationRow(dex, pool, "missing", { errorCode: "EVM_CODE_MISSING", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, raw: { factoryCode: boundedRaw(factoryCode), poolCode: boundedRaw(poolCode) } });
    const token0Deployment = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId);
    const token1Deployment = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId);
    if (!token0Deployment?.address || !token1Deployment?.address) return observationRow(dex, pool, "identity-mismatch", { errorCode: "TOKEN_BINDING_INVALID" });
    const [factoryPairRaw, pairFactoryRaw, pairToken0Raw, pairToken1Raw, reservesRaw] = await Promise.all([
      client(network, "eth_call", [{ to: dex.programAddress, data: `${EVM_DISCOVERY_SELECTORS.factoryGetPair}${token0Deployment.address.slice(2).toLowerCase().padStart(64, "0")}${token1Deployment.address.slice(2).toLowerCase().padStart(64, "0")}` }, tag]),
      client(network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairFactory }, tag]),
      client(network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairToken0 }, tag]),
      client(network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairToken1 }, tag]),
      client(network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, tag]),
    ]);
    const expectedPool = pool.address.toLowerCase();
    if (wordAddress(factoryPairRaw) !== expectedPool || wordAddress(pairFactoryRaw) !== dex.programAddress.toLowerCase() || wordAddress(pairToken0Raw) !== token0Deployment.address.toLowerCase() || wordAddress(pairToken1Raw) !== token1Deployment.address.toLowerCase()) return observationRow(dex, pool, "identity-mismatch", { errorCode: "POOL_IDENTITY_MISMATCH", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash });
    const reserves = [wordQuantity(reservesRaw, 0), wordQuantity(reservesRaw, 1)];
    const reread = blockHeader(await client(network, "eth_getBlockByNumber", [`0x${anchor.number.toString(16)}`, false]));
    if (reread.hash !== anchor.hash || reread.number !== anchor.number) return observationRow(dex, pool, "stale", { errorCode: "FINALIZED_REORG", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash });
    const status = reserves[0] === 0n && reserves[1] === 0n ? "empty" : reserves[0] === 0n || reserves[1] === 0n ? "swap-disabled" : "healthy";
    return observationRow(dex, pool, status, { blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, blockTimestamp: anchor.timestamp.toString(), reserves: reserves.map(String), token0Address: token0Deployment.address.toLowerCase(), token1Address: token1Deployment.address.toLowerCase(), finality: "finalized-eip1898", request: { methods: ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"], blockHash: anchor.hash }, raw: { factoryCode: boundedRaw(factoryCode), poolCode: boundedRaw(poolCode), factoryPair: factoryPairRaw, pairFactory: pairFactoryRaw, pairToken0: pairToken0Raw, pairToken1: pairToken1Raw, reserves: reservesRaw } });
  } catch (error) {
    const code = errorCode(error);
    if (["UNATTEMPTED_BUDGET", "RPC_RUN_BUDGET_EXCEEDED"].includes(code)) return observationRow(dex, pool, "missing", { errorCode: "UNATTEMPTED_BUDGET", unattempted: true });
    return observationRow(dex, pool, ["STALE", "FINALIZED_REORG"].includes(code) ? "stale" : code.startsWith("RPC") || ["TIMEOUT", "UNREACHABLE"].includes(code) ? "unreachable" : "identity-mismatch", { errorCode: code, blockNumber: anchor ? `0x${anchor.number.toString(16)}` : null, blockHash: anchor?.hash ?? null });
  }
}

function accountData(account) {
  if (!isRecord(account)) return null;
  if (Array.isArray(account.data) && account.data[1] === "base64" && typeof account.data[0] === "string") return Buffer.from(account.data[0], "base64");
  if (typeof account.data === "string") return Buffer.from(account.data, "base64");
  return null;
}

function solanaPoolData(account, program, layout) {
  const bytes = accountData(account);
  if (account.executable === true || !Number.isSafeInteger(Number(account.lamports)) || Number(account.lamports) <= 0) throw Object.assign(new Error("account is not initialized"), { code: "IDENTITY_MISMATCH" });
  if (!bytes || bytes.length !== layout.dataSize) throw Object.assign(new Error("layout mismatch"), { code: "IDENTITY_MISMATCH" });
  if (account.owner !== program.program || bytes.subarray(0, 8).toString("hex") !== layout.discriminator) throw Object.assign(new Error("program identity mismatch"), { code: "IDENTITY_MISMATCH" });
  if (Number.isSafeInteger(layout.seedIndexOffset) && bytes.readUInt16LE(layout.seedIndexOffset) !== 0) throw Object.assign(new Error("unsupported Raydium seed index"), { code: "IDENTITY_MISMATCH" });
  if (!verifySolanaPoolPda(account.__pubkey ?? "", program.program, bytes, layout.pda)) throw Object.assign(new Error("pool PDA mismatch"), { code: "IDENTITY_MISMATCH" });
  const liquidity = Number.isSafeInteger(layout.liquidityOffset) ? readU128LE(bytes, layout.liquidityOffset) : null;
  const sqrtPrice = Number.isSafeInteger(layout.sqrtPriceOffset) ? readU128LE(bytes, layout.sqrtPriceOffset) : null;
  const statusByte = Number.isSafeInteger(layout.statusOffset) && bytes.length > layout.statusOffset ? bytes[layout.statusOffset] : null;
  return { bytes, mints: layout.mintOffsets.map((offset) => encodeBase58(bytes.subarray(offset, offset + 32))), vaults: layout.vaultOffsets.map((offset) => encodeBase58(bytes.subarray(offset, offset + 32))), config: encodeBase58(bytes.subarray(layout.configOffset, layout.configOffset + 32)), liquidity, sqrtPrice, statusByte };
}

function parseMint(account, expectedPrograms) {
  const bytes = accountData(account);
  const info = account?.data?.parsed?.info;
  if (!bytes && info && (info.isInitialized === true || info.initialized === true) && info.decimals !== undefined && info.supply !== undefined && expectedPrograms.includes(account.owner)) return { standard: account.owner === TOKEN_PROGRAM_IDS.splToken2022 ? "spl-token-2022" : "spl-token", decimals: Number(info.decimals), supply: String(info.supply) };
  const validMintFraming = account.owner === TOKEN_PROGRAM_IDS.splToken ? bytes?.length === 82 : validToken2022Framing(bytes, 82, 1);
  if (!validMintFraming || !expectedPrograms.includes(account.owner) || bytes[45] !== 1) throw Object.assign(new Error("mint invalid"), { code: "IDENTITY_MISMATCH" });
  return { standard: account.owner === TOKEN_PROGRAM_IDS.splToken2022 ? "spl-token-2022" : "spl-token", decimals: bytes[44], supply: bytes.readBigUInt64LE(36).toString() };
}

function parseVault(account, expectedPrograms, expectedMint, expectedAuthority = null, expectedProgram = null) {
  const bytes = accountData(account);
  const info = account?.data?.parsed?.info;
  if (!bytes && info && info.mint === expectedMint && (info.state === "initialized" || info.state === "frozen") && expectedPrograms.includes(account.owner) && (expectedAuthority === null || info.owner === expectedAuthority) && (expectedProgram === null || account.owner === expectedProgram)) return { amount: String(info.tokenAmount?.amount ?? info.amount ?? "0"), frozen: info.state === "frozen" };
  const validVaultFraming = account.owner === TOKEN_PROGRAM_IDS.splToken ? bytes?.length === 165 : validToken2022Framing(bytes, 165, 2);
  if (!validVaultFraming || !expectedPrograms.includes(account.owner) || expectedProgram !== null && account.owner !== expectedProgram || encodeBase58(bytes.subarray(0, 32)) !== expectedMint || ![1, 2].includes(bytes[108]) || expectedAuthority !== null && encodeBase58(bytes.subarray(32, 64)) !== expectedAuthority) throw Object.assign(new Error("vault invalid"), { code: "IDENTITY_MISMATCH" });
  return { amount: bytes.readBigUInt64LE(64).toString(), frozen: bytes[108] === 2 };
}

async function observeSolana(dex, pool, program, client, config, options, tokenCatalogValue = tokenCatalog) {
  if (!pool) return observationRow(dex, null, "missing", { errorCode: "POOL_NOT_CONFIGURED" });
  const layout = { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol], ...program.layout };
  let result;
  let anchorSlot = null;
  let requestMeta = null;
  try {
    const genesis = await client("solana", "getGenesisHash", []);
    if (genesis !== (config.rpc.solana.expectedGenesisHash ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")) return observationRow(dex, pool, "identity-mismatch", { errorCode: "SOLANA_GENESIS_MISMATCH" });
    const freshSlotRaw = await client("solana", "getSlot", [{ commitment: "finalized" }]);
    const freshSlot = typeof freshSlotRaw === "number" ? freshSlotRaw : typeof freshSlotRaw === "string" && /^\d+$/u.test(freshSlotRaw) ? Number(freshSlotRaw) : NaN;
    if (!Number.isSafeInteger(freshSlot) || freshSlot < config.solana.anchor.minContextSlot) return observationRow(dex, pool, "stale", { errorCode: "SOLANA_SLOT_INVALID" });
    anchorSlot = Math.max(config.solana.anchor.minContextSlot, freshSlot);
    requestMeta = { methods: ["getGenesisHash", "getSlot", "getBlockTime", "getMultipleAccounts"], minContextSlot: anchorSlot, blockTimeSlot: anchorSlot };
    const blockTimeRaw = await client("solana", "getBlockTime", [anchorSlot]);
    let blockTime;
    try {
      blockTime = assertSolanaBlockTimeFresh(blockTimeRaw, options.clock, config);
    } catch (error) {
      const parsedBlockTime = solanaBlockTime(blockTimeRaw);
      return observationRow(dex, pool, "stale", { errorCode: error.code ?? "SOLANA_BLOCK_TIME_INVALID", contextSlot: anchorSlot, request: requestMeta, ...(parsedBlockTime === null ? {} : { blockTime: parsedBlockTime }) });
    }
    result = await client("solana", "getMultipleAccounts", [[pool.address], { commitment: "finalized", encoding: "base64", minContextSlot: anchorSlot }]);
    if (!isRecord(result) || !isRecord(result.context) || !Number.isSafeInteger(result.context.slot) || result.context.slot < anchorSlot || result.context.slot > anchorSlot + SOLANA_CONTEXT_MAX_SPREAD_SLOTS) return observationRow(dex, pool, "stale", { errorCode: "SOLANA_CONTEXT_BELOW_ANCHOR", request: requestMeta });
    if (!Array.isArray(result.value) || result.value.length !== 1 || !result.value[0]) return observationRow(dex, pool, "missing", { errorCode: "POOL_ACCOUNT_MISSING", contextSlot: result.context.slot, request: requestMeta });
    const accountWithPubkey = { ...result.value[0], __pubkey: pool.address };
    const parsed = solanaPoolData(accountWithPubkey, program, layout);
    const token0Deployment = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId);
    const token1Deployment = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId);
    if (!token0Deployment?.address || !token1Deployment?.address || token0Deployment.chainId !== SOLANA_CHAIN || token1Deployment.chainId !== SOLANA_CHAIN || parsed.mints[0] !== token0Deployment.address || parsed.mints[1] !== token1Deployment.address) return observationRow(dex, pool, "identity-mismatch", { errorCode: "POOL_TOKEN_BINDING_MISMATCH", contextSlot: result.context.slot, request: requestMeta });
    const related = [...parsed.mints, ...parsed.vaults, parsed.config];
    const relatedResult = await client("solana", "getMultipleAccounts", [related, { commitment: "finalized", encoding: "base64", minContextSlot: result.context.slot }]);
    if (!isRecord(relatedResult) || !isRecord(relatedResult.context) || !Number.isSafeInteger(relatedResult.context.slot) || relatedResult.context.slot < result.context.slot || relatedResult.context.slot > anchorSlot + SOLANA_CONTEXT_MAX_SPREAD_SLOTS) return observationRow(dex, pool, "stale", { errorCode: "SOLANA_CONTEXT_BELOW_ANCHOR", contextSlot: result.context.slot, request: requestMeta });
    if (!Array.isArray(relatedResult.value) || relatedResult.value.length !== 5 || relatedResult.value.some((entry) => !entry)) return observationRow(dex, pool, "identity-mismatch", { errorCode: "SOLANA_ACCOUNT_INVALID", contextSlot: relatedResult.context.slot, request: requestMeta });
    const mint0 = parseMint(relatedResult.value[0], config.solana.mintPrograms);
    const mint1 = parseMint(relatedResult.value[1], config.solana.mintPrograms);
    const vault0 = parseVault(relatedResult.value[2], config.solana.mintPrograms, parsed.mints[0], pool.address, relatedResult.value[0].owner);
    const vault1 = parseVault(relatedResult.value[3], config.solana.mintPrograms, parsed.mints[1], pool.address, relatedResult.value[1].owner);
    if (relatedResult.value[4].owner !== program.program || !accountData(relatedResult.value[4])?.length) return observationRow(dex, pool, "identity-mismatch", { errorCode: "SOLANA_CONFIG_INVALID", contextSlot: relatedResult.context.slot, request: requestMeta });
    const liquidityOffset = Number.isSafeInteger(layout.liquidityOffset) ? layout.liquidityOffset : program.protocol === "orca-whirlpool" ? 49 : 201;
    const liquidityBytes = accountData(accountWithPubkey)?.subarray(liquidityOffset, liquidityOffset + 16);
    const liquidity = liquidityBytes?.length === 16 ? Buffer.from(liquidityBytes).readBigUInt64LE(0).toString() : null;
    const hasLiquidity = parsed.liquidity === null ? vault0.amount !== "0" && vault1.amount !== "0" : BigInt(parsed.liquidity) > 0n;
    const swapDisabled = parsed.statusByte !== null && (parsed.statusByte & (layout.swapDisabledMask ?? 0)) !== 0;
    const status = vault0.amount === "0" && vault1.amount === "0" && !hasLiquidity ? "empty" : vault0.amount === "0" || vault1.amount === "0" || !hasLiquidity || swapDisabled || vault0.frozen || vault1.frozen ? "swap-disabled" : "healthy";
    return observationRow(dex, pool, status, { contextSlot: relatedResult.context.slot, slot: relatedResult.context.slot, blockTime, token0Address: parsed.mints[0], token1Address: parsed.mints[1], vaults: parsed.vaults, supplies: [mint0.supply, mint1.supply], decimals: [mint0.decimals, mint1.decimals], liquidity: parsed.liquidity, sqrtPrice: parsed.sqrtPrice, statusByte: parsed.statusByte, liquidityKind: "pool-account-u128", supplyKind: "mint-account-total-supply", finality: "finalized-minContextSlot", request: requestMeta, raw: { poolAccount: rawAccount(accountWithPubkey), mintAccounts: relatedResult.value.slice(0, 2).map(rawAccount), vaultAccounts: relatedResult.value.slice(2, 4).map(rawAccount), configAccount: rawAccount(relatedResult.value[4]) } });
  } catch (error) {
    const code = errorCode(error);
    if (["UNATTEMPTED_BUDGET", "RPC_RUN_BUDGET_EXCEEDED"].includes(code)) return observationRow(dex, pool, "missing", { errorCode: "UNATTEMPTED_BUDGET", unattempted: true });
    return observationRow(dex, pool, code === "SOLANA_CONTEXT_BELOW_ANCHOR" || code === "STALE" ? "stale" : code.startsWith("RPC") || ["TIMEOUT", "UNREACHABLE"].includes(code) ? "unreachable" : "identity-mismatch", { errorCode: code, ...(requestMeta ? { request: requestMeta } : {}) });
  }
}

function statusOf(rows) {
  if (rows.some((entry) => entry.status === "unreachable" || ["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(entry.errorCode))) return "partial";
  return "complete";
}

export function validatePoolObservations(artifact, { tokenCatalog: tokenCatalogValue = tokenCatalog, dexCatalog: dexCatalogValue = dexCatalog } = {}) {
  if (!isRecord(artifact) || artifact.schemaVersion !== 1 || artifact.artifactKind !== "pool-observations" || !Array.isArray(artifact.observations)) throw new Error("pool observation artifact is invalid");
  if (typeof artifact.sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(artifact.sourceSha) || typeof artifact.configDigest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.configDigest) || typeof artifact.tokenCatalogDigest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.tokenCatalogDigest) || typeof artifact.dexCatalogDigest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.dexCatalogDigest)) throw new Error("pool observation bindings are invalid");
  validateTokenCatalog(tokenCatalogValue);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  if (artifact.tokenCatalogDigest !== computeTokenDigest(tokenCatalogValue) || artifact.dexCatalogDigest !== computeDexDigest(dexCatalogValue)) throw new Error("pool observation catalog binding mismatch");
  validateCoverageEnvelope(artifact, artifact.observations, dexCatalogValue);
  for (const row of artifact.observations) {
    if (!isRecord(row) || !POOL_HEALTH_STATUSES.includes(row.status) || typeof row.dexDeploymentId !== "string" || !EVM_CHAINS.has(row.chainId) && row.chainId !== SOLANA_CHAIN) throw new Error("pool observation row is invalid");
    if (row.errorCode !== undefined && (!POOL_ERROR_CODE_SET.has(row.errorCode) || typeof row.errorCode !== "string")) throw new Error("pool observation error code is not allowlisted");
    if (row.blockTime !== undefined && row.blockTime !== null && (!Number.isSafeInteger(row.blockTime) || row.blockTime < 0)) throw new Error("pool observation block time is invalid");
    if (row.status === "healthy" || row.status === "empty" || row.status === "swap-disabled") {
      if (row.blockNumber === undefined && row.contextSlot === undefined) throw new Error("operational observation lacks snapshot");
      if (row.chainId === SOLANA_CHAIN && (!Number.isSafeInteger(row.blockTime) || row.blockTime < 0 || !isRecord(row.request) || !Number.isSafeInteger(row.request.blockTimeSlot))) throw new Error("operational Solana observation lacks mandatory finalized block time evidence");
    }
  }
  if (artifact.observations.some((row) => ["healthy", "empty", "swap-disabled"].includes(row.status)) && !Array.isArray(artifact.rpcTranscript)) throw new Error("operational pool observation requires an RPC transcript");
  if (artifact.state !== undefined && (!isRecord(artifact.state) || artifact.state.artifactKind !== "pool-observer-state" || !Number.isSafeInteger(artifact.state.poolCursor) || !Number.isSafeInteger(artifact.state.taskCount))) throw new Error("pool observer state is invalid");
  return true;
}

/** Revalidate a previously emitted, bounded pool receipt without network IO. */
export function replayPoolObservations(rawReceipts, { sourceSha: sourceShaValue, config = DEFAULT_DISCOVERY_CONFIG, tokenCatalog: tokenCatalogValue = tokenCatalog, dexCatalog: dexCatalogValue = dexCatalog } = {}) {
  validateDiscoveryConfig(config);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  validateTokenCatalog(tokenCatalogValue);
  if (!isRecord(rawReceipts) || !["pool-receipts", "pool-observations"].includes(rawReceipts.artifactKind) || !Array.isArray(rawReceipts.receipts)) throw new Error("pool receipts artifact is invalid");
  if (typeof rawReceipts.sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(rawReceipts.sourceSha)) throw new Error("pool receipt source binding is invalid");
  if (sourceShaValue !== undefined && rawReceipts.sourceSha !== sourceShaValue) throw new Error("pool receipt source binding mismatch");
  if (rawReceipts.configDigest !== computeDiscoveryConfigDigest(config) || rawReceipts.tokenCatalogDigest !== computeTokenDigest(tokenCatalogValue) || rawReceipts.dexCatalogDigest !== computeDexDigest(dexCatalogValue)) throw new Error("pool receipt catalog binding mismatch");
  const transcript = rawReceipts.rpcTranscript;
  const sourceRows = rawReceipts.receipts;
  validateCoverageEnvelope(rawReceipts, sourceRows, dexCatalogValue);
  if (sourceRows.some((row) => !["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode))) validateTranscript(transcript);
  if (sourceRows.some((row) => row.errorCode === "NOT_OBSERVED")) throw new Error("NOT_OBSERVED is not a valid raw pool receipt state");
  if (Array.isArray(transcript)) for (const entry of transcript) if (entry.endpointId !== config.rpc?.[entry.network]?.endpointId) throw new Error("pool RPC transcript endpoint binding mismatch");
  const replayed = sourceRows.map((row) => {
    if (!POOL_HEALTH_STATUSES.includes(row.status)) throw new Error("pool receipt status is invalid");
    if (row.errorCode !== undefined && (!POOL_ERROR_CODE_SET.has(row.errorCode) || typeof row.errorCode !== "string")) throw new Error("pool receipt error code is not allowlisted");
    const pool = row.poolDefinitionId ? dexCatalogValue.poolDefinitions.find((entry) => entry.poolDefinitionId === row.poolDefinitionId) : null;
    const dex = pool ? dexCatalogValue.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId) : null;
    const rowTranscript = scopeTranscript(transcript, row);
    if (row.poolDefinitionId && (!pool || !dex || row.dexDeploymentId !== pool.dexDeploymentId || row.chainId !== pool.chainId || row.poolAddress !== pool.address)) throw new Error("pool receipt canonical binding mismatch");
    if (["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode)) {
      if (row.status !== "missing" || row.unattempted !== true) throw new Error("unattempted pool receipt is not explicitly marked as bounded coverage");
      return row;
    }
    const hasDerivableRaw = isRecord(row.raw) && isRecord(row.request) && (EVM_CHAINS.has(row.chainId)
      ? typeof row.raw.reserves === "string"
      : isRecord(row.raw.poolAccount) && Array.isArray(row.raw.mintAccounts) && Array.isArray(row.raw.vaultAccounts) && isRecord(row.raw.configAccount));
    if (row.errorCode === "POOL_NOT_CONFIGURED") {
      if (row.poolDefinitionId !== null || row.status !== "missing") throw new Error("unconfigured pool receipt binding is invalid");
      return row;
    }
    if (!hasDerivableRaw && ["healthy", "empty", "swap-disabled"].includes(row.status)) throw new Error("operational pool receipt lacks complete raw evidence");
    if (!hasDerivableRaw) assertNonOperationalEvidence(row, rowTranscript, config, rawReceipts, tokenCatalogValue, dexCatalogValue);
    // A detached status is metadata. If complete raw evidence exists, derive
    // the state from it even when a producer changed that metadata.
    if (hasDerivableRaw) {
      if (!row.raw || !row.request) throw new Error("operational pool receipt lacks raw evidence");
      if (EVM_CHAINS.has(row.chainId)) {
        if (row.request.blockHash !== row.blockHash) throw new Error("EVM pool receipt block binding mismatch");
        const finalizedEntry = rowTranscript.find((entry) => entry?.network === NETWORK_BY_CHAIN[row.chainId] && entry.request?.method === "eth_getBlockByNumber" && entry.request?.params?.[0] === "finalized" && Object.hasOwn(entry.response ?? {}, "result"));
        if (!finalizedEntry) throw new Error("EVM pool receipt is missing the finalized block response");
        assertReplayAnchorFresh(blockHeader(finalizedEntry.response.result), NETWORK_BY_CHAIN[row.chainId], rawReceipts, rowTranscript, config);
        validateRawCode(row.raw.factoryCode);
        validateRawCode(row.raw.poolCode);
        if (typeof row.raw.reserves !== "string") throw new Error("EVM pool raw reserves are required");
        const reserves = [wordQuantity(row.raw.reserves, 0).toString(), wordQuantity(row.raw.reserves, 1).toString()];
        if (!Array.isArray(reserves) || stableStringify(reserves) !== stableStringify(row.reserves)) throw new Error("EVM pool reserves mismatch");
        const pool = dexCatalogValue.poolDefinitions.find((entry) => entry.poolDefinitionId === row.poolDefinitionId);
        const dex = pool && dexCatalogValue.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
        const token0 = pool && tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token0DeploymentId);
        const token1 = pool && tokenCatalogValue.deployments.find((entry) => entry.deploymentId === pool.token1DeploymentId);
        const tag = blockTag(row.blockHash);
        const network = NETWORK_BY_CHAIN[row.chainId];
        const expectedChain = network === "ethereum" ? "0x1" : "0xa86a";
        if (!pool || !dex || row.dexDeploymentId !== pool.dexDeploymentId || row.poolAddress !== pool.address || !token0?.address || !token1?.address || !transcriptCallMatches(rowTranscript, network, "eth_chainId", [], expectedChain) || !transcriptBlockMatches(rowTranscript, network, ["finalized", false], row) || !transcriptBlockMatches(rowTranscript, network, [row.blockNumber, false], row) || !transcriptCallMatches(rowTranscript, network, "eth_getCode", [dex.programAddress, tag], row.raw.factoryCode) || !transcriptCallMatches(rowTranscript, network, "eth_getCode", [pool.address, tag], row.raw.poolCode) || !transcriptCallMatches(rowTranscript, network, "eth_call", [{ to: dex.programAddress, data: `${EVM_DISCOVERY_SELECTORS.factoryGetPair}${token0.address.slice(2).toLowerCase().padStart(64, "0")}${token1.address.slice(2).toLowerCase().padStart(64, "0")}` }, tag], row.raw.factoryPair) || !transcriptCallMatches(rowTranscript, network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairFactory }, tag], row.raw.pairFactory) || !transcriptCallMatches(rowTranscript, network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairToken0 }, tag], row.raw.pairToken0) || !transcriptCallMatches(rowTranscript, network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairToken1 }, tag], row.raw.pairToken1) || !transcriptCallMatches(rowTranscript, network, "eth_call", [{ to: pool.address, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, tag], row.raw.reserves)) throw new Error("EVM pool receipt is not bound to exact RPC requests");
        if (wordAddress(row.raw.factoryPair) !== pool.address.toLowerCase() || wordAddress(row.raw.pairFactory) !== dex.programAddress.toLowerCase() || wordAddress(row.raw.pairToken0) !== token0.address.toLowerCase() || wordAddress(row.raw.pairToken1) !== token1.address.toLowerCase()) throw new Error("EVM pool raw identity mismatch");
        const derivedStatus = reserves[0] === "0" && reserves[1] === "0" ? "empty" : reserves[0] === "0" || reserves[1] === "0" ? "swap-disabled" : "healthy";
        if (derivedStatus !== row.status) throw new Error("EVM pool health status is not derived from raw reserves");
      } else {
        if (!Number.isSafeInteger(row.contextSlot) || !isRecord(row.request) || !Number.isSafeInteger(row.request.minContextSlot) || row.request.minContextSlot > row.contextSlot) throw new Error("Solana pool context binding mismatch");
        if (!Number.isSafeInteger(row.request.blockTimeSlot)) throw new Error("Solana block-time slot binding is invalid");
        const blockTimeSlot = row.request.blockTimeSlot;
        const blockTimeEntry = rowTranscript.find((entry) => entry?.network === "solana" && entry.request?.method === "getBlockTime" && stableStringify(entry.request?.params) === stableStringify([blockTimeSlot]) && Object.hasOwn(entry.response ?? {}, "result"));
        const blockTimeValue = blockTimeEntry ? solanaBlockTime(blockTimeEntry.response.result) : null;
        if (!blockTimeEntry || blockTimeValue === null || row.blockTime !== blockTimeValue) throw new Error("Solana block-time response is not bound to the exact request");
        const replayCapture = captureSeconds(rawReceipts, rowTranscript);
        if (replayCapture === null) throw new Error("Solana block-time capture clock is missing");
        assertSolanaBlockTimeFresh(blockTimeValue, { now: replayCapture * 1000 }, config);
        const dex = dexCatalogValue.dexDeployments.find((entry) => entry.dexDeploymentId === row.dexDeploymentId);
        const program = config.solana.programs.find((entry) => entry.dexDeploymentId === row.dexDeploymentId);
        if (!dex || !program || row.dexDeploymentId !== pool?.dexDeploymentId || row.poolAddress !== pool?.address || !row.raw.poolAccount) throw new Error("Solana pool receipt lacks program binding");
        const layout = { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol] ?? {}, ...program.layout };
        const account = { ...row.raw.poolAccount, __pubkey: row.poolAddress };
        const parsed = solanaPoolData(account, { ...program, program: dex.programAddress }, layout);
        const genesisEntry = rowTranscript.find((entry) => entry.network === "solana" && entry.request?.method === "getGenesisHash" && entry.request?.params?.length === 0 && entry.response?.result === (config.rpc.solana.expectedGenesisHash ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"));
        const slotEntry = rowTranscript.find((entry) => entry.network === "solana" && entry.request?.method === "getSlot" && stableStringify(entry.request?.params) === stableStringify([{ commitment: "finalized" }]) && Object.hasOwn(entry.response ?? {}, "result"));
        const finalSlot = slotEntry ? (typeof slotEntry.response.result === "number" ? slotEntry.response.result : typeof slotEntry.response.result === "string" && /^\d+$/u.test(slotEntry.response.result) ? Number(slotEntry.response.result) : NaN) : NaN;
        if (!genesisEntry || !slotEntry || !Number.isSafeInteger(finalSlot) || finalSlot < row.request.minContextSlot || blockTimeSlot !== Math.max(config.solana.anchor.minContextSlot, finalSlot)) throw new Error("Solana pool receipt is not bound to exact RPC requests");
        const poolEntry = transcriptMultipleAccountEntry(rowTranscript, { addresses: [row.poolAddress] });
        const poolContextSlot = poolEntry?.response?.result?.context?.slot;
        if (!poolEntry || !Number.isSafeInteger(poolContextSlot)) throw new Error("Solana pool receipt is missing exact pool context");
        assertSolanaContextCoherent(poolContextSlot, blockTimeSlot, blockTimeSlot);
        if (row.contextSlot < poolContextSlot) throw new Error("Solana pool context binding mismatch");
        const poolAddresses = [row.poolAddress];
        const relatedAddresses = [parsed.mints[0], parsed.mints[1], parsed.vaults[0], parsed.vaults[1], parsed.config];
        if (!transcriptMultipleAccountMatches(rowTranscript, { network: "solana", addresses: poolAddresses, address: row.poolAddress, raw: row.raw.poolAccount, minContextSlot: row.request.minContextSlot }) || !Array.isArray(row.raw.mintAccounts) || !Array.isArray(row.raw.vaultAccounts) || !row.raw.configAccount) throw new Error("Solana pool receipt is not bound to exact RPC requests");
        if (stableStringify(parsed.mints) !== stableStringify([row.token0Address, row.token1Address])) throw new Error("Solana pool token binding mismatch");
        if (!Array.isArray(row.raw.mintAccounts) || !Array.isArray(row.raw.vaultAccounts) || !row.raw.configAccount) throw new Error("Solana pool receipt lacks related accounts");
        const relatedEntry = transcriptMultipleAccountEntry(rowTranscript, { addresses: relatedAddresses });
        const relatedContextSlot = relatedEntry?.response?.result?.context?.slot;
        if (!relatedEntry || !Number.isSafeInteger(relatedContextSlot)) throw new Error("Solana related account context is invalid");
        assertSolanaContextCoherent(relatedContextSlot, poolContextSlot, blockTimeSlot);
        if (row.contextSlot !== relatedContextSlot) throw new Error("Solana related account context binding mismatch");
        const relatedInTranscript = (address, raw) => transcriptMultipleAccountMatches(rowTranscript, { network: "solana", addresses: relatedAddresses, address, raw, minContextSlot: row.request.minContextSlot });
        if (!relatedInTranscript(parsed.mints[0], row.raw.mintAccounts[0]) || !relatedInTranscript(parsed.mints[1], row.raw.mintAccounts[1]) || !relatedInTranscript(parsed.vaults[0], row.raw.vaultAccounts[0]) || !relatedInTranscript(parsed.vaults[1], row.raw.vaultAccounts[1]) || !relatedInTranscript(parsed.config, row.raw.configAccount)) throw new Error("Solana pool related raw accounts are not bound to exact RPC requests");
        parseMint(row.raw.mintAccounts[0], config.solana.mintPrograms);
        parseMint(row.raw.mintAccounts[1], config.solana.mintPrograms);
        const replayVault0 = parseVault(row.raw.vaultAccounts[0], config.solana.mintPrograms, parsed.mints[0], row.poolAddress, row.raw.mintAccounts[0].owner);
        const replayVault1 = parseVault(row.raw.vaultAccounts[1], config.solana.mintPrograms, parsed.mints[1], row.poolAddress, row.raw.mintAccounts[1].owner);
        if (row.raw.configAccount.owner !== dex.programAddress || !accountData(row.raw.configAccount)?.length) throw new Error("Solana pool config account mismatch");
        const amount0 = replayVault0.amount;
        const amount1 = replayVault1.amount;
        const hasLiquidity = parsed.liquidity === null ? amount0 !== "0" && amount1 !== "0" : BigInt(parsed.liquidity) > 0n;
        const swapDisabled = parsed.statusByte !== null && (parsed.statusByte & (layout.swapDisabledMask ?? 0)) !== 0;
        const derivedStatus = amount0 === "0" && amount1 === "0" && !hasLiquidity ? "empty" : amount0 === "0" || amount1 === "0" || !hasLiquidity || swapDisabled || replayVault0.frozen || replayVault1.frozen ? "swap-disabled" : "healthy";
        if (derivedStatus !== row.status) throw new Error("Solana pool health status is not derived from raw account state");
      }
    }
    return row;
  });
  const result = replayed;
  Object.defineProperties(result, { observations: { value: result, enumerable: false }, health: { value: result.map((row) => ({ dexDeploymentId: row.dexDeploymentId, poolDefinitionId: row.poolDefinitionId, status: row.status })), enumerable: false } });
  return result;
}

export async function observePools(options = {}) {
  const config = options.config ?? DEFAULT_DISCOVERY_CONFIG;
  validateDiscoveryConfig(config);
  const dexCatalogValue = options.dexCatalog ?? dexCatalog;
  const poolDefinitions = Array.isArray(options.poolDefinitions)
    ? options.poolDefinitions
    : dexCatalogValue.poolDefinitions;
  const tokenCatalogValue = options.tokenCatalog ?? tokenCatalog;
  validateTokenCatalog(tokenCatalogValue);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  const suppliedClient = options.rpcClient ?? createBoundedRpcClient(options, config);
  const client = typeof suppliedClient === "function"
    ? suppliedClient
    : suppliedClient && typeof suppliedClient.request === "function"
      ? (network, method, params) => suppliedClient.request(method, params, { network })
      : suppliedClient && typeof suppliedClient.call === "function"
        ? (network, method, params) => suppliedClient.call(method, params, { network })
        : suppliedClient;
  const localTranscript = [];
  let transcriptId = 1;
  const runStart = Date.now();
  const runBudget = Math.min(options.runBudgetMs ?? config.limits?.runBudgetMs ?? POOL_OBSERVER_LIMITS.runBudgetMs, POOL_OBSERVER_LIMITS.runBudgetMs);
  const boundedClient = async (...args) => {
    const remaining = runStart + runBudget - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("observer run budget"), { code: "UNATTEMPTED_BUDGET" });
    let timer;
    const [network, method, params] = args;
    const request = { jsonrpc: "2.0", id: transcriptId++, method, params: structuredClone(params) };
    try {
      const result = await Promise.race([
        client(...args),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("observer run budget"), { code: "RPC_RUN_BUDGET_EXCEEDED" })), remaining); }),
      ]);
      if (!Array.isArray(suppliedClient?.transcript)) localTranscript.push({ network, endpointId: config.rpc?.[network]?.endpointId ?? null, observedAt: new Date(nowMillis(options.clock)).toISOString(), request, response: { jsonrpc: "2.0", id: request.id, result: result?.jsonrpc === "2.0" && Object.hasOwn(result, "result") ? result.result : result } });
      return result;
    } catch (error) {
      if (!Array.isArray(suppliedClient?.transcript)) localTranscript.push({ network, endpointId: config.rpc?.[network]?.endpointId ?? null, observedAt: new Date(nowMillis(options.clock)).toISOString(), request, response: { jsonrpc: "2.0", id: request.id, error: { code: fixedErrorCode(error?.code) } } });
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const rpcTranscript = Array.isArray(suppliedClient?.transcript) ? suppliedClient.transcript : localTranscript;
  const tokenMap = tokenByAddress(tokenCatalogValue);
  const rows = [];
  const dexes = [...dexCatalogValue.dexDeployments].sort((left, right) => left.dexDeploymentId.localeCompare(right.dexDeploymentId));
  const tasks = [];
  for (const dex of dexes) {
    const network = NETWORK_BY_CHAIN[dex.chainId];
    const pools = poolDefinitions.filter((entry) => entry.dexDeploymentId === dex.dexDeploymentId && entry.status !== "retired");
    if (pools.length === 0) {
      tasks.push({ dex, pool: null, network });
      continue;
    }
    const program = network === "solana" ? config.solana.programs.find((entry) => entry.dexDeploymentId === dex.dexDeploymentId) : null;
    for (const pool of pools.sort((left, right) => left.poolDefinitionId.localeCompare(right.poolDefinitionId))) tasks.push({ dex, pool, network, program });
  }
  const cursorInput = Number.isSafeInteger(options.poolCursor) ? options.poolCursor : Number.isSafeInteger(options.state?.poolCursor) ? options.state.poolCursor : 0;
  const cursor = tasks.length > 0 ? ((cursorInput % tasks.length) + tasks.length) % tasks.length : 0;
  const maxPools = Math.min(tasks.length, Number.isSafeInteger(options.maxPoolsPerRun) ? Math.max(0, options.maxPoolsPerRun) : tasks.length);
  const selectedIndexes = new Set(Array.from({ length: maxPools }, (_, index) => (cursor + index) % Math.max(1, tasks.length)));
  for (const [index, task] of tasks.entries()) {
    if (!selectedIndexes.has(index)) {
      rows.push(observationRow(task.dex, task.pool, "missing", { errorCode: "UNATTEMPTED_ROTATION", unattempted: true }));
      continue;
    }
    const trace = Array.isArray(rpcTranscript) ? rpcTranscript : [];
    const traceStart = trace.length;
    let row;
    if (!task.pool) row = observationRow(task.dex, null, "missing", { errorCode: "POOL_NOT_CONFIGURED" });
    else if (task.network === "solana") row = await observeSolana(task.dex, task.pool, task.program ?? { protocol: task.dex.protocolId, program: task.dex.programAddress, layout: SOLANA_DISCOVERY_LAYOUTS[task.dex.protocolId] ?? {} }, boundedClient, config, options, tokenCatalogValue);
    else row = await observeEvm(task.dex, task.pool, boundedClient, options, tokenMap, tokenCatalogValue, config);
    const traceEntries = trace.slice(traceStart);
    if (traceEntries.length > 0) row.request = { ...(row.request ?? {}), transcriptIds: traceEntries.map((entry) => entry?.request?.id).filter((id) => Number.isSafeInteger(id)), transcriptEndpointId: traceEntries[0]?.endpointId ?? null };
    row.capturedAt = new Date(nowMillis(options.clock)).toISOString();
    rows.push(row);
  }
  const artifact = {
    schemaVersion: POOL_OBSERVER_SCHEMA_VERSION,
    artifactKind: "pool-observations",
    sourceSha: options.sourceSha ?? "0".repeat(40),
    configDigest: computeDiscoveryConfigDigest(config),
    tokenCatalogDigest: computeTokenDigest(tokenCatalogValue),
    dexCatalogDigest: computeDexDigest(dexCatalogValue),
    capturedAt: new Date(nowMillis(options.clock)).toISOString(),
    status: statusOf(rows),
    observations: rows,
    receipts: rows,
    rpcTranscript,
    health: rows.map((row) => ({ dexDeploymentId: row.dexDeploymentId, poolDefinitionId: row.poolDefinitionId, status: row.status, errorCode: row.errorCode ?? null })),
    policy: { readOnly: true, canonicalMutation: false, outageRetirement: false },
    coverage: { mode: "bounded", claim: "bounded", poolCount: rows.length, attemptedPoolCount: rows.filter((row) => !["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode)).length, unattemptedPoolCount: rows.filter((row) => ["UNATTEMPTED_ROTATION", "UNATTEMPTED_BUDGET"].includes(row.errorCode)).length, cursor },
    state: { schemaVersion: 1, artifactKind: "pool-observer-state", poolCursor: tasks.length > 0 ? (cursor + selectedIndexes.size) % tasks.length : 0, taskCount: tasks.length },
  };
  validatePoolObservations(artifact, { tokenCatalog: tokenCatalogValue, dexCatalog: dexCatalogValue });
  if (options.outputDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(resolve(options.outputDir, POOL_OBSERVER_ARTIFACT_FILENAMES.observations), `${JSON.stringify(artifact, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, POOL_OBSERVER_ARTIFACT_FILENAMES.receipts), `${JSON.stringify({ ...artifact, artifactKind: "pool-receipts", receipts: rows }, null, 2)}\n`);
  }
  return artifact;
}

export const observePoolHealth = observePools;
export const runPoolObserver = observePools;
export const poolObserver = observePools;
export const collectPoolObservations = observePools;
export const collectPoolReceipts = observePools;
export const replayPoolReceipts = replayPoolObservations;
export const DEFAULT_POOL_OBSERVER_CONFIG = DEFAULT_DISCOVERY_CONFIG;
