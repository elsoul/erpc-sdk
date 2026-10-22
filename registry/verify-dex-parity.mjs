#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CATALOG,
  DEX_CHAIN_IDS,
  dataModel,
  validateCatalog,
} from "./dex-catalog.mjs";
import tokenCatalog from "./token-catalog.json" with { type: "json" };
import quoteCases from "./fixtures/swap-quote-cases.json" with { type: "json" };

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);

const METADATA_KEYS = Object.freeze(["version", "asOfDate", "contentDigest", "chainIds"]);
const DEX_METADATA_KEYS = Object.freeze(["version", "asOfDate", "contentDigest"]);
const DEX_KEYS = Object.freeze([
  "dexDeploymentId",
  "protocolId",
  "name",
  "chainId",
  "programAddress",
  "adapterKind",
  "status",
  "replacedByDexDeploymentId",
]);
const POOL_KEYS = Object.freeze([
  "poolDefinitionId",
  "dexDeploymentId",
  "chainId",
  "address",
  "token0DeploymentId",
  "token1DeploymentId",
  "adapter",
  "status",
  "replacedByPoolDefinitionId",
]);
const WRAP_KEYS = Object.freeze([
  "nativeWrapDefinitionId",
  "chainId",
  "nativeTokenDeploymentId",
  "wrappedTokenDeploymentId",
  "status",
]);
const ALIAS_KEYS = Object.freeze(["namespace", "name", "dexDeploymentId", "poolDefinitionId"]);
const BEHAVIOR_KEYS = Object.freeze([
  "getDexDeployment",
  "getPoolDefinition",
  "findPoolDefinitionByAddress",
  "findPoolDefinitionsByPair",
  "listPoolDefinitions",
  "getNativeWrapDefinition",
  "alias",
  "quote",
]);

function resolveTokenCatalog(value) {
  return value?.tokenCatalog ?? value ?? tokenCatalog;
}

function parityError(message) {
  const error = new Error(message);
  error.name = "DexParityError";
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
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} keys must be exactly ${keys.join(", ")}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Keep golden quote amounts, ABI vectors, and RPC traces fixture-backed while
 * binding metadata rows to the catalogs used for the current verification.
 * This lets data-only catalog growth change digests without rewriting quote
 * fixtures.
 */
