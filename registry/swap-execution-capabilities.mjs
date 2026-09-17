import { createHash } from "node:crypto";
import canonicalRegistry from "./swap-execution-capabilities.json" with { type: "json" };
import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import {
  QUOTE_CAPABILITIES,
  validateQuoteCapabilities,
} from "./quote-capabilities.mjs";

export const SWAP_EXECUTION_SCHEMA_VERSION = 1;
export const SWAP_EXECUTION_CAPABILITY_KEYS = Object.freeze([
  "swapExecutionCapabilityId",
  "chainId",
  "dexDeploymentId",
  "poolDefinitionId",
  "factoryAddress",
  "routerAddress",
  "routerKind",
  "adapterKind",
  "token0DeploymentId",
  "token0Address",
  "token0Standard",
  "token1DeploymentId",
  "token1Address",
  "token1Standard",
  "wrappedNativeTokenDeploymentId",
  "wrappedNativeTokenAddress",
  "wrappedNativeFunctionSelector",
  "functionKind",
  "functionSignature",
  "functionSelector",
  "status",
  "evidence",
  "asOfDate",
]);
export const SWAP_EXECUTION_RUNTIME_KEYS = Object.freeze(
  SWAP_EXECUTION_CAPABILITY_KEYS.filter((key) => key !== "evidence" && key !== "asOfDate"),
);
export const SWAP_EXECUTION_CAPABILITY_IDS = Object.freeze([
  "swap-execution-0001",
  "swap-execution-0002",
]);
export const SWAP_EXECUTION_FUNCTION_SIGNATURE = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
export const SWAP_EXECUTION_FUNCTION_SELECTOR = "0x38ed1739";

const EVM_CHAINS = new Set(["eip155:1", "eip155:43114"]);
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const SELECTOR = /^0x[0-9a-f]{8}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const HTTPS_URL = /^https:\/\/\S+$/u;
const ROUTER_KINDS = new Set(["uniswap-v2-router02", "joe-v1-router02"]);
const CAPABILITY_ID_SET = new Set(SWAP_EXECUTION_CAPABILITY_IDS);

const REVIEWED_FACTS = Object.freeze({
  "swap-execution-0001": Object.freeze({
    chainId: "eip155:1",
    dexDeploymentId: "dex-deployment-0001",
    poolDefinitionId: "pool-0001",
    poolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    factoryAddress: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    routerAddress: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    routerKind: "uniswap-v2-router02",
    adapterKind: "evm-constant-product-v2",
    token0DeploymentId: "deployment-0008",
    token0Address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    token0Standard: "erc20",
    token1DeploymentId: "deployment-0002",
    token1Address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    token1Standard: "erc20",
    wrappedNativeTokenDeploymentId: "deployment-0002",
    wrappedNativeTokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    wrappedNativeFunctionSelector: "0xad5c4648",
  }),
  "swap-execution-0002": Object.freeze({
    chainId: "eip155:43114",
    dexDeploymentId: "dex-deployment-0002",
    poolDefinitionId: "pool-0002",
    poolAddress: "0xf4003f4efbe8691b60249e6afbd307abe7758adb",
    factoryAddress: "0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
    routerAddress: "0x60ae616a2155ee3d9a68541ba4544862310933d4",
    routerKind: "joe-v1-router02",
    adapterKind: "evm-constant-product-v2",
    token0DeploymentId: "deployment-0004",
    token0Address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    token0Standard: "erc20",
    token1DeploymentId: "deployment-0009",
    token1Address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    token1Standard: "erc20",
    wrappedNativeTokenDeploymentId: "deployment-0004",
    wrappedNativeTokenAddress: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    wrappedNativeFunctionSelector: "0x73b295c2",
  }),
});

export class SwapExecutionCapabilityValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SwapExecutionCapabilityValidationError";
  }
}

function fail(message) {
  throw new SwapExecutionCapabilityValidationError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${keys.join(", ")}`);
  }
}

function opaqueId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be an opaque ID`);
}

function dateString(value, label) {
  if (typeof value !== "string" || !DATE.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} must be a real calendar date`);
}

function address(value, label) {
  if (typeof value !== "string" || !EVM_ADDRESS.test(value)) fail(`${label} must be a lowercase 20-byte EVM address`);
}

function selector(value, label) {
  if (typeof value !== "string" || !SELECTOR.test(value)) fail(`${label} must be a lowercase four-byte selector`);
}

function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !HTTPS_URL.test(entry))) {
    fail(`${label} must be a non-empty list of HTTPS URLs`);
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicate URLs`);
}

