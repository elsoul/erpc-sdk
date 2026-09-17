import { createHash } from "node:crypto";
import canonicalRegistry from "./bridge-capabilities.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };

export const BRIDGE_CAPABILITIES_SCHEMA_VERSION = 1;

/** The source key order is part of the bridge registry contract. */
export const BRIDGE_CAPABILITY_KEYS = Object.freeze([
  "bridgeCapabilityId",
  "providerId",
  "capabilityKind",
  "sourceChainId",
  "destinationChainId",
  "sourceTokenDeploymentId",
  "destinationTokenDeploymentId",
  "sourceTokenAddress",
  "destinationTokenAddress",
  "sourceTokenStandard",
  "destinationTokenStandard",
  "sourceTokenDecimals",
  "destinationTokenDecimals",
  "sourceProviderChainName",
  "destinationProviderChainName",
  "sourceProviderChainId",
  "destinationProviderChainId",
  "sourceWormholeChainId",
  "destinationWormholeChainId",
  "sourceUsdcDeploymentId",
  "sourceUsdcAddress",
  "sourceUsdcStandard",
  "sourceUsdcDecimals",
  "swiftContract",
  "forwarderAddress",
  "forwarderFunctionSelector",
  "jupiterProgramAddress",
  "builderEndpoint",
  "explorerEndpoint",
  "dependencies",
  "status",
  "evidence",
  "asOfDate",
]);

export const BRIDGE_CAPABILITY_RUNTIME_KEYS = Object.freeze(
  BRIDGE_CAPABILITY_KEYS.filter((key) => key !== "evidence" && key !== "asOfDate"),
);
export const BRIDGE_RUNTIME_KEYS = BRIDGE_CAPABILITY_RUNTIME_KEYS;

export const BRIDGE_CAPABILITY_IDS = Object.freeze([
  "bridge-mayan-swift-v2-eurc-eth-sol",
  "bridge-mayan-swift-v2-eurc-sol-eth",
]);

export const BRIDGE_DEFAULT_BUILDER_ENDPOINT = "https://tx-builder.mayan.finance";
export const BRIDGE_DEFAULT_EXPLORER_ENDPOINT = "https://explorer-api.mayan.finance/v3";
export const BRIDGE_PROVIDER_ID = "mayan-swift-v2";
export const BRIDGE_CAPABILITY_KIND = "external-provider-dynamic";

export const BRIDGE_ERROR_MESSAGES = Object.freeze({
  BRIDGE_INVALID_ARGUMENT: "Bridge request is invalid",
  BRIDGE_UNSUPPORTED_ROUTE: "Bridge route is unsupported",
  BRIDGE_PROVIDER_AUTH_REQUIRED: "Bridge provider authentication is required",
  BRIDGE_PROVIDER_TRANSPORT: "Bridge provider transport failed",
  BRIDGE_PROVIDER_HTTP: "Bridge provider HTTP request failed",
  BRIDGE_PROVIDER_INVALID_RESPONSE: "Bridge provider response is invalid",
  BRIDGE_QUOTE_UNAVAILABLE: "Bridge quote is unavailable",
  BRIDGE_QUOTE_EXPIRED: "Bridge quote is expired",
  BRIDGE_QUOTE_MISMATCH: "Bridge quote does not match the request",
  BRIDGE_BUILD_INVALID: "Bridge provider build is invalid",
  BRIDGE_STATUS_NOT_FOUND: "Bridge status was not found",
  BRIDGE_TIMEOUT: "Bridge provider request timed out",
  BRIDGE_ABORTED: "Bridge provider request was aborted",
});

export const BRIDGE_DEPENDENCIES = Object.freeze([
  "mayan-hosted-quote-api",
  "mayan-hosted-transaction-builder",
  "mayan-hosted-source-swap-builder",
  "swift-auction-solvers",
  "relayers",
  "wormhole-guardian-messaging",
  "mayan-explorer-indexer",
]);
export const BRIDGE_JUPITER_DEPENDENCY = "jupiter-v6-source-swap";

const ETHEREUM_CHAIN_ID = "eip155:1";
const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const EVM_ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/u;
const EVM_SELECTOR = /^0x[0-9a-f]{8}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const HTTPS_URL = /^https:\/\/\S+$/u;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_SET = new Set(BASE58_ALPHABET);

