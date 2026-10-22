#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import canonicalRegistry from "./swap-execution-capabilities.json" with { type: "json" };
import canonicalDexCatalog from "./dex-catalog.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import fixture from "./fixtures/swap-execution-cases.json" with { type: "json" };
import {
  SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
  SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
  computeDigest,
  validateSwapExecutionCapabilities,
} from "./swap-execution-capabilities.mjs";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "swap-execution-native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
export const BEHAVIOR_KEYS = Object.freeze(["prepare", "simulate"]);

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CASE_KEYS = Object.freeze(["caseId", "method", "quoteCaseId", "request", "nowSeconds", "rpcResponses", "rpcTrace", "outcome"]);
const REQUEST_KEYS = Object.freeze([
  "chainId",
  "poolDefinitionId",
  "inputTokenDeploymentId",
  "outputTokenDeploymentId",
  "amountIn",
  "freshness",
  "sender",
  "recipient",
  "slippageBps",
  "deadline",
]);
const PREPARATION_KEYS = Object.freeze([
  "preparationKind",
  "executionCapabilityId",
  "executionCapabilityDigest",
  "quote",
  "minimumAmountOut",
  "slippageBps",
  "deadline",
  "recipient",
  "path",
  "transaction",
  "allowance",
]);
const PATH_KEYS = Object.freeze(["tokenDeploymentId", "address", "standard", "representationKind"]);
const TRANSACTION_KEYS = Object.freeze(["kind", "chainId", "from", "to", "data", "value"]);
const ALLOWANCE_KEYS = Object.freeze(["tokenDeploymentId", "tokenAddress", "owner", "spender", "requiredAmount"]);
const SIMULATION_KEYS = Object.freeze(["simulationKind", "preparation", "snapshot", "currentAllowance", "amounts", "amountOut"]);

export class SwapExecutionParityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SwapExecutionParityError";
  }
}

