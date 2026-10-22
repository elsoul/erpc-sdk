import { createHash } from "node:crypto";
import canonicalCatalog from "./token-catalog.json" with { type: "json" };

export const TOKEN_CHAIN_IDS = Object.freeze({
  ethereum: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  avalancheC: "eip155:43114",
  base: "eip155:8453",
});

const ALLOWED_CHAIN_IDS = new Set(Object.values(TOKEN_CHAIN_IDS));
const ASSET_KEYS = [
  "assetId",
  "name",
  "representationKind",
  "stableCurrency",
  "underlyingAssetId",
  "economicReferenceAssetId",
  "evidence",
  "asOfDate",
];
const DEPLOYMENT_KEYS = [
  "deploymentId",
  "assetId",
  "chainId",
  "symbol",
  "decimals",
  "standard",
  "address",
  "status",
  "replacedByDeploymentId",
  "evidence",
  "asOfDate",
];
const ALIAS_KEYS = ["namespace", "name", "deploymentId"];
const CATALOG_KEYS = [
  "schemaVersion",
  "catalogVersion",
  "manualAsOf",
  "contentDigest",
  "assets",
  "deployments",
  "aliases",
];
const ASSET_KINDS = new Set(["native", "issued", "wrapped", "bridged", "unclassified"]);
const STABLE_CURRENCIES = new Set(["USD", "EUR", "JPY"]);
const STANDARDS = new Set(["native", "erc20", "spl-token", "spl-token-2022"]);
const STATUSES = new Set(["active", "legacy", "winding-down", "retired"]);
const EVM_CHAINS = new Set([TOKEN_CHAIN_IDS.ethereum, TOKEN_CHAIN_IDS.avalancheC, TOKEN_CHAIN_IDS.base]);
const SOLANA_CHAIN = TOKEN_CHAIN_IDS.solana;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const OUTPUT_PATHS = Object.freeze({
  typescript: "packages/typescript/src/generated/token_catalog.ts",
  rust: "packages/rust/src/generated/token_catalog.rs",
  python: "packages/python/src/erpc_sdk/_token_catalog_data.py",
  go: "packages/go/token_catalog_generated.go",
  ruby: "packages/ruby/lib/erpc_sdk/generated/token_catalog.rb",
});
const RUNTIME_DEPLOYMENT_KEYS = [
  "deploymentId",
  "assetId",
  "name",
  "representationKind",
  "stableCurrency",
  "underlyingAssetId",
  "economicReferenceAssetId",
  "chainId",
  "symbol",
  "decimals",
  "standard",
  "address",
  "status",
  "replacedByDeploymentId",
];

export class CatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

function fail(message) {
  throw new CatalogValidationError(message);
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

function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !/^https?:\/\/\S+$/u.test(entry))) {
    fail(`${label} must be a non-empty list of HTTP(S) URLs`);
  }
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
  if (address === null) return null;
  if (typeof address !== "string") return null;
  if (EVM_CHAINS.has(chainId)) return address.toLowerCase();
  if (chainId === SOLANA_CHAIN) return address;
  return address;
}

function validateAddress(chainId, address, label) {
  if (address === null) fail(`${label} must not be null for a token deployment`);
  nonEmptyString(address, label);
  if (EVM_CHAINS.has(chainId)) {
    if (!/^0x[0-9a-f]{40}$/u.test(address)) fail(`${label} must be a normalized 20-byte EVM address`);
    if (address !== address.toLowerCase()) fail(`${label} must be lowercase`);
    return;
  }
  if (chainId === SOLANA_CHAIN) {
    const decoded = decodeBase58(address);
    if (decoded === null || decoded.length !== 32) fail(`${label} must be a 32-byte Solana base58 address`);
    return;
  }
  fail(`${label} uses an unsupported chain`);
}

function canonicalAsset(asset) {
  const {
    assetId,
    name,
    representationKind,
    stableCurrency,
    underlyingAssetId,
    economicReferenceAssetId,
  } = asset;
  return {
    assetId,
    name,
    representationKind,
    stableCurrency,
    underlyingAssetId,
    economicReferenceAssetId,
  };
}

function canonicalDeployment(deployment) {
  const {
    deploymentId,
    assetId,
    chainId,
    symbol,
    decimals,
    standard,
    address,
    status,
    replacedByDeploymentId,
  } = deployment;
  return {
    deploymentId,
    assetId,
    chainId,
    symbol,
    decimals,
    standard,
    address,
    status,
    replacedByDeploymentId,
  };
}

function canonicalAlias(alias) {
  const { namespace, name, deploymentId } = alias;
  return { namespace, name, deploymentId };
}

