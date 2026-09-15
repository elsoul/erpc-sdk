import { createHash } from "node:crypto";
import canonicalCatalog from "./dex-catalog.json" with { type: "json" };
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import { validateCatalog as validateTokenCatalog } from "./token-catalog.mjs";

export const DEX_CHAIN_IDS = Object.freeze({
  ethereum: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  avalancheC: "eip155:43114",
});

export const DEX_ALIASES = Object.freeze(["ethereum", "solana", "avalancheC"]);
const ALLOWED_CHAIN_IDS = new Set(Object.values(DEX_CHAIN_IDS));
const EVM_CHAINS = new Set([DEX_CHAIN_IDS.ethereum, DEX_CHAIN_IDS.avalancheC]);
const SOLANA_CHAIN = DEX_CHAIN_IDS.solana;
const STATUS_VALUES = new Set(["active", "legacy", "winding-down", "retired"]);
const SUPPORTED_QUOTE_ADAPTER = "evm-constant-product-v2";
const UINT256_MAX = (1n << 256n) - 1n;
const UINT112_MAX = (1n << 112n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT256_DECIMAL = /^[1-9][0-9]*$/u;
const NONNEGATIVE_DECIMAL = /^(0|[1-9][0-9]*)$/u;
const HEX_BYTES = /^0x[0-9a-fA-F]*$/u;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const CATALOG_KEYS = [
  "schemaVersion",
  "catalogVersion",
  "manualAsOf",
  "contentDigest",
  "dexDeployments",
  "poolDefinitions",
  "nativeWrapDefinitions",
  "aliases",
];
const DEX_KEYS = [
  "dexDeploymentId",
  "protocolId",
  "name",
  "chainId",
  "programAddress",
  "adapterKind",
  "status",
  "replacedByDexDeploymentId",
  "evidence",
  "asOfDate",
];
const POOL_KEYS = [
  "poolDefinitionId",
  "dexDeploymentId",
  "chainId",
  "address",
  "token0DeploymentId",
  "token1DeploymentId",
  "adapter",
  "status",
  "replacedByPoolDefinitionId",
  "evidence",
  "asOfDate",
];
const ADAPTER_KEYS = ["kind", "feeNumerator", "feeDenominator"];
const WRAP_KEYS = [
  "nativeWrapDefinitionId",
  "chainId",
  "nativeTokenDeploymentId",
  "wrappedTokenDeploymentId",
  "status",
  "evidence",
  "asOfDate",
];
const ALIAS_KEYS = ["namespace", "name", "dexDeploymentId", "poolDefinitionId", "evidence", "asOfDate"];
const RUNTIME_DEX_KEYS = [
  "dexDeploymentId",
  "protocolId",
  "name",
  "chainId",
  "programAddress",
  "adapterKind",
  "status",
  "replacedByDexDeploymentId",
];
const RUNTIME_POOL_KEYS = [
  "poolDefinitionId",
  "dexDeploymentId",
  "chainId",
  "address",
  "token0DeploymentId",
  "token1DeploymentId",
  "adapter",
  "status",
  "replacedByPoolDefinitionId",
];
const RUNTIME_WRAP_KEYS = [
  "nativeWrapDefinitionId",
  "chainId",
  "nativeTokenDeploymentId",
  "wrappedTokenDeploymentId",
  "status",
];
const RUNTIME_ALIAS_KEYS = ["namespace", "name", "dexDeploymentId", "poolDefinitionId"];

export const SWAP_ERROR_CODES = Object.freeze([
  "SWAP_INVALID_ARGUMENT",
  "SWAP_UNSUPPORTED_CHAIN",
  "SWAP_UNKNOWN_POOL",
  "SWAP_UNKNOWN_TOKEN",
  "SWAP_TOKEN_NOT_ACTIVE",
  "SWAP_UNSUPPORTED_TOKEN_STANDARD",
  "SWAP_UNSUPPORTED_ADAPTER",
  "SWAP_CHAIN_MISMATCH",
  "SWAP_POOL_TOKEN_MISMATCH",
  "SWAP_PROGRAM_MISMATCH",
  "SWAP_INVALID_POOL_STATE",
  "SWAP_STATE_STALE",
  "SWAP_INSUFFICIENT_LIQUIDITY",
  "SWAP_ARITHMETIC",
]);

export const SWAP_ERROR_MESSAGES = Object.freeze({
  SWAP_INVALID_ARGUMENT: "Swap request is invalid",
  SWAP_UNSUPPORTED_CHAIN: "Swap chain is unsupported",
  SWAP_UNKNOWN_POOL: "Swap pool is unknown",
  SWAP_UNKNOWN_TOKEN: "Swap token is unknown",
  SWAP_TOKEN_NOT_ACTIVE: "Swap token is not active",
  SWAP_UNSUPPORTED_TOKEN_STANDARD: "Swap token standard is unsupported",
  SWAP_UNSUPPORTED_ADAPTER: "Swap adapter is unsupported",
  SWAP_CHAIN_MISMATCH: "Swap chain does not match the selected records",
  SWAP_POOL_TOKEN_MISMATCH: "Swap pool tokens do not match the request",
  SWAP_PROGRAM_MISMATCH: "Swap program does not match the selected records",
  SWAP_INVALID_POOL_STATE: "Swap pool state is invalid",
  SWAP_STATE_STALE: "Swap pool state is stale",
  SWAP_INSUFFICIENT_LIQUIDITY: "Swap pool liquidity is insufficient",
  SWAP_ARITHMETIC: "Swap arithmetic overflowed or produced an invalid result",
});

export const DEFAULT_FRESHNESS = Object.freeze({
  maxBlockAgeSeconds: 120,
  maxBlockLag: 3,
  maxClockSkewSeconds: 5,
});

export class DexCatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DexCatalogValidationError";
  }
}

export class SwapQuoteError extends Error {
  constructor(code) {
    super(SWAP_ERROR_MESSAGES[code] ?? SWAP_ERROR_MESSAGES.SWAP_INVALID_ARGUMENT);
    this.name = "SwapQuoteError";
    this.code = code;
  }
}

function fail(message) {
  throw new DexCatalogValidationError(message);
}

function swapFail(code) {
  throw new SwapQuoteError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, { optional = [] } = {}) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value).sort();
  if (actual.some((key) => !allowed.has(key))) fail(`${label} has an unknown key`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`${label} is missing ${missing.join(", ")}`);
}

function exactOptionalKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} has an unknown key`);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\u0000]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`);
  }
}

function opaqueId(value, label) {
  nonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(`${label} must be an opaque identifier`);
}

function dateString(value, label) {
  nonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} must be a real calendar date`);
}

function semver(value, label) {
  nonEmptyString(value, label);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) {
    fail(`${label} must be semantic version text`);
  }
}

function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !/^https?:\/\/\S+$/u.test(entry))) {
    fail(`${label} must be a non-empty list of HTTP(S) URLs`);
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicate URLs`);
}

function decodeBase58(value) {
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (value[leadingZeroes] === "1") leadingZeroes += 1;
  for (let index = 0; index < leadingZeroes; index += 1) bytes.push(0);
  return bytes.reverse();
}

export function normalizeAddress(chainId, address) {
  if (typeof address !== "string") return null;
  if (EVM_CHAINS.has(chainId)) return address.toLowerCase();
  return address;
}

