#!/usr/bin/env node

/*
 * M2 data promotion.
 *
 * This module is deliberately a small policy boundary.  Online collectors
 * produce receipts; this module replays the receipts against a frozen main
 * checkout and creates an additive catalog candidate.  The candidate is then
 * rendered with the normal catalog renderers.  Nothing in an observation is
 * imported or executed and no uploaded file is treated as an authoritative
 * source.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import canonicalRanking from "./token-rankings.json" with { type: "json" };
import canonicalDiscoveryConfig from "./discovery-config.json" with { type: "json" };
import canonicalRankingConfig from "./ranking-config.json" with { type: "json" };
import {
  computeDigest as computeTokenDigest,
  normalizeAddress as normalizeTokenAddress,
  renderLanguage as renderTokenLanguage,
  validateCatalog as validateTokenCatalog,
  OUTPUTS as TOKEN_OUTPUTS,
} from "./token-catalog.mjs";
import {
  computeDigest as computeDexDigest,
  validateCatalog as validateDexCatalog,
} from "./dex-catalog.mjs";
import { OUTPUTS as DEX_OUTPUTS, renderLanguage as renderDexLanguage } from "./generate-dex-catalog.mjs";
import { OUTPUTS as RANKING_OUTPUTS, renderLanguage as renderRankingLanguage } from "./generate-token-rankings.mjs";
import {
  computeDiscoveryConfigDigest,
  decodeSolanaMintAccount,
  decodeSolanaPoolAccount,
  decodeSolanaVaultAccount,
  replayDiscoveryReceipts,
  discoverCatalog,
  validateDiscoveryState,
  DISCOVERY_LIMITS,
  DEFAULT_DISCOVERY_CONFIG,
} from "./discovery.mjs";
import * as poolObserver from "./pool-observer.mjs";
import {
  computeDigest as computeRankingDigest,
  replayRankings,
  replayTokenRankings,
  collectTokenRankings,
  validateRankingArtifact,
} from "./token-rankings.mjs";
import * as rankingProducer from "./token-rankings.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");

export const DATA_PROMOTION_SCHEMA_VERSION = 1;
export const DATA_PROMOTION_KIND = "erpc-sdk-data-maintenance-observation";
export const DATA_CANDIDATE_KIND = "erpc-sdk-data-maintenance-candidate";
export const DATA_ARTIFACT_FILENAMES = Object.freeze({
  observation: "maintenance-observation.json",
  discovery: "discovery-receipts.json",
  pool: "pool-receipts.json",
  ranking: "ranking-receipts.json",
});
export const GENERATED_OUTPUTS = Object.freeze({
  token: Object.freeze({ ...TOKEN_OUTPUTS }),
  dex: Object.freeze({ ...DEX_OUTPUTS }),
  ranking: Object.freeze({ ...RANKING_OUTPUTS }),
});
export const GENERATED_PATHS = Object.freeze([
  ...Object.values(TOKEN_OUTPUTS),
  ...Object.values(DEX_OUTPUTS),
  ...Object.values(RANKING_OUTPUTS),
].sort());
export const CANONICAL_DATA_PATHS = Object.freeze([
  "registry/token-catalog.json",
  "registry/dex-catalog.json",
  "registry/token-rankings.json",
  "registry/discovery-state.json",
].sort());
export const CANDIDATE_OUTPUT_PATHS = Object.freeze([...CANONICAL_DATA_PATHS, ...GENERATED_PATHS].sort());
export const DATA_BRANCH = "codex/registry-maintenance";
export const DATA_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const REQUIRED_CI_CONTEXT = "required-ci";
export const PUBLISHED_ROOT_TAG = "v0.6.0";
export const PUBLISHED_GO_TAG = "packages/go/v0.6.0";
export const PUBLISHED_PAIRED_PEEL = "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc";

const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ALIAS_RE = /^DISCOVERED_[0-9A-F]{16}$/u;
const POOL_ALIAS_RE = /^DISCOVERED_POOL_[0-9A-F]{16}$/u;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
// Keep raw artifacts and the enclosing observation under fixed, finite
// envelope bounds. The plain default capture measured 8,029,808 compact
// bytes for discovery receipts; the 12 MiB raw limit leaves bounded headroom
// for the same configured scan while the 16 MiB envelope covers all receipts.
const MAX_RAW_BYTES = 12 * 1024 * 1024;
const MAX_RAW_AGGREGATE_BYTES = 16 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 16 * 1024 * 1024;
const VOLATILE_KEY_RE = /^(?:sourceSha|sourceSHA|sourceTreeSha|baseSha|baseSHA|observedAt|observationTime|timestamp|date|time|block|blockNumber|slot|anchorSlot|contextSlot|retry|retryCount|requestId|requestID|runId|runID|runAttempt|attempt|workflowRunId|ciRunId)$/u;
const EVM_CHAINS = new Set(["eip155:1", "eip155:43114"]);
const SOLANA_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const CHAIN_NAMESPACE = Object.freeze({ "eip155:1": "ethereum", "eip155:43114": "avalancheC", [SOLANA_CHAIN]: "solana" });
const ADMISSION_MIN_NATIVE_LIQUIDITY = Object.freeze({
  "eip155:1": 10_000_000_000_000_000_000n,
  "eip155:43114": 100_000_000_000_000_000_000n,
  [SOLANA_CHAIN]: 100_000_000_000n,
});
const ADMISSION_TOKEN_CAP = 8;
const ADMISSION_POOL_CAP = 8;
const DEFERRED_POOL_REQUEUE_REASONS = new Set(["pool-cap", "missing-token-dependency"]);
const MAX_DISCOVERY_PENDING = Number.isSafeInteger(DISCOVERY_LIMITS?.maxPending) ? DISCOVERY_LIMITS.maxPending : 1024;

export class DataPromotionError extends Error {
  constructor(message, code = "DATA_PROMOTION_INVALID") {
    super(message);
    this.name = "DataPromotionError";
    this.code = code;
  }
}

function fail(message, code = "DATA_PROMOTION_INVALID") {
  throw new DataPromotionError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value, label = "value") {
  try { return structuredClone(value); } catch (error) { fail(`${label} is not JSON data: ${error.message}`, "ARTIFACT_INVALID"); }
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase SHA`, "BINDING_INVALID");
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`, "BINDING_INVALID");
  return value;
}

function requireId(value, label) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) fail(`${label} must be a bounded identifier`, "ARTIFACT_INVALID");
  return value;
}

function requireDate(value, label) {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${label} must be YYYY-MM-DD`, "ARTIFACT_INVALID");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} must be a real calendar date`, "ARTIFACT_INVALID");
  return value;
}

function stableValue(value, key = "") {
  if (VOLATILE_KEY_RE.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry, key)).filter((entry) => entry !== undefined);
  if (isRecord(value)) {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      const child = stableValue(value[childKey], childKey);
      if (child !== undefined) result[childKey] = child;
    }
    return result;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function semanticFingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeOutputDigest(files) {
  if (!isRecord(files)) fail("files must be an object", "ARTIFACT_INVALID");
  const hash = createHash("sha256");
  for (const pathValue of Object.keys(files).sort()) {
    if (typeof files[pathValue] !== "string") fail(`generated file ${pathValue} must be UTF-8 text`, "ARTIFACT_INVALID");
    hash.update(pathValue, "utf8").update("\0", "utf8").update(files[pathValue], "utf8").update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function contentDigest(files) {
  return computeOutputDigest(files);
}

function safeRelativePath(root, value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || isAbsolute(value)) fail(`${label} must be repository-relative`, "PATH_INVALID");
  const base = resolve(root);
  const target = resolve(base, value);
  const actual = relative(base, target).split(sep).join("/");
  if (actual !== value || actual.startsWith("../") || isAbsolute(actual)) fail(`${label} escapes the repository`, "PATH_INVALID");
  return target;
}

function readFileBounded(filePath, limit = MAX_ARTIFACT_BYTES, label = "file") {
  let stat;
  try {
    const link = lstatSync(filePath);
    if (link.isSymbolicLink()) fail(`${label} may not be a symbolic link`, "ARTIFACT_INVALID");
    stat = statSync(filePath);
  } catch (error) { fail(`cannot read ${label}: ${error.message}`, "ARTIFACT_INVALID"); }
  if (!stat.isFile() || stat.size > limit) fail(`${label} is not a bounded regular file`, "ARTIFACT_TOO_LARGE");
  try {
    const bytes = readFileSync(filePath);
    if (bytes.byteLength > limit) fail(`${label} exceeds its byte bound`, "ARTIFACT_TOO_LARGE");
    return bytes;
  } catch (error) { fail(`cannot read ${label}: ${error.message}`, "ARTIFACT_INVALID"); }
}

function readJsonFile(root, relativePath, { optional = false } = {}) {
  const target = safeRelativePath(root, relativePath, "trusted input path");
  try {
    const bytes = readFileBounded(target, MAX_ARTIFACT_BYTES, relativePath);
    try { return JSON.parse(bytes.toString("utf8")); } catch (error) { fail(`${relativePath} is not valid JSON: ${error.message}`, "ARTIFACT_INVALID"); }
  } catch (error) {
    if (optional && error?.code === "ARTIFACT_INVALID" && /ENOENT/u.test(error.message)) return null;
    throw error;
  }
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    fail(`trusted git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`, "GIT_INVALID");
  }
  return String(result.stdout ?? "").trim();
}

function gitSha(root, rev) {
  const value = git(root, ["rev-parse", rev]);
  requireSha(value, `git revision ${rev}`);
  return value;
}

function gitTreeSha(root, rev) {
  const value = git(root, ["rev-parse", `${rev}^{tree}`]);
  requireSha(value, `git tree for ${rev}`);
  return value;
}

function gitFilesAtCommit(root, commitSha, paths) {
  requireSha(commitSha, "base commit SHA");
  if (!Array.isArray(paths) || paths.some((pathValue) => typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0") || pathValue.includes("\\"))) fail("candidate paths are invalid", "PATH_INVALID");
  // Resolve the commit before looking at individual paths.  A missing file is
  // a normal additive-data case; a missing/unreadable commit is a provenance
  // failure and must never be treated as an empty base.
  git(root, ["rev-parse", `${commitSha}^{commit}`]);
  const listing = git(root, ["ls-tree", "-r", commitSha, "--", ...paths]);
  const modes = new Map();
  for (const line of String(listing).split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^(\d+)\s+(?:blob|tree)\s+[0-9a-f]+\t(.+)$/u);
    if (!match) fail("trusted git base tree listing is malformed", "GIT_INVALID");
    modes.set(match[2], match[1]);
  }
  const present = new Set(modes.keys());
  const files = {};
  for (const pathValue of paths) {
    if (!present.has(pathValue)) {
      files[pathValue] = null;
      continue;
    }
    if (modes.get(pathValue) !== "100644") fail(`trusted base file ${pathValue} is not a regular blob`, "GIT_INVALID");
    const result = spawnSync("git", ["show", `${commitSha}:${pathValue}`], { cwd: root, encoding: null, stdio: "pipe" });
    if (result.error || result.status !== 0) fail(`trusted git could not read base file ${pathValue}: ${String(result.stderr ?? "").trim()}`, "GIT_INVALID");
    const bytes = Buffer.from(result.stdout ?? Buffer.alloc(0));
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) fail(`trusted base file ${pathValue} exceeds the bounded content limit`, "ARTIFACT_TOO_LARGE");
    files[pathValue] = bytes.toString("utf8");
  }
  return files;
}

function defaultRoot(options = {}) {
  return resolve(options.root ?? REPOSITORY_ROOT);
}

function endpointForChain(config, chainId) {
  const network = CHAIN_NAMESPACE[chainId];
  const endpoint = config?.rpc?.[network];
  if (typeof endpoint?.url !== "string" || !/^https?:\/\/\S+$/u.test(endpoint.url)) fail(`no reviewed RPC endpoint is configured for ${chainId}`, "CONFIG_INVALID");
  return endpoint.url;
}

function evidenceUrls(value, config, chainId) {
  const list = [];
  const approved = new Set(Object.values(config?.rpc ?? {}).map((entry) => entry?.url).filter((entry) => typeof entry === "string"));
  const add = (entry) => {
    if (typeof entry === "string" && approved.has(entry) && !list.includes(entry)) list.push(entry);
    else if (isRecord(entry)) for (const key of ["url", "sourceUrl", "endpoint", "rpcUrl"]) add(entry[key]);
  };
  if (Array.isArray(value)) value.forEach(add);
  else add(value);
  if (list.length === 0) list.push(endpointForChain(config, chainId));
  return list.slice(0, 16);
}

function addressForChain(chainId, address, label = "address") {
  if (typeof address !== "string" || address.length === 0 || /[\r\n\0]/u.test(address)) fail(`${label} is invalid`, "ARTIFACT_INVALID");
  if (EVM_CHAINS.has(chainId)) {
    if (!EVM_ADDRESS_RE.test(address)) fail(`${label} must be a 20-byte EVM address`, "ARTIFACT_INVALID");
    return address.toLowerCase();
  }
  if (chainId === SOLANA_CHAIN) {
    if (!BASE58_RE.test(address)) fail(`${label} must be a Solana address`, "ARTIFACT_INVALID");
    return address;
  }
  fail(`${label} uses an unsupported chain`, "ARTIFACT_INVALID");
}

function identityHash(kind, chainId, address, dexDeploymentId = "") {
  const normalized = addressForChain(chainId, address);
  return createHash("sha256").update(`${kind}\0${chainId}\0${normalized}${dexDeploymentId ? `\0${dexDeploymentId}` : ""}`).digest("hex");
}

export function discoveredIdentity(kind, chainId, address, dexDeploymentId = "") {
  const hash = identityHash(kind, chainId, address, dexDeploymentId);
  return kind === "pool" ? `discovered-pool-${hash}` : `discovered-token-${hash}`;
}

export function discoveredAlias(kind, chainId, address, dexDeploymentId = "") {
  const hash = identityHash(kind, chainId, address, dexDeploymentId).slice(0, 16).toUpperCase();
  return kind === "pool" ? `DISCOVERED_POOL_${hash}` : `DISCOVERED_${hash}`;
}

function catalogMaps(tokenCatalog, dexCatalog) {
  const tokensById = new Map(tokenCatalog.deployments.map((entry) => [entry.deploymentId, entry]));
  const assetsById = new Map(tokenCatalog.assets.map((entry) => [entry.assetId, entry]));
  const tokensByBinding = new Map(tokenCatalog.deployments.filter((entry) => entry.address !== null).map((entry) => [`${entry.chainId}\0${normalizeTokenAddress(entry.chainId, entry.address)}`, entry]));
  const poolsById = new Map(dexCatalog.poolDefinitions.map((entry) => [entry.poolDefinitionId, entry]));
  const poolsByBinding = new Map(dexCatalog.poolDefinitions.map((entry) => [`${entry.chainId}\0${EVM_CHAINS.has(entry.chainId) ? entry.address.toLowerCase() : entry.address}`, entry]));
  return { tokensById, assetsById, tokensByBinding, poolsById, poolsByBinding };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function proposalsFromReplay(value, kind) {
  if (Array.isArray(value)) return value.filter((entry) => isRecord(entry));
  if (!isRecord(value)) return [];
  for (const key of kind === "token" ? ["tokenAppend", "proposals", "candidates", "tokens"] : ["poolAppend", "proposals", "candidates", "pools"]) {
    if (Array.isArray(value[key])) return value[key].filter((entry) => isRecord(entry));
  }
  return [];
}

function rawArtifactValue(value, filename) {
  if (!isRecord(value)) fail(`${filename} artifact binding is invalid`, "ARTIFACT_INVALID");
  const content = value.json ?? value.value ?? value.content ?? value.data ?? value.artifact ?? value;
  const bytes = jsonBytes(content);
  if (bytes.byteLength > MAX_RAW_BYTES) fail(`${filename} exceeds the bounded raw artifact limit`, "ARTIFACT_TOO_LARGE");
  const expectedLength = value.byteLength ?? value.bytes ?? value.length;
  const expectedHash = value.sha256 ?? value.sha256Digest ?? value.hash ?? value.digest;
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength !== bytes.byteLength)) fail(`${filename} byte length binding is invalid`, "ARTIFACT_BINDING_MISMATCH");
  if (expectedHash !== undefined && (typeof expectedHash !== "string" || expectedHash !== sha256Bytes(bytes))) fail(`${filename} SHA-256 binding is invalid`, "ARTIFACT_BINDING_MISMATCH");
  return { value: clone(content, filename), bytes, byteLength: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function artifactSlot(observation, filename) {
  const container = observation.rawArtifacts;
  if (!isRecord(container) || !Object.hasOwn(container, filename)) fail(`observation is missing fixed ${filename}`, "ARTIFACT_INVALID");
  return rawArtifactValue(container[filename], filename);
}

function normalizeArtifactValue(value, filename) {
  // Producers may return an envelope, while a hand-built fixture may contain
  // only the receipts array.  The latter is accepted only as data and is
  // passed to the producer replay unchanged; it never grants admission.
  if (isRecord(value)) return value;
  if (Array.isArray(value)) return { schemaVersion: 1, artifactKind: filename.includes("discovery") ? "discovery-receipts" : filename.includes("pool") ? "pool-observations" : "ranking-receipts", receipts: value };
  fail(`${filename} contains no JSON object`, "ARTIFACT_INVALID");
}

function validateProducerEnvelopeKinds(raw) {
  if (!isRecord(raw.discovery.value) || raw.discovery.value.schemaVersion !== 1 || raw.discovery.value.artifactKind !== "discovery-receipts") fail("discovery artifact must be the strict discovery-receipts envelope", "REPLAY_INVALID");
  if (!isRecord(raw.pool.value) || raw.pool.value.schemaVersion !== 1 || !["pool-receipts", "pool-observations"].includes(raw.pool.value.artifactKind)) fail("pool artifact must be the strict pool-receipts envelope", "REPLAY_INVALID");
  if (!isRecord(raw.ranking.value) || raw.ranking.value.schemaVersion !== 1 || raw.ranking.value.artifactKind !== "ranking-receipts") fail("ranking artifact must be the strict ranking-receipts envelope", "REPLAY_INVALID");
}

function extractRawArtifacts(observation) {
  const discovery = artifactSlot(observation, DATA_ARTIFACT_FILENAMES.discovery);
  const pool = artifactSlot(observation, DATA_ARTIFACT_FILENAMES.pool);
  const ranking = artifactSlot(observation, DATA_ARTIFACT_FILENAMES.ranking);
  const result = {
    discovery: { ...discovery, value: normalizeArtifactValue(discovery.value, DATA_ARTIFACT_FILENAMES.discovery) },
    pool: { ...pool, value: normalizeArtifactValue(pool.value, DATA_ARTIFACT_FILENAMES.pool) },
    ranking: { ...ranking, value: normalizeArtifactValue(ranking.value, DATA_ARTIFACT_FILENAMES.ranking) },
  };
  if (Object.values(result).reduce((sum, entry) => sum + entry.bytes.byteLength, 0) > MAX_RAW_AGGREGATE_BYTES) fail("maintenance raw artifacts exceed the aggregate bound", "ARTIFACT_TOO_LARGE");
  return result;
}

function validateRawArtifactContainer(observation) {
  const container = observation.rawArtifacts;
  if (!isRecord(container) || observation.artifacts !== undefined || observation.receipts !== undefined || observation.raw !== undefined) fail("maintenance observation must contain one fixed rawArtifacts container", "ARTIFACT_INVALID");
  const expected = new Set([
    DATA_ARTIFACT_FILENAMES.discovery,
    DATA_ARTIFACT_FILENAMES.pool,
    DATA_ARTIFACT_FILENAMES.ranking,
  ]);
  const keys = Object.keys(container).sort();
  const expectedKeys = [...expected].sort();
  if (keys.join("\0") !== expectedKeys.join("\0")) fail("raw artifact container must contain exactly the three fixed receipt files", "ARTIFACT_INVALID");
}

function validateExecution(execution) {
  if (execution === undefined || execution === null) return { origin: "local", githubRunId: null, githubRunAttempt: null };
  if (!isRecord(execution)) fail("execution provenance must be an object", "PROVENANCE_INVALID");
  const origin = execution.origin ?? execution.executionOrigin ?? "local";
  if (!["scheduled", "workflow_dispatch", "local", "replay"].includes(origin)) fail("execution origin is invalid", "PROVENANCE_INVALID");
  const runId = execution.githubRunId ?? execution.runId ?? execution.github?.runId ?? null;
  const attempt = execution.githubRunAttempt ?? execution.runAttempt ?? execution.attempt ?? execution.github?.runAttempt ?? null;
  if (runId !== null && (!Number.isSafeInteger(runId) || runId < 1)) fail("GitHub run ID is invalid", "PROVENANCE_INVALID");
  if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1)) fail("GitHub run attempt is invalid", "PROVENANCE_INVALID");
  if ((runId === null) !== (attempt === null)) fail("GitHub run ID and attempt must be provided together", "PROVENANCE_INVALID");
  if (["scheduled", "workflow_dispatch"].includes(origin) && (runId === null || attempt === null)) fail("workflow execution provenance requires GitHub run ID and attempt", "PROVENANCE_INVALID");
  return { origin, githubRunId: runId, githubRunAttempt: attempt };
}

function validateObservationEnvelope(observation, { sourceSha, baseSha } = {}) {
  if (!isRecord(observation) || observation.schemaVersion !== DATA_PROMOTION_SCHEMA_VERSION || observation.kind !== DATA_PROMOTION_KIND) fail("maintenance observation envelope is invalid", "ARTIFACT_INVALID");
  const allowedKeys = new Set(["schemaVersion", "kind", "sourceSha", "sourceTreeSha", "baseSha", "baseline", "discoveryConfigDigest", "rankingConfigDigest", "execution", "rawArtifacts", "artifacts"]);
  if (Object.keys(observation).some((key) => !allowedKeys.has(key))) fail("maintenance observation contains an unapproved field", "ARTIFACT_INVALID");
  requireSha(observation.sourceSha, "observation sourceSha");
  requireSha(observation.sourceTreeSha, "observation sourceTreeSha");
  requireSha(observation.baseSha, "observation baseSha");
  if (sourceSha !== undefined && observation.sourceSha !== sourceSha) fail("observation source SHA does not match request", "SOURCE_MISMATCH");
  if (baseSha !== undefined && observation.baseSha !== baseSha) fail("observation base SHA does not match request", "BASE_MISMATCH");
  if (!isRecord(observation.baseline)) fail("observation baseline is missing", "ARTIFACT_INVALID");
  for (const key of ["tokenCatalogDigest", "dexCatalogDigest", "rankingDigest"]) requireDigest(observation.baseline[key], `baseline.${key}`);
  requireDigest(observation.discoveryConfigDigest, "discoveryConfigDigest");
  requireDigest(observation.rankingConfigDigest, "rankingConfigDigest");
  const execution = validateExecution(observation.execution);
  if (["scheduled", "workflow_dispatch"].includes(execution.origin) && observation.sourceSha !== observation.baseSha) fail("workflow observation source and base must be the same frozen main commit", "BINDING_INVALID");
  validateRawArtifactContainer(observation);
  const raw = extractRawArtifacts(observation);
  validateProducerEnvelopeKinds(raw);
  return { observation: clone(observation, "maintenance observation"), raw };
}

function producerReplayDiscovery(raw, context, override = undefined) {
  const replay = override ?? replayDiscoveryReceipts;
  if (typeof replay !== "function") fail("discovery producer replay is unavailable", "PRODUCER_INTERFACE_MISSING");
  try {
    return replay(raw, context);
  } catch (error) {
    fail(`discovery receipt replay failed: ${error.message}`, error.code ?? "REPLAY_INVALID");
  }
}

function producerReplayPool(raw, context, override = undefined) {
  const replay = override ?? poolObserver.replayPoolObservations ?? poolObserver.replayPoolReceipts;
  if (typeof replay !== "function") {
    // A no-candidate empty artifact is useful for local dry-runs while the
    // online producer is unavailable.  Any non-empty observation must fail;
    // it cannot be promoted using decoded status fields alone.
    const rows = raw?.observations ?? raw?.receipts ?? raw?.rows ?? [];
    if (Array.isArray(rows) && rows.length === 0) return [];
    fail("pool producer replay is unavailable", "PRODUCER_INTERFACE_MISSING");
  }
  try { return replay(raw, context); } catch (error) { fail(`pool receipt replay failed: ${error.message}`, error.code ?? "REPLAY_INVALID"); }
}

function producerReplayRanking(raw, context, override = undefined) {
  if (override === undefined && (!isRecord(raw) || raw.artifactKind !== "ranking-receipts" || raw.schemaVersion !== 1)) fail("ranking artifact must be the strict ranking-receipts envelope", "REPLAY_INVALID");
  if (override === undefined && Array.isArray(raw?.receipts) && raw.receipts.every((entry) => isRecord(entry) && (!Array.isArray(entry.calls) || entry.calls.length === 0) && (!Array.isArray(entry.pools) || entry.pools.length === 0))) {
    // An offline/empty receipt set contains no candidate facts.  Build the
    // explicit unranked projection from the trusted candidate catalog; this
    // does not promote any decoded values and keeps a collector outage
    // reviewable rather than treating it as a successful ranking.
    return replayTokenRankings({ candidates: [], unranked: [], provenance: [] }, { ...context, tokenCatalog: context.tokenCatalog });
  }
  const replay = override ?? replayRankings ?? ((input, options) => collectTokenRankings({ snapshot: input, ...options }));
  try { return replay(raw, context); } catch (error) { fail(`ranking receipt replay failed: ${error.message}`, error.code ?? "REPLAY_INVALID"); }
}

function proposalAddress(proposal, chainId, label) {
  return addressForChain(chainId, proposal.address ?? proposal.tokenAddress ?? proposal.poolAddress ?? proposal.canonical?.address, label);
}

function proposalChain(proposal) {
  const value = proposal.chainId ?? proposal.canonical?.chainId;
  if (typeof value !== "string" || !CHAIN_NAMESPACE[value]) fail("proposal chainId is invalid", "REPLAY_INVALID");
  return value;
}

function canonicalTokenFromProposal(proposal, config, asOfDate, maps) {
  const chainId = proposalChain(proposal);
  const address = proposalAddress(proposal, chainId, "token proposal address");
  const deploymentId = discoveredIdentity("token", chainId, address);
  const alias = discoveredAlias("token", chainId, address);
  if (maps.tokensByBinding.has(`${chainId}\0${normalizeTokenAddress(chainId, address)}`)) return null;
  const canonical = isRecord(proposal.canonical) ? proposal.canonical : proposal;
  const decimals = canonical.decimals ?? proposal.decimals;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) fail(`token ${address} decimals are invalid`, "REPLAY_INVALID");
  const standard = canonical.standard ?? proposal.standard ?? (chainId === SOLANA_CHAIN ? "spl-token" : "erc20");
  if (!["erc20", "spl-token", "spl-token-2022"].includes(standard)) fail(`token ${address} standard is invalid`, "REPLAY_INVALID");
  const symbol = address;
  const asset = {
    assetId: deploymentId,
    name: `Unclassified token at ${address}`,
    representationKind: "unclassified",
    stableCurrency: null,
    underlyingAssetId: null,
    economicReferenceAssetId: null,
    evidence: evidenceUrls(proposal.evidence ?? canonical.evidence, config, chainId),
    asOfDate,
  };
  const deployment = {
    deploymentId,
    assetId: deploymentId,
    chainId,
    symbol,
    decimals,
    standard,
    address,
    status: "active",
    replacedByDeploymentId: null,
    evidence: [...asset.evidence],
    asOfDate,
  };
  const aliasRow = { namespace: CHAIN_NAMESPACE[chainId], name: alias, deploymentId };
  if (!ALIAS_RE.test(aliasRow.name)) fail(`token ${address} alias is invalid`, "REPLAY_INVALID");
  return { asset, deployment, alias: aliasRow, address, quoteEligible: false, reviewRequired: false };
}

function tokenIdForAddress(tokenCatalog, chainId, address) {
  const binding = `${chainId}\0${normalizeTokenAddress(chainId, address)}`;
  return tokenCatalog.deployments.find((entry) => entry.address !== null && `${entry.chainId}\0${normalizeTokenAddress(entry.chainId, entry.address)}` === binding)?.deploymentId ?? null;
}

function canonicalPoolFromProposal(proposal, config, asOfDate, maps, tokenCatalog) {
  const chainId = proposalChain(proposal);
  const dexDeploymentId = proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId;
  requireId(dexDeploymentId, "pool proposal dexDeploymentId");
  const address = proposalAddress(proposal, chainId, "pool proposal address");
  const existing = maps.poolsByBinding.get(`${chainId}\0${EVM_CHAINS.has(chainId) ? address.toLowerCase() : address}`);
  if (existing) return null;
  const tokenAddresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
  const canonical = isRecord(proposal.canonical) ? proposal.canonical : proposal;
  const token0Address = addressForChain(chainId, tokenAddresses?.[0] ?? canonical.token0Address, "pool token0 address");
  const token1Address = addressForChain(chainId, tokenAddresses?.[1] ?? canonical.token1Address, "pool token1 address");
  const token0DeploymentId = tokenIdForAddress(tokenCatalog, chainId, token0Address);
  const token1DeploymentId = tokenIdForAddress(tokenCatalog, chainId, token1Address);
  if (!token0DeploymentId || !token1DeploymentId) return { dependencyMissing: true };
  const poolDefinitionId = discoveredIdentity("pool", chainId, address, dexDeploymentId);
  const alias = discoveredAlias("pool", chainId, address, dexDeploymentId);
  const dexEntry = maps.dexById?.get(dexDeploymentId);
  const adapter = isRecord(canonical.adapter) ? {
    kind: canonical.adapter.kind,
    feeNumerator: canonical.adapter.feeNumerator ?? null,
    feeDenominator: canonical.adapter.feeDenominator ?? null,
  } : {
    kind: dexEntry?.adapterKind ?? (EVM_CHAINS.has(chainId) ? "evm-constant-product-v2" : "solana-orca-whirlpool"),
    feeNumerator: EVM_CHAINS.has(chainId) ? "3" : null,
    feeDenominator: EVM_CHAINS.has(chainId) ? "1000" : null,
  };
  if (typeof adapter.kind !== "string" || !SAFE_ID_RE.test(adapter.kind)) fail(`pool ${address} adapter is invalid`, "REPLAY_INVALID");
  const dexCatalogEntry = [...maps.poolsById.values()].find((entry) => entry.dexDeploymentId === dexDeploymentId);
  if (!dexCatalogEntry && !dexEntry) {
    // maps from the caller includes dexById for the normal path.  Keep this
    // check explicit so a forged new deployment cannot enter the DEX catalog.
    fail(`pool ${address} references an unknown DEX deployment`, "REPLAY_INVALID");
  }
  const evidence = evidenceUrls(proposal.evidence ?? canonical.evidence, config, chainId);
  const pool = {
    poolDefinitionId,
    dexDeploymentId,
    chainId,
    address,
    token0DeploymentId,
    token1DeploymentId,
    adapter,
    status: "active",
    replacedByPoolDefinitionId: null,
    evidence,
    asOfDate,
  };
  return { pool, alias: { namespace: CHAIN_NAMESPACE[chainId], name: alias, dexDeploymentId: null, poolDefinitionId, evidence: [...evidence], asOfDate }, address, token0Address, token1Address, quoteEligible: false, reviewRequired: false };
}

function ensureMaps(tokenCatalog, dexCatalog) {
  const maps = catalogMaps(tokenCatalog, dexCatalog);
  maps.dexById = new Map(dexCatalog.dexDeployments.map((entry) => [entry.dexDeploymentId, entry]));
  return maps;
}

function discoveryCaptureDate(discoveryRaw) {
  let latestMillis = null;
  for (const entry of Array.isArray(discoveryRaw?.rpcTranscript) ? discoveryRaw.rpcTranscript : []) {
    const value = entry?.observedAt;
    if (typeof value !== "string" || !RFC3339_RE.test(value)) continue;
    const millis = Date.parse(value);
    if (Number.isFinite(millis) && (latestMillis === null || millis > latestMillis)) latestMillis = millis;
  }
  return latestMillis === null ? null : new Date(latestMillis).toISOString().slice(0, 10);
}

function candidateDate(discoveryRaw, tokenCatalog, dexCatalog, hasNewCandidates) {
  const captured = discoveryCaptureDate(discoveryRaw);
  if (captured !== null) return requireDate(captured, "candidate asOfDate");
  if (hasNewCandidates) fail("new catalog records require a bound discovery capture timestamp", "ARTIFACT_INVALID");
  return requireDate(tokenCatalog.manualAsOf ?? dexCatalog.manualAsOf, "candidate asOfDate");
}

function configForObservation(observation, options) {
  return options.config ?? canonicalDiscoveryConfig;
}

function rankingConfigForObservation(observation, options) {
  return options.rankingConfig ?? canonicalRankingConfig;
}

export function computeRankingConfigDigest(config) {
  const producer = rankingProducer.computeRankingConfigDigest ?? rankingProducer.computeConfigDigest;
  if (typeof producer === "function") {
    try { return producer(config); } catch { /* fall through to the stable local projection */ }
  }
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function replayDiscoveryCandidates(raw, context, override = undefined) {
  const replayed = producerReplayDiscovery(raw, context, override);
  return { replayed, proposals: proposalsFromReplay(replayed, "token").concat(proposalsFromReplay(replayed, "pool")) };
}