export function currentQuoteOutcome(entry, catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  if (entry?.outcome === undefined) return undefined;
  const outcome = clone(entry.outcome);
  if (isRecord(outcome?.value)) {
    if (Object.hasOwn(outcome.value, "tokenCatalogDigest")) outcome.value.tokenCatalogDigest = referencedTokenCatalog.contentDigest;
    if (Object.hasOwn(outcome.value, "dexCatalogDigest")) outcome.value.dexCatalogDigest = catalog.contentDigest;
  }
  return outcome;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortRecords(records, key) {
  return [...records].sort((left, right) => compareText(key(left), key(right)));
}

function sortBehavior(value) {
  return Object.fromEntries(BEHAVIOR_KEYS.map((key) => [key, sortRecords(value[key], stableJson)]));
}

function runtimeRecords(catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  const model = dataModel(catalog, { tokenCatalog: referencedTokenCatalog });
  return {
    dexDeployments: model.dexDeployments,
    poolDefinitions: model.poolDefinitions,
    nativeWrapDefinitions: model.nativeWrapDefinitions,
    aliases: model.aliases,
  };
}

function ids(records) {
  return records.map((record) => record.poolDefinitionId).sort(compareText);
}

function expectedBehavior(catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  const model = dataModel(catalog, { tokenCatalog: referencedTokenCatalog });
  const behavior = {
    getDexDeployment: [],
    getPoolDefinition: [],
    findPoolDefinitionByAddress: [],
    findPoolDefinitionsByPair: [],
    listPoolDefinitions: [],
    getNativeWrapDefinition: [],
    alias: [],
    quote: [],
  };

  for (const dex of model.dexDeployments) behavior.getDexDeployment.push({ input: dex.dexDeploymentId, result: dex.dexDeploymentId });
  behavior.getDexDeployment.push({ input: "dex-unknown", result: null });
  for (const pool of model.poolDefinitions) behavior.getPoolDefinition.push({ input: pool.poolDefinitionId, result: pool.poolDefinitionId });
  behavior.getPoolDefinition.push({ input: "pool-unknown", result: null });

  for (const pool of model.poolDefinitions) {
    behavior.findPoolDefinitionByAddress.push({ chainId: pool.chainId, address: pool.address, result: pool.poolDefinitionId });
    if (pool.chainId.startsWith("eip155:")) behavior.findPoolDefinitionByAddress.push({ chainId: pool.chainId, address: `0x${pool.address.slice(2).toUpperCase()}`, result: pool.poolDefinitionId });
  }
  behavior.findPoolDefinitionByAddress.push(
    { chainId: DEX_CHAIN_IDS.ethereum, address: "0x0000000000000000000000000000000000000000", result: null },
    { chainId: DEX_CHAIN_IDS.ethereum, address: "not-an-address", result: null },
    { chainId: "unknown:chain", address: "0x0000000000000000000000000000000000000001", result: null },
  );

  for (const pool of model.poolDefinitions) {
    const pairResult = ids(model.poolDefinitions.filter((candidate) => candidate.chainId === pool.chainId
      && [candidate.token0DeploymentId, candidate.token1DeploymentId].sort(compareText).join("\u0000")
        === [pool.token0DeploymentId, pool.token1DeploymentId].sort(compareText).join("\u0000")));
    behavior.findPoolDefinitionsByPair.push({
      chainId: pool.chainId,
      token0DeploymentId: pool.token0DeploymentId,
      token1DeploymentId: pool.token1DeploymentId,
      result: pairResult,
    });
    behavior.findPoolDefinitionsByPair.push({
      chainId: pool.chainId,
      token0DeploymentId: pool.token1DeploymentId,
      token1DeploymentId: pool.token0DeploymentId,
      result: pairResult,
    });
  }
  behavior.findPoolDefinitionsByPair.push(
    { chainId: DEX_CHAIN_IDS.ethereum, token0DeploymentId: "deployment-0001", token1DeploymentId: "deployment-0003", result: [] },
    { chainId: "unknown:chain", token0DeploymentId: "deployment-0002", token1DeploymentId: "deployment-0008", result: [] },
  );

  const filters = [
    {},
    ...Object.values(DEX_CHAIN_IDS).map((chainId) => ({ chainId })),
    ...model.poolDefinitions.flatMap((pool) => [{ tokenDeploymentId: pool.token0DeploymentId }, { tokenDeploymentId: pool.token1DeploymentId }]),
    ...[...new Set(model.poolDefinitions.map((pool) => pool.adapter.kind))].map((adapterKind) => ({ adapterKind })),
    ...model.poolDefinitions.map((pool) => ({ chainId: pool.chainId, tokenDeploymentId: pool.token0DeploymentId, adapterKind: pool.adapter.kind })),
    { chainId: "unknown:chain" },
    { tokenDeploymentId: "deployment-unknown" },
    { adapterKind: "unknown-adapter" },
  ];
  for (const filter of filters) {
    const result = model.poolDefinitions.filter((pool) => (filter.chainId === undefined || pool.chainId === filter.chainId)
      && (filter.tokenDeploymentId === undefined || pool.token0DeploymentId === filter.tokenDeploymentId || pool.token1DeploymentId === filter.tokenDeploymentId)
      && (filter.adapterKind === undefined || pool.adapter.kind === filter.adapterKind));
    behavior.listPoolDefinitions.push({ filter, result: ids(result.map((entry) => ({ poolDefinitionId: entry.poolDefinitionId }))) });
  }

  const nativeDeployments = referencedTokenCatalog.deployments.filter((deployment) => deployment.standard === "native");
  for (const deployment of nativeDeployments) {
    const wrap = model.nativeWrapDefinitions.find((entry) => entry.nativeTokenDeploymentId === deployment.deploymentId);
    behavior.getNativeWrapDefinition.push({ input: deployment.deploymentId, result: wrap?.nativeWrapDefinitionId ?? null });
  }
  behavior.getNativeWrapDefinition.push({ input: "deployment-unknown", result: null }, { input: "native-wrap-0001", result: null });
  for (const alias of model.aliases) {
    behavior.alias.push({
      namespace: alias.namespace,
      name: alias.name,
      kind: alias.dexDeploymentId === null ? "pool" : "dex",
      result: alias.dexDeploymentId ?? alias.poolDefinitionId,
    });
  }
  // Shared quote rows are deliberately fixture-backed. Native snapshots must
  // contain the outcomes and captured RPC traces from each executed package;
  // this verifier only supplies the canonical comparison payload.
  const sharedQuoteCases = [
    ...quoteCases.validCases,
    ...quoteCases.invalidCases,
    ...quoteCases.rpcCases,
    ...quoteCases.arithmeticCases,
  ].filter((entry) => entry.applicability !== "language-local");
  for (const entry of sharedQuoteCases) behavior.quote.push({ caseId: entry.caseId, outcome: currentQuoteOutcome(entry, catalog, referencedTokenCatalog), rpcTrace: entry.rpcTrace ?? [] });
  return sortBehavior(behavior);
}

export function buildExpectedSnapshot(catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  validateCatalog(catalog, { tokenCatalog: referencedTokenCatalog });
  const model = dataModel(catalog, { tokenCatalog: referencedTokenCatalog });
  const records = runtimeRecords(catalog, referencedTokenCatalog);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    metadata: {
      version: referencedTokenCatalog.catalogVersion,
      asOfDate: referencedTokenCatalog.manualAsOf,
      contentDigest: referencedTokenCatalog.contentDigest,
      chainIds: {
        ethereum: "eip155:1",
        solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        avalancheC: "eip155:43114",
      },
    },
    dexMetadata: {
      version: catalog.catalogVersion,
      asOfDate: catalog.manualAsOf,
      contentDigest: catalog.contentDigest,
    },
    ...records,
    behavior: expectedBehavior(catalog, referencedTokenCatalog),
  };
}

