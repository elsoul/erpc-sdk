/*
 * Bounded, read-only token and pool discovery.
 *
 * This module deliberately contains a small RPC client and independent byte
 * parsers. It does not import a DEX SDK or execute files returned by an RPC.
 * The output is evidence and an append-only admission proposal; a separate
 * M2 writer is responsible for changing the canonical catalogs.
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";

import tokenCatalog from "./token-catalog.json" with { type: "json" };
import dexCatalog from "./dex-catalog.json" with { type: "json" };
import {
  TOKEN_CHAIN_IDS,
  computeDigest as computeTokenDigest,
  normalizeAddress as normalizeTokenAddress,
  validateCatalog as validateTokenCatalog,
} from "./token-catalog.mjs";
import {
  DEX_CHAIN_IDS,
  computeDigest as computeDexDigest,
  validateCatalog as validateDexCatalog,
} from "./dex-catalog.mjs";
import {
  DEFAULT_RPC_ENDPOINTS,
  TOKEN_PROGRAM_IDS,
  parseHttpsUrl,
  requestHttpsTransport,
} from "./observer.mjs";
import defaultConfig from "./discovery-config.json" with { type: "json" };

export const DISCOVERY_SCHEMA_VERSION = 1;
export const DISCOVERY_ARTIFACT_FILENAMES = Object.freeze({
  receipts: "discovery-receipts.json",
  proposals: "discovery-proposals.json",
  evidence: "discovery-evidence.json",
  state: "discovery-state.json",
  admissions: "discovery-admissions.json",
});

export const DISCOVERY_LIMITS = Object.freeze({
  rpcBodyBytes: 512 * 1024,
  rpcTimeoutMs: 10_000,
  rpcRetries: 2,
  maxConcurrentRequests: 4,
  runBudgetMs: 60_000,
  maxMultipleAccounts: 64,
  maxAdmissionTokens: 8,
  maxAdmissionPools: 8,
  maxPending: 1024,
});

export const DISCOVERY_ERROR_CODES = Object.freeze([
  "CONFIG_INVALID",
  "CATALOG_INVALID",
  "SOURCE_SHA_INVALID",
  "CONFIG_DIGEST_MISMATCH",
  "NETWORK_IDENTITY_INVALID",
  "NETWORK_IDENTITY_MISMATCH",
  "FINALIZED_BLOCK_UNAVAILABLE",
  "FINALIZED_BLOCK_INVALID",
  "FINALIZED_BLOCK_STALE",
  "RPC_TIMEOUT",
  "RPC_RUN_BUDGET_EXCEEDED",
  "RPC_RATE_LIMITED",
  "RPC_UPSTREAM_ERROR",
  "RPC_INVALID_JSON",
  "RPC_ERROR",
  "RPC_RESULT_INVALID",
  "RPC_BODY_LIMIT",
  "RPC_UNAVAILABLE",
  "EVM_CODE_MISSING",
  "EVM_CODE_INVALID",
  "EVM_ABI_INVALID",
  "EVM_FACTORY_MISMATCH",
  "EVM_PAIR_MISMATCH",
  "EVM_TOKEN_INVALID",
  "EVM_DECIMALS_INVALID",
  "EVM_SUPPLY_INVALID",
  "SOLANA_SLOT_INVALID",
  "SOLANA_CONTEXT_BELOW_ANCHOR",
  "SOLANA_ACCOUNT_INVALID",
  "SOLANA_PROGRAM_MISMATCH",
  "SOLANA_LAYOUT_MISMATCH",
  "SOLANA_MINT_INVALID",
  "SOLANA_VAULT_INVALID",
  "SOLANA_CONFIG_INVALID",
  "SCAN_PARTIAL",
  "UNATTEMPTED_BUDGET",
  "ADMISSION_COLLISION",
  "ADMISSION_INVALID",
  "ARTIFACT_INVALID",
  "INTERNAL_ERROR",
]);
const DISCOVERY_ERROR_CODE_SET = new Set(DISCOVERY_ERROR_CODES);

const HEX_RE = /^0x[0-9a-f]*$/iu;
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/iu;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/iu;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/u;
const ALIAS_RE = /^DISCOVERED_(?:POOL_)?[0-9A-F]{16}$/u;
const EVM_CHAINS = new Set([TOKEN_CHAIN_IDS.ethereum, TOKEN_CHAIN_IDS.avalancheC]);
const SOLANA_CHAIN = TOKEN_CHAIN_IDS.solana;
const NETWORKS = Object.freeze(["ethereum", "avalancheC", "solana"]);
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const FINALIZED_AGE_LIMIT_SECONDS = Object.freeze({ ethereum: 1800, avalancheC: 120 });
const FINALIZED_FUTURE_SKEW_SECONDS = 90;

export const EVM_DISCOVERY_SELECTORS = Object.freeze({
  allPairsLength: "0x574f2ba3",
  allPairs: "0x1e3dd18b",
  factoryGetPair: "0xe6a43905",
  pairFactory: "0xc45a0155",
  pairToken0: "0x0dfe1681",
  pairToken1: "0xd21220a7",
  pairGetReserves: "0x0902f1ac",
  tokenDecimals: "0x313ce567",
  tokenSymbol: "0x95d89b41",
  tokenTotalSupply: "0x18160ddd",
});

export const SOLANA_DISCOVERY_LAYOUTS = Object.freeze({
  "orca-whirlpool": Object.freeze({
    dataSize: 653,
    discriminator: "3f95d10ce1806309",
    mintOffsets: Object.freeze([101, 181]),
    vaultOffsets: Object.freeze([133, 213]),
    configOffset: 8,
    liquidityOffset: 49,
    pda: Object.freeze({
      prefixHex: "776869726c706f6f6c",
      seedSlices: Object.freeze([
        Object.freeze({ offset: 8, length: 32 }),
        Object.freeze({ offset: 101, length: 32 }),
        Object.freeze({ offset: 181, length: 32 }),
        Object.freeze({ offset: 43, length: 2 }),
      ]),
      bumpOffset: 40,
    }),
    layoutRevision: "orca-historical-apache-e528dd23bb41571f92cfdb49a2f15d4fa0b01bec-2025-02-26",
  }),
  "raydium-clmm": Object.freeze({
    dataSize: 1544,
    discriminator: "f7ede3f5d7c3de46",
    mintOffsets: Object.freeze([73, 105]),
    vaultOffsets: Object.freeze([137, 169]),
    configOffset: 9,
    liquidityOffset: 237,
    sqrtPriceOffset: 253,
    statusOffset: 389,
    swapDisabledMask: 16,
    seedIndexOffset: 391,
    pda: Object.freeze({
      prefixHex: "706f6f6c",
      seedSlices: Object.freeze([
        Object.freeze({ offset: 9, length: 32 }),
        Object.freeze({ offset: 73, length: 32 }),
        Object.freeze({ offset: 105, length: 32 }),
      ]),
      bumpOffset: 8,
    }),
    layoutRevision: "raydium-apache-ed7c84a54ced59c55981780546adb0b4583dcf85-2025-02-26",
  }),
});

export const SOLANA_LAYOUT_SOURCE_URLS = Object.freeze({
  "orca-whirlpool": "https://raw.githubusercontent.com/orca-so/whirlpools/e528dd23bb41571f92cfdb49a2f15d4fa0b01bec/programs/whirlpool/src/state/whirlpool.rs",
  "raydium-clmm": "https://raw.githubusercontent.com/raydium-io/raydium-clmm/ed7c84a54ced59c55981780546adb0b4583dcf85/programs/amm/src/states/pool.rs",
});

export class DiscoveryValidationError extends Error {
  constructor(message, code = "CONFIG_INVALID") {
    super(message);
    this.name = "DiscoveryValidationError";
    this.code = code;
  }
}

export class DiscoveryRunError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = "DiscoveryRunError";
    this.code = DISCOVERY_ERROR_CODES.includes(code) ? code : "INTERNAL_ERROR";
    this.retryable = options.retryable === true;
    this.statusCode = options.statusCode ?? null;
  }
}

function fail(message, code = "CONFIG_INVALID") {
  throw new DiscoveryValidationError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, { optional = [] } = {}) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} has unknown keys: ${unknown.join(", ")}`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing ${missing.join(", ")}`);
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\u0000]/u.test(value)) fail(`${label} must be a non-empty single-line string`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} through ${max}`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`, "ARTIFACT_INVALID");
  return value;
}

function sourceSha(value, label = "sourceSha") {
  if (typeof value !== "string" || !SOURCE_SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase source SHA`, "SOURCE_SHA_INVALID");
  return value;
}

function deepClone(value) {
  return structuredClone(value);
}

function nowMs(clock) {
  const value = typeof clock === "function" ? clock() : typeof clock?.now === "function" ? clock.now() : clock?.now;
  const number = value === undefined ? Date.now() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function sleep(ms, clock) {
  if (ms <= 0) return Promise.resolve();
  if (clock && typeof clock.sleep === "function") return clock.sleep(ms);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function stableStringify(value) {
  const normalize = (entry) => Array.isArray(entry)
    ? entry.map(normalize)
    : isRecord(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]))
      : entry;
  return JSON.stringify(normalize(value));
}

export function computeDiscoveryConfigDigest(config = defaultConfig) {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function parseHttpsConfigEndpoint(endpoint, network) {
  exactKeys(endpoint, ["endpointId", "chainId", "url", "hostname", "reviewedHosts"], `rpc.${network}`, { optional: ["expectedRpcChainId", "expectedGenesisHash"] });
  string(endpoint.endpointId, `rpc.${network}.endpointId`);
  string(endpoint.chainId, `rpc.${network}.chainId`);
  string(endpoint.url, `rpc.${network}.url`);
  string(endpoint.hostname, `rpc.${network}.hostname`);
  if (!Array.isArray(endpoint.reviewedHosts) || endpoint.reviewedHosts.length === 0) fail(`rpc.${network}.reviewedHosts must be non-empty`);
  let parsed;
  try { parsed = parseHttpsUrl(endpoint.url, `rpc.${network}.url`); } catch { fail(`rpc.${network}.url must be safe credential-free HTTPS`, "CONFIG_INVALID"); }
  if (parsed.hostname.toLowerCase() !== endpoint.hostname.toLowerCase() || !endpoint.reviewedHosts.includes(parsed.hostname.toLowerCase())) fail(`rpc.${network}.hostname is not reviewed`);
  return true;
}

function validateHexAddress(value, label) {
  if (typeof value !== "string" || !EVM_ADDRESS_RE.test(value)) fail(`${label} must be a 20-byte EVM address`);
  return value.toLowerCase();
}

function validateSolanaAddress(value, label) {
  if (typeof value !== "string" || !BASE58_RE.test(value) || decodeBase58(value)?.length !== 32) fail(`${label} must be a 32-byte Solana address`);
  return value;
}

export function validateDiscoveryConfig(config = defaultConfig) {
  exactKeys(config, ["schemaVersion", "configVersion", "rpc", "evm", "solana", "limits", "freshness", "admission", "coverage"], "discovery config");
  if (config.schemaVersion !== DISCOVERY_SCHEMA_VERSION) fail("discovery config schemaVersion must be 1");
  string(config.configVersion, "configVersion");
  for (const network of NETWORKS) {
    if (!isRecord(config.rpc?.[network])) fail(`rpc.${network} is required`);
    parseHttpsConfigEndpoint(config.rpc[network], network);
    if (config.rpc[network].chainId !== TOKEN_CHAIN_IDS[network]) fail(`rpc.${network}.chainId is invalid`);
    if (network !== "solana" && config.rpc[network].expectedRpcChainId !== undefined && config.rpc[network].expectedRpcChainId !== (network === "ethereum" ? "0x1" : "0xa86a")) fail(`rpc.${network}.expectedRpcChainId is invalid`);
    if (network === "solana" && config.rpc[network].expectedGenesisHash !== undefined && config.rpc[network].expectedGenesisHash !== DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash) fail("rpc.solana.expectedGenesisHash is invalid");
  }
  exactKeys(config.evm, ["factories"], "evm");
  if (!Array.isArray(config.evm.factories) || config.evm.factories.length === 0) fail("evm.factories must be non-empty");
  const factoryIds = new Set();
  for (const [index, factory] of config.evm.factories.entries()) {
    exactKeys(factory, ["dexDeploymentId", "network", "factory", "pairScan"], `evm.factories[${index}]`);
    string(factory.dexDeploymentId, `evm.factories[${index}].dexDeploymentId`);
    if (!NETWORKS.slice(0, 2).includes(factory.network)) fail(`evm.factories[${index}].network is invalid`);
    validateHexAddress(factory.factory, `evm.factories[${index}].factory`);
    if (factoryIds.has(factory.dexDeploymentId)) fail(`duplicate factory ${factory.dexDeploymentId}`);
    factoryIds.add(factory.dexDeploymentId);
    exactKeys(factory.pairScan, ["tail", "backfill", "maxPairsPerRun"], `evm.factories[${index}].pairScan`);
    integer(factory.pairScan.tail, "pairScan.tail", { min: 1, max: 10_000 });
    integer(factory.pairScan.backfill, "pairScan.backfill", { min: 1, max: 10_000 });
    integer(factory.pairScan.maxPairsPerRun, "pairScan.maxPairsPerRun", { min: 1, max: 10_000 });
  }
  exactKeys(config.solana, ["programs", "mintPrograms", "anchor", "mintScan"], "solana");
  if (!Array.isArray(config.solana.programs) || config.solana.programs.length === 0) fail("solana.programs must be non-empty");
  const programIds = new Set();
  for (const [index, program] of config.solana.programs.entries()) {
    exactKeys(program, ["dexDeploymentId", "protocol", "program", "layout"], `solana.programs[${index}]`);
    string(program.dexDeploymentId, `solana.programs[${index}].dexDeploymentId`);
    string(program.protocol, `solana.programs[${index}].protocol`);
    validateSolanaAddress(program.program, `solana.programs[${index}].program`);
    if (programIds.has(program.dexDeploymentId)) fail(`duplicate program ${program.dexDeploymentId}`);
    programIds.add(program.dexDeploymentId);
    exactKeys(program.layout, ["dataSize", "discriminator", "mintOffsets", "vaultOffsets", "configOffset"], `solana.programs[${index}].layout`, { optional: ["pda", "liquidityOffset", "sqrtPriceOffset", "statusOffset", "swapDisabledMask", "seedIndexOffset"] });
    integer(program.layout.dataSize, "program.layout.dataSize", { min: 82, max: 2_000_000 });
    if (!/^[0-9a-f]{16}$/u.test(program.layout.discriminator)) fail(`program.layout.discriminator is invalid`);
    for (const [field, offsets] of [["mintOffsets", program.layout.mintOffsets], ["vaultOffsets", program.layout.vaultOffsets]]) {
      if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0 || offset + 32 > program.layout.dataSize)) fail(`program.layout.${field} is invalid`);
    }
    integer(program.layout.configOffset, "program.layout.configOffset", { min: 0, max: program.layout.dataSize - 32 });
    for (const [field, value] of [["liquidityOffset", program.layout.liquidityOffset], ["sqrtPriceOffset", program.layout.sqrtPriceOffset], ["statusOffset", program.layout.statusOffset], ["seedIndexOffset", program.layout.seedIndexOffset]]) if (value !== undefined) integer(value, `program.layout.${field}`, { min: 0, max: program.layout.dataSize - 1 });
    if (program.layout.swapDisabledMask !== undefined) integer(program.layout.swapDisabledMask, "program.layout.swapDisabledMask", { min: 1, max: 255 });
    if (program.layout.pda !== undefined) {
      exactKeys(program.layout.pda, ["prefixHex", "seedSlices", "bumpOffset"], `solana.programs[${index}].layout.pda`);
      if (typeof program.layout.pda.prefixHex !== "string" || !/^[0-9a-f]*$/u.test(program.layout.pda.prefixHex) || program.layout.pda.prefixHex.length % 2 !== 0) fail(`program.layout.pda.prefixHex is invalid`);
      if (!Array.isArray(program.layout.pda.seedSlices) || program.layout.pda.seedSlices.some((slice) => !isRecord(slice) || !Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.length) || slice.offset < 0 || slice.length < 1 || slice.offset + slice.length > program.layout.dataSize)) fail(`program.layout.pda.seedSlices is invalid`);
      integer(program.layout.pda.bumpOffset, "program.layout.pda.bumpOffset", { min: 0, max: program.layout.dataSize - 1 });
    }
  }
  if (!Array.isArray(config.solana.mintPrograms) || config.solana.mintPrograms.length === 0 || config.solana.mintPrograms.some((program) => !BASE58_RE.test(program) || decodeBase58(program)?.length !== 32)) fail("solana.mintPrograms is invalid");
  exactKeys(config.solana.anchor, ["commitment", "minContextSlot"], "solana.anchor");
  if (config.solana.anchor.commitment !== "finalized") fail("solana.anchor.commitment must be finalized");
  integer(config.solana.anchor.minContextSlot, "solana.anchor.minContextSlot");
  exactKeys(config.solana.mintScan, ["maxAccountsPerProgram", "dataSize"], "solana.mintScan", { optional: ["enabled", "partitions"] });
  if (config.solana.mintScan.enabled !== undefined && typeof config.solana.mintScan.enabled !== "boolean") fail("solana.mintScan.enabled is invalid");
  if (config.solana.mintScan.partitions !== undefined && (!Array.isArray(config.solana.mintScan.partitions) || config.solana.mintScan.partitions.some((partition) => !isRecord(partition)))) fail("solana.mintScan.partitions is invalid");
  integer(config.solana.mintScan.maxAccountsPerProgram, "solana.mintScan.maxAccountsPerProgram", { min: 1, max: 10_000 });
  integer(config.solana.mintScan.dataSize, "solana.mintScan.dataSize", { min: 82, max: 500 });
  exactKeys(config.limits, ["runBudgetMs", "rpcTimeoutMs", "rpcRetries", "rpcBodyBytes", "maxConcurrentRequests", "maxAdmissionTokens", "maxAdmissionPools", "maxPending", "maxMultipleAccounts"], "limits");
  integer(config.limits.runBudgetMs, "limits.runBudgetMs", { min: 1, max: DISCOVERY_LIMITS.runBudgetMs });
  integer(config.limits.rpcTimeoutMs, "limits.rpcTimeoutMs", { min: 1, max: DISCOVERY_LIMITS.rpcTimeoutMs });
  integer(config.limits.rpcRetries, "limits.rpcRetries", { min: 0, max: DISCOVERY_LIMITS.rpcRetries });
  integer(config.limits.rpcBodyBytes, "limits.rpcBodyBytes", { min: 1, max: DISCOVERY_LIMITS.rpcBodyBytes });
  integer(config.limits.maxConcurrentRequests, "limits.maxConcurrentRequests", { min: 1, max: DISCOVERY_LIMITS.maxConcurrentRequests });
  integer(config.limits.maxAdmissionTokens, "limits.maxAdmissionTokens", { min: 1, max: DISCOVERY_LIMITS.maxAdmissionTokens });
  integer(config.limits.maxAdmissionPools, "limits.maxAdmissionPools", { min: 1, max: DISCOVERY_LIMITS.maxAdmissionPools });
  integer(config.limits.maxPending, "limits.maxPending", { min: 1, max: DISCOVERY_LIMITS.maxPending });
  integer(config.limits.maxMultipleAccounts, "limits.maxMultipleAccounts", { min: 1, max: DISCOVERY_LIMITS.maxMultipleAccounts });
  exactKeys(config.freshness, ["ethereum", "avalancheC", "solana"], "freshness");
  for (const network of ["ethereum", "avalancheC"]) {
    exactKeys(config.freshness[network], ["maxFinalizedAgeSeconds", "maxFutureSkewSeconds"], `freshness.${network}`);
    integer(config.freshness[network].maxFinalizedAgeSeconds, `freshness.${network}.maxFinalizedAgeSeconds`, { min: 1, max: 86_400 });
    integer(config.freshness[network].maxFutureSkewSeconds, `freshness.${network}.maxFutureSkewSeconds`, { min: 0, max: 3_600 });
  }
  exactKeys(config.freshness.solana, ["maxSlotAgeSeconds", "maxFutureSkewSeconds"], "freshness.solana");
  integer(config.freshness.solana.maxSlotAgeSeconds, "freshness.solana.maxSlotAgeSeconds", { min: 1, max: 86_400 });
  integer(config.freshness.solana.maxFutureSkewSeconds, "freshness.solana.maxFutureSkewSeconds", { min: 0, max: 3_600 });
  exactKeys(config.admission, ["quoteEligiblePoolIds", "tokenPolicy", "selectionPolicy", "poolQualification", "requiredReview", "aliasPrefix", "poolAliasPrefix"], "admission");
  if (!Array.isArray(config.admission.quoteEligiblePoolIds) || config.admission.quoteEligiblePoolIds.some((id) => typeof id !== "string")) fail("admission.quoteEligiblePoolIds is invalid");
  if (config.admission.tokenPolicy !== "qualified-pool-dependencies" || config.admission.selectionPolicy !== "chain-round-robin-liquidity-desc") fail("admission selection policy is invalid");
  exactKeys(config.admission.poolQualification, ["kind", "sources"], "admission.poolQualification");
  if (config.admission.poolQualification.kind !== "direct-reviewed-native-v1" || !isRecord(config.admission.poolQualification.sources)) fail("admission pool qualification is invalid");
  for (const chainId of Object.values(TOKEN_CHAIN_IDS)) {
    exactKeys(config.admission.poolQualification.sources[chainId], ["nativeWrapDeploymentId", "minNativeLiquidity"], `admission.poolQualification.sources.${chainId}`);
    string(config.admission.poolQualification.sources[chainId].nativeWrapDeploymentId, "nativeWrapDeploymentId");
    if (!/^[1-9][0-9]*$/u.test(config.admission.poolQualification.sources[chainId].minNativeLiquidity)) fail(`admission pool floor ${chainId} is invalid`);
  }
  if (config.admission.requiredReview !== true || config.admission.aliasPrefix !== "DISCOVERED_" || config.admission.poolAliasPrefix !== "DISCOVERED_POOL_") fail("admission policy is invalid");
  exactKeys(config.coverage, ["mode", "partialClaim", "description"], "coverage");
  if (config.coverage.mode !== "bounded" || config.coverage.partialClaim !== false) fail("coverage must be bounded and non-claiming");
  string(config.coverage.description, "coverage.description");
  return true;
}

function normalizeConfig(input) {
  const config = deepClone(input ?? defaultConfig);
  validateDiscoveryConfig(config);
  return config;
}

function normalizeRpcResponse(value) {
  if (value && isRecord(value) && Object.hasOwn(value, "error")) {
    const error = value.error;
    const wrapped = new DiscoveryRunError("RPC_ERROR", "RPC error");
    wrapped.rpcCode = Number(error?.code);
    wrapped.rpcTransient = /temporar|unavailable|timeout|rate.?limit|backend|syncing|min(?:imum)?[ -]?context|slot.*(?:behind|reached)|behind/iu.test(String(error?.message ?? ""));
    wrapped.retryable = wrapped.rpcTransient;
    throw wrapped;
  }
  if (value && isRecord(value) && Object.hasOwn(value, "result") && Object.keys(value).every((key) => ["jsonrpc", "id", "result"].includes(key))) return value.result;
  return value;
}

function credentials(options, endpoint) {
  const headers = options.rpcHeaders ?? options.rpcAuth?.[endpoint.endpointId] ?? options.rpcAuth?.[endpoint.chainId] ?? options.rpcAuth;
  const result = [];
  for (const [key, value] of Object.entries(headers?.headers ?? headers ?? {})) if (/auth|token|secret|key|credential|cookie/iu.test(key)) {
    result.push(String(value), String(value).replace(/^(?:Bearer|Basic|ApiKey)\s+/iu, ""));
  }
  try {
    const parsed = new URL(endpoint.url);
    for (const value of parsed.searchParams.values()) result.push(String(value));
  } catch {
    // Config validation will report malformed URLs.
  }
  return result.filter((value) => value.length > 0);
}

function echoesCredential(value, options, endpoint) {
  if (typeof value !== "string") return false;
  return credentials(options, endpoint).some((credential) => credential === value || value.includes(credential) || credential.includes(value));
}

async function bodyBuffer(value, maxBytes = DISCOVERY_LIMITS.rpcBodyBytes) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (value && typeof value[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let length = 0;
    for await (const chunk of value) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) throw new DiscoveryRunError("RPC_BODY_LIMIT");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(JSON.stringify(value));
}

function decodeBody(buffer, headers, maxBytes) {
  const encoding = String(headers?.["content-encoding"] ?? headers?.["Content-Encoding"] ?? "").split(",")[0].trim().toLowerCase();
  try {
    const decoded = !encoding || encoding === "identity"
      ? buffer
      : encoding === "gzip" || encoding === "x-gzip"
        ? gunzipSync(buffer, { maxOutputLength: maxBytes })
        : encoding === "deflate"
          ? inflateSync(buffer, { maxOutputLength: maxBytes })
          : encoding === "br"
            ? brotliDecompressSync(buffer, { maxOutputLength: maxBytes })
            : (() => { throw new DiscoveryRunError("RPC_RESULT_INVALID"); })();
    if (decoded.length > maxBytes) throw new DiscoveryRunError("RPC_BODY_LIMIT");
    return decoded;
  } catch (error) {
    if (error instanceof DiscoveryRunError) throw error;
    if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new DiscoveryRunError("RPC_BODY_LIMIT");
    throw new DiscoveryRunError("RPC_RESULT_INVALID");
  }
}

function invokeTransport(transport, request) {
  if (!transport) return requestHttpsTransport(request);
  if (typeof transport === "function") return transport.length >= 2 ? transport(request.url, request) : transport(request);
  if (typeof transport.request === "function") return transport.request.length >= 2 ? transport.request(request.url, request) : transport.request(request);
  if (typeof transport.rpc === "function") return transport.rpc(request);
  throw new DiscoveryRunError("INTERNAL_ERROR");
}

async function requestBounded(transport, request, { deadline, timeoutMs, retries, maxBytes, clock }) {
  let attempt = 0;
  while (true) {
    if (nowMs(clock) >= deadline()) throw new DiscoveryRunError("RPC_RUN_BUDGET_EXCEEDED");
    const remaining = Math.max(1, deadline() - nowMs(clock));
    const timeout = Math.min(timeoutMs, remaining);
    const controller = new AbortController();
    let timer;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiscoveryRunError(timeout < timeoutMs ? "RPC_RUN_BUDGET_EXCEEDED" : "RPC_TIMEOUT"));
        }, timeout);
      });
      const result = await Promise.race([
        invokeTransport(transport, { ...request, signal: request.signal ?? controller.signal, timeoutMs: timeout, compressedBodyLimit: maxBytes * 8, bodyLimitCode: "RPC_BODY_LIMIT", attempt }),
        timeoutPromise,
      ]);
      const normalized = {
        statusCode: Number(result?.statusCode ?? result?.status ?? 200),
        headers: result?.headers ?? {},
        body: result?.body ?? result?.data ?? result,
      };
      if (normalized.statusCode < 200 || normalized.statusCode >= 300) {
        const error = new DiscoveryRunError(normalized.statusCode === 429 ? "RPC_RATE_LIMITED" : "RPC_UPSTREAM_ERROR", "RPC HTTP error", { retryable: RETRYABLE_HTTP.has(normalized.statusCode), statusCode: normalized.statusCode });
        if (error.retryable && attempt < retries) { await sleep(Math.min(100 * (2 ** attempt), 1000), clock); attempt += 1; continue; }
        throw error;
      }
      return decodeBody(await bodyBuffer(normalized.body, maxBytes), normalized.headers, maxBytes);
    } catch (error) {
      const retryable = error?.retryable === true || ["RPC_TIMEOUT", "RPC_RUN_BUDGET_EXCEEDED", "RPC_RATE_LIMITED", "RPC_UPSTREAM_ERROR", "RPC_UNAVAILABLE"].includes(error?.code) || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code);
      if (retryable && attempt < retries && error?.code !== "RPC_RUN_BUDGET_EXCEEDED") { await sleep(Math.min(100 * (2 ** attempt), 1000), clock); attempt += 1; continue; }
      if (error instanceof DiscoveryRunError) throw error;
      throw new DiscoveryRunError("RPC_UNAVAILABLE");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

export function createBoundedRpcClient(options = {}, config = defaultConfig) {
  const normalizedConfig = normalizeConfig(config);
  const start = nowMs(options.clock);
  const runBudget = Math.min(options.runBudgetMs ?? normalizedConfig.limits.runBudgetMs, normalizedConfig.limits.runBudgetMs, DISCOVERY_LIMITS.runBudgetMs);
  const deadline = () => start + runBudget;
  let id = 1;
  const calls = [];
  const transcript = [];
  const requestTransport = options.rpcTransport ?? options.rpcRequest ?? options.transport ?? options.request ?? (options.rpc ? async (request) => {
    const networkProvider = options.rpc?.[request.network] ?? options.rpc;
    const payload = JSON.parse(request.body.toString("utf8"));
    if (typeof networkProvider === "function") {
      const value = await networkProvider(payload.method, payload.params, request);
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: value }) };
    }
    if (networkProvider && typeof networkProvider.request === "function") {
      const value = await networkProvider.request(payload.method, payload.params, request);
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: value }) };
    }
    throw new DiscoveryRunError("CONFIG_INVALID");
  } : null);
  const client = async (network, method, params = []) => {
    const endpoint = normalizedConfig.rpc[network] ?? network;
    if (!endpoint || !endpoint.endpointId) throw new DiscoveryRunError("CONFIG_INVALID");
    const payload = { jsonrpc: "2.0", id: id++, method, params };
    const request = {
      kind: "rpc",
      network,
      endpointId: endpoint.endpointId,
      url: endpoint.url,
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(options.rpcHeaders?.headers ?? options.rpcHeaders ?? {}) },
      body: Buffer.from(JSON.stringify(payload)),
      resolver: options.resolver,
    };
    let attempt = 0;
    while (true) {
      try {
        const body = await requestBounded(requestTransport, request, {
          deadline,
          timeoutMs: normalizedConfig.limits.rpcTimeoutMs,
          retries: normalizedConfig.limits.rpcRetries,
          maxBytes: normalizedConfig.limits.rpcBodyBytes,
          clock: options.clock,
        });
        let parsed;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new DiscoveryRunError("RPC_INVALID_JSON"); }
        if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== payload.id) throw new DiscoveryRunError("RPC_RESULT_INVALID");
        if (echoesCredential(JSON.stringify(parsed?.result), options, endpoint)) throw new DiscoveryRunError("RPC_RESULT_INVALID");
        const result = normalizeRpcResponse(parsed);
        transcript.push({
          network,
          endpointId: endpoint.endpointId,
          observedAt: new Date(nowMs(options.clock)).toISOString(),
          request: { jsonrpc: "2.0", id: payload.id, method, params: deepClone(params) },
          response: { jsonrpc: "2.0", id: payload.id, result: boundedTranscriptValue(result, normalizedConfig.limits.rpcBodyBytes) },
        });
        calls.push({ network, endpointId: endpoint.endpointId, method, params: deepClone(params) });
        return result;
      } catch (error) {
        if (error?.retryable === true && attempt < normalizedConfig.limits.rpcRetries) { await sleep(Math.min(100 * (2 ** attempt), 1000), options.clock); attempt += 1; continue; }
        const code = typeof error?.code === "string" && DISCOVERY_ERROR_CODE_SET.has(error.code) ? error.code : "RPC_ERROR";
        transcript.push({
          network,
          endpointId: endpoint.endpointId,
          observedAt: new Date(nowMs(options.clock)).toISOString(),
          request: { jsonrpc: "2.0", id: payload.id, method, params: deepClone(params) },
          response: { jsonrpc: "2.0", id: payload.id, error: { code } },
        });
        throw error;
      }
    }
  };
  client.calls = calls;
  client.transcript = transcript;
  client.deadline = deadline;
  client.config = normalizedConfig;
  return client;
}

function withRpcConcurrency(client, limit, deadline, clock) {
  const waiting = [];
  let active = 0;
  const acquire = () => new Promise((resolveAcquire) => {
    if (active < limit) { active += 1; resolveAcquire(); return; }
    waiting.push(resolveAcquire);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  };
  return async (...args) => {
    await acquire();
    try {
      const remaining = deadline(...args) - nowMs(clock);
      if (remaining <= 0) throw new DiscoveryRunError("RPC_RUN_BUDGET_EXCEEDED");
      let timer;
      try {
        return await Promise.race([
          client(...args),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new DiscoveryRunError("RPC_RUN_BUDGET_EXCEEDED")), remaining); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally { release(); }
  };
}

async function callRpc(client, network, method, params) {
  if (typeof client === "function") return normalizeRpcResponse(await client(network, method, params));
  if (client && typeof client.request === "function") return normalizeRpcResponse(await client.request(method, params));
  if (client && typeof client.call === "function") return normalizeRpcResponse(await client.call(method, params));
  throw new DiscoveryRunError("CONFIG_INVALID");
}

async function mapBounded(values, limit, worker) {
  const result = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      try { result[index] = await worker(values[index], index); } catch (error) { result[index] = { error }; }
    }
  });
  await Promise.all(workers);
  return result;
}

function blockTag(blockHash) {
  return { blockHash, requireCanonical: true };
}

function hexQuantity(value, label, { maxBits = 256 } = {}) {
  if (typeof value !== "string" || !HEX_QUANTITY_RE.test(value)) throw new DiscoveryRunError("EVM_ABI_INVALID", `${label} is not a hex quantity`);
  const number = BigInt(value);
  if (number < 0n || number >= (1n << BigInt(maxBits))) throw new DiscoveryRunError("EVM_ABI_INVALID", `${label} is out of range`);
  return number;
}

function hexBytes(value, label, { bytes = null } = {}) {
  if (typeof value !== "string" || !HEX_RE.test(value) || value.length % 2 !== 0) throw new DiscoveryRunError("EVM_ABI_INVALID", `${label} is not bytes`);
  if (bytes !== null && value.length !== bytes * 2 + 2) throw new DiscoveryRunError("EVM_ABI_INVALID", `${label} has invalid length`);
  return value.toLowerCase();
}

function word(result, index = 0) {
  const value = hexBytes(result, "ABI result");
  const start = 2 + index * 64;
  if (value.length < start + 64) throw new DiscoveryRunError("EVM_ABI_INVALID");
  return value.slice(start, start + 64);
}

function wordQuantity(result, index = 0) {
  const bytes = hexBytes(result, "ABI quantity");
  if (index === 0 && bytes.length > 2 && bytes.length <= 66) return BigInt(bytes);
  return BigInt(`0x${word(result, index)}`);
}

function readU128LE(data, offset) {
  if (!Buffer.isBuffer(data) || offset < 0 || data.length < offset + 16) return null;
  return (data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n)).toString();
}

function validToken2022Framing(data, baseLength, accountType) {
  if (!data || data.length === baseLength) return true;
  if (data.length < 166 || data.length > 10_000) return false;
  for (let offset = baseLength; offset < 165; offset += 1) if (data[offset] !== 0) return false;
  if (data[165] !== accountType) return false;
  let offset = 166;
  while (offset < data.length) {
    if (offset + 4 > data.length) return false;
    const extensionType = data.readUInt16LE(offset);
    const extensionLength = data.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + extensionLength > data.length) return false;
    // Framing validation only proves that the account has a bounded, valid
    // extension area.  Extension semantics (including close authority) are a
    // separate admission/review decision and must not be smuggled into this
    // byte-layout check.
    if (extensionType === 0 && extensionLength !== 0) return false;
    offset += extensionLength;
  }
  return offset === data.length;
}

export { validToken2022Framing };

export { readU128LE };

function wordAddress(result, index = 0) {
  const encoded = word(result, index);
  if (!/^0{24}$/u.test(encoded.slice(0, 24))) throw new DiscoveryRunError("EVM_ABI_INVALID");
  const address = `0x${encoded.slice(-40)}`.toLowerCase();
  if (!EVM_ADDRESS_RE.test(address)) throw new DiscoveryRunError("EVM_ABI_INVALID");
  return address;
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(value) {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function decodeAbiString(result) {
  const value = hexBytes(result, "symbol result");
  if (value === "0x") throw new DiscoveryRunError("EVM_ABI_INVALID");
  if (value.length >= 2 + 128) {
    try {
      const offset = Number(BigInt(`0x${value.slice(2, 66)}`));
      const length = Number(BigInt(`0x${value.slice(2 + offset * 2, 2 + offset * 2 + 64)}`));
      if (offset <= 4096 && length >= 0 && 2 + offset * 2 + 64 + length * 2 <= value.length) return Buffer.from(value.slice(2 + offset * 2 + 64, 2 + offset * 2 + 64 + length * 2), "hex").toString("utf8");
    } catch {
      // Try bytes32 below; malformed values are rejected by the caller.
    }
  }
  if (value.length >= 66) return Buffer.from(value.slice(2, 66), "hex").toString("utf8").replaceAll("\u0000", "");
  throw new DiscoveryRunError("EVM_ABI_INVALID");
}

function safeObservedSymbol(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\r\n\u0000]/u.test(value)) return null;
  if (!/^[\x20-\x7e\u0080-\uffff]+$/u.test(value)) return null;
  return value;
}

function decodeBase58(value) {
  if (typeof value !== "string" || !value.length) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let leading = 0;
  while (value[leading] === "1") leading += 1;
  const numeric = bytes.reverse();
  if (numeric.length === 1 && numeric[0] === 0) return Uint8Array.from({ length: leading }, () => 0);
  return Uint8Array.from([...Array.from({ length: leading }, () => 0), ...numeric]);
}

function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const input = Uint8Array.from(bytes);
  if (input.length === 0) return "";
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let leading = 0;
  while (leading < input.length && input[leading] === 0) leading += 1;
  const encodedDigits = digits.reverse();
  while (encodedDigits.length > 1 && encodedDigits[0] === 0) encodedDigits.shift();
  if (encodedDigits.length === 1 && encodedDigits[0] === 0) encodedDigits.length = 0;
  return `${"1".repeat(leading)}${encodedDigits.map((digit) => alphabet[digit]).join("")}`;
}

export { decodeBase58, encodeBase58 };

function base58Bytes(value, label) {
  const bytes = decodeBase58(value);
  if (!bytes || bytes.length !== 32) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID", `${label} is not a pubkey`);
  return bytes;
}

function bytesEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Check a PDA using the stored bump from an account. This is intentionally a
 * check only: it never searches bump values and never executes program code.
 * The seed bytes are supplied by the reviewed layout, so opaque historical
 * seed fields remain opaque bytes instead of being reinterpreted.
 */