function validateAddress(chainId, address, label) {
  nonEmptyString(address, label);
  if (EVM_CHAINS.has(chainId)) {
    if (!EVM_ADDRESS.test(address)) fail(`${label} must be a lowercase 20-byte EVM address`);
    return;
  }
  if (chainId === SOLANA_CHAIN) {
    const decoded = decodeBase58(address);
    if (decoded === null || decoded.length !== 32) fail(`${label} must be a 32-byte Solana base58 address`);
    return;
  }
  fail(`${label} uses an unsupported chain`);
}

function tokenMap(catalog = tokenCatalog) {
  return new Map(catalog.deployments.map((deployment) => [deployment.deploymentId, deployment]));
}

function canonicalDex(deployment) {
  const {
    dexDeploymentId,
    protocolId,
    name,
    chainId,
    programAddress,
    adapterKind,
    status,
    replacedByDexDeploymentId,
  } = deployment;
  return { dexDeploymentId, protocolId, name, chainId, programAddress, adapterKind, status, replacedByDexDeploymentId };
}

function canonicalPool(pool) {
  const {
    poolDefinitionId,
    dexDeploymentId,
    chainId,
    address,
    token0DeploymentId,
    token1DeploymentId,
    adapter,
    status,
    replacedByPoolDefinitionId,
  } = pool;
  return {
    poolDefinitionId,
    dexDeploymentId,
    chainId,
    address,
    token0DeploymentId,
    token1DeploymentId,
    adapter: {
      kind: adapter.kind,
      feeNumerator: adapter.feeNumerator,
      feeDenominator: adapter.feeDenominator,
    },
    status,
    replacedByPoolDefinitionId,
  };
}

function canonicalWrap(wrap) {
  const {
    nativeWrapDefinitionId,
    chainId,
    nativeTokenDeploymentId,
    wrappedTokenDeploymentId,
    status,
  } = wrap;
  return { nativeWrapDefinitionId, chainId, nativeTokenDeploymentId, wrappedTokenDeploymentId, status };
}

function canonicalAlias(alias) {
  const { namespace, name, dexDeploymentId, poolDefinitionId } = alias;
  return { namespace, name, dexDeploymentId, poolDefinitionId };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedBy(records, key) {
  return [...records].sort((left, right) => compareText(key(left), key(right)));
}

export function canonicalProjection(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    manualAsOf: catalog.manualAsOf,
    dexDeployments: sortedBy(catalog.dexDeployments, (entry) => entry.dexDeploymentId).map(canonicalDex),
    poolDefinitions: sortedBy(catalog.poolDefinitions, (entry) => entry.poolDefinitionId).map(canonicalPool),
    nativeWrapDefinitions: sortedBy(catalog.nativeWrapDefinitions, (entry) => entry.nativeWrapDefinitionId).map(canonicalWrap),
    aliases: sortedBy(catalog.aliases, (entry) => `${entry.namespace}\u0000${entry.name}`).map(canonicalAlias),
  };
}

export function computeDigest(catalog) {
  return createHash("sha256").update(JSON.stringify(canonicalProjection(catalog))).digest("hex");
}

function assertReplacementGraph(records, idKey, replacementKey, byId, label) {
  const state = new Map();
  const visit = (id) => {
    const currentState = state.get(id) ?? 0;
    if (currentState === 1) fail(`${label} replacement cycle includes ${id}`);
    if (currentState === 2) return;
    state.set(id, 1);
    const record = byId.get(id);
    if (record?.[replacementKey] !== null) visit(record[replacementKey]);
    state.set(id, 2);
  };
  for (const record of records) visit(record[idKey]);
}

function assertSameDexIdentity(current, replacement) {
  if (!replacement || replacement.chainId !== current.chainId || replacement.protocolId !== current.protocolId) {
    fail(`DEX replacement ${current.dexDeploymentId} must stay on the same chain and protocol`);
  }
}

function assertSamePoolIdentity(current, replacement) {
  if (!replacement
    || replacement.chainId !== current.chainId
    || replacement.dexDeploymentId !== current.dexDeploymentId
    || replacement.token0DeploymentId !== current.token0DeploymentId
    || replacement.token1DeploymentId !== current.token1DeploymentId
    || JSON.stringify(replacement.adapter) !== JSON.stringify(current.adapter)) {
    fail(`pool replacement ${current.poolDefinitionId} must preserve its chain, pair, and adapter`);
  }
}