function normalizedSnapshot(snapshot, language, catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  if (!isRecord(snapshot)) fail(`${language} snapshot must be an object`);
  exactKeys(snapshot, [
    "snapshotVersion",
    "snapshotKind",
    "language",
    "runtime",
    "metadata",
    "dexMetadata",
    "dexDeployments",
    "poolDefinitions",
    "nativeWrapDefinitions",
    "aliases",
    "behavior",
  ], `${language} snapshot`);
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) fail(`${language} snapshotVersion must be ${SNAPSHOT_VERSION}`);
  if (snapshot.snapshotKind !== SNAPSHOT_KIND) fail(`${language} snapshotKind must be ${SNAPSHOT_KIND}`);
  if (snapshot.language !== language) fail(`${language} snapshot language does not match its map key`);
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.trim() === "" || snapshot.runtime === "canonical-reference") fail(`${language} snapshot runtime must identify an executed native package`);

  exactKeys(snapshot.metadata, METADATA_KEYS, `${language}.metadata`);
  exactKeys(snapshot.metadata.chainIds, Object.keys(DEX_CHAIN_IDS), `${language}.metadata.chainIds`);
  if (snapshot.metadata.version !== referencedTokenCatalog.catalogVersion || snapshot.metadata.asOfDate !== referencedTokenCatalog.manualAsOf || snapshot.metadata.contentDigest !== referencedTokenCatalog.contentDigest) fail(`${language} token metadata differs from canonical catalog`);
  if (stableJson(snapshot.metadata.chainIds) !== stableJson(DEX_CHAIN_IDS)) fail(`${language} token chain IDs differ from canonical catalog`);
  exactKeys(snapshot.dexMetadata, DEX_METADATA_KEYS, `${language}.dexMetadata`);
  if (snapshot.dexMetadata.version !== catalog.catalogVersion || snapshot.dexMetadata.asOfDate !== catalog.manualAsOf || snapshot.dexMetadata.contentDigest !== catalog.contentDigest) fail(`${language} DEX metadata differs from canonical catalog`);

  if (!Array.isArray(snapshot.dexDeployments) || !Array.isArray(snapshot.poolDefinitions) || !Array.isArray(snapshot.nativeWrapDefinitions) || !Array.isArray(snapshot.aliases)) fail(`${language} snapshot record fields must be arrays`);
  for (const [index, value] of snapshot.dexDeployments.entries()) exactKeys(value, DEX_KEYS, `${language}.dexDeployments[${index}]`);
  for (const [index, value] of snapshot.poolDefinitions.entries()) {
    exactKeys(value, POOL_KEYS, `${language}.poolDefinitions[${index}]`);
    exactKeys(value.adapter, ["kind", "feeNumerator", "feeDenominator"], `${language}.poolDefinitions[${index}].adapter`);
  }
  for (const [index, value] of snapshot.nativeWrapDefinitions.entries()) exactKeys(value, WRAP_KEYS, `${language}.nativeWrapDefinitions[${index}]`);
  for (const [index, value] of snapshot.aliases.entries()) exactKeys(value, ALIAS_KEYS, `${language}.aliases[${index}]`);
  exactKeys(snapshot.behavior, BEHAVIOR_KEYS, `${language}.behavior`);
  for (const key of BEHAVIOR_KEYS) if (!Array.isArray(snapshot.behavior[key])) fail(`${language}.behavior.${key} must be an array`);
  return {
    ...clone(snapshot),
    dexDeployments: sortRecords(snapshot.dexDeployments, (entry) => entry.dexDeploymentId),
    poolDefinitions: sortRecords(snapshot.poolDefinitions, (entry) => entry.poolDefinitionId),
    nativeWrapDefinitions: sortRecords(snapshot.nativeWrapDefinitions, (entry) => entry.nativeWrapDefinitionId),
    aliases: sortRecords(snapshot.aliases, (entry) => `${entry.namespace}\u0000${entry.name}`),
    behavior: sortBehavior(snapshot.behavior),
  };
}