export function deriveSolanaPoolPda(programAddress, data, pdaLayout) {
  if (!pdaLayout || !isRecord(pdaLayout)) return null;
  const programBytes = base58Bytes(programAddress, "program address");
  const prefix = Buffer.from(pdaLayout.prefixHex ?? "", "hex");
  const seedParts = [prefix];
  for (const slice of pdaLayout.seedSlices ?? []) seedParts.push(Buffer.from(data.subarray(slice.offset, slice.offset + slice.length)));
  seedParts.push(Buffer.from([data[pdaLayout.bumpOffset]]), Buffer.from(programBytes), Buffer.from("ProgramDerivedAddress"));
  return encodeBase58(createHash("sha256").update(Buffer.concat(seedParts)).digest());
}

export function verifySolanaPoolPda(pubkey, programAddress, data, pdaLayout) {
  const expected = deriveSolanaPoolPda(programAddress, data, pdaLayout);
  return expected === null || expected === pubkey;
}

export const deriveSolanaPda = deriveSolanaPoolPda;
export const isSolanaPoolPda = verifySolanaPoolPda;

function accountData(account) {
  if (!isRecord(account)) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
  if (Array.isArray(account.data) && account.data[1] === "base64" && typeof account.data[0] === "string") {
    try { return Buffer.from(account.data[0], "base64"); } catch { throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID"); }
  }
  if (typeof account.data === "string") {
    try { return Buffer.from(account.data, "base64"); } catch { throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID"); }
  }
  if (isRecord(account.data) && Array.isArray(account.data.parsed?.info)) return null;
  return null;
}

function accountOwner(account) {
  return typeof account?.owner === "string" ? account.owner : account?.data?.parsed?.info?.owner ?? null;
}

function parsedAccountInfo(account) {
  return account?.data?.parsed?.info ?? account?.parsed?.info ?? null;
}

function solanaResultContext(result) {
  if (isRecord(result) && isRecord(result.context)) {
    if (!Number.isSafeInteger(result.context.slot) || result.context.slot < 0) throw new DiscoveryRunError("SOLANA_SLOT_INVALID");
    return { context: result.context, value: result.value };
  }
  return { context: {}, value: result };
}

function requireContextSlot(context, anchor) {
  if (!Number.isSafeInteger(context.slot) || context.slot < anchor) throw new DiscoveryRunError("SOLANA_CONTEXT_BELOW_ANCHOR");
  return context.slot;
}

async function finalizedSolanaAnchor(client, minimum) {
  const raw = await callRpc(client, "solana", "getSlot", [{ commitment: "finalized" }]);
  const slot = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(slot) || slot < 0) throw new DiscoveryRunError("SOLANA_SLOT_INVALID");
  return Math.max(minimum, slot);
}

function deriveHash(kind, chainId, address, dexDeploymentId = "") {
  const normalized = EVM_CHAINS.has(chainId) ? address.toLowerCase() : address;
  return createHash("sha256").update(`${kind}\u0000${chainId}\u0000${normalized}${dexDeploymentId ? `\u0000${dexDeploymentId}` : ""}`).digest("hex");
}

export function deriveDiscoveryHash(kind, chainId, address, dexDeploymentId = "") {
  return deriveHash(kind, chainId, address, dexDeploymentId);
}

export function deriveDiscoveredId(kind, chainId, address, dexDeploymentId = "") {
  if (!string(kind, "kind") || !string(chainId, "chainId") || !string(address, "address")) throw new DiscoveryValidationError("discovery identity is invalid", "ADMISSION_INVALID");
  const hash = deriveHash(kind, chainId, address, dexDeploymentId);
  return `${kind === "pool" ? "discovered-pool-" : "discovered-token-"}${hash}`;
}

export const discoveredId = deriveDiscoveredId;

export function deriveDiscoveredAlias(kind, chainId, address, dexDeploymentId = "") {
  const hash = deriveHash(kind, chainId, address, dexDeploymentId).slice(0, 16).toUpperCase();
  return `${kind === "pool" ? "DISCOVERED_POOL_" : "DISCOVERED_"}${hash}`;
}

export const discoveredAlias = deriveDiscoveredAlias;

function tokenMaps(catalog) {
  const byBinding = new Map();
  const byId = new Map();
  for (const deployment of catalog.deployments) {
    byId.set(deployment.deploymentId, deployment);
    if (deployment.address !== null) byBinding.set(`${deployment.chainId}\u0000${normalizeTokenAddress(deployment.chainId, deployment.address)}`, deployment);
  }
  return { byBinding, byId };
}

function dexMaps(catalog) {
  const byId = new Map(catalog.dexDeployments.map((entry) => [entry.dexDeploymentId, entry]));
  const poolsByBinding = new Map(catalog.poolDefinitions.map((entry) => [`${entry.chainId}\u0000${EVM_CHAINS.has(entry.chainId) ? entry.address.toLowerCase() : entry.address}`, entry]));
  return { byId, poolsByBinding };
}

function canonicalTokenProposal({ chainId, address, standard, decimals, observedSymbol, evidence, tokenCatalogValue, tokenReceipt }) {
  const id = deriveDiscoveredId("token", chainId, address);
  const canonicalSymbol = address;
  const normalizedAddress = EVM_CHAINS.has(chainId) ? address.toLowerCase() : address;
  const known = tokenCatalogValue ?? null;
  const alias = deriveDiscoveredAlias("token", chainId, address);
  return {
    kind: "token",
    id,
    assetId: id,
    deploymentId: id,
    alias,
    chainId,
    address: normalizedAddress,
    canonical: {
      name: `Unclassified token at ${normalizedAddress}`,
      symbol: canonicalSymbol,
      representationKind: "unclassified",
      stableCurrency: null,
      underlyingAssetId: null,
      economicReferenceAssetId: null,
      standard,
      decimals,
      status: "active",
      replacedByDeploymentId: null,
    },
    evidence: [{ ...evidence, observedSymbol: observedSymbol ?? null, token: tokenReceipt ? {
      address: tokenReceipt.address ?? normalizedAddress,
      decimals: tokenReceipt.decimals,
      supply: tokenReceipt.supply,
      ...(tokenReceipt.observedSymbol ? { observedSymbol: tokenReceipt.observedSymbol } : {}),
      ...(tokenReceipt.standard ? { standard: tokenReceipt.standard } : {}),
    } : null }],
    quoteEligible: false,
    reviewRequired: true,
    ...(known ? { knownDeploymentId: known.deploymentId } : {}),
  };
}

function canonicalPoolProposal({ chainId, address, dexDeploymentId, token0Address, token1Address, token0DeploymentId, token1DeploymentId, evidence, tokenCatalogValue }) {
  const id = deriveDiscoveredId("pool", chainId, address, dexDeploymentId);
  const normalizedAddress = EVM_CHAINS.has(chainId) ? address.toLowerCase() : address;
  const adapterKind = EVM_CHAINS.has(chainId) ? "evm-constant-product-v2" : dexDeploymentId === "dex-deployment-0004" ? "solana-raydium-clmm" : "solana-orca-whirlpool";
  const quoteEligible = false;
  return {
    kind: "pool",
    id,
    poolDefinitionId: id,
    alias: deriveDiscoveredAlias("pool", chainId, address, dexDeploymentId),
    chainId,
    address: normalizedAddress,
    dexDeploymentId,
    token0Address,
    token1Address,
    canonical: {
      poolDefinitionId: id,
      dexDeploymentId,
      chainId,
      address: normalizedAddress,
      token0DeploymentId: token0DeploymentId ?? deriveDiscoveredId("token", chainId, token0Address),
      token1DeploymentId: token1DeploymentId ?? deriveDiscoveredId("token", chainId, token1Address),
      adapter: { kind: adapterKind, feeNumerator: EVM_CHAINS.has(chainId) ? "3" : null, feeDenominator: EVM_CHAINS.has(chainId) ? "1000" : null },
      status: "active",
      replacedByPoolDefinitionId: null,
    },
    evidence: [evidence],
    quoteEligible,
    reviewRequired: true,
  };
}

function receipt(kind, network, status, subjectId, fields = {}) {
  const row = { kind, network, status, subjectId, ...fields };
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row;
}

function boundedRaw(value, maxBytes = DISCOVERY_LIMITS.rpcBodyBytes) {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes <= 1024) return value;
    return { encoding: "gzip-base64", data: gzipSync(Buffer.from(value)).toString("base64"), sha256: createHash("sha256").update(value).digest("hex"), bytes, bounded: bytes <= maxBytes };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    if (bytes.length <= maxBytes) return bytes.toString("base64");
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  if (Array.isArray(value)) return value.map((entry) => boundedRaw(entry, maxBytes));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundedRaw(entry, maxBytes)]));
  return value;
}