const ETHEREUM_EURC = Object.freeze({
  chainId: ETHEREUM_CHAIN_ID,
  deploymentId: "deployment-0011",
  address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",
  standard: "erc20",
  decimals: 6,
  providerName: "ethereum",
  providerChainId: 1,
  wormholeChainId: 2,
});
const SOLANA_EURC = Object.freeze({
  chainId: SOLANA_CHAIN_ID,
  deploymentId: "deployment-0013",
  address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
  standard: "spl-token",
  decimals: 6,
  providerName: "solana",
  providerChainId: 0,
  wormholeChainId: 1,
});
const ETHEREUM_USDC = Object.freeze({
  chainId: ETHEREUM_CHAIN_ID,
  deploymentId: "deployment-0008",
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  standard: "erc20",
  decimals: 6,
});
const SOLANA_USDC = Object.freeze({
  chainId: SOLANA_CHAIN_ID,
  deploymentId: "deployment-0010",
  address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  standard: "spl-token",
  decimals: 6,
});

const REVIEWED_FACTS = Object.freeze({
  "bridge-mayan-swift-v2-eurc-eth-sol": Object.freeze({
    bridgeCapabilityId: "bridge-mayan-swift-v2-eurc-eth-sol",
    providerId: BRIDGE_PROVIDER_ID,
    capabilityKind: BRIDGE_CAPABILITY_KIND,
    sourceChainId: ETHEREUM_CHAIN_ID,
    destinationChainId: SOLANA_CHAIN_ID,
    sourceTokenDeploymentId: ETHEREUM_EURC.deploymentId,
    destinationTokenDeploymentId: SOLANA_EURC.deploymentId,
    sourceTokenAddress: ETHEREUM_EURC.address,
    destinationTokenAddress: SOLANA_EURC.address,
    sourceTokenStandard: ETHEREUM_EURC.standard,
    destinationTokenStandard: SOLANA_EURC.standard,
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    sourceProviderChainName: ETHEREUM_EURC.providerName,
    destinationProviderChainName: SOLANA_EURC.providerName,
    sourceProviderChainId: ETHEREUM_EURC.providerChainId,
    destinationProviderChainId: SOLANA_EURC.providerChainId,
    sourceWormholeChainId: ETHEREUM_EURC.wormholeChainId,
    destinationWormholeChainId: SOLANA_EURC.wormholeChainId,
    sourceUsdcDeploymentId: ETHEREUM_USDC.deploymentId,
    sourceUsdcAddress: ETHEREUM_USDC.address,
    sourceUsdcStandard: ETHEREUM_USDC.standard,
    sourceUsdcDecimals: 6,
    swiftContract: "0x40ffe85a28dc9993541449464d7529a922142960",
    forwarderAddress: "0x337685fdab40d39bd02028545a4ffa7d287cc3e2",
    forwarderFunctionSelector: "0x30dedc57",
    jupiterProgramAddress: null,
    builderEndpoint: BRIDGE_DEFAULT_BUILDER_ENDPOINT,
    explorerEndpoint: BRIDGE_DEFAULT_EXPLORER_ENDPOINT,
    dependencies: [...BRIDGE_DEPENDENCIES],
    status: "active",
  }),
  "bridge-mayan-swift-v2-eurc-sol-eth": Object.freeze({
    bridgeCapabilityId: "bridge-mayan-swift-v2-eurc-sol-eth",
    providerId: BRIDGE_PROVIDER_ID,
    capabilityKind: BRIDGE_CAPABILITY_KIND,
    sourceChainId: SOLANA_CHAIN_ID,
    destinationChainId: ETHEREUM_CHAIN_ID,
    sourceTokenDeploymentId: SOLANA_EURC.deploymentId,
    destinationTokenDeploymentId: ETHEREUM_EURC.deploymentId,
    sourceTokenAddress: SOLANA_EURC.address,
    destinationTokenAddress: ETHEREUM_EURC.address,
    sourceTokenStandard: SOLANA_EURC.standard,
    destinationTokenStandard: ETHEREUM_EURC.standard,
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    sourceProviderChainName: SOLANA_EURC.providerName,
    destinationProviderChainName: ETHEREUM_EURC.providerName,
    sourceProviderChainId: SOLANA_EURC.providerChainId,
    destinationProviderChainId: ETHEREUM_EURC.providerChainId,
    sourceWormholeChainId: SOLANA_EURC.wormholeChainId,
    destinationWormholeChainId: ETHEREUM_EURC.wormholeChainId,
    sourceUsdcDeploymentId: SOLANA_USDC.deploymentId,
    sourceUsdcAddress: SOLANA_USDC.address,
    sourceUsdcStandard: SOLANA_USDC.standard,
    sourceUsdcDecimals: 6,
    swiftContract: "mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny",
    forwarderAddress: null,
    forwarderFunctionSelector: null,
    jupiterProgramAddress: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    builderEndpoint: BRIDGE_DEFAULT_BUILDER_ENDPOINT,
    explorerEndpoint: BRIDGE_DEFAULT_EXPLORER_ENDPOINT,
    dependencies: [...BRIDGE_DEPENDENCIES, BRIDGE_JUPITER_DEPENDENCY],
    status: "active",
  }),
});

