#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { CATALOG, computeDigest, validateCatalog } from "./token-catalog.mjs";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);

const CHAIN_IDS = Object.freeze({
  ethereum: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  avalancheC: "eip155:43114",
});
const RUNTIME_ASSET_KEYS = Object.freeze([
  "assetId",
  "name",
  "representationKind",
  "stableCurrency",
  "underlyingAssetId",
  "economicReferenceAssetId",
]);
const RUNTIME_DEPLOYMENT_KEYS = Object.freeze([
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
]);
const RUNTIME_ALIAS_KEYS = Object.freeze(["namespace", "name", "deploymentId"]);
const METADATA_KEYS = Object.freeze(["version", "asOfDate", "contentDigest", "chainIds"]);
const BEHAVIOR_KEYS = Object.freeze([
  "lookupAsset",
  "lookupDeployment",
  "nativeDeployment",
  "symbol",
  "address",
  "alias",
  "list",
]);

function parityError(message) {
  const error = new Error(message);
  error.name = "TokenParityError";
  return error;
}

function fail(message) {
  throw parityError(message);
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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeAsset(asset) {
  return {
    assetId: asset.assetId,
    name: asset.name,
    representationKind: asset.representationKind,
    stableCurrency: asset.stableCurrency,
    underlyingAssetId: asset.underlyingAssetId,
    economicReferenceAssetId: asset.economicReferenceAssetId,
  };
}

function runtimeDeployment(catalog, deployment) {
  const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
  if (!asset) fail(`deployment ${deployment.deploymentId} references an unknown asset`);
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
}

function runtimeAlias(alias) {
  return { namespace: alias.namespace, name: alias.name, deploymentId: alias.deploymentId };
}

function deploymentById(catalog) {
  return new Map(catalog.deployments.map((deployment) => [deployment.deploymentId, deployment]));
}

function assetById(catalog) {
  return new Map(catalog.assets.map((asset) => [asset.assetId, asset]));
}

function aliasByKey(catalog) {
  return new Map(catalog.aliases.map((alias) => [`${alias.namespace}\u0000${alias.name}`, alias]));
}

function deploymentIdResult(catalog, deploymentId) {
  return deploymentId === null ? null : deploymentId;
}

function ids(deployments) {
  return deployments.map((deployment) => deployment.deploymentId).sort();
}

function expectedBehavior(catalog) {
  const assets = assetById(catalog);
  const deployments = deploymentById(catalog);
  const aliases = aliasByKey(catalog);
  const chains = Object.values(CHAIN_IDS);
  const allAssetIds = [...assets.keys()].sort();
  const allDeploymentIds = [...deployments.keys()].sort();
  const symbolKeys = [...new Set(catalog.deployments.map((deployment) => `${deployment.chainId}\u0000${deployment.symbol}`))].sort();
  const aliasKeys = [...aliases.keys()].sort();

  const behavior = {
    lookupAsset: [...allAssetIds, "__unknown_asset__"].map((input) => ({
      input,
      result: assets.has(input) ? input : null,
    })),
    lookupDeployment: [...allDeploymentIds, "__unknown_deployment__"].map((input) => ({
      input,
      result: deployments.has(input) ? input : null,
    })),
    nativeDeployment: [...chains, "unknown:chain"].map((chainId) => ({
      chainId,
      result: deploymentIdResult(
        catalog,
        catalog.deployments.find((deployment) => deployment.chainId === chainId && deployment.standard === "native")?.deploymentId ?? null,
      ),
    })),
    symbol: [
      ...symbolKeys.map((key) => {
        const [chainId, symbol] = key.split("\u0000");
        return {
          chainId,
          symbol,
          result: ids(catalog.deployments.filter((deployment) => deployment.chainId === chainId && deployment.symbol === symbol)),
        };
      }),
      { chainId: CHAIN_IDS.ethereum, symbol: "__unknown_symbol__", result: [] },
      { chainId: "unknown:chain", symbol: "USDC", result: [] },
    ],
    address: [],
    alias: [
      ...aliasKeys.map((key) => {
        const [namespace, name] = key.split("\u0000");
        return { namespace, name, result: aliases.get(key).deploymentId };
      }),
      { namespace: "ethereum", name: "__UNKNOWN_ALIAS__", result: null },
      { namespace: "unknown", name: "USDC", result: null },
    ],
    list: [],
  };

  const addressed = catalog.deployments.filter((deployment) => deployment.address !== null);
  for (const deployment of addressed) {
    behavior.address.push({
      chainId: deployment.chainId,
      address: deployment.address,
      result: deployment.deploymentId,
    });
    if (deployment.chainId === CHAIN_IDS.ethereum || deployment.chainId === CHAIN_IDS.avalancheC) {
      behavior.address.push({
        chainId: deployment.chainId,
        address: `0x${deployment.address.slice(2).toUpperCase()}`,
        result: deployment.deploymentId,
      });
    }
  }
  behavior.address.push(
    { chainId: CHAIN_IDS.ethereum, address: "0x0000000000000000000000000000000000000000", result: null },
    { chainId: CHAIN_IDS.ethereum, address: "not-an-address", result: null },
    { chainId: CHAIN_IDS.solana, address: "not-a-solana-address", result: null },
    { chainId: "unknown:chain", address: "0x0000000000000000000000000000000000000001", result: null },
  );

  const filterCases = [
    { chainId: null, stableCurrency: null },
    ...chains.map((chainId) => ({ chainId, stableCurrency: null })),
    ...["USD", "EUR", "JPY"].map((stableCurrency) => ({ chainId: null, stableCurrency })),
    { chainId: CHAIN_IDS.ethereum, stableCurrency: "USD" },
    { chainId: CHAIN_IDS.solana, stableCurrency: "EUR" },
    { chainId: "unknown:chain", stableCurrency: null },
    { chainId: null, stableCurrency: "unknown" },
  ];
  for (const filter of filterCases) {
    const result = catalog.deployments.filter((deployment) =>
      (filter.chainId === null || deployment.chainId === filter.chainId)
      && (filter.stableCurrency === null || deployment.assetId !== null && catalog.assets.find((asset) => asset.assetId === deployment.assetId)?.stableCurrency === filter.stableCurrency),
    );
    behavior.list.push({ ...filter, result: ids(result) });
  }

  for (const entries of Object.values(behavior)) {
    if (Array.isArray(entries)) entries.sort((left, right) => compareStrings(stableJson(left), stableJson(right)));
  }
  return behavior;
}

/**
 * Return the exact normalized payload that each native package exporter must
 * match. This function derives expected values from the canonical records and
 * never reads generated source text. Callers must label snapshots honestly;
 * the runtime field records provenance but cannot prove that a process ran.
 */
export function buildExpectedSnapshot(catalog = CATALOG) {
  validateCatalog(catalog);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    metadata: {
      version: catalog.catalogVersion,
      asOfDate: catalog.manualAsOf,
      contentDigest: catalog.contentDigest,
      chainIds: { ...CHAIN_IDS },
    },
    assets: sortRecords(catalog.assets.map(runtimeAsset), (record) => record.assetId),
    deployments: sortRecords(catalog.deployments.map((deployment) => runtimeDeployment(catalog, deployment)), (record) => record.deploymentId),
    aliases: sortRecords(catalog.aliases.map(runtimeAlias), (record) => `${record.namespace}\u0000${record.name}`),
    behavior: expectedBehavior(catalog),
  };
}