function fail(message) {
  throw new SwapExecutionParityError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, { optional = [] } = {}) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value).sort();
  const expected = [...keys, ...optional].sort();
  if (actual.some((key) => !allowed.has(key)) || actual.length !== expected.length) {
    fail(`${label} has an unexpected key`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
}

function exactKeysWithOptional(value, keys, optional, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has an unexpected key ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
}

function clone(value) {
  return structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sortCases(rows) {
  return [...rows].sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);
}

function currentDigests(registry = canonicalRegistry) {
  return {
    capabilityAsOfDate: registry.asOfDate,
    capabilityDigest: computeDigest(registry.capabilities),
  };
}

function rebindOutcomeMetadata(outcome, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, dexCatalog = canonicalDexCatalog) {
  const next = clone(outcome);
  if (!isRecord(next) || next.kind !== "success" || !isRecord(next.value)) return next;
  const digest = currentDigests(registry).capabilityDigest;
  const value = next.value;
  const preparation = value.preparation ?? value;
  if (isRecord(preparation) && Object.hasOwn(preparation, "executionCapabilityDigest")) preparation.executionCapabilityDigest = digest;
  const quote = preparation?.quote;
  if (isRecord(quote)) {
    if (Object.hasOwn(quote, "tokenCatalogDigest")) quote.tokenCatalogDigest = tokenCatalog.contentDigest;
    if (Object.hasOwn(quote, "dexCatalogDigest")) quote.dexCatalogDigest = dexCatalog.contentDigest;
  }
  return next;
}

function validateTrace(trace, label) {
  if (!Array.isArray(trace)) fail(`${label} must be an array`);
  for (const [index, entry] of trace.entries()) {
    exactKeys(entry, ["method", "params"], `${label}[${index}]`);
    if (typeof entry.method !== "string" || entry.method.trim() === "") fail(`${label}[${index}].method is invalid`);
    if (!Array.isArray(entry.params)) fail(`${label}[${index}].params must be an array`);
  }
}

function validateRequest(request, label) {
  exactKeysWithOptional(request, ["chainId", "poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId", "amountIn", "sender", "recipient", "slippageBps", "deadline"], ["freshness"], label);
  for (const key of ["chainId", "poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId", "amountIn", "sender", "recipient", "deadline"]) {
    if (typeof request[key] !== "string") fail(`${label}.${key} must be a string`);
  }
  if (!Number.isSafeInteger(request.slippageBps) && typeof request.slippageBps !== "boolean" && typeof request.slippageBps !== "number") fail(`${label}.slippageBps is invalid`);
  if (Object.hasOwn(request, "freshness") && !isRecord(request.freshness)) fail(`${label}.freshness must be an object`);
}

function validatePreparation(value, label) {
  exactKeys(value, PREPARATION_KEYS, label);
  if (value.preparationKind !== "evm-router-v2-exact-input") fail(`${label}.preparationKind is invalid`);
  if (typeof value.executionCapabilityId !== "string" || typeof value.executionCapabilityDigest !== "string") fail(`${label} capability metadata is invalid`);
  if (!isRecord(value.quote)) fail(`${label}.quote must be an object`);
  if (typeof value.minimumAmountOut !== "string" || typeof value.deadline !== "string" || typeof value.recipient !== "string") fail(`${label} monetary or recipient fields are invalid`);
  if (!Number.isInteger(value.slippageBps)) fail(`${label}.slippageBps must be an integer`);
  if (!Array.isArray(value.path) || value.path.length !== 2) fail(`${label}.path must contain two entries`);
  for (const [index, entry] of value.path.entries()) exactKeys(entry, PATH_KEYS, `${label}.path[${index}]`);
  exactKeys(value.transaction, TRANSACTION_KEYS, `${label}.transaction`);
  if (value.transaction.kind !== "evm-unsigned-transaction" || value.transaction.value !== "0") fail(`${label}.transaction envelope is invalid`);
  if (typeof value.transaction.data !== "string" || !/^0x[0-9a-f]+$/u.test(value.transaction.data)) fail(`${label}.transaction.data is invalid`);
  exactKeys(value.allowance, ALLOWANCE_KEYS, `${label}.allowance`);
}

function validateOutcome(outcome, method, label) {
  if (!isRecord(outcome) || typeof outcome.kind !== "string") fail(`${label} outcome is invalid`);
  if (outcome.kind === "success") {
    exactKeys(outcome, ["kind", "value"], label);
    if (!isRecord(outcome.value)) fail(`${label}.value must be an object`);
    if (method === "prepare") validatePreparation(outcome.value, `${label}.value`);
    else {
      exactKeys(outcome.value, SIMULATION_KEYS, `${label}.value`);
      if (outcome.value.simulationKind !== "evm-call") fail(`${label}.value.simulationKind is invalid`);
      validatePreparation(outcome.value.preparation, `${label}.value.preparation`);
      if (!Array.isArray(outcome.value.amounts) || outcome.value.amounts.length !== 2) fail(`${label}.value.amounts must contain two values`);
    }
    return;
  }
  if (outcome.kind === "sdk-error") {
    exactKeys(outcome, ["kind", "code"], label);
    if (typeof outcome.code !== "string") fail(`${label}.code must be a string`);
    return;
  }
  if (outcome.kind === "transport-error") {
    exactKeys(outcome, ["kind", "sourcePreserved"], label);
    if (outcome.sourcePreserved !== true) fail(`${label}.sourcePreserved must be true`);
    return;
  }
  fail(`${label}.kind is unsupported`);
}

function validateFixtureCase(entry, index, quoteIds) {
  const label = `cases[${index}]`;
  exactKeysWithOptional(entry, CASE_KEYS, ["mutation"], label);
  if (typeof entry.caseId !== "string" || entry.caseId.length === 0 || typeof entry.quoteCaseId !== "string") fail(`${label} identifiers are invalid`);
  if (quoteIds && !quoteIds.has(entry.quoteCaseId)) fail(`${label}.quoteCaseId is unknown`);
  if (entry.method !== "prepare" && entry.method !== "simulate") fail(`${label}.method is invalid`);
  validateRequest(entry.request, `${label}.request`);
  if (!Number.isSafeInteger(entry.nowSeconds)) fail(`${label}.nowSeconds must be a safe integer`);
  if (!Array.isArray(entry.rpcResponses)) fail(`${label}.rpcResponses must be an array`);
  validateTrace(entry.rpcTrace, `${label}.rpcTrace`);
  if (entry.rpcResponses.length > entry.rpcTrace.length) fail(`${label} has more RPC responses than trace entries`);
  validateOutcome(entry.outcome, entry.method, `${label}.outcome`);
}

export function validateFixtures(value = fixture, { quoteFixtureIds = undefined } = {}) {
  exactKeys(value, ["schemaVersion", "fixtureKind", "capabilityAsOfDate", "capabilityDigest", "cases"], "fixture");
  if (value.schemaVersion !== 1 || value.fixtureKind !== "swap-execution-fixtures") fail("fixture schema or kind is invalid");
  if (typeof value.capabilityAsOfDate !== "string" || typeof value.capabilityDigest !== "string") fail("fixture capability metadata is invalid");
  if (value.capabilityAsOfDate !== SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE || value.capabilityDigest !== SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST) fail("fixture capability metadata differs from canonical source");
  if (!Array.isArray(value.cases) || value.cases.length === 0) fail("fixture.cases must be a non-empty array");
  const ids = new Set();
  const quoteIds = quoteFixtureIds ?? new Set(["ethereum-weth-usdc-forward", "ethereum-usdc-weth-reverse", "avalanche-wavax-usdc-forward", "avalanche-usdc-wavax-reverse"]);
  for (const [index, entry] of value.cases.entries()) {
    if (ids.has(entry?.caseId)) fail(`duplicate fixture case ${entry?.caseId}`);
    ids.add(entry?.caseId);
    validateFixtureCase(entry, index, quoteIds);
  }
  return true;
}

function fixtureBehavior(value, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, dexCatalog = canonicalDexCatalog) {
  const grouped = { prepare: [], simulate: [] };
  for (const entry of sortCases(value.cases)) {
    grouped[entry.method].push({
      caseId: entry.caseId,
      outcome: rebindOutcomeMetadata(entry.outcome, registry, tokenCatalog, dexCatalog),
      rpcTrace: clone(entry.rpcTrace),
    });
  }
  return grouped;
}

export function buildExpectedSnapshot(registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, dexCatalog = canonicalDexCatalog, sourceFixture = fixture) {
  validateSwapExecutionCapabilities(registry, { tokenCatalog, dexCatalog });
  validateFixtures(sourceFixture);
  const { capabilityAsOfDate, capabilityDigest } = currentDigests(registry);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    capabilityAsOfDate,
    capabilityDigest,
    behavior: fixtureBehavior(sourceFixture, registry, tokenCatalog, dexCatalog),
  };
}

