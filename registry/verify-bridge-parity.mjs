#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import canonicalRegistry from "./bridge-capabilities.json" with { type: "json" };
import canonicalTokenCatalog from "./token-catalog.json" with { type: "json" };
import fixture from "./fixtures/mayan-swift-v2-cases.json" with { type: "json" };
import localFixture from "./fixtures/mayan-swift-v2-local-build-cases.json" with { type: "json" };
import {
  BRIDGE_CAPABILITIES_AS_OF_DATE,
  BRIDGE_CAPABILITIES_CONTENT_DIGEST,
  BRIDGE_CAPABILITY_IDS,
  BRIDGE_CAPABILITY_KEYS,
  BRIDGE_ERROR_MESSAGES,
  BRIDGE_RUNTIME_KEYS,
  computeDigest,
  getBridgeCapabilityForRoute,
  validateBridgeCapabilities,
} from "./bridge-capabilities.mjs";

export const SNAPSHOT_VERSION = 2;
export const LEGACY_SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "bridge-native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
export const BEHAVIOR_KEYS = Object.freeze(["quote", "build", "status"]);
export const LOCAL_BEHAVIOR_KEYS = Object.freeze(["prepareSourceSwap", "buildLocalUnsigned"]);
export const SNAPSHOT_BEHAVIOR_KEYS = Object.freeze([...BEHAVIOR_KEYS, ...LOCAL_BEHAVIOR_KEYS]);
export const HOSTED_FIXTURE_DIGEST = "3c414e362b518a3845e365c3c7c6f78e43984aae396be19817ddb53bb0da6283";
export const HOSTED_FIXTURE_SEMANTIC_DIGEST = "843748ff68a12d32b0fee400093b9f25eed0f8100bc4082de5d693a9cd6db53a";