export function validateCatalog(catalog, { tokenCatalog: referencedTokenCatalog = tokenCatalog } = {}) {
  exactKeys(catalog, CATALOG_KEYS, "catalog");
  if (catalog.schemaVersion !== 1) fail("catalog.schemaVersion must be 1");
  semver(catalog.catalogVersion, "catalog.catalogVersion");
  dateString(catalog.manualAsOf, "catalog.manualAsOf");
  if (typeof catalog.contentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(catalog.contentDigest)) fail("catalog.contentDigest must be a lowercase SHA-256 digest");
  if (!Array.isArray(catalog.dexDeployments) || !Array.isArray(catalog.poolDefinitions) || !Array.isArray(catalog.nativeWrapDefinitions) || !Array.isArray(catalog.aliases)) {
    fail("catalog records must be arrays");
  }
  validateTokenCatalog(referencedTokenCatalog);
  const tokens = tokenMap(referencedTokenCatalog);
  const assets = new Map(referencedTokenCatalog.assets.map((asset) => [asset.assetId, asset]));

  const dexById = new Map();
  const dexBindings = new Set();
  for (const [index, dex] of catalog.dexDeployments.entries()) {
    exactKeys(dex, DEX_KEYS, `dexDeployments[${index}]`);
    opaqueId(dex.dexDeploymentId, `dexDeployments[${index}].dexDeploymentId`);
    if (dexById.has(dex.dexDeploymentId)) fail(`duplicate DEX deployment ID ${dex.dexDeploymentId}`);
    dexById.set(dex.dexDeploymentId, dex);
    opaqueId(dex.protocolId, `dexDeployments[${index}].protocolId`);
    nonEmptyString(dex.name, `dexDeployments[${index}].name`);
    if (!ALLOWED_CHAIN_IDS.has(dex.chainId)) fail(`dexDeployments[${index}].chainId is unsupported`);
    validateAddress(dex.chainId, dex.programAddress, `dexDeployments[${index}].programAddress`);
    if (dex.programAddress !== normalizeAddress(dex.chainId, dex.programAddress)) fail(`dexDeployments[${index}].programAddress is not normalized`);
    opaqueId(dex.adapterKind, `dexDeployments[${index}].adapterKind`);
    if (!STATUS_VALUES.has(dex.status)) fail(`dexDeployments[${index}].status is invalid`);
    if (dex.replacedByDexDeploymentId !== null) opaqueId(dex.replacedByDexDeploymentId, `dexDeployments[${index}].replacedByDexDeploymentId`);
    evidenceList(dex.evidence, `dexDeployments[${index}].evidence`);
    dateString(dex.asOfDate, `dexDeployments[${index}].asOfDate`);
    const binding = `${dex.chainId}\u0000${normalizeAddress(dex.chainId, dex.programAddress)}`;
    if (dexBindings.has(binding)) fail(`duplicate normalized DEX program binding ${binding}`);
    dexBindings.add(binding);
  }
  for (const [index, dex] of catalog.dexDeployments.entries()) {
    if (dex.replacedByDexDeploymentId !== null) {
      const replacement = dexById.get(dex.replacedByDexDeploymentId);
      if (!replacement) fail(`dexDeployments[${index}] replacement target is unknown`);
      if (replacement.dexDeploymentId === dex.dexDeploymentId) fail(`DEX deployment ${dex.dexDeploymentId} cannot replace itself`);
      assertSameDexIdentity(dex, replacement);
    }
  }
  assertReplacementGraph(catalog.dexDeployments, "dexDeploymentId", "replacedByDexDeploymentId", dexById, "DEX");

  const poolById = new Map();
  const poolBindings = new Set();
  for (const [index, pool] of catalog.poolDefinitions.entries()) {
    exactKeys(pool, POOL_KEYS, `poolDefinitions[${index}]`);
    opaqueId(pool.poolDefinitionId, `poolDefinitions[${index}].poolDefinitionId`);
    if (poolById.has(pool.poolDefinitionId)) fail(`duplicate pool definition ID ${pool.poolDefinitionId}`);
    poolById.set(pool.poolDefinitionId, pool);
    opaqueId(pool.dexDeploymentId, `poolDefinitions[${index}].dexDeploymentId`);
    const dex = dexById.get(pool.dexDeploymentId);
    if (!dex) fail(`poolDefinitions[${index}] references an unknown DEX deployment`);
    if (!ALLOWED_CHAIN_IDS.has(pool.chainId)) fail(`poolDefinitions[${index}].chainId is unsupported`);
    if (pool.chainId !== dex.chainId) fail(`poolDefinitions[${index}] chain does not match its DEX deployment`);
    validateAddress(pool.chainId, pool.address, `poolDefinitions[${index}].address`);
    if (pool.address !== normalizeAddress(pool.chainId, pool.address)) fail(`poolDefinitions[${index}].address is not normalized`);
    for (const [field, id] of [["token0DeploymentId", pool.token0DeploymentId], ["token1DeploymentId", pool.token1DeploymentId]]) {
      opaqueId(id, `poolDefinitions[${index}].${field}`);
      const token = tokens.get(id);
      if (!token) fail(`poolDefinitions[${index}] references an unknown token deployment`);
      if (token.chainId !== pool.chainId) fail(`poolDefinitions[${index}].${field} is on the wrong chain`);
      if (token.standard === "native") fail(`poolDefinitions[${index}].${field} must be a token contract or mint`);
    }
    if (pool.token0DeploymentId === pool.token1DeploymentId) fail(`poolDefinitions[${index}] must contain two distinct tokens`);
    exactKeys(pool.adapter, ADAPTER_KEYS, `poolDefinitions[${index}].adapter`);
    opaqueId(pool.adapter.kind, `poolDefinitions[${index}].adapter.kind`);
    if (pool.adapter.kind !== dex.adapterKind) fail(`poolDefinitions[${index}] adapter kind must match its DEX deployment`);
    for (const [field, value] of [["feeNumerator", pool.adapter.feeNumerator], ["feeDenominator", pool.adapter.feeDenominator]]) {
      if (value !== null && (typeof value !== "string" || !NONNEGATIVE_DECIMAL.test(value))) fail(`poolDefinitions[${index}].adapter.${field} must be a canonical decimal string or null`);
    }
    const evmFee = pool.adapter.kind === SUPPORTED_QUOTE_ADAPTER;
    if (evmFee && (pool.adapter.feeNumerator === null || pool.adapter.feeDenominator === null || BigInt(pool.adapter.feeNumerator) >= BigInt(pool.adapter.feeDenominator) || BigInt(pool.adapter.feeDenominator) === 0n)) {
      fail(`poolDefinitions[${index}] constant-product adapter must have a positive fee denominator greater than its numerator`);
    }
    if (!evmFee && (pool.adapter.feeNumerator !== null || pool.adapter.feeDenominator !== null)) fail(`poolDefinitions[${index}] unsupported adapter fee fields must be null`);
    if (!STATUS_VALUES.has(pool.status)) fail(`poolDefinitions[${index}].status is invalid`);
    if (pool.replacedByPoolDefinitionId !== null) opaqueId(pool.replacedByPoolDefinitionId, `poolDefinitions[${index}].replacedByPoolDefinitionId`);
    evidenceList(pool.evidence, `poolDefinitions[${index}].evidence`);
    dateString(pool.asOfDate, `poolDefinitions[${index}].asOfDate`);
    const binding = `${pool.chainId}\u0000${normalizeAddress(pool.chainId, pool.address)}`;
    if (poolBindings.has(binding)) fail(`duplicate normalized pool address binding ${binding}`);
    poolBindings.add(binding);
  }
  for (const [index, pool] of catalog.poolDefinitions.entries()) {
    if (pool.replacedByPoolDefinitionId !== null) {
      const replacement = poolById.get(pool.replacedByPoolDefinitionId);
      if (!replacement) fail(`poolDefinitions[${index}] replacement target is unknown`);
      if (replacement.poolDefinitionId === pool.poolDefinitionId) fail(`pool ${pool.poolDefinitionId} cannot replace itself`);
      assertSamePoolIdentity(pool, replacement);
    }
  }
  assertReplacementGraph(catalog.poolDefinitions, "poolDefinitionId", "replacedByPoolDefinitionId", poolById, "pool");

  const wrapById = new Map();
  const wrapBindings = new Set();
  const nativeWrapLookupKeys = new Set();
  for (const [index, wrap] of catalog.nativeWrapDefinitions.entries()) {
    exactKeys(wrap, WRAP_KEYS, `nativeWrapDefinitions[${index}]`);
    opaqueId(wrap.nativeWrapDefinitionId, `nativeWrapDefinitions[${index}].nativeWrapDefinitionId`);
    if (wrapById.has(wrap.nativeWrapDefinitionId)) fail(`duplicate native wrap definition ID ${wrap.nativeWrapDefinitionId}`);
    wrapById.set(wrap.nativeWrapDefinitionId, wrap);
    if (!ALLOWED_CHAIN_IDS.has(wrap.chainId)) fail(`nativeWrapDefinitions[${index}].chainId is unsupported`);
    for (const [field, id] of [["nativeTokenDeploymentId", wrap.nativeTokenDeploymentId], ["wrappedTokenDeploymentId", wrap.wrappedTokenDeploymentId]]) {
      opaqueId(id, `nativeWrapDefinitions[${index}].${field}`);
      if (!tokens.has(id)) fail(`nativeWrapDefinitions[${index}] references an unknown token deployment`);
      if (tokens.get(id).chainId !== wrap.chainId) fail(`nativeWrapDefinitions[${index}].${field} is on the wrong chain`);
    }
    if (wrap.nativeTokenDeploymentId === wrap.wrappedTokenDeploymentId) fail(`nativeWrapDefinitions[${index}] must contain two distinct tokens`);
    if (tokens.get(wrap.nativeTokenDeploymentId).standard !== "native") fail(`nativeWrapDefinitions[${index}] native side must use a native token deployment`);
    const nativeAsset = assets.get(tokens.get(wrap.nativeTokenDeploymentId).assetId);
    const wrappedAsset = assets.get(tokens.get(wrap.wrappedTokenDeploymentId).assetId);
    if (nativeAsset?.representationKind !== "native") fail(`nativeWrapDefinitions[${index}] native side must use a native asset`);
    if (tokens.get(wrap.wrappedTokenDeploymentId).standard === "native" || wrappedAsset?.representationKind !== "wrapped" || wrappedAsset.underlyingAssetId !== tokens.get(wrap.nativeTokenDeploymentId).assetId) {
      fail(`nativeWrapDefinitions[${index}] wrapped side must be the native asset's wrapped representation`);
    }
    if (!STATUS_VALUES.has(wrap.status)) fail(`nativeWrapDefinitions[${index}].status is invalid`);
    evidenceList(wrap.evidence, `nativeWrapDefinitions[${index}].evidence`);
    dateString(wrap.asOfDate, `nativeWrapDefinitions[${index}].asOfDate`);
    const binding = `${wrap.chainId}\u0000${wrap.nativeTokenDeploymentId}\u0000${wrap.wrappedTokenDeploymentId}`;
    if (wrapBindings.has(binding)) fail(`duplicate native wrap binding ${binding}`);
    wrapBindings.add(binding);
    const nativeLookupKey = `${wrap.chainId}\u0000${wrap.nativeTokenDeploymentId}`;
    if (nativeWrapLookupKeys.has(nativeLookupKey)) fail(`duplicate native wrap native-token binding ${nativeLookupKey}`);
    nativeWrapLookupKeys.add(nativeLookupKey);
  }
  for (const wrap of catalog.nativeWrapDefinitions) {
    if (!wrapById.has(wrap.nativeWrapDefinitionId)) fail(`native wrap ID ${wrap.nativeWrapDefinitionId} is unavailable`);
  }

  const aliasesByKey = new Map();
  for (const [index, alias] of catalog.aliases.entries()) {
    exactKeys(alias, ALIAS_KEYS, `aliases[${index}]`);
    if (!Object.hasOwn(DEX_CHAIN_IDS, alias.namespace)) fail(`aliases[${index}].namespace must be ethereum, solana, or avalancheC`);
    nonEmptyString(alias.name, `aliases[${index}].name`);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(alias.name)) fail(`aliases[${index}].name must be uppercase ASCII with optional underscores`);
    const hasDex = alias.dexDeploymentId !== null;
    const hasPool = alias.poolDefinitionId !== null;
    if (hasDex === hasPool) fail(`aliases[${index}] must target exactly one DEX or pool ID`);
    if (hasDex) {
      opaqueId(alias.dexDeploymentId, `aliases[${index}].dexDeploymentId`);
      const dex = dexById.get(alias.dexDeploymentId);
      if (!dex) fail(`aliases[${index}] references an unknown DEX deployment`);
      if (dex.chainId !== DEX_CHAIN_IDS[alias.namespace]) fail(`aliases[${index}] namespace does not match its DEX chain`);
    }
    if (hasPool) {
      opaqueId(alias.poolDefinitionId, `aliases[${index}].poolDefinitionId`);
      const pool = poolById.get(alias.poolDefinitionId);
      if (!pool) fail(`aliases[${index}] references an unknown pool definition`);
      if (pool.chainId !== DEX_CHAIN_IDS[alias.namespace]) fail(`aliases[${index}] namespace does not match its pool chain`);
    }
    evidenceList(alias.evidence, `aliases[${index}].evidence`);
    dateString(alias.asOfDate, `aliases[${index}].asOfDate`);
    const key = `${alias.namespace}\u0000${alias.name}`;
    if (aliasesByKey.has(key)) fail(`duplicate alias ${alias.namespace}:${alias.name}`);
    aliasesByKey.set(key, alias);
  }

  const expectedDigest = computeDigest(catalog);
  if (catalog.contentDigest !== expectedDigest) fail(`catalog.contentDigest does not match canonical projection (expected ${expectedDigest})`);
  return true;
}