function compareFields(left, right, fields, label) {
  for (const field of fields) if (left?.[field] !== right?.[field]) fail(`${label}.${field} differs from the reviewed binding`);
}

function catalogMaps(dexCatalog, tokenCatalog) {
  if (!isRecord(dexCatalog) || !Array.isArray(dexCatalog.dexDeployments) || !Array.isArray(dexCatalog.poolDefinitions)) {
    fail("DEX catalog is not a valid catalog object");
  }
  if (!isRecord(tokenCatalog) || !Array.isArray(tokenCatalog.deployments)) fail("token catalog is not a valid catalog object");
  return {
    dexes: new Map(dexCatalog.dexDeployments.map((entry) => [entry.dexDeploymentId, entry])),
    pools: new Map(dexCatalog.poolDefinitions.map((entry) => [entry.poolDefinitionId, entry])),
    wraps: new Map((dexCatalog.nativeWrapDefinitions ?? []).map((entry) => [entry.chainId, entry])),
    tokens: new Map(tokenCatalog.deployments.map((entry) => [entry.deploymentId, entry])),
  };
}

function validateRegistryShape(registry) {
  exactKeys(registry, ["schemaVersion", "asOfDate", "capabilities"], "registry");
  if (registry.schemaVersion !== SWAP_EXECUTION_SCHEMA_VERSION) fail(`registry.schemaVersion must be ${SWAP_EXECUTION_SCHEMA_VERSION}`);
  dateString(registry.asOfDate, "registry.asOfDate");
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length !== SWAP_EXECUTION_CAPABILITY_IDS.length) {
    fail(`registry.capabilities must contain exactly ${SWAP_EXECUTION_CAPABILITY_IDS.length} rows`);
  }
}

