import { createHash } from "node:crypto";
import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };

export const QUOTE_CAPABILITY_KEYS = Object.freeze([
  "chainId",
  "dexDeploymentId",
  "factoryAddress",
  "poolDefinitionId",
  "poolAddress",
  "token0DeploymentId",
  "token0Address",
  "token0Decimals",
  "token1DeploymentId",
  "token1Address",
  "token1Decimals",
  "adapterKind",
  "feeNumerator",
  "feeDenominator",
]);
const EVM_CHAINS = new Set(["eip155:1", "eip155:43114"]);
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

export const QUOTE_CAPABILITIES = Object.freeze([
  Object.freeze({
    chainId: "eip155:1",
    dexDeploymentId: "dex-deployment-0001",
    factoryAddress: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    poolDefinitionId: "pool-0001",
    poolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    token0DeploymentId: "deployment-0008",
    token0Address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    token0Decimals: 6,
    token1DeploymentId: "deployment-0002",
    token1Address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    token1Decimals: 18,
    adapterKind: "evm-constant-product-v2",
    feeNumerator: "3",
    feeDenominator: "1000",
  }),
  Object.freeze({
    chainId: "eip155:43114",
    dexDeploymentId: "dex-deployment-0002",
    factoryAddress: "0x9ad6c38be94206ca50bb0d90783181662f0cfa10",
    poolDefinitionId: "pool-0002",
    poolAddress: "0xf4003f4efbe8691b60249e6afbd307abe7758adb",
    token0DeploymentId: "deployment-0004",
    token0Address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    token0Decimals: 18,
    token1DeploymentId: "deployment-0009",
    token1Address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    token1Decimals: 6,
    adapterKind: "evm-constant-product-v2",
    feeNumerator: "3",
    feeDenominator: "1000",
  }),
]);