function normalizedSnapshot(snapshot, language, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, dexCatalog = canonicalDexCatalog) {
  exactKeys(snapshot, ["snapshotVersion", "snapshotKind", "language", "runtime", "capabilityAsOfDate", "capabilityDigest", "behavior"], `${language} snapshot`);
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) fail(`${language} snapshotVersion must be ${SNAPSHOT_VERSION}`);
  if (snapshot.snapshotKind !== SNAPSHOT_KIND) fail(`${language} snapshotKind must be ${SNAPSHOT_KIND}`);
  if (snapshot.language !== language) fail(`${language} snapshot language does not match its map key`);
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.trim() === "" || snapshot.runtime === "canonical-reference") fail(`${language} snapshot runtime must identify an executed native package`);
  const expected = currentDigests(registry);
  if (snapshot.capabilityAsOfDate !== expected.capabilityAsOfDate) fail(`${language} capability as-of date differs from canonical source`);
  if (snapshot.capabilityDigest !== expected.capabilityDigest) fail(`${language} capability digest differs from canonical source`);
  exactKeys(snapshot.behavior, BEHAVIOR_KEYS, `${language}.behavior`);
  for (const method of BEHAVIOR_KEYS) {
    if (!Array.isArray(snapshot.behavior[method])) fail(`${language}.behavior.${method} must be an array`);
    for (const [index, entry] of snapshot.behavior[method].entries()) {
      exactKeys(entry, ["caseId", "outcome", "rpcTrace"], `${language}.behavior.${method}[${index}]`);
      if (typeof entry.caseId !== "string") fail(`${language}.behavior.${method}[${index}].caseId is invalid`);
      validateTrace(entry.rpcTrace, `${language}.behavior.${method}[${index}].rpcTrace`);
      validateOutcome(entry.outcome, method, `${language}.behavior.${method}[${index}].outcome`);
    }
  }
  return {
    ...clone(snapshot),
    behavior: {
      prepare: sortCases(snapshot.behavior.prepare),
      simulate: sortCases(snapshot.behavior.simulate),
    },
  };
}