export function compareHistory(current, previous) {
  validateCatalog(previous);
  validateCatalog(current);
  const currentDexes = new Map(current.dexDeployments.map((entry) => [entry.dexDeploymentId, entry]));
  const currentPools = new Map(current.poolDefinitions.map((entry) => [entry.poolDefinitionId, entry]));
  const currentWraps = new Map(current.nativeWrapDefinitions.map((entry) => [entry.nativeWrapDefinitionId, entry]));
  const currentAliases = new Map(current.aliases.map((entry) => [`${entry.namespace}\u0000${entry.name}`, entry]));
  for (const dex of previous.dexDeployments) {
    const next = currentDexes.get(dex.dexDeploymentId);
    if (!next) fail(`historical DEX deployment ID removed: ${dex.dexDeploymentId}`);
    const nextIdentity = { protocolId: next.protocolId, name: next.name, chainId: next.chainId, programAddress: next.programAddress, adapterKind: next.adapterKind };
    const previousIdentity = { protocolId: dex.protocolId, name: dex.name, chainId: dex.chainId, programAddress: dex.programAddress, adapterKind: dex.adapterKind };
    if (JSON.stringify(nextIdentity) !== JSON.stringify(previousIdentity)) fail(`historical DEX deployment identity changed: ${dex.dexDeploymentId}`);
  }
  for (const pool of previous.poolDefinitions) {
    const next = currentPools.get(pool.poolDefinitionId);
    if (!next) fail(`historical pool definition ID removed: ${pool.poolDefinitionId}`);
    const nextIdentity = { dexDeploymentId: next.dexDeploymentId, chainId: next.chainId, address: next.address, token0DeploymentId: next.token0DeploymentId, token1DeploymentId: next.token1DeploymentId, adapter: next.adapter };
    const previousIdentity = { dexDeploymentId: pool.dexDeploymentId, chainId: pool.chainId, address: pool.address, token0DeploymentId: pool.token0DeploymentId, token1DeploymentId: pool.token1DeploymentId, adapter: pool.adapter };
    if (JSON.stringify(nextIdentity) !== JSON.stringify(previousIdentity)) fail(`historical pool definition identity changed: ${pool.poolDefinitionId}`);
  }
  for (const wrap of previous.nativeWrapDefinitions) {
    const next = currentWraps.get(wrap.nativeWrapDefinitionId);
    if (!next) fail(`historical native wrap definition ID removed: ${wrap.nativeWrapDefinitionId}`);
    const nextIdentity = { chainId: next.chainId, nativeTokenDeploymentId: next.nativeTokenDeploymentId, wrappedTokenDeploymentId: next.wrappedTokenDeploymentId };
    const previousIdentity = { chainId: wrap.chainId, nativeTokenDeploymentId: wrap.nativeTokenDeploymentId, wrappedTokenDeploymentId: wrap.wrappedTokenDeploymentId };
    if (JSON.stringify(nextIdentity) !== JSON.stringify(previousIdentity)) fail(`historical native wrap identity changed: ${wrap.nativeWrapDefinitionId}`);
  }
  for (const alias of previous.aliases) {
    const next = currentAliases.get(`${alias.namespace}\u0000${alias.name}`);
    if (!next) fail(`historical alias removed: ${alias.namespace}:${alias.name}`);
    if (JSON.stringify(canonicalAlias(next)) !== JSON.stringify(canonicalAlias(alias))) fail(`historical alias retargeted: ${alias.namespace}:${alias.name}`);
  }
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function runtimeDex(dex) {
  return {
    dexDeploymentId: dex.dexDeploymentId,
    protocolId: dex.protocolId,
    name: dex.name,
    chainId: dex.chainId,
    programAddress: dex.programAddress,
    adapterKind: dex.adapterKind,
    status: dex.status,
    replacedByDexDeploymentId: dex.replacedByDexDeploymentId,
  };
}

function runtimePool(pool) {
  return {
    poolDefinitionId: pool.poolDefinitionId,
    dexDeploymentId: pool.dexDeploymentId,
    chainId: pool.chainId,
    address: pool.address,
    token0DeploymentId: pool.token0DeploymentId,
    token1DeploymentId: pool.token1DeploymentId,
    adapter: {
      kind: pool.adapter.kind,
      feeNumerator: pool.adapter.feeNumerator,
      feeDenominator: pool.adapter.feeDenominator,
    },
    status: pool.status,
    replacedByPoolDefinitionId: pool.replacedByPoolDefinitionId,
  };
}

function runtimeWrap(wrap) {
  return {
    nativeWrapDefinitionId: wrap.nativeWrapDefinitionId,
    chainId: wrap.chainId,
    nativeTokenDeploymentId: wrap.nativeTokenDeploymentId,
    wrappedTokenDeploymentId: wrap.wrappedTokenDeploymentId,
    status: wrap.status,
  };
}

function runtimeAlias(alias) {
  return {
    namespace: alias.namespace,
    name: alias.name,
    dexDeploymentId: alias.dexDeploymentId,
    poolDefinitionId: alias.poolDefinitionId,
  };
}

export function dataModel(catalog = CATALOG) {
  validateCatalog(catalog);
  return {
    version: catalog.catalogVersion,
    asOfDate: catalog.manualAsOf,
    contentDigest: catalog.contentDigest,
    chainIds: { ...DEX_CHAIN_IDS },
    dexDeployments: sortedBy(catalog.dexDeployments, (entry) => entry.dexDeploymentId).map(runtimeDex),
    poolDefinitions: sortedBy(catalog.poolDefinitions, (entry) => entry.poolDefinitionId).map(runtimePool),
    nativeWrapDefinitions: sortedBy(catalog.nativeWrapDefinitions, (entry) => entry.nativeWrapDefinitionId).map(runtimeWrap),
    aliases: sortedBy(catalog.aliases, (entry) => `${entry.namespace}\u0000${entry.name}`).map(runtimeAlias),
  };
}

function frozenRuntime(value) {
  return deepFreeze(value);
}

export function getDexDeployment(dexDeploymentId) {
  const dex = CATALOG.dexDeployments.find((entry) => entry.dexDeploymentId === dexDeploymentId);
  return dex ? frozenRuntime(runtimeDex(dex)) : null;
}

export function getPoolDefinition(poolDefinitionId) {
  const pool = CATALOG.poolDefinitions.find((entry) => entry.poolDefinitionId === poolDefinitionId);
  return pool ? frozenRuntime(runtimePool(pool)) : null;
}

export function findPoolDefinitionByAddress(chainId, address) {
  if (!ALLOWED_CHAIN_IDS.has(chainId) || typeof address !== "string") return null;
  const normalized = normalizeAddress(chainId, address);
  const pool = CATALOG.poolDefinitions.find((entry) => entry.chainId === chainId && entry.address === normalized);
  return pool ? frozenRuntime(runtimePool(pool)) : null;
}

export function findPoolDefinitionsByPair(chainId, tokenA, tokenB) {
  if (typeof chainId !== "string" || typeof tokenA !== "string" || typeof tokenB !== "string" || !ALLOWED_CHAIN_IDS.has(chainId)) return Object.freeze([]);
  if (typeof tokenA !== "string" || typeof tokenB !== "string" || tokenA === tokenB) return Object.freeze([]);
  const wanted = [tokenA, tokenB].sort(compareText).join("\u0000");
  const found = CATALOG.poolDefinitions
    .filter((pool) => (chainId === undefined || pool.chainId === chainId)
      && [pool.token0DeploymentId, pool.token1DeploymentId].sort(compareText).join("\u0000") === wanted)
    .sort((left, right) => compareText(left.poolDefinitionId, right.poolDefinitionId))
    .map(runtimePool)
    .map(frozenRuntime);
  return Object.freeze(found);
}

export function listPoolDefinitions({ chainId, tokenDeploymentId, adapterKind } = {}) {
  const found = CATALOG.poolDefinitions
    .filter((pool) => (chainId === undefined || pool.chainId === chainId)
      && (tokenDeploymentId === undefined || pool.token0DeploymentId === tokenDeploymentId || pool.token1DeploymentId === tokenDeploymentId)
      && (adapterKind === undefined || pool.adapter.kind === adapterKind))
    .sort((left, right) => compareText(left.poolDefinitionId, right.poolDefinitionId))
    .map(runtimePool)
    .map(frozenRuntime);
  return Object.freeze(found);
}

export function getNativeWrapDefinition(nativeTokenDeploymentId) {
  const wrap = CATALOG.nativeWrapDefinitions.find((entry) => entry.nativeTokenDeploymentId === nativeTokenDeploymentId);
  return wrap ? frozenRuntime(runtimeWrap(wrap)) : null;
}

export function resolveDexAlias(namespace, name) {
  const alias = CATALOG.aliases.find((entry) => entry.namespace === namespace && entry.name === name && entry.dexDeploymentId !== null);
  return alias ? getDexDeployment(alias.dexDeploymentId) : null;
}

export function resolvePoolAlias(namespace, name) {
  const alias = CATALOG.aliases.find((entry) => entry.namespace === namespace && entry.name === name && entry.poolDefinitionId !== null);
  return alias ? getPoolDefinition(alias.poolDefinitionId) : null;
}

function tokenDeployment(id) {
  return tokenCatalog.deployments.find((entry) => entry.deploymentId === id) ?? null;
}

function assertRequestKeys(request) {
  if (!isRecord(request)) swapFail("SWAP_INVALID_ARGUMENT");
  const allowed = new Set(["chainId", "poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId", "amountIn", "freshness"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) swapFail("SWAP_INVALID_ARGUMENT");
  for (const key of ["chainId", "poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId", "amountIn"]) {
    if (typeof request[key] !== "string" || request[key].trim() !== request[key] || request[key].length === 0) swapFail("SWAP_INVALID_ARGUMENT");
  }
  for (const key of ["poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId"]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(request[key])) swapFail("SWAP_INVALID_ARGUMENT");
  }
}

function normalizeFreshness(value) {
  if (value === undefined) return { ...DEFAULT_FRESHNESS };
  if (!isRecord(value)) swapFail("SWAP_INVALID_ARGUMENT");
  const keys = ["maxBlockAgeSeconds", "maxBlockLag", "maxClockSkewSeconds"];
  if (Object.keys(value).some((key) => !keys.includes(key))) swapFail("SWAP_INVALID_ARGUMENT");
  const ranges = { maxBlockAgeSeconds: [0, 86400], maxBlockLag: [0, 1024], maxClockSkewSeconds: [0, 300] };
  const output = {};
  for (const key of keys) {
    const current = Object.hasOwn(value, key) ? value[key] : DEFAULT_FRESHNESS[key];
    const [minimum, maximum] = ranges[key];
    if (!Number.isSafeInteger(current) || current < minimum || current > maximum) swapFail("SWAP_INVALID_ARGUMENT");
    output[key] = current;
  }
  return output;
}

function normalizeQuoteRequest(request) {
  assertRequestKeys(request);
  const freshness = normalizeFreshness(request.freshness);
  if (request.amountIn.length > 78 || !UINT256_DECIMAL.test(request.amountIn)) swapFail("SWAP_INVALID_ARGUMENT");
  let amountIn;
  try { amountIn = BigInt(request.amountIn); } catch { swapFail("SWAP_INVALID_ARGUMENT"); }
  if (amountIn <= 0n || amountIn > UINT256_MAX) swapFail("SWAP_INVALID_ARGUMENT");
  if (!ALLOWED_CHAIN_IDS.has(request.chainId)) swapFail("SWAP_UNSUPPORTED_CHAIN");
  const pool = CATALOG.poolDefinitions.find((entry) => entry.poolDefinitionId === request.poolDefinitionId);
  if (!pool) swapFail("SWAP_UNKNOWN_POOL");
  if (pool.chainId !== request.chainId) swapFail("SWAP_CHAIN_MISMATCH");
  if (pool.status !== "active") swapFail("SWAP_INVALID_POOL_STATE");
  const dex = CATALOG.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
  if (!dex || dex.status !== "active") swapFail("SWAP_INVALID_POOL_STATE");
  const input = tokenDeployment(request.inputTokenDeploymentId);
  if (!input) swapFail("SWAP_UNKNOWN_TOKEN");
  const output = tokenDeployment(request.outputTokenDeploymentId);
  if (!output) swapFail("SWAP_UNKNOWN_TOKEN");
  if (input.chainId !== request.chainId || output.chainId !== request.chainId) swapFail("SWAP_CHAIN_MISMATCH");
  for (const token of [input, output]) if (token.status !== "active") swapFail("SWAP_TOKEN_NOT_ACTIVE");
  // Classic SPL records are valid catalog records but have no quote adapter
  // in this stage. Keep them through pair matching so they deterministically
  // report SWAP_UNSUPPORTED_ADAPTER; native and Token-2022 inputs fail at the
  // standard gate before any address or pool adapter work.
  for (const token of [input, output]) if (token.standard !== "erc20" && token.standard !== "spl-token") swapFail("SWAP_UNSUPPORTED_TOKEN_STANDARD");
  if (request.inputTokenDeploymentId === request.outputTokenDeploymentId) swapFail("SWAP_POOL_TOKEN_MISMATCH");
  const wanted = [request.inputTokenDeploymentId, request.outputTokenDeploymentId].sort(compareText).join("\u0000");
  const actual = [pool.token0DeploymentId, pool.token1DeploymentId].sort(compareText).join("\u0000");
  if (wanted !== actual) swapFail("SWAP_POOL_TOKEN_MISMATCH");
  if (pool.adapter.kind !== SUPPORTED_QUOTE_ADAPTER || dex.adapterKind !== SUPPORTED_QUOTE_ADAPTER) swapFail("SWAP_UNSUPPORTED_ADAPTER");
  if (input.standard !== "erc20" || output.standard !== "erc20") swapFail("SWAP_UNSUPPORTED_TOKEN_STANDARD");
  const requestSnapshot = Object.freeze({
    chainId: request.chainId,
    poolDefinitionId: request.poolDefinitionId,
    inputTokenDeploymentId: request.inputTokenDeploymentId,
    outputTokenDeploymentId: request.outputTokenDeploymentId,
    amountIn: request.amountIn,
    freshness: Object.freeze({ ...freshness }),
  });
  return {
    request: requestSnapshot,
    pool,
    dex,
    input,
    output,
    amountIn,
    freshness: requestSnapshot.freshness,
  };
}

function ensureUint256(value, code = "SWAP_ARITHMETIC") {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) swapFail(code);
  return value;
}

