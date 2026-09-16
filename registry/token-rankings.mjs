import { createHash } from "node:crypto";
import canonicalArtifact from "./token-rankings.json" with { type: "json" };
import rankingConfig from "./ranking-config.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import { computeDigest as computeTokenCatalogDigest, validateCatalog as validateTokenCatalog } from "./token-catalog.mjs";
import { computeDigest as computeDexCatalogDigest, validateCatalog as validateDexCatalog } from "./dex-catalog.mjs";
import { createBoundedRpcClient, decodeSolanaMintAccount, decodeSolanaVaultAccount, SOLANA_DISCOVERY_LAYOUTS, TOKEN_PROGRAM_IDS, encodeBase58, verifySolanaPoolPda } from "./discovery.mjs";
import discoveryConfig from "./discovery-config.json" with { type: "json" };

export const RANKING_CHAIN_IDS = Object.freeze({
  ethereum: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  avalancheC: "eip155:43114",
});
export const RANKING_METRICS = Object.freeze([
  "onchain-total-supply-value-native",
  "global-circulating-market-cap-usd",
]);
export const RANKING_STATUSES = Object.freeze(["unconfigured", "complete", "partial"]);
export const UNRANKED_REASONS = Object.freeze([
  "unavailable", "stale", "unpriced", "invalid", "rights-denied",
  "below-min-native-liquidity", "excluded-native", "unsupported",
]);
export const NATIVE_QUOTE_DEPLOYMENTS = Object.freeze({
  "eip155:1": "deployment-0001",
  "eip155:43114": "deployment-0003",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "deployment-0005",
});
export const RANKING_RECEIPT_KEYS = Object.freeze(["schemaVersion", "artifactKind", "sourceSha", "configDigest", "tokenCatalogDigest", "dexCatalogDigest", "observedAt", "metric", "status", "receipts"]);
export const RANKING_RPC_ERROR_CODES = Object.freeze([
  "RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_RUN_BUDGET_EXCEEDED", "RPC_RATE_LIMITED",
  "RPC_UPSTREAM_ERROR", "RPC_INVALID_JSON", "RPC_RESULT_INVALID", "RPC_BODY_LIMIT", "RPC_ERROR",
]);

const CHAIN_SET = new Set(Object.values(RANKING_CHAIN_IDS));
const METRIC_SET = new Set(RANKING_METRICS);
const STATUS_SET = new Set(RANKING_STATUSES);
const REASON_SET = new Set(UNRANKED_REASONS);
const RANKING_RPC_ERROR_CODE_SET = new Set(RANKING_RPC_ERROR_CODES);
const VERIFIED_NO_PRICE_REASONS = new Set(["unpriced", "below-min-native-liquidity"]);
const NONNEGATIVE = /^(0|[1-9][0-9]*)$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const EVM_CHAINS = new Set([RANKING_CHAIN_IDS.ethereum, RANKING_CHAIN_IDS.avalancheC]);
const SOLANA_CHAIN = RANKING_CHAIN_IDS.solana;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT112 = (1n << 112n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_RATIONAL_DIGITS = 256;
const U128 = 1n << 128n;
const SOLANA_MAINNET_GENESIS = discoveryConfig.rpc.solana.expectedGenesisHash ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const EVM_SELECTORS = Object.freeze({
  totalSupply: "0x18160ddd",
  factoryGetPair: "0xe6a43905",
  pairFactory: "0xc45a0155",
  pairToken0: "0x0dfe1681",
  pairToken1: "0xd21220a7",
  pairReserves: "0x0902f1ac",
});

export class TokenRankingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenRankingValidationError";
  }
}
export class TokenRankingSourceError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = "TokenRankingSourceError";
    this.reason = reason;
  }
}
function fail(message) { throw new TokenRankingValidationError(message); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail(label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(label + " keys must be exactly " + keys.join(", "));
  }
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\0]/u.test(value)) fail(label + " must be a non-empty single-line string");
}
function opaque(value, label) {
  nonEmpty(value, label);
  if (!ID.test(value)) fail(label + " must be an opaque identifier");
}
function timestamp(value, label) {
  nonEmpty(value, label);
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) fail(label + " must be RFC3339");
}
function optionalTimestamp(value, label) { if (value !== null) timestamp(value, label); }
function integer(value, label, positive = false) {
  if (typeof value !== "string" || !(positive ? POSITIVE : NONNEGATIVE).test(value)) fail(label + " must be a canonical integer string");
  if (value.length > MAX_RATIONAL_DIGITS) fail(label + " exceeds the bounded rational length");
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) { const next = a % b; a = b; b = next; }
  return a;
}
export function normalizeRational(numerator, denominator = "1") {
  if (typeof numerator !== "bigint") { integer(numerator, "valueNumerator"); numerator = BigInt(numerator); }
  if (typeof denominator !== "bigint") { integer(denominator, "valueDenominator", true); denominator = BigInt(denominator); }
  if (numerator < 0n || denominator <= 0n) throw new TokenRankingValidationError("rational must be non-negative with a positive denominator");
  const divisor = gcd(numerator, denominator) || 1n;
  return Object.freeze({ numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString() });
}
export function compareRationals(left, right) {
  const ln = BigInt(left.numerator ?? left.valueNumerator);
  const ld = BigInt(left.denominator ?? left.valueDenominator);
  const rn = BigInt(right.numerator ?? right.valueNumerator);
  const rd = BigInt(right.denominator ?? right.valueDenominator);
  const l = ln * rd;
  const r = rn * ld;
  return l < r ? -1 : l > r ? 1 : 0;
}
function canonicalRecord(row) {
  return { rank: row.rank, chainId: row.chainId, deploymentIds: [...row.deploymentIds].sort(compareText),
    metric: row.metric, valueNumerator: row.valueNumerator, valueDenominator: row.valueDenominator,
    quoteCurrency: row.quoteCurrency, quoteDeploymentId: row.quoteDeploymentId, observedAt: row.observedAt,
    sourceId: row.sourceId, sourceAssetId: row.sourceAssetId };
}
function canonicalUnranked(row) { return { chainId: row.chainId, deploymentId: row.deploymentId, reason: row.reason, sourceId: row.sourceId, observedAt: row.observedAt }; }
function canonicalProvenance(row) { return { sourceId: row.sourceId, kind: row.kind, observedAt: row.observedAt, rights: row.rights, details: row.details }; }
export function canonicalProjection(artifact) {
  return {
    metadata: {
      schemaVersion: artifact.metadata.schemaVersion, metric: artifact.metadata.metric, asOf: artifact.metadata.asOf,
      status: artifact.metadata.status,
      coverage: [...artifact.metadata.coverage].sort((a, b) => compareText(a.chainId, b.chainId)),
      sourceIds: [...artifact.metadata.sourceIds].sort(compareText),
    },
    records: artifact.records.map(canonicalRecord).sort((a, b) => compareText(a.chainId, b.chainId) || a.rank - b.rank || compareText(a.deploymentIds.join("\0"), b.deploymentIds.join("\0"))),
    unranked: artifact.unranked.map(canonicalUnranked).sort((a, b) => compareText(a.chainId, b.chainId) || compareText(a.deploymentId, b.deploymentId) || compareText(a.reason, b.reason) || compareText(a.sourceId, b.sourceId)),
    provenance: artifact.provenance.map(canonicalProvenance).sort((a, b) => compareText(a.sourceId, b.sourceId) || compareText(a.kind, b.kind) || compareText(JSON.stringify(a.details), JSON.stringify(b.details))),
  };
}
export function computeDigest(artifact) { return createHash("sha256").update(JSON.stringify(canonicalProjection(artifact))).digest("hex"); }