export class BridgeCapabilityValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeCapabilityValidationError";
  }
}

function fail(message) {
  throw new BridgeCapabilityValidationError(message);
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
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) fail(`${label} must be an opaque ID`);
}

function dateString(value, label) {
  if (typeof value !== "string" || !DATE.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} must be a real calendar date`);
  }
}

function isCanonicalBase58(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  if ([...value].some((character) => !BASE58_SET.has(character))) return false;
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  const leadingZeroes = value.match(/^1*/u)?.[0].length ?? 0;
  const decodedLength = bytes.length + leadingZeroes;
  if (decodedLength !== 32) return false;
  let canonical = "";
  let remaining = 0n;
  for (const byte of bytes.reverse()) remaining = remaining * 256n + BigInt(byte);
  while (remaining > 0n) {
    const remainder = Number(remaining % 58n);
    canonical = BASE58_ALPHABET[remainder] + canonical;
    remaining /= 58n;
  }
  return `${"1".repeat(leadingZeroes)}${canonical}` === value;
}

function addressForChain(value, chainId, label) {
  if (chainId === ETHEREUM_CHAIN_ID) {
    if (typeof value !== "string" || !EVM_ADDRESS.test(value) || /^0x0{40}$/u.test(value)) {
      fail(`${label} must be a lowercase non-zero EVM address`);
    }
    return;
  }
  if (chainId === SOLANA_CHAIN_ID) {
    if (!isCanonicalBase58(value)) fail(`${label} must be a canonical 32-byte Solana address`);
    return;
  }
  fail(`${label} has an unsupported chain`);
}

function nullableAddressForChain(value, chainId, label) {
  if (value === null) return;
  addressForChain(value, chainId, label);
}

function endpoint(value, label) {
  if (typeof value !== "string" || !HTTPS_URL.test(value)) fail(`${label} must be an HTTPS URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    fail(`${label} must not contain credentials, query, fragment, or a malformed port`);
  }
}