function comparableSnapshot(snapshot) {
  const copy = clone(snapshot);
  copy.language = "canonical";
  copy.runtime = "canonical-reference";
  return copy;
}

export function verifySnapshots(snapshots, catalog = CATALOG, referencedTokenCatalog = tokenCatalog) {
  referencedTokenCatalog = resolveTokenCatalog(referencedTokenCatalog);
  validateCatalog(catalog, { tokenCatalog: referencedTokenCatalog });
  if (!isRecord(snapshots)) fail("snapshots must be an object keyed by language");
  const actualLanguages = Object.keys(snapshots).sort(compareText);
  const expectedLanguages = [...PARITY_LANGUAGES].sort(compareText);
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) fail(`native snapshots must include exactly ${PARITY_LANGUAGES.join(", ")}`);
  const expected = buildExpectedSnapshot(catalog, referencedTokenCatalog);
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizedSnapshot(snapshots[language], language, catalog, referencedTokenCatalog);
    const expectedForLanguage = { ...expected, language, runtime: normalized.runtime };
    if (stableJson(comparableSnapshot(normalized)) !== stableJson(comparableSnapshot(expectedForLanguage))) {
      const fields = ["metadata", "dexMetadata", "dexDeployments", "poolDefinitions", "nativeWrapDefinitions", "aliases", "behavior"];
      const mismatches = fields.filter((field) => stableJson(normalized[field]) !== stableJson(expectedForLanguage[field]));
      fail(`${language} native runtime parity mismatch in ${mismatches.join(", ")}`);
    }
    results.push({
      language,
      runtime: normalized.runtime,
      dexDeployments: normalized.dexDeployments.length,
      poolDefinitions: normalized.poolDefinitions.length,
      nativeWrapDefinitions: normalized.nativeWrapDefinitions.length,
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

function parseArguments(argumentsList) {
  const options = { files: [], json: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") { if (options.json) fail("--json may be provided only once"); options.json = true; continue; }
    if (argument === "--help") { if (options.help) fail("--help may be provided only once"); options.help = true; continue; }
    if (argument === "--snapshots" || argument === "--snapshot") {
      const file = argumentsList[index + 1];
      if (file === undefined || file.startsWith("--")) fail(`${argument} requires a file path`);
      options.files.push(file); index += 1; continue;
    }
    if (argument.startsWith("--")) fail(`unknown option ${argument}`);
    fail(`unexpected argument ${argument}`);
  }
  if (options.help) {
    if (options.files.length > 0 || options.json) fail("--help cannot be combined with other options");
    return options;
  }
  if (options.files.length === 0) fail("an explicit --snapshots or --snapshot input is required for native parity");
  return options;
}

function parseEnvelope(value, sourceLabel, catalog = CATALOG) {
  if (!isRecord(value)) fail(`${sourceLabel} must contain a JSON object`);
  if (Object.hasOwn(value, "languages")) {
    exactKeys(value, ["snapshotVersion", "snapshotKind", "catalogDigest", "languages"], sourceLabel);
    if (value.snapshotVersion !== SNAPSHOT_VERSION || value.snapshotKind !== "native-runtime-parity" || value.catalogDigest !== catalog.contentDigest) fail(`${sourceLabel} envelope metadata differs from canonical catalog`);
    if (!isRecord(value.languages)) fail(`${sourceLabel}.languages must be an object keyed by language`);
    return value.languages;
  }
  if (Object.hasOwn(value, "language")) return { [value.language]: value };
  fail(`${sourceLabel} must be a native-runtime-parity envelope or one language snapshot`);
}

async function readSnapshots(files, catalog = CATALOG) {
  const result = {};
  for (const file of files) {
    const absolutePath = path.resolve(process.cwd(), file);
    let source;
    try { source = await readFile(absolutePath, "utf8"); } catch (error) { fail(`cannot read snapshot ${file}: ${error.message}`); }
    let value;
    try { value = JSON.parse(source); } catch (error) { fail(`cannot parse snapshot ${file} as JSON: ${error.message}`); }
    for (const [language, snapshot] of Object.entries(parseEnvelope(value, file, catalog))) {
      if (result[language] !== undefined) fail(`duplicate native snapshot for ${language}`);
      result[language] = snapshot;
    }
  }
  return result;
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-dex-parity.mjs --snapshots <native-snapshots.json>",
    "  node registry/verify-dex-parity.mjs --snapshot <language.json> --snapshot <language.json> ...",
    "",
    "The input must contain exports captured by an executed native package for all five languages.",
    "Options:",
    "  --snapshots <file>  read one native-runtime-parity envelope",
    "  --snapshot <file>   read one language snapshot; repeat five times",
    "  --json              print a machine-readable verification result",
    "  --help              show this help",
  ].join("\n");
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const result = verifySnapshots(await readSnapshots(options.files));
  process.stdout.write(`${options.json ? JSON.stringify(result) : `native DEX runtime parity OK: ${result.languages.map((entry) => `${entry.language} (${entry.runtime})`).join(", ")}; dexDeployments=${result.languages[0].dexDeployments}, pools=${result.languages[0].poolDefinitions}` }\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-dex-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