function boundedTranscriptValue(value, maxBytes = DISCOVERY_LIMITS.rpcBodyBytes) {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes <= 1024) return value;
    return { encoding: "gzip-base64", data: gzipSync(Buffer.from(value)).toString("base64"), sha256: createHash("sha256").update(value).digest("hex"), bytes };
  }
  if (Array.isArray(value)) return value.map((entry) => boundedTranscriptValue(entry, maxBytes));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, boundedTranscriptValue(entry, maxBytes)]));
  return value;
}

function validateBoundedCode(value, label) {
  if (typeof value === "string") {
    if (hexBytes(value, label).length <= 2) throw new DiscoveryValidationError(`${label} is empty`, "ARTIFACT_INVALID");
    return true;
  }
  if (isRecord(value) && value.encoding === "gzip-base64" && typeof value.data === "string" && typeof value.sha256 === "string" && DIGEST_RE.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0) {
    try {
      const decoded = gunzipSync(Buffer.from(value.data, "base64"));
      if (decoded.length !== value.bytes || createHash("sha256").update(decoded).digest("hex") !== value.sha256 || decoded.length === 0) throw new Error("compressed raw code mismatch");
      return true;
    } catch { throw new DiscoveryValidationError(`${label} is not bounded raw code`, "ARTIFACT_INVALID"); }
  }
  throw new DiscoveryValidationError(`${label} is not bounded raw code`, "ARTIFACT_INVALID");
}

function rawAccount(account) {
  const data = accountData(account);
  if (!data) return null;
  return {
    owner: accountOwner(account),
    lamports: Number.isSafeInteger(Number(account.lamports)) ? Number(account.lamports) : null,
    executable: account.executable === true,
    data: data.toString("base64"),
  };
}

function defaultWorkspace(options) {
  const workspace = options.workspace ?? { clean: true, pinned: true };
  const clean = workspace.clean === true;
  const pinned = workspace.pinned === true;
  return { clean, pinned, promotable: clean && pinned && options.liveEvidence !== true };
}

function initialState({ configDigest, tokenDigest, dexDigest, priorState }) {
  const state = isRecord(priorState) ? deepClone(priorState) : {};
  state.schemaVersion = DISCOVERY_SCHEMA_VERSION;
  state.artifactKind = "discovery-state";
  state.configDigest = configDigest;
  state.tokenCatalogDigest = tokenDigest;
  state.dexCatalogDigest = dexDigest;
  state.factories = isRecord(state.factories) ? state.factories : {};
  state.programs = isRecord(state.programs) ? state.programs : {};
  state.mints = isRecord(state.mints) ? state.mints : {};
  return state;
}

function factoryState(state, id) {
  const current = isRecord(state.factories[id]) ? state.factories[id] : {};
  return {
    count: Number.isSafeInteger(current.count) ? current.count : 0,
    backfillNext: Number.isSafeInteger(current.backfillNext) ? current.backfillNext : Number.isSafeInteger(current.backfillCursor) ? current.backfillCursor : 0,
    pendingIndexes: Array.isArray(current.pendingIndexes) ? current.pendingIndexes.filter((entry) => Number.isSafeInteger(entry) && entry >= 0) : [],
    completedIndexes: Array.isArray(current.completedIndexes) ? current.completedIndexes.filter((entry) => Number.isSafeInteger(entry) && entry >= 0) : [],
    lastBlockNumber: typeof current.lastBlockNumber === "string" ? current.lastBlockNumber : null,
    lastBlockHash: typeof current.lastBlockHash === "string" ? current.lastBlockHash : null,
  };
}

function orderedUnique(numbers) {
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function factoryScanPlan(current, factory, count) {
  const scan = factory.pairScan;
  const tailStart = Math.max(0, count - scan.tail);
  const pending = orderedUnique(current.pendingIndexes.filter((index) => index < count));
  const tail = Array.from({ length: Math.max(0, count - tailStart) }, (_, index) => tailStart + index);
  const backfill = Array.from({ length: Math.max(0, Math.min(scan.backfill, tailStart - current.backfillNext)) }, (_, index) => current.backfillNext + index);
  const streams = [backfill, tail, pending];
  const interleaved = [];
  let streamIndex = 0;
  while (interleaved.length < scan.maxPairsPerRun && streams.some((stream) => stream.length > 0)) {
    const stream = streams[streamIndex % streams.length];
    if (stream.length > 0) interleaved.push(stream.shift());
    streamIndex += 1;
  }
  return { tailStart, planned: orderedUnique(interleaved).slice(0, scan.maxPairsPerRun) };
}

function updateFactoryState(state, id, current, { count, backfillLimit, tailStart, attempted, succeeded }) {
  const previousCompleted = new Set(current.completedIndexes.filter((index) => index < count));
  const failed = new Set(current.pendingIndexes.filter((index) => index < count));
  const scanned = new Set(attempted);
  for (const index of attempted) {
    if (succeeded.has(index)) { previousCompleted.add(index); failed.delete(index); } else failed.add(index);
  }
  let next = Math.min(Math.max(0, current.backfillNext), tailStart);
  // Backfill progress tracks indexes that were actually scanned.  A failed
  // index stays in the retry queue, but it must not pin the cursor forever.
  while (next < tailStart && (previousCompleted.has(next) || scanned.has(next))) next += 1;
  state.factories[id] = {
    count,
    tailCursor: count,
    backfillCursor: next,
    backfillNext: next,
    pendingIndexes: orderedUnique([...failed]),
    completedIndexes: orderedUnique([...previousCompleted].filter((entry) => entry < tailStart)),
    lastBlockNumber: state.__lastBlockNumber ?? null,
    lastBlockHash: state.__lastBlockHash ?? null,
  };
  delete state.__lastBlockNumber;
  delete state.__lastBlockHash;
  return { next, pending: state.factories[id].pendingIndexes.length, budgeted: attempted.length >= backfillLimit };
}

async function finalizedEvmAnchor(client, network) {
  const chainRaw = await callRpc(client, network, "eth_chainId", []);
  const expected = network === "ethereum" ? "0x1" : "0xa86a";
  if (typeof chainRaw !== "string" || chainRaw.toLowerCase() !== expected) throw new DiscoveryRunError("NETWORK_IDENTITY_MISMATCH");
  const block = await callRpc(client, network, "eth_getBlockByNumber", ["finalized", false]);
  const blockHash = block?.hash ?? block?.blockHash;
  if (!isRecord(block) || typeof blockHash !== "string" || !EVM_ADDRESS_RE.test(`0x${blockHash.replace(/^0x/iu, "").slice(0, 40)}`) || typeof block.number !== "string" || !HEX_QUANTITY_RE.test(block.number)) throw new DiscoveryRunError("FINALIZED_BLOCK_INVALID");
  const hash = blockHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(hash)) throw new DiscoveryRunError("FINALIZED_BLOCK_INVALID");
  return { number: hexQuantity(block.number, "finalized.number"), hash, timestamp: typeof block.timestamp === "string" && HEX_QUANTITY_RE.test(block.timestamp) ? hexQuantity(block.timestamp, "finalized.timestamp") : null };
}

function assertEvmAnchorFresh(anchor, network, options = {}) {
  if (anchor.timestamp === null) return;
  const current = BigInt(Math.floor(nowMs(options.clock) / 1000));
  const age = current - anchor.timestamp;
  const maxAge = BigInt(options.maxFinalizedAgeSeconds?.[network] ?? options.freshness?.[network]?.maxFinalizedAgeSeconds ?? FINALIZED_AGE_LIMIT_SECONDS[network]);
  const futureSkew = BigInt(options.maxFinalizedFutureSkewSeconds ?? options.freshness?.[network]?.maxFutureSkewSeconds ?? FINALIZED_FUTURE_SKEW_SECONDS);
  if (age > maxAge || age < -futureSkew) throw new DiscoveryRunError("FINALIZED_BLOCK_STALE");
}

async function readEvmFactory(factory, client, state, config, tokenMapsValue, dexMapsValue, receipts, proposals, networkStatus, options = {}) {
  const scan = factory.pairScan;
  let anchor;
  try { anchor = await finalizedEvmAnchor(client, factory.network); }
  catch (error) {
    const deferred = error.code === "RPC_RUN_BUDGET_EXCEEDED";
    receipts.push(receipt("network", factory.network, deferred ? "skipped" : "failed", factory.network, { code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "NETWORK_IDENTITY_INVALID", queue: deferred ? "unattempted" : undefined }));
    return { status: "partial", failed: true };
  }
  try { assertEvmAnchorFresh(anchor, factory.network, { ...options, freshness: config.freshness }); } catch (error) {
    receipts.push(receipt("evm-factory", factory.network, "failed", factory.dexDeploymentId, { dexDeploymentId: factory.dexDeploymentId, code: error.code ?? "FINALIZED_BLOCK_STALE", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, address: factory.factory }));
    return { status: "partial", failed: true };
  }
  try {
    const reread = await callRpc(client, factory.network, "eth_getBlockByNumber", [`0x${anchor.number.toString(16)}`, false]);
    const rereadHash = reread?.hash ?? reread?.blockHash;
    if (typeof rereadHash !== "string" || rereadHash.toLowerCase() !== anchor.hash || typeof reread?.number !== "string" || hexQuantity(reread.number, "finalized reread") !== anchor.number) throw new DiscoveryRunError("FINALIZED_BLOCK_STALE");
  } catch (error) {
    receipts.push(receipt("evm-factory", factory.network, "failed", factory.dexDeploymentId, { dexDeploymentId: factory.dexDeploymentId, code: error.code ?? "FINALIZED_BLOCK_STALE", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, address: factory.factory }));
    return { status: "partial", failed: true };
  }
  const tag = blockTag(anchor.hash);
  let count;
  let factoryCodeRaw;
  let factoryCountRaw;
  try {
    factoryCodeRaw = await callRpc(client, factory.network, "eth_getCode", [factory.factory, tag]);
    const code = hexBytes(factoryCodeRaw, "factory code");
    if (code.length <= 2) throw new DiscoveryRunError("EVM_CODE_MISSING");
    factoryCountRaw = await callRpc(client, factory.network, "eth_call", [{ to: factory.factory, data: EVM_DISCOVERY_SELECTORS.allPairsLength }, tag]);
    count = Number(wordQuantity(factoryCountRaw));
    if (!Number.isSafeInteger(count) || count < 0) throw new DiscoveryRunError("EVM_ABI_INVALID");
  } catch (error) {
    receipts.push(receipt("evm-factory", factory.network, error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "skipped" : "failed", factory.dexDeploymentId, { code: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, address: factory.factory }));
    return { status: "partial", failed: true };
  }
  receipts.push(receipt("evm-factory", factory.network, "success", factory.dexDeploymentId, { dexDeploymentId: factory.dexDeploymentId, address: factory.factory, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, ...(anchor.timestamp === null ? {} : { blockTimestamp: anchor.timestamp.toString() }), pairCount: count, request: { method: "eth_call", data: EVM_DISCOVERY_SELECTORS.allPairsLength, blockHash: anchor.hash }, raw: { allPairsLength: factoryCountRaw } }));
  const current = factoryState(state, factory.dexDeploymentId);
  const { tailStart, planned } = factoryScanPlan(current, factory, count);
  const attempted = planned;
  const pairResults = await mapBounded(attempted, config.limits.maxConcurrentRequests, async (pairIndex) => {
    try {
      const pairRaw = await callRpc(client, factory.network, "eth_call", [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.allPairs}${encodeUint256(pairIndex)}` }, tag]);
      const pair = wordAddress(pairRaw);
      if (pair === "0x0000000000000000000000000000000000000000") return { pairIndex, empty: true, raw: { allPairs: pairRaw } };
      const codeRaw = await callRpc(client, factory.network, "eth_getCode", [pair, tag]);
      if (hexBytes(codeRaw, "pair code").length <= 2) throw new DiscoveryRunError("EVM_CODE_MISSING");
      const [pairFactoryRaw, token0Raw, token1Raw, reservesRaw] = await Promise.all([
        callRpc(client, factory.network, "eth_call", [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairFactory }, tag]),
        callRpc(client, factory.network, "eth_call", [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairToken0 }, tag]),
        callRpc(client, factory.network, "eth_call", [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairToken1 }, tag]),
        callRpc(client, factory.network, "eth_call", [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, tag]),
      ]);
      const pairFactory = wordAddress(pairFactoryRaw);
      if (pairFactory !== factory.factory.toLowerCase()) throw new DiscoveryRunError("EVM_FACTORY_MISMATCH");
      const token0 = wordAddress(token0Raw);
      const token1 = wordAddress(token1Raw);
      if (token0 === token1) throw new DiscoveryRunError("EVM_PAIR_MISMATCH");
      const reserves = [wordQuantity(reservesRaw, 0), wordQuantity(reservesRaw, 1)];
      const factoryPairRaw = await callRpc(client, factory.network, "eth_call", [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.factoryGetPair}${encodeAddress(token0)}${encodeAddress(token1)}` }, tag]);
      if (wordAddress(factoryPairRaw) !== pair) throw new DiscoveryRunError("EVM_PAIR_MISMATCH");
      return { pairIndex, pair, token0, token1, reserves, raw: { allPairs: pairRaw, pairFactory: pairFactoryRaw, token0: token0Raw, token1: token1Raw, reserves: reservesRaw, factoryPair: factoryPairRaw } };
    } catch (error) {
      const code = typeof error?.code === "string" && DISCOVERY_ERROR_CODE_SET.has(error.code) ? error.code : "RPC_ERROR";
      return { pairIndex, errorCode: code === "RPC_RUN_BUDGET_EXCEEDED" ? "UNATTEMPTED_BUDGET" : code };
    }
  });
  const attemptedSet = new Set();
  const succeeded = new Set();
  const validPairs = [];
  for (const result of pairResults) {
    if (result?.errorCode) {
      const unattempted = result.errorCode === "UNATTEMPTED_BUDGET";
      if (!unattempted) attemptedSet.add(result.pairIndex);
      receipts.push(receipt("evm-pair", factory.network, unattempted ? "skipped" : "failed", `${factory.dexDeploymentId}:${result.pairIndex}`, { dexDeploymentId: factory.dexDeploymentId, pairIndex: result.pairIndex, code: result.errorCode, ...(unattempted ? { queue: "unattempted" } : {}), blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash }));
      continue;
    }
    attemptedSet.add(result.pairIndex);
    succeeded.add(result.pairIndex);
    receipts.push(receipt("evm-pair", factory.network, "success", `${factory.dexDeploymentId}:${result.pairIndex}`, { dexDeploymentId: factory.dexDeploymentId, pairIndex: result.pairIndex, address: result.pair, tokens: [result.token0, result.token1], reserves: result.reserves.map(String), factory: factory.factory, request: { method: "eth_call", pairIndex: result.pairIndex, blockHash: anchor.hash }, raw: result.raw, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, ...(anchor.timestamp === null ? {} : { blockTimestamp: anchor.timestamp.toString() }) }));
    if (!result.empty) validPairs.push(result);
  }
  const scannedIndexes = [...attemptedSet].sort((left, right) => left - right);
  const factoryReceipt = receipts.find((entry) => entry.kind === "evm-factory" && entry.subjectId === factory.dexDeploymentId);
  if (factoryReceipt) {
    factoryReceipt.scannedIndexes = scannedIndexes;
    factoryReceipt.successfulIndexes = [...succeeded].sort((left, right) => left - right);
    factoryReceipt.failedIndexes = scannedIndexes.filter((index) => !succeeded.has(index));
  }
  const tokenAddresses = orderedUnique(validPairs.flatMap((pair) => [pair.token0, pair.token1]).map((address) => address.toLowerCase()));
  const tokenRows = await mapBounded(tokenAddresses, config.limits.maxConcurrentRequests, async (address) => {
    try {
      const codeRaw = await callRpc(client, factory.network, "eth_getCode", [address, tag]);
      if (hexBytes(codeRaw, "token code").length <= 2) throw new DiscoveryRunError("EVM_TOKEN_INVALID");
      const decimalsRaw = await callRpc(client, factory.network, "eth_call", [{ to: address, data: EVM_DISCOVERY_SELECTORS.tokenDecimals }, tag]);
      const decimalsValue = wordQuantity(decimalsRaw);
      if (decimalsValue > 255n) throw new DiscoveryRunError("EVM_DECIMALS_INVALID");
      const supplyRaw = await callRpc(client, factory.network, "eth_call", [{ to: address, data: EVM_DISCOVERY_SELECTORS.tokenTotalSupply }, tag]);
      const supplyValue = wordQuantity(supplyRaw);
      let observedSymbol = null;
      let symbolRaw = null;
      try { symbolRaw = await callRpc(client, factory.network, "eth_call", [{ to: address, data: EVM_DISCOVERY_SELECTORS.tokenSymbol }, tag]); observedSymbol = safeObservedSymbol(decodeAbiString(symbolRaw)); } catch { /* symbol is evidence only */ }
      return { address, decimals: Number(decimalsValue), supply: supplyValue.toString(), observedSymbol, raw: { decimals: decimalsRaw, supply: supplyRaw, ...(symbolRaw ? { symbolResult: symbolRaw } : {}), ...(observedSymbol ? { symbol: observedSymbol } : {}) } };
    } catch (error) {
      return { address, errorCode: error.code ?? "RPC_UNAVAILABLE" };
    }
  });
  const tokenByAddress = new Map();
  for (const row of tokenRows) {
    const known = tokenMapsValue.byBinding.get(`${TOKEN_CHAIN_IDS[factory.network]}\u0000${row.address}`);
    if (row.errorCode) {
      receipts.push(receipt("evm-token", factory.network, "failed", `${factory.dexDeploymentId}:${row.address}`, { dexDeploymentId: factory.dexDeploymentId, address: row.address, code: row.errorCode, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash }));
      continue;
    }
    tokenByAddress.set(row.address, row);
    receipts.push(receipt("evm-token", factory.network, "success", `${factory.dexDeploymentId}:${row.address}`, { dexDeploymentId: factory.dexDeploymentId, address: row.address, decimals: row.decimals, supply: row.supply, ...(row.observedSymbol ? { observedSymbol: row.observedSymbol } : {}), request: { method: "eth_call", address: row.address, blockHash: anchor.hash }, raw: row.raw, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, ...(anchor.timestamp === null ? {} : { blockTimestamp: anchor.timestamp.toString() }) }));
    if (!known) proposals.push(canonicalTokenProposal({ chainId: TOKEN_CHAIN_IDS[factory.network], address: row.address, standard: "erc20", decimals: row.decimals, observedSymbol: row.observedSymbol, evidence: { network: factory.network, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, method: "eth_getCode+eth_call" }, tokenReceipt: row }));
  }
  const failedTokenAddresses = new Set(tokenRows.filter((row) => row.errorCode).map((row) => row.address));
  for (const pair of validPairs) {
    if (!failedTokenAddresses.has(pair.token0) && !failedTokenAddresses.has(pair.token1)) continue;
    succeeded.delete(pair.pairIndex);
    receipts.push(receipt("evm-pair", factory.network, "failed", `${factory.dexDeploymentId}:${pair.pairIndex}:token-dependency`, { dexDeploymentId: factory.dexDeploymentId, pairIndex: pair.pairIndex, code: "EVM_TOKEN_INVALID", blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash }));
  }
  const refreshedFactoryReceipt = receipts.find((entry) => entry.kind === "evm-factory" && entry.subjectId === factory.dexDeploymentId);
  if (refreshedFactoryReceipt) {
    refreshedFactoryReceipt.successfulIndexes = [...succeeded].sort((left, right) => left - right);
    refreshedFactoryReceipt.failedIndexes = scannedIndexes.filter((index) => !succeeded.has(index));
  }
  for (const pair of validPairs) {
    if (failedTokenAddresses.has(pair.token0) || failedTokenAddresses.has(pair.token1)) continue;
    const token0Known = tokenMapsValue.byBinding.get(`${TOKEN_CHAIN_IDS[factory.network]}\u0000${pair.token0}`);
    const token1Known = tokenMapsValue.byBinding.get(`${TOKEN_CHAIN_IDS[factory.network]}\u0000${pair.token1}`);
    const knownPool = dexMapsValue.poolsByBinding.get(`${TOKEN_CHAIN_IDS[factory.network]}\u0000${pair.pair}`);
    if (!knownPool) proposals.push(canonicalPoolProposal({ chainId: TOKEN_CHAIN_IDS[factory.network], address: pair.pair, dexDeploymentId: factory.dexDeploymentId, token0Address: pair.token0, token1Address: pair.token1, token0DeploymentId: token0Known?.deploymentId, token1DeploymentId: token1Known?.deploymentId, evidence: { network: factory.network, pairIndex: pair.pairIndex, blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash, factory: factory.factory, reserves: pair.reserves.map(String) } }));
  }
  state.__lastBlockNumber = `0x${anchor.number.toString(16)}`;
  state.__lastBlockHash = anchor.hash;
  updateFactoryState(state, factory.dexDeploymentId, current, { count, backfillLimit: scan.backfill, tailStart, attempted: [...attemptedSet], succeeded });
  networkStatus.push(receipt("network", factory.network, "success", factory.network, { blockNumber: `0x${anchor.number.toString(16)}`, blockHash: anchor.hash }));
  const failed = pairResults.some((row) => row?.errorCode) || tokenRows.some((row) => row?.errorCode);
  return { status: failed ? "partial" : "complete", failed };
}