function validateCoverage(row, index) {
  exactKeys(row, ["chainId", "totalDeployments", "rankedDeployments", "unrankedDeployments", "observedAt"], "metadata.coverage[" + index + "]");
  opaque(row.chainId, "metadata.coverage[" + index + "].chainId");
  for (const key of ["totalDeployments", "rankedDeployments", "unrankedDeployments"]) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) fail("metadata.coverage[" + index + "]." + key + " must be a non-negative safe integer");
  }
  if (row.rankedDeployments + row.unrankedDeployments > row.totalDeployments) fail("metadata.coverage[" + index + "] counts exceed totalDeployments");
  optionalTimestamp(row.observedAt, "metadata.coverage[" + index + "].observedAt");
}
export function validateRankingArtifact(artifact, { tokenCatalog = canonicalTokenCatalog } = {}) {
  exactKeys(artifact, ["metadata", "records", "unranked", "provenance"], "ranking artifact");
  validateTokenCatalog(tokenCatalog);
  exactKeys(artifact.metadata, ["schemaVersion", "metric", "asOf", "contentDigest", "status", "coverage", "sourceIds"], "metadata");
  if (artifact.metadata.schemaVersion !== 1) fail("metadata.schemaVersion must be 1");
  if (artifact.metadata.metric !== null && !METRIC_SET.has(artifact.metadata.metric)) fail("metadata.metric is invalid");
  optionalTimestamp(artifact.metadata.asOf, "metadata.asOf");
  if (typeof artifact.metadata.contentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.metadata.contentDigest)) fail("metadata.contentDigest must be SHA-256 hex");
  if (!STATUS_SET.has(artifact.metadata.status)) fail("metadata.status is invalid");
  if (!Array.isArray(artifact.metadata.coverage)) fail("metadata.coverage must be an array");
  artifact.metadata.coverage.forEach(validateCoverage);
  if (!Array.isArray(artifact.metadata.sourceIds) || artifact.metadata.sourceIds.some((id) => !ID.test(id)) || new Set(artifact.metadata.sourceIds).size !== artifact.metadata.sourceIds.length) fail("metadata.sourceIds must be unique opaque IDs");
  if (!Array.isArray(artifact.records) || !Array.isArray(artifact.unranked) || !Array.isArray(artifact.provenance)) fail("ranking artifact records must be arrays");
  const deployments = new Map(tokenCatalog.deployments.map((entry) => [entry.deploymentId, entry]));
  const positions = new Map();
  const rankedDeployments = new Set();
  const observed = [];
  for (const [index, row] of artifact.records.entries()) {
    exactKeys(row, ["rank", "chainId", "deploymentIds", "metric", "valueNumerator", "valueDenominator", "quoteCurrency", "quoteDeploymentId", "observedAt", "sourceId", "sourceAssetId"], "records[" + index + "]");
    if (!Number.isSafeInteger(row.rank) || row.rank < 1) fail("records[" + index + "].rank must be positive");
    opaque(row.chainId, "records[" + index + "].chainId");
    if (!CHAIN_SET.has(row.chainId)) fail("records[" + index + "].chainId is unsupported");
    if (!Array.isArray(row.deploymentIds) || row.deploymentIds.length === 0 || row.deploymentIds.some((id) => !ID.test(id)) || new Set(row.deploymentIds).size !== row.deploymentIds.length) fail("records[" + index + "].deploymentIds is invalid");
    for (const id of row.deploymentIds) {
      const deployment = deployments.get(id);
      if (!deployment) fail("records[" + index + "] references unknown deployment " + id);
      if (deployment.chainId !== row.chainId) fail("records[" + index + "] deployment chain mismatch");
    }
    if (!METRIC_SET.has(row.metric)) fail("records[" + index + "].metric is invalid");
    if (artifact.metadata.metric !== null && artifact.metadata.metric !== row.metric) fail("record metric differs from metadata");
    integer(row.valueNumerator, "records[" + index + "].valueNumerator");
    integer(row.valueDenominator, "records[" + index + "].valueDenominator", true);
    const reduced = normalizeRational(row.valueNumerator, row.valueDenominator);
    if (reduced.numerator !== row.valueNumerator || reduced.denominator !== row.valueDenominator) fail("records[" + index + "] rational value is not reduced");
    if (row.metric === "onchain-total-supply-value-native") {
      if (row.quoteCurrency !== "native" || row.quoteDeploymentId !== NATIVE_QUOTE_DEPLOYMENTS[row.chainId]) fail("records[" + index + "] native quote is invalid");
      if (row.deploymentIds.length !== 1 || row.sourceAssetId !== null) fail("records[" + index + "] native rows must name one deployment and have null sourceAssetId");
    } else if (row.quoteCurrency !== "USD" || row.quoteDeploymentId !== null || row.sourceAssetId === null) fail("records[" + index + "] USD quote is invalid");
    timestamp(row.observedAt, "records[" + index + "].observedAt");
    opaque(row.sourceId, "records[" + index + "].sourceId");
    if (row.sourceAssetId !== null) opaque(row.sourceAssetId, "records[" + index + "].sourceAssetId");
    const key = row.chainId + "\0" + row.rank;
    if (positions.has(key)) fail("duplicate ranking position " + key);
    positions.set(key, row);
    for (const id of row.deploymentIds) {
      const deploymentKey = row.chainId + "\0" + id;
      if (rankedDeployments.has(deploymentKey)) fail("deployment appears in more than one ranking row " + deploymentKey);
      rankedDeployments.add(deploymentKey);
    }
    observed.push(row.observedAt);
  }
  const byChain = new Map();
  for (const row of artifact.records) {
    const rows = byChain.get(row.chainId) ?? [];
    rows.push(row);
    byChain.set(row.chainId, rows);
  }
  for (const [chainId, rows] of byChain) {
    rows.sort((a, b) => a.rank - b.rank);
    rows.forEach((row, index) => { if (row.rank !== index + 1) fail("ranks for " + chainId + " must be sequential"); });
    for (let index = 1; index < rows.length; index += 1) {
      const order = compareRationals(rows[index - 1], rows[index]);
      if (order < 0) fail("ranks for " + chainId + " must be descending");
      if (order === 0) {
        const before = rows[index - 1].sourceId + "\0" + rows[index - 1].deploymentIds.join("\0");
        const after = rows[index].sourceId + "\0" + rows[index].deploymentIds.join("\0");
        if (before > after) fail("equal values for " + chainId + " must be stable");
      }
    }
  }
  const unranked = new Set();
  for (const [index, row] of artifact.unranked.entries()) {
    exactKeys(row, ["chainId", "deploymentId", "reason", "sourceId", "observedAt"], "unranked[" + index + "]");
    opaque(row.chainId, "unranked[" + index + "].chainId");
    if (!CHAIN_SET.has(row.chainId)) fail("unranked[" + index + "].chainId is unsupported");
    opaque(row.deploymentId, "unranked[" + index + "].deploymentId");
    const deployment = deployments.get(row.deploymentId);
    if (deployment && deployment.chainId !== row.chainId) fail("unranked deployment chain mismatch");
    if (!REASON_SET.has(row.reason)) fail("unranked[" + index + "].reason is invalid");
    opaque(row.sourceId, "unranked[" + index + "].sourceId");
    optionalTimestamp(row.observedAt, "unranked[" + index + "].observedAt");
    const key = row.chainId + "\0" + row.deploymentId;
    if (unranked.has(key) || rankedDeployments.has(key)) fail("duplicate ranked or unranked deployment " + key);
    unranked.add(key);
  }
  for (const [index, row] of artifact.provenance.entries()) {
    exactKeys(row, ["sourceId", "kind", "observedAt", "rights", "details"], "provenance[" + index + "]");
    opaque(row.sourceId, "provenance[" + index + "].sourceId");
    if (!["rpc", "licensed-global-provider", "replay"].includes(row.kind)) fail("provenance[" + index + "].kind is invalid");
    optionalTimestamp(row.observedAt, "provenance[" + index + "].observedAt");
    if (!["original-rpc-facts", "licensed", "unconfigured", "unknown"].includes(row.rights)) fail("provenance[" + index + "].rights is invalid");
    if (!isRecord(row.details)) fail("provenance[" + index + "].details must be an object");
  }
  const sourceIds = new Set(artifact.metadata.sourceIds);
  for (const row of [...artifact.records, ...artifact.unranked, ...artifact.provenance]) if (!sourceIds.has(row.sourceId)) fail("metadata.sourceIds is missing " + row.sourceId);
  const coverageByChain = new Map();
  for (const [index, row] of artifact.metadata.coverage.entries()) {
    if (!CHAIN_SET.has(row.chainId) || coverageByChain.has(row.chainId)) fail("metadata.coverage contains a duplicate or unsupported chain");
    coverageByChain.set(row.chainId, row);
  }
  for (const chainId of coverageByChain.keys()) {
    const all = tokenCatalog.deployments.filter((entry) => entry.chainId === chainId).length;
    const ranked = [...rankedDeployments].filter((key) => key.startsWith(chainId + "\0")).length;
    const missing = [...unranked].filter((key) => key.startsWith(chainId + "\0")).length;
    const coverage = coverageByChain.get(chainId);
    if (artifact.metadata.status === "unconfigured" && !coverage) continue;
    if (!coverage || coverage.totalDeployments !== all || coverage.rankedDeployments !== ranked || coverage.unrankedDeployments !== missing || ranked + missing !== all) fail("metadata.coverage does not account for every chain deployment");
  }
  const oldest = observed.length === 0 ? null : observed.reduce((a, b) => Date.parse(a) <= Date.parse(b) ? a : b);
  if (artifact.metadata.asOf !== oldest) fail("metadata.asOf must be oldest ranked observedAt");
  if (artifact.metadata.status === "unconfigured" && (artifact.records.length || artifact.unranked.length)) fail("unconfigured rankings cannot contain observations");
  if (artifact.metadata.status === "complete" && artifact.unranked.some((row) => row.reason !== "excluded-native" && !(row.reason === "unsupported" && deployments.get(row.deploymentId)?.status !== "active"))) fail("complete rankings cannot contain unresolved unranked records");
  if (artifact.metadata.contentDigest !== computeDigest(artifact)) fail("metadata.contentDigest does not match canonical projection");
  return true;
}
export function validateRankingConfig(config) {
  exactKeys(config, ["schemaVersion", "metric", "freshness", "sources", "globalCirculatingMarketCap"], "ranking config");
  if (config.schemaVersion !== 1 || !METRIC_SET.has(config.metric)) fail("ranking config schemaVersion or metric is invalid");
  exactKeys(config.freshness, ["maxBlockAgeSeconds", "maxBlockLag", "maxClockSkewSeconds"], "ranking config freshness");
  const limits = { maxBlockAgeSeconds: [0, 86400], maxBlockLag: [0, 1024], maxClockSkewSeconds: [0, 300] };
  for (const [key, range] of Object.entries(limits)) if (!Number.isSafeInteger(config.freshness[key]) || config.freshness[key] < range[0] || config.freshness[key] > range[1]) fail("ranking config freshness." + key + " is invalid");
  for (const chainId of Object.values(RANKING_CHAIN_IDS)) {
    const source = config.sources[chainId];
    exactKeys(source, ["sourceId", "nativeTokenDeploymentId", "quoteDeploymentId", "nativeWrapDeploymentId", "minNativeLiquidity", "finalizedMaxBlockAgeSeconds", "maxSlotSpread"], "ranking config source " + chainId);
    opaque(source.sourceId, "ranking config sourceId");
    opaque(source.nativeTokenDeploymentId, "ranking config nativeTokenDeploymentId");
    if (source.quoteDeploymentId !== NATIVE_QUOTE_DEPLOYMENTS[chainId]) fail("ranking config quote deployment is invalid");
    opaque(source.nativeWrapDeploymentId, "ranking config nativeWrapDeploymentId");
    integer(source.minNativeLiquidity, "ranking config source minNativeLiquidity", true);
    if (!Number.isSafeInteger(source.finalizedMaxBlockAgeSeconds) || source.finalizedMaxBlockAgeSeconds < 0 || source.finalizedMaxBlockAgeSeconds > 86400) fail("ranking config source finalizedMaxBlockAgeSeconds is invalid");
    if (!Number.isSafeInteger(source.maxSlotSpread) || source.maxSlotSpread < 0 || source.maxSlotSpread > 100000) fail("ranking config source maxSlotSpread is invalid");
  }
  exactKeys(config.globalCirculatingMarketCap, ["enabled", "sourceId", "rights", "mappings"], "ranking config globalCirculatingMarketCap");
  if (typeof config.globalCirculatingMarketCap.enabled !== "boolean") fail("global market-cap enabled must be boolean");
  if (config.globalCirculatingMarketCap.sourceId !== null) opaque(config.globalCirculatingMarketCap.sourceId, "global market-cap sourceId");
  if (!["licensed", "unconfigured"].includes(config.globalCirculatingMarketCap.rights) || !Array.isArray(config.globalCirculatingMarketCap.mappings)) fail("global market-cap rights or mappings are invalid");
  return true;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function jsonDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function deploymentMap(catalog) { return new Map(catalog.deployments.map((entry) => [entry.deploymentId, entry])); }
function assetMap(catalog) { return new Map(catalog.assets.map((entry) => [entry.assetId, entry])); }
function isSolanaWsol(deployment, asset) {
  return deployment.chainId === SOLANA_CHAIN && (deployment.assetId === "asset-0006" || deployment.symbol === "WSOL" || asset?.underlyingAssetId === "asset-0005");
}
function eligible(deployment, assets) { return deployment.status === "active" && deployment.standard !== "native" && !isSolanaWsol(deployment, assets.get(deployment.assetId)); }
function sourceId(chainId, options) { return options.sourceId ?? options.config?.sources?.[chainId]?.sourceId ?? rankingConfig.sources[chainId]?.sourceId ?? "rpc-" + chainId.replaceAll(":", "-"); }
function observed(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "bigint" || typeof value === "number") return new Date(Number(value) * 1000).toISOString().replace(".000Z", "Z");
  if (typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value)) return new Date(Number(BigInt(value)) * 1000).toISOString().replace(".000Z", "Z");
  return RFC3339.test(value) ? value : fallback;
}
function defaultMetric(input, options) {
  const extracted = isRecord(input) ? input.candidates ?? input.observations ?? input.records ?? [] : [];
  return options.metric ?? extracted.find((entry) => METRIC_SET.has(entry?.metric))?.metric ?? rankingConfig.metric;
}
function extract(input) {
  if (Array.isArray(input)) return { candidates: input, unranked: [], provenance: [] };
  if (!isRecord(input)) return { candidates: [], unranked: [], provenance: [] };
  return { candidates: input.candidates ?? input.observations ?? input.records ?? [], unranked: input.unranked ?? [], provenance: input.provenance ?? [] };
}
function candidateValue(candidate) {
  if (candidate.valueNumerator !== undefined || candidate.valueDenominator !== undefined) return normalizeRational(candidate.valueNumerator, candidate.valueDenominator ?? "1");
  if (candidate.numerator !== undefined || candidate.denominator !== undefined) return normalizeRational(candidate.numerator, candidate.denominator ?? "1");
  if (typeof candidate.value === "string" && NONNEGATIVE.test(candidate.value)) return normalizeRational(candidate.value, "1");
  return null;
}
function makeUnranked(chainId, deploymentId, reason, source, at = null) { return { chainId, deploymentId, reason, sourceId: source, observedAt: at }; }
function provenance(source, kind, rights, at, details = {}) { return { sourceId: source, kind, observedAt: at, rights, details }; }
function normalizeCandidate(candidate, metric, catalog, options) {
  const deployments = deploymentMap(catalog);
  const id = candidate?.deploymentId ?? candidate?.tokenDeploymentId;
  const deployment = deployments.get(id);
  if (!deployment) return { error: "unavailable", deploymentId: id };
  if (candidate.chainId !== undefined && candidate.chainId !== deployment.chainId) return { error: "invalid", deploymentId: id };
  if (!eligible(deployment, assetMap(catalog))) return { error: "excluded-native", deploymentId: id };
  const value = candidateValue(candidate);
  const at = observed(candidate.observedAt, options.observedAt ?? null);
  if (!value || !at) return { error: metric === "global-circulating-market-cap-usd" ? "unpriced" : "unavailable", deploymentId: id };
  const source = candidate.sourceId ?? sourceId(deployment.chainId, options);
  const groupKey = candidate.groupKey ?? candidate.economicAssetId ?? candidate.assetId ?? candidate.sourceAssetId ?? id;
  return { chainId: deployment.chainId, deploymentId: id, metric, valueNumerator: value.numerator, valueDenominator: value.denominator,
    quoteCurrency: metric === "global-circulating-market-cap-usd" ? "USD" : "native",
    quoteDeploymentId: metric === "global-circulating-market-cap-usd" ? null : NATIVE_QUOTE_DEPLOYMENTS[deployment.chainId],
    observedAt: at, sourceId: source, sourceAssetId: metric === "global-circulating-market-cap-usd" ? (candidate.sourceAssetId ?? null) : null, groupKey };
}
function rankRows(rows, metric) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.chainId + "\0" + (metric === "global-circulating-market-cap-usd" ? row.groupKey : row.deploymentId);
    const current = groups.get(key);
    if (!current) groups.set(key, { ...row, deploymentIds: [row.deploymentId] });
    else {
      current.deploymentIds = [...new Set([...current.deploymentIds, row.deploymentId])].sort(compareText);
      if (compareRationals(current, row) !== 0 && current.sourceId !== row.sourceId) throw new TokenRankingValidationError("conflicting provider values for one economic asset");
      if (current.sourceId === row.sourceId && Date.parse(row.observedAt) > Date.parse(current.observedAt)) Object.assign(current, row);
    }
  }
  const byChain = new Map();
  for (const row of groups.values()) { const list = byChain.get(row.chainId) ?? []; list.push(row); byChain.set(row.chainId, list); }
  const records = [];
  for (const [chainId, rowsForChain] of byChain) {
    rowsForChain.sort((a, b) => compareRationals(b, a) || compareText(a.sourceId + "\0" + a.deploymentIds.join("\0"), b.sourceId + "\0" + b.deploymentIds.join("\0")));
    rowsForChain.forEach((row, index) => records.push({ rank: index + 1, chainId, deploymentIds: [...row.deploymentIds].sort(compareText), metric,
      valueNumerator: row.valueNumerator, valueDenominator: row.valueDenominator, quoteCurrency: metric === "global-circulating-market-cap-usd" ? "USD" : "native",
      quoteDeploymentId: metric === "global-circulating-market-cap-usd" ? null : NATIVE_QUOTE_DEPLOYMENTS[chainId], observedAt: row.observedAt, sourceId: row.sourceId,
      sourceAssetId: metric === "global-circulating-market-cap-usd" ? row.sourceAssetId : null }));
  }
  return records.sort((a, b) => compareText(a.chainId, b.chainId) || a.rank - b.rank);
}
export function replayTokenRankings(input, options = {}) {
  const catalog = options.tokenCatalog ?? canonicalTokenCatalog;
  validateTokenCatalog(catalog);
  const metric = defaultMetric(input, options);
  if (!METRIC_SET.has(metric)) throw new TokenRankingValidationError("ranking metric is invalid");
  const extracted = extract(input);
  const rows = [];
  const unranked = [];
  const provenanceRows = [];
  const sources = new Set();
  const seen = new Set();
  for (const item of extracted.provenance) {
    if (!isRecord(item)) continue;
    const source = item.sourceId ?? options.sourceId ?? "replay";
    if (!ID.test(source)) continue;
    provenanceRows.push(provenance(source, item.kind ?? "replay", item.rights ?? "unknown", observed(item.observedAt, options.observedAt ?? null), isRecord(item.details) ? clone(item.details) : {}));
    sources.add(source);
  }
  const deployments = deploymentMap(catalog);
  for (const item of extracted.candidates) {
    const row = normalizeCandidate(item, metric, catalog, options);
    if (row.error) {
      const id = row.deploymentId ?? item?.deploymentId ?? item?.tokenDeploymentId;
      const deployment = deployments.get(id);
      const chainId = item?.chainId ?? deployment?.chainId;
      if (typeof id === "string" && CHAIN_SET.has(chainId)) { const source = item.sourceId ?? sourceId(chainId, options); unranked.push(makeUnranked(chainId, id, row.error, source, observed(item.observedAt, options.observedAt ?? null))); sources.add(source); }
      continue;
    }
    const key = row.chainId + "\0" + row.deploymentId;
    if (seen.has(key)) { unranked.push(makeUnranked(row.chainId, row.deploymentId, "invalid", row.sourceId, row.observedAt)); sources.add(row.sourceId); continue; }
    seen.add(key); rows.push(row); sources.add(row.sourceId);
    if (!provenanceRows.some((entry) => entry.sourceId === row.sourceId)) provenanceRows.push(provenance(row.sourceId, metric === "global-circulating-market-cap-usd" ? "licensed-global-provider" : "replay", metric === "global-circulating-market-cap-usd" ? "licensed" : "original-rpc-facts", row.observedAt));
  }
  for (const item of extracted.unranked) {
    if (!isRecord(item)) continue;
    const id = item.deploymentId ?? item.tokenDeploymentId;
    const deployment = deployments.get(id);
    const chainId = item.chainId ?? deployment?.chainId;
    if (typeof id !== "string" || !CHAIN_SET.has(chainId)) continue;
    const key = chainId + "\0" + id;
    const source = item.sourceId ?? sourceId(chainId, options);
    if (!seen.has(key) && !unranked.some((entry) => entry.chainId + "\0" + entry.deploymentId === key)) unranked.push(makeUnranked(chainId, id, REASON_SET.has(item.reason) ? item.reason : "unavailable", source, observed(item.observedAt, options.observedAt ?? null)));
    sources.add(source);
  }
  const assets = assetMap(catalog);
  const eligibleRows = catalog.deployments.filter((entry) => eligible(entry, assets) && (!options.chainId || entry.chainId === options.chainId));
  const allRows = catalog.deployments.filter((entry) => !options.chainId || entry.chainId === options.chainId);
  for (const deployment of allRows) {
    const key = deployment.chainId + "\0" + deployment.deploymentId;
    if (seen.has(key) || unranked.some((entry) => entry.chainId + "\0" + entry.deploymentId === key)) continue;
    const source = sourceId(deployment.chainId, options);
    const reason = eligible(deployment, assets) ? "unavailable" : (deployment.standard === "native" || isSolanaWsol(deployment, assets.get(deployment.assetId)) ? "excluded-native" : "unsupported");
    unranked.push(makeUnranked(deployment.chainId, deployment.deploymentId, reason, source));
    sources.add(source);
  }
  const records = rankRows(rows, metric);
  const chains = (options.chainId ? [options.chainId] : [...CHAIN_SET]).filter((id) => CHAIN_SET.has(id)).sort(compareText);
  const coverage = chains.map((chainId) => {
    const total = allRows.filter((entry) => entry.chainId === chainId).length;
    const ranked = records.filter((entry) => entry.chainId === chainId).reduce((sum, entry) => sum + entry.deploymentIds.length, 0);
    const missing = unranked.filter((entry) => entry.chainId === chainId).length;
    const ats = [...records.filter((entry) => entry.chainId === chainId).map((entry) => entry.observedAt), ...unranked.filter((entry) => entry.chainId === chainId).map((entry) => entry.observedAt).filter(Boolean)];
    return { chainId, totalDeployments: total, rankedDeployments: ranked, unrankedDeployments: missing, observedAt: ats.length ? ats.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) : null };
  });
  const asOf = records.length ? records.map((entry) => entry.observedAt).reduce((a, b) => Date.parse(a) <= Date.parse(b) ? a : b) : null;
  const unresolved = unranked.some((entry) => entry.reason !== "excluded-native" && !(entry.reason === "unsupported" && deployments.get(entry.deploymentId)?.status !== "active"));
  const status = records.length === 0 && unranked.length === 0 ? "unconfigured" : unresolved ? "partial" : "complete";
  const artifact = { metadata: { schemaVersion: 1, metric: status === "unconfigured" ? null : metric, asOf, contentDigest: "0".repeat(64), status, coverage, sourceIds: [...sources].sort(compareText) }, records, unranked, provenance: provenanceRows };
  artifact.metadata.contentDigest = computeDigest(artifact);
  validateRankingArtifact(artifact, { tokenCatalog: catalog });
  return deepFreeze(artifact);
}
export const rankTokenObservations = replayTokenRankings;