function uniqueByIdentity(list, keyFn) {
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const key = keyFn(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function hexWord(value, index = 0) {
  if (typeof value !== "string" || !/^0x[0-9a-f]*$/iu.test(value) || value.length % 2 !== 0) return null;
  const start = 2 + index * 64;
  if (value.length < start + 64) return null;
  try { return BigInt(`0x${value.slice(start, start + 64)}`); } catch { return null; }
}

function rawReserveValue(raw, index) {
  const value = typeof raw === "string" ? hexWord(raw, index) : Array.isArray(raw) ? raw[index] : isRecord(raw) ? raw[index === 0 ? "reserve0" : "reserve1"] ?? raw[index === 0 ? "token0Reserve" : "token1Reserve"] : null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function rawAddressWord(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value) || value.length < 42) return null;
  const encoded = value.slice(2);
  if (encoded.length < 64 || !/^0{24}[0-9a-f]{40}$/iu.test(encoded.slice(-64))) return null;
  const word = encoded.slice(-40);
  return `0x${word}`.toLowerCase();
}

function rawPoolRows(raw) {
  const rows = raw?.receipts ?? raw?.observations ?? raw?.rows ?? [];
  return Array.isArray(rows) ? rows.filter((entry) => isRecord(entry)) : [];
}

function poolAddressOf(proposal) {
  return proposal.address ?? proposal.poolAddress ?? proposal.canonical?.address ?? null;
}

function poolRawEvidence(proposal, discoveryRaw, poolRaw) {
  const chainId = proposalChain(proposal);
  const address = addressForChain(chainId, poolAddressOf(proposal), "pool proposal address");
  const normalize = (value) => EVM_CHAINS.has(chainId) ? String(value).toLowerCase() : String(value);
  const target = normalize(address);
  const rows = [...rawPoolRows(discoveryRaw), ...rawPoolRows(poolRaw)];
  return rows.filter((row) => {
    const candidate = row.address ?? row.poolAddress ?? row.canonical?.address;
    return candidate !== undefined && normalize(candidate) === target && (row.dexDeploymentId ?? row.canonical?.dexDeploymentId) === (proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId);
  });
}

function requireCandidatePoolCoverage(raw, replayed, poolCandidates) {
  if (!Array.isArray(poolCandidates) || poolCandidates.length === 0) return;
  const sourceRows = rawPoolRows(raw);
  const replayRows = Array.isArray(replayed) ? replayed : replayed?.observations ?? replayed?.receipts ?? [];
  if (!Array.isArray(replayRows)) fail("pool replay did not return canonical observation rows", "POOL_REPLAY_INVALID");
  for (const candidate of poolCandidates) {
    const pool = candidate?.pool;
    if (!isRecord(pool)) fail("pool candidate is missing its canonical pool definition", "POOL_REPLAY_INVALID");
    const matches = sourceRows.filter((row) => row?.poolDefinitionId === pool.poolDefinitionId && row?.poolAddress === pool.address && row?.dexDeploymentId === pool.dexDeploymentId && row?.chainId === pool.chainId);
    if (matches.length !== 1) fail(`pool observation coverage is not exact for ${pool.poolDefinitionId}`, "POOL_REPLAY_INVALID");
    const row = matches[0];
    // A candidate definition must have an independently replayable monitor
    // row. Status alone, including an outage/status flag, cannot authorize a
    // new pool after discovery admission.
    if (!isRecord(row.raw) || !isRecord(row.request)) fail(`pool observation ${pool.poolDefinitionId} lacks bound raw/request evidence`, "POOL_REPLAY_INVALID");
    const replayMatches = replayRows.filter((entry) => entry?.poolDefinitionId === pool.poolDefinitionId && entry?.poolAddress === pool.address && entry?.dexDeploymentId === pool.dexDeploymentId && entry?.chainId === pool.chainId);
    if (replayMatches.length !== 1) fail(`pool replay did not return exactly one verified row for ${pool.poolDefinitionId}`, "POOL_REPLAY_INVALID");
  }
}

function rawSolanaBytes(account) {
  const data = account?.data;
  if (Array.isArray(data) && typeof data[0] === "string" && data[1] === "base64") return Buffer.from(data[0], "base64");
  if (typeof data === "string") return Buffer.from(data, "base64");
  return null;
}

function nativeWrapForChain(dexCatalog, chainId) {
  return dexCatalog.nativeWrapDefinitions.find((entry) => entry.chainId === chainId && entry.status !== "retired") ?? null;
}

function admissionFloor(chainId, rankingConfig) {
  let configured = 0n;
  try { configured = BigInt(rankingConfig?.sources?.[chainId]?.minNativeLiquidity ?? 0); } catch { configured = 0n; }
  return configured > ADMISSION_MIN_NATIVE_LIQUIDITY[chainId] ? configured : ADMISSION_MIN_NATIVE_LIQUIDITY[chainId];
}

function nativeLiquidityFromRaw(proposal, rows, dexCatalog, tokenCatalog, config, rankingConfig) {
  const chainId = proposalChain(proposal);
  const dexDeploymentId = proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId;
  const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === dexDeploymentId);
  const wrap = nativeWrapForChain(dexCatalog, chainId);
  const tokenAddresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
  const token0Id = proposal.token0DeploymentId ?? proposal.canonical?.token0DeploymentId ?? (tokenAddresses?.[0] ? tokenIdForAddress(tokenCatalog, chainId, tokenAddresses[0]) : null);
  const token1Id = proposal.token1DeploymentId ?? proposal.canonical?.token1DeploymentId ?? (tokenAddresses?.[1] ? tokenIdForAddress(tokenCatalog, chainId, tokenAddresses[1]) : null);
  const nativeIs0 = token0Id === wrap?.wrappedTokenDeploymentId;
  const nativeIs1 = token1Id === wrap?.wrappedTokenDeploymentId;
  if (nativeIs0 === nativeIs1) return null;
  const nativeIndex = nativeIs0 ? 0 : 1;
  let best = null;
  for (const row of rows) {
    if (EVM_CHAINS.has(chainId)) {
      const reserves = row.raw?.reserves;
      const tokenWords = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
      // The normal path reaches this policy only after strict M1 replay has
      // matched this pair's exact allPairs/getCode/token/reserve transcript
      // requests. Code proof lives in that pinned transcript; the producer
      // does not duplicate it in the pair receipt as a pairCode flag.
      const identityValid = rawAddressWord(row.raw?.allPairs) === String(poolAddressOf(proposal)).toLowerCase()
        && rawAddressWord(row.raw?.factoryPair) === String(poolAddressOf(proposal)).toLowerCase()
        && rawAddressWord(row.raw?.pairFactory) === dex?.programAddress?.toLowerCase()
        && rawAddressWord(row.raw?.token0) === String(tokenWords?.[0]).toLowerCase()
        && rawAddressWord(row.raw?.token1) === String(tokenWords?.[1]).toLowerCase();
      if (!identityValid) continue;
      const value = rawReserveValue(reserves, nativeIndex);
      const other = rawReserveValue(reserves, nativeIndex === 0 ? 1 : 0);
      const maxReserve = (1n << 112n) - 1n;
      if (value !== null && other !== null && value > 0n && other > 0n && value <= maxReserve && other <= maxReserve && (best === null || value > best)) best = value;
      continue;
    }
    const programConfig = config?.solana?.programs?.find((entry) => entry.dexDeploymentId === (row.dexDeploymentId ?? proposal.dexDeploymentId));
    const layoutConfig = programConfig?.layout ?? {};
    const mintPrograms = Array.isArray(config?.solana?.mintPrograms) ? config.solana.mintPrograms : [];
    const tokenAddresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
    const poolAccount = row.raw?.poolAccount;
    const mintAccounts = Array.isArray(row.raw?.mintAccounts) ? row.raw.mintAccounts : [];
    const vaultAccounts = Array.isArray(row.raw?.vaultAccounts) ? row.raw.vaultAccounts : [];
    const configAccount = row.raw?.configAccount;
    if (!programConfig || mintAccounts.length !== 2 || vaultAccounts.length !== 2 || !isRecord(configAccount)) continue;
    try {
      // Reuse the producer's complete pool decoder: it checks owner, account
      // framing, discriminator, and PDA, and reads the full little-endian
      // u128 liquidity/price fields rather than only their low 64 bits.
      const verified = decodeSolanaPoolAccount(row.address, poolAccount, { ...programConfig, layout: layoutConfig }, layoutConfig);
      if (stableStringify(verified.mints) !== stableStringify(tokenAddresses) || stableStringify(row.mints ?? []) !== stableStringify(verified.mints)) continue;
      const mint0 = decodeSolanaMintAccount(verified.mints[0], mintAccounts[0], mintPrograms);
      const mint1 = decodeSolanaMintAccount(verified.mints[1], mintAccounts[1], mintPrograms);
      const vault0 = decodeSolanaVaultAccount(verified.vaults[0], vaultAccounts[0], verified.mints[0], mintPrograms, row.address, mint0.owner);
      const vault1 = decodeSolanaVaultAccount(verified.vaults[1], vaultAccounts[1], verified.mints[1], mintPrograms, row.address, mint1.owner);
      if (mint0.address !== verified.mints[0] || mint1.address !== verified.mints[1] || vault0.frozen || vault1.frozen) continue;
      const configBytes = rawSolanaBytes(configAccount);
      if (configAccount.owner !== dex?.programAddress || !configBytes || configBytes.length === 0) continue;
      const liquidity = verified.liquidity === null ? null : BigInt(verified.liquidity);
      const sqrtPrice = verified.sqrtPrice === null ? null : BigInt(verified.sqrtPrice);
      const statusMask = layoutConfig.swapDisabledMask;
      const statusAllowed = statusMask === undefined
        ? true
        : Number.isSafeInteger(verified.status) && (verified.status & statusMask) === 0;
      const priceAllowed = Number.isSafeInteger(layoutConfig.sqrtPriceOffset) && sqrtPrice === null ? false : sqrtPrice === null || sqrtPrice > 0n;
      const nativeVault = BigInt(vault0.amount) > 0n && BigInt(vault1.amount) > 0n ? BigInt(nativeIndex === 0 ? vault0.amount : vault1.amount) : null;
      if (liquidity !== null && liquidity > 0n && priceAllowed && statusAllowed && nativeVault !== null && (best === null || nativeVault > best)) best = nativeVault;
    } catch {
      // Strict M1 replay normally performs these checks before admission; a
      // test-only or hand-built row must still fail closed here.
    }
  }
  return best;
}