function sortRecords(records, keyFunction) {
  return [...records].sort((left, right) => compareStrings(keyFunction(left), keyFunction(right)));
}

function normalizedSnapshot(snapshot, language, catalog = CATALOG) {
  if (!isRecord(snapshot)) fail(`${language} snapshot must be an object`);
  const expectedKeys = [
    "snapshotVersion",
    "snapshotKind",
    "language",
    "runtime",
    "metadata",
    "assets",
    "deployments",
    "aliases",
    "behavior",
  ];
  exactKeys(snapshot, expectedKeys, `${language} snapshot`);
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) fail(`${language} snapshotVersion must be ${SNAPSHOT_VERSION}`);
  if (snapshot.snapshotKind !== SNAPSHOT_KIND) fail(`${language} snapshotKind must be ${SNAPSHOT_KIND}`);
  if (snapshot.language !== language) fail(`${language} snapshot language does not match its map key`);
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.trim() === "" || snapshot.runtime === "canonical-reference") {
    fail(`${language} snapshot runtime must identify an executed native package`);
  }

  exactKeys(snapshot.metadata, METADATA_KEYS, `${language}.metadata`);
  exactKeys(snapshot.metadata.chainIds, Object.keys(CHAIN_IDS), `${language}.metadata.chainIds`);
  if (snapshot.metadata.version !== catalog.catalogVersion) fail(`${language} metadata version differs from canonical catalog`);
  if (snapshot.metadata.asOfDate !== catalog.manualAsOf) fail(`${language} metadata asOfDate differs from canonical catalog`);
  if (snapshot.metadata.contentDigest !== catalog.contentDigest) fail(`${language} metadata contentDigest differs from canonical catalog`);
  if (stableJson(snapshot.metadata.chainIds) !== stableJson(CHAIN_IDS)) fail(`${language} metadata chain IDs differ from canonical catalog`);

  if (!Array.isArray(snapshot.assets) || !Array.isArray(snapshot.deployments) || !Array.isArray(snapshot.aliases)) {
    fail(`${language} snapshot assets, deployments, and aliases must be arrays`);
  }
  for (const [index, asset] of snapshot.assets.entries()) exactKeys(asset, RUNTIME_ASSET_KEYS, `${language}.assets[${index}]`);
  for (const [index, deployment] of snapshot.deployments.entries()) exactKeys(deployment, RUNTIME_DEPLOYMENT_KEYS, `${language}.deployments[${index}]`);
  for (const [index, alias] of snapshot.aliases.entries()) exactKeys(alias, RUNTIME_ALIAS_KEYS, `${language}.aliases[${index}]`);
  exactKeys(snapshot.behavior, BEHAVIOR_KEYS, `${language}.behavior`);

  for (const key of BEHAVIOR_KEYS) {
    if (!Array.isArray(snapshot.behavior[key])) fail(`${language}.behavior.${key} must be an array`);
  }
  return {
    ...jsonClone(snapshot),
    assets: sortRecords(snapshot.assets, (record) => record.assetId),
    deployments: sortRecords(snapshot.deployments, (record) => record.deploymentId),
    aliases: sortRecords(snapshot.aliases, (record) => `${record.namespace}\u0000${record.name}`),
    behavior: Object.fromEntries(BEHAVIOR_KEYS.map((key) => [
      key,
      sortRecords(snapshot.behavior[key], (record) => stableJson(record)),
    ])),
  };
}

