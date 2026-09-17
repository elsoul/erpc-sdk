#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import canonicalRegistry from "./bridge-capabilities.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import fixture from "./fixtures/mayan-swift-v2-cases.json" with { type: "json" };
import {
  BRIDGE_CAPABILITIES_AS_OF_DATE,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  BRIDGE_CAPABILITY_IDS,
  BRIDGE_CAPABILITY_KEYS,
  BRIDGE_ERROR_MESSAGES,
  BRIDGE_DEPENDENCIES,
  BRIDGE_JUPITER_DEPENDENCY,
  BRIDGE_RUNTIME_KEYS,
  computeDigest,
  getBridgeCapabilityForRoute,
  validateBridgeCapabilities,
} from "./bridge-capabilities.mjs";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "bridge-native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
export const BEHAVIOR_KEYS = Object.freeze(["quote", "build", "status"]);

const ETHEREUM_CHAIN_ID = "eip155:1";
const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const UINT64 = /^(0|[1-9][0-9]*)$/u;
const PROVIDER_SIGNATURE = /^0x[0-9a-f]{130}$/u;
const QUOTE_ID = /^0x[0-9a-f]{32}$/u;
const HEX_BYTES = /^0x[0-9a-f]*$/u;
const URL_PATTERN = /^https:\/\/\S+$/u;
const ERROR_CODES = Object.freeze([
  "BRIDGE_INVALID_ARGUMENT",
  "BRIDGE_UNSUPPORTED_ROUTE",
  "BRIDGE_PROVIDER_AUTH_REQUIRED",
  "BRIDGE_PROVIDER_TRANSPORT",
  "BRIDGE_PROVIDER_HTTP",
  "BRIDGE_PROVIDER_INVALID_RESPONSE",
  "BRIDGE_QUOTE_UNAVAILABLE",
  "BRIDGE_QUOTE_EXPIRED",
  "BRIDGE_QUOTE_MISMATCH",
  "BRIDGE_BUILD_INVALID",
  "BRIDGE_STATUS_NOT_FOUND",
  "BRIDGE_TIMEOUT",
  "BRIDGE_ABORTED",
]);

const FIXTURE_CASE_KEYS = Object.freeze([
  "caseId",
  "method",
  "source",
  "capabilityId",
  "request",
  "nowSeconds",
  "providerStatus",
  "providerBody",
  "expected",
  "httpTrace",
  "config",
  "quoteCaseId",
]);
const QUOTE_KEYS = Object.freeze([
  "quoteKind",
  "providerId",
  "sourceChainId",
  "destinationChainId",
  "sourceTokenDeploymentId",
  "destinationTokenDeploymentId",
  "amountIn",
  "expectedAmountOut",
  "minimumAmountOut",
  "minimumReceived",
  "deadline",
  "slippageBps",
  "quoteId",
  "providerSignature",
  "sourceSwap",
  "dependencies",
  "quoteVerification",
  "rawSignedQuoteJson",
]);
const SOURCE_SWAP_KEYS = Object.freeze([
  "required",
  "inputTokenDeploymentId",
  "intermediateTokenDeploymentId",
  "intermediateTokenAddress",
  "intermediateTokenStandard",
  "intermediateTokenDecimals",
  "providerMinimumAmount",
  "routerKind",
  "routerAddress",
]);
const BUILD_KEYS = Object.freeze([
  "buildKind",
  "providerId",
  "quote",
  "sourceChainId",
  "destinationChainId",
  "transaction",
  "allowance",
  "validation",
  "rawProviderBuildJson",
]);
const BUILD_VALIDATION_KEYS = Object.freeze([
  "level",
  "quoteSignatureLocallyVerified",
  "transactionSemanticsLocallyVerified",
  "settlementLocallyVerified",
]);
const EVM_TRANSACTION_KEYS = Object.freeze(["kind", "chainId", "from", "to", "data", "value"]);
const SOLANA_TRANSACTION_KEYS = Object.freeze(["kind", "chainId", "feePayer", "transactionBase64"]);
const ALLOWANCE_KEYS = Object.freeze(["tokenDeploymentId", "tokenAddress", "owner", "spender", "requiredAmount"]);
const STATUS_KEYS = Object.freeze([
  "statusKind",
  "providerId",
  "sourceChainId",
  "sourceTransactionHash",
  "state",
  "providerClientStatus",
  "providerStatus",
  "statusVerification",
  "rawProviderStatusJson",
]);