function parseSolanaPoolAccount(pubkey, account, program, layout) {
  const data = accountData(account);
  const owner = accountOwner(account);
  if (account.executable === true || !Number.isSafeInteger(Number(account.lamports)) || Number(account.lamports) <= 0) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
  if (owner !== program.program) throw new DiscoveryRunError("SOLANA_PROGRAM_MISMATCH");
  if (!data || data.length !== layout.dataSize) throw new DiscoveryRunError("SOLANA_LAYOUT_MISMATCH");
  if (data.subarray(0, 8).toString("hex") !== layout.discriminator) throw new DiscoveryRunError("SOLANA_LAYOUT_MISMATCH");
  if (Number.isSafeInteger(layout.seedIndexOffset) && data.length >= layout.seedIndexOffset + 2 && data.readUInt16LE(layout.seedIndexOffset) !== 0) throw new DiscoveryRunError("SOLANA_LAYOUT_MISMATCH");
  if (!verifySolanaPoolPda(pubkey, program.program, data, layout.pda)) throw new DiscoveryRunError("SOLANA_PROGRAM_MISMATCH");
  const mints = layout.mintOffsets.map((offset) => encodeBase58(data.subarray(offset, offset + 32)));
  const vaults = layout.vaultOffsets.map((offset) => encodeBase58(data.subarray(offset, offset + 32)));
  const configAddress = encodeBase58(data.subarray(layout.configOffset, layout.configOffset + 32));
  const liquidity = Number.isSafeInteger(layout.liquidityOffset) ? readU128LE(data, layout.liquidityOffset) : null;
  const sqrtPrice = Number.isSafeInteger(layout.sqrtPriceOffset) ? readU128LE(data, layout.sqrtPriceOffset) : null;
  const status = Number.isSafeInteger(layout.statusOffset) && data.length > layout.statusOffset ? data[layout.statusOffset] : null;
  return { pubkey, mints, vaults, configAddress, dataLength: data.length, owner, liquidity, sqrtPrice, status };
}

function parseSolanaMint(address, account, tokenPrograms) {
  const owner = accountOwner(account);
  const data = accountData(account);
  const parsed = parsedAccountInfo(account);
  if (!data && parsed && typeof parsed.decimals === "number" && (parsed.isInitialized === true || parsed.initialized === true) && (typeof parsed.supply === "string" || typeof parsed.supply === "number")) {
    if (!tokenPrograms.includes(owner)) throw new DiscoveryRunError("SOLANA_MINT_INVALID");
    return { address, owner, standard: owner === TOKEN_PROGRAM_IDS.splToken2022 ? "spl-token-2022" : "spl-token", decimals: parsed.decimals, supply: String(parsed.supply), initialized: true };
  }
  if (!tokenPrograms.includes(owner)) throw new DiscoveryRunError("SOLANA_MINT_INVALID");
  const validMintFraming = owner === TOKEN_PROGRAM_IDS.splToken ? data?.length === 82 : validToken2022Framing(data, 82, 1);
  if (!validMintFraming) throw new DiscoveryRunError("SOLANA_MINT_INVALID");
  const supply = data.readBigUInt64LE(36);
  const decimals = data[44];
  const initialized = data[45] === 1;
  if (!initialized) throw new DiscoveryRunError("SOLANA_MINT_INVALID");
  return { address, owner, standard: owner === TOKEN_PROGRAM_IDS.splToken2022 ? "spl-token-2022" : "spl-token", decimals, supply: supply.toString(), initialized };
}

function parseSolanaVault(address, account, expectedMint, tokenPrograms, expectedAuthority = null, expectedProgram = null) {
  const owner = accountOwner(account);
  const data = accountData(account);
  const parsed = parsedAccountInfo(account);
  if (!data && parsed && parsed.mint === expectedMint && (parsed.state === "initialized" || parsed.state === "frozen") && (expectedAuthority === null || parsed.owner === expectedAuthority) && (expectedProgram === null || owner === expectedProgram)) return { address, owner, mint: expectedMint, amount: String(parsed.tokenAmount?.amount ?? parsed.amount ?? "0"), initialized: true, frozen: parsed.state === "frozen" };
  const validVaultFraming = owner === TOKEN_PROGRAM_IDS.splToken ? data?.length === 165 : validToken2022Framing(data, 165, 2);
  if (!tokenPrograms.includes(owner) || expectedProgram !== null && owner !== expectedProgram || !validVaultFraming) throw new DiscoveryRunError("SOLANA_VAULT_INVALID");
  const mint = encodeBase58(data.subarray(0, 32));
  const state = data[108];
  const authority = encodeBase58(data.subarray(32, 64));
  if (mint !== expectedMint || ![1, 2].includes(state) || expectedAuthority !== null && authority !== expectedAuthority) throw new DiscoveryRunError("SOLANA_VAULT_INVALID");
  return { address, owner, mint, amount: data.readBigUInt64LE(64).toString(), initialized: true, frozen: state === 2 };
}