function decimal(value, code = "SWAP_INVALID_POOL_STATE") {
  if (typeof value === "bigint") return ensureUint256(value, code).toString(10);
  if (typeof value !== "string" || value.length > 78 || !NONNEGATIVE_DECIMAL.test(value)) swapFail(code);
  let parsed;
  try { parsed = BigInt(value); } catch { swapFail(code); }
  return ensureUint256(parsed, code).toString(10);
}

function hexQuantity(value, code = "SWAP_INVALID_POOL_STATE") {
  if (typeof value !== "string" || value.length > 66 || !HEX_QUANTITY.test(value)) swapFail(code);
  let parsed;
  try { parsed = BigInt(value); } catch { swapFail(code); }
  return ensureUint256(parsed, code);
}

function quantityValue(value, code = "SWAP_INVALID_POOL_STATE") {
  if (typeof value === "string" && value.startsWith("0x")) return hexQuantity(value, code);
  if (typeof value === "string" && value.length <= 78 && NONNEGATIVE_DECIMAL.test(value)) {
    try { return ensureUint256(BigInt(value), code); } catch (error) {
      if (error instanceof SwapQuoteError) throw error;
    }
  }
  swapFail(code);
}

function hexBytes(value, expectedBytes, code = "SWAP_INVALID_POOL_STATE") {
  if (typeof value !== "string" || !HEX_BYTES.test(value) || value.length % 2 !== 0 || (expectedBytes !== undefined && value.length !== expectedBytes * 2 + 2)) swapFail(code);
  return value.toLowerCase();
}