function comparableSnapshot(snapshot) {
  const copy = jsonClone(snapshot);
  copy.language = "canonical";
  copy.runtime = "canonical-reference";
  return copy;
}

function parseSnapshotEnvelope(value, sourceLabel, catalog = CATALOG) {
  if (!isRecord(value)) fail(`${sourceLabel} must contain a JSON object`);
  if (Object.hasOwn(value, "languages")) {
    exactKeys(value, ["snapshotVersion", "snapshotKind", "catalogDigest", "languages"], sourceLabel);
    if (value.snapshotVersion !== SNAPSHOT_VERSION) fail(`${sourceLabel}.snapshotVersion must be ${SNAPSHOT_VERSION}`);
    if (value.snapshotKind !== "native-runtime-parity") fail(`${sourceLabel}.snapshotKind must be native-runtime-parity`);
    if (value.catalogDigest !== catalog.contentDigest) fail(`${sourceLabel}.catalogDigest differs from canonical catalog`);
    if (!isRecord(value.languages)) fail(`${sourceLabel}.languages must be an object keyed by language`);
    return value.languages;
  }
  if (Object.hasOwn(value, "language")) return { [value.language]: value };
  fail(`${sourceLabel} must be a native-runtime-parity envelope or one language snapshot`);
}

export function verifySnapshots(snapshots, catalog = CATALOG) {
  validateCatalog(catalog);
  const expected = buildExpectedSnapshot(catalog);
  if (!isRecord(snapshots)) fail("snapshots must be an object keyed by language");
  const actualLanguages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) {
    fail(`native snapshots must include exactly ${PARITY_LANGUAGES.join(", ")}`);
  }

  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizedSnapshot(snapshots[language], language, catalog);
    const expectedForLanguage = { ...expected, language, runtime: normalized.runtime };
    if (stableJson(comparableSnapshot(normalized)) !== stableJson(comparableSnapshot(expectedForLanguage))) {
      const fields = ["metadata", "assets", "deployments", "aliases", "behavior"];
      const mismatches = fields.filter((field) => stableJson(normalized[field]) !== stableJson(expectedForLanguage[field]));
      fail(`${language} native runtime parity mismatch in ${mismatches.join(", ")}`);
    }
    results.push({
      language,
      runtime: normalized.runtime,
      assets: normalized.assets.length,
      deployments: normalized.deployments.length,
      aliases: normalized.aliases.length,
    });
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    catalogDigest: catalog.contentDigest,
    languages: results,
    status: "ok",
  };
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-token-parity.mjs --snapshots <native-snapshots.json>",
    "  node registry/verify-token-parity.mjs --snapshot <language.json> --snapshot <language.json> ...",
    "",
    "The input must contain exports captured by an executed native package for all five languages.",
    "This verifier compares supplied runtime snapshots; it does not compile packages or prove snapshot provenance.",
    "Options:",
    "  --snapshots <file>  read one native-runtime-parity envelope",
    "  --snapshot <file>   read one language snapshot; repeat five times",
    "  --json              print a machine-readable verification result",
    "  --help              show this help",
  ].join("\n");
}