async function readSolanaProgram(program, client, config, state, tokenMapsValue, dexMapsValue, receipts, proposals, networkStatus) {
  const layout = program.layout;
  const prior = isRecord(state.programs[program.dexDeploymentId]) ? state.programs[program.dexDeploymentId] : {};
  const partitionCursor = Number.isSafeInteger(prior.partitionCursor) ? prior.partitionCursor & 0xff : 0;
  const priorPending = Array.isArray(prior.pendingPubkeys) ? prior.pendingPubkeys : Array.isArray(prior.pendingQueue) ? prior.pendingQueue : [];
  let anchor;
  try { anchor = await finalizedSolanaAnchor(client, config.solana.anchor.minContextSlot); }
  catch (error) {
    const deferred = error.code === "RPC_RUN_BUDGET_EXCEEDED";
    receipts.push(receipt("solana-program", "solana", deferred ? "skipped" : "failed", program.dexDeploymentId, { program: program.program, code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "SOLANA_SLOT_INVALID", queue: deferred ? "unattempted" : "slot" }));
    networkStatus.push(receipt("network", "solana", deferred ? "skipped" : "failed", "solana", { code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "SOLANA_SLOT_INVALID" }));
    return { status: "partial" };
  }
  try {
    const genesis = await callRpc(client, "solana", "getGenesisHash", []);
    if (genesis !== (config.rpc.solana.expectedGenesisHash ?? DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash)) throw new DiscoveryRunError("NETWORK_IDENTITY_MISMATCH");
  } catch (error) {
    const deferred = error.code === "RPC_RUN_BUDGET_EXCEEDED";
    receipts.push(receipt("solana-program", "solana", deferred ? "skipped" : "failed", program.dexDeploymentId, { dexDeploymentId: program.dexDeploymentId, program: program.program, code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "NETWORK_IDENTITY_MISMATCH", queue: deferred ? "unattempted" : "genesis" }));
    networkStatus.push(receipt("network", "solana", deferred ? "skipped" : "failed", "solana", { code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "NETWORK_IDENTITY_MISMATCH" }));
    return { status: "partial" };
  }
  let gpa;
  try {
    const filters = [{ dataSize: layout.dataSize }, { memcmp: { offset: 0, bytes: encodeBase58(Buffer.from(layout.discriminator, "hex")) } }, { memcmp: { offset: layout.vaultOffsets[0], bytes: encodeBase58(Uint8Array.from([partitionCursor])) } }];
    const result = await callRpc(client, "solana", "getProgramAccounts", [program.program, { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: anchor, dataSlice: { offset: 0, length: 0 }, filters }]);
    const contextResult = solanaResultContext(result);
    const gpaSlot = requireContextSlot(contextResult.context, anchor);
    if (!Array.isArray(contextResult.value)) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
    const allPubkeys = contextResult.value.map((entry) => entry?.pubkey).filter((entry) => typeof entry === "string");
    gpa = { slot: gpaSlot, accounts: contextResult.value.slice(0, config.limits.maxMultipleAccounts), allPubkeys, keySetDigest: createHash("sha256").update(JSON.stringify([...allPubkeys].sort())).digest("hex") };
  } catch (error) {
    const deferred = error.code === "RPC_RUN_BUDGET_EXCEEDED";
    receipts.push(receipt("solana-program", "solana", deferred ? "skipped" : "failed", program.dexDeploymentId, { dexDeploymentId: program.dexDeploymentId, program: program.program, code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE", queue: deferred ? "unattempted" : "gpa" }));
    networkStatus.push(receipt("network", "solana", deferred ? "skipped" : "failed", "solana", { code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE" }));
    return { status: "partial" };
  }
  receipts.push(receipt("solana-program", "solana", "success", `${program.dexDeploymentId}:partition:${partitionCursor}`, { dexDeploymentId: program.dexDeploymentId, program: program.program, contextSlot: gpa.slot, queue: "gpa", gpaPubkeys: gpa.allPubkeys, request: { methods: ["getProgramAccounts"], minContextSlot: anchor, gpaPubkeyCount: gpa.allPubkeys.length, gpaPubkeySetDigest: gpa.keySetDigest } }));
  const parsed = [];
  for (const entry of gpa.accounts) {
    try {
      const pubkey = validateSolanaAddress(entry.pubkey, "program account");
      const data = accountData(entry.account);
      parsed.push(data && data.length > 0 ? parseSolanaPoolAccount(pubkey, entry.account, program, layout) : { pubkey });
    } catch (error) {
      receipts.push(receipt("solana-program", "solana", "failed", `${program.dexDeploymentId}:${entry.pubkey ?? "unknown"}`, { dexDeploymentId: program.dexDeploymentId, program: program.program, code: error.code ?? "SOLANA_ACCOUNT_INVALID", contextSlot: gpa.slot, queue: "gpa" }));
    }
  }
  const previousCompleted = Array.isArray(prior.completedPubkeys) ? prior.completedPubkeys : Array.isArray(prior.completePubkeySet) ? prior.completePubkeySet : [];
  const completeQueue = [...new Set([...priorPending, ...gpa.allPubkeys, ...parsed.map((entry) => entry.pubkey)])].filter((pubkey) => !previousCompleted.includes(pubkey));
  const pubkeys = completeQueue.slice(0, config.limits.maxMultipleAccounts);
  const pending = completeQueue.slice(pubkeys.length);
  let gma;
  try {
    if (pubkeys.length > 0) {
      const result = await callRpc(client, "solana", "getMultipleAccounts", [pubkeys, { commitment: "finalized", encoding: "base64", minContextSlot: gpa.slot }]);
      const contextResult = solanaResultContext(result);
      const gmaSlot = requireContextSlot(contextResult.context, gpa.slot);
      if (!Array.isArray(contextResult.value) || contextResult.value.length !== pubkeys.length) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      gma = { slot: gmaSlot, values: contextResult.value };
    } else gma = { slot: gpa.slot, values: [] };
  } catch (error) {
    const retained = [...new Set(completeQueue)];
    state.programs[program.dexDeploymentId] = { partitionCursor: (partitionCursor + 1) & 0xff, pendingPubkeys: retained, pendingQueue: retained, completedPubkeys: previousCompleted, completePubkeySet: previousCompleted, lastContextSlot: gpa.slot };
    const deferred = error.code === "RPC_RUN_BUDGET_EXCEEDED";
    receipts.push(receipt("solana-program", "solana", deferred ? "skipped" : "failed", program.dexDeploymentId, { dexDeploymentId: program.dexDeploymentId, program: program.program, code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE", contextSlot: gpa.slot, queue: deferred ? "unattempted" : "gma" }));
    networkStatus.push(receipt("network", "solana", deferred ? "skipped" : "failed", "solana", { code: deferred ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE", contextSlot: gpa.slot }));
    return { status: "partial" };
  }
  const gmaByPubkey = new Map(pubkeys.map((pubkey, index) => [pubkey, gma.values[index]]));
  const completePubkeys = [];
  const failedPubkeys = [];
  const parsedCandidates = [];
  for (const candidate of pubkeys.map((pubkey) => ({ pubkey, account: gmaByPubkey.get(pubkey) }))) {
    try {
      if (!candidate.account) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      const verified = parseSolanaPoolAccount(candidate.pubkey, candidate.account, program, layout);
      parsedCandidates.push({ verified, related: [...verified.mints, ...verified.vaults, verified.configAddress] });
    } catch (error) {
      failedPubkeys.push(candidate.pubkey);
      receipts.push(receipt("solana-program", "solana", "failed", `${program.dexDeploymentId}:${candidate.pubkey}`, { dexDeploymentId: program.dexDeploymentId, address: candidate.pubkey, program: program.program, code: error.code ?? "SOLANA_ACCOUNT_INVALID", contextSlot: gma.slot, queue: "pending" }));
    }
  }
  const relatedAddresses = [...new Set(parsedCandidates.flatMap((candidate) => candidate.related))];
  const relatedByAddress = new Map();
  const relatedBatchByAddress = new Map();
  const relatedContextSlotByAddress = new Map();
  const relatedFailedAddresses = new Set();
  const relatedFailureCodes = new Map();
  for (let offset = 0; offset < relatedAddresses.length; offset += config.limits.maxMultipleAccounts) {
    const batch = relatedAddresses.slice(offset, offset + config.limits.maxMultipleAccounts);
    try {
      const relatedResult = await callRpc(client, "solana", "getMultipleAccounts", [batch, { commitment: "finalized", encoding: "base64", minContextSlot: gma.slot }]);
      const relatedContext = solanaResultContext(relatedResult);
      const relatedContextSlot = requireContextSlot(relatedContext.context, gma.slot);
      if (!Array.isArray(relatedContext.value) || relatedContext.value.length !== batch.length) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      batch.forEach((address, index) => {
        relatedByAddress.set(address, relatedContext.value[index]);
        relatedBatchByAddress.set(address, [...batch]);
        relatedContextSlotByAddress.set(address, relatedContextSlot);
      });
    } catch (error) {
      batch.forEach((address) => { relatedFailedAddresses.add(address); relatedFailureCodes.set(address, error.code ?? "RPC_UNAVAILABLE"); });
    }
  }
  for (const candidate of parsedCandidates) {
    const verified = candidate.verified;
    try {
      const relatedValues = candidate.related.map((address) => relatedByAddress.get(address));
      const failedRelated = candidate.related.find((address) => relatedFailedAddresses.has(address));
      if (failedRelated) {
        throw new DiscoveryRunError(relatedFailureCodes.get(failedRelated) ?? "RPC_UNAVAILABLE");
      }
      if (relatedValues.some((value) => !value)) {
        throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      }
      const mint0 = parseSolanaMint(verified.mints[0], relatedValues[0], config.solana.mintPrograms);
      const mint1 = parseSolanaMint(verified.mints[1], relatedValues[1], config.solana.mintPrograms);
      const vault0 = parseSolanaVault(verified.vaults[0], relatedValues[2], verified.mints[0], config.solana.mintPrograms, verified.pubkey, mint0.owner);
      const vault1 = parseSolanaVault(verified.vaults[1], relatedValues[3], verified.mints[1], config.solana.mintPrograms, verified.pubkey, mint1.owner);
      const configAccount = relatedValues[4];
      if (!configAccount || accountOwner(configAccount) !== program.program || !accountData(configAccount)?.length) throw new DiscoveryRunError("SOLANA_CONFIG_INVALID");
      const poolAccountAddresses = [...pubkeys];
      const poolAccountIndex = poolAccountAddresses.indexOf(verified.pubkey);
      if (poolAccountIndex < 0) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      const relatedAccountBindings = candidate.related.map((address) => {
        const addresses = relatedBatchByAddress.get(address);
        const index = addresses?.indexOf(address) ?? -1;
        const contextSlotForAddress = relatedContextSlotByAddress.get(address);
        if (!addresses || index < 0 || !Number.isSafeInteger(contextSlotForAddress)) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
        return { address, addresses, index, contextSlot: contextSlotForAddress };
      });
      const accountContextSlots = relatedAccountBindings.map((binding) => binding.contextSlot);
      const contextSlot = Math.min(gma.slot, ...accountContextSlots);
      const pairReceipt = receipt("solana-program", "solana", "success", `${program.dexDeploymentId}:${verified.pubkey}`, { dexDeploymentId: program.dexDeploymentId, address: verified.pubkey, program: program.program, mints: verified.mints, vaults: verified.vaults, tokens: verified.mints, tokenMetadata: [mint0, mint1], vaultAmounts: [vault0.amount, vault1.amount], vaultFrozen: [vault0.frozen, vault1.frozen], liquidity: verified.liquidity, sqrtPrice: verified.sqrtPrice, statusByte: verified.status, request: { methods: ["getProgramAccounts", "getMultipleAccounts"], minContextSlot: anchor, gpaPubkeyCount: gpa.allPubkeys.length, gpaPubkeySetDigest: gpa.keySetDigest, poolAccountAddresses, poolAccountIndex, poolAccountContextSlot: gma.slot, relatedAccountBindings }, raw: { poolAccount: rawAccount(gmaByPubkey.get(verified.pubkey)), mintAccounts: relatedValues.slice(0, 2).map(rawAccount), vaultAccounts: relatedValues.slice(2, 4).map(rawAccount), configAccount: rawAccount(configAccount) }, contextSlot, slot: contextSlot, layout: layout.layoutRevision });
      receipts.push(pairReceipt);
      const poolKnown = dexMapsValue.poolsByBinding.get(`${SOLANA_CHAIN}\u0000${verified.pubkey}`);
      const tokenKnown0 = tokenMapsValue.byBinding.get(`${SOLANA_CHAIN}\u0000${verified.mints[0]}`);
      const tokenKnown1 = tokenMapsValue.byBinding.get(`${SOLANA_CHAIN}\u0000${verified.mints[1]}`);
      if (!tokenKnown0) proposals.push(canonicalTokenProposal({ chainId: SOLANA_CHAIN, address: verified.mints[0], standard: mint0.standard, decimals: mint0.decimals, evidence: { network: "solana", program: program.program, pool: verified.pubkey, contextSlot }, tokenReceipt: mint0 }));
      if (!tokenKnown1) proposals.push(canonicalTokenProposal({ chainId: SOLANA_CHAIN, address: verified.mints[1], standard: mint1.standard, decimals: mint1.decimals, evidence: { network: "solana", program: program.program, pool: verified.pubkey, contextSlot }, tokenReceipt: mint1 }));
      if (!poolKnown) proposals.push(canonicalPoolProposal({ chainId: SOLANA_CHAIN, address: verified.pubkey, dexDeploymentId: program.dexDeploymentId, token0Address: verified.mints[0], token1Address: verified.mints[1], token0DeploymentId: tokenKnown0?.deploymentId, token1DeploymentId: tokenKnown1?.deploymentId, evidence: { network: "solana", program: program.program, contextSlot, layout: layout.layoutRevision, vaults: verified.vaults, vaultAmounts: [vault0.amount, vault1.amount], vaultFrozen: [vault0.frozen, vault1.frozen], liquidity: verified.liquidity, sqrtPrice: verified.sqrtPrice, swapDisabled: vault0.frozen || vault1.frozen || verified.status !== null && (verified.status & (layout.swapDisabledMask ?? 0)) !== 0 } }));
      completePubkeys.push(verified.pubkey);
    } catch (error) {
      failedPubkeys.push(verified.pubkey);
      receipts.push(receipt("solana-program", "solana", "failed", `${program.dexDeploymentId}:${verified.pubkey}`, { dexDeploymentId: program.dexDeploymentId, address: verified.pubkey, program: program.program, code: error.code ?? "SOLANA_ACCOUNT_INVALID", contextSlot: gma.slot, queue: "pending" }));
    }
  }
  const completedPubkeys = [...new Set([...(prior.completedPubkeys ?? prior.completePubkeySet ?? []), ...completePubkeys])].sort();
  const failedSet = new Set(failedPubkeys);
  const retainedPending = [...new Set([...pending, ...priorPending.filter((entry) => !completePubkeys.includes(entry) && !failedSet.has(entry)), ...failedPubkeys])].filter((entry) => !completedPubkeys.includes(entry));
  state.programs[program.dexDeploymentId] = { partitionCursor: (partitionCursor + 1) & 0xff, pendingPubkeys: retainedPending, pendingQueue: retainedPending, completedPubkeys, completePubkeySet: completedPubkeys, lastContextSlot: gma.slot };
  networkStatus.push(receipt("network", "solana", failedPubkeys.length > 0 || pending.length > 0 ? "failed" : "success", "solana", { contextSlot: gma.slot }));
  return { status: failedPubkeys.length > 0 || pending.length > 0 ? "partial" : "complete" };
}

async function readSolanaMints(config, client, state, tokenMapsValue, receipts, proposals) {
  if (!config.solana.mintScan.enabled && !state.scanMints) return { status: "skipped" };
  let partial = false;
  let anchor;
  try { anchor = await finalizedSolanaAnchor(client, config.solana.anchor.minContextSlot); }
  catch (error) { receipts.push(receipt("solana-mint", "solana", error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "skipped" : "failed", "mint-anchor", { code: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "UNATTEMPTED_BUDGET" : error.code ?? "SOLANA_SLOT_INVALID", queue: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "unattempted" : undefined })); return { status: "partial" }; }
  try {
    const genesis = await callRpc(client, "solana", "getGenesisHash", []);
    if (genesis !== (config.rpc.solana.expectedGenesisHash ?? DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash)) throw new DiscoveryRunError("NETWORK_IDENTITY_MISMATCH");
  } catch (error) { receipts.push(receipt("solana-mint", "solana", error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "skipped" : "failed", "mint-genesis", { code: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "UNATTEMPTED_BUDGET" : error.code ?? "NETWORK_IDENTITY_MISMATCH", queue: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "unattempted" : undefined })); return { status: "partial" }; }
  for (const tokenProgram of config.solana.mintPrograms) {
    try {
      const result = await callRpc(client, "solana", "getProgramAccounts", [tokenProgram, { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: anchor, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: config.solana.mintScan.dataSize }] }]);
      const context = solanaResultContext(result);
      const slot = requireContextSlot(context.context, anchor);
      if (!Array.isArray(context.value)) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      const mintState = isRecord(state.mints[tokenProgram]) ? state.mints[tokenProgram] : {};
      const allAccounts = context.value;
      const cursor = Number.isSafeInteger(mintState.cursor) && allAccounts.length > 0 ? mintState.cursor % allAccounts.length : 0;
      const accounts = allAccounts.length <= config.solana.mintScan.maxAccountsPerProgram
        ? allAccounts
        : Array.from({ length: config.solana.mintScan.maxAccountsPerProgram }, (_, index) => allAccounts[(cursor + index) % allAccounts.length]);
      const selectedPubkeys = new Set(accounts.map((entry) => entry?.pubkey).filter((entry) => typeof entry === "string"));
      const pendingBefore = Array.isArray(mintState.pendingPubkeys) ? mintState.pendingPubkeys : Array.isArray(mintState.pendingQueue) ? mintState.pendingQueue : [];
      const deferredPubkeys = allAccounts.map((entry) => entry?.pubkey).filter((entry) => typeof entry === "string" && !selectedPubkeys.has(entry));
      const failedPubkeys = [];
      const completedPubkeys = [];
      const mintPubkeys = accounts.map((entry) => entry?.pubkey).filter((entry) => typeof entry === "string");
      const mintDataResult = mintPubkeys.length > 0 ? solanaResultContext(await callRpc(client, "solana", "getMultipleAccounts", [mintPubkeys, { commitment: "finalized", encoding: "base64", minContextSlot: slot }])) : { context: { slot }, value: [] };
      const mintSlot = requireContextSlot(mintDataResult.context, slot);
      if (!Array.isArray(mintDataResult.value) || mintDataResult.value.length !== mintPubkeys.length) throw new DiscoveryRunError("SOLANA_ACCOUNT_INVALID");
      for (const [accountIndex, entry] of accounts.entries()) {
        const accountValue = mintDataResult.value[accountIndex];
        try {
          const parsed = parseSolanaMint(entry.pubkey, accountValue, config.solana.mintPrograms);
          const known = tokenMapsValue.byBinding.get(`${SOLANA_CHAIN}\u0000${parsed.address}`);
          receipts.push(receipt("solana-mint", "solana", "success", parsed.address, { address: parsed.address, tokenProgram, cursor: cursor + accountIndex, contextSlot: mintSlot, slot: mintSlot, decimals: parsed.decimals, supply: parsed.supply, request: { method: "getProgramAccounts", minContextSlot: anchor, tokenProgram }, raw: rawAccount(accountValue) }));
          if (!known) proposals.push(canonicalTokenProposal({ chainId: SOLANA_CHAIN, address: parsed.address, standard: parsed.standard, decimals: parsed.decimals, evidence: { network: "solana", tokenProgram, contextSlot: slot, scope: "bounded-mint-data-size" }, tokenReceipt: parsed }));
          completedPubkeys.push(entry.pubkey);
        } catch (error) { failedPubkeys.push(entry.pubkey); receipts.push(receipt("solana-mint", "solana", "failed", entry.pubkey ?? "unknown", { address: entry.pubkey ?? "unknown", code: error.code ?? "SOLANA_MINT_INVALID", contextSlot: slot })); }
      }
      const pending = [...new Set([...pendingBefore.filter((entry) => !completedPubkeys.includes(entry)), ...deferredPubkeys, ...failedPubkeys])];
      state.mints[tokenProgram] = { cursor: allAccounts.length > 0 ? (cursor + accounts.length) % allAccounts.length : 0, pendingPubkeys: pending, pendingQueue: pending, completedPubkeys: [...new Set([...(mintState.completedPubkeys ?? mintState.completePubkeySet ?? []), ...completedPubkeys])].sort(), completePubkeySet: [...new Set([...(mintState.completedPubkeys ?? mintState.completePubkeySet ?? []), ...completedPubkeys])].sort(), lastContextSlot: slot };
    } catch (error) {
      partial = true;
      receipts.push(receipt("solana-mint", "solana", error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "skipped" : "failed", tokenProgram, { program: tokenProgram, code: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "UNATTEMPTED_BUDGET" : error.code ?? "RPC_UNAVAILABLE", queue: error.code === "RPC_RUN_BUDGET_EXCEEDED" ? "unattempted" : undefined }));
    }
  }
  return { status: partial ? "partial" : "complete" };
}

function sortProposals(proposals) {
  const selected = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.kind}\u0000${proposal.id}`;
    const current = selected.get(key);
    if (!current || stableStringify(proposal).localeCompare(stableStringify(current)) < 0) selected.set(key, proposal);
  }
  return [...selected.values()].sort((left, right) => `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`));
}

function collisionCheck(proposals, tokenCatalogValue, dexCatalogValue) {
  const tokenIds = new Set(tokenCatalogValue.deployments.map((entry) => entry.deploymentId));
  const assetIds = new Set(tokenCatalogValue.assets.map((entry) => entry.assetId));
  const tokenAliases = new Set(tokenCatalogValue.aliases.map((entry) => `${entry.namespace}\u0000${entry.name}`));
  const poolIds = new Set(dexCatalogValue.poolDefinitions.map((entry) => entry.poolDefinitionId));
  const aliases = new Set(dexCatalogValue.aliases.map((entry) => `${entry.namespace}\u0000${entry.name}`));
  const poolAliases = new Set(dexCatalogValue.aliases.filter((entry) => entry.poolDefinitionId).map((entry) => `${entry.namespace}\u0000${entry.name}`));
  const proposedTokenIds = new Set(proposals.filter((entry) => entry.kind === "token").map((entry) => entry.deploymentId));
  for (const proposal of proposals) {
    if (proposal.kind === "token") {
      if (tokenIds.has(proposal.deploymentId) || assetIds.has(proposal.assetId)) throw new DiscoveryRunError("ADMISSION_COLLISION", `token identity ${proposal.id} collides with canonical data`);
      const namespace = EVM_CHAINS.has(proposal.chainId) ? (proposal.chainId === TOKEN_CHAIN_IDS.ethereum ? "ethereum" : "avalancheC") : "solana";
      if (tokenAliases.has(`${namespace}\u0000${proposal.alias}`) || aliases.has(`${namespace}\u0000${proposal.alias}`)) throw new DiscoveryRunError("ADMISSION_COLLISION", `token alias ${proposal.alias} collides with canonical data`);
    } else {
      if (poolIds.has(proposal.poolDefinitionId)) throw new DiscoveryRunError("ADMISSION_COLLISION", `pool identity ${proposal.id} collides with canonical data`);
      const namespace = EVM_CHAINS.has(proposal.chainId) ? (proposal.chainId === TOKEN_CHAIN_IDS.ethereum ? "ethereum" : "avalancheC") : "solana";
      if (poolAliases.has(`${namespace}\u0000${proposal.alias}`) || aliases.has(`${namespace}\u0000${proposal.alias}`)) throw new DiscoveryRunError("ADMISSION_COLLISION", `pool alias ${proposal.alias} collides with canonical data`);
      const token0 = proposal.canonical?.token0DeploymentId;
      const token1 = proposal.canonical?.token1DeploymentId;
      if (token0 && !tokenIds.has(token0) && !proposedTokenIds.has(token0) || token1 && !tokenIds.has(token1) && !proposedTokenIds.has(token1)) throw new DiscoveryRunError("ADMISSION_INVALID", `pool ${proposal.id} has no admitted token dependency (${String(token0)} / ${String(token1)})`);
    }
  }
  return true;
}

function closeProposalDependencies(proposals, tokenCatalogValue) {
  const tokenIds = new Set(tokenCatalogValue.deployments.map((entry) => entry.deploymentId));
  const proposedTokenIds = new Set(proposals.filter((entry) => entry.kind === "token").map((entry) => entry.deploymentId));
  return proposals.filter((proposal) => {
    if (proposal.kind !== "pool") return true;
    const token0 = proposal.canonical?.token0DeploymentId;
    const token1 = proposal.canonical?.token1DeploymentId;
    return (!token0 || tokenIds.has(token0) || proposedTokenIds.has(token0)) && (!token1 || tokenIds.has(token1) || proposedTokenIds.has(token1));
  });
}

function coverageFor(config, receipts, status) {
  const scopes = [];
  for (const factory of config.evm.factories) scopes.push(`${factory.dexDeploymentId}:tail=${factory.pairScan.tail}:backfill=${factory.pairScan.backfill}`);
  for (const program of config.solana.programs) scopes.push(`${program.dexDeploymentId}:program=${program.program}:dataSize=${program.layout.dataSize}:discriminator=${program.layout.discriminator}`);
  const failed = receipts.some((entry) => entry.status === "failed");
  return { mode: "bounded", claim: status === "complete" && !failed ? "bounded" : "bounded", scopes };
}

function validateWorkspace(workspace, label = "workspace") {
  exactKeys(workspace, ["clean", "pinned", "promotable"], label);
  if (typeof workspace.clean !== "boolean" || typeof workspace.pinned !== "boolean" || typeof workspace.promotable !== "boolean") fail(`${label} flags are invalid`, "ARTIFACT_INVALID");
}

function artifactEnvelope(kind, fields) {
  return { schemaVersion: DISCOVERY_SCHEMA_VERSION, artifactKind: kind, ...fields };
}

function checkReceiptShape(row) {
  if (!isRecord(row) || !["network", "evm-factory", "evm-pair", "evm-token", "solana-program", "solana-mint", "solana-account"].includes(row.kind) || !NETWORKS.includes(row.network) || !["success", "failed", "skipped", "pending"].includes(row.status) || typeof row.subjectId !== "string") fail("invalid discovery receipt", "ARTIFACT_INVALID");
  if (row.code !== undefined && (typeof row.code !== "string" || !DISCOVERY_ERROR_CODES.includes(row.code))) fail("discovery receipt code is not fixed", "ARTIFACT_INVALID");
  if (row.status === "failed" && typeof row.code !== "string") fail("failed discovery receipt needs fixed code", "ARTIFACT_INVALID");
  return true;
}

function validateRpcTranscript(transcript, label = "rpcTranscript") {
  if (!Array.isArray(transcript)) fail(`${label} must be an array`, "ARTIFACT_INVALID");
  const seenIds = new Set();
  for (const [index, entry] of transcript.entries()) {
    if (!isRecord(entry) || !NETWORKS.includes(entry.network) || (entry.endpointId !== null && typeof entry.endpointId !== "string") || !isRecord(entry.request) || !isRecord(entry.response)) fail(`${label}[${index}] is invalid`, "ARTIFACT_INVALID");
    if (entry.request.jsonrpc !== "2.0" || !Number.isSafeInteger(entry.request.id) || entry.request.id < 1 || typeof entry.request.method !== "string" || !Array.isArray(entry.request.params)) fail(`${label}[${index}] request correlation is invalid`, "ARTIFACT_INVALID");
    if (entry.response.jsonrpc !== "2.0" || entry.response.id !== entry.request.id || !Object.hasOwn(entry.response, "result") && !Object.hasOwn(entry.response, "error")) fail(`${label}[${index}] response correlation is invalid`, "ARTIFACT_INVALID");
    if (Object.hasOwn(entry.response, "error") && (!isRecord(entry.response.error) || Object.keys(entry.response.error).some((key) => key !== "code") || typeof entry.response.error.code !== "string" || !DISCOVERY_ERROR_CODE_SET.has(entry.response.error.code))) fail(`${label}[${index}] error code is not fixed`, "ARTIFACT_INVALID");
    const idKey = `${entry.network}\u0000${entry.endpointId}\u0000${entry.request.id}`;
    if (seenIds.has(idKey)) fail(`${label}[${index}] request id is duplicated`, "ARTIFACT_INVALID");
    seenIds.add(idKey);
    const scan = (value) => {
      if (Array.isArray(value)) value.forEach(scan);
      else if (isRecord(value)) for (const [key, child] of Object.entries(value)) {
        if (/url|header|auth|credential|cookie/iu.test(key)) fail(`${label}[${index}] retains request credentials`, "ARTIFACT_INVALID");
        scan(child);
      }
    };
    scan(entry);
  }
  return true;
}

function transcriptCompressedText(value) {
  if (!isRecord(value) || value.encoding !== "gzip-base64" || typeof value.data !== "string" || typeof value.sha256 !== "string" || !DIGEST_RE.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) return null;
  try {
    const decoded = gunzipSync(Buffer.from(value.data, "base64"));
    if (decoded.length !== value.bytes || createHash("sha256").update(decoded).digest("hex") !== value.sha256) return null;
    return decoded.toString("utf8");
  } catch { return null; }
}

/** Compare one JSON-RPC result, allowing only the documented bounded string encoding. */
function transcriptResultEquals(actual, expected) {
  if (stableStringify(actual) === stableStringify(expected)) return true;
  const actualText = transcriptCompressedText(actual);
  const expectedText = transcriptCompressedText(expected);
  if (actualText !== null && expectedText !== null) return actualText === expectedText;
  if (actualText !== null && typeof expected === "string") return actualText === expected;
  if (expectedText !== null && typeof actual === "string") return expectedText === actual;
  return false;
}

function transcriptCallMatches(transcript, { network, method, params, result = undefined, predicate = undefined }) {
  return transcript.some((entry) => entry?.network === network
    && entry.request?.method === method
    && stableStringify(entry.request?.params) === stableStringify(params)
    && (predicate ? predicate(entry.response?.result) : result === undefined ? Object.hasOwn(entry.response ?? {}, "result") : transcriptResultEquals(entry.response?.result, result)));
}

function transcriptFactoryAttempt(transcript, { network, factory, pairIndex, blockHash }) {
  const params = [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.allPairs}${encodeUint256(pairIndex)}` }, blockTag(blockHash)];
  return transcript.find((entry) => entry?.network === network && entry.request?.method === "eth_call" && stableStringify(entry.request?.params) === stableStringify(params) && (Object.hasOwn(entry.response ?? {}, "result") || isRecord(entry.response?.error) && typeof entry.response.error.code === "string" && DISCOVERY_ERROR_CODE_SET.has(entry.response.error.code))) ?? null;
}

function factoryAttemptEvidence(transcript, factoryReceipt, factory, current, failedRows = []) {
  const count = factoryReceipt.pairCount;
  const { planned } = factoryScanPlan(current, factory, count);
  const plannedSet = new Set(planned);
  const scanned = Array.isArray(factoryReceipt.scannedIndexes) ? factoryReceipt.scannedIndexes : [];
  const successful = Array.isArray(factoryReceipt.successfulIndexes) ? factoryReceipt.successfulIndexes : [];
  const failed = Array.isArray(factoryReceipt.failedIndexes) ? factoryReceipt.failedIndexes : [];
  const allClaimed = [...scanned, ...successful, ...failed];
  if (allClaimed.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= count) || new Set(scanned).size !== scanned.length || new Set(successful).size !== successful.length || new Set(failed).size !== failed.length) return { valid: false, reason: "factory cursor claim contains invalid indexes" };
  const scannedSet = new Set(scanned);
  const successfulSet = new Set(successful);
  const failedSet = new Set(failed);
  if (successfulSet.size + failedSet.size !== scannedSet.size || [...successfulSet].some((index) => !scannedSet.has(index)) || [...failedSet].some((index) => !scannedSet.has(index) || successfulSet.has(index))) return { valid: false, reason: "factory cursor claim partitions are inconsistent" };
  if ([...scannedSet].some((index) => !plannedSet.has(index))) return { valid: false, reason: "factory cursor claim is outside the recomputed scan plan" };
  const exact = new Set();
  const exactEntries = new Map();
  for (const index of planned) {
    const entry = transcriptFactoryAttempt(transcript, { network: factory.network, factory, pairIndex: index, blockHash: factoryReceipt.blockHash });
    const errorCode = entry?.response?.error?.code;
    if (entry && !["RPC_RUN_BUDGET_EXCEEDED", "UNATTEMPTED_BUDGET"].includes(errorCode)) { exact.add(index); exactEntries.set(index, entry); }
  }
  if ([...scannedSet].some((index) => !exact.has(index))) return { valid: false, reason: "factory cursor claim lacks an exact allPairs RPC request" };
  if ([...exact].some((index) => !scannedSet.has(index))) return { valid: false, reason: "factory allPairs RPC evidence is absent from cursor claim" };
  for (const index of failedSet) {
    const entry = exactEntries.get(index);
    const hasFixedError = isRecord(entry?.response?.error) && typeof entry.response.error.code === "string" && DISCOVERY_ERROR_CODE_SET.has(entry.response.error.code);
    const hasFailedReceipt = failedRows.some((row) => row.pairIndex === index && row.status === "failed");
    if (!hasFixedError && !hasFailedReceipt && !exactEntries.has(index)) return { valid: false, reason: "failed factory index lacks exact failure evidence" };
  }
  return { valid: true, planned, attempted: [...exact].sort((left, right) => left - right), exactEntries };
}

function normalizeFactoryCursorClaims(receiptArtifact, config, priorState, transcript) {
  const state = { factories: isRecord(priorState?.factories) ? deepClone(priorState.factories) : {} };
  for (const factoryReceipt of receiptArtifact.receipts.filter((row) => row.kind === "evm-factory" && row.status === "success")) {
    const dexId = factoryReceipt.dexDeploymentId ?? factoryReceipt.subjectId;
    const factory = config.evm.factories.find((entry) => entry.dexDeploymentId === dexId);
    if (!factory) continue;
    const current = factoryState(state, dexId);
    const { tailStart, planned } = factoryScanPlan(current, factory, factoryReceipt.pairCount);
    const actual = planned.filter((index) => {
      const entry = transcriptFactoryAttempt(transcript, { network: factory.network, factory, pairIndex: index, blockHash: factoryReceipt.blockHash });
      return entry && !["RPC_RUN_BUDGET_EXCEEDED", "UNATTEMPTED_BUDGET"].includes(entry.response?.error?.code);
    });
    const actualSet = new Set(actual);
    const pairRows = receiptArtifact.receipts.filter((row) => row.kind === "evm-pair" && row.dexDeploymentId === dexId && Number.isSafeInteger(row.pairIndex) && row.blockHash === factoryReceipt.blockHash);
    const failedRows = new Set(pairRows.filter((row) => row.status === "failed").map((row) => row.pairIndex));
    for (const index of actual) {
      const row = pairRows.find((candidate) => candidate.pairIndex === index);
      if (row?.status === "skipped" && row.code === "UNATTEMPTED_BUDGET") {
        row.status = "failed";
        row.code = "RPC_RUN_BUDGET_EXCEEDED";
        delete row.queue;
        failedRows.add(index);
      }
      if (!row) {
        const entry = transcriptFactoryAttempt(transcript, { network: factory.network, factory, pairIndex: index, blockHash: factoryReceipt.blockHash });
        const code = entry?.response?.error?.code ?? "RPC_RUN_BUDGET_EXCEEDED";
        receiptArtifact.receipts.push(receipt("evm-pair", factory.network, "failed", `${dexId}:${index}:budget`, { dexDeploymentId: dexId, pairIndex: index, code, blockNumber: factoryReceipt.blockNumber, blockHash: factoryReceipt.blockHash }));
        failedRows.add(index);
      }
    }
    const successful = [...new Set(pairRows.filter((row) => actualSet.has(row.pairIndex) && row.status === "success" && !failedRows.has(row.pairIndex)).map((row) => row.pairIndex))].sort((left, right) => left - right);
    const failed = actual.filter((index) => !successful.includes(index));
    factoryReceipt.scannedIndexes = [...actual].sort((left, right) => left - right);
    factoryReceipt.successfulIndexes = successful;
    factoryReceipt.failedIndexes = failed;
    updateFactoryState(state, dexId, current, { count: factoryReceipt.pairCount, backfillLimit: factory.pairScan.backfill, tailStart, attempted: actual, succeeded: new Set(successful) });
  }
}

function transcriptAccountData(value) {
  let encoded = value;
  if (Array.isArray(value)) {
    if (value[1] !== "base64") return null;
    encoded = value[0];
  }
  if (typeof encoded !== "string") encoded = transcriptCompressedText(encoded);
  if (typeof encoded !== "string") return null;
  try {
    return Buffer.from(encoded, "base64");
  } catch { return null; }
}

function transcriptAccountEquals(actual, expected) {
  if (!isRecord(actual) || !isRecord(expected) || typeof actual.owner !== "string" || typeof expected.owner !== "string" || actual.owner !== expected.owner || typeof actual.executable !== "boolean" || typeof expected.executable !== "boolean" || actual.executable !== expected.executable) return false;
  const actualLamports = typeof actual.lamports === "number" ? actual.lamports : typeof actual.lamports === "string" && /^\d+$/u.test(actual.lamports) ? Number(actual.lamports) : NaN;
  const expectedLamports = typeof expected.lamports === "number" ? expected.lamports : typeof expected.lamports === "string" && /^\d+$/u.test(expected.lamports) ? Number(expected.lamports) : NaN;
  if (!Number.isSafeInteger(actualLamports) || !Number.isSafeInteger(expectedLamports) || actualLamports !== expectedLamports) return false;
  if (typeof expected.data !== "string") return false;
  const actualData = transcriptAccountData(actual.data);
  let expectedData;
  try { expectedData = Buffer.from(expected.data, "base64"); } catch { expectedData = null; }
  return actualData !== null && expectedData !== null && actualData.length === expectedData.length && actualData.equals(expectedData);
}

/**
 * Bind an account to the exact requested address index in one getMultipleAccounts
 * response.  A matching byte string elsewhere in the response is insufficient.
 */
function transcriptMultipleAccountMatches(transcript, { network, addresses, address, raw, minContextSlot = 0, commitment = "finalized", expectedContextSlot = undefined }) {
  if (!Array.isArray(addresses) || typeof address !== "string" || !isRecord(raw)) return false;
  const index = addresses.indexOf(address);
  if (index < 0) return false;
  return transcript.some((entry) => {
    if (entry?.network !== network || entry.request?.method !== "getMultipleAccounts") return false;
    const params = entry.request?.params;
    if (!Array.isArray(params?.[0]) || stableStringify(params[0]) !== stableStringify(addresses) || params[1]?.commitment !== commitment) return false;
    const result = entry.response?.result;
    if (!isRecord(result) || !isRecord(result.context) || !Number.isSafeInteger(result.context.slot) || result.context.slot < minContextSlot || expectedContextSlot !== undefined && result.context.slot !== expectedContextSlot || !Array.isArray(result.value) || result.value.length !== addresses.length) return false;
    return transcriptAccountEquals(result.value[index], raw);
  });
}

function transcriptBlockMatches(transcript, { network, params, row }) {
  return transcriptCallMatches(transcript, {
    network,
    method: "eth_getBlockByNumber",
    params,
    predicate: (value) => {
      if (!isRecord(value) || typeof value.hash !== "string" || typeof value.number !== "string" || value.hash.toLowerCase() !== String(row.blockHash).toLowerCase() || value.number.toLowerCase() !== String(row.blockNumber).toLowerCase()) return false;
      if (row.blockTimestamp === undefined) return true;
      try { return typeof value.timestamp === "string" && BigInt(value.timestamp) === BigInt(row.blockTimestamp); } catch { return false; }
    },
  });
}

export { transcriptResultEquals, transcriptMultipleAccountMatches };

function transcriptCodePresent(value) {
  try {
    const text = typeof value === "string" ? value : isRecord(value) && value.encoding === "gzip-base64" ? gunzipSync(Buffer.from(value.data, "base64")).toString("utf8") : null;
    return typeof text === "string" && hexBytes(text, "transcript code").length > 2;
  } catch { return false; }
}

export function validateDiscoveryArtifacts(artifacts, context = {}) {
  if (!isRecord(artifacts)) fail("discovery artifacts are required", "ARTIFACT_INVALID");
  const allowedArtifactSlots = new Set(["receipts", "proposals", "evidence", "state", "admissions"]);
  if (Object.keys(artifacts).some((key) => !allowedArtifactSlots.has(key))) fail("discovery artifacts contain an unapproved slot", "ARTIFACT_INVALID");
  const receipts = artifacts.receipts;
  if (!isRecord(receipts) || receipts.artifactKind !== "discovery-receipts") fail("receipts envelope is invalid", "ARTIFACT_INVALID");
  if (Object.keys(receipts).some((key) => !["schemaVersion", "artifactKind", "sourceSha", "configDigest", "tokenCatalogDigest", "dexCatalogDigest", "status", "workspace", "coverage", "rpcTranscript", "receipts", "state"].includes(key))) fail("receipts envelope contains an unapproved field", "ARTIFACT_INVALID");
  if (receipts.schemaVersion !== 1) fail("receipts schemaVersion is invalid", "ARTIFACT_INVALID");
  sourceSha(receipts.sourceSha, "receipts.sourceSha");
  digest(receipts.configDigest, "receipts.configDigest");
  digest(receipts.tokenCatalogDigest, "receipts.tokenCatalogDigest");
  digest(receipts.dexCatalogDigest, "receipts.dexCatalogDigest");
  if (!Array.isArray(receipts.receipts)) fail("receipts.receipts must be an array", "ARTIFACT_INVALID");
  if (receipts.rpcTranscript !== undefined) validateRpcTranscript(receipts.rpcTranscript);
  receipts.receipts.forEach(checkReceiptShape);
  validateWorkspace(receipts.workspace, "receipts.workspace");
  if (!isRecord(receipts.coverage) || receipts.coverage.mode !== "bounded" || receipts.coverage.claim !== "bounded" || !Array.isArray(receipts.coverage.scopes)) fail("coverage envelope is invalid", "ARTIFACT_INVALID");
  const proposals = artifacts.proposals;
  if (!isRecord(proposals) || proposals.artifactKind !== "discovery-proposals" || !Array.isArray(proposals.proposals)) fail("proposals envelope is invalid", "ARTIFACT_INVALID");
  if (Object.keys(proposals).some((key) => !["schemaVersion", "artifactKind", "sourceSha", "configDigest", "tokenCatalogDigest", "dexCatalogDigest", "status", "workspace", "coverage", "proposals", "reviewRequired"].includes(key))) fail("proposals envelope contains an unapproved field", "ARTIFACT_INVALID");
  sourceSha(proposals.sourceSha, "proposals.sourceSha");
  if (proposals.sourceSha !== receipts.sourceSha || proposals.configDigest !== receipts.configDigest || proposals.tokenCatalogDigest !== receipts.tokenCatalogDigest || proposals.dexCatalogDigest !== receipts.dexCatalogDigest) fail("proposal bindings do not match receipts", "ARTIFACT_INVALID");
  validateWorkspace(proposals.workspace, "proposals.workspace");
  for (const proposal of proposals.proposals) {
    const allowedProposalKeys = new Set(["kind", "id", "assetId", "deploymentId", "poolDefinitionId", "alias", "chainId", "address", "canonical", "evidence", "quoteEligible", "reviewRequired", "token0Address", "token1Address", "dexDeploymentId"]);
    if (Object.keys(proposal ?? {}).some((key) => !allowedProposalKeys.has(key))) fail("proposal contains an unapproved field", "ARTIFACT_INVALID");
    if (!isRecord(proposal) || !["token", "pool"].includes(proposal.kind) || typeof proposal.id !== "string" || !ALIAS_RE.test(proposal.alias) || typeof proposal.address !== "string" || typeof proposal.chainId !== "string" || !isRecord(proposal.canonical) || !Array.isArray(proposal.evidence) || proposal.quoteEligible !== false || proposal.reviewRequired !== true) fail("proposal is invalid", "ARTIFACT_INVALID");
    const scan = (value) => {
      if (Array.isArray(value)) value.forEach(scan);
      else if (isRecord(value)) for (const [key, child] of Object.entries(value)) { if (/command|operation|write|execute|publish|tag/iu.test(key)) fail("proposal contains an executable field", "ARTIFACT_INVALID"); scan(child); }
    };
    scan(proposal);
  }
  if (context.config) {
    const config = normalizeConfig(context.config);
    if (receipts.configDigest !== computeDiscoveryConfigDigest(config)) fail("config digest mismatch", "ARTIFACT_INVALID");
  }
  const defaultBound = receipts.configDigest === computeDiscoveryConfigDigest(defaultConfig) && receipts.tokenCatalogDigest === computeTokenDigest(tokenCatalog) && receipts.dexCatalogDigest === computeDexDigest(dexCatalog);
  if (context.recompute === true || context.tokenCatalog || context.dexCatalog || defaultBound) {
    const expected = replayDiscoveryReceipts(receipts, {
      sourceSha: receipts.sourceSha,
      config: context.config ?? defaultConfig,
      tokenCatalog: context.tokenCatalog ?? tokenCatalog,
      dexCatalog: context.dexCatalog ?? dexCatalog,
      priorState: context.priorState,
    });
    if (stableStringify(expected) !== stableStringify(proposals.proposals)) {
      const firstDifference = expected.findIndex((entry, index) => stableStringify(entry) !== stableStringify(proposals.proposals[index]));
      fail(`proposal artifact does not match deterministic receipt replay (${expected.length}/${proposals.proposals.length}) at ${firstDifference}`, "ARTIFACT_INVALID");
    }
  }
  if (artifacts.admissions) {
    validateDiscoveryAdmissions(artifacts.admissions);
    if (artifacts.admissions.sourceSha !== receipts.sourceSha || artifacts.admissions.configDigest !== receipts.configDigest || artifacts.admissions.tokenCatalogDigest !== receipts.tokenCatalogDigest || artifacts.admissions.dexCatalogDigest !== receipts.dexCatalogDigest) fail("admission bindings do not match receipts", "ARTIFACT_INVALID");
  }
  return true;
}

export function validateDiscoveryState(state, context = {}) {
  if (!isRecord(state) || state.schemaVersion !== 1 || state.artifactKind !== "discovery-state") fail("discovery state envelope is invalid", "ARTIFACT_INVALID");
  digest(state.configDigest, "state.configDigest");
  digest(state.tokenCatalogDigest, "state.tokenCatalogDigest");
  digest(state.dexCatalogDigest, "state.dexCatalogDigest");
  for (const group of [state.factories, state.programs, state.mints]) if (!isRecord(group)) fail("discovery state groups are invalid", "ARTIFACT_INVALID");
  for (const entry of Object.values(state.factories)) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.backfillNext) || entry.backfillNext < 0 || !Array.isArray(entry.pendingIndexes) || !Array.isArray(entry.completedIndexes)) fail("factory state is invalid", "ARTIFACT_INVALID");
    if (entry.backfillNext > entry.count || entry.pendingIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= entry.count) || entry.completedIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= entry.count)) fail("factory cursor queue is invalid", "ARTIFACT_INVALID");
    if (entry.tailCursor !== undefined && entry.tailCursor !== entry.count || entry.backfillCursor !== undefined && entry.backfillCursor !== entry.backfillNext) fail("factory cursor aliases are inconsistent", "ARTIFACT_INVALID");
    if (new Set(entry.pendingIndexes).size !== entry.pendingIndexes.length || new Set(entry.completedIndexes).size !== entry.completedIndexes.length || entry.pendingIndexes.some((index) => entry.completedIndexes.includes(index))) fail("factory cursor queue contains duplicates or overlap", "ARTIFACT_INVALID");
  }
  for (const group of [state.programs, state.mints]) for (const entry of Object.values(group)) {
    if (!isRecord(entry)) fail("Solana discovery state entry is invalid", "ARTIFACT_INVALID");
    const pending = entry.pendingPubkeys ?? entry.pendingQueue ?? [];
    const complete = entry.completedPubkeys ?? entry.completePubkeySet ?? [];
    const invalidQueue = !Array.isArray(pending) || !Array.isArray(complete) || pending.some((pubkey) => typeof pubkey !== "string" || !BASE58_RE.test(pubkey)) || complete.some((pubkey) => typeof pubkey !== "string" || !BASE58_RE.test(pubkey));
    const duplicateQueue = Array.isArray(pending) && (new Set(pending).size !== pending.length || new Set(complete).size !== complete.length);
    const overlapQueue = Array.isArray(pending) && Array.isArray(complete) && pending.some((pubkey) => complete.includes(pubkey));
    if (invalidQueue || duplicateQueue || overlapQueue || Array.isArray(pending) && pending.some((pubkey) => decodeBase58(pubkey)?.length !== 32) || Array.isArray(complete) && complete.some((pubkey) => decodeBase58(pubkey)?.length !== 32)) fail("Solana pending queue is invalid", "ARTIFACT_INVALID");
  }
  if (context.config && state.configDigest !== computeDiscoveryConfigDigest(normalizeConfig(context.config))) fail("state config digest mismatch", "ARTIFACT_INVALID");
  return true;
}

export function validateDiscoveryAdmissions(admissions) {
  if (!isRecord(admissions) || admissions.schemaVersion !== 1 || admissions.artifactKind !== "discovery-admissions" || !Array.isArray(admissions.proposals) || !Array.isArray(admissions.tokenAppend) || !Array.isArray(admissions.poolAppend)) fail("admissions envelope is invalid", "ADMISSION_INVALID");
  const allowed = new Set(["schemaVersion", "artifactKind", "sourceSha", "configDigest", "tokenCatalogDigest", "dexCatalogDigest", "appendOnly", "workspace", "tokenPolicy", "selectionPolicy", "poolQualification", "proposals", "tokenAppend", "poolAppend", "deferred"]);
  if (Object.keys(admissions).some((key) => !allowed.has(key))) fail("admissions envelope contains an unapproved field", "ADMISSION_INVALID");
  sourceSha(admissions.sourceSha, "admissions.sourceSha");
  validateWorkspace(admissions.workspace, "admissions.workspace");
  if (admissions.appendOnly !== true || admissions.tokenPolicy !== "qualified-pool-dependencies" || admissions.selectionPolicy !== "chain-round-robin-liquidity-desc" || !isRecord(admissions.poolQualification)) fail("admissions policy is invalid", "ADMISSION_INVALID");
  for (const proposal of admissions.proposals) if (!isRecord(proposal) || !ALIAS_RE.test(proposal.alias)) fail("admission proposal alias is invalid", "ADMISSION_INVALID");
  for (const proposal of admissions.tokenAppend) if (!isRecord(proposal) || proposal.kind !== "token" || !["ethereum", "avalancheC", "solana"].includes(proposal.namespace)) fail("token admission append is invalid", "ADMISSION_INVALID");
  for (const proposal of admissions.poolAppend) if (!isRecord(proposal) || proposal.kind !== "pool") fail("pool admission append is invalid", "ADMISSION_INVALID");
  if (!Array.isArray(admissions.deferred) || admissions.deferred.some((entry) => !isRecord(entry) || !isRecord(entry.proposal) || typeof entry.reason !== "string")) fail("deferred admissions are invalid", "ADMISSION_INVALID");
  return true;
}

function proposalEvidence(proposal) {
  return Array.isArray(proposal?.evidence) ? proposal.evidence.find((entry) => isRecord(entry)) ?? {} : {};
}

function proposalNativeLiquidity(proposal, config, tokenCatalogValue) {
  const chainId = proposal.chainId;
  const source = config.admission.poolQualification.sources[chainId];
  if (!source) return null;
  const wrap = tokenCatalogValue.deployments.find((entry) => entry.deploymentId === source.nativeWrapDeploymentId);
  const token0 = proposal.token0Address ?? proposal.tokens?.[0] ?? proposal.canonical?.token0Address;
  const token1 = proposal.token1Address ?? proposal.tokens?.[1] ?? proposal.canonical?.token1Address;
  const token0Id = proposal.canonical?.token0DeploymentId;
  const token1Id = proposal.canonical?.token1DeploymentId;
  if (!wrap?.address || !token0 || !token1) return null;
  const normalizedWrap = EVM_CHAINS.has(chainId) ? wrap.address.toLowerCase() : wrap.address;
  const normalized0 = EVM_CHAINS.has(chainId) ? token0.toLowerCase() : token0;
  const normalized1 = EVM_CHAINS.has(chainId) ? token1.toLowerCase() : token1;
  const nativeIndex = token0Id === source.nativeWrapDeploymentId || normalized0 === normalizedWrap ? 0 : token1Id === source.nativeWrapDeploymentId || normalized1 === normalizedWrap ? 1 : -1;
  if (nativeIndex < 0) return null;
  const evidence = proposalEvidence(proposal);
  const raw = evidence.nativeLiquidity ?? (EVM_CHAINS.has(chainId) ? evidence.reserves?.[nativeIndex] : evidence.vaultAmounts?.[nativeIndex] ?? evidence.reserves?.[nativeIndex]);
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const liquidity = BigInt(raw);
  const floor = BigInt(source.minNativeLiquidity);
  const validPositive = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) > 0n;
  const balances = evidence.vaultAmounts ?? evidence.reserves;
  const positiveOther = EVM_CHAINS.has(chainId)
    ? Array.isArray(evidence.reserves) && evidence.reserves.length === 2 && evidence.reserves.every(validPositive)
    : Array.isArray(balances) && balances.length === 2 && balances.every(validPositive) && (evidence.liquidity === undefined || validPositive(evidence.liquidity)) && evidence.swapDisabled !== true;
  if (!positiveOther || liquidity < floor) return null;
  return liquidity;
}