function addressWord(value) {
  const bytes = hexBytes(value, 32);
  const word = bytes.slice(2);
  if (!/^0{24}[0-9a-f]{40}$/u.test(word)) swapFail("SWAP_INVALID_POOL_STATE");
  return `0x${word.slice(24)}`;
}

function uintWord(value, maximum = UINT256_MAX) {
  const bytes = hexBytes(value, 32);
  const parsed = BigInt(`0x${bytes.slice(2)}`);
  if (parsed > maximum) swapFail("SWAP_INVALID_POOL_STATE");
  return parsed;
}

function reserveWords(value) {
  const bytes = hexBytes(value, 96);
  const payload = bytes.slice(2);
  const reserve0 = uintWord(`0x${payload.slice(0, 64)}`, UINT112_MAX);
  const reserve1 = uintWord(`0x${payload.slice(64, 128)}`, UINT112_MAX);
  uintWord(`0x${payload.slice(128, 192)}`, UINT32_MAX);
  return { reserve0, reserve1 };
}

function blockHeader(value) {
  if (!isRecord(value)) swapFail("SWAP_STATE_STALE");
  const number = hexQuantity(value.number, "SWAP_STATE_STALE");
  const hash = hexBytes(value.hash, 32, "SWAP_STATE_STALE");
  const timestamp = hexQuantity(value.timestamp, "SWAP_STATE_STALE");
  return { number, hash, timestamp };
}