function parseArguments(argumentsList) {
  const options = { files: [], json: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") {
      if (options.json) fail("--json may be provided only once");
      options.json = true;
      continue;
    }
    if (argument === "--help") {
      if (options.help) fail("--help may be provided only once");
      options.help = true;
      continue;
    }
    if (argument === "--snapshots" || argument === "--snapshot") {
      const file = argumentsList[index + 1];
      if (file === undefined || file.startsWith("--")) fail(`${argument} requires a file path`);
      options.files.push(file);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) fail(`unknown option ${argument}`);
    fail(`unexpected argument ${argument}`);
  }
  if (options.help) {
    if (options.files.length !== 0 || options.json) fail("--help cannot be combined with other options");
    return options;
  }
  if (options.files.length === 0) fail("an explicit --snapshots or --snapshot input is required for native parity");
  return options;
}

async function readSnapshots(files, catalog = CATALOG) {
  const languageSnapshots = {};
  for (const file of files) {
    const absolutePath = path.resolve(process.cwd(), file);
    let source;
    try {
      source = await readFile(absolutePath, "utf8");
    } catch (error) {
      fail(`cannot read snapshot ${file}: ${error.message}`);
    }
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      fail(`cannot parse snapshot ${file} as JSON: ${error.message}`);
    }
    const entries = parseSnapshotEnvelope(value, file, catalog);
    for (const [language, snapshot] of Object.entries(entries)) {
      if (languageSnapshots[language] !== undefined) fail(`duplicate native snapshot for ${language}`);
      languageSnapshots[language] = snapshot;
    }
  }
  return languageSnapshots;
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = verifySnapshots(await readSnapshots(options.files));
  process.stdout.write(`${options.json ? JSON.stringify(result) : `native runtime parity OK: ${result.languages.map((entry) => `${entry.language} (${entry.runtime})`).join(", ")}; assets=${result.languages[0].assets}, deployments=${result.languages[0].deployments}, aliases=${result.languages[0].aliases}`}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-token-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