export function canonicalProjection(catalog) {
  const assets = [...catalog.assets].sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
  const deployments = [...catalog.deployments].sort((left, right) => left.deploymentId < right.deploymentId ? -1 : left.deploymentId > right.deploymentId ? 1 : 0);
  const aliases = [...catalog.aliases].sort((left, right) => {
    const leftKey = `${left.namespace}\u0000${left.name}`;
    const rightKey = `${right.namespace}\u0000${right.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    manualAsOf: catalog.manualAsOf,
    assets: assets.map(canonicalAsset),
    deployments: deployments.map(canonicalDeployment),
    aliases: aliases.map(canonicalAlias),
  };
}

export function computeDigest(catalog) {
  const projection = canonicalProjection(catalog);
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

function assertReplacementGraph(deployments, byId) {
  const state = new Map();
  const visit = (deploymentId) => {
    const currentState = state.get(deploymentId) ?? 0;
    if (currentState === 1) fail(`replacement cycle includes ${deploymentId}`);
    if (currentState === 2) return;
    state.set(deploymentId, 1);
    const deployment = byId.get(deploymentId);
    if (deployment.replacedByDeploymentId !== null) visit(deployment.replacedByDeploymentId);
    state.set(deploymentId, 2);
  };
  for (const deployment of deployments) visit(deployment.deploymentId);
}

export function validateCatalog(catalog) {
  exactKeys(catalog, CATALOG_KEYS, "catalog");
  if (catalog.schemaVersion !== 1) fail("catalog.schemaVersion must be 1");
  nonEmptyString(catalog.catalogVersion, "catalog.catalogVersion");
  dateString(catalog.manualAsOf, "catalog.manualAsOf");
  if (typeof catalog.contentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(catalog.contentDigest)) {
    fail("catalog.contentDigest must be a lowercase SHA-256 hex digest");
  }
  if (!Array.isArray(catalog.assets) || !Array.isArray(catalog.deployments) || !Array.isArray(catalog.aliases)) {
    fail("catalog assets, deployments, and aliases must be arrays");
  }

  const assetsById = new Map();
  for (const [index, asset] of catalog.assets.entries()) {
    exactKeys(asset, ASSET_KEYS, `assets[${index}]`);
    opaqueId(asset.assetId, `assets[${index}].assetId`);
    if (assetsById.has(asset.assetId)) fail(`duplicate asset ID ${asset.assetId}`);
    assetsById.set(asset.assetId, asset);
    nonEmptyString(asset.name, `assets[${index}].name`);
    if (!ASSET_KINDS.has(asset.representationKind)) fail(`assets[${index}].representationKind is invalid`);
    if (asset.stableCurrency !== null && !STABLE_CURRENCIES.has(asset.stableCurrency)) fail(`assets[${index}].stableCurrency is invalid`);
    for (const [field, value] of [["underlyingAssetId", asset.underlyingAssetId], ["economicReferenceAssetId", asset.economicReferenceAssetId]]) {
      if (value !== null) opaqueId(value, `assets[${index}].${field}`);
    }
    evidenceList(asset.evidence, `assets[${index}].evidence`);
    dateString(asset.asOfDate, `assets[${index}].asOfDate`);
  }

  for (const [index, asset] of catalog.assets.entries()) {
    if (asset.underlyingAssetId !== null && !assetsById.has(asset.underlyingAssetId)) fail(`assets[${index}] references an unknown underlying asset`);
    if (asset.economicReferenceAssetId !== null && !assetsById.has(asset.economicReferenceAssetId)) fail(`assets[${index}] references an unknown economic reference asset`);
    if (asset.underlyingAssetId === asset.assetId || asset.economicReferenceAssetId === asset.assetId) fail(`assets[${index}] cannot reference itself`);
    if (asset.representationKind === "native" && (asset.underlyingAssetId !== null || asset.economicReferenceAssetId !== null)) fail(`native asset ${asset.assetId} cannot have relations`);
    if (asset.representationKind === "issued" && (asset.underlyingAssetId !== null || asset.economicReferenceAssetId !== null)) fail(`issued asset ${asset.assetId} cannot have relations`);
    if (asset.representationKind === "wrapped" && asset.underlyingAssetId === null) fail(`wrapped asset ${asset.assetId} requires underlyingAssetId`);
    if (asset.representationKind === "bridged" && asset.economicReferenceAssetId === null) fail(`bridged asset ${asset.assetId} requires economicReferenceAssetId`);
    if (asset.representationKind === "unclassified"
      && (asset.stableCurrency !== null || asset.underlyingAssetId !== null || asset.economicReferenceAssetId !== null)) {
      fail(`unclassified asset ${asset.assetId} requires null stableCurrency, underlyingAssetId, and economicReferenceAssetId`);
    }
  }

  const deploymentsById = new Map();
  const bindingKeys = new Set();
  for (const [index, deployment] of catalog.deployments.entries()) {
    exactKeys(deployment, DEPLOYMENT_KEYS, `deployments[${index}]`);
    opaqueId(deployment.deploymentId, `deployments[${index}].deploymentId`);
    if (deploymentsById.has(deployment.deploymentId)) fail(`duplicate deployment ID ${deployment.deploymentId}`);
    deploymentsById.set(deployment.deploymentId, deployment);
    opaqueId(deployment.assetId, `deployments[${index}].assetId`);
    if (!assetsById.has(deployment.assetId)) fail(`deployments[${index}] references an unknown asset`);
    if (!ALLOWED_CHAIN_IDS.has(deployment.chainId)) fail(`deployments[${index}].chainId is unsupported`);
    nonEmptyString(deployment.symbol, `deployments[${index}].symbol`);
    if (!Number.isInteger(deployment.decimals) || deployment.decimals < 0 || deployment.decimals > 255) fail(`deployments[${index}].decimals must be an integer from 0 through 255`);
    if (!STANDARDS.has(deployment.standard)) fail(`deployments[${index}].standard is invalid`);
    if (!STATUSES.has(deployment.status)) fail(`deployments[${index}].status is invalid`);
    if (deployment.replacedByDeploymentId !== null) opaqueId(deployment.replacedByDeploymentId, `deployments[${index}].replacedByDeploymentId`);
    evidenceList(deployment.evidence, `deployments[${index}].evidence`);
    dateString(deployment.asOfDate, `deployments[${index}].asOfDate`);

    const asset = assetsById.get(deployment.assetId);
    if (deployment.standard === "native") {
      if (deployment.address !== null || asset.representationKind !== "native") fail(`native deployment ${deployment.deploymentId} must use a native asset and null address`);
    } else {
      if (asset.representationKind === "native") fail(`non-native deployment ${deployment.deploymentId} cannot use a native asset`);
      validateAddress(deployment.chainId, deployment.address, `deployments[${index}].address`);
      if (deployment.address !== normalizeAddress(deployment.chainId, deployment.address)) fail(`deployments[${index}].address is not normalized`);
    }
    if (deployment.standard === "erc20" && !EVM_CHAINS.has(deployment.chainId)) fail(`erc20 deployment ${deployment.deploymentId} must use an EVM chain`);
    if ((deployment.standard === "spl-token" || deployment.standard === "spl-token-2022") && deployment.chainId !== SOLANA_CHAIN) fail(`SPL deployment ${deployment.deploymentId} must use Solana`);
    if (deployment.standard === "native" && !EVM_CHAINS.has(deployment.chainId) && deployment.chainId !== SOLANA_CHAIN) fail(`native deployment ${deployment.deploymentId} uses an unsupported chain`);

    const bindingAddress = deployment.address === null ? "native" : normalizeAddress(deployment.chainId, deployment.address);
    const bindingKey = `${deployment.chainId}\u0000${bindingAddress}`;
    if (bindingKeys.has(bindingKey)) fail(`duplicate normalized chain/address binding ${deployment.chainId} ${bindingAddress}`);
    bindingKeys.add(bindingKey);
  }
  for (const [index, deployment] of catalog.deployments.entries()) {
    if (deployment.replacedByDeploymentId !== null) {
      const replacement = deploymentsById.get(deployment.replacedByDeploymentId);
      if (!replacement) fail(`deployments[${index}] replacement target is unknown`);
      if (replacement.deploymentId === deployment.deploymentId) fail(`deployment ${deployment.deploymentId} cannot replace itself`);
      if (replacement.assetId !== deployment.assetId || replacement.chainId !== deployment.chainId) fail(`replacement ${deployment.deploymentId} must stay on the same asset and chain`);
    }
  }
  assertReplacementGraph(catalog.deployments, deploymentsById);

  const aliasesByKey = new Map();
  for (const [index, alias] of catalog.aliases.entries()) {
    exactKeys(alias, ALIAS_KEYS, `aliases[${index}]`);
    nonEmptyString(alias.namespace, `aliases[${index}].namespace`);
    if (!Object.hasOwn(TOKEN_CHAIN_IDS, alias.namespace)) {
      fail(`aliases[${index}].namespace must be one of ${Object.keys(TOKEN_CHAIN_IDS).join(", ")}`);
    }
    nonEmptyString(alias.name, `aliases[${index}].name`);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(alias.name)) fail(`aliases[${index}].name must be uppercase ASCII with optional underscores`);
    opaqueId(alias.deploymentId, `aliases[${index}].deploymentId`);
    const targetDeployment = deploymentsById.get(alias.deploymentId);
    if (!targetDeployment) fail(`aliases[${index}] references an unknown deployment`);
    if (targetDeployment.chainId !== TOKEN_CHAIN_IDS[alias.namespace]) {
      fail(`aliases[${index}] namespace ${alias.namespace} must target a deployment on ${TOKEN_CHAIN_IDS[alias.namespace]}`);
    }
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
  const currentAssets = new Map(current.assets.map((asset) => [asset.assetId, asset]));
  const currentDeployments = new Map(current.deployments.map((deployment) => [deployment.deploymentId, deployment]));
  const currentAliases = new Map(current.aliases.map((alias) => [`${alias.namespace}\u0000${alias.name}`, alias]));
  for (const asset of previous.assets) {
    const next = currentAssets.get(asset.assetId);
    if (!next) fail(`historical asset ID removed: ${asset.assetId}`);
  }
  for (const deployment of previous.deployments) {
    const next = currentDeployments.get(deployment.deploymentId);
    if (!next) fail(`historical deployment ID removed: ${deployment.deploymentId}`);
    const previousBinding = [deployment.assetId, deployment.chainId, deployment.standard, normalizeAddress(deployment.chainId, deployment.address)];
    const currentBinding = [next.assetId, next.chainId, next.standard, normalizeAddress(next.chainId, next.address)];
    if (JSON.stringify(previousBinding) !== JSON.stringify(currentBinding)) fail(`historical deployment re-bound: ${deployment.deploymentId}`);
  }
  for (const alias of previous.aliases) {
    const next = currentAliases.get(`${alias.namespace}\u0000${alias.name}`);
    if (!next) fail(`historical alias removed: ${alias.namespace}:${alias.name}`);
    if (next.deploymentId !== alias.deploymentId) fail(`historical alias retargeted: ${alias.namespace}:${alias.name}`);
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

function assetFor(catalog, assetId) {
  return catalog.assets.find((asset) => asset.assetId === assetId) ?? null;
}

function materializeAssets(catalog) {
  return [...catalog.assets]
    .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0)
    .map((asset) => ({
    assetId: asset.assetId,
    name: asset.name,
    representationKind: asset.representationKind,
    stableCurrency: asset.stableCurrency,
    underlyingAssetId: asset.underlyingAssetId,
    economicReferenceAssetId: asset.economicReferenceAssetId,
    }));
}

function orderedAliases(catalog) {
  return [...catalog.aliases].sort((left, right) => {
    const leftKey = `${left.namespace}\u0000${left.name}`;
    const rightKey = `${right.namespace}\u0000${right.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function publicDeployment(catalog, deployment) {
  const asset = assetFor(catalog, deployment.assetId);
  if (!asset) return null;
  return Object.freeze({
    deploymentId: deployment.deploymentId,
    assetId: deployment.assetId,
    name: asset.name,
    representationKind: asset.representationKind,
    stableCurrency: asset.stableCurrency,
    underlyingAssetId: asset.underlyingAssetId,
    economicReferenceAssetId: asset.economicReferenceAssetId,
    chainId: deployment.chainId,
    symbol: deployment.symbol,
    decimals: deployment.decimals,
    standard: deployment.standard,
    address: deployment.address,
    status: deployment.status,
    replacedByDeploymentId: deployment.replacedByDeploymentId,
  });
}

export function getTokenAsset(assetId) {
  const asset = assetFor(CATALOG, assetId);
  if (!asset) return null;
  return Object.freeze({
    assetId: asset.assetId,
    name: asset.name,
    representationKind: asset.representationKind,
    stableCurrency: asset.stableCurrency,
    underlyingAssetId: asset.underlyingAssetId,
    economicReferenceAssetId: asset.economicReferenceAssetId,
  });
}

export function getDeployment(deploymentId) {
  const deployment = CATALOG.deployments.find((entry) => entry.deploymentId === deploymentId);
  return deployment ? publicDeployment(CATALOG, deployment) : null;
}

export function getNativeDeployment(chainId) {
  const deployment = CATALOG.deployments.find((entry) => entry.chainId === chainId && entry.standard === "native");
  return deployment ? publicDeployment(CATALOG, deployment) : null;
}

export function lookupDeployment(chainId, address) {
  if (address === null || typeof address !== "string") return null;
  const normalized = normalizeAddress(chainId, address);
  const deployment = CATALOG.deployments.find((entry) => entry.chainId === chainId && entry.address !== null && entry.address === normalized);
  return deployment ? publicDeployment(CATALOG, deployment) : null;
}

export function resolveAlias(namespace, name) {
  const alias = CATALOG.aliases.find((entry) => entry.namespace === namespace && entry.name === name);
  return alias ? getDeployment(alias.deploymentId) : null;
}

export function listDeployments({ status, chainId, includeRetired = true } = {}) {
  return Object.freeze([...CATALOG.deployments]
    .sort((left, right) => left.deploymentId < right.deploymentId ? -1 : left.deploymentId > right.deploymentId ? 1 : 0)
    .filter((deployment) => (status === undefined || deployment.status === status)
      && (chainId === undefined || deployment.chainId === chainId)
      && (includeRetired || deployment.status !== "retired"))
    .map((deployment) => publicDeployment(CATALOG, deployment)));
}

export function materializeDeployments(catalog = CATALOG) {
  validateCatalog(catalog);
  return [...catalog.deployments]
    .sort((left, right) => left.deploymentId < right.deploymentId ? -1 : left.deploymentId > right.deploymentId ? 1 : 0)
    .map((deployment) => {
    const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
    return {
      deploymentId: deployment.deploymentId,
      assetId: deployment.assetId,
      name: asset.name,
      representationKind: asset.representationKind,
      stableCurrency: asset.stableCurrency,
      underlyingAssetId: asset.underlyingAssetId,
      economicReferenceAssetId: asset.economicReferenceAssetId,
      chainId: deployment.chainId,
      symbol: deployment.symbol,
      decimals: deployment.decimals,
      standard: deployment.standard,
      address: deployment.address,
      status: deployment.status,
      replacedByDeploymentId: deployment.replacedByDeploymentId,
    };
    });
}

function aliasesByNamespace(catalog) {
  const groups = {};
  for (const alias of orderedAliases(catalog)) (groups[alias.namespace] ??= []).push(alias);
  return groups;
}

function identifier(value, language) {
  if (/^[A-Z][A-Z0-9_]*$/u.test(value)) return value;
  let result = value.replace(/[^A-Za-z0-9]+/gu, "_");
  if (language === "typescript") {
    result = result.toLowerCase().replace(/_([a-z0-9])/gu, (_, character) => character.toUpperCase());
    if (!/^[a-zA-Z_]/u.test(result)) result = `_${result}`;
    return result || "_alias";
  }
  if (language === "python") {
    result = result.toLowerCase();
    if (!/^[a-z_]/u.test(result)) result = `_${result}`;
    return result || "_alias";
  }
  if (language === "go") {
    result = result.replace(/(?:^|_)([a-z])/gu, (_, character) => character.toUpperCase());
    if (!/^[A-Za-z_]/u.test(result)) result = `_${result}`;
    return result || "Alias";
  }
  if (language === "ruby") {
    result = result.toLowerCase();
    if (!/^[a-z_]/u.test(result)) result = `_${result}`;
    return result || "_alias";
  }
  result = result.toUpperCase();
  if (!/^[A-Z_]/u.test(result)) result = `_${result}`;
  return result || "_ALIAS";
}

function groupedAliases(catalog, language) {
  const groups = {};
  const used = {};
  for (const alias of orderedAliases(catalog)) {
    const namespace = alias.namespace;
    const groupName = (language === "rust" || language === "python" || language === "ruby") && namespace === "avalancheC"
      ? "avalanche_c"
      : namespace;
    const property = alias.name;
    const key = `${groupName}\u0000${property}`;
    const count = used[key] ?? 0;
    used[key] = count + 1;
    if (count !== 0) fail(`alias group collision: ${alias.namespace}:${alias.name}`);
    (groups[groupName] ??= []).push({ property, deploymentId: alias.deploymentId, sourceName: alias.name });
  }
  return groups;
}

function aliasGroupName(namespace, language) {
  return (language === "rust" || language === "python" || language === "ruby") && namespace === "avalancheC"
    ? "avalanche_c"
    : namespace;
}

function tokenAliasReference(alias, language) {
  const group = aliasGroupName(alias.namespace, language);
  if (language === "typescript") return `tokens.${group}.${alias.name}`;
  if (language === "rust") return `tokens::${group}::${alias.name}`;
  if (language === "python") return `tokens.${group}.${alias.name}`;
  if (language === "go") return `Token${identifier(alias.namespace, "go")}${alias.name}`;
  const constant = group === "avalanche_c" ? "AvalancheC" : group[0].toUpperCase() + group.slice(1);
  return `ERPC::Tokens::${constant}[:${alias.name}]`;
}

function q(value) {
  return JSON.stringify(value);
}

function tsValue(value) {
  return JSON.stringify(value, null, 2);
}

// Output contract: runtime records contain only the canonical projection and
// global catalog metadata. Public alias groups are the single emitted source
// for alias target IDs; alias rows reference those groups in every language.
function renderTypeScript(catalog) {
  const assets = materializeAssets(catalog);
  const deployments = materializeDeployments(catalog);
  const groups = groupedAliases(catalog, "typescript");
  const groupValue = Object.fromEntries(Object.entries(groups).map(([name, entries]) => [name, Object.fromEntries(entries.map((entry) => [entry.property, entry.deploymentId]))]));
  const lines = [
    "/* Generated by registry/generate-token-catalog.mjs. Do not edit. */",
    "",
    "export type TokenRepresentationKind = \"native\" | \"issued\" | \"wrapped\" | \"bridged\" | \"unclassified\";",
    "export type TokenStandard = \"native\" | \"erc20\" | \"spl-token\" | \"spl-token-2022\";",
    "export type TokenStatus = \"active\" | \"legacy\" | \"winding-down\" | \"retired\";",
    "export type TokenStableCurrency = \"USD\" | \"EUR\" | \"JPY\" | null;",
    "",
    "export interface TokenAsset {",
    "  readonly assetId: string;",
    "  readonly name: string;",
    "  readonly representationKind: TokenRepresentationKind;",
    "  readonly stableCurrency: TokenStableCurrency;",
    "  readonly underlyingAssetId: string | null;",
    "  readonly economicReferenceAssetId: string | null;",
    "}",
    "",
    "export interface TokenDeployment {",
    "  readonly deploymentId: string;",
    "  readonly assetId: string;",
    "  readonly name: string;",
    "  readonly representationKind: TokenRepresentationKind;",
    "  readonly stableCurrency: TokenStableCurrency;",
    "  readonly underlyingAssetId: string | null;",
    "  readonly economicReferenceAssetId: string | null;",
    "  readonly chainId: TokenChainId;",
    "  readonly symbol: string;",
    "  readonly decimals: number;",
    "  readonly standard: TokenStandard;",
    "  readonly address: string | null;",
    "  readonly status: TokenStatus;",
    "  readonly replacedByDeploymentId: string | null;",
    "}",
    "",
    "export interface TokenAlias {",
    "  readonly namespace: string;",
    "  readonly name: string;",
    "  readonly deploymentId: string;",
    "}",
    "",
    "const deepFreeze = <T>(value: T): Readonly<T> => {",
    "  if (value && typeof value === \"object\" && !Object.isFrozen(value)) {",
    "    Object.freeze(value);",
    "    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);",
    "  }",
    "  return value as Readonly<T>;",
    "};",
    "",
    `export const TOKEN_CATALOG_VERSION = ${q(catalog.catalogVersion)} as const;`,
    `export const TOKEN_CATALOG_AS_OF_DATE = ${q(catalog.manualAsOf)} as const;`,
    `export const TOKEN_CATALOG_CONTENT_DIGEST = ${q(catalog.contentDigest)} as const;`,
    `export const TOKEN_CHAIN_IDS = deepFreeze(${tsValue({ ethereumMainnet: TOKEN_CHAIN_IDS.ethereum, solanaMainnet: TOKEN_CHAIN_IDS.solana, avalancheCMainnet: TOKEN_CHAIN_IDS.avalancheC, baseMainnet: TOKEN_CHAIN_IDS.base })}) as {`,
    `  readonly ethereumMainnet: ${q(TOKEN_CHAIN_IDS.ethereum)};`,
    `  readonly solanaMainnet: ${q(TOKEN_CHAIN_IDS.solana)};`,
    `  readonly avalancheCMainnet: ${q(TOKEN_CHAIN_IDS.avalancheC)};`,
    `  readonly baseMainnet: ${q(TOKEN_CHAIN_IDS.base)};`,
    "};",
    "export type TokenChainId = (typeof TOKEN_CHAIN_IDS)[keyof typeof TOKEN_CHAIN_IDS];",
    "",
    `export const tokens = deepFreeze(${tsValue(groupValue)} as const);`,
    `export const TOKEN_ASSETS: readonly TokenAsset[] = deepFreeze(${tsValue(assets)}) as readonly TokenAsset[];`,
    `export const TOKEN_DEPLOYMENTS: readonly TokenDeployment[] = deepFreeze(${tsValue(deployments)}) as readonly TokenDeployment[];`,
    "export const TOKEN_ALIASES: readonly TokenAlias[] = deepFreeze([",
    ...orderedAliases(catalog).map((alias) => `  { namespace: ${q(alias.namespace)}, name: ${q(alias.name)}, deploymentId: ${tokenAliasReference(alias, "typescript")} },`),
    "]) as readonly TokenAlias[];",
  ];
  return lines.join("\n") + "\n";
}

const RUST_ENUMS = Object.freeze({
  representationKind: { native: "Native", issued: "Issued", wrapped: "Wrapped", bridged: "Bridged", unclassified: "Unclassified" },
  standard: { native: "Native", erc20: "Erc20", "spl-token": "SplToken", "spl-token-2022": "SplToken2022" },
  status: { active: "Active", legacy: "Legacy", "winding-down": "WindingDown", retired: "Retired" },
});

function rustString(value) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replace(/[\u0000-\u001f\u007f-\u{10ffff}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`)}"`;
}

function rustOption(value) {
  return value === null ? "None" : `Some(${rustString(value)})`;
}

function rustSlice(values) {
  return values.length === 0 ? "&[]" : `&[${values.map((value) => rustString(value)).join(", ")}]`;
}

function rustAliasConst(entry) {
  const prefix = `        pub const ${entry.property}`;
  const value = rustString(entry.deploymentId);
  const declaration = `${prefix}: &str = ${value};`;
  if (declaration.length <= 100) return [declaration];
  if (`${prefix}: &str =`.length <= 100) return [`${prefix}: &str =`, `            ${value};`];
  return [`${prefix}:`, "            &str =", `            ${value};`];
}

function renderRust(catalog) {
  const assets = materializeAssets(catalog);
  const deployments = materializeDeployments(catalog);
  const groups = groupedAliases(catalog, "rust");
  const tokenGroups = Object.entries(groups).flatMap(([group, entries]) => [
    `    pub mod ${group} {`,
    ...entries.flatMap(rustAliasConst),
    "    }",
  ]);
  const lines = [
    "// Generated by registry/generate-token-catalog.mjs. Do not edit.",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub enum TokenRepresentationKind {",
    "    Native,",
    "    Issued,",
    "    Wrapped,",
    "    Bridged,",
    "    Unclassified,",
    "}",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub enum TokenStandard {",
    "    Native,",
    "    Erc20,",
    "    SplToken,",
    "    SplToken2022,",
    "}",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub enum TokenStatus {",
    "    Active,",
    "    Legacy,",
    "    WindingDown,",
    "    Retired,",
    "}",
    "",
    "pub type TokenChainId = &'static str;",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub struct TokenAsset {",
    "    pub asset_id: &'static str,",
    "    pub name: &'static str,",
    "    pub representation_kind: TokenRepresentationKind,",
    "    pub stable_currency: Option<&'static str>,",
    "    pub underlying_asset_id: Option<&'static str>,",
    "    pub economic_reference_asset_id: Option<&'static str>,",
    "}",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub struct TokenDeployment {",
    "    pub deployment_id: &'static str,",
    "    pub asset_id: &'static str,",
    "    pub name: &'static str,",
    "    pub representation_kind: TokenRepresentationKind,",
    "    pub stable_currency: Option<&'static str>,",
    "    pub underlying_asset_id: Option<&'static str>,",
    "    pub economic_reference_asset_id: Option<&'static str>,",
    "    pub chain_id: TokenChainId,",
    "    pub symbol: &'static str,",
    "    pub decimals: u8,",
    "    pub standard: TokenStandard,",
    "    pub address: Option<&'static str>,",
    "    pub status: TokenStatus,",
    "    pub replaced_by_deployment_id: Option<&'static str>,",
    "}",
    "",
    "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
    "pub struct TokenAlias {",
    "    pub namespace: &'static str,",
    "    pub name: &'static str,",
    "    pub deployment_id: &'static str,",
    "}",
    "",
    `pub const TOKEN_CATALOG_VERSION: &str = ${rustString(catalog.catalogVersion)};`,
    `pub const TOKEN_CATALOG_AS_OF_DATE: &str = ${rustString(catalog.manualAsOf)};`,
    "pub const TOKEN_CATALOG_CONTENT_DIGEST: &str =",
    `    ${rustString(catalog.contentDigest)};`,
    "",
    "pub mod token_chain_ids {",
    `    pub const ETHEREUM_MAINNET: super::TokenChainId = ${rustString(TOKEN_CHAIN_IDS.ethereum)};`,
    `    pub const SOLANA_MAINNET: super::TokenChainId = ${rustString(TOKEN_CHAIN_IDS.solana)};`,
    `    pub const AVALANCHE_C_MAINNET: super::TokenChainId = ${rustString(TOKEN_CHAIN_IDS.avalancheC)};`,
    `    pub const BASE_MAINNET: super::TokenChainId = ${rustString(TOKEN_CHAIN_IDS.base)};`,
    "}",
    "",
    "pub mod tokens {",
    ...tokenGroups,
    "}",
    "",
    "pub const TOKEN_CHAIN_IDS: &[(&str, TokenChainId)] = &[",
    `    ("ethereum", ${rustString(TOKEN_CHAIN_IDS.ethereum)}),`,
    `    ("solana", ${rustString(TOKEN_CHAIN_IDS.solana)}),`,
    `    ("avalancheC", ${rustString(TOKEN_CHAIN_IDS.avalancheC)}),`,
    `    ("base", ${rustString(TOKEN_CHAIN_IDS.base)}),`,
    "];",
    "",
    "pub static TOKEN_ASSETS: &[TokenAsset] = &[",
  ];
  for (const asset of assets) {
    lines.push(
      "    TokenAsset {",
      `        asset_id: ${rustString(asset.assetId)},`,
      `        name: ${rustString(asset.name)},`,
      `        representation_kind: TokenRepresentationKind::${RUST_ENUMS.representationKind[asset.representationKind]},`,
      `        stable_currency: ${rustOption(asset.stableCurrency)},`,
      `        underlying_asset_id: ${rustOption(asset.underlyingAssetId)},`,
      `        economic_reference_asset_id: ${rustOption(asset.economicReferenceAssetId)},`,
      "    },",
    );
  }
  lines.push("];", "", "pub static TOKEN_DEPLOYMENTS: &[TokenDeployment] = &[");
  for (const deployment of deployments) {
    lines.push(
      "    TokenDeployment {",
      `        deployment_id: ${rustString(deployment.deploymentId)},`,
      `        asset_id: ${rustString(deployment.assetId)},`,
      `        name: ${rustString(deployment.name)},`,
      `        representation_kind: TokenRepresentationKind::${RUST_ENUMS.representationKind[deployment.representationKind]},`,
      `        stable_currency: ${rustOption(deployment.stableCurrency)},`,
      `        underlying_asset_id: ${rustOption(deployment.underlyingAssetId)},`,
      `        economic_reference_asset_id: ${rustOption(deployment.economicReferenceAssetId)},`,
      `        chain_id: ${rustString(deployment.chainId)},`,
      `        symbol: ${rustString(deployment.symbol)},`,
      `        decimals: ${deployment.decimals},`,
      `        standard: TokenStandard::${RUST_ENUMS.standard[deployment.standard]},`,
      `        address: ${rustOption(deployment.address)},`,
      `        status: TokenStatus::${RUST_ENUMS.status[deployment.status]},`,
      `        replaced_by_deployment_id: ${rustOption(deployment.replacedByDeploymentId)},`,
      "    },",
    );
  }
  lines.push("];", "", "pub static TOKEN_ALIASES: &[TokenAlias] = &[");
  for (const alias of orderedAliases(catalog)) {
    lines.push(
      "    TokenAlias {",
      `        namespace: ${rustString(alias.namespace)},`,
      `        name: ${rustString(alias.name)},`,
      `        deployment_id: ${tokenAliasReference(alias, "rust")},`,
      "    },",
    );
  }
  lines.push("];");
  return lines.join("\n") + "\n";
}

function renderPython(catalog) {
  const assets = materializeAssets(catalog);
  const deployments = materializeDeployments(catalog);
  const groups = groupedAliases(catalog, "python");
  const groupDefinitions = [];
  for (const [group, entries] of Object.entries(groups)) {
    const className = `_${group.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join("")}Tokens`;
    groupDefinitions.push(`class ${className}(NamedTuple):`);
    for (const entry of entries) groupDefinitions.push(`    ${entry.property}: str`);
    groupDefinitions.push("");
  }
  const rootFields = Object.keys(groups).map((group) => `    ${group}: _${group.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join("")}Tokens`);
  const tokenValues = [];
  for (const [group, entries] of Object.entries(groups)) {
    const className = `_${group.split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join("")}Tokens`;
    tokenValues.push(`    ${group}=${className}(`);
    for (const entry of entries) tokenValues.push(`        ${entry.property}=${q(entry.deploymentId)},`);
    tokenValues.push("    ),");
  }
  const aliasRows = orderedAliases(catalog).flatMap((alias) => {
    const values = [pythonValue(alias.namespace), pythonValue(alias.name), tokenAliasReference(alias, "python")];
    const inline = `    TokenAlias(${values.join(", ")}),`;
    return inline.length <= 100
      ? [inline]
      : ["    TokenAlias(", ...values.map((value) => `        ${value},`), "    ),"];
  });
  const lines = [
    "# Generated by registry/generate-token-catalog.mjs. Do not edit.",
    "from __future__ import annotations",
    "",
    "from types import MappingProxyType",
    "from typing import Literal, NamedTuple",
    "",
    "TokenRepresentationKind = Literal[\"native\", \"issued\", \"wrapped\", \"bridged\", \"unclassified\"]",
    "TokenStandard = Literal[\"native\", \"erc20\", \"spl-token\", \"spl-token-2022\"]",
    "TokenStatus = Literal[\"active\", \"legacy\", \"winding-down\", \"retired\"]",
    "TokenStableCurrency = Literal[\"USD\", \"EUR\", \"JPY\"] | None",
    "TokenChainId = str",
    "",
    "class TokenAsset(NamedTuple):",
    "    asset_id: str",
    "    name: str",
    "    representation_kind: TokenRepresentationKind",
    "    stable_currency: TokenStableCurrency",
    "    underlying_asset_id: str | None",
    "    economic_reference_asset_id: str | None",
    "",
    "class TokenDeployment(NamedTuple):",
    "    deployment_id: str",
    "    asset_id: str",
    "    name: str",
    "    representation_kind: TokenRepresentationKind",
    "    stable_currency: TokenStableCurrency",
    "    underlying_asset_id: str | None",
    "    economic_reference_asset_id: str | None",
    "    chain_id: TokenChainId",
    "    symbol: str",
    "    decimals: int",
    "    standard: TokenStandard",
    "    address: str | None",
    "    status: TokenStatus",
    "    replaced_by_deployment_id: str | None",
    "",
    "class TokenAlias(NamedTuple):",
    "    namespace: str",
    "    name: str",
    "    deployment_id: str",
    "",
    `TOKEN_CATALOG_VERSION = ${q(catalog.catalogVersion)}`,
    `TOKEN_CATALOG_AS_OF_DATE = ${q(catalog.manualAsOf)}`,
    `TOKEN_CATALOG_CONTENT_DIGEST = ${q(catalog.contentDigest)}`,
    "TOKEN_CHAIN_IDS = MappingProxyType({",
    `    "ethereum": ${q(TOKEN_CHAIN_IDS.ethereum)},`,
    `    "solana": ${q(TOKEN_CHAIN_IDS.solana)},`,
    `    "avalancheC": ${q(TOKEN_CHAIN_IDS.avalancheC)},`,
    `    "base": ${q(TOKEN_CHAIN_IDS.base)},`,
    "})",
    "",
    ...groupDefinitions,
    "class _Tokens(NamedTuple):",
    ...rootFields,
    "",
    "tokens = _Tokens(",
    ...tokenValues,
    ")",
    "TOKENS = tokens",
    "",
    "TOKEN_ASSETS: tuple[TokenAsset, ...] = (",
  ];
  for (const asset of assets) lines.push(
    "    TokenAsset(",
    `        asset_id=${pythonValue(asset.assetId)},`,
    `        name=${pythonValue(asset.name)},`,
    `        representation_kind=${pythonValue(asset.representationKind)},`,
    `        stable_currency=${pythonValue(asset.stableCurrency)},`,
    `        underlying_asset_id=${pythonValue(asset.underlyingAssetId)},`,
    `        economic_reference_asset_id=${pythonValue(asset.economicReferenceAssetId)},`,
    "    ),",
  );
  lines.push(")", "", "TOKEN_DEPLOYMENTS: tuple[TokenDeployment, ...] = (");
  for (const deployment of deployments) lines.push(
    "    TokenDeployment(",
    `        deployment_id=${pythonValue(deployment.deploymentId)},`,
    `        asset_id=${pythonValue(deployment.assetId)},`,
    `        name=${pythonValue(deployment.name)},`,
    `        representation_kind=${pythonValue(deployment.representationKind)},`,
    `        stable_currency=${pythonValue(deployment.stableCurrency)},`,
    `        underlying_asset_id=${pythonValue(deployment.underlyingAssetId)},`,
    `        economic_reference_asset_id=${pythonValue(deployment.economicReferenceAssetId)},`,
    `        chain_id=${pythonValue(deployment.chainId)},`,
    `        symbol=${pythonValue(deployment.symbol)},`,
    `        decimals=${deployment.decimals},`,
    `        standard=${pythonValue(deployment.standard)},`,
    `        address=${pythonValue(deployment.address)},`,
    `        status=${pythonValue(deployment.status)},`,
    `        replaced_by_deployment_id=${pythonValue(deployment.replacedByDeploymentId)},`,
    "    ),",
  );
  lines.push(")", "", "TOKEN_ALIASES: tuple[TokenAlias, ...] = (");
  lines.push(...aliasRows, ")", "");
  return lines.join("\n");
}

function pythonValue(value) {
  if (value === null) return "None";
  if (typeof value === "string") return q(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `(${value.map(pythonValue).join(", ")}${value.length === 1 ? "," : ""})`;
  return `{${Object.entries(value).map(([key, child]) => `${q(key)}: ${pythonValue(child)}`).join(", ")}}`;
}

function goString(value) {
  return q(value);
}

function goPointer(value) {
  return value === null ? "nil" : `tokenString(${goString(value)})`;
}

function formatGoIndent(lines) {
  return lines.map((line) => {
    const leading = line.match(/^ */u)?.[0].length ?? 0;
    if (leading === 0 || leading % 4 !== 0) return line;
    return `${"\t".repeat(leading / 4)}${line.slice(leading)}`;
  });
}

function alignGoConstBlock(lines, start, end) {
  const entries = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^(\t+)([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s+)(.+)$/u);
    if (!match) return;
    entries.push({ index, indent: match[1], name: match[2], type: match[3], value: match[4] });
  }
  const maxName = Math.max(...entries.map((entry) => entry.name.length));
  const maxType = Math.max(...entries.map((entry) => entry.type.length));
  for (const entry of entries) {
    lines[entry.index] = `${entry.indent}${entry.name}${" ".repeat(maxName - entry.name.length + 1)}${entry.type}${" ".repeat(maxType - entry.type.length + 1)}= ${entry.value}`;
  }
}

function alignGoStructBlock(lines, start, end) {
  const entries = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^(\t+)([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/u);
    if (!match) return;
    entries.push({ index, indent: match[1], name: match[2], type: match[3].trim() });
  }
  const maxName = Math.max(...entries.map((entry) => entry.name.length));
  for (const entry of entries) lines[entry.index] = `${entry.indent}${entry.name}${" ".repeat(maxName - entry.name.length + 1)}${entry.type}`;
}

function alignGoMapBlock(lines, start, end) {
  const entries = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(/^(\t+)"([^"]+)":\s+(.+),$/u);
    if (!match) return;
    entries.push({ index, indent: match[1], key: match[2], value: match[3] });
  }
  const maxKey = Math.max(...entries.map((entry) => entry.key.length));
  for (const entry of entries) lines[entry.index] = `${entry.indent}"${entry.key}":${" ".repeat(maxKey - entry.key.length + 1)}${entry.value},`;
}

function alignGoLiteralFieldRuns(lines) {
  let index = 0;
  while (index < lines.length) {
    const first = lines[index].match(/^(\t+)([A-Za-z_][A-Za-z0-9_]*):\s+(.+),$/u);
    if (!first || /,\s+[A-Za-z_][A-Za-z0-9_]*:/u.test(first[3])) {
      index += 1;
      continue;
    }
    const entries = [];
    const indent = first[1];
    while (index < lines.length) {
      const match = lines[index].match(/^(\t+)([A-Za-z_][A-Za-z0-9_]*):\s+(.+),$/u);
      if (!match || match[1] !== indent || /,\s+[A-Za-z_][A-Za-z0-9_]*:/u.test(match[3])) break;
      entries.push({ index, name: match[2], value: match[3] });
      index += 1;
    }
    if (entries.length > 1) {
      const maxName = Math.max(...entries.map((entry) => entry.name.length));
      for (const entry of entries) lines[entry.index] = `${indent}${entry.name}:${" ".repeat(maxName - entry.name.length + 1)}${entry.value},`;
    }
  }
}

function formatGoSource(source) {
  const lines = formatGoIndent(source.split("\n"));
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === "const (") {
      const end = lines.indexOf(")", index + 1);
      if (end !== -1) alignGoConstBlock(lines, index, end);
    }
    if (/^type [A-Za-z_][A-Za-z0-9_]* struct \{$/u.test(lines[index])) {
      const end = lines.indexOf("}", index + 1);
      if (end !== -1) alignGoStructBlock(lines, index, end);
    }
    if (lines[index] === "\treturn map[string]TokenChainID{") {
      const end = lines.indexOf("\t}", index + 1);
      if (end !== -1) alignGoMapBlock(lines, index, end);
    }
  }
  alignGoLiteralFieldRuns(lines);
  return lines.join("\n");
}

function renderGo(catalog) {
  const assets = materializeAssets(catalog);
  const deployments = materializeDeployments(catalog);
  const groups = groupedAliases(catalog, "go");
  const groupTypeName = (group) => `Token${identifier(group, "go")}Aliases`;
  const aliasConstName = (group, property) => `Token${identifier(group, "go")}${property}`;
  const lines = [
    "// Generated by registry/generate-token-catalog.mjs. Do not edit.",
    "",
    "package erpc",
    "",
    "type TokenRepresentationKind string",
    "type TokenStandard string",
    "type TokenStatus string",
    "type TokenChainID = string",
    "type TokenChainId = TokenChainID",
    "",
    "const (",
    '    TokenRepresentationNative TokenRepresentationKind = "native"',
    '    TokenRepresentationIssued TokenRepresentationKind = "issued"',
    '    TokenRepresentationWrapped TokenRepresentationKind = "wrapped"',
    '    TokenRepresentationBridged TokenRepresentationKind = "bridged"',
    '    TokenRepresentationUnclassified TokenRepresentationKind = "unclassified"',
    '    TokenStandardNative TokenStandard = "native"',
    '    TokenStandardERC20 TokenStandard = "erc20"',
    '    TokenStandardSPLToken TokenStandard = "spl-token"',
    '    TokenStandardSPLToken2022 TokenStandard = "spl-token-2022"',
    '    TokenStatusActive TokenStatus = "active"',
    '    TokenStatusLegacy TokenStatus = "legacy"',
    '    TokenStatusWindingDown TokenStatus = "winding-down"',
    '    TokenStatusRetired TokenStatus = "retired"',
    ")",
    "",
    "type TokenAsset struct {",
    "    AssetID string",
    "    Name string",
    "    RepresentationKind TokenRepresentationKind",
    "    StableCurrency *string",
    "    UnderlyingAssetID *string",
    "    EconomicReferenceAssetID *string",
    "}",
    "",
    "type TokenDeployment struct {",
    "    DeploymentID string",
    "    AssetID string",
    "    Name string",
    "    RepresentationKind TokenRepresentationKind",
    "    StableCurrency *string",
    "    UnderlyingAssetID *string",
    "    EconomicReferenceAssetID *string",
    "    ChainID TokenChainId",
    "    Symbol string",
    "    Decimals uint8",
    "    Standard TokenStandard",
    "    Address *string",
    "    Status TokenStatus",
    "    ReplacedByDeploymentID *string",
    "}",
    "",
    "type TokenAlias struct {",
    "    Namespace string",
    "    Name string",
    "    DeploymentID string",
    "}",
    "",
    "func tokenString(value string) *string { copied := value; return &copied }",
    "",
    `const TOKEN_CATALOG_VERSION = ${goString(catalog.catalogVersion)}`,
    `const TOKEN_CATALOG_AS_OF_DATE = ${goString(catalog.manualAsOf)}`,
    `const TOKEN_CATALOG_CONTENT_DIGEST = ${goString(catalog.contentDigest)}`,
    `const TokenEthereumChainID TokenChainID = ${goString(TOKEN_CHAIN_IDS.ethereum)}`,
    `const TokenSolanaChainID TokenChainID = ${goString(TOKEN_CHAIN_IDS.solana)}`,
    `const TokenAvalancheCChainID TokenChainID = ${goString(TOKEN_CHAIN_IDS.avalancheC)}`,
    `const TokenBaseChainID TokenChainID = ${goString(TOKEN_CHAIN_IDS.base)}`,
    "",
    "func TokenChainIDs() map[string]TokenChainID {",
    "    return map[string]TokenChainID{",
    `        "ethereum": TokenEthereumChainID,`,
    `        "solana": TokenSolanaChainID,`,
    `        "avalancheC": TokenAvalancheCChainID,`,
    `        "base": TokenBaseChainID,`,
    "    }",
    "}",
    "",
    "func TokenAssets() []TokenAsset {",
    "    return []TokenAsset{",
  ];
  for (const asset of assets) lines.push(
    "        {",
    `            AssetID: ${goString(asset.assetId)}, Name: ${goString(asset.name)}, RepresentationKind: TokenRepresentationKind(${goString(asset.representationKind)}),`,
    `            StableCurrency: ${goPointer(asset.stableCurrency)}, UnderlyingAssetID: ${goPointer(asset.underlyingAssetId)}, EconomicReferenceAssetID: ${goPointer(asset.economicReferenceAssetId)},`,
    "        },",
  );
  lines.push("    }", "}", "", "func TokenDeployments() []TokenDeployment {", "    return []TokenDeployment{");
  for (const deployment of deployments) lines.push(
    "        {",
    `            DeploymentID: ${goString(deployment.deploymentId)}, AssetID: ${goString(deployment.assetId)}, Name: ${goString(deployment.name)}, RepresentationKind: TokenRepresentationKind(${goString(deployment.representationKind)}),`,
    `            StableCurrency: ${goPointer(deployment.stableCurrency)}, UnderlyingAssetID: ${goPointer(deployment.underlyingAssetId)}, EconomicReferenceAssetID: ${goPointer(deployment.economicReferenceAssetId)},`,
    `            ChainID: TokenChainID(${goString(deployment.chainId)}), Symbol: ${goString(deployment.symbol)}, Decimals: ${deployment.decimals}, Standard: TokenStandard(${goString(deployment.standard)}),`,
    `            Address: ${goPointer(deployment.address)}, Status: TokenStatus(${goString(deployment.status)}), ReplacedByDeploymentID: ${goPointer(deployment.replacedByDeploymentId)},`,
    "        },",
  );
  lines.push("    }", "}", "", "func TokenAliases() []TokenAlias {", "    return []TokenAlias{");
  for (const alias of orderedAliases(catalog)) lines.push(`        {Namespace: ${goString(alias.namespace)}, Name: ${goString(alias.name)}, DeploymentID: ${aliasConstName(alias.namespace, alias.name)}},`);
  lines.push("    }", "}", "");
  for (const [group, entries] of Object.entries(groups)) {
    lines.push(`type ${groupTypeName(group)} struct {`);
    for (const entry of entries) lines.push(`    ${entry.property} string`);
    lines.push("}", "");
  }
  lines.push("type TokenAliasGroups struct {");
  for (const group of ["ethereum", "solana", "avalancheC", "base"]) if (groups[group]) lines.push(`    ${identifier(group, "go")} ${groupTypeName(group)}`);
  lines.push("}", "", "func TokenAliasIDs() TokenAliasGroups {", "    return TokenAliasGroups{");
  for (const group of ["ethereum", "solana", "avalancheC", "base"]) if (groups[group]) {
    const entries = groups[group] ?? [];
    lines.push(`        ${identifier(group, "go")}: ${groupTypeName(group)}{`);
    for (const entry of entries) lines.push(`            ${entry.property}: ${aliasConstName(group, entry.property)},`);
    lines.push("        },");
  }
  lines.push("    }", "}", "");
  for (const [group, entries] of Object.entries(groups)) {
    for (const entry of entries) lines.push(`const ${aliasConstName(group, entry.property)} = ${goString(entry.deploymentId)}`);
  }
  lines.push("");
  return formatGoSource(lines.join("\n"));
}

function rubyString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function rubyKey(key) {
  return /^[a-z][a-z0-9_]*$/u.test(key) ? `${key}:` : `:${rubyString(key).slice(1, -1)} =>`;
}

function renderRuby(catalog) {
  const assets = materializeAssets(catalog);
  const deployments = materializeDeployments(catalog);
  const groups = groupedAliases(catalog, "ruby");
  const rubyValue = (value) => {
    if (value === null) return "nil";
    if (typeof value === "string") return rubyString(value);
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return `[${value.map(rubyValue).join(", ")}]`;
    return `{ ${Object.entries(value).map(([key, child]) => `${rubyKey(key)} ${rubyValue(child)}`).join(", ")} }`;
  };
  const tokenGroups = [];
  for (const group of ["ethereum", "solana", "avalanche_c", "base"]) {
    const constant = group === "avalanche_c" ? "AvalancheC" : group[0].toUpperCase() + group.slice(1);
    const entries = groups[group] ?? [];
    tokenGroups.push(`    ${constant} = ${rubyValue(Object.fromEntries(entries.map((entry) => [entry.property, entry.deploymentId])))}.freeze`);
  }
  const lines = [
    "# frozen_string_literal: true",
    "",
    "# Generated by registry/generate-token-catalog.mjs. Do not edit.",
    "",
    "module ERPC",
    "  module Tokens",
    ...tokenGroups,
    "  end",
    "",
    "  module TokenCatalogData",
    `    TOKEN_CATALOG_VERSION = ${rubyString(catalog.catalogVersion)}`,
    `    TOKEN_CATALOG_AS_OF_DATE = ${rubyString(catalog.manualAsOf)}`,
    `    TOKEN_CATALOG_CONTENT_DIGEST = ${rubyString(catalog.contentDigest)}`,
    `    TOKEN_CHAIN_IDS = ${rubyValue({ ethereum: TOKEN_CHAIN_IDS.ethereum, solana: TOKEN_CHAIN_IDS.solana, avalanche_c: TOKEN_CHAIN_IDS.avalancheC, base: TOKEN_CHAIN_IDS.base })}.freeze`,
    "",
    "    TOKEN_ASSETS = [",
  ];
  for (const asset of assets) lines.push(`      ${rubyValue({asset_id:asset.assetId,name:asset.name,representation_kind:asset.representationKind,stable_currency:asset.stableCurrency,underlying_asset_id:asset.underlyingAssetId,economic_reference_asset_id:asset.economicReferenceAssetId})}.freeze,`);
  lines.push("    ].freeze", "", "    TOKEN_DEPLOYMENTS = [");
  for (const deployment of deployments) lines.push(`      ${rubyValue({deployment_id:deployment.deploymentId,asset_id:deployment.assetId,name:deployment.name,representation_kind:deployment.representationKind,stable_currency:deployment.stableCurrency,underlying_asset_id:deployment.underlyingAssetId,economic_reference_asset_id:deployment.economicReferenceAssetId,chain_id:deployment.chainId,symbol:deployment.symbol,decimals:deployment.decimals,standard:deployment.standard,address:deployment.address,status:deployment.status,replaced_by_deployment_id:deployment.replacedByDeploymentId})}.freeze,`);
  lines.push("    ].freeze", "", "    TOKEN_ALIASES = [");
  for (const alias of orderedAliases(catalog)) lines.push(`      { namespace: ${rubyString(alias.namespace)}, name: ${rubyString(alias.name)}, deployment_id: ${tokenAliasReference(alias, "ruby")} }.freeze,`);
  lines.push("    ].freeze", "  end", "end", "");
  return lines.join("\n");
}

export function dataModel(catalog = CATALOG) {
  validateCatalog(catalog);
  return {
    version: catalog.catalogVersion,
    asOfDate: catalog.manualAsOf,
    contentDigest: catalog.contentDigest,
    chainIds: { ...TOKEN_CHAIN_IDS },
    assets: materializeAssets(catalog),
    deployments: materializeDeployments(catalog),
    aliases: orderedAliases(catalog).map((alias) => ({ ...alias })),
  };
}

export const OUTPUTS = OUTPUT_PATHS;
export const LANGUAGES = Object.freeze(Object.keys(OUTPUT_PATHS));

export function renderLanguage(language, catalog = CATALOG) {
  if (!Object.hasOwn(OUTPUT_PATHS, language)) fail(`unknown language: ${language}`);
  if (language === "typescript") return renderTypeScript(catalog);
  if (language === "rust") return renderRust(catalog);
  if (language === "python") return renderPython(catalog);
  if (language === "go") return renderGo(catalog);
  return renderRuby(catalog);
}

export const RENDERERS = Object.freeze({
  typescript: renderTypeScript,
  rust: renderRust,
  python: renderPython,
  go: renderGo,
  ruby: renderRuby,
});
export const renderers = RENDERERS;

export const CATALOG = deepFreeze(canonicalCatalog);
validateCatalog(CATALOG);
export const VERSION = CATALOG.catalogVersion;
export const AS_OF_DATE = CATALOG.manualAsOf;
export const CONTENT_DIGEST = CATALOG.contentDigest;
export const RUNTIME_FIELDS = Object.freeze([...RUNTIME_DEPLOYMENT_KEYS]);
export const ALIAS_GROUPS = Object.freeze(["ethereum", "solana", "avalancheC", "base"]);