function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !HTTPS_URL.test(entry))) {
    fail(`${label} must be a non-empty list of HTTPS URLs`);
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicate URLs`);
}

function catalogMaps(tokenCatalog) {
  if (!isRecord(tokenCatalog) || !Array.isArray(tokenCatalog.deployments)) fail("token catalog is not a valid catalog object");
  return new Map(tokenCatalog.deployments.map((entry) => [entry.deploymentId, entry]));
}

function compareCatalogToken(tokens, expected, label) {
  const token = tokens.get(expected.deploymentId);
  if (!isRecord(token) || token.deploymentId !== expected.deploymentId || token.chainId !== expected.chainId || token.decimals !== expected.decimals || token.standard !== expected.standard || token.status !== "active") {
    fail(`${label} does not match the canonical token catalog`);
  }
  if (typeof token.address !== "string") fail(`${label} has no canonical address`);
  const addressMatches = expected.chainId === ETHEREUM_CHAIN_ID
    ? token.address.toLowerCase() === expected.address.toLowerCase()
    : token.address === expected.address;
  if (!addressMatches) fail(`${label} address differs from the canonical token catalog`);
}

function validateRegistryShape(registry) {
  exactKeys(registry, ["schemaVersion", "asOfDate", "capabilities"], "registry");
  if (registry.schemaVersion !== BRIDGE_CAPABILITIES_SCHEMA_VERSION) fail(`registry.schemaVersion must be ${BRIDGE_CAPABILITIES_SCHEMA_VERSION}`);
  dateString(registry.asOfDate, "registry.asOfDate");
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length !== BRIDGE_CAPABILITY_IDS.length) {
    fail(`registry.capabilities must contain exactly ${BRIDGE_CAPABILITY_IDS.length} rows`);
  }
}

function stableEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRow(row, index, registry, tokens) {
  const label = `capabilities[${index}]`;
  exactKeys(row, BRIDGE_CAPABILITY_KEYS, label);
  opaqueId(row.bridgeCapabilityId, `${label}.bridgeCapabilityId`);
  if (!BRIDGE_CAPABILITY_IDS.includes(row.bridgeCapabilityId)) fail(`${label} references an unapproved capability ID`);
  if (row.asOfDate !== registry.asOfDate) fail(`${label}.asOfDate must match registry.asOfDate`);
  if (row.providerId !== BRIDGE_PROVIDER_ID) fail(`${label}.providerId is unsupported`);
  if (row.capabilityKind !== BRIDGE_CAPABILITY_KIND) fail(`${label}.capabilityKind is unsupported`);
  const reviewed = REVIEWED_FACTS[row.bridgeCapabilityId];
  if (!reviewed) fail(`${label} has no reviewed bridge facts`);
  for (const field of [
    "sourceChainId",
    "destinationChainId",
    "sourceTokenDeploymentId",
    "destinationTokenDeploymentId",
    "sourceTokenAddress",
    "destinationTokenAddress",
    "sourceTokenStandard",
    "destinationTokenStandard",
    "sourceTokenDecimals",
    "destinationTokenDecimals",
    "sourceProviderChainName",
    "destinationProviderChainName",
    "sourceProviderChainId",
    "destinationProviderChainId",
    "sourceWormholeChainId",
    "destinationWormholeChainId",
    "sourceUsdcDeploymentId",
    "sourceUsdcAddress",
    "sourceUsdcStandard",
    "sourceUsdcDecimals",
    "swiftContract",
    "forwarderAddress",
    "forwarderFunctionSelector",
    "jupiterProgramAddress",
    "builderEndpoint",
    "explorerEndpoint",
    "status",
  ]) {
    const equal = Array.isArray(row[field]) ? stableEqual(row[field], reviewed[field]) : row[field] === reviewed[field];
    if (!equal) fail(`${label}.${field} differs from the reviewed binding`);
  }
  for (const field of ["sourceTokenDeploymentId", "destinationTokenDeploymentId", "sourceUsdcDeploymentId"]) opaqueId(row[field], `${label}.${field}`);
  addressForChain(row.sourceTokenAddress, row.sourceChainId, `${label}.sourceTokenAddress`);
  addressForChain(row.destinationTokenAddress, row.destinationChainId, `${label}.destinationTokenAddress`);
  addressForChain(row.sourceUsdcAddress, row.sourceChainId, `${label}.sourceUsdcAddress`);
  addressForChain(row.swiftContract, row.sourceChainId, `${label}.swiftContract`);
  nullableAddressForChain(row.forwarderAddress, ETHEREUM_CHAIN_ID, `${label}.forwarderAddress`);
  if (row.forwarderFunctionSelector !== null && !EVM_SELECTOR.test(row.forwarderFunctionSelector)) fail(`${label}.forwarderFunctionSelector is invalid`);
  nullableAddressForChain(row.jupiterProgramAddress, SOLANA_CHAIN_ID, `${label}.jupiterProgramAddress`);
  endpoint(row.builderEndpoint, `${label}.builderEndpoint`);
  endpoint(row.explorerEndpoint, `${label}.explorerEndpoint`);
  if (!Array.isArray(row.dependencies) || !stableEqual(row.dependencies, reviewed.dependencies) || new Set(row.dependencies).size !== row.dependencies.length) fail(`${label}.dependencies differ from the reviewed dependency order`);
  evidenceList(row.evidence, `${label}.evidence`);
  dateString(row.asOfDate, `${label}.asOfDate`);

  const sourceToken = row.sourceChainId === ETHEREUM_CHAIN_ID ? ETHEREUM_EURC : SOLANA_EURC;
  const destinationToken = row.destinationChainId === ETHEREUM_CHAIN_ID ? ETHEREUM_EURC : SOLANA_EURC;
  const sourceUsdc = row.sourceChainId === ETHEREUM_CHAIN_ID ? ETHEREUM_USDC : SOLANA_USDC;
  compareCatalogToken(tokens, sourceToken, `${label}.sourceTokenDeploymentId`);
  compareCatalogToken(tokens, destinationToken, `${label}.destinationTokenDeploymentId`);
  compareCatalogToken(tokens, sourceUsdc, `${label}.sourceUsdcDeploymentId`);
}

/** Return the provenance-free rows in stable capability-ID order. */
export function runtimeProjection(value = canonicalRegistry.capabilities) {
  const rows = Array.isArray(value) ? value : value?.capabilities;
  if (!Array.isArray(rows)) fail("capabilities must be an array");
  return rows
    .map((row) => Object.fromEntries(BRIDGE_CAPABILITY_RUNTIME_KEYS.map((key) => [key, row[key]])))
    .sort((left, right) => left.bridgeCapabilityId < right.bridgeCapabilityId ? -1 : left.bridgeCapabilityId > right.bridgeCapabilityId ? 1 : 0);
}

export const canonicalProjection = runtimeProjection;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function computeDigest(value = canonicalRegistry.capabilities) {
  return createHash("sha256").update(JSON.stringify(stableValue(runtimeProjection(value)))).digest("hex");
}

export function validateBridgeCapabilities(registry = canonicalRegistry, { tokenCatalog = canonicalTokenCatalog } = {}) {
  validateRegistryShape(registry);
  const tokens = catalogMaps(tokenCatalog);
  const seen = new Set();
  for (const [index, row] of registry.capabilities.entries()) {
    if (seen.has(row?.bridgeCapabilityId)) fail(`duplicate bridge capability ID ${row?.bridgeCapabilityId}`);
    seen.add(row?.bridgeCapabilityId);
    validateRow(row, index, registry, tokens);
  }
  if (seen.size !== BRIDGE_CAPABILITY_IDS.length || BRIDGE_CAPABILITY_IDS.some((id) => !seen.has(id))) fail("registry capability IDs do not match the reviewed set");
  const digest = computeDigest(registry.capabilities);
  if (!/^[0-9a-f]{64}$/u.test(digest)) fail("bridge capability digest is invalid");
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

validateBridgeCapabilities();

export const BRIDGE_CAPABILITIES = deepFreeze(canonicalRegistry.capabilities);
export const BRIDGE_CAPABILITIES_AS_OF_DATE = canonicalRegistry.asOfDate;
export const BRIDGE_CAPABILITIES_JSON = JSON.stringify(runtimeProjection(BRIDGE_CAPABILITIES));
export const BRIDGE_CAPABILITIES_CONTENT_DIGEST = computeDigest(BRIDGE_CAPABILITIES);
export const BRIDGE_CAPABILITY_DIGEST = BRIDGE_CAPABILITIES_CONTENT_DIGEST;
export const BRIDGE_RUNTIME_CAPABILITIES = deepFreeze(JSON.parse(BRIDGE_CAPABILITIES_JSON));

export function getBridgeCapability(bridgeCapabilityId) {
  if (typeof bridgeCapabilityId !== "string") return null;
  return BRIDGE_RUNTIME_CAPABILITIES.find((entry) => entry.bridgeCapabilityId === bridgeCapabilityId) ?? null;
}

export function getBridgeCapabilityForRoute(sourceChainId, destinationChainId) {
  if (typeof sourceChainId !== "string" || typeof destinationChainId !== "string") return null;
  return BRIDGE_RUNTIME_CAPABILITIES.find((entry) => entry.sourceChainId === sourceChainId && entry.destinationChainId === destinationChainId) ?? null;
}

export function isCanonicalEvmAddress(value) {
  return typeof value === "string" && EVM_ADDRESS.test(value) && !/^0x0{40}$/u.test(value);
}

export function isEvmAddress(value) {
  return typeof value === "string" && EVM_ADDRESS_ANY_CASE.test(value) && !/^0x0{40}$/iu.test(value);
}

export { ETHEREUM_CHAIN_ID, SOLANA_CHAIN_ID };