function unwrap(response) {
  if (response && isRecord(response) && Object.hasOwn(response, "error")) {
    if (response.error instanceof Error) throw response.error;
    const error = new Error(typeof response.error === "string" ? response.error : response.error?.message ?? "RPC request failed");
    if (isRecord(response.error)) Object.assign(error, response.error);
    throw error;
  }
  return response && isRecord(response) && Object.hasOwn(response, "result") && Object.keys(response).every((key) => ["id", "jsonrpc", "result"].includes(key)) ? response.result : response;
}
function rpcCall(context, method, params) {
  const rpc = context?.rpc ?? context;
  const signal = context?.signal;
  if (signal?.aborted) throw signal.reason ?? new TokenRankingSourceError("unavailable", "ranking RPC cancelled");
  if (typeof rpc === "function") return rpc(method, params, signal ? { signal } : undefined);
  if (rpc && typeof rpc.request === "function") return rpc.request(method, params, signal ? { signal } : undefined);
  if (rpc && typeof rpc.call === "function") return rpc.call(method, params, signal ? { signal } : undefined);
  throw new TokenRankingSourceError("unavailable", "ranking RPC is not configured");
}
async function rpc(context, method, params) {
  try {
    const result = unwrap(await rpcCall(context, method, params));
    if (Array.isArray(context?.__transcript)) {
      const request = clone(params);
      const response = clone(result);
      context.__transcript.push({ method, params: request, requestDigest: jsonDigest(request), result: response, responseDigest: jsonDigest(response) });
    }
    return result;
  } catch (error) {
    if (Array.isArray(context?.__transcript)) {
      const request = clone(params);
      const failure = { code: fixedRpcErrorCode(error) };
      context.__transcript.push({ method, params: request, requestDigest: jsonDigest(request), error: failure, errorDigest: jsonDigest(failure) });
    }
    throw error;
  }
}
function fixedRpcErrorCode(error) {
  if (typeof error?.code === "string" && RANKING_RPC_ERROR_CODE_SET.has(error.code)) return error.code;
  if (error?.code === "ETIMEDOUT") return "RPC_TIMEOUT";
  if (error?.code === "ECONNRESET" || error?.code === "EAI_AGAIN") return "RPC_UNAVAILABLE";
  return "RPC_UNAVAILABLE";
}
function isFixedRpcError(value) {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.code === "string" && RANKING_RPC_ERROR_CODE_SET.has(value.code);
}
function qty(value, label, allowNumber = false, maximum = MAX_UINT256) {
  if (typeof value === "bigint") {
    if (value < 0n || value > maximum) throw new TokenRankingSourceError("invalid", label + " is out of range");
    return value;
  }
  if (allowNumber && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || (!NONNEGATIVE.test(value) && !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value))) throw new TokenRankingSourceError("invalid", label + " is invalid");
  if (value.startsWith("0x") && value.length > 66 || !value.startsWith("0x") && value.length > 78) throw new TokenRankingSourceError("invalid", label + " exceeds the bounded quantity length");
  const result = BigInt(value);
  if (result < 0n || result > maximum) throw new TokenRankingSourceError("invalid", label + " is out of range");
  return result;
}
function slotQty(value, label) { return qty(value, label, true, MAX_UINT64); }
function block(value) {
  if (!isRecord(value) || typeof value.hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value.hash)) throw new TokenRankingSourceError("stale", "EVM block is incomplete");
  return { number: qty(value.number, "block number"), timestamp: qty(value.timestamp, "block timestamp"), hash: value.hash.toLowerCase() };
}
function data(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]*$/iu.test(value) || value.length % 2) throw new TokenRankingSourceError("invalid", "EVM ABI data is malformed");
  return value.toLowerCase();
}
function word(value, index = 0) {
  const body = data(value).slice(2);
  if (body.length < (index + 1) * 64) throw new TokenRankingSourceError("invalid", "EVM ABI word is missing");
  return body.slice(index * 64, (index + 1) * 64);
}
function abiQty(value, index = 0, maximum = MAX_UINT256, wordCount = 1) {
  if (data(value).slice(2).length !== wordCount * 64) throw new TokenRankingSourceError("invalid", "EVM ABI quantity has unexpected padding");
  return qty(BigInt("0x" + word(value, index)), "EVM ABI quantity", false, maximum);
}
function abiAddress(value) {
  if (data(value).slice(2).length !== 64) throw new TokenRankingSourceError("invalid", "EVM ABI address has unexpected padding");
  const body = word(value);
  if (!/^0{24}[0-9a-f]{40}$/u.test(body)) throw new TokenRankingSourceError("invalid", "EVM ABI address is malformed");
  return "0x" + body.slice(-40);
}
function addressArg(value) {
  const address = value.toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw new TokenRankingSourceError("invalid", "EVM address is invalid");
  return address.slice(2).padStart(64, "0");
}
function reserves(value) {
  if (data(value).slice(2).length !== 192) throw new TokenRankingSourceError("invalid", "EVM reserve ABI has unexpected padding");
  const first = abiQty(value, 0, MAX_UINT112, 3);
  const second = abiQty(value, 1, MAX_UINT112, 3);
  if (first <= 0n || second <= 0n) throw new TokenRankingSourceError("unpriced", "pool reserves are empty");
  return { reserve0: first, reserve1: second };
}
function nativeWrap(dexCatalog, chainId) { return dexCatalog.nativeWrapDefinitions.find((entry) => entry.chainId === chainId && entry.status === "active") ?? null; }
function nativePool(pool, wrap) { return wrap && (pool.token0DeploymentId === wrap.wrappedTokenDeploymentId || pool.token1DeploymentId === wrap.wrappedTokenDeploymentId); }
function stateSelector(hash) { return { blockHash: hash, requireCanonical: true }; }
function now(options) { const value = typeof options.clock === "function" ? options.clock() : options.now; return value === undefined ? Math.floor(Date.now() / 1000) : value; }
function chainName(chainId) {
  if (chainId === RANKING_CHAIN_IDS.ethereum) return "ethereum";
  if (chainId === RANKING_CHAIN_IDS.avalancheC) return "avalancheC";
  return "solana";
}
function makeBoundedClient(options) {
  if (typeof options.rpcClient === "function") return options.rpcClient;
  const supplied = options.rpc ?? options.reader ?? options.request;
  if (supplied === undefined) {
    const client = createBoundedRpcClient({ ...options }, discoveryConfig);
    return (network, method, params) => client(network, method, params);
  }
  const providerFor = (network) => {
    if (isRecord(supplied)) return supplied[network] ?? supplied[network === "ethereum" ? RANKING_CHAIN_IDS.ethereum : network === "avalancheC" ? RANKING_CHAIN_IDS.avalancheC : RANKING_CHAIN_IDS.solana] ?? supplied;
    return supplied;
  };
  const client = createBoundedRpcClient({ ...options, rpc: { ethereum: providerFor("ethereum"), avalancheC: providerFor("avalancheC"), solana: providerFor("solana") } }, discoveryConfig);
  return (network, method, params) => client(network, method, params);
}
function fresh(initial, latest, reread, options, chainId) {
  const config = options.config?.freshness ?? rankingConfig.freshness;
  const source = options.config?.sources?.[chainId] ?? rankingConfig.sources[chainId];
  const maxAge = source?.finalizedMaxBlockAgeSeconds ?? config.maxBlockAgeSeconds;
  const current = options.observationAt !== undefined ? BigInt(Math.floor(Date.parse(options.observationAt) / 1000)) : BigInt(now(options));
  for (const header of [initial, latest]) { const age = current - header.timestamp; if (age < -BigInt(config.maxClockSkewSeconds) || age > BigInt(maxAge)) throw new TokenRankingSourceError("stale", "EVM snapshot is outside freshness bounds"); }
  if (reread.number !== initial.number || reread.hash !== initial.hash || reread.timestamp !== initial.timestamp) throw new TokenRankingSourceError("stale", "EVM block hash changed");
  if (latest.number < initial.number || latest.number - initial.number > BigInt(config.maxBlockLag)) throw new TokenRankingSourceError("stale", "EVM block lag exceeded");
}
async function collectEvm(chainId, options, tokenCatalog, dexCatalog) {
  const transcript = options.__transcript ?? [];
  const source = sourceId(chainId, options);
  const deployments = deploymentMap(tokenCatalog);
  const assets = assetMap(tokenCatalog);
  const eligibleRows = tokenCatalog.deployments.filter((entry) => entry.chainId === chainId && eligible(entry, assets));
  const wrap = nativeWrap(dexCatalog, chainId);
  const pools = dexCatalog.poolDefinitions.filter((entry) => entry.chainId === chainId && entry.status === "active" && nativePool(entry, wrap));
  const network = qty(await rpc(options, "eth_chainId", []), "eth_chainId");
  if (network !== (chainId === RANKING_CHAIN_IDS.ethereum ? 1n : 43114n)) throw new TokenRankingSourceError("invalid", "EVM chain ID mismatch");
  const initial = block(await rpc(options, "eth_getBlockByNumber", ["finalized", false]));
  const selectorHash = stateSelector(initial.hash);
  const selected = new Map();
  const unranked = [];
  for (const pool of pools) {
    const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
    const token0 = deployments.get(pool.token0DeploymentId);
    const token1 = deployments.get(pool.token1DeploymentId);
    if (!dex || !token0?.address || !token1?.address) continue;
    try {
      if (data(await rpc(options, "eth_getCode", [dex.programAddress, selectorHash])) === "0x") throw new TokenRankingSourceError("invalid", "factory has no code");
      if (data(await rpc(options, "eth_getCode", [pool.address, selectorHash])) === "0x") throw new TokenRankingSourceError("invalid", "pool has no code");
      const pair = await rpc(options, "eth_call", [{ to: dex.programAddress, data: EVM_SELECTORS.factoryGetPair + addressArg(token0.address) + addressArg(token1.address) }, selectorHash]);
      const owner = await rpc(options, "eth_call", [{ to: pool.address, data: EVM_SELECTORS.pairFactory }, selectorHash]);
      const readToken0 = await rpc(options, "eth_call", [{ to: pool.address, data: EVM_SELECTORS.pairToken0 }, selectorHash]);
      const readToken1 = await rpc(options, "eth_call", [{ to: pool.address, data: EVM_SELECTORS.pairToken1 }, selectorHash]);
      const reserve = reserves(await rpc(options, "eth_call", [{ to: pool.address, data: EVM_SELECTORS.pairReserves }, selectorHash]));
      if (abiAddress(pair) !== pool.address.toLowerCase() || abiAddress(owner) !== dex.programAddress.toLowerCase()) throw new TokenRankingSourceError("invalid", "EVM pool owner mismatch");
      if (abiAddress(readToken0) !== token0.address.toLowerCase() || abiAddress(readToken1) !== token1.address.toLowerCase()) throw new TokenRankingSourceError("invalid", "EVM pool orientation mismatch");
      const nativeIs0 = pool.token0DeploymentId === wrap.wrappedTokenDeploymentId;
      const id = nativeIs0 ? pool.token1DeploymentId : pool.token0DeploymentId;
      const nativeLiquidity = nativeIs0 ? reserve.reserve0 : reserve.reserve1;
      const tokenReserve = nativeIs0 ? reserve.reserve1 : reserve.reserve0;
      const candidate = { poolDefinitionId: pool.poolDefinitionId, nativeLiquidity, tokenReserve, observedAt: observed(initial.timestamp) };
      const previous = selected.get(id);
      if (!previous || candidate.nativeLiquidity > previous.nativeLiquidity || candidate.nativeLiquidity === previous.nativeLiquidity && candidate.poolDefinitionId < previous.poolDefinitionId) selected.set(id, candidate);
    } catch (error) {
      const id = pool.token0DeploymentId === wrap?.wrappedTokenDeploymentId ? pool.token1DeploymentId : pool.token0DeploymentId;
      if (eligibleRows.some((entry) => entry.deploymentId === id)) unranked.push(makeUnranked(chainId, id, error instanceof TokenRankingSourceError ? error.reason : "unavailable", source, observed(initial.timestamp)));
    }
  }
  const minimum = BigInt(options.config?.sources?.[chainId]?.minNativeLiquidity ?? rankingConfig.sources[chainId]?.minNativeLiquidity);
  const candidates = [];
  for (const entry of eligibleRows) {
    const selectedPool = selected.get(entry.deploymentId);
    if (selectedPool) for (let index = unranked.length - 1; index >= 0; index -= 1) if (unranked[index].deploymentId === entry.deploymentId) unranked.splice(index, 1);
    if (unranked.some((row) => row.deploymentId === entry.deploymentId)) continue;
    if (!selectedPool) { unranked.push(makeUnranked(chainId, entry.deploymentId, "unpriced", source, observed(initial.timestamp))); continue; }
    if (selectedPool.nativeLiquidity < minimum) { unranked.push(makeUnranked(chainId, entry.deploymentId, "below-min-native-liquidity", source, selectedPool.observedAt)); continue; }
    try {
      const supply = abiQty(await rpc(options, "eth_call", [{ to: entry.address, data: EVM_SELECTORS.totalSupply }, selectorHash]));
      if (supply <= 0n || selectedPool.tokenReserve <= 0n) throw new TokenRankingSourceError("unpriced", "token supply or reserve is empty");
      const value = normalizeRational(supply * selectedPool.nativeLiquidity, selectedPool.tokenReserve);
      candidates.push({ chainId, deploymentId: entry.deploymentId, valueNumerator: value.numerator, valueDenominator: value.denominator, observedAt: selectedPool.observedAt, sourceId: source, poolDefinitionId: selectedPool.poolDefinitionId });
    } catch (error) {
      unranked.push(makeUnranked(chainId, entry.deploymentId, error instanceof TokenRankingSourceError ? error.reason : "unavailable", source, selectedPool.observedAt));
    }
  }
  const latest = block(await rpc(options, "eth_getBlockByNumber", ["finalized", false]));
  const reread = block(await rpc(options, "eth_getBlockByNumber", ["0x" + initial.number.toString(16), false]));
  try { fresh(initial, latest, reread, options, chainId); } catch (error) {
    for (const entry of eligibleRows) if (!unranked.some((row) => row.deploymentId === entry.deploymentId)) unranked.push(makeUnranked(chainId, entry.deploymentId, "stale", source, observed(initial.timestamp)));
    return { candidates: [], unranked, provenance: [provenance(source, "rpc", "original-rpc-facts", observed(initial.timestamp), { blockHash: initial.hash })], transcript };
  }
  return { candidates, unranked, provenance: [provenance(source, "rpc", "original-rpc-facts", observed(initial.timestamp), { blockHash: initial.hash, blockNumber: initial.number.toString() })], transcript };
}
function asBuffer(account) {
  const value = account?.value ?? account;
  const raw = value?.data;
  if (Array.isArray(raw) && typeof raw[0] === "string") return Buffer.from(raw[0], "base64");
  if (typeof raw === "string") return Buffer.from(raw, "base64");
  return null;
}
function little(bytes, offset, length) {
  if (!bytes || offset < 0 || offset + length > bytes.length) return null;
  let result = 0n;
  for (let index = offset + length - 1; index >= offset; index -= 1) result = (result << 8n) + BigInt(bytes[index]);
  return result;
}
function solanaPool(value) {
  const direct = value?.value ?? value;
  if (isRecord(direct) && (direct.sqrtPriceX64 !== undefined || direct.sqrt_price_x64 !== undefined)) return {
    owner: direct.owner ?? direct.programId,
    token0: direct.token0 ?? direct.token0Mint ?? direct.tokenMintA,
    token1: direct.token1 ?? direct.token1Mint ?? direct.tokenMintB,
    vault0Balance: direct.vault0Balance ?? direct.token0VaultBalance,
    vault1Balance: direct.vault1Balance ?? direct.token1VaultBalance,
    sqrtPriceX64: direct.sqrtPriceX64 ?? direct.sqrt_price_x64,
    slot: direct.slot ?? direct.context?.slot,
  };
  const bytes = asBuffer(value);
  if (!bytes || bytes.length < 96) throw new TokenRankingSourceError("invalid", "Solana pool account is unavailable");
  return { owner: value.owner, token0: bytes.subarray(0, 32), token1: bytes.subarray(32, 64), sqrtPriceX64: little(bytes, 64, 16), vault0Balance: little(bytes, 80, 8), vault1Balance: little(bytes, 88, 8), slot: value.context?.slot };
}
function exactSolanaPool(account, pubkey, dex) {
  const layoutName = dex.protocolId === "orca-whirlpools" ? "orca-whirlpool" : dex.protocolId;
  const layout = SOLANA_DISCOVERY_LAYOUTS[layoutName];
  if (!layout) throw new TokenRankingSourceError("unsupported", "Solana pool protocol layout is not reviewed");
  const value = account?.value ?? account;
  const bytes = asBuffer(value);
  const lamports = typeof value?.lamports === "string" && /^\d+$/u.test(value.lamports) ? BigInt(value.lamports) : value?.lamports;
  if (value?.executable === true || !Number.isSafeInteger(lamports) && typeof lamports !== "bigint" || typeof lamports === "number" && lamports <= 0 || typeof lamports === "bigint" && (lamports <= 0n || lamports > MAX_UINT64) || !bytes || bytes.length !== layout.dataSize || value?.owner !== dex.programAddress) throw new TokenRankingSourceError("invalid", "Solana pool identity is invalid");
  if (bytes.subarray(0, 8).toString("hex") !== layout.discriminator) throw new TokenRankingSourceError("invalid", "Solana pool discriminator is invalid");
  if (Number.isSafeInteger(layout.seedIndexOffset) && bytes.length >= layout.seedIndexOffset + 2 && bytes.readUInt16LE(layout.seedIndexOffset) !== 0) throw new TokenRankingSourceError("unsupported", "Solana pool seed index is unsupported");
  if (!verifySolanaPoolPda(pubkey, dex.programAddress, bytes, layout.pda)) throw new TokenRankingSourceError("invalid", "Solana pool PDA is invalid");
  const mints = layout.mintOffsets.map((offset) => solAddress(bytes.subarray(offset, offset + 32)));
  const vaults = layout.vaultOffsets.map((offset) => solAddress(bytes.subarray(offset, offset + 32)));
  const liquidityOffset = Number.isSafeInteger(layout.liquidityOffset) ? layout.liquidityOffset : layoutName === "orca-whirlpool" ? 49 : 237;
  const sqrtPriceOffset = Number.isSafeInteger(layout.sqrtPriceOffset) ? layout.sqrtPriceOffset : layoutName === "orca-whirlpool" ? 65 : 253;
  const statusOffset = Number.isSafeInteger(layout.statusOffset) ? layout.statusOffset : layoutName === "raydium-clmm" ? 389 : null;
  const swapDisabledMask = Number.isSafeInteger(layout.swapDisabledMask) ? layout.swapDisabledMask : 0;
  const liquidity = little(bytes, liquidityOffset, 16);
  const sqrtPriceX64 = little(bytes, sqrtPriceOffset, 16);
  if (statusOffset !== null && statusOffset < bytes.length && swapDisabledMask !== 0 && (bytes[statusOffset] & swapDisabledMask) !== 0) throw new TokenRankingSourceError("unpriced", "Solana pool swaps are disabled");
  if (liquidity === null || sqrtPriceX64 === null || liquidity <= 0n || sqrtPriceX64 <= 0n) throw new TokenRankingSourceError("unpriced", "Solana pool liquidity or price is empty");
  return { owner: value.owner, mints, vaults, liquidity, sqrtPriceX64, config: solAddress(bytes.subarray(layout.configOffset, layout.configOffset + 32)) };
}
function exactSolanaMint(account, expectedAddress) {
	try {
		const decoded = decodeSolanaMintAccount(expectedAddress, account, [TOKEN_PROGRAM_IDS.splToken, TOKEN_PROGRAM_IDS.splToken2022]);
		return { ...decoded, supply: qty(decoded.supply, "Solana mint supply", false, MAX_UINT64) };
	} catch {
		throw new TokenRankingSourceError("invalid", "Solana mint account is invalid");
	}
}
function exactSolanaVault(account, expectedMint, expectedAuthority, expectedProgram) {
	try {
		const decoded = decodeSolanaVaultAccount(account?.address ?? null, account, expectedMint, [TOKEN_PROGRAM_IDS.splToken, TOKEN_PROGRAM_IDS.splToken2022], expectedAuthority, expectedProgram);
		return { ...decoded, amount: qty(decoded.amount, "Solana vault amount", false, MAX_UINT64) };
	} catch {
		throw new TokenRankingSourceError("invalid", "Solana vault account is invalid");
	}
}
function solAddress(value) {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) return null;
  return encodeBase58(Buffer.from(value));
}
function solValue(supply, sqrt, token0) {
  const square = sqrt * sqrt;
  return token0 ? normalizeRational(supply * square, U128) : normalizeRational(supply * U128, square);
}
async function collectSolana(chainId, options, tokenCatalog, dexCatalog) {
  const transcript = options.__transcript ?? [];
  const source = sourceId(chainId, options);
  const deployments = deploymentMap(tokenCatalog);
  const assets = assetMap(tokenCatalog);
  const eligibleRows = tokenCatalog.deployments.filter((entry) => entry.chainId === chainId && eligible(entry, assets));
  const wrap = nativeWrap(dexCatalog, chainId);
  let start;
  try {
    const genesis = await rpc(options, "getGenesisHash", []);
    if (genesis !== SOLANA_MAINNET_GENESIS) throw new TokenRankingSourceError("invalid", "Solana genesis hash does not match mainnet");
  } catch (error) {
    const reason = error instanceof TokenRankingSourceError ? error.reason : "unavailable";
    return { candidates: [], unranked: eligibleRows.map((entry) => makeUnranked(chainId, entry.deploymentId, reason, source)), provenance: [provenance(source, "rpc", "original-rpc-facts", null)], transcript };
  }
  try { start = slotQty(await rpc(options, "getSlot", [{ commitment: "finalized" }]), "Solana slot"); } catch {
    return { candidates: [], unranked: eligibleRows.map((entry) => makeUnranked(chainId, entry.deploymentId, "unavailable", source)), provenance: [provenance(source, "rpc", "original-rpc-facts", null)], transcript };
  }
  const selected = new Map();
  const unranked = [];
  for (const pool of dexCatalog.poolDefinitions.filter((entry) => entry.chainId === chainId && entry.status === "active")) {
    const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
    if (!dex || !nativePool(pool, wrap)) continue;
    try {
      const poolResult = await rpc(options, "getMultipleAccounts", [[pool.address], { encoding: "base64", commitment: "finalized", minContextSlot: Number(start) }]);
      if (!isRecord(poolResult) || !isRecord(poolResult.context) || !Number.isSafeInteger(poolResult.context.slot) || BigInt(poolResult.context.slot) < start || !Array.isArray(poolResult.value) || poolResult.value.length !== 1 || !poolResult.value[0]) throw new TokenRankingSourceError("stale", "Solana pool context is below the anchor");
      const poolAccount = { ...poolResult.value[0], __pubkey: pool.address };
      const parsed = exactSolanaPool(poolAccount, pool.address, dex);
      const token0 = deployments.get(pool.token0DeploymentId);
      const token1 = deployments.get(pool.token1DeploymentId);
      if (!token0?.address || !token1?.address || parsed.mints[0] !== token0.address || parsed.mints[1] !== token1.address) throw new TokenRankingSourceError("invalid", "Solana pool orientation does not match catalog");
      if (!Number.isSafeInteger(poolResult.context.slot)) throw new TokenRankingSourceError("stale", "Solana pool context slot is invalid");
      const related = [...parsed.mints, ...parsed.vaults, parsed.config];
      const relatedResult = await rpc(options, "getMultipleAccounts", [related, { encoding: "base64", commitment: "finalized", minContextSlot: poolResult.context.slot }]);
      if (!isRecord(relatedResult) || !isRecord(relatedResult.context) || !Number.isSafeInteger(relatedResult.context.slot) || relatedResult.context.slot < poolResult.context.slot || !Array.isArray(relatedResult.value) || relatedResult.value.length !== 5 || relatedResult.value.some((entry) => !entry)) throw new TokenRankingSourceError("stale", "Solana related-account context is below the pool anchor");
      if (!Number.isSafeInteger(relatedResult.context.slot)) throw new TokenRankingSourceError("stale", "Solana related context slot is invalid");
		const mint0 = exactSolanaMint(relatedResult.value[0], token0.address);
		const mint1 = exactSolanaMint(relatedResult.value[1], token1.address);
		const vault0 = exactSolanaVault(relatedResult.value[2], parsed.mints[0], pool.address, mint0.owner);
		const vault1 = exactSolanaVault(relatedResult.value[3], parsed.mints[1], pool.address, mint1.owner);
		const configAccount = relatedResult.value[4];
		if (configAccount.owner !== dex.programAddress || !asBuffer(configAccount)?.length) throw new TokenRankingSourceError("invalid", "Solana pool config account is invalid");
		if (vault0.frozen || vault1.frozen) throw new TokenRankingSourceError("unpriced", "Solana pool vault is frozen");
		const sqrt = parsed.sqrtPriceX64;
      const balance0 = vault0.amount;
      const balance1 = vault1.amount;
      if (sqrt <= 0n || balance0 <= 0n || balance1 <= 0n || parsed.liquidity <= 0n) throw new TokenRankingSourceError("unpriced", "Solana pool liquidity is empty");
      const nativeIs0 = pool.token0DeploymentId === wrap.wrappedTokenDeploymentId;
      const id = nativeIs0 ? pool.token1DeploymentId : pool.token0DeploymentId;
      const candidate = { poolDefinitionId: pool.poolDefinitionId, nativeLiquidity: nativeIs0 ? balance0 : balance1, tokenReserve: nativeIs0 ? balance1 : balance0, sqrt, token0: !nativeIs0, observedAt: null, slot: relatedResult.context.slot, supply: nativeIs0 ? mint1.supply : mint0.supply, contextSlot: relatedResult.context.slot };
      const previous = selected.get(id);
      if (!previous || candidate.nativeLiquidity > previous.nativeLiquidity || candidate.nativeLiquidity === previous.nativeLiquidity && candidate.poolDefinitionId < previous.poolDefinitionId) selected.set(id, candidate);
    } catch (error) {
      const id = pool.token0DeploymentId === wrap?.wrappedTokenDeploymentId ? pool.token1DeploymentId : pool.token0DeploymentId;
      if (eligibleRows.some((entry) => entry.deploymentId === id)) unranked.push(makeUnranked(chainId, id, error instanceof TokenRankingSourceError ? error.reason : "unavailable", source));
    }
  }
  let end = null;
  try { end = slotQty(await rpc(options, "getSlot", [{ commitment: "finalized" }]), "Solana final slot"); } catch {
    for (const entry of eligibleRows) if (!unranked.some((row) => row.deploymentId === entry.deploymentId)) unranked.push(makeUnranked(chainId, entry.deploymentId, "stale", source));
  }
  const maxSpread = BigInt(options.config?.sources?.[chainId]?.maxSlotSpread ?? rankingConfig.sources[chainId]?.maxSlotSpread ?? 64);
  if (end === null || end < start || end - start > maxSpread) for (const entry of eligibleRows) if (!unranked.some((row) => row.deploymentId === entry.deploymentId)) unranked.push(makeUnranked(chainId, entry.deploymentId, "stale", source));
  if (end === null) return { candidates: [], unranked, provenance: [provenance(source, "rpc", "original-rpc-facts", null, { startSlot: start.toString() })], transcript };
  if ([...selected.values()].some((entry) => entry.contextSlot > Number(end))) {
    for (const entry of eligibleRows) if (!unranked.some((row) => row.deploymentId === entry.deploymentId)) unranked.push(makeUnranked(chainId, entry.deploymentId, "stale", source));
    return { candidates: [], unranked, provenance: [provenance(source, "rpc", "original-rpc-facts", null, { startSlot: start.toString(), endSlot: end.toString() })], transcript };
  }
  let fetchObservedAt = observed(options.observedAt, null);
  if (!fetchObservedAt) {
    try {
      const blockTime = await rpc(options, "getBlockTime", [Number(end)]);
      if (blockTime !== null && blockTime !== undefined) fetchObservedAt = observed(blockTime, null);
    } catch { /* A provider may omit historical block time; the explicit fetch clock remains evidence. */ }
  }
  if (!fetchObservedAt) fetchObservedAt = new Date(Number(now(options)) * 1000).toISOString().replace(".000Z", "Z");
  const minimum = BigInt(options.config?.sources?.[chainId]?.minNativeLiquidity ?? rankingConfig.sources[chainId]?.minNativeLiquidity);
  const candidates = [];
  for (const entry of eligibleRows) {
    const selectedPool = selected.get(entry.deploymentId);
    if (selectedPool) for (let index = unranked.length - 1; index >= 0; index -= 1) if (unranked[index].deploymentId === entry.deploymentId) unranked.splice(index, 1);
    if (unranked.some((row) => row.deploymentId === entry.deploymentId)) continue;
    if (!selectedPool) { unranked.push(makeUnranked(chainId, entry.deploymentId, "unpriced", source)); continue; }
    if (selectedPool.nativeLiquidity < minimum) { unranked.push(makeUnranked(chainId, entry.deploymentId, "below-min-native-liquidity", source, fetchObservedAt)); continue; }
    try {
      const supply = qty(selectedPool.supply, "Solana token supply", false, MAX_UINT64);
      if (supply <= 0n) throw new TokenRankingSourceError("unpriced", "Solana token supply is zero");
      const value = solValue(supply, selectedPool.sqrt, selectedPool.token0);
      candidates.push({ chainId, deploymentId: entry.deploymentId, valueNumerator: value.numerator, valueDenominator: value.denominator, observedAt: fetchObservedAt, sourceId: source, poolDefinitionId: selectedPool.poolDefinitionId });
    } catch (error) { unranked.push(makeUnranked(chainId, entry.deploymentId, error instanceof TokenRankingSourceError ? error.reason : "unavailable", source, fetchObservedAt)); }
  }
  return { candidates, unranked, provenance: [provenance(source, "rpc", "original-rpc-facts", fetchObservedAt, { startSlot: start.toString(), endSlot: end.toString() })], transcript };
}
function validateSourceSha(value) {
  if (value !== undefined && value !== null && (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value))) throw new TokenRankingValidationError("sourceSha must be a lowercase 40-character commit SHA");
}
function rawObserved(receipt, row) {
  return observed(row.observedAt ?? receipt.observedAt, null);
}
function validateRawReceipt(receipt, chainId, options, config) {
  if (!rawObserved(receipt, {})) throw new TokenRankingSourceError("invalid", "raw ranking receipt observedAt is missing");
  if (EVM_CHAINS.has(chainId)) {
    if (receipt.finality !== "finalized-eip1898") throw new TokenRankingSourceError("invalid", "raw EVM receipt is not finalized");
    if (typeof receipt.blockHash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(receipt.blockHash) || typeof receipt.finalBlockHash !== "string" || receipt.finalBlockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new TokenRankingSourceError("stale", "raw EVM receipt block hash is not coherent");
    qty(receipt.blockNumber, "raw block number");
    const blockTimestamp = qty(receipt.blockTimestamp, "raw block timestamp");
    if (options.observationAt !== undefined || options.now !== undefined || typeof options.clock === "function") {
      const maxAge = config.sources[chainId]?.finalizedMaxBlockAgeSeconds ?? config.freshness.maxBlockAgeSeconds;
      const referenceSeconds = options.observationAt !== undefined ? Math.floor(Date.parse(options.observationAt) / 1000) : now(options);
      const age = BigInt(referenceSeconds) - blockTimestamp;
      if (age < -BigInt(config.freshness.maxClockSkewSeconds) || age > BigInt(maxAge)) throw new TokenRankingSourceError("stale", "raw EVM receipt is outside the configured finalized age");
    }
  } else {
    if (!Number.isSafeInteger(receipt.contextSlot) || receipt.contextSlot < 0 || !Number.isSafeInteger(receipt.finalContextSlot) || receipt.finalContextSlot < receipt.contextSlot) throw new TokenRankingSourceError("stale", "raw Solana context slot is not coherent");
    const spread = receipt.finalContextSlot - receipt.contextSlot;
    const maxSpread = config.sources[chainId]?.maxSlotSpread ?? config.freshness.maxBlockLag;
    if (spread > maxSpread) throw new TokenRankingSourceError("stale", "raw Solana context spread exceeded");
  }
}
function successfulTranscript(receipt) {
  if (!Array.isArray(receipt.calls)) throw new TokenRankingSourceError("invalid", "ranking receipt has no bounded RPC transcript");
  const methods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "getGenesisHash", "getSlot", "getMultipleAccounts", "getBlockTime"]);
  for (const call of receipt.calls) {
    if (!isRecord(call) || !methods.has(call.method) || !Array.isArray(call.params) || (call.result === undefined) === (call.error === undefined)) throw new TokenRankingSourceError("invalid", "ranking transcript entry is malformed");
    if (call.error !== undefined && !isFixedRpcError(call.error)) throw new TokenRankingSourceError("invalid", "ranking transcript error code is not fixed and allowlisted");
    if (call.requestDigest !== undefined && call.requestDigest !== jsonDigest(call.params)) throw new TokenRankingSourceError("invalid", "ranking transcript request changed");
    if (call.result !== undefined && call.responseDigest !== undefined && call.responseDigest !== jsonDigest(call.result)) throw new TokenRankingSourceError("invalid", "ranking transcript response changed");
    if (call.error !== undefined && call.errorDigest !== undefined && call.errorDigest !== jsonDigest(call.error)) throw new TokenRankingSourceError("invalid", "ranking transcript error changed");
  }
  return receipt.calls.filter((call) => call.result !== undefined);
}
function sourceFailureReceipt(receipt) {
  if (receipt.status !== "partial" || !Array.isArray(receipt.calls) || receipt.calls.length === 0 || !receipt.calls.every((call) => isFixedRpcError(call?.error))) return false;
  const first = receipt.calls[0];
  const isEvmBootstrap = receipt.chainId && EVM_CHAINS.has(receipt.chainId) && first.method === "eth_chainId" && first.params?.length === 0;
  const isSolanaBootstrap = receipt.chainId === SOLANA_CHAIN && first.method === "getGenesisHash" && first.params?.length === 0;
  const noEvmAnchor = ["blockNumber", "blockTimestamp", "blockHash", "finalBlockHash", "latestBlockNumber", "latestBlockTimestamp", "latestBlockHash"].every((key) => receipt[key] === null);
  const noSolanaAnchor = receipt.contextSlot === null && receipt.finalContextSlot === null;
  return (isEvmBootstrap && noEvmAnchor || isSolanaBootstrap && noSolanaAnchor) && receipt.calls.every((call) => call.method === first.method && call.params?.length === 0);
}
function receiptErrorCalls(receipt) {
  return Array.isArray(receipt?.calls) ? receipt.calls.filter((call) => call?.error !== undefined) : [];
}
function transcriptReplayFailure(receipt, calls, tokenCatalog, dexCatalog, config, options) {
  if (!EVM_CHAINS.has(receipt.chainId)) return null;
  try {
    replayEvmTranscript(receipt, calls, tokenCatalog, dexCatalog, config, options);
    return null;
  } catch (error) {
    return error;
  }
}
function missingEvmRequestFailure(receipt, calls, replayError) {
  if (!EVM_CHAINS.has(receipt.chainId) || !(replayError instanceof TokenRankingSourceError)) return false;
  const errors = receiptErrorCalls(receipt);
  if (errors.length === 0) return false;
  if (replayError.message === "ranking EVM transcript lacks final anchor reads") {
    return errors.some((call) => call.method === "eth_getBlockByNumber" && (call.params?.[0] === "finalized" || typeof call.params?.[0] === "string" && /^0x[0-9a-f]+$/iu.test(call.params[0]))) && calls.filter((call) => call.method === "eth_getBlockByNumber").length < 3;
  }
  const missing = replayError.message.match(/^ranking transcript is missing (eth_getCode|eth_call)$/u)?.[1];
  return missing !== undefined && errors.some((call) => call.method === missing);
}
function missingSolanaRequestFailure(receipt, calls, replayError) {
  if (receipt.chainId !== SOLANA_CHAIN || !(replayError instanceof TokenRankingSourceError)) return false;
  const errors = receiptErrorCalls(receipt);
  if (errors.length === 0) return false;
  const exactFinalizedSlot = (call) => call.method === "getSlot" && JSON.stringify(call.params) === JSON.stringify([{ commitment: "finalized" }]);
  if (replayError.message === "ranking Solana slot requests are not finalized") return errors.some(exactFinalizedSlot) && calls.filter(exactFinalizedSlot).length < 2;
  if (replayError.message === "ranking Solana observation clock is not bound to getBlockTime") return errors.some((call) => call.method === "getBlockTime" && call.params?.length === 1 && Number.isSafeInteger(call.params[0]));
  if (replayError.message === "ranking Solana pool transcript is missing context") return errors.some((call) => call.method === "getMultipleAccounts" && call.params?.[0]?.length === 1 && call.params?.[1]?.encoding === "base64" && call.params?.[1]?.commitment === "finalized");
  if (replayError.message === "ranking Solana related transcript is missing context") return errors.some((call) => call.method === "getMultipleAccounts" && call.params?.[0]?.length === 5 && call.params?.[1]?.encoding === "base64" && call.params?.[1]?.commitment === "finalized");
  return false;
}
function evmPartialClaimsMatch(receipt, calls) {
  if (!EVM_CHAINS.has(receipt.chainId)) return false;
  const blockCalls = calls.filter((call) => call.method === "eth_getBlockByNumber");
  const anchorCall = blockCalls.find((call) => call.params[0] === "finalized");
  if (!anchorCall) return true;
  const latestCall = blockCalls.filter((call) => call.params[0] === "finalized").at(-1);
  try {
    const anchor = block(anchorCall.result);
    const latest = block(latestCall.result);
    const rereadCall = blockCalls.find((call) => typeof call.params[0] === "string" && /^0x[0-9a-f]+$/iu.test(call.params[0]));
    const reread = rereadCall ? block(rereadCall.result) : latest;
    if (!rereadCall && latest.hash !== anchor.hash) return false;
    return receipt.finality === "finalized-eip1898" && receipt.blockNumber === anchorCall.result.number && receipt.blockTimestamp === anchorCall.result.timestamp && receipt.blockHash?.toLowerCase() === anchor.hash && receipt.finalBlockHash?.toLowerCase() === reread.hash && receipt.latestBlockNumber === latestCall.result.number && receipt.latestBlockTimestamp === latestCall.result.timestamp && receipt.latestBlockHash?.toLowerCase() === latest.hash;
  } catch {
    return false;
  }
}
function evmStaleReason(receipt, calls, config, options) {
  if (!EVM_CHAINS.has(receipt.chainId)) return null;
  const blockCalls = calls.filter((call) => call.method === "eth_getBlockByNumber");
  const anchorCall = blockCalls.find((call) => call.params[0] === "finalized");
  const rereadCall = blockCalls.find((call) => typeof call.params[0] === "string" && /^0x[0-9a-f]+$/iu.test(call.params[0]));
  const latestCall = blockCalls.filter((call) => call.params[0] === "finalized").at(-1);
  if (!anchorCall || !rereadCall || !latestCall || blockCalls.length < 3) return null;
  let anchor;
  let latest;
  let reread;
  try {
    anchor = block(anchorCall.result);
    latest = block(latestCall.result);
    reread = block(rereadCall.result);
  } catch {
    return null;
  }
  if (String(rereadCall.params[0]).toLowerCase() !== "0x" + anchor.number.toString(16)) return null;
  if (receipt.finality !== "finalized-eip1898" || receipt.blockNumber !== anchorCall.result.number || receipt.blockTimestamp !== anchorCall.result.timestamp || receipt.blockHash?.toLowerCase() !== anchor.hash || receipt.finalBlockHash?.toLowerCase() !== reread.hash || receipt.latestBlockNumber !== latestCall.result.number || receipt.latestBlockTimestamp !== latestCall.result.timestamp || receipt.latestBlockHash?.toLowerCase() !== latest.hash) return null;
  try {
    fresh(anchor, latest, reread, { ...options, observationAt: options.observationAt }, receipt.chainId);
  } catch (error) {
    if (error instanceof TokenRankingSourceError && error.reason === "stale") return "stale";
  }
  return null;
}
function sourceFailureReason(receipt, calls, { config, options, replayError = null, validationError = null } = {}) {
  if (receipt.status !== "partial" || !Array.isArray(receipt.calls) || receipt.calls.length === 0) return null;
  if (!rawObserved(receipt, {})) return null;
  if (sourceFailureReceipt(receipt)) return "unavailable";
  const errors = receiptErrorCalls(receipt);
  if (errors.length > 0) {
    if (validationError !== null && EVM_CHAINS.has(receipt.chainId) && !evmPartialClaimsMatch(receipt, calls)) return null;
    return missingEvmRequestFailure(receipt, calls, replayError) || missingSolanaRequestFailure(receipt, calls, replayError) ? "unavailable" : null;
  }
  const stale = evmStaleReason(receipt, calls, config, options);
  if (stale !== null) return stale;
  return null;
}
function sourceUnrankedRows(receipt, tokenCatalog, reason) {
  const assets = assetMap(tokenCatalog);
  return tokenCatalog.deployments.filter((entry) => entry.chainId === receipt.chainId && eligible(entry, assets)).map((entry) => makeUnranked(receipt.chainId, entry.deploymentId, reason, receipt.sourceId, receipt.observedAt));
}
function verifiedNoPrice(unranked) {
  return unranked.length > 0 && unranked.every((entry) => VERIFIED_NO_PRICE_REASONS.has(entry.reason));
}
function verifiedDegraded(unranked) {
  return unranked.length > 0 && unranked.every((entry) => VERIFIED_NO_PRICE_REASONS.has(entry.reason) || entry.reason === "stale" || entry.reason === "unavailable");
}
function transcriptCall(calls, method, predicate) {
  const found = calls.find((call) => call.method === method && predicate(call.params, call.result));
  if (!found) throw new TokenRankingSourceError("unavailable", "ranking transcript is missing " + method);
  return found.result;
}
function evmTranscriptRow(receipt, calls, pool, dexCatalog, tokenCatalog, config, anchor) {
  const deployments = deploymentMap(tokenCatalog);
  const wrap = nativeWrap(dexCatalog, receipt.chainId);
  const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
  const token0 = deployments.get(pool.token0DeploymentId);
  const token1 = deployments.get(pool.token1DeploymentId);
  if (!dex || !token0?.address || !token1?.address || !nativePool(pool, wrap)) throw new TokenRankingSourceError("unsupported", "ranking pool is not a reviewed native pair");
  const tagMatches = (params) => isRecord(params?.[1]) && params[1].blockHash === anchor.hash && params[1].requireCanonical === true;
  const factoryCode = transcriptCall(calls, "eth_getCode", (params) => params[0]?.toLowerCase?.() === dex.programAddress.toLowerCase() && tagMatches(params));
  const poolCode = transcriptCall(calls, "eth_getCode", (params) => params[0]?.toLowerCase?.() === pool.address.toLowerCase() && tagMatches(params));
  if (data(factoryCode) === "0x" || data(poolCode) === "0x") throw new TokenRankingSourceError("invalid", "ranking factory or pool code is empty");
  const pairData = EVM_SELECTORS.factoryGetPair + addressArg(token0.address) + addressArg(token1.address);
  const pair = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === dex.programAddress.toLowerCase() && params[0]?.data?.toLowerCase?.() === pairData && tagMatches(params));
  const owner = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === pool.address.toLowerCase() && params[0]?.data?.toLowerCase?.() === EVM_SELECTORS.pairFactory && tagMatches(params));
  const readToken0 = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === pool.address.toLowerCase() && params[0]?.data?.toLowerCase?.() === EVM_SELECTORS.pairToken0 && tagMatches(params));
  const readToken1 = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === pool.address.toLowerCase() && params[0]?.data?.toLowerCase?.() === EVM_SELECTORS.pairToken1 && tagMatches(params));
  const reserve = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === pool.address.toLowerCase() && params[0]?.data?.toLowerCase?.() === EVM_SELECTORS.pairReserves && tagMatches(params));
  if (abiAddress(pair) !== pool.address.toLowerCase() || abiAddress(owner) !== dex.programAddress.toLowerCase() || abiAddress(readToken0) !== token0.address.toLowerCase() || abiAddress(readToken1) !== token1.address.toLowerCase()) throw new TokenRankingSourceError("invalid", "ranking EVM binding does not match catalog");
  const values = reserves(reserve);
  const nativeIs0 = pool.token0DeploymentId === wrap.wrappedTokenDeploymentId;
  const id = nativeIs0 ? pool.token1DeploymentId : pool.token0DeploymentId;
  const nativeLiquidity = nativeIs0 ? values.reserve0 : values.reserve1;
  const tokenReserve = nativeIs0 ? values.reserve1 : values.reserve0;
  if (nativeLiquidity <= 0n || tokenReserve <= 0n) throw new TokenRankingSourceError("unpriced", "ranking EVM liquidity is empty");
  const minimum = BigInt(config.sources[receipt.chainId]?.minNativeLiquidity);
  if (nativeLiquidity < minimum) throw new TokenRankingSourceError("below-min-native-liquidity", "ranking EVM liquidity is below the configured floor");
  const totalSupply = transcriptCall(calls, "eth_call", (params) => params[0]?.to?.toLowerCase?.() === deployments.get(id)?.address?.toLowerCase() && params[0]?.data?.toLowerCase?.() === EVM_SELECTORS.totalSupply && tagMatches(params));
  const supply = abiQty(totalSupply);
  if (supply <= 0n) throw new TokenRankingSourceError("unpriced", "ranking EVM supply is empty");
  const value = normalizeRational(supply * nativeLiquidity, tokenReserve);
  return { chainId: receipt.chainId, deploymentId: id, valueNumerator: value.numerator, valueDenominator: value.denominator, observedAt: receipt.observedAt, sourceId: receipt.sourceId, poolDefinitionId: pool.poolDefinitionId, nativeLiquidity };
}
function replayEvmTranscript(receipt, calls, tokenCatalog, dexCatalog, config, options) {
  const blockCalls = calls.filter((call) => call.method === "eth_getBlockByNumber");
  const anchorCall = blockCalls.find((call) => call.params[0] === "finalized");
  const rereadCall = blockCalls.find((call) => typeof call.params[0] === "string" && /^0x[0-9a-f]+$/iu.test(call.params[0]));
  if (!anchorCall || !rereadCall || blockCalls.length < 3) throw new TokenRankingSourceError("invalid", "ranking EVM transcript lacks final anchor reads");
  const anchorResult = anchorCall.result;
  const rereadResult = rereadCall.result;
  const anchor = block(anchorResult);
  const reread = block(rereadResult);
  if (String(rereadCall.params[0]).toLowerCase() !== "0x" + anchor.number.toString(16)) throw new TokenRankingSourceError("stale", "ranking EVM reread number differs from the anchor");
  const latestResult = blockCalls.filter((call) => call.params[0] === "finalized" && call.result !== undefined).at(-1)?.result;
  const latest = block(latestResult);
  if (receipt.latestBlockNumber === undefined || receipt.latestBlockNumber === null || receipt.latestBlockHash === undefined || receipt.latestBlockHash === null || receipt.latestBlockTimestamp === undefined || receipt.latestBlockTimestamp === null) throw new TokenRankingSourceError("invalid", "ranking receipt latest block binding is missing");
  if (receipt.latestBlockNumber !== latestResult.number) throw new TokenRankingSourceError("stale", "ranking receipt latest block number differs from its transcript");
  if (receipt.latestBlockHash.toLowerCase() !== latest.hash) throw new TokenRankingSourceError("stale", "ranking receipt latest block hash differs from its transcript");
  if (receipt.latestBlockTimestamp !== latestResult.timestamp) throw new TokenRankingSourceError("stale", "ranking receipt latest block timestamp differs from its transcript");
  fresh(anchor, latest, reread, { ...options, observationAt: options.observationAt }, receipt.chainId);
  if (receipt.blockHash?.toLowerCase() !== anchor.hash || receipt.finalBlockHash?.toLowerCase() !== reread.hash || receipt.blockNumber !== anchorResult.number || receipt.blockTimestamp !== anchorResult.timestamp) throw new TokenRankingSourceError("stale", "ranking receipt anchor differs from its transcript");
  const expectedNetwork = receipt.chainId === RANKING_CHAIN_IDS.ethereum ? "0x1" : "0xa86a";
  const networkCall = calls.find((call) => call.method === "eth_chainId");
  if (!networkCall || String(networkCall.result).toLowerCase() !== expectedNetwork) throw new TokenRankingSourceError("invalid", "ranking receipt network identity differs from its transcript");
  const best = new Map();
  const unranked = [];
  for (const pool of dexCatalog.poolDefinitions.filter((entry) => entry.chainId === receipt.chainId && entry.status === "active")) {
    try {
      const row = evmTranscriptRow(receipt, calls, pool, dexCatalog, tokenCatalog, config, anchor);
      const previous = best.get(row.deploymentId);
      if (!previous || row.nativeLiquidity > previous.nativeLiquidity || row.nativeLiquidity === previous.nativeLiquidity && row.poolDefinitionId < previous.poolDefinitionId) best.set(row.deploymentId, row);
    } catch (error) {
      const wrap = nativeWrap(dexCatalog, receipt.chainId);
      const id = pool.token0DeploymentId === wrap?.wrappedTokenDeploymentId ? pool.token1DeploymentId : pool.token0DeploymentId;
      if (id) unranked.push(makeUnranked(receipt.chainId, id, error instanceof TokenRankingSourceError ? error.reason : "unavailable", receipt.sourceId, receipt.observedAt));
    }
  }
  if (best.size === 0 && dexCatalog.poolDefinitions.some((entry) => entry.chainId === receipt.chainId && entry.status === "active" && nativePool(entry, nativeWrap(dexCatalog, receipt.chainId))) && !verifiedNoPrice(unranked) && !(receipt.calls.some((call) => call.error !== undefined) && verifiedDegraded(unranked))) throw new TokenRankingSourceError("invalid", "ranking EVM transcript contains no valid native pool");
  return { candidates: [...best.values()], unranked, provenance: [provenance(receipt.sourceId, "rpc", "original-rpc-facts", receipt.observedAt, { blockHash: anchor.hash })] };
}
function solanaTranscriptRow(receipt, calls, pool, dexCatalog, tokenCatalog, config) {
  const wrap = nativeWrap(dexCatalog, receipt.chainId);
  const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
  const deployments = deploymentMap(tokenCatalog);
  const token0 = deployments.get(pool.token0DeploymentId);
  const token1 = deployments.get(pool.token1DeploymentId);
  if (!dex || !token0?.address || !token1?.address || !nativePool(pool, wrap)) throw new TokenRankingSourceError("unsupported", "ranking Solana pool is not a reviewed native pair");
  const poolCall = calls.find((call) => call.method === "getMultipleAccounts" && Array.isArray(call.params[0]) && call.params[0].length === 1 && call.params[0][0] === pool.address && call.result !== undefined);
  if (poolCall && (!isRecord(poolCall.params[1]) || poolCall.params[1].encoding !== "base64" || poolCall.params[1].commitment !== "finalized" || !Number.isSafeInteger(poolCall.params[1].minContextSlot) || poolCall.params[1].minContextSlot < Number(receipt.contextSlot))) throw new TokenRankingSourceError("stale", "ranking Solana pool request is not anchored");
  if (!poolCall || !isRecord(poolCall.result) || !isRecord(poolCall.result.context) || !Number.isSafeInteger(poolCall.result.context.slot) || poolCall.result.context.slot < Number(receipt.contextSlot) || poolCall.result.context.slot > Number(receipt.finalContextSlot) || !Array.isArray(poolCall.result.value) || poolCall.result.value.length !== 1 || !poolCall.result.value[0]) throw new TokenRankingSourceError("stale", "ranking Solana pool transcript is missing context");
  const poolAccount = { ...poolCall.result.value[0], __pubkey: pool.address };
  const parsed = exactSolanaPool(poolAccount, pool.address, dex);
  if (parsed.mints[0] !== token0.address || parsed.mints[1] !== token1.address) throw new TokenRankingSourceError("invalid", "ranking Solana pool orientation differs from catalog");
  const related = [...parsed.mints, ...parsed.vaults, parsed.config];
  const relatedCall = calls.find((call) => call.method === "getMultipleAccounts" && JSON.stringify(call.params[0]) === JSON.stringify(related) && call.result !== undefined);
  if (relatedCall && (!isRecord(relatedCall.params[1]) || relatedCall.params[1].encoding !== "base64" || relatedCall.params[1].commitment !== "finalized" || !Number.isSafeInteger(relatedCall.params[1].minContextSlot) || relatedCall.params[1].minContextSlot < Number(poolCall.result.context.slot))) throw new TokenRankingSourceError("stale", "ranking Solana related request is not anchored");
  if (!relatedCall || !isRecord(relatedCall.result) || !isRecord(relatedCall.result.context) || !Number.isSafeInteger(relatedCall.result.context.slot) || relatedCall.result.context.slot < poolCall.result.context.slot || relatedCall.result.context.slot > Number(receipt.finalContextSlot) || !Array.isArray(relatedCall.result.value) || relatedCall.result.value.length !== 5 || relatedCall.result.value.some((entry) => !entry)) throw new TokenRankingSourceError("stale", "ranking Solana related transcript is missing context");
  if (!Number.isSafeInteger(poolCall.result.context.slot) || !Number.isSafeInteger(relatedCall.result.context.slot)) throw new TokenRankingSourceError("stale", "ranking Solana account context is invalid");
	const mint0 = exactSolanaMint(relatedCall.result.value[0], token0.address);
	const mint1 = exactSolanaMint(relatedCall.result.value[1], token1.address);
	const vault0 = exactSolanaVault(relatedCall.result.value[2], parsed.mints[0], pool.address, mint0.owner);
	const vault1 = exactSolanaVault(relatedCall.result.value[3], parsed.mints[1], pool.address, mint1.owner);
	if (vault0.frozen || vault1.frozen) throw new TokenRankingSourceError("unpriced", "ranking Solana pool vault is frozen");
	if (relatedCall.result.value[4].owner !== dex.programAddress || !asBuffer(relatedCall.result.value[4])?.length) throw new TokenRankingSourceError("invalid", "ranking Solana config account is invalid");
  const nativeIs0 = pool.token0DeploymentId === wrap.wrappedTokenDeploymentId;
  const id = nativeIs0 ? pool.token1DeploymentId : pool.token0DeploymentId;
  const nativeLiquidity = nativeIs0 ? vault0.amount : vault1.amount;
  const supply = nativeIs0 ? mint1.supply : mint0.supply;
  const minimum = BigInt(config.sources[receipt.chainId]?.minNativeLiquidity);
  if (nativeLiquidity < minimum) throw new TokenRankingSourceError("below-min-native-liquidity", "ranking Solana liquidity is below the configured floor");
  const value = solValue(supply, parsed.sqrtPriceX64, !nativeIs0);
  return { chainId: receipt.chainId, deploymentId: id, valueNumerator: value.numerator, valueDenominator: value.denominator, observedAt: receipt.observedAt, sourceId: receipt.sourceId, poolDefinitionId: pool.poolDefinitionId, nativeLiquidity };
}
function replaySolanaTranscript(receipt, calls, tokenCatalog, dexCatalog, config) {
  const genesis = calls.find((call) => call.method === "getGenesisHash");
  if (!genesis || JSON.stringify(genesis.params) !== "[]" || genesis.result !== SOLANA_MAINNET_GENESIS) throw new TokenRankingSourceError("invalid", "ranking Solana genesis identity is not proven");
  const slotCalls = calls.filter((call) => call.method === "getSlot");
  if (slotCalls.some((call) => JSON.stringify(call.params) !== JSON.stringify([{ commitment: "finalized" }])) || slotCalls.length < 2) throw new TokenRankingSourceError("invalid", "ranking Solana slot requests are not finalized");
  const slots = slotCalls.filter((call) => call.result !== undefined).map((call) => call.result);
  if (!slots.length || receipt.contextSlot !== slots[0] || receipt.finalContextSlot !== slots.at(-1)) throw new TokenRankingSourceError("stale", "ranking Solana slot transcript is incoherent");
  const blockTimeCall = calls.find((call) => call.method === "getBlockTime");
  if (!blockTimeCall || JSON.stringify(blockTimeCall.params) !== JSON.stringify([receipt.finalContextSlot]) || blockTimeCall.result !== undefined && observed(blockTimeCall.result, null) !== receipt.observedAt) throw new TokenRankingSourceError("invalid", "ranking Solana observation clock is not bound to getBlockTime");
  const best = new Map();
  const unranked = [];
  for (const pool of dexCatalog.poolDefinitions.filter((entry) => entry.chainId === receipt.chainId && entry.status === "active")) {
    try {
      const row = solanaTranscriptRow(receipt, calls, pool, dexCatalog, tokenCatalog, config);
      const previous = best.get(row.deploymentId);
      if (!previous || row.nativeLiquidity > previous.nativeLiquidity || row.nativeLiquidity === previous.nativeLiquidity && row.poolDefinitionId < previous.poolDefinitionId) best.set(row.deploymentId, row);
    } catch (error) {
      const wrap = nativeWrap(dexCatalog, receipt.chainId);
      const id = pool.token0DeploymentId === wrap?.wrappedTokenDeploymentId ? pool.token1DeploymentId : pool.token0DeploymentId;
      if (id) unranked.push(makeUnranked(receipt.chainId, id, error instanceof TokenRankingSourceError ? error.reason : "unavailable", receipt.sourceId, receipt.observedAt));
    }
  }
  if (best.size === 0 && dexCatalog.poolDefinitions.some((entry) => entry.chainId === receipt.chainId && entry.status === "active" && nativePool(entry, nativeWrap(dexCatalog, receipt.chainId))) && !verifiedNoPrice(unranked) && !(receipt.calls.some((call) => call.error !== undefined) && verifiedDegraded(unranked))) throw new TokenRankingSourceError("invalid", "ranking Solana transcript contains no valid native pool");
  return { candidates: [...best.values()], unranked, provenance: [provenance(receipt.sourceId, "rpc", "original-rpc-facts", receipt.observedAt, { contextSlot: receipt.finalContextSlot })] };
}
/**
 * Recompute rankings from raw RPC receipts. A receipt containing only a
 * precomputed value is rejected, so a promotion cannot trust derived numbers
 * from an untrusted source.
 */