function runtimeRow(row) {
  return Object.fromEntries(SWAP_EXECUTION_RUNTIME_KEYS.map((key) => [key, row[key]]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Return the provenance-free runtime rows in stable capability-ID order. */
export function runtimeProjection(value = canonicalRegistry.capabilities) {
  const rows = Array.isArray(value) ? value : value?.capabilities;
  if (!Array.isArray(rows)) fail("capabilities must be an array");
  return rows
    .map(runtimeRow)
    .sort((left, right) => compareText(left.swapExecutionCapabilityId, right.swapExecutionCapabilityId));
}

/** Alias used by registry tooling when referring to the digest projection. */
export const canonicalProjection = runtimeProjection;

export function computeDigest(value = canonicalRegistry.capabilities) {
  return createHash("sha256").update(JSON.stringify(stableValue(runtimeProjection(value)))).digest("hex");
}

function validateRow(row, index, registry, maps, quoteCapabilities) {
  const label = `capabilities[${index}]`;
  exactKeys(row, SWAP_EXECUTION_CAPABILITY_KEYS, label);
  opaqueId(row.swapExecutionCapabilityId, `${label}.swapExecutionCapabilityId`);
  if (!CAPABILITY_ID_SET.has(row.swapExecutionCapabilityId)) fail(`${label} references an unapproved capability ID`);
  if (row.asOfDate !== registry.asOfDate) fail(`${label}.asOfDate must match registry.asOfDate`);
  if (!EVM_CHAINS.has(row.chainId)) fail(`${label}.chainId is not an approved EVM chain`);
  for (const field of [
    "dexDeploymentId",
    "poolDefinitionId",
    "token0DeploymentId",
    "token1DeploymentId",
    "wrappedNativeTokenDeploymentId",
  ]) opaqueId(row[field], `${label}.${field}`);
  for (const field of [
    "factoryAddress",
    "routerAddress",
    "token0Address",
    "token1Address",
    "wrappedNativeTokenAddress",
  ]) address(row[field], `${label}.${field}`);
  if (!ROUTER_KINDS.has(row.routerKind)) fail(`${label}.routerKind is unsupported`);
  if (row.adapterKind !== "evm-constant-product-v2") fail(`${label}.adapterKind is unsupported`);
  if (row.token0Standard !== "erc20" || row.token1Standard !== "erc20") fail(`${label} token standard must be erc20`);
  selector(row.wrappedNativeFunctionSelector, `${label}.wrappedNativeFunctionSelector`);
  if (row.functionKind !== "exact-input-erc20-to-erc20") fail(`${label}.functionKind is unsupported`);
  if (row.functionSignature !== SWAP_EXECUTION_FUNCTION_SIGNATURE) fail(`${label}.functionSignature is unsupported`);
  if (row.functionSelector !== SWAP_EXECUTION_FUNCTION_SELECTOR) fail(`${label}.functionSelector is unsupported`);
  if (row.status !== "active") fail(`${label}.status must be active`);
  evidenceList(row.evidence, `${label}.evidence`);
  dateString(row.asOfDate, `${label}.asOfDate`);

  const reviewed = REVIEWED_FACTS[row.swapExecutionCapabilityId];
  if (!reviewed) fail(`${label} has no reviewed execution facts`);
  compareFields(row, reviewed, Object.keys(reviewed).filter((field) => field !== "poolAddress"), label);

  const pool = maps.pools.get(row.poolDefinitionId);
  const dex = maps.dexes.get(row.dexDeploymentId);
  const token0 = maps.tokens.get(row.token0DeploymentId);
  const token1 = maps.tokens.get(row.token1DeploymentId);
  const wrapped = maps.tokens.get(row.wrappedNativeTokenDeploymentId);
  if (!pool || !dex || !token0 || !token1 || !wrapped) fail(`${label} references an unknown catalog record`);
  if (pool.status !== "active" || dex.status !== "active" || token0.status !== "active" || token1.status !== "active" || wrapped.status !== "active") {
    fail(`${label} references an inactive catalog record`);
  }
  if (pool.address !== reviewed.poolAddress) fail(`${label}.pool address differs from the reviewed binding`);
  if (pool.chainId !== row.chainId || pool.dexDeploymentId !== row.dexDeploymentId || pool.token0DeploymentId !== row.token0DeploymentId || pool.token1DeploymentId !== row.token1DeploymentId) {
    fail(`${label} pool binding differs from the catalog`);
  }
  if (pool.adapter?.kind !== row.adapterKind || pool.adapter?.feeNumerator !== "3" || pool.adapter?.feeDenominator !== "1000") {
    fail(`${label} pool adapter or fee differs from the reviewed quote capability`);
  }
  if (dex.chainId !== row.chainId || dex.programAddress !== row.factoryAddress || dex.adapterKind !== row.adapterKind) {
    fail(`${label} DEX binding differs from the catalog`);
  }
  for (const [token, id, tokenAddress, field] of [[token0, row.token0DeploymentId, row.token0Address, "token0"], [token1, row.token1DeploymentId, row.token1Address, "token1"]]) {
    if (token.deploymentId !== id || token.chainId !== row.chainId || token.address !== tokenAddress || token.standard !== "erc20") fail(`${label}.${field} binding differs from the catalog`);
  }
  if (wrapped.chainId !== row.chainId || wrapped.address !== row.wrappedNativeTokenAddress || wrapped.standard !== "erc20") fail(`${label}.wrappedNativeToken binding differs from the catalog`);
  const wrap = maps.wraps.get(row.chainId);
  if (!wrap || wrap.status !== "active" || wrap.wrappedTokenDeploymentId !== row.wrappedNativeTokenDeploymentId) fail(`${label}.wrappedNativeTokenDeploymentId differs from the native-wrap catalog`);

  const quote = quoteCapabilities.find((entry) => entry.poolDefinitionId === row.poolDefinitionId);
  if (!quote) fail(`${label} is missing its reviewed quote capability`);
  compareFields(quote, row, ["chainId", "dexDeploymentId", "poolDefinitionId", "factoryAddress", "token0DeploymentId", "token0Address", "token1DeploymentId", "token1Address", "adapterKind"], label + ".quote");
  if (quote.feeNumerator !== "3" || quote.feeDenominator !== "1000") fail(`${label}.quote fee differs from the reviewed fee`);
}

export function validateSwapExecutionCapabilities(
  registry = canonicalRegistry,
  {
    dexCatalog = canonicalDexCatalog,
    tokenCatalog = canonicalTokenCatalog,
    quoteCapabilities = QUOTE_CAPABILITIES,
  } = {},
) {
  validateRegistryShape(registry);
  const maps = catalogMaps(dexCatalog, tokenCatalog);
  if (!Array.isArray(quoteCapabilities)) fail("quoteCapabilities must be an array");
  try {
    validateQuoteCapabilities(quoteCapabilities, { dexCatalog, tokenCatalog });
  } catch (error) {
    if (error instanceof SwapExecutionCapabilityValidationError) throw error;
    fail(`quote capability source is invalid: ${error.message}`);
  }
  const ids = new Set();
  for (const [index, row] of registry.capabilities.entries()) {
    if (ids.has(row?.swapExecutionCapabilityId)) fail(`duplicate capability ID ${row?.swapExecutionCapabilityId}`);
    ids.add(row?.swapExecutionCapabilityId);
    validateRow(row, index, registry, maps, quoteCapabilities);
  }
  if (ids.size !== CAPABILITY_ID_SET.size || [...CAPABILITY_ID_SET].some((id) => !ids.has(id))) fail("registry capability IDs do not match the reviewed set");
  const digest = computeDigest(registry.capabilities);
  if (!/^[0-9a-f]{64}$/u.test(digest)) fail("execution capability digest is invalid");
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SWAP_EXECUTION_CAPABILITIES = deepFreeze(canonicalRegistry.capabilities);
export const SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE = canonicalRegistry.asOfDate;
export const SWAP_EXECUTION_CAPABILITIES_JSON = JSON.stringify(runtimeProjection(SWAP_EXECUTION_CAPABILITIES));
export const SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST = computeDigest(SWAP_EXECUTION_CAPABILITIES);
export const SWAP_EXECUTION_CAPABILITY_DIGEST = SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST;
export const SWAP_EXECUTION_RUNTIME_CAPABILITIES = deepFreeze(JSON.parse(SWAP_EXECUTION_CAPABILITIES_JSON));

export function getSwapExecutionCapability(swapExecutionCapabilityId) {
  if (typeof swapExecutionCapabilityId !== "string") return null;
  return SWAP_EXECUTION_RUNTIME_CAPABILITIES.find((entry) => entry.swapExecutionCapabilityId === swapExecutionCapabilityId) ?? null;
}

export function getSwapExecutionCapabilityForPool(poolDefinitionId) {
  if (typeof poolDefinitionId !== "string") return null;
  return SWAP_EXECUTION_RUNTIME_CAPABILITIES.find((entry) => entry.poolDefinitionId === poolDefinitionId) ?? null;
}

export function isSwapExecutionCapability(pool, input, output, { dexCatalog = canonicalDexCatalog, tokenCatalog = canonicalTokenCatalog } = {}) {
  if (!pool || !input || !output) return false;
  const capability = SWAP_EXECUTION_CAPABILITIES.find((entry) => entry.poolDefinitionId === pool.poolDefinitionId);
  if (!capability) return false;
  const dex = dexCatalog.dexDeployments?.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
  const matchesToken = (token) => token.chainId === capability.chainId
    && token.standard === "erc20"
    && token.address !== null
    && ((token.deploymentId === capability.token0DeploymentId && token.address === capability.token0Address)
      || (token.deploymentId === capability.token1DeploymentId && token.address === capability.token1Address));
  const assets = new Map((tokenCatalog.assets ?? []).map((entry) => [entry.assetId, entry]));
  const inputAsset = assets.get(input.assetId);
  const outputAsset = assets.get(output.assetId);
  if (inputAsset?.representationKind === "unclassified" || outputAsset?.representationKind === "unclassified") return false;
  return pool.status === "active"
    && pool.chainId === capability.chainId
    && pool.dexDeploymentId === capability.dexDeploymentId
    && pool.address === REVIEWED_FACTS[capability.swapExecutionCapabilityId]?.poolAddress
    && pool.token0DeploymentId === capability.token0DeploymentId
    && pool.token1DeploymentId === capability.token1DeploymentId
    && pool.adapter?.kind === capability.adapterKind
    && pool.adapter?.feeNumerator === "3"
    && pool.adapter?.feeDenominator === "1000"
    && dex?.status === "active"
    && dex.programAddress === capability.factoryAddress
    && dex.adapterKind === capability.adapterKind
    && matchesToken(input)
    && matchesToken(output)
    && input.deploymentId !== output.deploymentId;
}

validateSwapExecutionCapabilities();