function selectQualifiedAdmissions(ordered, config, tokenCatalogValue) {
  const tokens = ordered.filter((entry) => entry.kind === "token");
  const tokenById = new Map(tokens.map((entry) => [entry.deploymentId ?? entry.id, entry]));
  const knownTokenIds = new Set(tokenCatalogValue.deployments.map((entry) => entry.deploymentId));
  const qualified = ordered.filter((entry) => entry.kind === "pool")
    .map((entry) => ({ entry, liquidity: proposalNativeLiquidity(entry, config, tokenCatalogValue) }))
    .filter((candidate) => candidate.liquidity !== null);
  const chainOrder = Object.values(TOKEN_CHAIN_IDS);
  const queues = new Map(chainOrder.map((chainId) => [chainId, qualified.filter((candidate) => candidate.entry.chainId === chainId).sort((left, right) => right.liquidity < left.liquidity ? -1 : right.liquidity > left.liquidity ? 1 : left.entry.id.localeCompare(right.entry.id))]));
  const selectedPools = [];
  const selectedUnknownTokenIds = new Set();
  let progress = true;
  while (selectedPools.length < config.limits.maxAdmissionPools && progress) {
    progress = false;
    for (const chainId of chainOrder) {
      if (selectedPools.length >= config.limits.maxAdmissionPools) break;
      const queue = queues.get(chainId);
      if (!queue || queue.length === 0) continue;
      const candidate = queue.shift();
      const dependencies = [candidate.entry.canonical?.token0DeploymentId, candidate.entry.canonical?.token1DeploymentId].filter((id) => typeof id === "string");
      const newDependencies = dependencies.filter((id) => !knownTokenIds.has(id) && !selectedUnknownTokenIds.has(id));
      if (newDependencies.some((id) => !tokenById.has(id))) continue;
      if (selectedUnknownTokenIds.size + newDependencies.length > config.limits.maxAdmissionTokens) continue;
      selectedPools.push(candidate.entry);
      newDependencies.forEach((id) => selectedUnknownTokenIds.add(id));
      progress = true;
    }
  }
  const selectedTokens = [...selectedUnknownTokenIds].map((id) => tokenById.get(id)).filter(Boolean);
  return { selectedTokens, selectedPools, qualified: new Set(qualified.map((candidate) => candidate.entry.id)), tokenById };
}

export function admitDiscoveryProposals(proposals, { tokenCatalog: tokenCatalogValue = tokenCatalog, dexCatalog: dexCatalogValue = dexCatalog, sourceSha: sourceShaValue, config = defaultConfig, workspace = { clean: true, pinned: true } } = {}) {
  validateTokenCatalog(tokenCatalogValue);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  const normalizedConfig = normalizeConfig(config);
  sourceSha(sourceShaValue ?? "0".repeat(40));
  const list = Array.isArray(proposals) ? proposals : proposals?.proposals;
  if (!Array.isArray(list)) fail("proposals must be an array", "ADMISSION_INVALID");
  const ordered = sortProposals(list);
  const { selectedTokens, selectedPools } = selectQualifiedAdmissions(ordered, normalizedConfig, tokenCatalogValue);
  const selected = [...selectedTokens, ...selectedPools];
  collisionCheck(selected, tokenCatalogValue, dexCatalogValue);
  const namespaceFor = (chainId) => chainId === TOKEN_CHAIN_IDS.ethereum ? "ethereum" : chainId === TOKEN_CHAIN_IDS.avalancheC ? "avalancheC" : "solana";
  const tokenAppend = selected.filter((entry) => entry.kind === "token").map((entry) => ({ ...entry, namespace: namespaceFor(entry.chainId) }));
  const poolAppend = selected.filter((entry) => entry.kind === "pool");
  const result = artifactEnvelope("discovery-admissions", {
    sourceSha: sourceShaValue ?? "0".repeat(40),
    configDigest: computeDiscoveryConfigDigest(normalizedConfig),
    tokenCatalogDigest: computeTokenDigest(tokenCatalogValue),
    dexCatalogDigest: computeDexDigest(dexCatalogValue),
    appendOnly: true,
    tokenPolicy: normalizedConfig.admission.tokenPolicy,
    selectionPolicy: normalizedConfig.admission.selectionPolicy,
    poolQualification: normalizedConfig.admission.poolQualification,
    workspace: defaultWorkspace({ workspace }),
    proposals: selected,
    tokenAppend,
    poolAppend,
    deferred: ordered.filter((entry) => !selected.some((candidate) => candidate.id === entry.id)).map((entry) => ({ proposal: entry, reason: entry.kind === "pool" && !proposalNativeLiquidity(entry, normalizedConfig, tokenCatalogValue) ? "pool-not-qualified" : entry.kind === "token" ? "not-a-qualified-pool-dependency" : "admission-cap-or-dependency-closure" })),
  });
  validateDiscoveryAdmissions(result);
  return result;
}

export const buildAdmissions = admitDiscoveryProposals;

/**
 * Validate the invariant expected by the M2 canonical writer. Discovery never
 * calls this with a live catalog; it is also useful to the writer's preflight
 * and makes accidental retirement/rebinding of an old record observable.
 */