export function verifySnapshots(
  snapshots,
  registry = canonicalRegistry,
  tokenCatalog = canonicalTokenCatalog,
  dexCatalog = canonicalDexCatalog,
  sourceFixture = fixture,
) {
  if (!isRecord(snapshots)) fail("snapshots must be an object keyed by language");
  validateSwapExecutionCapabilities(registry, { tokenCatalog, dexCatalog });
  validateFixtures(sourceFixture);
  const actualLanguages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) {
    fail(`snapshots must contain exactly ${PARITY_LANGUAGES.join(", ")}`);
  }
  const expectedBehavior = fixtureBehavior(sourceFixture, registry, tokenCatalog, dexCatalog);
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizedSnapshot(snapshots[language], language, registry, tokenCatalog, dexCatalog);
    if (stableJson(normalized.behavior) !== stableJson(expectedBehavior)) fail(`${language} native runtime parity mismatch in behavior`);
    results.push({ language, runtime: normalized.runtime, prepareCases: normalized.behavior.prepare.length, simulateCases: normalized.behavior.simulate.length });
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    capabilityAsOfDate: currentDigests(registry).capabilityAsOfDate,
    capabilityDigest: currentDigests(registry).capabilityDigest,
    languages: results,
    status: "ok",
  };
}

async function readSnapshots(source) {
  if (typeof source !== "string" || source.length === 0) fail("snapshot input path is required");
  const text = source.trimStart().startsWith("{") ? source : await readFile(path.resolve(process.cwd(), source), "utf8");
  try { return JSON.parse(text); } catch (error) { fail(`cannot parse parity snapshots: ${error.message}`); }
}

function parseArguments(argumentsList) {
  const options = { help: false, json: false, snapshots: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") {
      if (options.help) fail("--help may be provided only once");
      options.help = true;
    } else if (argument === "--json") {
      if (options.json) fail("--json may be provided only once");
      options.json = true;
    } else if (argument === "--snapshots") {
      if (options.snapshots !== null) fail("--snapshots may be provided only once");
      options.snapshots = argumentsList[++index];
      if (options.snapshots === undefined || options.snapshots.startsWith("--")) fail("--snapshots requires a path or JSON object");
    } else if (argument.startsWith("--")) fail(`unknown option ${argument}`);
    else fail(`unexpected argument ${argument}`);
  }
  if (!options.help && options.snapshots === null) options.snapshots = process.env.ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT ?? null;
  if (!options.help && options.snapshots === null) fail("--snapshots or ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT is required");
  if (options.help && (options.snapshots !== null || options.json)) fail("--help cannot be combined with other options");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-swap-execution-parity.mjs --snapshots <file>",
    "  ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT=<file> node registry/verify-swap-execution-parity.mjs",
    "",
    "The verifier requires exactly one executed native capture for each of TypeScript, Rust, Python, Go, and Ruby.",
  ].join("\n");
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshots = await readSnapshots(options.snapshots);
  const result = verifySnapshots(snapshots);
  process.stdout.write(`${options.json ? JSON.stringify(result) : `swap execution parity: ${result.status} (${result.languages.length} languages)`}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-swap-execution-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