function configuredPoolAdmission(proposal, discoveryRaw, poolRaw, tokenCatalog, dexCatalog, config, rankingConfig) {
  const chainId = proposalChain(proposal);
  const dexDeploymentId = proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId;
  const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === dexDeploymentId);
  if (!dex || dex.chainId !== chainId) return { eligible: false, reason: "unknown-dex" };
  const configured = EVM_CHAINS.has(chainId)
    ? config?.evm?.factories?.some((entry) => entry.dexDeploymentId === dexDeploymentId && entry.network === CHAIN_NAMESPACE[chainId] && entry.factory.toLowerCase() === dex.programAddress.toLowerCase())
    : config?.solana?.programs?.some((entry) => entry.dexDeploymentId === dexDeploymentId && entry.program === dex.programAddress);
  if (!configured) return { eligible: false, reason: "unconfigured-program" };
  const wrap = nativeWrapForChain(dexCatalog, chainId);
  const token0 = proposal.token0DeploymentId ?? proposal.canonical?.token0DeploymentId ?? (proposal.token0Address ? tokenIdForAddress(tokenCatalog, chainId, proposal.token0Address) : null);
  const token1 = proposal.token1DeploymentId ?? proposal.canonical?.token1DeploymentId ?? (proposal.token1Address ? tokenIdForAddress(tokenCatalog, chainId, proposal.token1Address) : null);
  const tokenAddresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
  const native0 = token0 === wrap?.wrappedTokenDeploymentId;
  const native1 = token1 === wrap?.wrappedTokenDeploymentId;
  if (native0 === native1) return { eligible: false, reason: "not-direct-native-pair" };
  const rows = poolRawEvidence(proposal, discoveryRaw, poolRaw);
  if (rows.length === 0) return { eligible: false, reason: "missing-pool-transcript" };
  const liquidity = nativeLiquidityFromRaw(proposal, rows, dexCatalog, tokenCatalog, config, rankingConfig);
  if (liquidity === null || liquidity < admissionFloor(chainId, rankingConfig)) return { eligible: false, reason: "below-native-liquidity-floor", liquidity: liquidity?.toString() ?? null };
  return { eligible: true, liquidity, rows };
}

function poolSelectionIdentity(proposal) {
  return String(proposal.canonical?.poolDefinitionId ?? proposal.poolDefinitionId ?? proposal.id ?? `${proposalChain(proposal)}\0${proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId ?? ""}\0${poolAddressOf(proposal) ?? ""}`);
}

function selectAdmissionCandidates({ discoveryProposals, poolProposals, discoveryRaw, poolRaw, tokenCatalog, dexCatalog, config, rankingConfig }) {
  const allPools = uniqueByIdentity([...discoveryProposals.filter((entry) => entry.kind === "pool" || entry.poolDefinitionId || entry.poolAddress), ...poolProposals], (entry) => `${proposalChain(entry)}\0${poolAddressOf(entry)}\0${entry.dexDeploymentId ?? entry.canonical?.dexDeploymentId}`);
  const deferred = [];
  const qualified = [];
  for (const proposal of allPools) {
    const chainId = proposalChain(proposal);
    const existing = dexCatalog.poolDefinitions.some((entry) => entry.chainId === chainId && normalizeTokenAddress(chainId, entry.address) === normalizeTokenAddress(chainId, poolAddressOf(proposal)));
    if (existing) continue;
    const admission = configuredPoolAdmission(proposal, discoveryRaw, poolRaw, tokenCatalog, dexCatalog, config, rankingConfig);
    if (admission.eligible) qualified.push({ proposal, admission });
    else deferred.push({ proposal: clone(proposal, "deferred pool proposal"), reason: admission.reason });
  }
  const chainOrder = [...new Set(qualified.map((entry) => proposalChain(entry.proposal)))].sort();
  const byChain = new Map(chainOrder.map((chainId) => [chainId, qualified.filter((entry) => proposalChain(entry.proposal) === chainId).sort((left, right) => {
    const liquidityOrder = left.admission.liquidity > right.admission.liquidity ? -1 : left.admission.liquidity < right.admission.liquidity ? 1 : 0;
    return liquidityOrder || poolSelectionIdentity(left.proposal).localeCompare(poolSelectionIdentity(right.proposal));
  })]));
  const selected = [];
  let round = 0;
  while (selected.length < ADMISSION_POOL_CAP) {
    let added = false;
    for (const chainId of chainOrder) {
      const row = byChain.get(chainId)?.[round];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length >= ADMISSION_POOL_CAP) break;
    }
    if (!added) break;
    round += 1;
  }
  const selectedPoolKeys = new Set(selected.map((entry) => `${proposalChain(entry.proposal)}\0${poolAddressOf(entry.proposal)}`));
  for (const entry of qualified) if (!selectedPoolKeys.has(`${proposalChain(entry.proposal)}\0${poolAddressOf(entry.proposal)}`)) deferred.push({ proposal: clone(entry.proposal, "deferred pool proposal"), reason: "pool-cap" });
  const tokenCandidates = discoveryProposals.filter((entry) => entry.kind === "token" || entry.deploymentId || entry.assetId);
  const tokenNeeded = [];
  const tokenBindings = new Map(tokenCatalog.deployments.filter((entry) => entry.address !== null).map((entry) => [`${entry.chainId}\0${normalizeTokenAddress(entry.chainId, entry.address)}`, entry.deploymentId]));
  for (const entry of selected) {
    const proposal = entry.proposal;
    const chainId = proposalChain(proposal);
    const addresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
    for (const address of addresses ?? []) {
      const binding = `${chainId}\0${normalizeTokenAddress(chainId, address)}`;
      if (!tokenBindings.has(binding)) {
        const token = tokenCandidates.find((candidate) => proposalChain(candidate) === chainId && normalizeTokenAddress(chainId, candidate.address) === normalizeTokenAddress(chainId, address));
        if (token) { tokenNeeded.push(token); tokenBindings.set(binding, "pending"); }
      }
    }
  }
  const selectedTokens = uniqueByIdentity(tokenNeeded, (entry) => `${proposalChain(entry)}\0${entry.address}`).slice(0, ADMISSION_TOKEN_CAP);
  const selectedTokenKeys = new Set(selectedTokens.map((entry) => `${proposalChain(entry)}\0${entry.address}`));
  for (const token of tokenCandidates) if (!selectedTokenKeys.has(`${proposalChain(token)}\0${token.address}`)) deferred.push({ proposal: clone(token, "deferred token proposal"), reason: "dependency-or-token-cap" });
  const selectedPoolProposals = selected.map((entry) => entry.proposal).filter((proposal) => {
    const chainId = proposalChain(proposal);
    const addresses = proposal.tokens ?? proposal.mints ?? [proposal.token0Address, proposal.token1Address];
    return (addresses ?? []).every((address) => tokenCatalog.deployments.some((deployment) => deployment.chainId === chainId && deployment.address !== null && normalizeTokenAddress(chainId, deployment.address) === normalizeTokenAddress(chainId, address)) || selectedTokens.some((token) => proposalChain(token) === chainId && normalizeTokenAddress(chainId, token.address) === normalizeTokenAddress(chainId, address)));
  });
  const selectedPoolKeysFinal = new Set(selectedPoolProposals.map((entry) => `${proposalChain(entry)}\0${poolAddressOf(entry)}`));
  for (const entry of selected) if (!selectedPoolKeysFinal.has(`${proposalChain(entry.proposal)}\0${poolAddressOf(entry.proposal)}`)) deferred.push({ proposal: clone(entry.proposal, "deferred pool proposal"), reason: "missing-token-dependency" });
  return { tokens: selectedTokens, pools: selectedPoolProposals, deferred };
}