export function replayRankings(rawReceipts, options = {}) {
  validateSourceSha(options.sourceSha ?? rawReceipts?.sourceSha);
  const config = options.config ?? rankingConfig;
  validateRankingConfig(config);
  const tokenCatalog = options.tokenCatalog ?? canonicalTokenCatalog;
  const dexCatalog = options.dexCatalog ?? canonicalDexCatalog;
  validateTokenCatalog(tokenCatalog);
  validateDexCatalog(dexCatalog, { tokenCatalog });
  if (!isRecord(rawReceipts) || rawReceipts.artifactKind !== "ranking-receipts") throw new TokenRankingValidationError("ranking receipts must use the ranking-receipts envelope");
  validateReceiptEnvelope(rawReceipts, { sourceSha: options.sourceSha, config, tokenCatalog, dexCatalog });
  if (options.sourceSha !== undefined && rawReceipts?.sourceSha !== undefined && rawReceipts.sourceSha !== options.sourceSha) throw new TokenRankingValidationError("ranking receipt source SHA does not match the requested source");
  const metric = options.metric ?? rawReceipts?.metric ?? "onchain-total-supply-value-native";
  if (!METRIC_SET.has(metric)) throw new TokenRankingValidationError("ranking receipt metric is invalid");
  const replayOptions = { ...options, observationAt: options.observationAt ?? rawReceipts.observedAt };
  const receipts = Array.isArray(rawReceipts) ? rawReceipts : rawReceipts?.receipts ?? rawReceipts?.observations ?? [];
  if (!Array.isArray(receipts)) throw new TokenRankingValidationError("raw ranking receipts must be an array");
  const aggregate = { candidates: [], unranked: [], provenance: [] };
  for (const receipt of receipts) {
    if (!isRecord(receipt)) continue;
    const chainId = receipt.chainId;
    if (!CHAIN_SET.has(chainId)) continue;
    const source = receipt.sourceId;
    if (typeof source !== "string" || !ID.test(source)) throw new TokenRankingValidationError("raw ranking receipt sourceId is invalid");
    const at = rawObserved(receipt, {});
    aggregate.provenance.push(provenance(source, "rpc", "original-rpc-facts", at, { sourceSha: options.sourceSha ?? rawReceipts?.sourceSha ?? null, blockHash: receipt.blockHash ?? null, contextSlot: receipt.contextSlot ?? null }));
    let successful;
    let validationError = null;
    try {
      validateRawReceipt(receipt, chainId, replayOptions, config);
    } catch (error) {
      validationError = error;
    }
    if (validationError !== null) {
      try { successful = successfulTranscript(receipt); } catch (transcriptError) { throw new TokenRankingValidationError("ranking receipt binding is invalid: " + (transcriptError?.message ?? transcriptError)); }
      const replayError = transcriptReplayFailure(receipt, successful, tokenCatalog, dexCatalog, config, replayOptions);
      const reason = sourceFailureReason(receipt, successful, { config, options: replayOptions, replayError, validationError });
      if (reason === null) throw new TokenRankingValidationError("ranking receipt binding is invalid: " + (validationError?.message ?? validationError));
      aggregate.unranked.push(...sourceUnrankedRows(receipt, tokenCatalog, reason));
      continue;
    }
    try { successful = successfulTranscript(receipt); } catch (error) { throw new TokenRankingValidationError("ranking transcript replay failed: " + (error?.message ?? error)); }
    if (Array.isArray(receipt.calls)) {
      try {
        const replayed = EVM_CHAINS.has(chainId) ? replayEvmTranscript(receipt, successful, tokenCatalog, dexCatalog, config, replayOptions) : replaySolanaTranscript(receipt, successful, tokenCatalog, dexCatalog, config);
        aggregate.candidates.push(...replayed.candidates);
        aggregate.unranked.push(...replayed.unranked);
        continue;
      } catch (error) {
        const reason = sourceFailureReason(receipt, successful, { config, options: replayOptions, replayError: error });
        if (reason === null) throw new TokenRankingValidationError("ranking transcript replay failed: " + (error?.message ?? error));
        aggregate.unranked.push(...sourceUnrankedRows(receipt, tokenCatalog, reason));
        continue;
      }
    }
    throw new TokenRankingValidationError("ranking receipt lacks original RPC transcript");
  }
  return replayTokenRankings(aggregate, { ...options, metric, tokenCatalog });
}
export async function collectGlobalMarketCaps(options, tokenCatalog = canonicalTokenCatalog) {
  const config = options.config?.globalCirculatingMarketCap ?? rankingConfig.globalCirculatingMarketCap;
  const provider = options.provider ?? options.globalProvider;
  const chains = options.chainId ? [options.chainId] : Object.values(RANKING_CHAIN_IDS);
  const eligibleRows = tokenCatalog.deployments.filter((entry) => chains.includes(entry.chainId) && eligible(entry, assetMap(tokenCatalog)));
  if (config.rights !== "licensed" || (!provider || typeof provider !== "function" && typeof provider.read !== "function")) {
    const source = config.sourceId ?? "global-provider-unconfigured";
    return replayTokenRankings({ candidates: [], unranked: eligibleRows.map((entry) => makeUnranked(entry.chainId, entry.deploymentId, "rights-denied", source)), provenance: [provenance(source, "licensed-global-provider", "unconfigured", null)] }, { ...options, metric: "global-circulating-market-cap-usd", tokenCatalog });
  }
  if (!Array.isArray(config.mappings) || config.mappings.length === 0) throw new TokenRankingSourceError("invalid", "global provider requires exact mappings");
  const deployments = deploymentMap(tokenCatalog);
  const candidates = [];
  const unranked = [];
  const source = config.sourceId ?? provider.sourceId ?? "licensed-global-provider";
  for (const mapping of config.mappings) {
    if (!isRecord(mapping) || typeof mapping.assetId !== "string" || !Array.isArray(mapping.deployments) || mapping.deployments.length === 0) throw new TokenRankingSourceError("invalid", "global mapping is invalid");
    const mappingRows = mapping.deployments.map((entry) => typeof entry === "string" ? { deploymentId: entry, address: null } : entry);
    if (mappingRows.some((entry) => !isRecord(entry) || typeof entry.deploymentId !== "string" || typeof entry.address !== "string")) throw new TokenRankingSourceError("invalid", "global mapping must include exact deployment addresses");
    const ids = mappingRows.map((entry) => entry.deploymentId).sort(compareText);
    if (new Set(ids).size !== ids.length || ids.some((id) => {
      const deployment = deployments.get(id);
      const suppliedAddress = mappingRows.find((entry) => entry.deploymentId === id).address;
      const expectedAddress = deployment?.chainId && EVM_CHAINS.has(deployment.chainId) ? deployment.address?.toLowerCase() : deployment?.address;
      return deployment?.assetId !== mapping.assetId || deployment?.chainId !== (mapping.chainId ?? deployment?.chainId) || expectedAddress !== (EVM_CHAINS.has(deployment?.chainId) ? suppliedAddress.toLowerCase() : suppliedAddress);
    })) throw new TokenRankingSourceError("invalid", "global mapping is not exact");
    try {
      const read = typeof provider === "function" ? provider : provider.read.bind(provider);
      const result = await read({ assetId: mapping.assetId, deployments: ids, chainId: mapping.chainId });
      const value = normalizeRational(result.valueNumerator, result.valueDenominator);
      const at = observed(result.observedAt, null);
      if (!at) throw new TokenRankingSourceError("invalid", "global provider timestamp is missing");
      for (const id of ids) candidates.push({ chainId: mapping.chainId ?? deployments.get(id).chainId, deploymentId: id, valueNumerator: value.numerator, valueDenominator: value.denominator, observedAt: at, sourceId: source, sourceAssetId: result.sourceAssetId ?? mapping.assetId, groupKey: mapping.assetId });
    } catch (error) {
      const reason = error instanceof TokenRankingSourceError ? error.reason : "unavailable";
      for (const id of ids) unranked.push(makeUnranked(mapping.chainId ?? deployments.get(id).chainId, id, reason, source));
    }
  }
  return replayTokenRankings({ candidates, unranked, provenance: [provenance(source, "licensed-global-provider", "licensed", candidates[0]?.observedAt ?? null, { mappings: config.mappings.length })] }, { ...options, metric: "global-circulating-market-cap-usd", tokenCatalog });
}
function normalizeCollectionOptions(options, context) {
  if (typeof options === "function" || options && typeof options.request === "function") options = { rpc: options };
  if (context !== undefined) options = { ...options, ...context };
  return isRecord(options) ? options : {};
}
export function computeRankingConfigDigest(config = rankingConfig) { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }
const configDigest = computeRankingConfigDigest;
function receiptAnchorFields(chainId, calls, runObservedAt) {
  const successful = calls.filter((entry) => entry.result !== undefined);
  if (EVM_CHAINS.has(chainId)) {
    const headers = successful.filter((entry) => entry.method === "eth_getBlockByNumber").map((entry) => entry.result).filter(isRecord);
    const anchor = headers[0];
    const reread = headers.at(-1) ?? anchor;
    const latest = headers.length > 1 ? headers.at(-2) : anchor;
    return { observedAt: observed(anchor?.timestamp, runObservedAt) ?? runObservedAt, finality: "finalized-eip1898", blockNumber: anchor?.number ?? null, blockTimestamp: anchor?.timestamp ?? null, blockHash: anchor?.hash ?? null, finalBlockHash: reread?.hash ?? null, latestBlockNumber: latest?.number ?? null, latestBlockTimestamp: latest?.timestamp ?? null, latestBlockHash: latest?.hash ?? null };
  }
  const slots = successful.filter((entry) => entry.method === "getSlot").map((entry) => entry.result).filter((entry) => Number.isSafeInteger(entry) || typeof entry === "string" && /^\\d+$/u.test(entry)).map((entry) => Number(entry));
  const blockTime = successful.find((entry) => entry.method === "getBlockTime")?.result;
  return { observedAt: observed(blockTime, runObservedAt) ?? runObservedAt, contextSlot: slots[0] ?? null, finalContextSlot: slots.at(-1) ?? null };
}
function buildRankingReceipt(chainId, source, calls, runObservedAt, status) {
  return { chainId, sourceId: source, observedAt: receiptAnchorFields(chainId, calls, runObservedAt).observedAt, ...receiptAnchorFields(chainId, calls, runObservedAt), calls, status };
}
function validateReceiptEnvelope(envelope, { sourceSha, config, tokenCatalog, dexCatalog } = {}) {
  exactKeys(envelope, RANKING_RECEIPT_KEYS, "ranking receipts");
  if (envelope.schemaVersion !== 1 || envelope.artifactKind !== "ranking-receipts") throw new TokenRankingValidationError("ranking receipt schema is invalid");
  validateSourceSha(envelope.sourceSha);
  if (sourceSha !== undefined && envelope.sourceSha !== sourceSha) throw new TokenRankingValidationError("ranking receipt source SHA does not match the requested source");
  if (typeof envelope.configDigest !== "string" || envelope.configDigest !== configDigest(config)) throw new TokenRankingValidationError("ranking receipt configuration digest is stale");
  if (typeof envelope.tokenCatalogDigest !== "string" || envelope.tokenCatalogDigest !== computeTokenCatalogDigest(tokenCatalog)) throw new TokenRankingValidationError("ranking receipt token catalog digest is stale");
  if (typeof envelope.dexCatalogDigest !== "string" || envelope.dexCatalogDigest !== computeDexCatalogDigest(dexCatalog)) throw new TokenRankingValidationError("ranking receipt DEX catalog digest is stale");
  if (!METRIC_SET.has(envelope.metric) || !STATUS_SET.has(envelope.status)) throw new TokenRankingValidationError("ranking receipt metric or status is invalid");
  timestamp(envelope.observedAt, "ranking receipts.observedAt");
  if (!Array.isArray(envelope.receipts)) throw new TokenRankingValidationError("ranking receipts.receipts must be an array");
  for (const receipt of envelope.receipts) {
    if (!isRecord(receipt) || !Array.isArray(receipt.calls)) continue;
    for (const call of receipt.calls) {
      if (call?.error !== undefined && !isFixedRpcError(call.error)) throw new TokenRankingValidationError("ranking transcript error code is not fixed and allowlisted");
    }
  }
  return true;
}
export function validateRankingReceipts(envelope, options = {}) {
  const config = options.config ?? rankingConfig;
  const tokenCatalog = options.tokenCatalog ?? canonicalTokenCatalog;
  const dexCatalog = options.dexCatalog ?? canonicalDexCatalog;
  validateRankingConfig(config);
  validateTokenCatalog(tokenCatalog);
  validateDexCatalog(dexCatalog, { tokenCatalog });
  return validateReceiptEnvelope(envelope, { ...options, config, tokenCatalog, dexCatalog });
}
export async function collectRankingReceipts(options = {}, context = undefined) {
  options = normalizeCollectionOptions(options, context);
  const metric = options.metric ?? options.config?.metric ?? rankingConfig.metric;
  if (!METRIC_SET.has(metric)) throw new TokenRankingValidationError("ranking metric is invalid");
  const tokenCatalog = options.tokenCatalog ?? canonicalTokenCatalog;
  const dexCatalog = options.dexCatalog ?? canonicalDexCatalog;
  const config = options.config ?? rankingConfig;
  validateTokenCatalog(tokenCatalog);
  validateDexCatalog(dexCatalog, { tokenCatalog });
  validateRankingConfig(config);
  validateSourceSha(options.sourceSha);
  const runObservedAt = new Date(Number(now(options)) * 1000).toISOString().replace(".000Z", "Z");
  const receipts = [];
  if (metric === "global-circulating-market-cap-usd") {
    const source = config.globalCirculatingMarketCap?.sourceId ?? "global-provider-unconfigured";
    const global = await collectGlobalMarketCaps(options, tokenCatalog);
    receipts.push({ chainId: options.chainId ?? RANKING_CHAIN_IDS.ethereum, sourceId: source, observedAt: runObservedAt, calls: [], status: global.metadata.status, candidates: global.records.map((entry) => ({ deploymentIds: entry.deploymentIds, valueNumerator: entry.valueNumerator, valueDenominator: entry.valueDenominator, sourceAssetId: entry.sourceAssetId })) });
  } else {
    const chains = options.chainId === undefined ? Object.values(RANKING_CHAIN_IDS) : [options.chainId];
    const boundedClient = options.rpcClient ?? makeBoundedClient(options);
    for (const chainId of chains) {
      const source = sourceId(chainId, options);
      const calls = [];
      const assets = assetMap(tokenCatalog);
      const eligibleRows = tokenCatalog.deployments.filter((entry) => entry.chainId === chainId && eligible(entry, assets));
      let result;
      if (!CHAIN_SET.has(chainId)) {
        result = { candidates: [], unranked: eligibleRows.map((entry) => makeUnranked(chainId, entry.deploymentId, "unsupported", source)), provenance: [] };
      } else {
        try {
          const chainOptions = { ...options, rpc: (method, params) => boundedClient(chainName(chainId), method, params), __transcript: calls };
          result = EVM_CHAINS.has(chainId) ? await collectEvm(chainId, chainOptions, tokenCatalog, dexCatalog) : await collectSolana(chainId, chainOptions, tokenCatalog, dexCatalog);
        } catch (error) {
          const reason = error instanceof TokenRankingSourceError ? error.reason : "unavailable";
          result = { candidates: [], unranked: eligibleRows.map((entry) => makeUnranked(chainId, entry.deploymentId, reason, source)), provenance: [] };
        }
      }
      const fields = buildRankingReceipt(chainId, source, calls, runObservedAt, result.unranked.some((entry) => entry.reason !== "excluded-native") ? "partial" : "complete");
      receipts.push(fields);
    }
  }
  const status = receipts.length === 0 ? "unconfigured" : receipts.some((entry) => entry.status === "partial") ? "partial" : "complete";
  const envelope = { schemaVersion: 1, artifactKind: "ranking-receipts", sourceSha: options.sourceSha ?? null, configDigest: configDigest(config), tokenCatalogDigest: computeTokenCatalogDigest(tokenCatalog), dexCatalogDigest: computeDexCatalogDigest(dexCatalog), observedAt: runObservedAt, metric, status, receipts };
  validateReceiptEnvelope(envelope, { sourceSha: options.sourceSha, config, tokenCatalog, dexCatalog });
  return deepFreeze(envelope);
}
export async function collectTokenRankings(options = {}, context = undefined) {
  options = normalizeCollectionOptions(options, context);
  const metric = options.metric ?? options.config?.metric ?? rankingConfig.metric;
  if (!METRIC_SET.has(metric)) throw new TokenRankingValidationError("ranking metric is invalid");
  const tokenCatalog = options.tokenCatalog ?? canonicalTokenCatalog;
  const dexCatalog = options.dexCatalog ?? canonicalDexCatalog;
  validateTokenCatalog(tokenCatalog);
  validateDexCatalog(dexCatalog, { tokenCatalog });
  if (options.snapshot !== undefined || options.observations !== undefined || options.candidates !== undefined) return replayTokenRankings(options.snapshot ?? { candidates: options.observations ?? options.candidates, unranked: options.unranked, provenance: options.provenance }, { ...options, metric, tokenCatalog });
  if (metric === "global-circulating-market-cap-usd") return collectGlobalMarketCaps(options, tokenCatalog);
  const raw = await collectRankingReceipts(options);
  return replayRankings(raw, { ...options, metric, tokenCatalog, dexCatalog, sourceSha: options.sourceSha });
}
export function listTokenRankings(chainId, artifact = RANKINGS) {
  if (typeof chainId !== "string" || !CHAIN_SET.has(chainId)) return Object.freeze([]);
  return Object.freeze(artifact.records.filter((row) => row.chainId === chainId).map((row) => deepFreeze(clone(row))));
}
export function dataModel(artifact = RANKINGS) { validateRankingArtifact(artifact); return deepFreeze({ metadata: clone(artifact.metadata), records: artifact.records.map(clone) }); }
export const RANKINGS = deepFreeze(canonicalArtifact);
export const TOKEN_RANKINGS = RANKINGS;
validateRankingArtifact(RANKINGS);
validateRankingConfig(rankingConfig);
export const METADATA = RANKINGS.metadata;
export const RECORDS = RANKINGS.records;
export const CONTENT_DIGEST = RANKINGS.metadata.contentDigest;
export const RANKING_CONFIG = deepFreeze(rankingConfig);