function assertChainIdResponse(value, chainId) {
  let network;
  try { network = hexQuantity(value, "SWAP_CHAIN_MISMATCH"); } catch (error) {
    if (error instanceof SwapQuoteError) swapFail("SWAP_CHAIN_MISMATCH");
    throw error;
  }
  const expected = chainId === DEX_CHAIN_IDS.ethereum ? 1n : chainId === DEX_CHAIN_IDS.avalancheC ? 43114n : null;
  if (expected === null || network !== expected) swapFail("SWAP_CHAIN_MISMATCH");
}

function requestMethod(rpc, method, params, signal) {
  if (signal === undefined) {
    if (typeof rpc === "function") return rpc(method, params);
    if (rpc && typeof rpc.request === "function") return rpc.request(method, params);
    if (rpc && typeof rpc.call === "function") return rpc.call(method, params);
  } else {
    if (typeof rpc === "function") return rpc(method, params, { signal });
    if (rpc && typeof rpc.request === "function") return rpc.request(method, params, { signal });
    if (rpc && typeof rpc.call === "function") return rpc.call(method, params, { signal });
  }
  swapFail("SWAP_INVALID_ARGUMENT");
}

async function rpcRequest(context, method, params) {
  const rpc = context?.rpc ?? context;
  const signal = context?.signal;
  if (signal?.aborted) {
    if (signal.reason !== undefined) throw signal.reason;
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const response = await requestMethod(rpc, method, params, signal);
  if (response && isRecord(response) && Object.hasOwn(response, "error")) {
    if (response.error instanceof Error) throw response.error;
    const error = new Error(typeof response.error === "string" ? response.error : response.error?.message ?? "RPC request failed");
    if (isRecord(response.error)) Object.assign(error, response.error);
    throw error;
  }
  if (response && isRecord(response) && Object.hasOwn(response, "result") && Object.keys(response).every((key) => key === "result" || key === "id" || key === "jsonrpc")) return response.result;
  return response;
}

function rpcSelector(hash) {
  return { blockHash: hash, requireCanonical: true };
}

function abiCall(to, data) {
  return { to, data };
}

function encodeAddressArgument(address) {
  if (!EVM_ADDRESS.test(address)) swapFail("SWAP_INVALID_POOL_STATE");
  return address.slice(2).padStart(64, "0");
}

const FACTORY_GET_PAIR_SELECTOR = "0xe6a43905";
const PAIR_FACTORY_SELECTOR = "0xc45a0155";
const PAIR_TOKEN0_SELECTOR = "0x0dfe1681";
const PAIR_TOKEN1_SELECTOR = "0xd21220a7";
const PAIR_GET_RESERVES_SELECTOR = "0x0902f1ac";

async function readEvmState(context, normalized) {
  const { pool, dex, input, output } = normalized;
  const chainId = await rpcRequest(context, "eth_chainId", []);
  assertChainIdResponse(chainId, pool.chainId);
  const initial = blockHeader(await rpcRequest(context, "eth_getBlockByNumber", ["latest", false]));
  const selector = rpcSelector(`0x${initial.hash.slice(2)}`);
  // Keep the seven state responses opaque until both final-header checks have
  // passed. If a reorg or freshness violation coincides with malformed ABI,
  // stale state has deterministic precedence and no decoded response is used.
  const factoryCodeRaw = await rpcRequest(context, "eth_getCode", [dex.programAddress, selector]);
  const poolCodeRaw = await rpcRequest(context, "eth_getCode", [pool.address, selector]);

  const token0 = tokenDeployment(pool.token0DeploymentId);
  const token1 = tokenDeployment(pool.token1DeploymentId);
  if (!token0?.address || !token1?.address) swapFail("SWAP_INVALID_POOL_STATE");
  const pairCallData = `${FACTORY_GET_PAIR_SELECTOR}${encodeAddressArgument(token0.address)}${encodeAddressArgument(token1.address)}`;
  const factoryPairRaw = await rpcRequest(context, "eth_call", [abiCall(dex.programAddress, pairCallData), selector]);
  const pairFactoryRaw = await rpcRequest(context, "eth_call", [abiCall(pool.address, PAIR_FACTORY_SELECTOR), selector]);
  const pairToken0Raw = await rpcRequest(context, "eth_call", [abiCall(pool.address, PAIR_TOKEN0_SELECTOR), selector]);
  const pairToken1Raw = await rpcRequest(context, "eth_call", [abiCall(pool.address, PAIR_TOKEN1_SELECTOR), selector]);
  const reservesRaw = await rpcRequest(context, "eth_call", [abiCall(pool.address, PAIR_GET_RESERVES_SELECTOR), selector]);

  const latestAfterReads = blockHeader(await rpcRequest(context, "eth_getBlockByNumber", ["latest", false]));
  const reread = blockHeader(await rpcRequest(context, "eth_getBlockByNumber", [`0x${initial.number.toString(16)}`, false]));
  if (reread.number !== initial.number || reread.hash !== initial.hash || reread.timestamp !== initial.timestamp) swapFail("SWAP_STATE_STALE");
  const bufferedState = { initial, latestAfterReads, input, output, pool, dex };
  // Freshness and reorg checks run while every ABI response is still buffered.
  // This gives stale state precedence over malformed bytes in any response.
  assertFreshness(bufferedState, normalized.freshness, context);
  const factoryCode = hexBytes(factoryCodeRaw);
  if (factoryCode.length <= 2) swapFail("SWAP_PROGRAM_MISMATCH");
  const poolCode = hexBytes(poolCodeRaw);
  if (poolCode.length <= 2) swapFail("SWAP_INVALID_POOL_STATE");
  const factoryPair = addressWord(factoryPairRaw);
  if (factoryPair !== pool.address) swapFail("SWAP_PROGRAM_MISMATCH");
  const pairFactory = addressWord(pairFactoryRaw);
  if (pairFactory !== dex.programAddress) swapFail("SWAP_PROGRAM_MISMATCH");
  const pairToken0 = addressWord(pairToken0Raw);
  const pairToken1 = addressWord(pairToken1Raw);
  if (pairToken0 !== token0.address || pairToken1 !== token1.address) swapFail("SWAP_POOL_TOKEN_MISMATCH");
  const reserves = reserveWords(reservesRaw);
  return { ...bufferedState, reserves };
}

function currentClockSeconds(context) {
  const value = typeof context?.clock === "function" ? context.clock() : context?.now;
  if (value === undefined) return Math.floor(Date.now() / 1000);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) swapFail("SWAP_INVALID_ARGUMENT");
  return value;
}

function assertFreshness(state, freshness, context) {
  const now = BigInt(currentClockSeconds(context));
  const timestamp = state.initial.timestamp;
  const age = now - timestamp;
  if (age < -BigInt(freshness.maxClockSkewSeconds) || age > BigInt(freshness.maxBlockAgeSeconds)) swapFail("SWAP_STATE_STALE");
  const latestAge = now - state.latestAfterReads.timestamp;
  if (latestAge < -BigInt(freshness.maxClockSkewSeconds) || latestAge > BigInt(freshness.maxBlockAgeSeconds)) swapFail("SWAP_STATE_STALE");
  if (state.latestAfterReads.number < state.initial.number || state.latestAfterReads.number - state.initial.number > BigInt(freshness.maxBlockLag)) swapFail("SWAP_STATE_STALE");
  if (state.latestAfterReads.number === state.initial.number && state.latestAfterReads.hash !== state.initial.hash) swapFail("SWAP_STATE_STALE");
  if (state.latestAfterReads.number > state.initial.number && state.latestAfterReads.timestamp < state.initial.timestamp) swapFail("SWAP_STATE_STALE");
  if (state.latestAfterReads.hash === state.initial.hash && state.latestAfterReads.number === state.initial.number && state.latestAfterReads.timestamp !== state.initial.timestamp) {
    swapFail("SWAP_STATE_STALE");
  }
}