function appendCatalogData({ baseTokenCatalog, baseDexCatalog, discoveryProposals, poolProposals, discoveryRaw, config, options }) {
  const tokenCatalog = clone(baseTokenCatalog, "token catalog");
  const dexCatalog = clone(baseDexCatalog, "DEX catalog");
  const asOfDate = candidateDate(discoveryRaw, tokenCatalog, dexCatalog, discoveryProposals.length > 0 || poolProposals.length > 0);
  const maps = ensureMaps(tokenCatalog, dexCatalog);
  const tokenCandidates = [];
  const tokenSeen = new Set();
  const tokenProposals = uniqueByIdentity(discoveryProposals.filter((entry) => entry.kind === "token" || entry.deploymentId || entry.assetId), (entry) => `${proposalChain(entry)}\0${entry.address ?? entry.canonical?.address}`)
    .sort((left, right) => `${proposalChain(left)}\0${left.address ?? left.canonical?.address}`.localeCompare(`${proposalChain(right)}\0${right.address ?? right.canonical?.address}`));
  const maxTokens = Number.isSafeInteger(config?.limits?.maxAdmissionTokens) ? config.limits.maxAdmissionTokens : 128;
  for (const proposal of tokenProposals.slice(0, maxTokens)) {
    const item = canonicalTokenFromProposal(proposal, config, asOfDate, maps);
    if (!item || tokenSeen.has(item.deployment.deploymentId)) continue;
    tokenSeen.add(item.deployment.deploymentId);
    tokenCandidates.push(item);
    tokenCatalog.assets.push(item.asset);
    tokenCatalog.deployments.push(item.deployment);
    tokenCatalog.aliases.push(item.alias);
    maps.tokensById.set(item.deployment.deploymentId, item.deployment);
    maps.assetsById.set(item.asset.assetId, item.asset);
    maps.tokensByBinding.set(`${item.deployment.chainId}\0${normalizeTokenAddress(item.deployment.chainId, item.deployment.address)}`, item.deployment);
  }
  const allPoolProposals = uniqueByIdentity([...discoveryProposals.filter((entry) => entry.kind === "pool" || entry.poolDefinitionId || entry.poolAddress), ...poolProposals], (entry) => `${proposalChain(entry)}\0${entry.address ?? entry.poolAddress ?? entry.canonical?.address}\0${entry.dexDeploymentId ?? entry.canonical?.dexDeploymentId}`);
  const poolCandidates = [];
  const maxPools = Number.isSafeInteger(config?.limits?.maxAdmissionPools) ? config.limits.maxAdmissionPools : 128;
  for (const proposal of allPoolProposals) {
    if (poolCandidates.length >= maxPools) break;
    const item = canonicalPoolFromProposal(proposal, config, asOfDate, maps, tokenCatalog);
    if (!item || item.dependencyMissing) continue;
    poolCandidates.push(item);
    dexCatalog.poolDefinitions.push(item.pool);
    dexCatalog.aliases.push(item.alias);
    maps.poolsById.set(item.pool.poolDefinitionId, item.pool);
    maps.poolsByBinding.set(`${item.pool.chainId}\0${EVM_CHAINS.has(item.pool.chainId) ? item.pool.address.toLowerCase() : item.pool.address}`, item.pool);
  }
  // Tokens are appended before pools, which is the dependency closure order
  // required by the DEX schema.  The token cap was applied before pool
  // admission so a pool can never retain a dependency that was truncated.
  tokenCatalog.assets.sort((a, b) => a.assetId.localeCompare(b.assetId));
  tokenCatalog.deployments.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  tokenCatalog.aliases.sort((a, b) => `${a.namespace}\0${a.name}`.localeCompare(`${b.namespace}\0${b.name}`));
  dexCatalog.dexDeployments.sort((a, b) => a.dexDeploymentId.localeCompare(b.dexDeploymentId));
  dexCatalog.poolDefinitions.sort((a, b) => a.poolDefinitionId.localeCompare(b.poolDefinitionId));
  dexCatalog.nativeWrapDefinitions.sort((a, b) => a.nativeWrapDefinitionId.localeCompare(b.nativeWrapDefinitionId));
  dexCatalog.aliases.sort((a, b) => `${a.namespace}\0${a.name}`.localeCompare(`${b.namespace}\0${b.name}`));
  tokenCatalog.contentDigest = computeTokenDigest(tokenCatalog);
  dexCatalog.contentDigest = computeDexDigest(dexCatalog);
  try { validateTokenCatalog(tokenCatalog); } catch (error) { fail(`candidate token catalog failed validation: ${error.message}`, "CANDIDATE_INVALID"); }
  try { validateDexCatalog(dexCatalog, { tokenCatalog }); } catch (error) { fail(`candidate DEX catalog failed validation: ${error.message}`, "CANDIDATE_INVALID"); }
  return { tokenCatalog, dexCatalog, tokenCandidates: tokenCandidates.slice(0, maxTokens), poolCandidates };
}

function generatedFiles(tokenCatalog, dexCatalog, ranking) {
  const files = {};
  for (const [language, pathValue] of Object.entries(TOKEN_OUTPUTS)) files[pathValue] = renderTokenLanguage(language, tokenCatalog);
  for (const [language, pathValue] of Object.entries(DEX_OUTPUTS)) files[pathValue] = renderDexLanguage(language, dexCatalog, { tokenCatalog });
  for (const [language, pathValue] of Object.entries(RANKING_OUTPUTS)) files[pathValue] = renderRankingLanguage(language, ranking, { tokenCatalog });
  if (Object.keys(files).sort().join("\0") !== GENERATED_PATHS.join("\0")) fail("generator output allowlist drifted", "GENERATOR_INVALID");
  return files;
}

function trustedState(root, options = {}) {
  const tokenCatalog = options.tokenCatalog ?? readJsonFile(root, "registry/token-catalog.json");
  const dexCatalog = options.dexCatalog ?? readJsonFile(root, "registry/dex-catalog.json");
  const ranking = options.ranking ?? readJsonFile(root, "registry/token-rankings.json", { optional: true }) ?? canonicalRanking;
  const priorState = options.priorState ?? readJsonFile(root, "registry/discovery-state.json", { optional: true });
  try { validateTokenCatalog(tokenCatalog); } catch (error) { fail(`trusted token catalog is invalid: ${error.message}`, "CATALOG_INVALID"); }
  try { validateDexCatalog(dexCatalog, { tokenCatalog }); } catch (error) { fail(`trusted DEX catalog is invalid: ${error.message}`, "CATALOG_INVALID"); }
  try { validateRankingArtifact(ranking, { tokenCatalog }); } catch (error) { fail(`trusted ranking snapshot is invalid: ${error.message}`, "RANKING_INVALID"); }
  if (priorState) {
    try { validateDiscoveryState(priorState); } catch (error) { fail(`trusted discovery state is invalid: ${error.message}`, "DISCOVERY_STATE_INVALID"); }
  }
  return { tokenCatalog: clone(tokenCatalog, "trusted token catalog"), dexCatalog: clone(dexCatalog, "trusted DEX catalog"), ranking: clone(ranking, "trusted ranking snapshot"), priorState: priorState ? clone(priorState, "trusted discovery state") : null };
}

function ensureCatalogHistory(base, candidate, kind) {
  const oldRows = kind === "token" ? base.deployments : base.poolDefinitions;
  const newRows = kind === "token" ? candidate.deployments : candidate.poolDefinitions;
  const byId = new Map(newRows.map((entry) => [kind === "token" ? entry.deploymentId : entry.poolDefinitionId, entry]));
  for (const old of oldRows) {
    const id = kind === "token" ? old.deploymentId : old.poolDefinitionId;
    const next = byId.get(id);
    if (!next || stableStringify(old) !== stableStringify(next)) fail(`historical ${kind} record ${id} changed`, "APPEND_ONLY_VIOLATION");
  }
  const oldAliases = base.aliases;
  const aliases = new Map(candidate.aliases.map((entry) => [`${entry.namespace}\0${entry.name}`, entry]));
  for (const old of oldAliases) {
    const next = aliases.get(`${old.namespace}\0${old.name}`);
    if (!next || stableStringify(old) !== stableStringify(next)) fail(`historical ${kind} alias ${old.namespace}:${old.name} changed`, "APPEND_ONLY_VIOLATION");
  }
  if (kind === "dex") {
    const wraps = new Map(candidate.nativeWrapDefinitions.map((entry) => [entry.nativeWrapDefinitionId, entry]));
    for (const old of base.nativeWrapDefinitions) if (!wraps.has(old.nativeWrapDefinitionId) || stableStringify(old) !== stableStringify(wraps.get(old.nativeWrapDefinitionId))) fail(`historical native wrap ${old.nativeWrapDefinitionId} changed`, "APPEND_ONLY_VIOLATION");
  }
}

function deferredPoolIdentity(proposal) {
  if (!isRecord(proposal) || proposal.kind !== "pool") fail("deferred pool proposal is invalid", "DISCOVERY_STATE_INVALID");
  const chainId = proposalChain(proposal);
  const address = addressForChain(chainId, poolAddressOf(proposal), "deferred pool address");
  const dexDeploymentId = proposal.dexDeploymentId ?? proposal.canonical?.dexDeploymentId;
  requireId(dexDeploymentId, "deferred pool dexDeploymentId");
  return { chainId, address, dexDeploymentId, key: `${chainId}\0${address}\0${dexDeploymentId}` };
}

function deferredPoolPairIndex(proposal, row) {
  const proposalValues = [proposal.pairIndex, proposal.canonical?.pairIndex];
  for (const evidence of proposal.evidence ?? []) if (isRecord(evidence)) proposalValues.push(evidence.pairIndex);
  const proposalIndex = proposalValues.find((value) => Number.isSafeInteger(value) && value >= 0);
  const receiptIndex = row?.pairIndex;
  if (!Number.isSafeInteger(receiptIndex) || receiptIndex < 0) fail("deferred EVM pool receipt has no pair index", "DISCOVERY_STATE_INVALID");
  if (proposalIndex !== undefined && proposalIndex !== receiptIndex) fail("deferred EVM pool proposal and receipt disagree on pair index", "DISCOVERY_STATE_INVALID");
  return receiptIndex;
}

function freshDiscoveryPoolReceipt(proposal, discoveryRaw) {
  const identity = deferredPoolIdentity(proposal);
  const expectedKind = EVM_CHAINS.has(identity.chainId) ? "evm-pair" : "solana-program";
  const rows = Array.isArray(discoveryRaw?.receipts) ? discoveryRaw.receipts : [];
  const matches = rows.filter((row) => {
    if (!isRecord(row) || row.status !== "success" || row.kind !== expectedKind) return false;
    if (row.dexDeploymentId !== identity.dexDeploymentId || typeof row.address !== "string") return false;
    try { return addressForChain(identity.chainId, row.address, "discovery pool receipt address") === identity.address; } catch { return false; }
  });
  if (matches.length !== 1) fail(`deferred pool ${identity.key} lacks one fresh verified discovery receipt`, "DISCOVERY_STATE_INVALID");
  return { identity, row: matches[0] };
}