export class QuoteCapabilityValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuoteCapabilityValidationError";
  }
}
function fail(message) { throw new QuoteCapabilityValidationError(message); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, label) {
  if (!isRecord(value)) fail(label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...QUOTE_CAPABILITY_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(label + " keys must be exactly " + QUOTE_CAPABILITY_KEYS.join(", "));
}
function id(value, label) { if (typeof value !== "string" || !ID.test(value)) fail(label + " must be an opaque ID"); }
function address(value, label) { if (typeof value !== "string" || !EVM_ADDRESS.test(value)) fail(label + " must be a lowercase EVM address"); }
function canonical(value) {
  return Object.fromEntries(QUOTE_CAPABILITY_KEYS.map((key) => [key, value[key]]));
}
function projection(rows) {
  return rows.map(canonical).sort((a, b) => a.chainId.localeCompare(b.chainId) || a.poolDefinitionId.localeCompare(b.poolDefinitionId));
}
export function computeDigest(rows = QUOTE_CAPABILITIES) {
  return createHash("sha256").update(JSON.stringify(projection(rows))).digest("hex");
}
export function validateQuoteCapabilities(rows = QUOTE_CAPABILITIES, { dexCatalog = canonicalDexCatalog, tokenCatalog = canonicalTokenCatalog } = {}) {
  if (!Array.isArray(rows)) fail("quote capabilities must be an array");
  const pools = new Map(dexCatalog.poolDefinitions.map((entry) => [entry.poolDefinitionId, entry]));
  const dexes = new Map(dexCatalog.dexDeployments.map((entry) => [entry.dexDeploymentId, entry]));
  const tokens = new Map(tokenCatalog.deployments.map((entry) => [entry.deploymentId, entry]));
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    exactKeys(row, "quoteCapabilities[" + index + "]");
    if (!EVM_CHAINS.has(row.chainId)) fail("quoteCapabilities[" + index + "] chain is not EVM");
    for (const key of ["dexDeploymentId", "poolDefinitionId", "token0DeploymentId", "token1DeploymentId", "adapterKind"]) id(row[key], "quoteCapabilities[" + index + "]." + key);
    address(row.poolAddress, "quoteCapabilities[" + index + "].poolAddress");
    address(row.factoryAddress, "quoteCapabilities[" + index + "].factoryAddress");
    address(row.token0Address, "quoteCapabilities[" + index + "].token0Address");
    address(row.token1Address, "quoteCapabilities[" + index + "].token1Address");
    for (const key of ["token0Decimals", "token1Decimals"]) if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 255) fail("quoteCapabilities[" + index + "]." + key + " is invalid");
    if (row.adapterKind !== "evm-constant-product-v2" || row.feeNumerator !== "3" || row.feeDenominator !== "1000") fail("quoteCapabilities[" + index + "] adapter or fee is unsupported");
    if (!DECIMAL.test(row.feeNumerator) || !DECIMAL.test(row.feeDenominator) || BigInt(row.feeDenominator) <= BigInt(row.feeNumerator)) fail("quoteCapabilities[" + index + "] fee is invalid");
    if (ids.has(row.poolDefinitionId)) fail("duplicate quote capability " + row.poolDefinitionId);
    ids.add(row.poolDefinitionId);
    const pool = pools.get(row.poolDefinitionId);
    const dex = dexes.get(row.dexDeploymentId);
    const token0 = tokens.get(row.token0DeploymentId);
    const token1 = tokens.get(row.token1DeploymentId);
    if (!pool || !dex || !token0 || !token1) fail("quote capability references an unknown catalog binding");
    if (pool.chainId !== row.chainId || pool.dexDeploymentId !== row.dexDeploymentId || pool.address !== row.poolAddress || pool.token0DeploymentId !== row.token0DeploymentId || pool.token1DeploymentId !== row.token1DeploymentId) fail("quote capability pool binding differs from catalog");
    if (dex.chainId !== row.chainId || dex.programAddress !== row.factoryAddress || dex.adapterKind !== row.adapterKind) fail("quote capability DEX binding differs from catalog");
    if (token0.chainId !== row.chainId || token0.address !== row.token0Address || token0.decimals !== row.token0Decimals || token0.standard !== "erc20") fail("quote capability token0 binding differs from catalog");
    if (token1.chainId !== row.chainId || token1.address !== row.token1Address || token1.decimals !== row.token1Decimals || token1.standard !== "erc20") fail("quote capability token1 binding differs from catalog");
  }
  return true;
}
export function getQuoteCapability(poolDefinitionId) {
  if (typeof poolDefinitionId !== "string") return null;
  const row = QUOTE_CAPABILITIES.find((entry) => entry.poolDefinitionId === poolDefinitionId);
  return row ? Object.freeze({ ...row }) : null;
}
export function isQuoteCapability(pool, input, output, { dexCatalog = canonicalDexCatalog, tokenCatalog = canonicalTokenCatalog } = {}) {
  if (!pool || !input || !output) return false;
  const row = QUOTE_CAPABILITIES.find((entry) => entry.poolDefinitionId === pool.poolDefinitionId);
  if (!row) return false;
  const assets = new Map(tokenCatalog.assets.map((entry) => [entry.assetId, entry]));
  const inputAsset = assets.get(input.assetId);
  const outputAsset = assets.get(output.assetId);
  if (inputAsset?.representationKind === "unclassified" || outputAsset?.representationKind === "unclassified") return false;
  const dex = dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId);
  return row.chainId === pool.chainId
    && row.dexDeploymentId === pool.dexDeploymentId
    && row.factoryAddress === (dexCatalog.dexDeployments.find((entry) => entry.dexDeploymentId === pool.dexDeploymentId)?.programAddress ?? null)
    && row.poolAddress === pool.address
    && dex?.programAddress === row.factoryAddress
    && dex?.adapterKind === row.adapterKind
    && row.token0DeploymentId === pool.token0DeploymentId
    && row.token1DeploymentId === pool.token1DeploymentId
    && input.chainId === row.chainId && output.chainId === row.chainId
    && input.standard === "erc20" && output.standard === "erc20"
    && input.address !== null && output.address !== null
    && input.address !== null && output.address !== null
    && (input.deploymentId === row.token0DeploymentId ? input.address === row.token0Address && input.decimals === row.token0Decimals : input.deploymentId === row.token1DeploymentId ? input.address === row.token1Address && input.decimals === row.token1Decimals : false)
    && (output.deploymentId === row.token0DeploymentId ? output.address === row.token0Address && output.decimals === row.token0Decimals : output.deploymentId === row.token1DeploymentId ? output.address === row.token1Address && output.decimals === row.token1Decimals : false)
    && pool.adapter.kind === row.adapterKind
    && pool.adapter.feeNumerator === row.feeNumerator
    && pool.adapter.feeDenominator === row.feeDenominator;
}
export const QUOTE_CAPABILITY_DIGEST = computeDigest();
validateQuoteCapabilities();