export function validateAppendOnly(previousTokenCatalog, nextTokenCatalog, previousDexCatalog = dexCatalog, nextDexCatalog = dexCatalog) {
  try {
    validateTokenCatalog(previousTokenCatalog);
    validateTokenCatalog(nextTokenCatalog);
    validateDexCatalog(previousDexCatalog, { tokenCatalog: previousTokenCatalog });
    validateDexCatalog(nextDexCatalog, { tokenCatalog: nextTokenCatalog });
  } catch (error) {
    throw new DiscoveryValidationError("append candidate catalog is invalid", "ADMISSION_INVALID");
  }
  const nextDeployments = new Map(nextTokenCatalog.deployments.map((entry) => [entry.deploymentId, entry]));
  const nextAssets = new Map(nextTokenCatalog.assets.map((entry) => [entry.assetId, entry]));
  const nextAliases = new Map(nextTokenCatalog.aliases.map((entry) => [`${entry.namespace}\u0000${entry.name}`, entry]));
  for (const deployment of previousTokenCatalog.deployments) {
    const next = nextDeployments.get(deployment.deploymentId);
    const projection = (entry, catalog) => {
      const asset = catalog.assets.find((candidate) => candidate.assetId === entry.assetId);
      return {
        deploymentId: entry.deploymentId,
        assetId: entry.assetId,
        name: asset?.name ?? null,
        representationKind: asset?.representationKind ?? null,
        stableCurrency: asset?.stableCurrency ?? null,
        underlyingAssetId: asset?.underlyingAssetId ?? null,
        economicReferenceAssetId: asset?.economicReferenceAssetId ?? null,
        chainId: entry.chainId,
        symbol: entry.symbol,
        decimals: entry.decimals,
        standard: entry.standard,
        address: normalizeTokenAddress(entry.chainId, entry.address),
        status: entry.status,
        replacedByDeploymentId: entry.replacedByDeploymentId,
      };
    };
    if (!next || stableStringify(projection(deployment, previousTokenCatalog)) !== stableStringify(projection(next, nextTokenCatalog))) throw new DiscoveryRunError("ADMISSION_INVALID");
  }
  for (const asset of previousTokenCatalog.assets) if (!nextAssets.has(asset.assetId) || stableStringify(asset) !== stableStringify(nextAssets.get(asset.assetId))) throw new DiscoveryRunError("ADMISSION_INVALID");
  for (const alias of previousTokenCatalog.aliases) if (!nextAliases.has(`${alias.namespace}\u0000${alias.name}`) || stableStringify({ namespace: alias.namespace, name: alias.name, deploymentId: alias.deploymentId }) !== stableStringify({ namespace: nextAliases.get(`${alias.namespace}\u0000${alias.name}`).namespace, name: nextAliases.get(`${alias.namespace}\u0000${alias.name}`).name, deploymentId: nextAliases.get(`${alias.namespace}\u0000${alias.name}`).deploymentId })) throw new DiscoveryRunError("ADMISSION_INVALID");
  const nextDexes = new Map(nextDexCatalog.dexDeployments.map((entry) => [entry.dexDeploymentId, entry]));
  const nextPools = new Map(nextDexCatalog.poolDefinitions.map((entry) => [entry.poolDefinitionId, entry]));
  const nextDexAliases = new Map(nextDexCatalog.aliases.map((entry) => [`${entry.namespace}\u0000${entry.name}`, entry]));
  for (const dex of previousDexCatalog.dexDeployments) {
    const next = nextDexes.get(dex.dexDeploymentId);
    if (!next || stableStringify({ ...dex, evidence: undefined, asOfDate: undefined }) !== stableStringify({ ...next, evidence: undefined, asOfDate: undefined })) throw new DiscoveryRunError("ADMISSION_INVALID");
  }
  for (const pool of previousDexCatalog.poolDefinitions) {
    const next = nextPools.get(pool.poolDefinitionId);
    if (!next || stableStringify({ ...pool, evidence: undefined, asOfDate: undefined }) !== stableStringify({ ...next, evidence: undefined, asOfDate: undefined })) throw new DiscoveryRunError("ADMISSION_INVALID");
  }
  for (const alias of previousDexCatalog.aliases) if (!nextDexAliases.has(`${alias.namespace}\u0000${alias.name}`) || stableStringify({ ...alias, evidence: undefined, asOfDate: undefined }) !== stableStringify({ ...nextDexAliases.get(`${alias.namespace}\u0000${alias.name}`), evidence: undefined, asOfDate: undefined })) throw new DiscoveryRunError("ADMISSION_INVALID");
  const nextWraps = new Map(nextDexCatalog.nativeWrapDefinitions.map((entry) => [entry.nativeWrapDefinitionId, entry]));
  for (const wrap of previousDexCatalog.nativeWrapDefinitions) if (!nextWraps.has(wrap.nativeWrapDefinitionId) || stableStringify({ ...wrap, evidence: undefined, asOfDate: undefined }) !== stableStringify({ ...nextWraps.get(wrap.nativeWrapDefinitionId), evidence: undefined, asOfDate: undefined })) throw new DiscoveryRunError("ADMISSION_INVALID");
  return true;
}

export const validateAdmissionAppend = validateAppendOnly;

function deriveVerifiedReplayState(receipts, config, tokenDigest, dexDigest, priorState, verifiedEvmPairIndexes, verifiedEvmPairRows, verifiedEmptyPairIndexes, verifiedSolanaPools, transcript) {
  if (priorState && isRecord(priorState) && (priorState.configDigest !== undefined && priorState.configDigest !== receipts.configDigest || priorState.tokenCatalogDigest !== undefined && priorState.tokenCatalogDigest !== tokenDigest || priorState.dexCatalogDigest !== undefined && priorState.dexCatalogDigest !== dexDigest)) throw new DiscoveryValidationError("prior discovery state binding is stale", "ARTIFACT_INVALID");
  const replayState = initialState({ configDigest: receipts.configDigest, tokenDigest, dexDigest, priorState });
  for (const factoryReceipt of receipts.receipts.filter((row) => row.kind === "evm-factory" && row.status === "success")) {
    const dexId = factoryReceipt.dexDeploymentId ?? factoryReceipt.subjectId;
    const factoryConfig = config.evm.factories.find((entry) => entry.dexDeploymentId === dexId);
    if (!factoryConfig) continue;
    const count = factoryReceipt.pairCount;
    const current = factoryState(replayState, dexId);
    const { tailStart } = factoryScanPlan(current, factoryConfig, count);
    const failedRows = receipts.receipts.filter((row) => row.kind === "evm-pair" && row.dexDeploymentId === dexId && Number.isSafeInteger(row.pairIndex));
    const evidence = factoryAttemptEvidence(transcript, factoryReceipt, factoryConfig, current, failedRows);
    if (!evidence.valid) fail(evidence.reason, "ARTIFACT_INVALID");
    const successfulClaimed = new Set(factoryReceipt.successfulIndexes);
    const actualSuccesses = new Set([
      ...verifiedEvmPairRows.filter((row) => row.dexDeploymentId === dexId && successfulClaimed.has(row.pairIndex)).map((row) => row.pairIndex),
      ...(verifiedEmptyPairIndexes.get(dexId) ?? new Set()),
    ]);
    if ([...successfulClaimed].some((index) => !actualSuccesses.has(index))) fail("successful factory index lacks a matching raw pair receipt", "ARTIFACT_INVALID");
    const attempted = evidence.attempted;
    const succeeded = actualSuccesses;
    replayState.__lastBlockNumber = factoryReceipt.blockNumber ?? null;
    replayState.__lastBlockHash = factoryReceipt.blockHash ?? null;
    updateFactoryState(replayState, dexId, current, { count, backfillLimit: factoryConfig.pairScan.backfill, tailStart, attempted, succeeded });
  }
  const byProgram = new Map();
  const failedByProgram = new Map();
  for (const row of receipts.receipts.filter((entry) => entry.kind === "solana-program" && entry.status === "success" && entry.address && Array.isArray(entry.mints))) {
    const list = byProgram.get(row.dexDeploymentId) ?? [];
    list.push(row);
    byProgram.set(row.dexDeploymentId, list);
  }
  for (const row of receipts.receipts.filter((entry) => entry.kind === "solana-program" && entry.status === "failed" && entry.queue === "pending" && entry.address)) {
    const list = failedByProgram.get(row.dexDeploymentId) ?? [];
    list.push(row);
    failedByProgram.set(row.dexDeploymentId, list);
  }
  for (const program of config.solana.programs) {
    const current = isRecord(replayState.programs[program.dexDeploymentId]) ? replayState.programs[program.dexDeploymentId] : {};
    const previousPending = Array.isArray(current.pendingPubkeys) ? current.pendingPubkeys : Array.isArray(current.pendingQueue) ? current.pendingQueue : [];
    const previousComplete = Array.isArray(current.completedPubkeys) ? current.completedPubkeys : Array.isArray(current.completePubkeySet) ? current.completePubkeySet : [];
    const partitionReceipt = receipts.receipts.find((row) => row.kind === "solana-program" && row.status === "success" && row.queue === "gpa" && row.dexDeploymentId === program.dexDeploymentId);
    const verified = new Set([...(verifiedSolanaPools.has(program.dexDeploymentId) ? [verifiedSolanaPools.get(program.dexDeploymentId)] : []), ...((byProgram.get(program.dexDeploymentId) ?? []).map((row) => row.address))]);
    const gpaKeys = Array.isArray(partitionReceipt?.gpaPubkeys) ? partitionReceipt.gpaPubkeys : [];
    const completed = [...new Set([...previousComplete, ...[...verified].filter((address) => address)])].sort();
    const candidateQueue = [...new Set([...previousPending, ...gpaKeys])].filter((address) => !completed.includes(address));
    const failedAddresses = new Set((failedByProgram.get(program.dexDeploymentId) ?? []).map((row) => row.address));
    const gmaFailed = receipts.receipts.some((row) => row.kind === "solana-program" && row.dexDeploymentId === program.dexDeploymentId && row.status === "failed" && row.queue === "gma");
    const unattempted = gmaFailed ? candidateQueue : candidateQueue.filter((address) => !failedAddresses.has(address));
    const failed = gmaFailed ? [] : candidateQueue.filter((address) => failedAddresses.has(address));
    const pending = [...new Set([...unattempted, ...failed])].filter((address) => !completed.includes(address));
    replayState.programs[program.dexDeploymentId] = {
      partitionCursor: (Number.isSafeInteger(current.partitionCursor) ? current.partitionCursor + (partitionReceipt ? 1 : 0) : partitionReceipt ? 1 : 0) & 0xff,
      pendingPubkeys: pending,
      pendingQueue: pending,
      completedPubkeys: completed,
      completePubkeySet: completed,
      lastContextSlot: [...(byProgram.get(program.dexDeploymentId) ?? []), ...(partitionReceipt ? [partitionReceipt] : [])].map((row) => row.contextSlot).filter(Number.isSafeInteger).at(-1) ?? current.lastContextSlot ?? null,
    };
  }
  delete replayState.__lastBlockNumber;
  delete replayState.__lastBlockHash;
  return replayState;
}