function mergePendingQueue(current, additions, compare) {
  const result = [];
  const seen = new Set();
  for (const value of [...current, ...[...new Set(additions)].sort(compare)]) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function requeueDeferredPoolCursors({ discoveryState, deferredCandidates, discoveryProposals, discoveryRaw, poolCandidates, maxPending = MAX_DISCOVERY_PENDING }) {
  if (!Array.isArray(deferredCandidates) || deferredCandidates.length === 0) return;
  const verifiedProposalKeys = new Set(
    discoveryProposals.filter((proposal) => isRecord(proposal) && proposal.kind === "pool").map((proposal) => deferredPoolIdentity(proposal).key),
  );
  const admittedKeys = new Set(
    poolCandidates.filter((candidate) => isRecord(candidate?.pool)).map((candidate) => deferredPoolIdentity({
      kind: "pool",
      chainId: candidate.pool.chainId,
      address: candidate.pool.address,
      dexDeploymentId: candidate.pool.dexDeploymentId,
    }).key),
  );
  const queuedKeys = new Set();
  for (const deferred of deferredCandidates) {
    if (!isRecord(deferred) || !DEFERRED_POOL_REQUEUE_REASONS.has(deferred.reason)) continue;
    const proposal = deferred.proposal;
    if (!isRecord(proposal) || proposal.kind !== "pool") continue;
    const { identity, row } = freshDiscoveryPoolReceipt(proposal, discoveryRaw);
    if (!verifiedProposalKeys.has(identity.key)) fail(`deferred pool ${identity.key} is not from the fresh verified discovery proposal set`, "DISCOVERY_STATE_INVALID");
    if (admittedKeys.has(identity.key) || queuedKeys.has(identity.key)) continue;
    queuedKeys.add(identity.key);

    if (EVM_CHAINS.has(identity.chainId)) {
      const factory = discoveryState.factories?.[identity.dexDeploymentId];
      if (!isRecord(factory)) fail(`deferred EVM pool ${identity.key} has no factory cursor`, "DISCOVERY_STATE_INVALID");
      const pairIndex = deferredPoolPairIndex(proposal, row);
      if (!Number.isSafeInteger(factory.count) || pairIndex >= factory.count) fail(`deferred EVM pair index is outside the verified factory cursor for ${identity.key}`, "DISCOVERY_STATE_INVALID");
      const pending = Array.isArray(factory.pendingIndexes) ? factory.pendingIndexes : [];
      const completed = Array.isArray(factory.completedIndexes) ? factory.completedIndexes : [];
      if (pending.length > maxPending) fail(`deferred EVM cursor exceeds the pending bound for ${identity.dexDeploymentId}`, "DISCOVERY_STATE_INVALID");
      const nextPending = mergePendingQueue(pending, [pairIndex], (left, right) => left - right);
      if (nextPending.length > maxPending) fail(`deferred EVM cursor would exceed the pending bound for ${identity.dexDeploymentId}`, "DISCOVERY_STATE_INVALID");
      factory.pendingIndexes = nextPending;
      factory.completedIndexes = completed.filter((index) => index !== pairIndex).sort((left, right) => left - right);
      continue;
    }

    const program = discoveryState.programs?.[identity.dexDeploymentId];
    if (!isRecord(program)) fail(`deferred Solana pool ${identity.key} has no program cursor`, "DISCOVERY_STATE_INVALID");
    const pending = Array.isArray(program.pendingPubkeys) ? program.pendingPubkeys : Array.isArray(program.pendingQueue) ? program.pendingQueue : [];
    const completed = Array.isArray(program.completedPubkeys) ? program.completedPubkeys : Array.isArray(program.completePubkeySet) ? program.completePubkeySet : [];
    if (pending.length > maxPending) fail(`deferred Solana cursor exceeds the pending bound for ${identity.dexDeploymentId}`, "DISCOVERY_STATE_INVALID");
    const nextPending = mergePendingQueue(pending, [identity.address], (left, right) => left.localeCompare(right));
    if (nextPending.length > maxPending) fail(`deferred Solana cursor would exceed the pending bound for ${identity.dexDeploymentId}`, "DISCOVERY_STATE_INVALID");
    const nextCompleted = completed.filter((pubkey) => pubkey !== identity.address).sort();
    program.pendingPubkeys = nextPending;
    program.pendingQueue = nextPending;
    program.completedPubkeys = nextCompleted;
    program.completePubkeySet = nextCompleted;
  }
}

function finalizedDiscoveryState(verifiedState, { baseTokenCatalog, baseDexCatalog, tokenCatalog, dexCatalog, config, deferredCandidates, discoveryProposals, discoveryRaw, poolCandidates }) {
  try { validateDiscoveryState(verifiedState, { config }); } catch (error) { fail(`verified discovery cursor is invalid: ${error.message}`, "DISCOVERY_STATE_INVALID"); }
  if (verifiedState.tokenCatalogDigest !== computeTokenDigest(baseTokenCatalog) || verifiedState.dexCatalogDigest !== computeDexDigest(baseDexCatalog)) fail("verified discovery cursor is not bound to the trusted base catalogs", "DISCOVERY_STATE_INVALID");
  const state = clone(verifiedState, "verified discovery state");
  state.tokenCatalogDigest = computeTokenDigest(tokenCatalog);
  state.dexCatalogDigest = computeDexDigest(dexCatalog);
  const maxPending = Number.isSafeInteger(config?.limits?.maxPending) ? config.limits.maxPending : MAX_DISCOVERY_PENDING;
  requeueDeferredPoolCursors({ discoveryState: state, deferredCandidates, discoveryProposals, discoveryRaw, poolCandidates, maxPending });
  try { validateDiscoveryState(state, { config }); } catch (error) { fail(`final discovery cursor is invalid: ${error.message}`, "DISCOVERY_STATE_INVALID"); }
  return state;
}

function candidateSummary({ observation, baseTokenCatalog, baseDexCatalog, baseRanking, candidateTokenCatalog, candidateDexCatalog, ranking, discoveryState, tokenCandidates, poolCandidates, deferredCandidates = [], config, rankingConfig, files }) {
  const tokenDigest = computeTokenDigest(candidateTokenCatalog);
  const dexDigest = computeDexDigest(candidateDexCatalog);
  let rankingDigest;
  try { rankingDigest = computeRankingDigest(ranking); } catch (error) { fail(`candidate ranking digest failed: ${error.message}`, "RANKING_INVALID"); }
  const candidateFiles = {
    "registry/token-catalog.json": `${JSON.stringify(candidateTokenCatalog, null, 2)}\n`,
    "registry/dex-catalog.json": `${JSON.stringify(candidateDexCatalog, null, 2)}\n`,
    "registry/token-rankings.json": `${JSON.stringify(ranking, null, 2)}\n`,
    "registry/discovery-state.json": `${JSON.stringify(discoveryState, null, 2)}\n`,
    ...files,
  };
  const changes = {
    tokenCatalog: tokenDigest !== baseTokenCatalog.contentDigest,
    dexCatalog: dexDigest !== baseDexCatalog.contentDigest,
    ranking: rankingDigest !== computeRankingDigest(baseRanking),
  };
  const informationReasons = [];
  if (tokenCandidates.length > 0) informationReasons.push(`${tokenCandidates.length} factual unclassified token candidate(s) were admitted with address-only symbols`);
  if (poolCandidates.length > 0) informationReasons.push(`${poolCandidates.length} factual pool candidate(s) were admitted after native-pair and liquidity checks`);
  if (changes.ranking) informationReasons.push("ranking snapshot changed and remains a separate digest");
  if (deferredCandidates.length > 0) informationReasons.push(`${deferredCandidates.length} candidates were deferred by admission policy/caps`);
  const reviewReasons = [];
  const actionRequired = reviewReasons.length > 0;
  return {
    schemaVersion: DATA_PROMOTION_SCHEMA_VERSION,
    kind: DATA_CANDIDATE_KIND,
    sourceSha: observation.sourceSha,
    sourceTreeSha: observation.sourceTreeSha,
    baseSha: observation.baseSha,
    baseline: {
      tokenCatalogDigest: baseTokenCatalog.contentDigest,
      dexCatalogDigest: baseDexCatalog.contentDigest,
      rankingDigest: computeRankingDigest(baseRanking),
    },
    candidateDigests: { tokenCatalogDigest: tokenDigest, dexCatalogDigest: dexDigest, rankingDigest },
    tokenCatalogDigest: tokenDigest,
    dexCatalogDigest: dexDigest,
    rankingDigest,
    discoveryConfigDigest: computeDiscoveryConfigDigest(config),
    rankingConfigDigest: computeRankingConfigDigest(rankingConfig),
    discoveryState,
    tokenCatalog: candidateTokenCatalog,
    dexCatalog: candidateDexCatalog,
    rankingSnapshot: ranking,
    files: candidateFiles,
    outputPaths: Object.freeze(Object.keys(candidateFiles).sort()),
    outputDigest: computeOutputDigest(candidateFiles),
    semanticFingerprint: semanticFingerprint({
      baseline: { token: baseTokenCatalog.contentDigest, dex: baseDexCatalog.contentDigest },
      candidateDigests: { tokenCatalogDigest: tokenDigest, dexCatalogDigest: dexDigest, rankingDigest },
      files: candidateFiles,
      discoveryState,
    }),
    actionRequired,
    reviewReasons,
    informationReasons,
    manualReviewRequired: actionRequired,
    changes,
    admissionPolicy: {
      status: "enabled",
      maxNewTokens: ADMISSION_TOKEN_CAP,
      maxNewPools: ADMISSION_POOL_CAP,
      minNativeLiquidity: Object.fromEntries(Object.entries(ADMISSION_MIN_NATIVE_LIQUIDITY).map(([chainId, floor]) => [chainId, floor.toString()])),
      requiresConfiguredNativePair: true,
      standaloneMintAdmission: false,
    },
    tokenCandidates: tokenCandidates.map(clone),
    poolCandidates: poolCandidates.map(clone),
    deferredCandidates: deferredCandidates.map(clone),
    execution: validateExecution(observation.execution),
  };
}

function validateRankingCandidate(ranking, tokenCatalog) {
  try { validateRankingArtifact(ranking, { tokenCatalog }); } catch (error) { fail(`ranking snapshot is invalid: ${error.message}`, "RANKING_INVALID"); }
}

/**
 * Replay one trusted observation envelope.  Replays happen in dependency
 * order: discovery -> additive candidate catalogs -> pool and ranking.
 */
export function replayMaintenanceObservation(observation, options = {}) {
  const root = defaultRoot(options);
  const { observation: envelope, raw } = validateObservationEnvelope(observation, { sourceSha: options.sourceSha, baseSha: options.baseSha });
  const state = trustedState(root, options);
  // The source tree is part of the replay binding.  Git read errors and
  // missing commits are provenance failures, never an invitation to continue
  // with an unresolved tree.
  const trustedTree = gitTreeSha(root, envelope.sourceSha);
  if (trustedTree !== envelope.sourceTreeSha) fail("observation sourceTreeSha does not match the trusted source commit", "SOURCE_TREE_MISMATCH");
  if (options.sourceTreeSha !== undefined) {
    requireSha(options.sourceTreeSha, "sourceTreeSha option");
    if (options.sourceTreeSha !== envelope.sourceTreeSha) fail("requested sourceTreeSha does not match the observation", "SOURCE_TREE_MISMATCH");
  }
  if (envelope.baseline.tokenCatalogDigest !== state.tokenCatalog.contentDigest || envelope.baseline.dexCatalogDigest !== state.dexCatalog.contentDigest || envelope.baseline.rankingDigest !== computeRankingDigest(state.ranking)) fail("observation baseline catalog digest is stale", "BASELINE_MISMATCH");
  const config = configForObservation(envelope, options);
  const rankingConfig = rankingConfigForObservation(envelope, options);
  const discoveryConfigDigest = computeDiscoveryConfigDigest(config);
  const rankingConfigDigest = computeRankingConfigDigest(rankingConfig);
  if (envelope.discoveryConfigDigest !== discoveryConfigDigest) fail("observation discovery config digest is stale", "CONFIG_MISMATCH");
  if (envelope.rankingConfigDigest !== rankingConfigDigest) fail("observation ranking config digest is stale", "CONFIG_MISMATCH");
  const discoveryContext = {
    sourceSha: envelope.sourceSha,
    config,
    tokenCatalog: state.tokenCatalog,
    dexCatalog: state.dexCatalog,
    priorState: state.priorState,
  };
  const injectedReplay = options.testOnly === true;
  const discoveryReplayResult = replayDiscoveryCandidates(raw.discovery.value, discoveryContext, injectedReplay ? options.replayDiscovery : undefined);
  const discoveryProposals = discoveryReplayResult.proposals;
  const verifiedDiscoveryState = discoveryReplayResult.replayed?.state;
  if (!isRecord(verifiedDiscoveryState)) fail("discovery replay did not return a verified cursor state", "DISCOVERY_STATE_INVALID");
  const initialAdmission = selectAdmissionCandidates({ discoveryProposals, poolProposals: [], discoveryRaw: raw.discovery.value, poolRaw: { receipts: [] }, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, config, rankingConfig });
  const provisional = appendCatalogData({
    baseTokenCatalog: state.tokenCatalog,
    baseDexCatalog: state.dexCatalog,
    discoveryProposals: initialAdmission.tokens,
    poolProposals: initialAdmission.pools,
    discoveryRaw: raw.discovery.value,
    config,
    options,
  });
  const poolReplay = producerReplayPool(raw.pool.value, { sourceSha: envelope.sourceSha, config, tokenCatalog: provisional.tokenCatalog, dexCatalog: provisional.dexCatalog }, injectedReplay ? options.replayPool : undefined);
  if (!injectedReplay) requireCandidatePoolCoverage(raw.pool.value, poolReplay, provisional.poolCandidates);
  // Pool replay is an operational integrity check for the already selected
  // definitions. It cannot add a second set of pools after the candidate
  // catalogs have been frozen; doing so would change the ranking bindings.
  void poolReplay;
  const ranking = producerReplayRanking(raw.ranking.value, { sourceSha: envelope.sourceSha, config: rankingConfig, tokenCatalog: provisional.tokenCatalog, dexCatalog: provisional.dexCatalog }, injectedReplay ? options.replayRanking : undefined);
  validateRankingCandidate(ranking, provisional.tokenCatalog);
  ensureCatalogHistory(state.tokenCatalog, provisional.tokenCatalog, "token");
  ensureCatalogHistory(state.dexCatalog, provisional.dexCatalog, "dex");
  const discoveryState = finalizedDiscoveryState(verifiedDiscoveryState, {
    baseTokenCatalog: state.tokenCatalog,
    baseDexCatalog: state.dexCatalog,
    tokenCatalog: provisional.tokenCatalog,
    dexCatalog: provisional.dexCatalog,
    config,
    deferredCandidates: initialAdmission.deferred,
    discoveryProposals,
    discoveryRaw: raw.discovery.value,
    poolCandidates: provisional.poolCandidates,
  });
  const files = generatedFiles(provisional.tokenCatalog, provisional.dexCatalog, ranking);
  return candidateSummary({ observation: envelope, baseTokenCatalog: state.tokenCatalog, baseDexCatalog: state.dexCatalog, baseRanking: state.ranking, candidateTokenCatalog: provisional.tokenCatalog, candidateDexCatalog: provisional.dexCatalog, ranking, discoveryState, tokenCandidates: provisional.tokenCandidates, poolCandidates: provisional.poolCandidates, deferredCandidates: initialAdmission.deferred, config, rankingConfig, files });
}

export const replay = replayMaintenanceObservation;

export function observationEnvelope({ sourceSha, sourceTreeSha, baseSha, tokenCatalog = canonicalTokenCatalog, dexCatalog = canonicalDexCatalog, ranking = canonicalRanking, baselineRanking = canonicalRanking, discoveryConfig = canonicalDiscoveryConfig, rankingConfig = canonicalRankingConfig, discovery, pool, execution }) {
  const files = {
    [DATA_ARTIFACT_FILENAMES.discovery]: jsonBytes(discovery),
    [DATA_ARTIFACT_FILENAMES.pool]: jsonBytes(pool),
    [DATA_ARTIFACT_FILENAMES.ranking]: jsonBytes(ranking),
  };
  return {
    schemaVersion: DATA_PROMOTION_SCHEMA_VERSION,
    kind: DATA_PROMOTION_KIND,
    sourceSha,
    sourceTreeSha,
    baseSha,
    baseline: {
      tokenCatalogDigest: computeTokenDigest(tokenCatalog),
      dexCatalogDigest: computeDexDigest(dexCatalog),
      rankingDigest: computeRankingDigest(baselineRanking),
    },
    discoveryConfigDigest: computeDiscoveryConfigDigest(discoveryConfig),
    rankingConfigDigest: computeRankingConfigDigest(rankingConfig),
    execution: validateExecution(execution),
    rawArtifacts: Object.fromEntries(Object.entries(files).map(([filename, bytes]) => [filename, { byteLength: bytes.byteLength, sha256: sha256Bytes(bytes), json: JSON.parse(bytes.toString("utf8")) }])),
  };
}

/** Collect online receipts, then replay them in dependency order. */
export async function collectMaintenanceObservation(options = {}) {
  const root = defaultRoot(options);
  const sourceSha = requireSha(options.sourceSha ?? gitSha(root, "HEAD"), "sourceSha");
  const baseSha = requireSha(options.baseSha ?? sourceSha, "baseSha");
  const collectionOrigin = options.execution?.origin ?? options.origin ?? "local";
  if (["scheduled", "workflow_dispatch"].includes(collectionOrigin) && baseSha !== sourceSha) fail("workflow collection requires sourceSha and baseSha to be the same", "BINDING_INVALID");
  const checkedOutHead = gitSha(root, "HEAD");
  if (sourceSha === baseSha && checkedOutHead !== sourceSha) fail("collection checkout HEAD is not the frozen source/base commit", "STALE_CHECKOUT");
  const sourceTreeSha = requireSha(options.sourceTreeSha ?? gitTreeSha(root, sourceSha), "sourceTreeSha");
  const state = trustedState(root, options);
  const discoveryConfig = options.config ?? canonicalDiscoveryConfig;
  const rankingConfig = options.rankingConfig ?? canonicalRankingConfig;
  const discoveryCollector = options.discoveryCollector ?? discoverCatalog;
  let discovery;
  if (options.discoveryReceipts !== undefined) discovery = options.discoveryReceipts;
  else {
    discovery = await discoveryCollector({ ...options, root, sourceSha, config: discoveryConfig, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, state: state.priorState, outputDir: undefined });
  }
  const discoveryRaw = discovery?.artifactKind === "discovery-receipts" ? discovery : discovery?.receipts ?? discovery;
  const injectedReplay = options.testOnly === true;
  const discoveryReplayResult = replayDiscoveryCandidates(discoveryRaw, { sourceSha, config: discoveryConfig, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, priorState: state.priorState }, injectedReplay ? options.replayDiscovery : undefined);
  const discoveryProposals = discoveryReplayResult.proposals;
  const verifiedDiscoveryState = discoveryReplayResult.replayed?.state;
  if (!isRecord(verifiedDiscoveryState)) fail("discovery replay did not return a verified cursor state", "DISCOVERY_STATE_INVALID");
  const initialAdmission = selectAdmissionCandidates({ discoveryProposals, poolProposals: [], discoveryRaw, poolRaw: { receipts: [] }, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, config: discoveryConfig, rankingConfig });
  const provisional = appendCatalogData({ baseTokenCatalog: state.tokenCatalog, baseDexCatalog: state.dexCatalog, discoveryProposals: initialAdmission.tokens, poolProposals: initialAdmission.pools, discoveryRaw, config: discoveryConfig, options });
  const poolCollector = options.testOnly === true && options.poolCollector ? options.poolCollector : poolObserver.collectPoolReceipts ?? poolObserver.observePools;
  const poolRaw = options.poolReceipts !== undefined
    ? options.poolReceipts
    : await poolCollector({ ...options, root, sourceSha, config: discoveryConfig, tokenCatalog: provisional.tokenCatalog, dexCatalog: provisional.dexCatalog, outputDir: undefined });
  // Pool and ranking collection happen after the one discovery-based admission
  // decision and are bound to these frozen candidate catalog digests.
  const poolReplay = producerReplayPool(poolRaw, { sourceSha, config: discoveryConfig, tokenCatalog: provisional.tokenCatalog, dexCatalog: provisional.dexCatalog }, injectedReplay ? options.replayPool : undefined);
  if (!injectedReplay) requireCandidatePoolCoverage(poolRaw, poolReplay, provisional.poolCandidates);
  const afterPools = provisional;
  const rankingCollector = options.testOnly === true && options.rankingCollector ? options.rankingCollector : rankingProducer.collectRankingReceipts ?? collectTokenRankings;
  const rankingRaw = options.rankingReceipts !== undefined
    ? options.rankingReceipts
    : await rankingCollector({ ...options, sourceSha, config: rankingConfig, tokenCatalog: afterPools.tokenCatalog, dexCatalog: afterPools.dexCatalog });
  const envelope = observationEnvelope({ sourceSha, sourceTreeSha, baseSha, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, ranking: rankingRaw, baselineRanking: state.ranking, discoveryConfig, rankingConfig, discovery: discoveryRaw, pool: poolRaw, execution: options.execution ?? { origin: options.origin ?? "local", githubRunId: options.githubRunId, githubRunAttempt: options.githubRunAttempt } });
  const candidate = replayMaintenanceObservation(envelope, { ...options, root, sourceSha, baseSha, tokenCatalog: state.tokenCatalog, dexCatalog: state.dexCatalog, priorState: state.priorState, config: discoveryConfig, rankingConfig });
  if (options.outputDir) {
    const target = resolve(options.outputDir);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(target, { recursive: true });
    await writeFile(resolve(target, DATA_ARTIFACT_FILENAMES.observation), `${JSON.stringify(envelope, null, 2)}\n`);
    const raw = extractRawArtifacts(envelope);
    const outputArtifacts = {
      [DATA_ARTIFACT_FILENAMES.discovery]: raw.discovery,
      [DATA_ARTIFACT_FILENAMES.pool]: raw.pool,
      [DATA_ARTIFACT_FILENAMES.ranking]: raw.ranking,
    };
    for (const [filename, slot] of Object.entries(outputArtifacts)) await writeFile(resolve(target, filename), slot.bytes);
  }
  // The public collector result is the bound, replayable observation envelope. Keep the
  // local candidate available to callers that want a same-process dry-run,
  // without placing an authoritative catalog/files map inside the envelope.
  Object.defineProperty(envelope, "candidate", { value: candidate, enumerable: false });
  Object.defineProperty(envelope, "observation", { value: envelope, enumerable: false });
  return envelope;
}

export const collect = collectMaintenanceObservation;

function exactCandidate(candidate) {
  if (!isRecord(candidate) || candidate.kind !== DATA_CANDIDATE_KIND || candidate.schemaVersion !== 1) fail("data candidate is invalid", "CANDIDATE_INVALID");
  requireSha(candidate.sourceSha, "candidate sourceSha");
  requireSha(candidate.sourceTreeSha, "candidate sourceTreeSha");
  requireSha(candidate.baseSha, "candidate baseSha");
  if (candidate.headSha !== undefined) requireSha(candidate.headSha, "candidate headSha");
  for (const key of ["tokenCatalogDigest", "dexCatalogDigest", "rankingDigest"]) requireDigest(candidate.baseline?.[key], `candidate.baseline.${key}`);
  for (const key of ["tokenCatalogDigest", "dexCatalogDigest", "rankingDigest"]) requireDigest(candidate.candidateDigests?.[key], `candidate.${key}`);
  for (const key of ["tokenCatalogDigest", "dexCatalogDigest", "rankingDigest"]) if (candidate[key] !== undefined && candidate[key] !== candidate.candidateDigests[key]) fail(`candidate ${key} binding is inconsistent`, "CANDIDATE_INVALID");
  if (!isRecord(candidate.files) || Object.keys(candidate.files).sort().join("\0") !== CANDIDATE_OUTPUT_PATHS.join("\0")) fail("candidate output file set is not exact", "EXACT_DIFF_ALLOWLIST");
  for (const pathValue of Object.keys(candidate.files)) {
    if (!CANDIDATE_OUTPUT_PATHS.includes(pathValue) || typeof candidate.files[pathValue] !== "string") fail(`candidate file ${pathValue} is invalid`, "EXACT_DIFF_ALLOWLIST");
  }
  if (candidate.outputPaths !== undefined && (!Array.isArray(candidate.outputPaths) || candidate.outputPaths.join("\0") !== CANDIDATE_OUTPUT_PATHS.join("\0"))) fail("candidate outputPaths binding is not exact", "EXACT_DIFF_ALLOWLIST");
  if (computeOutputDigest(candidate.files) !== candidate.outputDigest) fail("candidate output digest is stale", "CANDIDATE_INVALID");
  if (semanticFingerprint({ baseline: { token: candidate.baseline?.tokenCatalogDigest, dex: candidate.baseline?.dexCatalogDigest }, candidateDigests: candidate.candidateDigests, files: candidate.files, discoveryState: candidate.discoveryState }) !== candidate.semanticFingerprint) fail("candidate semantic fingerprint is stale", "CANDIDATE_INVALID");
  try { validateTokenCatalog(candidate.tokenCatalog); validateDexCatalog(candidate.dexCatalog, { tokenCatalog: candidate.tokenCatalog }); } catch (error) { fail(`candidate catalogs are invalid: ${error.message}`, "CANDIDATE_INVALID"); }
  try { validateRankingArtifact(candidate.rankingSnapshot, { tokenCatalog: candidate.tokenCatalog }); } catch (error) { fail(`candidate ranking is invalid: ${error.message}`, "CANDIDATE_INVALID"); }
  if (computeTokenDigest(candidate.tokenCatalog) !== candidate.candidateDigests.tokenCatalogDigest || computeDexDigest(candidate.dexCatalog) !== candidate.candidateDigests.dexCatalogDigest || computeRankingDigest(candidate.rankingSnapshot) !== candidate.candidateDigests.rankingDigest) fail("candidate catalog or ranking digest is stale", "CANDIDATE_INVALID");
  const canonicalFiles = {
    "registry/token-catalog.json": `${JSON.stringify(candidate.tokenCatalog, null, 2)}\n`,
    "registry/dex-catalog.json": `${JSON.stringify(candidate.dexCatalog, null, 2)}\n`,
    "registry/token-rankings.json": `${JSON.stringify(candidate.rankingSnapshot, null, 2)}\n`,
    "registry/discovery-state.json": `${JSON.stringify(candidate.discoveryState, null, 2)}\n`,
  };
  for (const [pathValue, expected] of Object.entries(canonicalFiles)) if (candidate.files[pathValue] !== expected) fail(`candidate canonical bytes for ${pathValue} are stale`, "CANDIDATE_INVALID");
  const rendered = generatedFiles(candidate.tokenCatalog, candidate.dexCatalog, candidate.rankingSnapshot);
  for (const pathValue of GENERATED_PATHS) if (candidate.files[pathValue] !== rendered[pathValue]) fail(`candidate generated bytes for ${pathValue} are stale`, "CANDIDATE_INVALID");
  return candidate;
}

/**
 * Return the subset of the generated allowlist whose bytes differ from the
 * exact frozen base.  A candidate carries all generated bytes so an emitter
 * can be rerun deterministically; Git should receive only the paths that
 * actually changed.  Missing base files are represented by null and count as
 * an additive change.
 */
export async function expectedCandidateChangedPaths(candidate, { root = REPOSITORY_ROOT, baseSha = undefined, adapter = undefined } = {}) {
  const value = exactCandidate(candidate);
  const frozenBase = requireSha(baseSha ?? value.baseSha, "candidate base SHA");
  let baseFiles;
  if (adapter !== undefined && typeof adapter?.getBaseFiles === "function") {
    baseFiles = await adapter.getBaseFiles(frozenBase, [...CANDIDATE_OUTPUT_PATHS]);
    if (!isRecord(baseFiles)) fail("GitHub adapter base file response is invalid", "GITHUB_ADAPTER_INVALID");
    const keys = Object.keys(baseFiles).sort();
    if (keys.join("\0") !== CANDIDATE_OUTPUT_PATHS.join("\0")) fail("GitHub adapter did not return every candidate base path", "GITHUB_ADAPTER_INVALID");
    for (const pathValue of CANDIDATE_OUTPUT_PATHS) if (baseFiles[pathValue] !== null && typeof baseFiles[pathValue] !== "string") fail(`GitHub adapter base file ${pathValue} is invalid`, "GITHUB_ADAPTER_INVALID");
  } else {
    baseFiles = gitFilesAtCommit(root, frozenBase, [...CANDIDATE_OUTPUT_PATHS]);
  }
  return CANDIDATE_OUTPUT_PATHS.filter((pathValue) => baseFiles[pathValue] === null || baseFiles[pathValue] !== value.files[pathValue]);
}

function candidateHasWork(candidate) {
  return candidate.candidateDigests.tokenCatalogDigest !== candidate.baseline?.tokenCatalogDigest
    || candidate.candidateDigests.dexCatalogDigest !== candidate.baseline?.dexCatalogDigest
    || candidate.candidateDigests.rankingDigest !== candidate.baseline?.rankingDigest
    || (Array.isArray(candidate.tokenCandidates) && candidate.tokenCandidates.length > 0)
    || (Array.isArray(candidate.poolCandidates) && candidate.poolCandidates.length > 0);
}

export function buildDataCandidate(input = {}, options = {}) {
  if (input?.kind === DATA_CANDIDATE_KIND) return exactCandidate(input);
  const observation = input.observation ?? input.maintenanceObservation ?? input;
  const passThrough = ["root", "sourceSha", "baseSha", "sourceTreeSha", "config", "rankingConfig", "tokenCatalog", "dexCatalog", "ranking", "priorState", "testOnly", "replayDiscovery", "replayPool", "replayRanking"];
  const mergedOptions = { ...options, ...Object.fromEntries(passThrough.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])), ...(isRecord(input.options) ? input.options : {}) };
  return replayMaintenanceObservation(observation, mergedOptions);
}