export class BridgeParityError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeParityError";
  }
}

function fail(message) {
  throw new BridgeParityError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, { optional = [] } = {}) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} keys are invalid`);
  }
  if (actual.length !== new Set([...keys, ...actual.filter((key) => optional.includes(key))]).size) fail(`${label} has duplicate keys`);
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

function sortedCases(rows) {
  return [...rows].sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);
}

function canonicalUint64(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || !UINT64.test(value) || (positive && value === "0") || value.length > 20) fail(`${label} is not a canonical uint64 string`);
  try {
    const parsed = BigInt(value);
    if (parsed > ((1n << 64n) - 1n) || (positive && parsed === 0n)) fail(`${label} is outside uint64`);
  } catch {
    fail(`${label} is not a canonical uint64 string`);
  }
}

function address(value, chainId, label) {
  if (chainId === ETHEREUM_CHAIN_ID) {
    if (typeof value !== "string" || !EVM_ADDRESS.test(value) || /^0x0{40}$/u.test(value)) fail(`${label} is not a canonical EVM address`);
  } else if (chainId === SOLANA_CHAIN_ID) {
    if (typeof value !== "string" || !SOLANA_ADDRESS.test(value)) fail(`${label} is not a Solana address`);
  } else {
    fail(`${label} uses an unsupported chain`);
  }
}

function validateUrl(value, label) {
  if (typeof value !== "string" || !URL_PATTERN.test(value)) fail(`${label} is not an HTTPS URL`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") fail(`${label} contains an unsafe URL component`);
  } catch {
    fail(`${label} is not a valid HTTPS URL`);
  }
}

function validateTrace(trace, label) {
  if (!Array.isArray(trace)) fail(`${label} must be an array`);
  for (const [index, entry] of trace.entries()) {
    exactKeys(entry, ["method", "url", "headers", "body"], `${label}[${index}]`);
    if (typeof entry.method !== "string" || entry.method !== entry.method.toUpperCase() || !/^[A-Z]+$/u.test(entry.method)) fail(`${label}[${index}].method must be uppercase`);
    validateUrl(entry.url, `${label}[${index}].url`);
    if (!isRecord(entry.headers)) fail(`${label}[${index}].headers must be an object`);
    for (const [name, value] of Object.entries(entry.headers)) {
      if (name !== name.toLowerCase()) fail(`${label}[${index}] header names must be lowercase`);
      if (!["accept", "content-type", "x-api-key", "user-agent", "host", "content-length"].includes(name)) fail(`${label}[${index}] has an unexpected header`);
      if (typeof value !== "string") fail(`${label}[${index}].headers.${name} must be a string`);
      if (name === "authorization" || name === "cookie") fail(`${label}[${index}] must not carry cross-service credentials`);
    }
    if (entry.body !== null && typeof entry.body !== "string") fail(`${label}[${index}].body must be a string or null`);
  }
}

function validateQuote(value, label) {
  exactKeys(value, QUOTE_KEYS, label);
  if (value.quoteKind !== "mayan-swift-v2" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  const capability = getBridgeCapabilityForRoute(value.sourceChainId, value.destinationChainId);
  if (!capability || value.sourceTokenDeploymentId !== capability.sourceTokenDeploymentId || value.destinationTokenDeploymentId !== capability.destinationTokenDeploymentId) fail(`${label} route is invalid`);
  for (const field of ["amountIn", "expectedAmountOut", "minimumAmountOut", "minimumReceived", "deadline"]) canonicalUint64(value[field], `${label}.${field}`, { positive: field !== "deadline" });
  if (!Number.isSafeInteger(value.slippageBps) || value.slippageBps < 0 || value.slippageBps > 500) fail(`${label}.slippageBps is invalid`);
  if (typeof value.quoteId !== "string" || !QUOTE_ID.test(value.quoteId)) fail(`${label}.quoteId is invalid`);
  if (typeof value.providerSignature !== "string" || !PROVIDER_SIGNATURE.test(value.providerSignature)) fail(`${label}.providerSignature is invalid`);
  exactKeys(value.sourceSwap, SOURCE_SWAP_KEYS, `${label}.sourceSwap`);
  if (value.sourceSwap.required !== true || value.sourceSwap.intermediateTokenDecimals !== 6) fail(`${label}.sourceSwap binding is invalid`);
  if (typeof value.sourceSwap.providerMinimumAmount !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value.sourceSwap.providerMinimumAmount) || !Number.isFinite(Number(value.sourceSwap.providerMinimumAmount)) || Number(value.sourceSwap.providerMinimumAmount) <= 0) fail(`${label}.sourceSwap.providerMinimumAmount is invalid`);
  if (![
    "provider-selected-evm",
    "jupiter-v6",
  ].includes(value.sourceSwap.routerKind)) fail(`${label}.sourceSwap.routerKind is invalid`);
  address(value.sourceSwap.intermediateTokenAddress, value.sourceChainId, `${label}.sourceSwap.intermediateTokenAddress`);
  if (value.sourceSwap.routerKind === "provider-selected-evm") address(value.sourceSwap.routerAddress, ETHEREUM_CHAIN_ID, `${label}.sourceSwap.routerAddress`);
  else address(value.sourceSwap.routerAddress, SOLANA_CHAIN_ID, `${label}.sourceSwap.routerAddress`);
  if (!Array.isArray(value.dependencies) || value.dependencies.length < 7 || value.dependencies.some((entry) => typeof entry !== "string")) fail(`${label}.dependencies is invalid`);
  if (value.quoteVerification !== "provider-signed-not-locally-verified" || typeof value.rawSignedQuoteJson !== "string" || value.rawSignedQuoteJson.length === 0) fail(`${label} verification metadata is invalid`);
  try {
    const parsed = JSON.parse(value.rawSignedQuoteJson);
    if (!isRecord(parsed)) fail(`${label}.rawSignedQuoteJson must contain an object`);
  } catch {
    fail(`${label}.rawSignedQuoteJson is not valid JSON`);
  }
}

function validateBuild(value, label) {
  exactKeys(value, BUILD_KEYS, label);
  if (value.buildKind !== "mayan-swift-v2-unsigned" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  validateQuote(value.quote, `${label}.quote`);
  if (value.sourceChainId !== value.quote.sourceChainId || value.destinationChainId !== value.quote.destinationChainId) fail(`${label} route differs from quote`);
  exactKeys(value.validation, BUILD_VALIDATION_KEYS, `${label}.validation`);
  if (value.validation.level !== "structural" || value.validation.quoteSignatureLocallyVerified !== false || value.validation.transactionSemanticsLocallyVerified !== false || value.validation.settlementLocallyVerified !== false) fail(`${label}.validation is invalid`);
  if (typeof value.rawProviderBuildJson !== "string" || value.rawProviderBuildJson.length === 0) fail(`${label}.rawProviderBuildJson is invalid`);
  if (value.sourceChainId === ETHEREUM_CHAIN_ID) {
    exactKeys(value.transaction, EVM_TRANSACTION_KEYS, `${label}.transaction`);
    if (value.transaction.kind !== "evm-unsigned-transaction" || value.transaction.chainId !== ETHEREUM_CHAIN_ID || !EVM_ADDRESS.test(value.transaction.from) || !EVM_ADDRESS.test(value.transaction.to) || !HEX_BYTES.test(value.transaction.data) || value.transaction.value !== "0") fail(`${label}.transaction is invalid`);
    exactKeys(value.allowance, ALLOWANCE_KEYS, `${label}.allowance`);
    if (value.allowance.tokenDeploymentId !== "deployment-0011" || !EVM_ADDRESS.test(value.allowance.tokenAddress) || !EVM_ADDRESS.test(value.allowance.owner) || !EVM_ADDRESS.test(value.allowance.spender) || typeof value.allowance.requiredAmount !== "string") fail(`${label}.allowance is invalid`);
  } else {
    exactKeys(value.transaction, SOLANA_TRANSACTION_KEYS, `${label}.transaction`);
    if (value.transaction.kind !== "solana-v0-unsigned-transaction" || value.transaction.chainId !== SOLANA_CHAIN_ID || !SOLANA_ADDRESS.test(value.transaction.feePayer) || typeof value.transaction.transactionBase64 !== "string" || value.transaction.transactionBase64.length === 0) fail(`${label}.transaction is invalid`);
    if (value.allowance !== null) fail(`${label}.allowance must be null for Solana source`);
  }
}

function validateStatus(value, label) {
  exactKeys(value, STATUS_KEYS, label);
  if (value.statusKind !== "mayan-explorer-index" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  if (![ETHEREUM_CHAIN_ID, SOLANA_CHAIN_ID].includes(value.sourceChainId)) fail(`${label}.sourceChainId is invalid`);
  if (typeof value.sourceTransactionHash !== "string" || value.sourceTransactionHash.length === 0) fail(`${label}.sourceTransactionHash is invalid`);
  if (!["in-progress", "completed", "refunded", "unknown"].includes(value.state)) fail(`${label}.state is invalid`);
  if (typeof value.providerClientStatus !== "string" || value.providerClientStatus.length === 0 || value.providerClientStatus.length > 128) fail(`${label}.providerClientStatus is invalid`);
  if (value.providerStatus !== null && (typeof value.providerStatus !== "string" || value.providerStatus.length > 1024)) fail(`${label}.providerStatus is invalid`);
  if (value.statusVerification !== "provider-indexed-not-locally-verified" || typeof value.rawProviderStatusJson !== "string" || value.rawProviderStatusJson.length === 0) fail(`${label} verification metadata is invalid`);
}

function validateOutcome(outcome, method, label) {
  if (!isRecord(outcome) || typeof outcome.kind !== "string") fail(`${label} outcome is invalid`);
  if (outcome.kind === "sdk-error") {
    exactKeys(outcome, ["kind", "code", "message"], label, { optional: ["status"] });
    if (!ERROR_CODES.includes(outcome.code)) fail(`${label}.code is unsupported`);
    if (outcome.message !== BRIDGE_ERROR_MESSAGES[outcome.code]) fail(`${label}.message differs from the canonical fixed wording`);
    if (Object.hasOwn(outcome, "status") && (!Number.isInteger(outcome.status) || outcome.status < 100 || outcome.status > 599)) fail(`${label}.status is invalid`);
    return;
  }
  if (outcome.kind !== "success") fail(`${label}.kind is unsupported`);
  exactKeys(outcome, ["kind", "value"], label);
  if (method === "quote") {
    if (!Array.isArray(outcome.value) || outcome.value.length === 0) fail(`${label}.value must contain quote results`);
    for (const [index, value] of outcome.value.entries()) validateQuote(value, `${label}.value[${index}]`);
  } else if (method === "build") validateBuild(outcome.value, `${label}.value`);
  else validateStatus(outcome.value, `${label}.value`);
}

function validateFixtureCase(entry, index, ids) {
  const label = `cases[${index}]`;
  exactKeys(entry, FIXTURE_CASE_KEYS, label);
  if (typeof entry.caseId !== "string" || entry.caseId.length === 0 || entry.source !== "synthetic") fail(`${label} identity is invalid`);
  if (!["quote", "build", "status"].includes(entry.method)) fail(`${label}.method is invalid`);
  if (entry.capabilityId !== null && !ids.has(entry.capabilityId)) fail(`${label}.capabilityId is invalid`);
  if (!isRecord(entry.request)) fail(`${label}.request must be an object`);
  if (!Number.isSafeInteger(entry.nowSeconds)) fail(`${label}.nowSeconds must be a safe integer`);
  if (entry.providerStatus !== null && (!Number.isInteger(entry.providerStatus) || entry.providerStatus < 100 || entry.providerStatus > 599)) fail(`${label}.providerStatus is invalid`);
  if (entry.providerBody !== null && typeof entry.providerBody !== "string") fail(`${label}.providerBody must be a string or null`);
  if (entry.config !== null && !isRecord(entry.config)) fail(`${label}.config must be an object or null`);
  if (entry.quoteCaseId !== null && typeof entry.quoteCaseId !== "string") fail(`${label}.quoteCaseId must be a string or null`);
  validateOutcome(entry.expected, entry.method, `${label}.expected`);
  validateTrace(entry.httpTrace, `${label}.httpTrace`);
  if (entry.method === "build" && entry.quoteCaseId === null) fail(`${label}.quoteCaseId is required for build cases`);
  if (entry.capabilityId !== null && entry.method !== "status") {
    const capability = canonicalRegistry.capabilities.find((row) => row.bridgeCapabilityId === entry.capabilityId);
    if (!capability) fail(`${label}.capabilityId is unknown`);
  }
}

export function validateFixtures(value = fixture, { registry = canonicalRegistry } = {}) {
  exactKeys(value, ["schemaVersion", "fixtureKind", "capabilityAsOfDate", "capabilityDigest", "cases"], "fixture");
  if (value.schemaVersion !== 1 || value.fixtureKind !== "mayan-swift-v2-fixtures") fail("fixture schema or kind is invalid");
  const digest = computeDigest(registry.capabilities);
  if (value.capabilityAsOfDate !== registry.asOfDate || value.capabilityDigest !== digest) fail("fixture capability metadata differs from canonical source");
  if (!Array.isArray(value.cases) || value.cases.length === 0) fail("fixture.cases must be a non-empty array");
  const ids = new Set(BRIDGE_CAPABILITY_IDS);
  const caseIds = new Set();
  for (const [index, entry] of value.cases.entries()) {
    if (caseIds.has(entry?.caseId)) fail(`duplicate fixture case ${entry?.caseId}`);
    caseIds.add(entry?.caseId);
    validateFixtureCase(entry, index, ids);
  }
  const methods = new Set(value.cases.map((entry) => entry.method));
  for (const method of BEHAVIOR_KEYS) if (!methods.has(method)) fail(`fixture is missing ${method} cases`);
  return true;
}

export function fixtureBehavior(value = fixture, registry = canonicalRegistry) {
  validateFixtures(value, { registry });
  const grouped = { quote: [], build: [], status: [] };
  for (const entry of sortedCases(value.cases)) grouped[entry.method].push({ caseId: entry.caseId, outcome: clone(entry.expected), httpTrace: clone(entry.httpTrace) });
  return grouped;
}

export function buildExpectedSnapshot(registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture) {
  validateBridgeCapabilities(registry, { tokenCatalog });
  validateFixtures(sourceFixture, { registry });
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    capabilityAsOfDate: registry.asOfDate,
    capabilityDigest: computeDigest(registry.capabilities),
    behavior: fixtureBehavior(sourceFixture, registry),
  };
}

function normalizeTrace(trace, label) {
  validateTrace(trace, label);
  return trace.map((entry) => ({
    ...clone(entry),
    headers: Object.fromEntries(Object.entries(entry.headers).filter(([name]) => !["user-agent", "host", "content-length"].includes(name))),
  }));
}

function normalizeSnapshot(snapshot, language, registry = canonicalRegistry) {
  exactKeys(snapshot, ["snapshotVersion", "snapshotKind", "language", "runtime", "capabilityAsOfDate", "capabilityDigest", "behavior"], `${language} snapshot`);
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION || snapshot.snapshotKind !== SNAPSHOT_KIND || snapshot.language !== language) fail(`${language} snapshot envelope is invalid`);
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.length === 0 || snapshot.runtime === "canonical-reference") fail(`${language} snapshot runtime is invalid`);
  if (snapshot.capabilityAsOfDate !== registry.asOfDate || snapshot.capabilityDigest !== computeDigest(registry.capabilities)) fail(`${language} capability metadata differs from canonical source`);
  exactKeys(snapshot.behavior, BEHAVIOR_KEYS, `${language}.behavior`);
  const behavior = {};
  for (const method of BEHAVIOR_KEYS) {
    if (!Array.isArray(snapshot.behavior[method])) fail(`${language}.behavior.${method} must be an array`);
    behavior[method] = sortedCases(snapshot.behavior[method]).map((entry, index) => {
      exactKeys(entry, ["caseId", "outcome", "httpTrace"], `${language}.behavior.${method}[${index}]`);
      if (typeof entry.caseId !== "string") fail(`${language}.behavior.${method}[${index}].caseId is invalid`);
      validateOutcome(entry.outcome, method, `${language}.behavior.${method}[${index}].outcome`);
      return { caseId: entry.caseId, outcome: clone(entry.outcome), httpTrace: normalizeTrace(entry.httpTrace, `${language}.behavior.${method}[${index}].httpTrace`) };
    });
  }
  return { ...clone(snapshot), behavior };
}

export function verifySnapshots(snapshots, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture) {
  if (!isRecord(snapshots)) fail("snapshots must be an object keyed by language");
  validateBridgeCapabilities(registry, { tokenCatalog });
  const expected = fixtureBehavior(sourceFixture, registry);
  const actualLanguages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) fail(`snapshots must contain exactly ${PARITY_LANGUAGES.join(", ")}`);
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizeSnapshot(snapshots[language], language, registry);
    const normalizedBehavior = Object.fromEntries(BEHAVIOR_KEYS.map((method) => [method, normalized.behavior[method].map((entry) => ({ ...entry, httpTrace: normalizeTrace(entry.httpTrace, `${language}.${method}.httpTrace`) }))]));
    if (stableJson(normalizedBehavior) !== stableJson(expected)) fail(`${language} native runtime parity mismatch in behavior`);
    results.push({ language, runtime: normalized.runtime, quoteCases: normalized.behavior.quote.length, buildCases: normalized.behavior.build.length, statusCases: normalized.behavior.status.length });
  }
  return { snapshotVersion: SNAPSHOT_VERSION, snapshotKind: SNAPSHOT_KIND, capabilityAsOfDate: registry.asOfDate, capabilityDigest: computeDigest(registry.capabilities), languages: results, status: "ok" };
}

async function readSnapshots(source) {
  if (typeof source !== "string" || source.length === 0) fail("snapshot input path is required");
  const text = source.trimStart().startsWith("{") ? source : await readFile(path.resolve(process.cwd(), source), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    fail("cannot parse bridge parity snapshots");
  }
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
  if (!options.help && options.snapshots === null) options.snapshots = process.env.ERPC_SDK_BRIDGE_PARITY_OUTPUT ?? null;
  if (!options.help && options.snapshots === null) fail("--snapshots or ERPC_SDK_BRIDGE_PARITY_OUTPUT is required");
  if (options.help && (options.snapshots !== null || options.json)) fail("--help cannot be combined with other options");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-bridge-parity.mjs --snapshots <file>",
    "  ERPC_SDK_BRIDGE_PARITY_OUTPUT=<file> node registry/verify-bridge-parity.mjs",
    "",
    "The verifier requires exactly one executed native capture for TypeScript, Rust, Python, Go, and Ruby.",
  ].join("\n");
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = verifySnapshots(await readSnapshots(options.snapshots));
  process.stdout.write(`${options.json ? JSON.stringify(result) : `bridge parity: ${result.status} (${result.languages.length} languages)`}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-bridge-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