export function replayDiscoveryReceipts(receipts, { sourceSha: sourceShaValue, config = defaultConfig, tokenCatalog: tokenCatalogValue = tokenCatalog, dexCatalog: dexCatalogValue = dexCatalog, priorState = undefined } = {}) {
  validateTokenCatalog(tokenCatalogValue);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  const normalizedConfig = normalizeConfig(config);
  if (!isRecord(receipts) || receipts.artifactKind !== "discovery-receipts" || !Array.isArray(receipts.receipts)) fail("receipts are invalid", "ARTIFACT_INVALID");
  sourceSha(sourceShaValue ?? receipts.sourceSha);
  const expectedSourceSha = sourceShaValue ?? receipts.sourceSha;
  if (receipts.sourceSha !== expectedSourceSha || receipts.configDigest !== computeDiscoveryConfigDigest(normalizedConfig) || receipts.tokenCatalogDigest !== computeTokenDigest(tokenCatalogValue) || receipts.dexCatalogDigest !== computeDexDigest(dexCatalogValue)) fail("receipt binding mismatch", "ARTIFACT_INVALID");
  if (receipts.rpcTranscript === undefined) {
    if (receipts.receipts.some((row) => row.status === "success")) fail("successful discovery receipts require an RPC transcript", "ARTIFACT_INVALID");
  } else validateRpcTranscript(receipts.rpcTranscript);
  const transcript = receipts.rpcTranscript ?? [];
  for (const entry of transcript) if (entry.endpointId !== normalizedConfig.rpc[entry.network]?.endpointId) fail("RPC transcript endpoint binding is invalid", "ARTIFACT_INVALID");
  const tokens = new Map();
  const pools = new Map();
  const verifiedEvmPairIndexes = new Map();
  const verifiedEvmPairRows = [];
  const verifiedEmptyPairIndexes = new Map();
  const verifiedSolanaPools = new Map();
  const replayFail = (message = "receipt raw evidence is invalid") => fail(message, "ARTIFACT_INVALID");
  const factoryByDex = new Map(normalizedConfig.evm.factories.map((entry) => [entry.dexDeploymentId, entry]));
  for (const row of receipts.receipts) {
    if (row.status !== "success" || row.kind !== "evm-factory") continue;
    if (!isRecord(row.raw) || typeof row.raw.allPairsLength !== "string") replayFail("successful factory receipt lacks raw result");
    let rawCount;
    try { rawCount = Number(wordQuantity(row.raw.allPairsLength)); } catch { replayFail("successful factory count is malformed"); }
    const factory = factoryByDex.get(row.dexDeploymentId ?? row.subjectId);
    if (rawCount !== row.pairCount || !factory || row.address !== factory.factory) replayFail("successful factory receipt binding is invalid");
    if (row.request?.blockHash !== row.blockHash) replayFail("successful factory request is not bound to its block");
    const factoryTag = blockTag(row.blockHash);
    const expectedChain = factory.network === "ethereum" ? "0x1" : "0xa86a";
    if (!transcriptCallMatches(transcript, { network: row.network, method: "eth_chainId", params: [], result: expectedChain }) || !transcriptBlockMatches(transcript, { network: row.network, params: ["finalized", false], row }) || !transcriptBlockMatches(transcript, { network: row.network, params: [row.blockNumber, false], row }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_getCode", params: [factory.factory, factoryTag], predicate: transcriptCodePresent }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: factory.factory, data: EVM_DISCOVERY_SELECTORS.allPairsLength }, factoryTag], result: row.raw.allPairsLength })) replayFail("successful factory raw result is not bound to its exact RPC request");
  }
  for (const row of receipts.receipts.filter((entry) => entry.kind === "solana-program" && entry.status === "success" && entry.queue === "gpa")) {
    if (!Array.isArray(row.gpaPubkeys) || row.gpaPubkeys.some((pubkey) => typeof pubkey !== "string") || new Set(row.gpaPubkeys).size !== row.gpaPubkeys.length) replayFail("Solana GPA key set is incomplete");
    const sorted = [...row.gpaPubkeys].sort();
    if (row.request?.gpaPubkeyCount !== row.gpaPubkeys.length || row.request?.gpaPubkeySetDigest !== createHash("sha256").update(JSON.stringify(sorted)).digest("hex")) replayFail("Solana GPA key set digest mismatch");
    const programId = row.dexDeploymentId;
    const program = normalizedConfig.solana.programs.find((entry) => entry.dexDeploymentId === programId);
    const partitionText = String(row.subjectId).split(":").at(-1);
    const partition = Number(partitionText);
    const layout = program ? { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol] ?? {}, ...program.layout } : null;
    if (!program || !layout || !Number.isSafeInteger(partition) || !transcriptCallMatches(transcript, { network: "solana", method: "getProgramAccounts", params: [program.program, { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: row.request.minContextSlot, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: layout.dataSize }, { memcmp: { offset: 0, bytes: encodeBase58(Buffer.from(layout.discriminator, "hex")) } }, { memcmp: { offset: layout.vaultOffsets[0], bytes: encodeBase58(Uint8Array.from([partition])) } }] }], predicate: (value) => { const context = solanaResultContext(value); const pubkeys = Array.isArray(context.value) ? context.value.map((entry) => entry?.pubkey).filter((entry) => typeof entry === "string") : []; return context.context?.slot >= row.contextSlot && stableStringify([...pubkeys].sort()) === stableStringify(sorted); } })) replayFail("Solana GPA receipt is not bound to its exact request and response");
  }
  for (const row of receipts.receipts) {
    if (row.status !== "success") continue;
    if (row.kind === "evm-token") {
      const tokenFactory = factoryByDex.get(row.dexDeploymentId ?? String(row.subjectId ?? "").split(":")[0]);
      if (!tokenFactory || TOKEN_CHAIN_IDS[tokenFactory.network] !== TOKEN_CHAIN_IDS[row.network]) replayFail("successful EVM token receipt factory binding is invalid");
      if (!isRecord(row.raw) || typeof row.raw.decimals !== "string" || typeof row.raw.supply !== "string") replayFail("successful EVM token receipt lacks raw results");
      try { if (wordQuantity(row.raw.decimals) !== BigInt(row.decimals) || wordQuantity(row.raw.supply) !== BigInt(row.supply)) replayFail("successful EVM token raw result does not match receipt"); } catch { replayFail("successful EVM token raw result is malformed"); }
      const tokenTag = blockTag(row.blockHash);
      if (!transcriptCallMatches(transcript, { network: row.network, method: "eth_getCode", params: [row.address, tokenTag], predicate: transcriptCodePresent }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: row.address, data: EVM_DISCOVERY_SELECTORS.tokenDecimals }, tokenTag], result: row.raw.decimals }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: row.address, data: EVM_DISCOVERY_SELECTORS.tokenTotalSupply }, tokenTag], result: row.raw.supply }) || row.raw.symbolResult && !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: row.address, data: EVM_DISCOVERY_SELECTORS.tokenSymbol }, tokenTag], result: row.raw.symbolResult })) replayFail("successful EVM token raw result is not bound to its exact RPC request");
      if (row.request?.blockHash !== row.blockHash) replayFail("successful token request is not bound to its block");
      let observedSymbol = null;
      if (row.raw.symbolResult) { try { observedSymbol = safeObservedSymbol(decodeAbiString(row.raw.symbolResult)); } catch { observedSymbol = null; } }
      if (row.observedSymbol !== undefined && row.observedSymbol !== observedSymbol) replayFail("successful EVM token symbol evidence does not match raw result");
      if (row.address && Number.isSafeInteger(row.decimals)) {
        const key = `${row.network}\u0000${row.address.toLowerCase()}`;
        if (!tokens.has(key)) tokens.set(key, { ...row, observedSymbol });
      }
    }
    if (row.kind === "solana-mint" && row.address && Number.isSafeInteger(row.decimals)) {
      if (!row.raw) replayFail("successful Solana mint receipt lacks raw account");
      if (!Number.isSafeInteger(row.contextSlot) || row.request?.minContextSlot > row.contextSlot) replayFail("successful Solana mint request is not bound to its context slot");
      try {
        const parsed = parseSolanaMint(row.address, row.raw, normalizedConfig.solana.mintPrograms);
        if (parsed.decimals !== row.decimals || parsed.supply !== row.supply) replayFail("successful Solana mint raw result does not match receipt");
        if (!transcriptMultipleAccountMatches(transcript, { network: "solana", addresses: [row.address], address: row.address, raw: row.raw, minContextSlot: row.request.minContextSlot })) replayFail("successful Solana mint raw account is not bound to an exact RPC request");
        const key = `solana\u0000${row.address}`;
        if (!tokens.has(key)) tokens.set(key, { ...row, ...parsed });
      } catch { replayFail("successful Solana mint raw account is invalid"); }
    }
    if (row.kind === "solana-program" && Array.isArray(row.mints) && Array.isArray(row.tokenMetadata)) {
      if (!isRecord(row.raw) || !row.raw.poolAccount || !Array.isArray(row.raw.mintAccounts) || !Array.isArray(row.raw.vaultAccounts) || !row.raw.configAccount) replayFail("successful Solana program receipt lacks raw accounts");
      if (!Number.isSafeInteger(row.contextSlot) || row.request?.minContextSlot > row.contextSlot) replayFail("successful Solana program request is not bound to its context slot");
      const program = normalizedConfig.solana.programs.find((entry) => entry.dexDeploymentId === row.dexDeploymentId);
      if (!program || row.program !== program.program) replayFail("successful Solana program receipt has unknown program");
      const layout = { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol] ?? {}, ...program.layout };
      try {
        const verified = parseSolanaPoolAccount(row.address, row.raw.poolAccount, { ...program, layout }, layout);
        const poolAddresses = row.request?.poolAccountAddresses;
        const poolIndex = row.request?.poolAccountIndex;
        const poolContextSlot = row.request?.poolAccountContextSlot ?? row.contextSlot;
        if (!Array.isArray(poolAddresses) || !Number.isSafeInteger(poolIndex) || poolIndex < 0 || poolAddresses[poolIndex] !== row.address || !Number.isSafeInteger(poolContextSlot)) replayFail("successful Solana pool receipt lacks its exact account batch binding");
        const hasPool = transcriptMultipleAccountMatches(transcript, { network: "solana", addresses: poolAddresses, address: row.address, raw: row.raw.poolAccount, minContextSlot: row.request.minContextSlot, expectedContextSlot: poolContextSlot });
        const relatedAccountBindings = row.request?.relatedAccountBindings;
        if (!Array.isArray(relatedAccountBindings) || relatedAccountBindings.length !== 5) replayFail("successful Solana pool receipt lacks exact related account batches");
        const relatedAddresses = [...verified.mints, ...verified.vaults, verified.configAddress];
        const relatedRaw = [row.raw.mintAccounts[0], row.raw.mintAccounts[1], row.raw.vaultAccounts[0], row.raw.vaultAccounts[1], row.raw.configAccount];
        const hasRelated = relatedAddresses.every((address, index) => {
          const binding = relatedAccountBindings[index];
          return binding?.address === address && Array.isArray(binding.addresses) && Number.isSafeInteger(binding.index) && binding.index >= 0 && binding.addresses[binding.index] === address && Number.isSafeInteger(binding.contextSlot) && transcriptMultipleAccountMatches(transcript, { network: "solana", addresses: binding.addresses, address, raw: relatedRaw[index], minContextSlot: row.request.minContextSlot, expectedContextSlot: binding.contextSlot });
        });
        if (!hasPool || !hasRelated) replayFail("successful Solana program raw accounts are not bound to exact batched RPC requests");
        const expectedContextSlot = Math.min(poolContextSlot, ...relatedAccountBindings.map((binding) => binding.contextSlot));
        if (row.contextSlot !== expectedContextSlot || row.slot !== expectedContextSlot) replayFail("Solana pool receipt context slot is not the minimum exact account context");
        const mint0 = parseSolanaMint(verified.mints[0], row.raw.mintAccounts[0], normalizedConfig.solana.mintPrograms);
        const mint1 = parseSolanaMint(verified.mints[1], row.raw.mintAccounts[1], normalizedConfig.solana.mintPrograms);
        parseSolanaVault(verified.vaults[0], row.raw.vaultAccounts[0], verified.mints[0], normalizedConfig.solana.mintPrograms, verified.pubkey, mint0.owner);
        parseSolanaVault(verified.vaults[1], row.raw.vaultAccounts[1], verified.mints[1], normalizedConfig.solana.mintPrograms, verified.pubkey, mint1.owner);
        if (!row.raw.configAccount || accountOwner(row.raw.configAccount) !== program.program || !accountData(row.raw.configAccount)?.length) replayFail("successful Solana config account is invalid");
        if (stableStringify(row.mints) !== stableStringify(verified.mints) || stableStringify(row.vaults) !== stableStringify(verified.vaults)) replayFail("successful Solana pool receipt does not match raw account");
        const parsedMetadata = [mint0, mint1];
        if (stableStringify(row.tokenMetadata) !== stableStringify(parsedMetadata)) replayFail("successful Solana token metadata does not match raw accounts");
        parsedMetadata.forEach((metadata, index) => {
          const key = `solana\u0000${verified.mints[index]}`;
          if (!tokens.has(key)) tokens.set(key, { ...metadata, pool: row.address, program: row.program, contextSlot: row.contextSlot });
        });
        verifiedSolanaPools.set(row.dexDeploymentId, row.address);
      } catch (error) { replayFail(`successful Solana program raw account is invalid: ${error.code ?? "account"}`); }
    }
    if (row.kind === "evm-pair" && row.address && Array.isArray(row.tokens)) {
      const factory = factoryByDex.get(row.dexDeploymentId ?? String(row.subjectId ?? "").split(":")[0]);
      if (!factory || !isRecord(row.raw) || typeof row.raw.allPairs !== "string" || typeof row.raw.pairFactory !== "string" || typeof row.raw.token0 !== "string" || typeof row.raw.token1 !== "string" || typeof row.raw.reserves !== "string" || typeof row.raw.factoryPair !== "string") replayFail("successful EVM pair receipt lacks raw results");
      try {
        if (row.request?.blockHash !== row.blockHash) replayFail("successful pair request is not bound to its block");
        const pair = wordAddress(row.raw.allPairs);
        const token0 = wordAddress(row.raw.token0);
        const token1 = wordAddress(row.raw.token1);
        const reserves = [wordQuantity(row.raw.reserves, 0), wordQuantity(row.raw.reserves, 1)].map(String);
        const pairTag = blockTag(row.blockHash);
        if (!transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.allPairs}${encodeUint256(row.pairIndex)}` }, pairTag], result: row.raw.allPairs }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_getCode", params: [pair, pairTag], predicate: transcriptCodePresent }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairFactory }, pairTag], result: row.raw.pairFactory }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairToken0 }, pairTag], result: row.raw.token0 }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairToken1 }, pairTag], result: row.raw.token1 }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: pair, data: EVM_DISCOVERY_SELECTORS.pairGetReserves }, pairTag], result: row.raw.reserves }) || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.factoryGetPair}${encodeAddress(token0)}${encodeAddress(token1)}` }, pairTag], result: row.raw.factoryPair }) || pair !== row.address.toLowerCase() || row.factory !== factory.factory || wordAddress(row.raw.pairFactory) !== factory.factory.toLowerCase() || wordAddress(row.raw.factoryPair) !== pair || stableStringify([token0, token1]) !== stableStringify(row.tokens) || stableStringify(reserves) !== stableStringify(row.reserves)) replayFail("successful EVM pair raw result does not match exact RPC transcript");
        const poolKey = `${row.network}\u0000${pair}`;
        const currentPool = pools.get(poolKey);
        if (!currentPool || stableStringify(row).localeCompare(stableStringify(currentPool)) < 0) pools.set(poolKey, row);
        verifiedEvmPairRows.push(row);
      } catch (error) { replayFail(`successful EVM pair raw result is malformed: ${error.message ?? "invalid"}`); }
    }
    if (row.kind === "evm-pair" && row.raw?.allPairs && !Array.isArray(row.tokens)) {
      try {
        const dexId = row.dexDeploymentId ?? String(row.subjectId ?? "").split(":")[0];
        const factory = factoryByDex.get(dexId);
        const tag = blockTag(row.blockHash);
        if (wordAddress(row.raw.allPairs) !== "0x0000000000000000000000000000000000000000" || !factory || row.request?.blockHash !== row.blockHash || !transcriptCallMatches(transcript, { network: row.network, method: "eth_call", params: [{ to: factory.factory, data: `${EVM_DISCOVERY_SELECTORS.allPairs}${encodeUint256(row.pairIndex)}` }, tag], result: row.raw.allPairs })) replayFail("empty pair receipt is not bound to an exact RPC request");
        const emptyIndexes = verifiedEmptyPairIndexes.get(dexId) ?? new Set();
        emptyIndexes.add(row.pairIndex);
        verifiedEmptyPairIndexes.set(dexId, emptyIndexes);
      }
      catch { replayFail("empty EVM pair raw result is malformed"); }
    }
    if (row.kind === "solana-program" && row.address && Array.isArray(row.mints) && verifiedSolanaPools.get(row.dexDeploymentId) === row.address) {
      const poolKey = `solana\u0000${row.address}`;
      const currentPool = pools.get(poolKey);
      if (!currentPool || stableStringify(row).localeCompare(stableStringify(currentPool)) < 0) pools.set(poolKey, row);
    }
  }
  const knownTokenBinding = (chainId, address) => tokenCatalogValue.deployments.some((entry) => entry.chainId === chainId && entry.address !== null && normalizeTokenAddress(chainId, entry.address) === normalizeTokenAddress(chainId, address));
  for (const row of verifiedEvmPairRows) {
    const chainId = TOKEN_CHAIN_IDS[row.network];
    if (!chainId || row.tokens.some((address) => !knownTokenBinding(chainId, address) && !tokens.has(`${row.network}\u0000${address.toLowerCase()}`))) continue;
    const pairIndexes = verifiedEvmPairIndexes.get(row.dexDeploymentId) ?? new Set();
    pairIndexes.add(row.pairIndex);
    verifiedEvmPairIndexes.set(row.dexDeploymentId, pairIndexes);
  }
  const tokenMapsValue = tokenMaps(tokenCatalogValue);
  const dexMapsValue = dexMaps(dexCatalogValue);
  const proposals = [];
  for (const [binding, row] of tokens) {
    const [network, address] = binding.split("\u0000");
    const chainId = TOKEN_CHAIN_IDS[network];
    if (!chainId || tokenMapsValue.byBinding.has(`${chainId}\u0000${address}`)) continue;
    const evidence = network === "solana"
      ? { network, program: row.program, pool: row.pool, contextSlot: row.contextSlot ?? row.slot }
      : { network, blockNumber: row.blockNumber, blockHash: row.blockHash, method: "eth_getCode+eth_call" };
    proposals.push(canonicalTokenProposal({ chainId, address, standard: row.standard ?? (network === "solana" ? "spl-token" : "erc20"), decimals: row.decimals, observedSymbol: row.observedSymbol ?? null, evidence, tokenReceipt: row }));
  }
  for (const [binding, row] of pools) {
    const [network, address] = binding.split("\u0000");
    const chainId = TOKEN_CHAIN_IDS[network];
    const dexDeploymentId = row.dexDeploymentId ?? (String(row.subjectId ?? "").split(":")[0] || null);
    const dex = dexDeploymentId ?? (network === "ethereum" ? "dex-deployment-0001" : network === "avalancheC" ? "dex-deployment-0002" : "dex-deployment-0003");
    if (!chainId || dexMapsValue.poolsByBinding.has(`${chainId}\u0000${address}`)) continue;
    const tokensForPool = row.tokens ?? row.mints ?? [];
    if (tokensForPool.length !== 2) continue;
    const known0 = tokenMapsValue.byBinding.get(`${chainId}\u0000${EVM_CHAINS.has(chainId) ? tokensForPool[0].toLowerCase() : tokensForPool[0]}`);
    const known1 = tokenMapsValue.byBinding.get(`${chainId}\u0000${EVM_CHAINS.has(chainId) ? tokensForPool[1].toLowerCase() : tokensForPool[1]}`);
    const evidence = network === "solana"
      ? { network, program: row.program, contextSlot: row.contextSlot ?? row.slot, layout: row.layout, vaults: row.vaults, vaultAmounts: row.vaultAmounts, vaultFrozen: row.vaultFrozen, liquidity: row.liquidity, sqrtPrice: row.sqrtPrice, swapDisabled: row.vaultFrozen?.some(Boolean) || row.statusByte !== null && row.statusByte !== undefined && (row.statusByte & (normalizedConfig.solana.programs.find((entry) => entry.dexDeploymentId === row.dexDeploymentId)?.layout?.swapDisabledMask ?? 0)) !== 0 }
      : { network, pairIndex: row.pairIndex, blockNumber: row.blockNumber, blockHash: row.blockHash, factory: row.factory, reserves: row.reserves };
    proposals.push(canonicalPoolProposal({ chainId, address, dexDeploymentId: dex, token0Address: tokensForPool[0], token1Address: tokensForPool[1], token0DeploymentId: known0?.deploymentId, token1DeploymentId: known1?.deploymentId, evidence }));
  }
  const result = sortProposals(closeProposalDependencies(proposals, tokenCatalogValue));
  collisionCheck(result, tokenCatalogValue, dexCatalogValue);
  const verifiedState = deriveVerifiedReplayState(receipts, normalizedConfig, computeTokenDigest(tokenCatalogValue), computeDexDigest(dexCatalogValue), priorState, verifiedEvmPairIndexes, verifiedEvmPairRows, verifiedEmptyPairIndexes, verifiedSolanaPools, transcript);
  if (verifiedState) {
    validateDiscoveryState(verifiedState, { config: normalizedConfig });
    if (verifiedState.configDigest !== receipts.configDigest || verifiedState.tokenCatalogDigest !== receipts.tokenCatalogDigest || verifiedState.dexCatalogDigest !== receipts.dexCatalogDigest) replayFail("state binding mismatch");
    if (priorState) validateDiscoveryState(initialState({ configDigest: receipts.configDigest, tokenDigest: computeTokenDigest(tokenCatalogValue), dexDigest: computeDexDigest(dexCatalogValue), priorState }), { config: normalizedConfig });
    for (const factoryReceipt of receipts.receipts.filter((row) => row.kind === "evm-factory" && row.status === "success")) {
      if (!Array.isArray(factoryReceipt.scannedIndexes) || !Array.isArray(factoryReceipt.successfulIndexes) || !Array.isArray(factoryReceipt.failedIndexes)) replayFail("factory receipt lacks cursor transition");
      const scanned = new Set(factoryReceipt.scannedIndexes);
      const successful = new Set(factoryReceipt.successfulIndexes);
      const failed = new Set(factoryReceipt.failedIndexes);
      if (successful.size + failed.size !== scanned.size || [...successful].some((index) => !scanned.has(index)) || [...failed].some((index) => !scanned.has(index) || successful.has(index))) replayFail("factory cursor transition is inconsistent");
      const cursor = verifiedState.factories[factoryReceipt.dexDeploymentId ?? factoryReceipt.subjectId];
      if (cursor && (cursor.backfillNext > factoryReceipt.pairCount || factoryReceipt.successfulIndexes.some((index) => cursor.pendingIndexes.includes(index)))) replayFail("factory cursor transition is inconsistent with its receipts");
    }
    for (const partitionReceipt of receipts.receipts.filter((row) => row.kind === "solana-program" && row.status === "success" && row.queue === "gpa" && Array.isArray(row.gpaPubkeys))) {
      const cursor = verifiedState.programs[partitionReceipt.dexDeploymentId ?? String(partitionReceipt.subjectId).split(":")[0]];
      if (cursor) {
      const covered = new Set([...(cursor.pendingPubkeys ?? []), ...(cursor.completedPubkeys ?? [])]);
        if (partitionReceipt.gpaPubkeys.some((pubkey) => !covered.has(pubkey))) replayFail("Solana cursor transition omitted a GPA pubkey");
      }
    }
  }
  Object.defineProperties(result, {
    proposals: { value: result, enumerable: false },
    state: { value: verifiedState, enumerable: false },
    replayed: { value: { proposals: result, state: verifiedState }, enumerable: false },
    verifiedCursorTransitions: { value: verifiedState?.factories ?? {}, enumerable: false },
  });
  return result;
}

export const replayDiscovery = replayDiscoveryReceipts;

export async function discoverCatalog(options = {}) {
  const config = normalizeConfig(typeof options.config === "string" ? JSON.parse(await readFile(options.config, "utf8")) : options.config ?? defaultConfig);
  const tokenCatalogValue = options.tokenCatalog ?? tokenCatalog;
  const dexCatalogValue = options.dexCatalog ?? dexCatalog;
  validateTokenCatalog(tokenCatalogValue);
  validateDexCatalog(dexCatalogValue, { tokenCatalog: tokenCatalogValue });
  const sourceShaValue = options.sourceSha ?? "0".repeat(40);
  sourceSha(sourceShaValue);
  const configDigest = computeDiscoveryConfigDigest(config);
  const tokenDigest = computeTokenDigest(tokenCatalogValue);
  const dexDigest = computeDexDigest(dexCatalogValue);
  const priorStateValue = typeof options.state === "string" ? JSON.parse(await readFile(options.state, "utf8")) : options.state;
  if (isRecord(priorStateValue) && (priorStateValue.configDigest !== undefined && priorStateValue.configDigest !== configDigest || priorStateValue.tokenCatalogDigest !== undefined && priorStateValue.tokenCatalogDigest !== tokenDigest || priorStateValue.dexCatalogDigest !== undefined && priorStateValue.dexCatalogDigest !== dexDigest)) throw new DiscoveryValidationError("prior discovery state binding is stale", "CONFIG_DIGEST_MISMATCH");
  const state = initialState({ configDigest, tokenDigest, dexDigest, priorState: priorStateValue });
  const start = nowMs(options.clock);
  const runBudget = Math.min(options.runBudgetMs ?? config.limits.runBudgetMs, config.limits.runBudgetMs, DISCOVERY_LIMITS.runBudgetMs);
  const sourceBudget = Math.max(1, Math.floor(runBudget / Math.max(1, new Set([...config.evm.factories.map((entry) => entry.network), "solana"]).size)));
  const networkClients = options.rpcClient ? null : Object.fromEntries(NETWORKS.map((network) => [network, createBoundedRpcClient({ ...options, runBudgetMs: runBudget }, config)]));
  const suppliedClient = options.rpcClient ?? networkClients;
  const rawClient = networkClients
    ? (network, method, params) => networkClients[network](network, method, params)
    : typeof suppliedClient === "function"
    ? suppliedClient
    : suppliedClient && typeof suppliedClient.request === "function"
      ? (network, method, params) => suppliedClient.request(method, params, { network })
      : suppliedClient && typeof suppliedClient.call === "function"
        ? (network, method, params) => suppliedClient.call(method, params, { network })
        : suppliedClient;
  const localTranscript = [];
  let localTranscriptId = 1;
  const recordingClient = async (network, method, params) => {
    const request = { jsonrpc: "2.0", id: localTranscriptId++, method, params: deepClone(params) };
    try {
      const result = await rawClient(network, method, params);
      const endpoint = config.rpc[network];
      if (echoesCredential(JSON.stringify(result), options, endpoint)) throw new DiscoveryRunError("RPC_RESULT_INVALID");
      if (!Array.isArray(suppliedClient?.transcript)) localTranscript.push({ network, endpointId: config.rpc[network]?.endpointId ?? null, observedAt: new Date(nowMs(options.clock)).toISOString(), request, response: { jsonrpc: "2.0", id: request.id, result: boundedTranscriptValue(normalizeRpcResponse(result), config.limits.rpcBodyBytes) } });
      return result;
    } catch (error) {
      if (!Array.isArray(suppliedClient?.transcript)) localTranscript.push({ network, endpointId: config.rpc[network]?.endpointId ?? null, observedAt: new Date(nowMs(options.clock)).toISOString(), request, response: { jsonrpc: "2.0", id: request.id, error: { code: typeof error?.code === "string" && DISCOVERY_ERROR_CODE_SET.has(error.code) ? error.code : "RPC_ERROR" } } });
      throw error;
    }
  };
  const sourceIndex = new Map([...new Set([...config.evm.factories.map((entry) => entry.network), "solana"])].map((network, index) => [network, index]));
  const client = withRpcConcurrency(recordingClient, config.limits.maxConcurrentRequests, (network) => Math.min(start + runBudget, start + ((sourceIndex.get(network) ?? 0) + 1) * sourceBudget), options.clock);
  const tokenMapsValue = tokenMaps(tokenCatalogValue);
  const dexMapsValue = dexMaps(dexCatalogValue);
  const receipts = [];
  const proposals = [];
  const networkStatus = [];
  let partial = false;
  for (const factory of config.evm.factories) {
    const result = await readEvmFactory(factory, client, state, config, tokenMapsValue, dexMapsValue, receipts, proposals, networkStatus, options);
    if (result.status !== "complete") partial = true;
  }
  for (const program of config.solana.programs) {
    const normalizedProgram = { ...program, layout: { ...SOLANA_DISCOVERY_LAYOUTS[program.protocol] ?? {}, ...program.layout } };
    const result = await readSolanaProgram(normalizedProgram, client, config, state, tokenMapsValue, dexMapsValue, receipts, proposals, networkStatus);
    if (result.status !== "complete") partial = true;
  }
  state.scanMints = options.discoverMints === true;
  const mintResult = await readSolanaMints(config, client, state, tokenMapsValue, receipts, proposals);
  if (mintResult.status === "partial") partial = true;
  const workspace = defaultWorkspace(options);
  const status = partial ? "partial" : "complete";
  const coverage = coverageFor(config, receipts, status);
  const rpcTranscript = Array.isArray(suppliedClient?.transcript) ? suppliedClient.transcript : localTranscript;
  const receiptArtifact = artifactEnvelope("discovery-receipts", { sourceSha: sourceShaValue, configDigest, tokenCatalogDigest: tokenDigest, dexCatalogDigest: dexDigest, status, workspace, coverage, rpcTranscript, receipts: receipts.sort((left, right) => `${left.kind}\u0000${left.subjectId}`.localeCompare(`${right.kind}\u0000${right.subjectId}`)), state: deepClone(state) });
  normalizeFactoryCursorClaims(receiptArtifact, config, priorStateValue, rpcTranscript);
  const verifiedReplay = replayDiscoveryReceipts(receiptArtifact, { sourceSha: sourceShaValue, config, tokenCatalog: tokenCatalogValue, dexCatalog: dexCatalogValue, priorState: priorStateValue });
  receiptArtifact.state = verifiedReplay.state;
  const verifiedProposals = [...verifiedReplay];
  collisionCheck(verifiedProposals, tokenCatalogValue, dexCatalogValue);
  const proposalArtifact = artifactEnvelope("discovery-proposals", { sourceSha: sourceShaValue, configDigest, tokenCatalogDigest: tokenDigest, dexCatalogDigest: dexDigest, status, workspace, coverage, proposals: verifiedProposals, reviewRequired: true });
  const evidenceArtifact = artifactEnvelope("discovery-evidence", { sourceSha: sourceShaValue, configDigest, tokenCatalogDigest: tokenDigest, dexCatalogDigest: dexDigest, status, coverage, receipts: deepClone(receiptArtifact.receipts), networkStatus: networkStatus.sort((left, right) => left.subjectId.localeCompare(right.subjectId)) });
  const admissions = admitDiscoveryProposals(verifiedProposals, { tokenCatalog: tokenCatalogValue, dexCatalog: dexCatalogValue, sourceSha: sourceShaValue, config, workspace });
  const artifacts = { receipts: receiptArtifact, proposals: proposalArtifact, evidence: evidenceArtifact, state: artifactEnvelope("discovery-state", verifiedReplay.state), admissions };
  validateDiscoveryArtifacts(artifacts, { config, tokenCatalog: tokenCatalogValue, dexCatalog: dexCatalogValue, recompute: true, priorState: priorStateValue });
  validateDiscoveryState(artifacts.state, { config });
  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(resolve(options.outputDir, DISCOVERY_ARTIFACT_FILENAMES.receipts), `${JSON.stringify(receiptArtifact, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, DISCOVERY_ARTIFACT_FILENAMES.proposals), `${JSON.stringify(proposalArtifact, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, DISCOVERY_ARTIFACT_FILENAMES.evidence), `${JSON.stringify(evidenceArtifact, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, DISCOVERY_ARTIFACT_FILENAMES.state), `${JSON.stringify(artifacts.state, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, DISCOVERY_ARTIFACT_FILENAMES.admissions), `${JSON.stringify(admissions, null, 2)}\n`);
  }
  return artifacts;
}

export const discover = discoverCatalog;
export const runDiscovery = discoverCatalog;
export const discoverTokenAndPools = discoverCatalog;
export const discoverTokensAndPools = discoverCatalog;
export const collectDiscovery = discoverCatalog;
export const collectDiscoveryReceipts = discoverCatalog;
export const validateDiscovery = validateDiscoveryArtifacts;
export const replayDiscoveryEvidence = replayDiscoveryReceipts;
export const decodeSolanaPoolAccount = parseSolanaPoolAccount;
export const decodeSolanaMintAccount = parseSolanaMint;
export const decodeSolanaVaultAccount = parseSolanaVault;

export function exitCodeForDiscovery(artifacts) {
  if (!artifacts?.receipts || !artifacts?.proposals) return 70;
  if (artifacts.receipts.status === "partial") return 3;
  if (artifacts.proposals.proposals.length > 0) return 2;
  return 0;
}

export const DEFAULT_DISCOVERY_CONFIG = defaultConfig;
export const DEFAULT_TOKEN_CATALOG = tokenCatalog;
export const DEFAULT_DEX_CATALOG = dexCatalog;
export const DISCOVERY_CHAINS = TOKEN_CHAIN_IDS;
export const DISCOVERY_DEX_CHAINS = DEX_CHAIN_IDS;
export { TOKEN_CHAIN_IDS };
export { TOKEN_PROGRAM_IDS };