function normalizeJobs(ci) {
  const jobs = ci?.jobs ?? ci?.checkRuns ?? ci?.checks ?? [];
  if (Array.isArray(jobs)) return jobs;
  if (isRecord(jobs)) return Object.entries(jobs).map(([name, value]) => ({ name, ...value }));
  return [];
}

function jobName(job) {
  return job?.name ?? job?.context ?? job?.checkName ?? job?.jobName ?? job?.id ?? null;
}

function jobSuccess(job) {
  return job?.status === "completed" && job?.conclusion === "success";
}

/** Verify the exact dispatched CI run and all required job contexts. */
export function verifyDataCi({ candidate, ci, run, provenance, requiredJobs = undefined, expectedRunId = undefined, expectedAttempt = undefined, expectedHead = undefined, baseSha = undefined, workflowPath = DATA_WORKFLOW_PATH } = {}) {
  const value = exactCandidate(candidate);
  const runValue = run ?? ci ?? {};
  const prov = provenance ?? ci?.provenance ?? runValue.provenance;
  const actualRunId = runValue.id ?? runValue.runId ?? runValue.workflow_run_id ?? runValue.workflowRunId;
  const actualAttempt = runValue.run_attempt ?? runValue.runAttempt ?? runValue.workflow_run_attempt ?? runValue.workflowRunAttempt ?? runValue.attempt;
  if (!Number.isSafeInteger(actualRunId) || actualRunId < 1) fail("CI API response must include a positive run ID", "CI_PROVENANCE_INVALID");
  if (!Number.isSafeInteger(actualAttempt) || actualAttempt < 1) fail("CI API response must include a positive run attempt", "CI_PROVENANCE_INVALID");
  if (expectedRunId !== undefined && (actualRunId !== expectedRunId)) fail("CI run ID does not match requested run", "CI_RUN_MISMATCH");
  if (expectedAttempt !== undefined && (actualAttempt !== expectedAttempt)) fail("CI run attempt does not match requested attempt", "CI_RUN_MISMATCH");
  const runId = actualRunId;
  const attempt = actualAttempt;
  if (runValue.status !== "completed" || runValue.conclusion !== "success") fail("CI run must be completed successfully", "CI_RUN_FAILED");
  const candidateHead = value.headSha ?? expectedHead;
  if (expectedHead === undefined && value.headSha === undefined) fail("CI expected head is required", "CI_HEAD_MISMATCH");
  if (expectedHead !== undefined && value.headSha !== undefined && value.headSha !== expectedHead) fail("CI expected head is not bound to candidate", "CI_HEAD_MISMATCH");
  // Head, workflow, and event are API facts.  A provenance artifact can bind
  // those facts to the downloaded observation, but it cannot fill in a field
  // omitted by the API response.
  const head = runValue.headSha ?? runValue.head_sha ?? runValue.sha ?? runValue.commitSha;
  if (head === undefined || head !== candidateHead) fail("CI API response must include the exact candidate head SHA", "CI_HEAD_MISMATCH");
  const base = baseSha ?? runValue.baseSha ?? runValue.base_sha ?? runValue.inputs?.base_sha ?? prov?.baseSha ?? prov?.base_sha;
  if (base === undefined || base !== value.baseSha) fail("CI API response must include the exact candidate base SHA", "CI_BASE_MISMATCH");
  const workflow = runValue.workflowPath ?? runValue.workflow_path ?? runValue.workflow ?? runValue.path;
  if (workflow === undefined || workflow !== workflowPath) fail("CI API response must identify the managed workflow", "CI_PROVENANCE_INVALID");
  const event = runValue.event ?? runValue.eventName;
  if (event === undefined || event !== "workflow_dispatch") fail("data promotion CI must be an explicit workflow_dispatch", "CI_EVENT_INVALID");
  const provenanceHead = prov?.headSha ?? prov?.head_sha ?? prov?.head;
  const provenanceBase = prov?.baseSha ?? prov?.base_sha ?? prov?.base;
  const provenanceWorkflow = prov?.workflowPath ?? prov?.workflow_path ?? prov?.workflow;
  const provenanceRun = prov?.runId ?? prov?.run_id ?? prov?.workflowRunId ?? prov?.workflow_run_id;
  const provenanceAttempt = prov?.runAttempt ?? prov?.run_attempt ?? prov?.workflowRunAttempt ?? prov?.workflow_run_attempt;
  if (!isRecord(prov) || provenanceHead !== candidateHead || provenanceBase !== value.baseSha || provenanceWorkflow !== workflowPath || Number(provenanceRun) !== Number(runId) || Number(provenanceAttempt) !== Number(attempt)) fail("CI provenance artifact is missing exact source/base/workflow/run binding", "CI_PROVENANCE_INVALID");
  const jobs = normalizeJobs(runValue);
  if (jobs.length === 0) fail("CI API response must include completed job results", "CI_REQUIRED_JOB_FAILED");
  const jobNames = jobs.map(jobName);
  if (jobNames.some((name) => typeof name !== "string") || new Set(jobNames).size !== jobNames.length) fail("CI API response contains duplicate or unnamed jobs", "CI_REQUIRED_JOB_FAILED");
  const names = new Map(jobs.map((job, index) => [jobNames[index], job]));
  const configuredRequired = requiredJobs ?? runValue.requiredJobs ?? runValue.requiredContexts ?? ci?.requiredJobs ?? ci?.requiredContexts;
  const required = [...new Set([...(Array.isArray(configuredRequired) ? configuredRequired : jobs.map(jobName).filter((name) => typeof name === "string")), REQUIRED_CI_CONTEXT])];
  for (const name of required) {
    const job = names.get(name);
    if (!job || !jobSuccess(job)) fail(`required CI job ${name} did not pass`, "CI_REQUIRED_JOB_FAILED");
  }
  return Object.freeze({ eligible: true, runId, runAttempt: attempt, headSha: candidateHead, sourceSha: value.sourceSha, baseSha: value.baseSha, workflowPath, requiredJobs: required });
}

function adapterCall(adapter, method, ...args) {
  if (!adapter || typeof adapter[method] !== "function") fail(`GitHub adapter lacks ${method}`, "GITHUB_ADAPTER_INVALID");
  return adapter[method](...args);
}

export function normalizeChangedPaths(value) {
  const paths = Array.isArray(value) ? value : value?.paths ?? value?.files?.map((entry) => entry?.filename) ?? null;
  if (!Array.isArray(paths) || paths.some((pathValue) => typeof pathValue !== "string")) fail("GitHub adapter changed-path response is invalid", "GITHUB_ADAPTER_INVALID");
  const sorted = [...paths].sort();
  if (new Set(sorted).size !== sorted.length) fail("GitHub adapter changed-path response contains duplicates", "GITHUB_ADAPTER_INVALID");
  return sorted;
}