const ETHEREUM_CHAIN_ID = "eip155:1";
const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ETHEREUM_FORWARDER = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2";
const ETHEREUM_SWIFT = "0x40ffe85a28dc9993541449464d7529a922142960";
const ETHEREUM_EURC_ROUTER = "0xa929c559e5e6537359680f39cb4e3708e1a14dd1";
const SOLANA_MAYAN_ALT = "Ff3yi1meWQQ19VPZMzGg6H8JQQeRudiV7QtVtyzJyoht";
const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
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
  "BRIDGE_LOCAL_RPC_REQUIRED",
  "BRIDGE_SOURCE_RPC_TRANSPORT",
  "BRIDGE_SOURCE_RPC_INVALID_RESPONSE",
  "BRIDGE_LOCAL_PLAN_INVALID",
  "BRIDGE_LOCAL_BUILD_INVALID",
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
const QUOTE_MUTATION_KINDS = Object.freeze(["normalized-set", "raw-replace"]);
const QUOTE_MUTATION_NORMALIZED_PATHS = Object.freeze(["sourceSwap.required", "sourceTokenDeploymentId"]);
const FROZEN_LEGACY_FIXTURE_CASE_IDS = Object.freeze([
  "quote-eth-sol-synthetic",
  "quote-sol-eth-synthetic",
  "build-eth-sol-synthetic",
  "build-sol-eth-synthetic",
  "status-eth-inprogress-synthetic",
  "status-eth-completed-synthetic",
  "status-sol-refunded-synthetic",
  "status-sol-unknown-synthetic",
  "status-eth-not-found-synthetic",
  "quote-duplicate-key",
  "quote-malformed-json",
  "quote-expired",
  "quote-mismatched-amount",
  "quote-bad-signature-shape",
  "quote-json-depth-limit",
  "quote-body-size-limit",
  "quote-unsupported-route",
  "build-auth-required-local",
  "build-quote-mismatch",
  "build-evm-forwarder-violation",
  "build-evm-selector-violation",
  "build-evm-value-violation",
  "build-solana-framing-violation",
  "build-solana-fee-payer-violation",
  "build-solana-extra-signer-violation",
  "build-solana-swap-message-violation",
  "build-http-auth-401",
  "build-http-rate-limit-429",
  "quote-redirect-rejected",
  "quote-timeout",
  "quote-aborted",
  "status-invalid-evm-hash",
  "status-invalid-provider-fields",
  "build-eth-sol-wrong-evm-destination",
  "build-sol-eth-wrong-solana-destination",
  "quote-eth-sol-zero-validity-margin",
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
const LOCAL_FIXTURE_KEYS = Object.freeze([
  "schemaVersion",
  "fixtureKind",
  "capabilityAsOfDate",
  "capabilityDigest",
  "hostedFixtureSha256",
  "hostedFixtureSemanticSha256",
  "localFixtureDigest",
  "referenceCommit",
  "officialSdkVersion",
  "oracle",
  "quotes",
  "sourceSwapMocks",
  "rpcMocks",
  "cases",
]);
const LOCAL_QUOTE_RECORD_KEYS = Object.freeze(["quoteId", "capabilityId", "rawQuoteJson", "rawQuoteSha256", "normalizedQuote"]);
const LOCAL_CASE_KEYS = Object.freeze([
  "caseId",
  "method",
  "source",
  "capabilityId",
  "quoteId",
  "context",
  "sourceSwapMockIds",
  "rpcMockIds",
  "sourceSwapPlanRef",
  "expected",
  "httpTrace",
  "rpcTrace",
  "mutation",
  "config",
]);
const LOCAL_PLAN_KEYS = Object.freeze([
  "planKind",
  "providerId",
  "capabilityId",
  "sourceChainId",
  "destinationChainId",
  "sourceTokenDeploymentId",
  "destinationTokenDeploymentId",
  "quoteId",
  "rawQuoteSha256",
  "orderNonce",
  "swapperAddress",
  "destinationAddress",
  "orderHash",
  "quoteBindingHash",
  "minimumIntermediateAmount",
  "sourceSwap",
  "planHash",
]);
const LOCAL_SOURCE_RPC_EVM_KEYS = Object.freeze(["kind", "rpcChainId", "code"]);
const LOCAL_SOURCE_RPC_SOLANA_KEYS = Object.freeze([
  "kind",
  "genesisHash",
  "blockhashContextSlot",
  "accountContextSlot",
  "recentBlockhash",
  "lastValidBlockHeight",
  "lookupTables",
]);
const LOCAL_BUILD_KEYS = Object.freeze([
  "buildKind",
  "providerId",
  "capabilityId",
  "quote",
  "sourceChainId",
  "destinationChainId",
  "sourceSwapPlan",
  "transaction",
  "allowance",
  "construction",
  "validation",
]);
const LOCAL_CONSTRUCTION_KEYS = Object.freeze([
  "mode",
  "referenceCommit",
  "orderNonce",
  "orderHash",
  "minimumIntermediateAmount",
  "effectiveDependencies",
  "sourceRpcEvidence",
]);
const LOCAL_VALIDATION_KEYS = Object.freeze([
  "level",
  "quoteSignatureLocallyVerified",
  "planBindingLocallyVerified",
  "transactionBytesLocallyConstructed",
  "settlementLocallyVerified",
]);
const LOCAL_SOURCE_SWAP_NONE_KEYS = Object.freeze(["kind"]);
const LOCAL_SOURCE_SWAP_EVM_KEYS = Object.freeze([
  "kind",
  "routerAddress",
  "calldata",
  "rawResponseSha256",
  "rawProviderSourceSwapJson",
]);
const LOCAL_SOURCE_SWAP_SOLANA_KEYS = Object.freeze([
  "kind",
  "instructions",
  "addressLookupTableAddresses",
  "rawResponseSha256",
  "rawProviderSourceSwapJson",
]);
const LOCAL_INSTRUCTION_KEYS = Object.freeze(["programId", "accounts", "dataBase64"]);
const LOCAL_ACCOUNT_KEYS = Object.freeze(["pubkey", "isSigner", "isWritable"]);
const LOCAL_EVM_CODE_KEYS = Object.freeze(["address", "keccak256"]);
const LOCAL_LOOKUP_TABLE_EVIDENCE_KEYS = Object.freeze(["address", "dataSha256"]);
const LOCAL_NONCE = /^0x[0-9a-f]{32}$/u;
const LOCAL_SHA256 = /^[0-9a-f]{64}$/u;
const LOCAL_KECCAK = /^0x[0-9a-f]{64}$/u;
const LOCAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const LOCAL_SNAPSHOT_ENTRY_KEYS = Object.freeze(["caseId", "outcome", "httpTrace", "rpcTrace"]);
const LOCAL_TRANSPORT_MUTATION_EVENTS = Object.freeze([
  "source-swap-timeout",
  "source-swap-abort",
  "rpc-transport-error",
  "rpc-timeout",
  "rpc-abort",
]);
const LOCAL_CONTEXT_MUTATION_PATHS = Object.freeze([
  "sourceChainId",
  "destinationChainId",
  "sourceTokenDeploymentId",
  "destinationTokenDeploymentId",
  "swapperAddress",
  "destinationAddress",
  "orderNonce",
]);
const LOCAL_QUOTE_NORMALIZED_MUTATION_PATHS = Object.freeze([
  "sourceChainId",
  "destinationChainId",
  "sourceTokenDeploymentId",
  "destinationTokenDeploymentId",
  "amountIn",
  "expectedAmountOut",
  "minimumAmountOut",
  "deadline",
  "slippageBps",
  "minimumReceived",
  "quoteId",
  "providerId",
  "providerSignature",
  "rawSignedQuoteJson",
  "sourceSwap.required",
  "sourceSwap.providerMinimumAmount",
  "sourceSwap.routerKind",
  "sourceSwap.routerAddress",
]);
const LOCAL_QUOTE_RAW_MUTATION_PATHS = Object.freeze([
  "swiftAuctionMode",
  "minMiddleAmount",
  "swiftInputContract",
  "swiftMayanContract",
  "gasDrop",
  "customPayload",
  "memoHex",
  "onlyBridging",
  "swiftWrapAndLock",
  "type",
  "swiftVersion",
  "gasless",
  "suggestedPriorityFee",
  "signature",
  "expectedAmountOut",
  "minAmountOut",
  "minReceived",
  "effectiveAmountIn64",
  "deadline64",
  "slippageBps",
  "evmSwapRouterAddress",
  "evmSwapRouterCalldata",
  "fromChain",
  "toChain",
  "fromToken.contract",
  "toToken.contract",
  "toToken.mint",
]);
const LOCAL_SOURCE_SWAP_MUTATION_PATHS = Object.freeze([
  "swapRouterAddress",
  "swapRouterCalldata",
  "swapInstruction.programId",
  "swapInstruction.accounts[0].isSigner",
  "swapInstruction.accounts[0].isWritable",
  "swapInstruction.accounts[1].pubkey",
  "swapInstruction.accounts[1].isSigner",
  "swapInstruction.accounts[1].isWritable",
  "swapInstruction.accounts[2].pubkey",
  "swapInstruction.accounts[2].isSigner",
  "swapInstruction.accounts[2].isWritable",
  "swapInstruction.accounts[3].pubkey",
  "swapInstruction.accounts[3].isSigner",
  "swapInstruction.accounts[3].isWritable",
  "swapInstruction.accounts[4].pubkey",
  "swapInstruction.accounts[4].isSigner",
  "swapInstruction.accounts[4].isWritable",
  "swapInstruction.accounts[5].pubkey",
  "swapInstruction.accounts[5].isSigner",
  "swapInstruction.accounts[5].isWritable",
  "swapInstruction.accounts[6].pubkey",
  "swapInstruction.accounts[6].isSigner",
  "swapInstruction.accounts[6].isWritable",
  "swapInstruction.accounts[7].pubkey",
  "swapInstruction.accounts[7].isSigner",
  "swapInstruction.accounts[7].isWritable",
  "swapInstruction.accounts[8].pubkey",
  "swapInstruction.accounts[8].isSigner",
  "swapInstruction.accounts[8].isWritable",
  "swapInstruction.accounts[9].pubkey",
  "swapInstruction.accounts[9].isSigner",
  "swapInstruction.accounts[9].isWritable",
  "swapInstruction.accounts[10].pubkey",
  "swapInstruction.accounts[10].isSigner",
  "swapInstruction.accounts[10].isWritable",
  "swapInstruction.accounts[11].pubkey",
  "swapInstruction.accounts[11].isSigner",
  "swapInstruction.accounts[11].isWritable",
  "swapInstruction.accounts[12].pubkey",
  "swapInstruction.accounts[12].isSigner",
  "swapInstruction.accounts[12].isWritable",
  "swapInstruction.accounts[13].pubkey",
  "swapInstruction.accounts[13].isSigner",
  "swapInstruction.accounts[13].isWritable",
  "swapInstruction.accounts[14].pubkey",
  "swapInstruction.accounts[14].isSigner",
  "swapInstruction.accounts[14].isWritable",
  "swapInstruction.accounts[15].pubkey",
  "swapInstruction.accounts[15].isSigner",
  "swapInstruction.accounts[15].isWritable",
  "swapInstruction.accounts[16].pubkey",
  "swapInstruction.accounts[16].isSigner",
  "swapInstruction.accounts[16].isWritable",
  "swapInstruction.accounts[17].pubkey",
  "swapInstruction.accounts[17].isSigner",
  "swapInstruction.accounts[17].isWritable",
  "swapInstruction.accounts[18].pubkey",
  "swapInstruction.accounts[18].isSigner",
  "swapInstruction.accounts[18].isWritable",
  "swapInstruction.accounts[19].pubkey",
  "swapInstruction.accounts[19].isSigner",
  "swapInstruction.accounts[19].isWritable",
  "swapInstruction.accounts[20].pubkey",
  "swapInstruction.accounts[20].isSigner",
  "swapInstruction.accounts[20].isWritable",
  "swapInstruction.accounts[21].pubkey",
  "swapInstruction.accounts[21].isSigner",
  "swapInstruction.accounts[21].isWritable",
  "swapInstruction.accounts[22].pubkey",
  "swapInstruction.accounts[22].isSigner",
  "swapInstruction.accounts[22].isWritable",
  "swapInstruction.accounts[23].pubkey",
  "swapInstruction.accounts[23].isSigner",
  "swapInstruction.accounts[23].isWritable",
  "swapInstruction.accounts[24].pubkey",
  "swapInstruction.accounts[24].isSigner",
  "swapInstruction.accounts[24].isWritable",
  "setupInstructions[0].accounts[0].pubkey",
  "setupInstructions[0].accounts[0].isSigner",
  "setupInstructions[0].accounts[0].isWritable",
  "setupInstructions[0].accounts[2].isSigner",
  "setupInstructions[0].accounts[2].isWritable",
  "setupInstructions[1].accounts[0].pubkey",
  "setupInstructions[1].accounts[0].isSigner",
  "setupInstructions[1].accounts[0].isWritable",
  "setupInstructions[1].accounts[2].isSigner",
  "setupInstructions[1].accounts[2].isWritable",
  "quoteResponse.raw.routePlan[0].swapInfo.inAmount",
  "quoteResponse.raw.routePlan[0].swapInfo.outAmount",
  "quoteResponse.raw.routePlan[0].swapInfo.ammKey",
  "quoteResponse.raw.routePlan[0].swapInfo.label",
]);
const LOCAL_RPC_MUTATION_PATHS = Object.freeze([
  "eth_chainId.result",
  "eth_getCode.result",
  "getGenesisHash.result",
  "getLatestBlockhash.value.blockhash",
  "getLatestBlockhash.value.lastValidBlockHeight",
  "getLatestBlockhash.context.slot",
  "getMultipleAccounts.context.slot",
  "getMultipleAccounts.value[0]",
  "getMultipleAccounts.value[0].executable",
  "getMultipleAccounts.value[0].owner",
  "getMultipleAccounts.value[0].data[0]",
  "getMultipleAccounts.value[0].data[1]",
  "getMultipleAccounts.value[1]",
  "getMultipleAccounts.value[1].executable",
  "getMultipleAccounts.value[1].owner",
  "getMultipleAccounts.value[1].data[0]",
]);
const LOCAL_RPC_ENVELOPE_MUTATION_PATHS = Object.freeze([
  "jsonrpc",
  "version",
  "id",
  "depth",
  "size",
]);
const LOCAL_PLAN_MUTATION_PATHS = Object.freeze([
  "orderNonce",
  "orderHash",
  "quoteBindingHash",
  "planHash",
  "minimumIntermediateAmount",
  "sourceSwap.rawResponseSha256",
  "sourceSwap.calldata",
  "sourceSwap.instructions[0].programId",
  "sourceSwap.instructions[0].dataBase64",
  "sourceSwap.instructions[0].accounts[0].pubkey",
  "sourceSwap.instructions[0].accounts[0].isSigner",
  "sourceSwap.instructions[4].accounts[0].isSigner",
  "sourceSwap.instructions[4].accounts[1].pubkey",
  "sourceSwap.instructions[4].accounts[1].isWritable",
  "sourceSwap.instructions[4].accounts[2].isSigner",
  "sourceSwap.instructions[4].accounts[2].isWritable",
  "sourceSwap.instructions[4].accounts[13].pubkey",
  "sourceSwap.instructions[4].accounts[13].isWritable",
  "sourceSwap.instructions[4].accounts[14].pubkey",
  "sourceSwap.instructions[4].accounts[15].isSigner",
  "sourceSwap.instructions[4].accounts[15].pubkey",
  "sourceSwap.instructions[4].accounts[16].pubkey",
  "sourceSwap.instructions[4].accounts[17].pubkey",
  "sourceSwap.instructions[4].accounts[18].pubkey",
  "sourceSwap.instructions[4].accounts[19].pubkey",
  "sourceSwap.instructions[4].accounts[20].pubkey",
  "sourceSwap.instructions[4].accounts[21].pubkey",
  "sourceSwap.instructions[4].accounts[22].pubkey",
  "sourceSwap.instructions[4].accounts[23].pubkey",
  "sourceSwap.instructions[4].accounts[24].pubkey",
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

function validateUrl(value, label, { allowQuery = false } = {}) {
  if (typeof value !== "string" || !URL_PATTERN.test(value)) fail(`${label} is not an HTTPS URL`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || (!allowQuery && parsed.search !== "") || parsed.hash !== "") fail(`${label} contains an unsafe URL component`);
  } catch {
    fail(`${label} is not a valid HTTPS URL`);
  }
}

function validateTrace(trace, label, { allowQuery = false } = {}) {
  if (!Array.isArray(trace)) fail(`${label} must be an array`);
  for (const [index, entry] of trace.entries()) {
    exactKeys(entry, ["method", "url", "headers", "body"], `${label}[${index}]`);
    if (typeof entry.method !== "string" || entry.method !== entry.method.toUpperCase() || !/^[A-Z]+$/u.test(entry.method)) fail(`${label}[${index}].method must be uppercase`);
    validateUrl(entry.url, `${label}[${index}].url`, { allowQuery });
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

function validateQuoteMutation(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (typeof value.kind !== "string" || !QUOTE_MUTATION_KINDS.includes(value.kind)) fail(`${label}.kind is invalid`);
  if (value.kind === "normalized-set") {
    exactKeys(value, ["kind", "path", "value"], label);
    if (!QUOTE_MUTATION_NORMALIZED_PATHS.includes(value.path)) fail(`${label} normalized mutation is invalid`);
    if (value.path === "sourceSwap.required" && value.value === true) return;
    if (value.path === "sourceTokenDeploymentId" && ["deployment-0008", "deployment-0011"].includes(value.value)) return;
    fail(`${label} normalized mutation is invalid`);
  }
  exactKeys(value, ["kind", "path", "from", "to"], label);
  if (value.path !== "rawSignedQuoteJson" || typeof value.from !== "string" || value.from.length === 0 || typeof value.to !== "string" || value.to.length === 0 || value.from === value.to) fail(`${label} raw mutation is invalid`);
}

function validateQuote(value, label) {
  exactKeys(value, QUOTE_KEYS, label);
  if (value.quoteKind !== "mayan-swift-v2" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  const capability = getBridgeCapabilityForRoute(value.sourceChainId, value.destinationChainId, value.sourceTokenDeploymentId, value.destinationTokenDeploymentId);
  if (!capability || value.sourceTokenDeploymentId !== capability.sourceTokenDeploymentId || value.destinationTokenDeploymentId !== capability.destinationTokenDeploymentId) fail(`${label} route is invalid`);
  for (const field of ["amountIn", "expectedAmountOut", "minimumAmountOut", "minimumReceived", "deadline"]) canonicalUint64(value[field], `${label}.${field}`, { positive: field !== "deadline" });
  if (!Number.isSafeInteger(value.slippageBps) || value.slippageBps < 0 || value.slippageBps > 500) fail(`${label}.slippageBps is invalid`);
  if (typeof value.quoteId !== "string" || !QUOTE_ID.test(value.quoteId)) fail(`${label}.quoteId is invalid`);
  if (typeof value.providerSignature !== "string" || !PROVIDER_SIGNATURE.test(value.providerSignature)) fail(`${label}.providerSignature is invalid`);
  exactKeys(value.sourceSwap, SOURCE_SWAP_KEYS, `${label}.sourceSwap`);
  const direct = capability.bridgeCapabilityId.includes("-usdc-");
  const expectedSourceSwapRequired = !direct;
  if (value.sourceSwap.required !== expectedSourceSwapRequired || value.sourceSwap.intermediateTokenDecimals !== 6) fail(`${label}.sourceSwap binding is invalid`);
  if (typeof value.sourceSwap.providerMinimumAmount !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value.sourceSwap.providerMinimumAmount) || !Number.isFinite(Number(value.sourceSwap.providerMinimumAmount)) || Number(value.sourceSwap.providerMinimumAmount) <= 0) fail(`${label}.sourceSwap.providerMinimumAmount is invalid`);
  const providerStandard = value.sourceChainId === SOLANA_CHAIN_ID ? "spl" : "erc20";
  const intermediateDeploymentId = capability.sourceUsdcDeploymentId;
  if (value.sourceSwap.inputTokenDeploymentId !== capability.sourceTokenDeploymentId || value.sourceSwap.intermediateTokenDeploymentId !== intermediateDeploymentId || value.sourceSwap.intermediateTokenAddress !== capability.sourceUsdcAddress || value.sourceSwap.intermediateTokenStandard !== providerStandard) fail(`${label}.sourceSwap token binding is invalid`);
  address(value.sourceSwap.intermediateTokenAddress, value.sourceChainId, `${label}.sourceSwap.intermediateTokenAddress`);
  if (direct) {
    if (value.sourceSwap.routerKind !== null || value.sourceSwap.routerAddress !== null) fail(`${label}.sourceSwap direct router must be null`);
  } else {
    if (!["provider-selected-evm", "jupiter-v6"].includes(value.sourceSwap.routerKind)) fail(`${label}.sourceSwap.routerKind is invalid`);
    if (value.sourceSwap.routerKind === "provider-selected-evm") address(value.sourceSwap.routerAddress, ETHEREUM_CHAIN_ID, `${label}.sourceSwap.routerAddress`);
    else address(value.sourceSwap.routerAddress, SOLANA_CHAIN_ID, `${label}.sourceSwap.routerAddress`);
  }
  if (!Array.isArray(value.dependencies) || stableJson(value.dependencies) !== stableJson(capability.dependencies)) fail(`${label}.dependencies is invalid`);
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
    const capability = getBridgeCapabilityForRoute(value.sourceChainId, value.destinationChainId, value.quote.sourceTokenDeploymentId, value.quote.destinationTokenDeploymentId);
    if (value.transaction.kind !== "evm-unsigned-transaction" || value.transaction.chainId !== ETHEREUM_CHAIN_ID || !EVM_ADDRESS.test(value.transaction.from) || !EVM_ADDRESS.test(value.transaction.to) || !HEX_BYTES.test(value.transaction.data) || value.transaction.value !== "0" || !capability || capability.forwarderAddress === null || capability.forwarderFunctionSelector === null || value.transaction.to !== capability.forwarderAddress || !value.transaction.data.toLowerCase().startsWith(capability.forwarderFunctionSelector)) fail(`${label}.transaction is invalid`);
    exactKeys(value.allowance, ALLOWANCE_KEYS, `${label}.allowance`);
    if (!capability || value.allowance.tokenDeploymentId !== capability.sourceTokenDeploymentId || value.allowance.tokenAddress !== capability.sourceTokenAddress || !EVM_ADDRESS.test(value.allowance.owner) || !EVM_ADDRESS.test(value.allowance.spender) || capability.forwarderAddress === null || value.allowance.spender !== capability.forwarderAddress || typeof value.allowance.requiredAmount !== "string") fail(`${label}.allowance is invalid`);
  } else {
    exactKeys(value.transaction, SOLANA_TRANSACTION_KEYS, `${label}.transaction`);
    if (value.transaction.kind !== "solana-v0-unsigned-transaction" || value.transaction.chainId !== SOLANA_CHAIN_ID || !SOLANA_ADDRESS.test(value.transaction.feePayer) || typeof value.transaction.transactionBase64 !== "string" || value.transaction.transactionBase64.length === 0) fail(`${label}.transaction is invalid`);
    if (value.allowance !== null) fail(`${label}.allowance must be null for Solana source`);
  }
}

function localSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function localDigest(value) {
  return localSha256(stableJson(value));
}

function validateLocalHash(value, label) {
  if (typeof value !== "string" || !LOCAL_SHA256.test(value)) fail(`${label} is not a SHA-256 digest`);
}

function validateLocalNonce(value, label) {
  if (typeof value !== "string" || !LOCAL_NONCE.test(value)) fail(`${label} is not a canonical 16-byte nonce`);
}

function validateBase64(value, label) {
  if (typeof value !== "string" || !LOCAL_BASE64.test(value)) fail(`${label} is not canonical base64`);
  try {
    Buffer.from(value, "base64");
  } catch {
    fail(`${label} is not canonical base64`);
  }
}

function validateLocalInstruction(value, label) {
  exactKeys(value, LOCAL_INSTRUCTION_KEYS, label);
  address(value.programId, SOLANA_CHAIN_ID, `${label}.programId`);
  if (!Array.isArray(value.accounts)) fail(`${label}.accounts must be an array`);
  for (const [index, account] of value.accounts.entries()) {
    exactKeys(account, LOCAL_ACCOUNT_KEYS, `${label}.accounts[${index}]`);
    address(account.pubkey, SOLANA_CHAIN_ID, `${label}.accounts[${index}].pubkey`);
    if (typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") fail(`${label}.accounts[${index}] flags are invalid`);
  }
  validateBase64(value.dataBase64, `${label}.dataBase64`);
}

function validateLocalSourceSwap(value, capability, label) {
  const direct = capability.bridgeCapabilityId.includes("-usdc-");
  if (direct) {
    exactKeys(value, LOCAL_SOURCE_SWAP_NONE_KEYS, label);
    if (value.kind !== "none") fail(`${label}.kind must be none for direct USDC`);
    return;
  }
  if (capability.sourceChainId === ETHEREUM_CHAIN_ID) {
    exactKeys(value, LOCAL_SOURCE_SWAP_EVM_KEYS, label);
    if (value.kind !== "evm-router" || typeof value.routerAddress !== "string" || !EVM_ADDRESS.test(value.routerAddress) || /^0x0{40}$/u.test(value.routerAddress) || typeof value.calldata !== "string" || !HEX_BYTES.test(value.calldata) || value.calldata.length < 4 || value.calldata.length % 2 !== 0) fail(`${label} EVM source swap is invalid`);
  } else {
    exactKeys(value, LOCAL_SOURCE_SWAP_SOLANA_KEYS, label);
    if (value.kind !== "solana-jupiter-v6" || !Array.isArray(value.instructions) || value.instructions.length === 0 || !Array.isArray(value.addressLookupTableAddresses)) fail(`${label} Solana source swap is invalid`);
    for (const [index, instruction] of value.instructions.entries()) validateLocalInstruction(instruction, `${label}.instructions[${index}]`);
    for (const [index, lookupTable] of value.addressLookupTableAddresses.entries()) address(lookupTable, SOLANA_CHAIN_ID, `${label}.addressLookupTableAddresses[${index}]`);
    if (new Set(value.addressLookupTableAddresses).size !== value.addressLookupTableAddresses.length || value.addressLookupTableAddresses.length > 8) fail(`${label}.addressLookupTableAddresses is invalid`);
  }
  validateLocalHash(value.rawResponseSha256, `${label}.rawResponseSha256`);
  if (typeof value.rawProviderSourceSwapJson !== "string" || value.rawProviderSourceSwapJson.length === 0) fail(`${label}.rawProviderSourceSwapJson is invalid`);
  try {
    if (!isRecord(JSON.parse(value.rawProviderSourceSwapJson))) fail(`${label}.rawProviderSourceSwapJson must be an object`);
  } catch {
    fail(`${label}.rawProviderSourceSwapJson is invalid`);
  }
}

function validateLocalSourceRpcEvidence(value, chainId, label, sourceSwap = { kind: "none" }) {
  if (chainId === ETHEREUM_CHAIN_ID) {
    exactKeys(value, LOCAL_SOURCE_RPC_EVM_KEYS, label);
    const expectedAddresses = [ETHEREUM_FORWARDER, ETHEREUM_SWIFT];
    if (sourceSwap.kind === "evm-router") expectedAddresses.push(ETHEREUM_EURC_ROUTER);
    if (value.kind !== "evm" || value.rpcChainId !== "0x1" || !Array.isArray(value.code) || value.code.length !== expectedAddresses.length) fail(`${label} EVM evidence is invalid`);
    for (const [index, entry] of value.code.entries()) {
      exactKeys(entry, LOCAL_EVM_CODE_KEYS, `${label}.code[${index}]`);
      if (typeof entry.address !== "string" || !EVM_ADDRESS.test(entry.address) || entry.address !== entry.address.toLowerCase() || entry.address !== expectedAddresses[index] || !LOCAL_KECCAK.test(entry.keccak256)) fail(`${label}.code[${index}] is invalid`);
    }
    return;
  }
  exactKeys(value, LOCAL_SOURCE_RPC_SOLANA_KEYS, label);
  if (value.kind !== "solana" || value.genesisHash !== SOLANA_GENESIS) fail(`${label} Solana identity is invalid`);
  for (const field of ["blockhashContextSlot", "accountContextSlot", "lastValidBlockHeight"]) canonicalUint64(value[field], `${label}.${field}`);
  if (BigInt(value.accountContextSlot) < BigInt(value.blockhashContextSlot)) fail(`${label} account context predates blockhash context`);
  address(value.recentBlockhash, SOLANA_CHAIN_ID, `${label}.recentBlockhash`);
  const expectedLookupTables = sourceSwap.kind === "solana-jupiter-v6"
    ? [SOLANA_MAYAN_ALT, ...sourceSwap.addressLookupTableAddresses]
    : [SOLANA_MAYAN_ALT];
  if (!Array.isArray(value.lookupTables) || value.lookupTables.length !== expectedLookupTables.length) fail(`${label}.lookupTables is invalid`);
  for (const [index, entry] of value.lookupTables.entries()) {
    exactKeys(entry, LOCAL_LOOKUP_TABLE_EVIDENCE_KEYS, `${label}.lookupTables[${index}]`);
    if (entry.address !== expectedLookupTables[index]) fail(`${label}.lookupTables[${index}].address is not the requested ALT`);
    address(entry.address, SOLANA_CHAIN_ID, `${label}.lookupTables[${index}].address`);
    validateLocalHash(entry.dataSha256, `${label}.lookupTables[${index}].dataSha256`);
  }
  if (new Set(value.lookupTables.map((entry) => entry.address)).size !== value.lookupTables.length) fail(`${label}.lookupTables contains duplicates`);
}

function validateLocalPlan(value, label) {
  exactKeys(value, LOCAL_PLAN_KEYS, label);
  if (value.planKind !== "mayan-swift-v2-local-source-swap" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  const capability = getBridgeCapabilityForRoute(value.sourceChainId, value.destinationChainId, value.sourceTokenDeploymentId, value.destinationTokenDeploymentId);
  if (!capability || value.capabilityId !== capability.bridgeCapabilityId || value.quoteId !== value.quoteId.toLowerCase() || !QUOTE_ID.test(value.quoteId)) fail(`${label} route or quote identity is invalid`);
  if (value.rawQuoteSha256 !== value.rawQuoteSha256.toLowerCase()) fail(`${label}.rawQuoteSha256 is not lowercase`);
  validateLocalHash(value.rawQuoteSha256, `${label}.rawQuoteSha256`);
  validateLocalNonce(value.orderNonce, `${label}.orderNonce`);
  address(value.swapperAddress, value.sourceChainId, `${label}.swapperAddress`);
  address(value.destinationAddress, value.destinationChainId, `${label}.destinationAddress`);
  if (typeof value.orderHash !== "string" || !/^0x[0-9a-f]{64}$/u.test(value.orderHash) || typeof value.quoteBindingHash !== "string" || !LOCAL_SHA256.test(value.quoteBindingHash) || typeof value.planHash !== "string" || !LOCAL_SHA256.test(value.planHash)) fail(`${label} hash fields are invalid`);
  canonicalUint64(value.minimumIntermediateAmount, `${label}.minimumIntermediateAmount`, { positive: true });
  validateLocalSourceSwap(value.sourceSwap, capability, `${label}.sourceSwap`);
  const binding = {
    capabilityId: value.capabilityId,
    destinationAddress: value.destinationAddress,
    destinationChainId: value.destinationChainId,
    destinationTokenDeploymentId: value.destinationTokenDeploymentId,
    orderNonce: value.orderNonce,
    quoteId: value.quoteId,
    rawQuoteSha256: value.rawQuoteSha256,
    sourceChainId: value.sourceChainId,
    sourceTokenDeploymentId: value.sourceTokenDeploymentId,
    swapperAddress: value.swapperAddress,
  };
  if (value.quoteBindingHash !== localDigest(binding)) fail(`${label}.quoteBindingHash does not match its context`);
  const sourceSwapProjection = value.sourceSwap.kind === "none"
    ? value.sourceSwap
    : Object.fromEntries(Object.entries(value.sourceSwap).filter(([key]) => key !== "rawProviderSourceSwapJson"));
  if (value.planHash !== localDigest({ quoteBindingHash: value.quoteBindingHash, sourceSwap: sourceSwapProjection })) fail(`${label}.planHash does not match its source swap`);
  return capability;
}

function validateLocalQuoteRecord(value, index, ids) {
  const label = `quotes[${index}]`;
  exactKeys(value, LOCAL_QUOTE_RECORD_KEYS, label);
  if (!ids.has(value.capabilityId) || typeof value.quoteId !== "string" || !QUOTE_ID.test(value.quoteId)) fail(`${label} identity is invalid`);
  if (typeof value.rawQuoteJson !== "string" || value.rawQuoteJson.length === 0 || value.rawQuoteSha256 !== localSha256(value.rawQuoteJson)) fail(`${label}.rawQuoteJson digest is invalid`);
  try {
    if (!isRecord(JSON.parse(value.rawQuoteJson))) fail(`${label}.rawQuoteJson must be an object`);
  } catch {
    fail(`${label}.rawQuoteJson is invalid`);
  }
  validateQuote(value.normalizedQuote, `${label}.normalizedQuote`);
  if (value.normalizedQuote.quoteId !== value.quoteId || value.normalizedQuote.rawSignedQuoteJson !== value.rawQuoteJson || value.normalizedQuote.providerId !== "mayan-swift-v2") fail(`${label} normalized quote does not retain the raw quote`);
}

function validateLocalMock(value, index, label) {
  exactKeys(value, ["mockId", "request", "response"], `${label}[${index}]`);
  if (typeof value.mockId !== "string" || value.mockId.length === 0) fail(`${label}[${index}].mockId is invalid`);
  exactKeys(value.request, ["method", "url", "headers", "body"], `${label}[${index}].request`);
  if (typeof value.request.method !== "string" || value.request.method !== value.request.method.toUpperCase()) fail(`${label}[${index}].request.method is invalid`);
  validateUrl(value.request.url, `${label}[${index}].request.url`, { allowQuery: true });
  validateTrace([value.request], `${label}[${index}].requestTrace`, { allowQuery: true });
  const requestUrl = new URL(value.request.url);
  if (label.startsWith("sourceSwapMocks")) {
    if (value.request.method !== "GET" || requestUrl.origin !== "https://price-api.mayan.finance" || !["/v3/get-swap/evm", "/v3/get-swap/solana"].includes(requestUrl.pathname) || requestUrl.searchParams.has("apiKey") || value.request.body !== null) fail(`${label}[${index}] source-swap request is invalid`);
  } else if (label.startsWith("rpcMocks")) {
    if (value.request.method !== "POST" || requestUrl.pathname !== "/" || value.request.body === null) fail(`${label}[${index}] RPC request is invalid`);
    try {
      const parsed = JSON.parse(value.request.body);
      if (!isRecord(parsed) || Object.keys(parsed).join(",") !== "jsonrpc,id,method,params" || parsed.jsonrpc !== "2.0" || parsed.id !== 1 || typeof parsed.method !== "string" || !Array.isArray(parsed.params)) fail(`${label}[${index}] RPC request envelope is invalid`);
      if (!value.request.body.startsWith('{"jsonrpc":"2.0","id":1,"method":"')) fail(`${label}[${index}] RPC request prefix is invalid`);
      if (!["eth_chainId", "eth_getCode", "getGenesisHash", "getLatestBlockhash", "getMultipleAccounts"].includes(parsed.method)) fail(`${label}[${index}] RPC method is not allowlisted`);
    } catch {
      fail(`${label}[${index}] RPC request body is invalid`);
    }
  }
  exactKeys(value.response, ["status", "headers", "body"], `${label}[${index}].response`);
  if (!Number.isInteger(value.response.status) || value.response.status < 100 || value.response.status > 599 || !isRecord(value.response.headers) || typeof value.response.body !== "string") fail(`${label}[${index}].response is invalid`);
  if (label.startsWith("rpcMocks")) {
    try {
      const response = JSON.parse(value.response.body);
      if (!isRecord(response) || response.jsonrpc !== "2.0" || response.id !== 1 || (!Object.hasOwn(response, "result") && !Object.hasOwn(response, "error"))) fail(`${label}[${index}] RPC response envelope is invalid`);
    } catch {
      fail(`${label}[${index}] RPC response body is invalid`);
    }
  }
}

function validateLocalValidation(value, label) {
  exactKeys(value, LOCAL_VALIDATION_KEYS, label);
  if (value.level !== "local-structural" || value.quoteSignatureLocallyVerified !== false || value.planBindingLocallyVerified !== true || value.transactionBytesLocallyConstructed !== true || value.settlementLocallyVerified !== false) fail(`${label} validation labels are invalid`);
}

function validateLocalBuild(value, label) {
  exactKeys(value, LOCAL_BUILD_KEYS, label);
  if (value.buildKind !== "mayan-swift-v2-local-unsigned" || value.providerId !== "mayan-swift-v2") fail(`${label} identity is invalid`);
  const capability = validateLocalPlan(value.sourceSwapPlan, `${label}.sourceSwapPlan`);
  validateQuote(value.quote, `${label}.quote`);
  if (value.capabilityId !== capability.bridgeCapabilityId || value.sourceChainId !== capability.sourceChainId || value.destinationChainId !== capability.destinationChainId || value.quote.quoteId !== value.sourceSwapPlan.quoteId || localSha256(value.quote.rawSignedQuoteJson) !== value.sourceSwapPlan.rawQuoteSha256) fail(`${label} route differs from plan`);
  if (value.sourceChainId === ETHEREUM_CHAIN_ID) {
    exactKeys(value.transaction, EVM_TRANSACTION_KEYS, `${label}.transaction`);
    if (value.transaction.kind !== "evm-unsigned-transaction" || value.transaction.chainId !== ETHEREUM_CHAIN_ID || !EVM_ADDRESS.test(value.transaction.from) || !EVM_ADDRESS.test(value.transaction.to) || !HEX_BYTES.test(value.transaction.data) || value.transaction.value !== "0" || value.transaction.from !== value.sourceSwapPlan.swapperAddress || value.transaction.to !== ETHEREUM_FORWARDER || !value.transaction.data.toLowerCase().startsWith(capability.forwarderFunctionSelector)) fail(`${label}.transaction is invalid`);
    exactKeys(value.allowance, ALLOWANCE_KEYS, `${label}.allowance`);
    if (value.allowance.tokenDeploymentId !== capability.sourceTokenDeploymentId || value.allowance.tokenAddress !== capability.sourceTokenAddress || value.allowance.owner !== value.sourceSwapPlan.swapperAddress || value.allowance.spender !== ETHEREUM_FORWARDER || typeof value.allowance.requiredAmount !== "string") fail(`${label}.allowance is invalid`);
  } else {
    exactKeys(value.transaction, SOLANA_TRANSACTION_KEYS, `${label}.transaction`);
    if (value.transaction.kind !== "solana-v0-unsigned-transaction" || value.transaction.chainId !== SOLANA_CHAIN_ID || !SOLANA_ADDRESS.test(value.transaction.feePayer) || typeof value.transaction.transactionBase64 !== "string" || value.transaction.transactionBase64.length === 0 || value.transaction.feePayer !== value.sourceSwapPlan.swapperAddress) fail(`${label}.transaction is invalid`);
    if (value.allowance !== null) fail(`${label}.allowance must be null for Solana source`);
  }
  exactKeys(value.construction, LOCAL_CONSTRUCTION_KEYS, `${label}.construction`);
  if (value.construction.mode !== "local" || value.construction.referenceCommit !== "c4c98031aaad9264d17630d7b4de0cb18688cf78" || value.construction.orderNonce !== value.sourceSwapPlan.orderNonce || value.construction.orderHash !== value.sourceSwapPlan.orderHash || value.construction.minimumIntermediateAmount !== value.sourceSwapPlan.minimumIntermediateAmount || !Array.isArray(value.construction.effectiveDependencies) || value.construction.effectiveDependencies.length === 0) fail(`${label}.construction is invalid`);
  validateLocalSourceRpcEvidence(value.construction.sourceRpcEvidence, value.sourceChainId, `${label}.construction.sourceRpcEvidence`, value.sourceSwapPlan.sourceSwap);
  validateLocalValidation(value.validation, `${label}.validation`);
}

function validateLocalOutcome(outcome, method, label) {
  if (!isRecord(outcome) || typeof outcome.kind !== "string") fail(`${label} outcome is invalid`);
  if (outcome.kind === "sdk-error") {
    exactKeys(outcome, ["kind", "code", "message"], label, { optional: ["status"] });
    if (!ERROR_CODES.includes(outcome.code) || outcome.message !== BRIDGE_ERROR_MESSAGES[outcome.code]) fail(`${label} error wording is invalid`);
    if (Object.hasOwn(outcome, "status") && (!Number.isInteger(outcome.status) || outcome.status < 100 || outcome.status > 599)) fail(`${label}.status is invalid`);
    return;
  }
  if (outcome.kind !== "success") fail(`${label}.kind is unsupported`);
  exactKeys(outcome, ["kind", "value"], label);
  if (method === "prepareSourceSwap") validateLocalPlan(outcome.value, `${label}.value`);
  else if (method === "buildLocalUnsigned") validateLocalBuild(outcome.value, `${label}.value`);
  else fail(`${label} method is not local`);
}

function validateLocalMutation(value, label) {
  if (!isRecord(value) || typeof value.kind !== "string") fail(`${label} must be a closed descriptor`);
  if (value.kind === "transport") {
    exactKeys(value, ["kind", "event"], label);
    if (!LOCAL_TRANSPORT_MUTATION_EVENTS.includes(value.event)) fail(`${label}.event is invalid`);
    return;
  }
  if (value.kind === "boundary") {
    exactKeys(value, ["kind", "path", "value"], label);
    if (value.path !== "solana.finalTransactionBytes" || typeof value.value !== "string" || !UINT64.test(value.value)) fail(`${label} boundary is invalid`);
    return;
  }
  if (value.kind === "rpc-envelope-set") {
    exactKeys(value, ["kind", "path", "value"], label);
    if (!LOCAL_RPC_ENVELOPE_MUTATION_PATHS.includes(value.path)) fail(`${label} RPC envelope mutation is invalid`);
    if (value.value !== null && typeof value.value !== "string" && typeof value.value !== "boolean" && typeof value.value !== "number") fail(`${label}.value must be a scalar`);
    if (typeof value.value === "number" && !Number.isFinite(value.value)) fail(`${label}.value must be finite`);
    return;
  }
  exactKeys(value, ["kind", "path", "value"], label);
  const allowed = value.kind === "context-set"
    ? LOCAL_CONTEXT_MUTATION_PATHS
    : value.kind === "quote-normalized-set"
      ? LOCAL_QUOTE_NORMALIZED_MUTATION_PATHS
      : value.kind === "quote-raw-set"
        ? LOCAL_QUOTE_RAW_MUTATION_PATHS
        : value.kind === "source-swap-response-set"
          ? LOCAL_SOURCE_SWAP_MUTATION_PATHS
          : value.kind === "rpc-response-set"
            ? LOCAL_RPC_MUTATION_PATHS
            : value.kind === "plan-set"
              ? LOCAL_PLAN_MUTATION_PATHS
              : value.kind === "config-set"
                ? ["localBuild.ethereumRpc", "localBuild.solanaRpc", "localBuild.sourceSwapEndpoint"]
                : null;
  if (allowed === null || !allowed.includes(value.path)) fail(`${label} kind or path is invalid`);
  if (value.value !== null && typeof value.value !== "string" && typeof value.value !== "boolean" && typeof value.value !== "number") fail(`${label}.value must be a scalar`);
  if (typeof value.value === "number" && !Number.isFinite(value.value)) fail(`${label}.value must be finite`);
}

function validateLocalFixtureCase(entry, index, ids, quoteMap, sourceSwapMap, rpcMap) {
  const label = `localCases[${index}]`;
  exactKeys(entry, LOCAL_CASE_KEYS, label);
  if (typeof entry.caseId !== "string" || entry.caseId.length === 0 || entry.source !== "synthetic" || !["prepareSourceSwap", "buildLocalUnsigned"].includes(entry.method) || !ids.has(entry.capabilityId) || typeof entry.quoteId !== "string" || !quoteMap.has(entry.quoteId)) fail(`${label} identity is invalid`);
  exactKeys(entry.context, ["quoteRef", "swapperAddress", "destinationAddress", "orderNonce"], `${label}.context`);
  if (entry.context.quoteRef !== entry.quoteId) fail(`${label}.context.quoteRef is invalid`);
  validateLocalNonce(entry.context.orderNonce, `${label}.context.orderNonce`);
  const capability = canonicalRegistry.capabilities.find((row) => row.bridgeCapabilityId === entry.capabilityId);
  address(entry.context.swapperAddress, capability.sourceChainId, `${label}.context.swapperAddress`);
  address(entry.context.destinationAddress, capability.destinationChainId, `${label}.context.destinationAddress`);
  if (!Array.isArray(entry.sourceSwapMockIds) || !Array.isArray(entry.rpcMockIds)) fail(`${label} mock IDs must be arrays`);
  for (const id of entry.sourceSwapMockIds) if (!sourceSwapMap.has(id)) fail(`${label} references an unknown source-swap mock`);
  for (const id of entry.rpcMockIds) if (!rpcMap.has(id)) fail(`${label} references an unknown RPC mock`);
  if (entry.method === "prepareSourceSwap" && entry.sourceSwapPlanRef !== null) fail(`${label}.sourceSwapPlanRef must be null for prepare`);
  if (entry.method === "buildLocalUnsigned" && (typeof entry.sourceSwapPlanRef !== "string" || entry.sourceSwapPlanRef.length === 0)) fail(`${label}.sourceSwapPlanRef is required for build`);
  validateLocalOutcome(entry.expected, entry.method, `${label}.expected`);
  validateTrace(entry.httpTrace, `${label}.httpTrace`, { allowQuery: true });
  validateTrace(entry.rpcTrace, `${label}.rpcTrace`, { allowQuery: true });
  if (entry.config?.builderApiKey !== undefined) {
    if (entry.method !== "prepareSourceSwap" || entry.expected.kind !== "success" || entry.mutation !== null || entry.sourceSwapMockIds.length !== 1 || entry.httpTrace.length !== 1 || entry.rpcTrace.length !== 0) fail(`${label} credential boundary control must be a positive anonymous source-swap prepare`);
    if (entry.config.builderApiKey !== "synthetic-builder-api-key" || entry.config.builderEndpoint !== "https://unused-builder.invalid") fail(`${label} credential boundary sentinels are invalid`);
    const rpcHeaders = entry.config.localBuild?.ethereumRpc?.headers;
    if (!isRecord(rpcHeaders) || rpcHeaders.authorization !== "synthetic-source-rpc-credential") fail(`${label} source RPC credential sentinel is invalid`);
    if (entry.httpTrace[0].headers.authorization !== undefined || entry.httpTrace[0].headers["x-api-key"] !== undefined || entry.httpTrace[0].body !== null) fail(`${label} source-swap trace contains a credential or body`);
  }
  if (entry.mutation === null && entry.expected.kind !== "success") fail(`${label}.mutation is required for a rejection case`);
  if (entry.mutation !== null) validateLocalMutation(entry.mutation, `${label}.mutation`);
  if (entry.mutation?.kind === "rpc-envelope-set" && (entry.method !== "buildLocalUnsigned" || entry.rpcMockIds.length !== 1 || entry.rpcTrace.length !== 1 || entry.expected.kind !== "sdk-error" || entry.expected.code !== "BRIDGE_SOURCE_RPC_INVALID_RESPONSE")) fail(`${label}.rpc-envelope-set must reject on the first selected response`);
  if (entry.method === "prepareSourceSwap" && ["quote-normalized-set", "quote-raw-set"].includes(entry.mutation?.kind) && (entry.sourceSwapMockIds.length !== 0 || entry.httpTrace.length !== 0 || entry.rpcTrace.length !== 0)) fail(`${label} quote binding mutation must reject before I/O`);
  if (entry.mutation?.kind === "rpc-response-set" && entry.mutation.path.startsWith("getLatestBlockhash.") && (entry.rpcMockIds.length !== 2 || entry.rpcTrace.length !== 2)) fail(`${label} blockhash response mutation must stop before account fetch`);
  if (entry.mutation !== null && entry.expected.kind === "success") fail(`${label}.mutation is only for rejection cases`);
  if (entry.config !== null && !isRecord(entry.config)) fail(`${label}.config must be an object or null`);
  if (entry.config?.localBuild !== undefined && (!isRecord(entry.config.localBuild) || Object.keys(entry.config.localBuild).some((key) => !["sourceSwapEndpoint", "ethereumRpc", "solanaRpc"].includes(key)))) fail(`${label}.config.localBuild keys are invalid`);
}

export function localFixtureProjection(value = localFixture) {
  return { quotes: value.quotes, sourceSwapMocks: value.sourceSwapMocks, rpcMocks: value.rpcMocks, cases: value.cases };
}

export function computeLocalFixtureDigest(value = localFixture) {
  return localDigest(localFixtureProjection(value));
}

export function validateLocalFixtures(value = localFixture, { registry = canonicalRegistry } = {}) {
  exactKeys(value, LOCAL_FIXTURE_KEYS, "local fixture");
  if (value.schemaVersion !== 1 || value.fixtureKind !== "mayan-swift-v2-local-build-fixtures") fail("local fixture schema or kind is invalid");
  if (value.capabilityAsOfDate !== registry.asOfDate || value.capabilityDigest !== computeDigest(registry.capabilities) || value.hostedFixtureSha256 !== HOSTED_FIXTURE_DIGEST || value.hostedFixtureSemanticSha256 !== HOSTED_FIXTURE_SEMANTIC_DIGEST || value.referenceCommit !== "c4c98031aaad9264d17630d7b4de0cb18688cf78" || value.officialSdkVersion !== "15.2.2") fail("local fixture metadata differs from canonical source");
  if (!isRecord(value.oracle) || value.oracle.mode !== "oracle-only" || !isRecord(value.oracle.memoHexByQuoteId) || !isRecord(value.oracle.random32ByQuoteId)) fail("local fixture oracle metadata is invalid");
  if (!Array.isArray(value.quotes) || value.quotes.length !== 5 || !Array.isArray(value.sourceSwapMocks) || !Array.isArray(value.rpcMocks) || !Array.isArray(value.cases) || value.cases.length < 8) fail("local fixture collections are invalid");
  const ids = new Set(BRIDGE_CAPABILITY_IDS);
  const quoteMap = new Map();
  for (const [index, quote] of value.quotes.entries()) { validateLocalQuoteRecord(quote, index, ids); if (quoteMap.has(quote.quoteId)) fail(`duplicate local quote ${quote.quoteId}`); quoteMap.set(quote.quoteId, quote); }
  const sourceSwapMap = new Map();
  for (const [index, mock] of value.sourceSwapMocks.entries()) { validateLocalMock(mock, index, "sourceSwapMocks"); if (sourceSwapMap.has(mock.mockId)) fail(`duplicate source-swap mock ${mock.mockId}`); sourceSwapMap.set(mock.mockId, mock); }
  const rpcMap = new Map();
  for (const [index, mock] of value.rpcMocks.entries()) { validateLocalMock(mock, index, "rpcMocks"); if (rpcMap.has(mock.mockId)) fail(`duplicate RPC mock ${mock.mockId}`); rpcMap.set(mock.mockId, mock); }
  const caseIds = new Set();
  for (const [index, entry] of value.cases.entries()) { if (caseIds.has(entry?.caseId)) fail(`duplicate local fixture case ${entry?.caseId}`); caseIds.add(entry?.caseId); validateLocalFixtureCase(entry, index, ids, quoteMap, sourceSwapMap, rpcMap); }
  for (const entry of value.cases) {
    if (entry.method === "prepareSourceSwap" && entry.sourceSwapPlanRef !== null) fail(`${entry.caseId}.sourceSwapPlanRef is invalid for prepare`);
    if (entry.method === "buildLocalUnsigned") {
      if (!caseIds.has(entry.sourceSwapPlanRef)) fail(`${entry.caseId}.sourceSwapPlanRef is unknown`);
      if (entry.httpTrace.length !== 0) fail(`${entry.caseId}.httpTrace must be empty for local build`);
    }
    if (entry.method === "prepareSourceSwap" && entry.expected.kind === "success" && entry.context.quoteRef.startsWith("0x")) {
      const quote = quoteMap.get(entry.context.quoteRef);
      const direct = entry.capabilityId.includes("-usdc-");
      if (direct && (entry.sourceSwapMockIds.length !== 0 || entry.httpTrace.length !== 0)) fail(`${entry.caseId} direct USDC must have zero source-swap I/O`);
      if (!direct && entry.expected.kind === "success" && (entry.sourceSwapMockIds.length !== 1 || entry.httpTrace.length !== 1)) fail(`${entry.caseId} EURC prepare must record one source-swap request`);
      if (!quote) fail(`${entry.caseId} quote reference is unknown`);
    }
  }
  for (const method of LOCAL_BEHAVIOR_KEYS) if (!value.cases.some((entry) => entry.method === method)) fail(`local fixture is missing ${method} cases`);
  if (value.localFixtureDigest !== computeLocalFixtureDigest(value)) fail("local fixture digest differs from canonical source");
  return true;
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
  exactKeys(entry, FIXTURE_CASE_KEYS, label, { optional: ["quoteMutation"] });
  if (typeof entry.caseId !== "string" || entry.caseId.length === 0 || entry.source !== "synthetic") fail(`${label} identity is invalid`);
  if (Object.hasOwn(entry, "quoteMutation")) {
    if (FROZEN_LEGACY_FIXTURE_CASE_IDS.includes(entry.caseId)) fail(`${label}.quoteMutation is not allowed on a frozen legacy case`);
    validateQuoteMutation(entry.quoteMutation, `${label}.quoteMutation`);
    if (entry.method !== "build" || entry.quoteCaseId === null) fail(`${label}.quoteMutation is only valid for a build case with a quoteCaseId`);
  }
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

export function localFixtureBehavior(value = localFixture, registry = canonicalRegistry) {
  validateLocalFixtures(value, { registry });
  const grouped = { prepareSourceSwap: [], buildLocalUnsigned: [] };
  for (const entry of sortedCases(value.cases)) grouped[entry.method].push({ caseId: entry.caseId, outcome: clone(entry.expected), httpTrace: clone(entry.httpTrace), rpcTrace: clone(entry.rpcTrace) });
  return grouped;
}

export function buildExpectedLegacySnapshot(registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture) {
  validateBridgeCapabilities(registry, { tokenCatalog });
  validateFixtures(sourceFixture, { registry });
  return {
    snapshotVersion: LEGACY_SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    capabilityAsOfDate: registry.asOfDate,
    capabilityDigest: computeDigest(registry.capabilities),
    behavior: fixtureBehavior(sourceFixture, registry),
  };
}

export function buildExpectedSnapshot(registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture, sourceLocalFixture = localFixture) {
  validateBridgeCapabilities(registry, { tokenCatalog });
  validateFixtures(sourceFixture, { registry });
  validateLocalFixtures(sourceLocalFixture, { registry });
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    language: "canonical",
    runtime: "canonical-reference",
    capabilityAsOfDate: registry.asOfDate,
    capabilityDigest: computeDigest(registry.capabilities),
    hostedFixtureDigest: HOSTED_FIXTURE_DIGEST,
    localFixtureDigest: computeLocalFixtureDigest(sourceLocalFixture),
    behavior: { ...fixtureBehavior(sourceFixture, registry), ...localFixtureBehavior(sourceLocalFixture, registry) },
  };
}

function normalizeTrace(trace, label, { allowQuery = false } = {}) {
  validateTrace(trace, label, { allowQuery });
  return trace.map((entry) => ({
    ...clone(entry),
    headers: Object.fromEntries(Object.entries(entry.headers).filter(([name]) => !["user-agent", "host", "content-length"].includes(name))),
  }));
}

function normalizeLegacySnapshot(snapshot, language, registry = canonicalRegistry) {
  exactKeys(snapshot, ["snapshotVersion", "snapshotKind", "language", "runtime", "capabilityAsOfDate", "capabilityDigest", "behavior"], `${language} snapshot`);
  if (snapshot.snapshotVersion !== LEGACY_SNAPSHOT_VERSION || snapshot.snapshotKind !== SNAPSHOT_KIND || snapshot.language !== language) fail(`${language} snapshot envelope is invalid`);
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

function normalizeSnapshot(snapshot, language, registry = canonicalRegistry, sourceLocalFixture = localFixture) {
  exactKeys(snapshot, ["snapshotVersion", "snapshotKind", "language", "runtime", "capabilityAsOfDate", "capabilityDigest", "hostedFixtureDigest", "localFixtureDigest", "behavior"], `${language} snapshot`);
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION || snapshot.snapshotKind !== SNAPSHOT_KIND || snapshot.language !== language) fail(`${language} snapshot envelope is invalid`);
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.length === 0 || snapshot.runtime === "canonical-reference") fail(`${language} snapshot runtime is invalid`);
  if (snapshot.capabilityAsOfDate !== registry.asOfDate || snapshot.capabilityDigest !== computeDigest(registry.capabilities) || snapshot.hostedFixtureDigest !== HOSTED_FIXTURE_DIGEST || snapshot.localFixtureDigest !== computeLocalFixtureDigest(sourceLocalFixture)) fail(`${language} capability or fixture metadata differs from canonical source`);
  exactKeys(snapshot.behavior, SNAPSHOT_BEHAVIOR_KEYS, `${language}.behavior`);
  const behavior = {};
  for (const method of SNAPSHOT_BEHAVIOR_KEYS) {
    if (!Array.isArray(snapshot.behavior[method])) fail(`${language}.behavior.${method} must be an array`);
    const local = LOCAL_BEHAVIOR_KEYS.includes(method);
    behavior[method] = sortedCases(snapshot.behavior[method]).map((entry, index) => {
      exactKeys(entry, local ? LOCAL_SNAPSHOT_ENTRY_KEYS : ["caseId", "outcome", "httpTrace"], `${language}.behavior.${method}[${index}]`);
      if (typeof entry.caseId !== "string") fail(`${language}.behavior.${method}[${index}].caseId is invalid`);
      if (local) {
        validateLocalOutcome(entry.outcome, method, `${language}.behavior.${method}[${index}].outcome`);
        return { caseId: entry.caseId, outcome: clone(entry.outcome), httpTrace: normalizeTrace(entry.httpTrace, `${language}.behavior.${method}[${index}].httpTrace`, { allowQuery: true }), rpcTrace: normalizeTrace(entry.rpcTrace, `${language}.behavior.${method}[${index}].rpcTrace`, { allowQuery: false }) };
      }
      validateOutcome(entry.outcome, method, `${language}.behavior.${method}[${index}].outcome`);
      return { caseId: entry.caseId, outcome: clone(entry.outcome), httpTrace: normalizeTrace(entry.httpTrace, `${language}.behavior.${method}[${index}].httpTrace`) };
    });
  }
  return { ...clone(snapshot), behavior };
}

function verifyLegacySnapshots(snapshots, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture) {
  validateBridgeCapabilities(registry, { tokenCatalog });
  const expected = fixtureBehavior(sourceFixture, registry);
  const actualLanguages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) fail(`snapshots must contain exactly ${PARITY_LANGUAGES.join(", ")}`);
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizeLegacySnapshot(snapshots[language], language, registry);
    const normalizedBehavior = Object.fromEntries(BEHAVIOR_KEYS.map((method) => [method, normalized.behavior[method].map((entry) => ({ ...entry, httpTrace: normalizeTrace(entry.httpTrace, `${language}.${method}.httpTrace`) }))]));
    if (stableJson(normalizedBehavior) !== stableJson(expected)) fail(`${language} native runtime parity mismatch in behavior`);
    results.push({ language, runtime: normalized.runtime, quoteCases: normalized.behavior.quote.length, buildCases: normalized.behavior.build.length, statusCases: normalized.behavior.status.length });
  }
  return { snapshotVersion: LEGACY_SNAPSHOT_VERSION, snapshotKind: SNAPSHOT_KIND, capabilityAsOfDate: registry.asOfDate, capabilityDigest: computeDigest(registry.capabilities), languages: results, status: "ok" };
}

export function verifySnapshots(snapshots, registry = canonicalRegistry, tokenCatalog = canonicalTokenCatalog, sourceFixture = fixture, sourceLocalFixture = localFixture, { allowLegacyV1 = false } = {}) {
  if (!isRecord(snapshots)) fail("snapshots must be an object keyed by language");
  const versions = Object.values(snapshots).map((snapshot) => snapshot?.snapshotVersion);
  if (versions.length > 0 && versions.every((version) => version === LEGACY_SNAPSHOT_VERSION)) {
    if (allowLegacyV1 !== true) fail("snapshot version 1 requires explicit allowLegacyV1 opt-in");
    return verifyLegacySnapshots(snapshots, registry, tokenCatalog, sourceFixture);
  }
  if (versions.some((version) => version === LEGACY_SNAPSHOT_VERSION)) fail("snapshots must use one snapshot version");
  validateBridgeCapabilities(registry, { tokenCatalog });
  const expected = {
    ...fixtureBehavior(sourceFixture, registry),
    ...localFixtureBehavior(sourceLocalFixture, registry),
  };
  const actualLanguages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (actualLanguages.length !== expectedLanguages.length || actualLanguages.some((language, index) => language !== expectedLanguages[index])) fail(`snapshots must contain exactly ${PARITY_LANGUAGES.join(", ")}`);
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizeSnapshot(snapshots[language], language, registry, sourceLocalFixture);
    const normalizedBehavior = Object.fromEntries(SNAPSHOT_BEHAVIOR_KEYS.map((method) => {
      const local = LOCAL_BEHAVIOR_KEYS.includes(method);
      return [method, normalized.behavior[method].map((entry) => ({
        ...entry,
        httpTrace: normalizeTrace(entry.httpTrace, `${language}.${method}.httpTrace`, { allowQuery: local }),
        ...(local ? { rpcTrace: normalizeTrace(entry.rpcTrace, `${language}.${method}.rpcTrace`) } : {}),
      }))];
    }));
    if (stableJson(normalizedBehavior) !== stableJson(expected)) fail(`${language} native runtime parity mismatch in behavior`);
    results.push({
      language,
      runtime: normalized.runtime,
      quoteCases: normalized.behavior.quote.length,
      buildCases: normalized.behavior.build.length,
      statusCases: normalized.behavior.status.length,
      prepareSourceSwapCases: normalized.behavior.prepareSourceSwap.length,
      buildLocalUnsignedCases: normalized.behavior.buildLocalUnsigned.length,
    });
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_KIND,
    capabilityAsOfDate: registry.asOfDate,
    capabilityDigest: computeDigest(registry.capabilities),
    hostedFixtureDigest: HOSTED_FIXTURE_DIGEST,
    localFixtureDigest: computeLocalFixtureDigest(sourceLocalFixture),
    languages: results,
    status: "ok",
  };
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
  const options = { help: false, json: false, allowLegacyV1: false, snapshots: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") {
      if (options.help) fail("--help may be provided only once");
      options.help = true;
    } else if (argument === "--json") {
      if (options.json) fail("--json may be provided only once");
      options.json = true;
    } else if (argument === "--allow-legacy-v1") {
      if (options.allowLegacyV1) fail("--allow-legacy-v1 may be provided only once");
      options.allowLegacyV1 = true;
    } else if (argument === "--snapshots") {
      if (options.snapshots !== null) fail("--snapshots may be provided only once");
      options.snapshots = argumentsList[++index];
      if (options.snapshots === undefined || options.snapshots.startsWith("--")) fail("--snapshots requires a path or JSON object");
    } else if (argument.startsWith("--")) fail(`unknown option ${argument}`);
    else fail(`unexpected argument ${argument}`);
  }
  if (!options.help && options.snapshots === null) options.snapshots = process.env.ERPC_SDK_BRIDGE_PARITY_OUTPUT ?? null;
  if (!options.help && options.snapshots === null) fail("--snapshots or ERPC_SDK_BRIDGE_PARITY_OUTPUT is required");
  if (options.help && (options.snapshots !== null || options.json || options.allowLegacyV1)) fail("--help cannot be combined with other options");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-bridge-parity.mjs --snapshots <file>",
    "  node registry/verify-bridge-parity.mjs --allow-legacy-v1 --snapshots <file>",
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
  const result = verifySnapshots(await readSnapshots(options.snapshots), undefined, undefined, undefined, undefined, { allowLegacyV1: options.allowLegacyV1 });
  process.stdout.write(`${options.json ? JSON.stringify(result) : `bridge parity: ${result.status} (${result.languages.length} languages)`}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-bridge-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