function calculateQuote(normalized, state) {
  const feeNumerator = BigInt(normalized.pool.adapter.feeNumerator);
  const feeDenominator = BigInt(normalized.pool.adapter.feeDenominator);
  if (feeNumerator < 0n || feeDenominator <= feeNumerator) swapFail("SWAP_ARITHMETIC");
  const reserveIn = normalized.input.address === tokenDeployment(normalized.pool.token0DeploymentId).address ? state.reserves.reserve0 : state.reserves.reserve1;
  const reserveOut = normalized.output.address === tokenDeployment(normalized.pool.token0DeploymentId).address ? state.reserves.reserve0 : state.reserves.reserve1;
  if (reserveIn <= 0n || reserveOut <= 0n) swapFail("SWAP_INSUFFICIENT_LIQUIDITY");
  const adjusted = ensureUint256(normalized.amountIn * (feeDenominator - feeNumerator));
  const denominator = ensureUint256(reserveIn * feeDenominator + adjusted);
  if (denominator <= 0n) swapFail("SWAP_ARITHMETIC");
  const numerator = ensureUint256(adjusted * reserveOut);
  const amountOut = numerator / denominator;
  ensureUint256(amountOut);
  if (amountOut <= 0n || amountOut >= reserveOut + 1n) swapFail("SWAP_INSUFFICIENT_LIQUIDITY");
  return { amountOut, feeNumerator, feeDenominator };
}

function quoteResult(normalized, state, result) {
  return deepFreeze({
    quoteKind: "exact-input",
    chainId: normalized.request.chainId,
    poolDefinitionId: normalized.pool.poolDefinitionId,
    dexDeploymentId: normalized.pool.dexDeploymentId,
    adapterKind: normalized.pool.adapter.kind,
    inputTokenDeploymentId: normalized.request.inputTokenDeploymentId,
    outputTokenDeploymentId: normalized.request.outputTokenDeploymentId,
    amountIn: normalized.amountIn.toString(10),
    amountOut: result.amountOut.toString(10),
    fee: {
      numerator: result.feeNumerator.toString(10),
      denominator: result.feeDenominator.toString(10),
    },
    snapshot: {
      kind: "evm-block",
      blockNumber: state.initial.number.toString(10),
      blockHash: state.initial.hash,
      blockTimestamp: state.initial.timestamp.toString(10),
    },
    tokenCatalogDigest: tokenCatalog.contentDigest,
    dexCatalogDigest: CATALOG.contentDigest,
  });
}

function snapshotState(snapshot, normalized) {
  if (!isRecord(snapshot)) swapFail("SWAP_INVALID_POOL_STATE");
  const blockHash = hexBytes(snapshot.blockHash ?? snapshot.hash, 32);
  const blockNumber = quantityValue(snapshot.blockNumber ?? snapshot.number);
  const blockTimestamp = quantityValue(snapshot.blockTimestamp ?? snapshot.timestamp);
  const token0 = tokenDeployment(normalized.pool.token0DeploymentId);
  const token1 = tokenDeployment(normalized.pool.token1DeploymentId);
  const token0Address = (snapshot.token0 ?? snapshot.token0Address ?? token0.address)?.toLowerCase();
  const token1Address = (snapshot.token1 ?? snapshot.token1Address ?? token1.address)?.toLowerCase();
  if (token0Address !== token0.address || token1Address !== token1.address) swapFail("SWAP_INVALID_POOL_STATE");
  const factory = (snapshot.pairFactory ?? snapshot.poolFactory ?? snapshot.factoryAddress ?? normalized.dex.programAddress)?.toLowerCase();
  if (factory !== normalized.dex.programAddress) swapFail("SWAP_PROGRAM_MISMATCH");
  const pair = (snapshot.factoryPair ?? snapshot.pairAddress ?? normalized.pool.address)?.toLowerCase();
  if (pair !== normalized.pool.address) swapFail("SWAP_PROGRAM_MISMATCH");
  const reserve0 = decimal(snapshot.reserve0);
  const reserve1 = decimal(snapshot.reserve1);
  if (BigInt(reserve0) > UINT112_MAX || BigInt(reserve1) > UINT112_MAX) swapFail("SWAP_INVALID_POOL_STATE");
  return {
    initial: { number: blockNumber, hash: blockHash, timestamp: blockTimestamp },
    latestAfterReads: { number: blockNumber, hash: blockHash, timestamp: blockTimestamp },
    reserves: { reserve0: BigInt(reserve0), reserve1: BigInt(reserve1) },
  };
}

export function quoteExactInputFromSnapshot(request, snapshot, context = {}) {
  const normalized = normalizeQuoteRequest(request);
  const state = snapshotState(snapshot, normalized);
  assertFreshness(state, normalized.freshness, context);
  return quoteResult(normalized, state, calculateQuote(normalized, state));
}

export async function quoteExactInput(request, context = {}) {
  const normalized = normalizeQuoteRequest(request);
  if (context?.snapshot !== undefined) return quoteExactInputFromSnapshot(request, context.snapshot, context);
  if (normalized.pool.adapter.kind !== SUPPORTED_QUOTE_ADAPTER) swapFail("SWAP_UNSUPPORTED_ADAPTER");
  const state = await readEvmState(context, normalized);
  return quoteResult(normalized, state, calculateQuote(normalized, state));
}

export function createQuoteDriver({ rpc, signal, now, clock } = {}) {
  if (rpc === undefined) swapFail("SWAP_INVALID_ARGUMENT");
  return Object.freeze({
    quoteExactInput: (request) => quoteExactInput(request, { rpc, signal, now, clock }),
  });
}

export const quoteExactInputWithRpc = quoteExactInput;
export const CATALOG = deepFreeze(canonicalCatalog);
validateCatalog(CATALOG);
export const VERSION = CATALOG.catalogVersion;
export const AS_OF_DATE = CATALOG.manualAsOf;
export const CONTENT_DIGEST = CATALOG.contentDigest;
export const RUNTIME_DEX_FIELDS = Object.freeze([...RUNTIME_DEX_KEYS]);
export const RUNTIME_POOL_FIELDS = Object.freeze([...RUNTIME_POOL_KEYS]);
export const RUNTIME_WRAP_FIELDS = Object.freeze([...RUNTIME_WRAP_KEYS]);
export const RUNTIME_ALIAS_FIELDS = Object.freeze([...RUNTIME_ALIAS_KEYS]);
export const EVM_ABI_SELECTORS = Object.freeze({
  factoryGetPair: FACTORY_GET_PAIR_SELECTOR,
  pairFactory: PAIR_FACTORY_SELECTOR,
  pairToken0: PAIR_TOKEN0_SELECTOR,
  pairToken1: PAIR_TOKEN1_SELECTOR,
  pairGetReserves: PAIR_GET_RESERVES_SELECTOR,
});