function normalizePr(pr, expectedRepository = undefined) {
  if (!isRecord(pr)) fail("managed PR record is invalid", "PR_INVALID");
  const head = pr.head?.sha ?? pr.headSha ?? pr.head_sha;
  const base = pr.base?.sha ?? pr.baseSha ?? pr.base_sha;
  const headRef = pr.head?.ref ?? pr.headRef ?? pr.head_ref ?? pr.branch;
  const baseRef = pr.base?.ref ?? pr.baseRef ?? pr.base_ref;
  const headRepo = pr.head?.repo?.full_name ?? pr.head?.repo?.fullName ?? pr.headRepo ?? pr.head_repository ?? null;
  const baseRepo = pr.base?.repo?.full_name ?? pr.base?.repo?.fullName ?? pr.baseRepo ?? pr.base_repository ?? null;
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) fail("managed PR number is invalid", "PR_INVALID");
  if (typeof head !== "string" || !SHA_RE.test(head) || typeof base !== "string" || !SHA_RE.test(base)) fail("managed PR must include exact head and base SHAs", "PR_PROVENANCE_INVALID");
  if (typeof headRef !== "string" || typeof baseRef !== "string") fail("managed PR must include exact head and base refs", "PR_PROVENANCE_INVALID");
  if (typeof headRepo !== "string" || typeof baseRepo !== "string" || headRepo !== baseRepo || expectedRepository !== undefined && headRepo !== expectedRepository) fail("managed PR head/base must belong to the same repository", "PR_PROVENANCE_INVALID");
  let bodyMetadata = null;
  if (typeof pr.body === "string") {
    try { const parsed = JSON.parse(pr.body); if (isRecord(parsed)) bodyMetadata = parsed; } catch { /* body is checked by the explicit marker below */ }
  }
  const metadata = pr.metadata ?? bodyMetadata;
  const managedBy = pr.managedBy ?? metadata?.managedBy ?? (typeof pr.body === "string" && /erpc-sdk-data-maintenance/u.test(pr.body) ? "erpc-sdk-data-maintenance" : null);
  if (managedBy !== "erpc-sdk-data-maintenance") fail("managed PR provenance marker is missing", "PR_PROVENANCE_INVALID");
  if (!isRecord(metadata) || metadata.managedBy !== managedBy || metadata.baseSha !== base || metadata.sourceSha === undefined || metadata.outputDigest === undefined || metadata.contentDigest === undefined || metadata.semanticFingerprint === undefined || !Array.isArray(metadata.outputPaths)) fail("managed PR metadata is incomplete", "PR_PROVENANCE_INVALID");
  return { number: pr.number, head, base, headRef, baseRef, headRepo, baseRepo, managedBy, metadata, state: pr.state, merged: pr.merged === true };
}

/**
 * Check all merge preconditions.  With apply=false this is a read-only report;
 * with apply=true an injected adapter performs one managed merge after a
 * second main-branch compare-and-swap check.
 */
export async function promoteDataCandidate({ candidate, observation = undefined, root = REPOSITORY_ROOT, pr, ci, run, provenance, adapter, repo = undefined, apply = false, expectedHead = undefined, baseSha = undefined, requiredJobs = undefined, expectedRunId = undefined, expectedAttempt = undefined, actor = undefined } = {}) {
  let value = exactCandidate(candidate);
  let promotableObservation = false;
  if (observation !== undefined) {
    const replayed = replayMaintenanceObservation(observation, { root, sourceSha: observation.sourceSha, baseSha: observation.baseSha });
    if (replayed.semanticFingerprint !== value.semanticFingerprint || replayed.outputDigest !== value.outputDigest) fail("promotion candidate does not match fresh bound observation replay", "CANDIDATE_INVALID");
    value = value.headSha ? { ...replayed, headSha: value.headSha, expectedTree: value.expectedTree } : replayed;
    promotableObservation = ["scheduled", "workflow_dispatch"].includes(replayed.execution?.origin);
    if (apply && !promotableObservation) fail("--apply requires a workflow-origin observation bound to frozen main", "PROMOTION_PROVENANCE_INVALID");
  }
  if (apply && observation === undefined) fail("--apply requires the authenticated maintenance observation", "PROMOTION_PROVENANCE_INVALID");
  if (!candidateHasWork(value)) return { status: "NO_ACTION", eligible: false, applied: false };
  const pull = normalizePr(pr, repo);
  const expectedBase = baseSha ?? value.baseSha;
  if (expectedBase !== value.baseSha) fail("promotion base SHA does not match the freshly replayed candidate", "PR_BASE_MISMATCH");
  const expectedBranch = value.branch ?? DATA_BRANCH;
  if (pull.baseRef !== "main" || pull.headRef !== expectedBranch) fail("PR head/base is outside the managed data branch policy", "PR_POLICY");
  const head = expectedHead ?? value.headSha ?? pull.head;
  requireSha(head, "candidate head SHA");
  if (pull.head !== head) fail("managed PR head SHA does not match candidate", "PR_HEAD_MISMATCH");
  if (pull.base !== undefined && pull.base !== expectedBase) fail("managed PR base SHA does not match candidate", "PR_BASE_MISMATCH");
  const metadata = pull.metadata;
  if (metadata.sourceSha !== value.sourceSha || metadata.baseSha !== value.baseSha || metadata.outputDigest !== value.outputDigest || metadata.contentDigest !== computeOutputDigest(value.files) || metadata.semanticFingerprint !== value.semanticFingerprint || metadata.outputPaths.length !== CANDIDATE_OUTPUT_PATHS.length || [...metadata.outputPaths].sort().join("\0") !== CANDIDATE_OUTPUT_PATHS.join("\0")) fail("managed PR metadata does not match the candidate", "PR_PROVENANCE_INVALID");
  if (!adapter || typeof adapter.getChangedPaths !== "function" || typeof adapter.getBranchFiles !== "function") fail("promotion requires exact PR diff and branch file checks", "GITHUB_ADAPTER_INVALID");
  const changed = await adapter.getChangedPaths(expectedBranch, { baseSha: expectedBase, headSha: head });
  const actualChangedPaths = normalizeChangedPaths(changed);
  const expectedChangedPaths = await expectedCandidateChangedPaths(value, { root, baseSha: expectedBase, adapter });
  if (actualChangedPaths.join("\0") !== expectedChangedPaths.join("\0")) fail("managed PR diff does not match the exact candidate bytes against frozen base", "EXACT_DIFF_ALLOWLIST");
  const files = await adapter.getBranchFiles(expectedBranch, CANDIDATE_OUTPUT_PATHS, { headSha: head });
  if (!isRecord(files) || CANDIDATE_OUTPUT_PATHS.some((pathValue) => files[pathValue] !== value.files[pathValue])) fail("managed PR branch bytes differ from the freshly replayed candidate", "PR_CONTENT_MISMATCH");
  if (!["open", "OPEN"].includes(String(pull.state)) || pull.merged) fail("managed PR is not open", "PR_STATE_INVALID");
  const ciReport = verifyDataCi({ candidate: value, ci, run, provenance, expectedHead: head, baseSha: expectedBase, requiredJobs, expectedRunId, expectedAttempt });
  const policy = await (adapter && typeof adapter.getMergePolicy === "function" ? adapter.getMergePolicy({ base: "main", actor }) : null);
  const policyReady = Boolean(promotableObservation && policy?.protected && policy?.strict && policy?.upToDate && policy?.actorAllowed && policy?.requiredChecks?.includes?.(REQUIRED_CI_CONTEXT));
  const reasons = [];
  if (!promotableObservation) reasons.push("automatic promotion requires an authenticated workflow-origin observation");
  if (!policy?.protected || !policy?.strict || !policy?.upToDate || !policy?.actorAllowed || !policy?.requiredChecks?.includes?.(REQUIRED_CI_CONTEXT)) reasons.push("main required-ci protection is not proven for the merge actor");
  if (!apply) return { status: "DRY_RUN", eligible: policyReady, applied: false, pr: pull, ci: ciReport, policy, reasons, changedPaths: actualChangedPaths, expectedChangedPaths };
  if (!policyReady) fail(reasons.join("; "), "MERGE_POLICY_BLOCKED");
  const currentBefore = await adapterCall(adapter, "getMainSha");
  requireSha(currentBefore, "current main SHA");
  if (currentBefore !== expectedBase) fail("main moved after the frozen lease", "MAIN_RACE");
  // Resolve and verify the candidate tree before asking GitHub to merge.  A
  // tree fetched after the merge could simply describe a raced, different
  // head and would not prove what was approved by CI.
  if (typeof adapter.getCommit !== "function") fail("promotion requires a commit-tree read before merge", "GITHUB_ADAPTER_INVALID");
  const headCommit = await adapter.getCommit(head);
  const returnedHeadSha = headCommit?.sha ?? headCommit?.commitSha ?? headCommit?.commit?.sha;
  requireSha(returnedHeadSha, "candidate head commit SHA");
  if (returnedHeadSha !== head) fail("candidate head commit read does not match the managed PR head", "MERGE_HEAD_MISMATCH");
  const headTree = headCommit?.tree?.sha ?? headCommit?.treeSha ?? headCommit?.commit?.tree?.sha;
  requireSha(headTree, "candidate head tree SHA");
  if (value.expectedTree !== undefined && value.expectedTree !== headTree) fail("candidate expected tree does not match the exact PR head", "MERGE_TREE_MISMATCH");
  const expectedTree = headTree;
  const currentImmediatelyBeforeMerge = await adapterCall(adapter, "getMainSha");
  requireSha(currentImmediatelyBeforeMerge, "current main SHA before merge");
  if (currentImmediatelyBeforeMerge !== expectedBase) fail("main moved while the candidate tree was being verified", "MAIN_RACE");
  const merged = await adapterCall(adapter, "mergePullRequest", { number: pull.number, expectedHead: head, expectedBase, method: "merge" });
  const mergeSha = merged?.sha ?? merged?.mergeSha ?? merged?.merge_commit_sha;
  requireSha(mergeSha, "merge commit SHA");
  const verified = await verifyMergedCandidate({ mergeSha, expectedBase, expectedHead: head, expectedTree, adapter });
  const currentAfter = await adapterCall(adapter, "getMainSha");
  if (currentAfter !== mergeSha) fail("main did not advance to the verified merge commit", "MERGE_HEAD_MISMATCH");
  return { status: "MERGED", eligible: true, applied: true, pr: pull, ci: ciReport, policy, mergeSha, verified, changedPaths: actualChangedPaths, expectedChangedPaths };
}

export async function verifyMergedCandidate({ mergeSha, expectedBase, expectedHead, expectedTree, adapter, mergeCommit = undefined, currentMainSha = undefined } = {}) {
  requireSha(mergeSha, "mergeSha");
  requireSha(expectedBase, "expectedBase");
  requireSha(expectedHead, "expectedHead");
  const commit = mergeCommit ?? await adapterCall(adapter, "getCommit", mergeSha);
  const returnedSha = commit?.sha ?? commit?.commitSha ?? commit?.commit?.sha;
  requireSha(returnedSha, "merge commit SHA");
  if (returnedSha !== mergeSha) fail("merge commit read does not match the verified merge SHA", "MERGE_HEAD_MISMATCH");
  const parents = commit?.parents ?? commit?.commit?.parents ?? [];
  const parentShas = parents.map((entry) => typeof entry === "string" ? entry : entry?.sha).filter(Boolean);
  if (parentShas.length !== 2 || parentShas[0] !== expectedBase || parentShas[1] !== expectedHead) fail("merge commit parents are not bound to exact base and managed head", "MERGE_PROVENANCE_INVALID");
  requireSha(expectedTree, "expectedTree");
  const treeSha = commit?.tree?.sha ?? commit?.treeSha ?? commit?.commit?.tree?.sha;
  if (treeSha === undefined || treeSha !== expectedTree) fail("merge tree SHA does not match expected generated tree", "MERGE_TREE_MISMATCH");
  if (currentMainSha !== undefined && currentMainSha !== mergeSha) fail("current main SHA is not the verified merge commit", "MERGE_HEAD_MISMATCH");
  return Object.freeze({ verified: true, mergeSha, expectedBase, expectedHead, treeSha: treeSha ?? null });
}

export async function writeDataMaintenancePr({ candidate, observation, adapter, repo = undefined, report = undefined, apply = false, root = REPOSITORY_ROOT } = {}) {
  if (apply && (observation === undefined || !["scheduled", "workflow_dispatch"].includes(observation?.execution?.origin))) fail("--apply requires a workflow-origin maintenance observation", "PROMOTION_PROVENANCE_INVALID");
  const value = observation !== undefined ? (() => {
    const replayed = exactCandidate(buildDataCandidate(observation, { root }));
    if (candidate) {
      const supplied = exactCandidate(candidate);
      if (supplied.semanticFingerprint !== replayed.semanticFingerprint || supplied.outputDigest !== replayed.outputDigest) fail("PR candidate does not match fresh bound observation replay", "CANDIDATE_INVALID");
    }
    return replayed;
  })() : exactCandidate(candidate);
  const outputPaths = Object.keys(value.files).sort();
  const payload = { kind: "erpc-sdk-managed-data-pr", managedBy: "erpc-sdk-data-maintenance", branch: DATA_BRANCH, baseBranch: "main", baseSha: value.baseSha, sourceSha: value.sourceSha, outputPaths, outputDigest: value.outputDigest, contentDigest: computeOutputDigest(value.files), semanticFingerprint: value.semanticFingerprint, files: value.files };
  if (!candidateHasWork(value)) return { status: "NO_ACTION", noPr: true, candidate: value, payload };
  if (!apply) return { status: "DRY_RUN", candidate: value, payload, report: report ?? null };
  if (!adapter) fail("--apply requires an injected GitHub adapter", "GITHUB_ADAPTER_INVALID");
  if (typeof adapter.getChangedPaths !== "function" || typeof adapter.getBranchFiles !== "function") fail("data PR apply requires exact branch diff and file checks", "GITHUB_ADAPTER_INVALID");
  const current = typeof adapter.getMainSha === "function" ? await adapter.getMainSha() : await adapterCall(adapter, "getBranchSha", "main");
  if (current !== value.baseSha) fail("main moved before PR write", "MAIN_RACE");
  let branch = null;
  if (typeof adapter.getBranch === "function") branch = await adapter.getBranch(DATA_BRANCH);
  else if (typeof adapter.getBranchSha === "function") {
    const existingSha = await adapter.getBranchSha(DATA_BRANCH);
    if (existingSha !== null && existingSha !== undefined && typeof adapter.getBranchMetadata === "function") branch = await adapter.getBranchMetadata(DATA_BRANCH);
    else if (existingSha !== null && existingSha !== undefined) branch = { sha: existingSha };
  } else if (typeof adapter.getBranchMetadata === "function") {
    try { branch = await adapter.getBranchMetadata(DATA_BRANCH); } catch (error) {
      if (!/not found|404/u.test(String(error?.message ?? "")) && error?.status !== 404 && error?.code !== 404) throw error;
    }
  }
  const branchSha = branch?.sha ?? branch?.headSha ?? branch?.head_sha ?? branch?.head?.sha ?? null;
  const managed = branch?.metadata ?? branch;
  let branchNeedsRefresh = false;
  if (branchSha !== null && branchSha !== undefined) {
    if (!isRecord(managed) || managed.managedBy !== payload.managedBy || managed.branch !== DATA_BRANCH || managed.baseSha !== value.baseSha || managed.parentSha !== undefined && managed.parentSha !== value.baseSha || managed.headSha !== undefined && managed.headSha !== branchSha || !Array.isArray(managed.outputPaths) || managed.outputPaths.join("\0") !== outputPaths.join("\0") || typeof managed.outputDigest !== "string" || typeof managed.contentDigest !== "string") fail("existing data branch has no matching managed provenance", "HUMAN_BRANCH_EDIT");
    const changed = await adapter.getChangedPaths(DATA_BRANCH, { baseSha: value.baseSha, headSha: branchSha });
    const paths = normalizeChangedPaths(changed);
    const branchFiles = await adapter.getBranchFiles(DATA_BRANCH, CANDIDATE_OUTPUT_PATHS, { headSha: branchSha });
    if (!isRecord(branchFiles) || CANDIDATE_OUTPUT_PATHS.some((pathValue) => typeof branchFiles[pathValue] !== "string")) fail("existing data branch bytes are incomplete", "HUMAN_BRANCH_EDIT");
    if (dataOutputDigest(branchFiles) !== managed.outputDigest || computeOutputDigest(branchFiles) !== managed.contentDigest) fail("existing data branch bytes do not match their managed provenance", "HUMAN_BRANCH_EDIT");
    if (paths.some((pathValue) => !CANDIDATE_OUTPUT_PATHS.includes(pathValue))) fail("existing data branch changed an unexpected path", "HUMAN_BRANCH_EDIT");
    const matchesCandidate = managed.semanticFingerprint === value.semanticFingerprint && managed.outputDigest === value.outputDigest && managed.contentDigest === payload.contentDigest;
    if (matchesCandidate) {
      const expectedChanged = await expectedCandidateChangedPaths(value, { root, baseSha: value.baseSha, adapter });
      if (paths.join("\0") !== expectedChanged.join("\0")) fail("existing data branch changed bytes outside the exact candidate subset", "HUMAN_BRANCH_EDIT");
      if (CANDIDATE_OUTPUT_PATHS.some((pathValue) => branchFiles[pathValue] !== value.files[pathValue])) fail("existing data branch bytes differ from the candidate", "HUMAN_BRANCH_EDIT");
    } else branchNeedsRefresh = true;
  }
  let headSha = branchSha;
  let commit = null;
  if (headSha === null || headSha === undefined || branchNeedsRefresh) {
    const message = [
      `chore(registry): promote data candidate ${value.candidateDigests.tokenCatalogDigest.slice(0, 12)}`,
      "",
      `ERPC-Maintenance-Managed-By: ${payload.managedBy}`,
      `ERPC-Maintenance-Branch: ${DATA_BRANCH}`,
      `ERPC-Maintenance-Base-SHA: ${value.baseSha}`,
      `ERPC-Maintenance-Source-SHA: ${value.sourceSha}`,
      `ERPC-Maintenance-Semantic-Fingerprint: ${value.semanticFingerprint}`,
      `ERPC-Maintenance-Output-Digest: ${value.outputDigest}`,
      `ERPC-Maintenance-Content-Digest: ${payload.contentDigest}`,
      `ERPC-Maintenance-Output-Paths: ${outputPaths.join(",")}`,
    ].join("\n");
    commit = await adapterCall(adapter, "commitFiles", { branch: DATA_BRANCH, parentSha: value.baseSha, expectedOldSha: branchNeedsRefresh ? branchSha : null, baseSha: value.baseSha, files: value.files, message, metadata: { ...payload, parentSha: value.baseSha, headSha: null } });
    headSha = commit?.sha ?? commit?.headSha ?? commit?.head_sha;
    requireSha(headSha, "managed PR head SHA");
  }
  const changed = await adapter.getChangedPaths(DATA_BRANCH, { baseSha: value.baseSha, headSha });
  const paths = normalizeChangedPaths(changed);
  const expectedChanged = await expectedCandidateChangedPaths(value, { root, baseSha: value.baseSha, adapter });
  if (paths.join("\0") !== expectedChanged.join("\0")) fail("data branch diff does not match the exact candidate subset", "EXACT_DIFF_ALLOWLIST");
  const branchFiles = await adapter.getBranchFiles(DATA_BRANCH, CANDIDATE_OUTPUT_PATHS, { headSha });
  if (!isRecord(branchFiles) || CANDIDATE_OUTPUT_PATHS.some((pathValue) => branchFiles[pathValue] !== value.files[pathValue])) fail("data branch bytes differ from the candidate", "PR_CONTENT_MISMATCH");
  const currentAfterCommit = typeof adapter.getMainSha === "function" ? await adapter.getMainSha() : typeof adapter.getBranchSha === "function" ? await adapter.getBranchSha("main") : value.baseSha;
  if (currentAfterCommit !== value.baseSha) fail("main moved before managed PR creation", "MAIN_RACE");
  const beforePrs = typeof adapter.listPullRequests === "function" ? await adapter.listPullRequests({ head: DATA_BRANCH, base: "main", state: "all" }) : [];
  const prs = Array.isArray(beforePrs) ? beforePrs : beforePrs?.items ?? beforePrs?.pullRequests ?? [];
  const open = prs.find((entry) => String(entry.state ?? "").toLowerCase() === "open" && (entry.head?.ref ?? entry.headRef ?? entry.head_ref) === DATA_BRANCH);
  const body = JSON.stringify({ ...payload, files: undefined });
  const pull = open && typeof adapter.updatePullRequest === "function"
    ? await adapter.updatePullRequest(open.number ?? open.id, { title: "chore(registry): promote verified data candidate", body, head: DATA_BRANCH, base: "main", metadata: payload })
    : typeof adapter.createOrUpdatePullRequest === "function"
      ? await adapter.createOrUpdatePullRequest({ number: open?.number, title: "chore(registry): promote verified data candidate", body, head: DATA_BRANCH, base: "main", metadata: payload })
      : await adapterCall(adapter, "createPullRequest", { title: "chore(registry): promote verified data candidate", body, head: DATA_BRANCH, base: "main", metadata: payload });
  if (typeof adapter.dispatchWorkflow !== "function" || typeof adapter.verifyWorkflowRunHead !== "function") fail("data PR apply requires exact CI dispatch and verification", "GITHUB_ADAPTER_INVALID");
  const dispatched = await adapter.dispatchWorkflow({ workflowPath: DATA_WORKFLOW_PATH, ref: DATA_BRANCH, inputs: { expected_head_sha: headSha, base_sha: value.baseSha } });
  const run = await adapter.verifyWorkflowRunHead(dispatched, headSha, value.baseSha, DATA_BRANCH);
  const runId = run?.id ?? run?.runId ?? run?.workflow_run_id ?? run?.workflowRunId ?? dispatched?.id ?? dispatched?.runId ?? dispatched?.workflow_run_id;
  const runAttempt = run?.run_attempt ?? run?.runAttempt ?? run?.workflow_run_attempt ?? run?.workflowRunAttempt ?? dispatched?.run_attempt ?? dispatched?.runAttempt;
  const dispatchedId = dispatched?.id ?? dispatched?.runId ?? dispatched?.workflow_run_id ?? dispatched?.workflowRunId;
  if (dispatchedId !== undefined && (runId === undefined || String(dispatchedId) !== String(runId))) fail("workflow verification returned a different dispatched run", "CI_RUN_MISMATCH");
  if (run?.head_sha !== undefined && run.head_sha !== headSha || run?.headSha !== undefined && run.headSha !== headSha) fail("workflow verification returned a different head", "CI_HEAD_MISMATCH");
  if (run?.head_branch !== undefined && run.head_branch !== DATA_BRANCH || run?.ref !== undefined && run.ref !== `refs/heads/${DATA_BRANCH}`) fail("workflow verification returned a different branch", "CI_HEAD_MISMATCH");
  const workflow = { workflowPath: DATA_WORKFLOW_PATH, ref: DATA_BRANCH, inputs: { expected_head_sha: headSha, base_sha: value.baseSha }, response: dispatched, run, runId, runAttempt };
  return { status: open ? "UPDATED" : "CREATED", candidate: { ...value, headSha, expectedTree: commit?.treeSha ?? commit?.tree?.sha ?? value.expectedTree }, payload: { ...payload, headSha }, pr: pull, workflow, commit };
}

function parseCli(args) {
  const options = { mode: null, root: REPOSITORY_ROOT, apply: false, report: null };
  const values = new Map([["--observation", "observation"], ["--provenance", "provenance"], ["--source-sha", "sourceSha"], ["--base-sha", "baseSha"], ["--output-dir", "outputDir"], ["--repo", "repo"], ["--pr", "pr"], ["--ci-run-id", "ciRunId"], ["--ci-run-attempt", "ciRunAttempt"], ["--expected-head", "expectedHead"], ["--merge-sha", "mergeSha"], ["--expected-base", "expectedBase"], ["--expected-tree", "expectedTree"], ["--report", "report"], ["--root", "root"]]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") return { ...options, mode: "help" };
    if (key === "--apply") { options.apply = true; continue; }
    if (index === 0 && !key.startsWith("--")) { options.mode = key; continue; }
    const property = values.get(key);
    if (!property) fail(`unknown option ${key}`, "USAGE");
    const value = args[++index];
    if (value === undefined || value.startsWith("--") || seen.has(key)) fail(`${key} requires one value`, "USAGE");
    seen.add(key); options[property] = value;
  }
  if (!options.mode) fail("command is required", "USAGE");
  const requiredByMode = {
    collect: ["sourceSha", "outputDir"],
    replay: ["observation", "sourceSha", "baseSha", "outputDir"],
    "write-pr": ["observation", "sourceSha", "baseSha", "repo", "report"],
    promote: ["pr", "ciRunId", "ciRunAttempt", "expectedHead", "baseSha", "report"],
    "verify-merged": ["mergeSha", "expectedBase", "expectedHead", "expectedTree", "report"],
  };
  for (const property of requiredByMode[options.mode] ?? []) if (options[property] === null || options[property] === undefined) fail(`--${property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required for ${options.mode}`, "USAGE");
  return options;
}

export function usage() {
  return [
    "Usage:",
    "  node registry/data-promotion.mjs collect --source-sha SHA --output-dir DIR [--root DIR]",
    "  node registry/data-promotion.mjs replay --observation FILE --source-sha SHA --base-sha SHA --output-dir DIR [--root DIR]",
    "  node registry/data-promotion.mjs write-pr --observation FILE --source-sha SHA --base-sha SHA --repo OWNER/REPO --report FILE [--apply]",
    "  node registry/data-promotion.mjs promote --pr NUMBER --ci-run-id NUMBER --ci-run-attempt NUMBER --expected-head SHA --base-sha SHA --report FILE [--observation FILE --provenance FILE] [--apply]",
    "  node registry/data-promotion.mjs verify-merged --merge-sha SHA --expected-base SHA --expected-head SHA --expected-tree SHA --report FILE",
  ].join("\n");
}

async function writeReportPath(root, reportPath, value) {
  if (!reportPath) return;
  const target = isAbsolute(reportPath) ? resolve(reportPath) : safeRelativePath(root, reportPath, "report path");
  try {
    const existing = lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile()) fail("report path already exists and is not a regular file", "PATH_INVALID");
    fail("report path already exists; refusing to overwrite an artifact", "PATH_INVALID");
  } catch (error) {
    if (error instanceof DataPromotionError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = resolve(target, "..");
  if (!existsSync(parent) || !statSync(parent).isDirectory()) fail("report path parent must already exist", "PATH_INVALID");
  try {
    const realParent = realpathSync(parent);
    if (!isAbsolute(realParent)) fail("report path parent is invalid", "PATH_INVALID");
  } catch (error) { fail(`report path parent cannot be inspected: ${error.message}`, "PATH_INVALID"); }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function readJsonInputPath(pathValue, label, limit = MAX_RAW_BYTES) {
  if (!pathValue) return null;
  const bytes = readFileBounded(resolve(pathValue), limit, label);
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`, "ARTIFACT_INVALID"); }
}

function integerOption(value, label) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) fail(`${label} must be a positive integer`, "USAGE");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`, "USAGE");
  return parsed;
}

export function executionFromEnvironment(options, environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true") return { origin: "local" };
  const sourceSha = requireSha(String(environment.GITHUB_SHA ?? ""), "GITHUB_SHA");
  if (options.sourceSha !== sourceSha) fail("--source-sha must equal the authenticated GITHUB_SHA", "SOURCE_MISMATCH");
  const repository = environment.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail("GITHUB_REPOSITORY is required for workflow collection", "PROVENANCE_INVALID");
  const runId = integerOption(String(environment.GITHUB_RUN_ID ?? ""), "GITHUB_RUN_ID");
  const runAttempt = integerOption(String(environment.GITHUB_RUN_ATTEMPT ?? ""), "GITHUB_RUN_ATTEMPT");
  const event = environment.GITHUB_EVENT_NAME;
  const origin = event === "schedule" ? "scheduled" : event === "workflow_dispatch" ? "workflow_dispatch" : null;
  if (origin === null) fail("workflow collection requires schedule or workflow_dispatch", "PROVENANCE_INVALID");
  return { origin, githubRunId: runId, githubRunAttempt: runAttempt };
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseCli(argumentsList);
  if (options.mode === "help") { process.stdout.write(`${usage()}\n`); return null; }
  const root = defaultRoot(options);
  let result;
  if (options.mode === "collect") {
    result = await collectMaintenanceObservation({ ...options, root, execution: executionFromEnvironment(options) });
  } else if (options.mode === "replay") {
    const bytes = readFileBounded(resolve(options.observation), MAX_OBSERVATION_BYTES, "observation");
    const observation = JSON.parse(bytes.toString("utf8"));
    result = { candidate: replayMaintenanceObservation(observation, { ...options, root, sourceSha: options.sourceSha, baseSha: options.baseSha }) };
    if (options.outputDir) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const target = resolve(options.outputDir); await mkdir(target, { recursive: true });
      await writeFile(resolve(target, "data-candidate.json"), `${JSON.stringify(result.candidate, null, 2)}\n`);
    }
  } else if (options.mode === "write-pr") {
    const bytes = readFileBounded(resolve(options.observation), MAX_OBSERVATION_BYTES, "observation");
    const observation = JSON.parse(bytes.toString("utf8"));
    const candidate = replayMaintenanceObservation(observation, { ...options, root, sourceSha: options.sourceSha, baseSha: options.baseSha });
    const adapter = options.apply
      ? (await import("./maintenance-pr.mjs")).createGhAdapter({ repo: options.repo, root })
      : undefined;
    result = await writeDataMaintenancePr({ candidate, observation, report: options.report, repo: options.repo, adapter, apply: options.apply });
    if (result && observation) result.observation = observation;
  } else if (options.mode === "promote") {
    const adapter = (await import("./maintenance-pr.mjs")).createGhAdapter({ repo: options.repo, root });
    const explicitObservation = options.observation ? readJsonInputPath(options.observation, "observation", MAX_OBSERVATION_BYTES) : null;
    const explicitProvenance = options.provenance ? readJsonInputPath(options.provenance, "provenance", MAX_RAW_BYTES) : null;
    const fetched = typeof adapter.getMaintenanceObservation === "function"
      ? await adapter.getMaintenanceObservation(integerOption(options.ciRunId, "--ci-run-id"), integerOption(options.ciRunAttempt, "--ci-run-attempt"), { expectedHead: options.expectedHead, expectedBase: options.baseSha })
      : null;
    // The report path is output-only.  A local observation/provenance pair is
    // useful for a read-only preview, while --apply always requires the
    // authenticated same-run artifact returned by the GitHub adapter.
    if (options.apply && !fetched) fail("authenticated same-run CI maintenance artifact is missing", "CI_ARTIFACT_MISSING");
    const observation = fetched?.observation ?? explicitObservation;
    const suppliedProvenance = fetched?.provenance ?? explicitProvenance;
    let candidate = null;
    if (observation) {
      candidate = replayMaintenanceObservation(observation, { ...options, root, sourceSha: options.sourceSha, baseSha: options.baseSha });
    }
    if (!candidate) {
      result = { status: "BLOCKED", eligible: false, reasons: ["authenticated maintenance observation artifact is required; pass --observation and --provenance only for a local dry-run preview"] };
    } else {
      const pr = await adapter.getPullRequest(integerOption(options.pr, "--pr"));
      const run = await adapter.getWorkflowRun(integerOption(options.ciRunId, "--ci-run-id"), integerOption(options.ciRunAttempt, "--ci-run-attempt"));
      result = await promoteDataCandidate({ candidate, observation, pr, ci: run, run, provenance: suppliedProvenance, adapter, repo: options.repo, root, apply: options.apply, expectedHead: options.expectedHead, baseSha: options.baseSha, expectedRunId: integerOption(options.ciRunId, "--ci-run-id"), expectedAttempt: integerOption(options.ciRunAttempt, "--ci-run-attempt") });
    }
  } else if (options.mode === "verify-merged") {
    if (!options.expectedTree) fail("--expected-tree is required for merge verification", "USAGE");
    const adapter = (await import("./maintenance-pr.mjs")).createGhAdapter({ repo: options.repo, root });
    result = await verifyMergedCandidate({ mergeSha: options.mergeSha, expectedBase: options.expectedBase, expectedHead: options.expectedHead, expectedTree: options.expectedTree, adapter });
  } else fail(`unknown command ${options.mode}`, "USAGE");
  await writeReportPath(root, options.report, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath !== null && import.meta.url === invokedPath) {
  try { await run(); } catch (error) { process.stderr.write(`data-promotion: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = error.code === "USAGE" ? 64 : 1; }
}
