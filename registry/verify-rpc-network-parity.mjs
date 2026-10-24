#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import fixture from "./fixtures/rpc-chain-contract-cases.json" with { type: "json" };
import fixtureSchema from "./rpc-chain-contract-cases.schema.json" with { type: "json" };
import {
  CONTRACT,
  LANGUAGES,
  NETWORK_IDS,
  canonicalProjection,
  computeDigest,
  expectedScope,
  stableJson,
  validateContract,
} from "./rpc-network-contract.mjs";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "rpc-network-native-runtime";
export const SNAPSHOT_SYNTHETIC_KIND = "rpc-network-expected-template";
export const PARITY_LANGUAGES = Object.freeze([...LANGUAGES]);
export const FIXTURE_KEYS = Object.freeze(["schemaVersion", "fixtureKind", "contractVersion", "contractDigest", "fixtureDigest", "cases", "suiGrpcWeb", "oracleGoldens", "lifecycleSchedules"]);
export const CASE_KEYS = Object.freeze(["caseId", "cohort", "clientContractId", "networkId", "caseKind", "applicability", "exceptionIds", "setup", "operation", "mockExchange", "expected", "responseDescriptor"]);
export const SNAPSHOT_KEYS = Object.freeze(["snapshotVersion", "snapshotKind", "language", "runtime", "contractVersion", "contractDigest", "fixtureDigest", "scope", "coverage", "behavior", "surface"]);
export const SNAPSHOT_BASE_KEYS = SNAPSHOT_KEYS;
export const COVERAGE_KEYS = Object.freeze(["networkId", "clientContractId", "namespace", "methodSetDigest", "routePolicyIds", "portableCasesExecuted"]);
export const SURFACE_KEYS = Object.freeze(["clientContractId", "allowed", "forbidden"]);
const FIXTURE_SCHEMA_VALIDATION_CACHE = new WeakSet();
const FIXTURE_ORACLE_VALIDATION_CACHE = new WeakSet();
const FINITE_APPLICABILITY_PROBE_CASES = new Set([
  "c1-rust-bitcoin-legacy-raw-batch-remains",
  "c1-rust-bitcoin-decode-domain-exception",
  "c1-typescript-base-unconfigured-placeholder-exception",
  "c1-ruby-bitcoin-synchronous-request-exception",
  "c1-ruby-base-synchronous-request-exception",
  "c1-ruby-arbitrum-synchronous-request-exception",
  "btc-rust-legacy-utf8-replacement",
  "btc-strict-utf8-invalid",
  "c2-ruby-polygon-synchronous-request-exception",
  "c2-ruby-bsc-synchronous-request-exception",
  "c2-ruby-optimism-synchronous-request-exception",
  "c3-ruby-kaia-synchronous-request-exception",
  "c3-ruby-soneium-synchronous-request-exception",
  "c3-ruby-monad-synchronous-request-exception",
  "c4-ruby-hyperliquid-synchronous-request-exception",
  "c4-ruby-arc-synchronous-request-exception",
  "c4-ruby-robinhood-synchronous-request-exception",
  "c5-ruby-near-synchronous-request-exception",
  "c5-ruby-tron-synchronous-request-exception",
  "c5-ruby-sui-synchronous-request-exception",
]);
const SUI_QUERY_HEADER_CASES = new Set([
  "sui-framing-sui-compressed-frame", "sui-framing-sui-data-and-terminal-trailer", "sui-framing-sui-duplicate-trailer", "sui-framing-sui-missing-trailer", "sui-framing-sui-trailer-first", "sui-framing-sui-two-data-frames", "sui-framing-sui-unknown-marker", "sui-request-bytes-inclusive-case", "sui-request-bytes-over-case", "sui-response-bytes-inclusive-case", "sui-response-bytes-over-case", "sui-trailer-bytes-inclusive-case", "sui-trailer-bytes-over-case",
]);

function exceptionAppliesToCase(caseId, scheduleId, exceptionId) {
  if (exceptionId === "rust-bitcoin-raw-batch-v1") return ["c1-bitcoin-new-languages-have-no-raw-request-batch-subscription", "c1-rust-bitcoin-legacy-raw-batch-remains", "c1-hosted-bitcoin-bearer-no-query-null-error", "c1-direct-bitcoin-exact-target-scoped-header-keyless", "c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"].includes(caseId);
  if (exceptionId === "rust-bitcoin-direct-diagnostic-v1") return caseId === "c1-direct-bitcoin-exact-target-scoped-header-keyless";
  if (exceptionId === "rust-bitcoin-decode-domain-v1") return caseId === "c1-rust-bitcoin-decode-domain-exception" || caseId.startsWith("btc-");
  if (exceptionId === "ruby-bitcoin-synchronous-request-v1") return caseId === "c1-ruby-bitcoin-synchronous-request-exception" || (scheduleId === "life-pre-cancel" || scheduleId === "life-first-chunk-cancellation-barrier");
  if (exceptionId === "ruby-base-synchronous-request-v1") return caseId === "c1-ruby-base-synchronous-request-exception";
  if (exceptionId === "ruby-arbitrum-synchronous-request-v1") return caseId === "c1-ruby-arbitrum-synchronous-request-exception";
  const rubyCancellationCases = {
    "ruby-polygon-synchronous-request-v1": "c2-ruby-polygon-synchronous-request-exception",
    "ruby-bsc-synchronous-request-v1": "c2-ruby-bsc-synchronous-request-exception",
    "ruby-optimism-synchronous-request-v1": "c2-ruby-optimism-synchronous-request-exception",
    "ruby-kaia-synchronous-request-v1": "c3-ruby-kaia-synchronous-request-exception",
    "ruby-soneium-synchronous-request-v1": "c3-ruby-soneium-synchronous-request-exception",
    "ruby-monad-synchronous-request-v1": "c3-ruby-monad-synchronous-request-exception",
    "ruby-hyperliquid-synchronous-request-v1": "c4-ruby-hyperliquid-synchronous-request-exception",
    "ruby-arc-synchronous-request-v1": "c4-ruby-arc-synchronous-request-exception",
    "ruby-robinhood-synchronous-request-v1": "c4-ruby-robinhood-synchronous-request-exception",
    "ruby-near-synchronous-request-v1": "c5-ruby-near-synchronous-request-exception",
    "ruby-tron-synchronous-request-v1": "c5-ruby-tron-synchronous-request-exception",
    "ruby-sui-synchronous-request-v1": "c5-ruby-sui-synchronous-request-exception",
  };
  if (Object.hasOwn(rubyCancellationCases, exceptionId)) return caseId === rubyCancellationCases[exceptionId];
  if (exceptionId === "typescript-base-unconfigured-placeholder-v1") return caseId === "c1-typescript-base-unconfigured-placeholder-exception";
  return false;
}
export const LIMITS = Object.freeze({
  decodedEntityBytes: 67108864,
  containerDepth: 64,
  jsonTokens: 1000000,
  numericLexemeBytes: 1024,
  coefficientDigits: 1000,
  explicitExponentMin: -10000,
  explicitExponentMax: 10000,
  canonicalExponentMin: -10000,
  canonicalExponentMax: 10000,
});
export const DESCRIPTOR_LIMITS = Object.freeze({
  maxChunkBytes: 65536,
  maxSegments: 32,
  maxMutations: 8,
  maxLiteralBytes: 4096,
  maxSuiRawBytes: 4096,
  maxDecodedBytes: 67108865,
  maxSuiRequestBytes: 1048577,
  maxSuiResponseBytes: 8388609,
  maxSuiTrailerBytes: 8193,
  maxArrayElements: 999994,
  maxNestedContainers: 65,
  maxNumericLexemeBytes: 1025,
  maxCoefficientDigits: 1001,
});

export class RpcNetworkParityError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcNetworkParityError";
  }
}

function fail(message) {
  throw new RpcNetworkParityError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, optional = []) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} has unknown field ${unknown[0]}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000\r\n]/u.test(value)) fail(`${label} must be a non-empty string`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function canonicalFixtureCases(cases) {
  return [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId)).map((entry) => canonicalize(entry));
}

function canonicalFixtureIdSet(entries, idKey) {
  return [...entries].sort((left, right) => String(left[idKey]).localeCompare(String(right[idKey]))).map((entry) => canonicalize(entry));
}

function canonicalFixtureSui(sui) {
  return canonicalize({
    ...sui,
    golden: canonicalFixtureIdSet(sui.golden, "id"),
    boundaryCases: canonicalFixtureIdSet(sui.boundaryCases, "id"),
    framingCases: canonicalFixtureIdSet(sui.framingCases, "id"),
  });
}

function caseRelationProjection(entry) {
  const responseSource = entry.responseDescriptor.kind === "oracle-ref-v1" ? { kind: entry.responseDescriptor.kind, oracleGoldenId: entry.responseDescriptor.oracleGoldenId } : { kind: entry.responseDescriptor.kind, measurementSha256: entry.responseDescriptor.measurement.sha256 };
  const requestSource = entry.requestDescriptor === undefined ? { bodySha256: entry.mockExchange.request.bodySha256 } : entry.requestDescriptor.kind === "oracle-ref-v1" ? { kind: entry.requestDescriptor.kind, oracleGoldenId: entry.requestDescriptor.oracleGoldenId } : { kind: entry.requestDescriptor.kind, measurementSha256: entry.requestDescriptor.measurement.sha256 };
  return {
    cohort: entry.cohort,
    clientContractId: entry.clientContractId,
    networkId: entry.networkId,
    operation: { publicOperation: entry.operation.publicOperation, wireOperation: entry.operation.wireOperation, params: entry.operation.params },
    request: { method: entry.mockExchange.request.method, target: entry.mockExchange.request.target, headers: entry.mockExchange.request.headers, bodyEncoding: entry.mockExchange.request.bodyEncoding, source: requestSource },
    response: { status: entry.mockExchange.response.status, headers: entry.mockExchange.response.headers, bodyEncoding: entry.mockExchange.response.bodyEncoding, source: responseSource },
    expected: { outcome: entry.expected.outcome, trace: entry.expected.trace, endpointDiagnostic: entry.expected.endpointDiagnostic, ioCount: entry.expected.ioCount, binary: entry.expected.binary },
    scheduleId: entry.scheduleId ?? null,
    exceptionIds: entry.exceptionIds,
    applicability: entry.applicability,
  };
}

const APPROVED_CASE_RELATIONS = Object.freeze({"arbitrum-get-balance-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arbitrum-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://edge.erpc.global/","ioCount":1,"outcome":{"kind":"success","value":"method coverage"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://edge.erpc.global/arbitrum"}},"networkId":"rpc-arbitrum-one-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://edge.erpc.global/arbitrum?api-key=fixture-api-key"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"base-eth-call-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://base.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"method coverage"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json","x-fixture-scoped":"<redacted>"},"ioKind":"performed","method":"POST","target":"https://base.fixture.invalid/custom%2Fpath?secret=<redacted>"}},"networkId":"rpc-base-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json","x-fixture-scoped":"fixture-header"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://base.fixture.invalid/custom%2Fpath?secret=fixture-secret"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"btc-canonical-exponent-inclusive":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-canonical-positive-inclusive"},"status":200},"scheduleId":null},"btc-canonical-exponent-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-canonical-positive-over"},"status":200},"scheduleId":null},"btc-chunked-content-length-adversary":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-decoded-entity-inclusive"},"status":200},"scheduleId":null},"btc-container-depth-inclusive":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-container-depth-inclusive"},"status":200},"scheduleId":null},"btc-container-depth-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-container-depth-over"},"status":200},"scheduleId":null},"btc-decoded-entity-inclusive":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-decoded-entity-inclusive"},"status":200},"scheduleId":null},"btc-decoded-entity-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-decoded-entity-over"},"status":200},"scheduleId":null},"btc-duplicate-escaped-equivalent":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"last-occurrence-wins"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-duplicate-escaped-last-wins"},"status":200},"scheduleId":null},"btc-duplicate-escaped-key-last-wins":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"last-occurrence-wins"},"trace":{"attempts":1,"bodySha256":"bc3387c836312e65845e01e23ae81c2a0a571a41980a88b99d3a7aeeb002e156","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"bc3387c836312e65845e01e23ae81c2a0a571a41980a88b99d3a7aeeb002e156"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"e29696b0f852ba7676a53718bbf6314243c844ad7d5a8aa4cb2ad478f3553581"},"status":200},"scheduleId":null},"btc-error-data-lossless-redaction":{"applicability":["typescript","python","go","ruby","rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"json-rpc","kind":"error","message":"approved golden failure"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json","x-fixture-scoped":"<redacted>"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json","x-fixture-scoped":"fixture-secret"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-error-data-exact"},"status":200},"scheduleId":null},"btc-explicit-exponent-inclusive":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-number"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-exponent-positive-inclusive"},"status":200},"scheduleId":null},"btc-explicit-exponent-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-exponent-positive-over"},"status":200},"scheduleId":null},"btc-explicit-negative-exponent-inclusive":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-number"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-exponent-negative-inclusive"},"status":200},"scheduleId":null},"btc-explicit-negative-exponent-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-exponent-negative-over"},"status":200},"scheduleId":null},"btc-gettxout-null-result":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":null},"trace":{"attempts":1,"bodySha256":"0c4f6428d12743615aa7077ca1daa75e71bdb46a50c09b75d1c69a90a8911ef6","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":["fixture-txid",0],"publicOperation":"getTxOut","wireOperation":"gettxout"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"0c4f6428d12743615aa7077ca1daa75e71bdb46a50c09b75d1c69a90a8911ef6"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-null-gettxout"},"status":200},"scheduleId":null},"btc-json-token-budget-inclusive":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-json-token-budget-inclusive"},"status":200},"scheduleId":null},"btc-json-token-budget-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-json-token-budget-over"},"status":200},"scheduleId":null},"btc-long-coefficient-inclusive":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-number"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-coefficient-inclusive"},"status":200},"scheduleId":null},"btc-long-coefficient-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-coefficient-over"},"status":200},"scheduleId":null},"btc-method-estimatesmartfee":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"estimatesmartfee"}},"trace":{"attempts":1,"bodySha256":"07d2b8b3023649a8145ec92db23e80d8e60f0bf5884bfdb18bf606ad57fb044a","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[6],"publicOperation":"estimateSmartFee","wireOperation":"estimatesmartfee"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"07d2b8b3023649a8145ec92db23e80d8e60f0bf5884bfdb18bf606ad57fb044a"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"64d57aaa7ff56176c3e06763ae5c114abee55671f14a1c1132b02a59dda789db"},"status":200},"scheduleId":null},"btc-method-getblock":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"getblock"}},"trace":{"attempts":1,"bodySha256":"bbb2d140a46e7a7b202f13997bf8ac936398529f18dda99b8d935ce90e07ee32","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":["000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",1],"publicOperation":"getBlock","wireOperation":"getblock"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"bbb2d140a46e7a7b202f13997bf8ac936398529f18dda99b8d935ce90e07ee32"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"dce179994b060144c44c290f1a2721b78ffdf2fa4afdba22b632a51c025cfc0f"},"status":200},"scheduleId":null},"btc-method-getblockhash":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"},"trace":{"attempts":1,"bodySha256":"146412ca5e745ccbb930bbfb81f93bd0f4bd354c29ddc4cb629a8a3c02b8ae69","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[0],"publicOperation":"getBlockHash","wireOperation":"getblockhash"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"146412ca5e745ccbb930bbfb81f93bd0f4bd354c29ddc4cb629a8a3c02b8ae69"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"8466c03ec383304816416e9cd445a2d722a32e939c36aa954f7b1b277a55233a"},"status":200},"scheduleId":null},"btc-method-getblockheader":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"getblockheader"}},"trace":{"attempts":1,"bodySha256":"5d66fea0da62c6241872df754ccc1873d4a48f3efbddca298fc2dd8af3d6afd2","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":["000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",true],"publicOperation":"getBlockHeader","wireOperation":"getblockheader"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"5d66fea0da62c6241872df754ccc1873d4a48f3efbddca298fc2dd8af3d6afd2"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"e8f09ef6db80740d774928d5c68573f1535cdd0fb6077062395581a73f39f71e"},"status":200},"scheduleId":null},"btc-method-getmempoolinfo":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"getmempoolinfo"}},"trace":{"attempts":1,"bodySha256":"db5238c8b20bfd8b003c603d9335e228dfa0a13d63ae4670727884abd156624b","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getMempoolInfo","wireOperation":"getmempoolinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"db5238c8b20bfd8b003c603d9335e228dfa0a13d63ae4670727884abd156624b"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"7dab299e6983a11dc4a77d878cc6d9f39b100f6508a5891203a6577fc9f97b64"},"status":200},"scheduleId":null},"btc-method-getrawmempool":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"getrawmempool"}},"trace":{"attempts":1,"bodySha256":"e3e98ffb72f8939e27fbf4d4af7193eaaf960c7a9c64d9492bb63891dae2187f","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getRawMempool","wireOperation":"getrawmempool"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"e3e98ffb72f8939e27fbf4d4af7193eaaf960c7a9c64d9492bb63891dae2187f"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"2c9036fbd4e9f9c64f94a0785b1fa96f3b7be74eb78473fb1a27952b8a81804b"},"status":200},"scheduleId":null},"btc-method-getrawtransaction":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"getrawtransaction"}},"trace":{"attempts":1,"bodySha256":"93e0be0429dcc78c6223859efbd100d7086c9f4019521369e43db7e7f0da773b","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":["fixture-txid",true],"publicOperation":"getRawTransaction","wireOperation":"getrawtransaction"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"93e0be0429dcc78c6223859efbd100d7086c9f4019521369e43db7e7f0da773b"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"e67737af636b88cb3de23e07d7fbfbab14f189d61145255b7e9207d02df16a2d"},"status":200},"scheduleId":null},"btc-numeric-lexeme-inclusive":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-numeric-lexeme-inclusive"},"status":200},"scheduleId":null},"btc-numeric-lexeme-over":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-numeric-lexeme-over"},"status":200},"scheduleId":null},"btc-overwritten-resource-violation":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-overwritten-over-limit"},"status":200},"scheduleId":null},"btc-prototype-marker-safe":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-boundary"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-prototype-marker"},"status":200},"scheduleId":null},"btc-resource-exponent-boundary-and-overflow":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"numeric resource bound exceeded"},"trace":{"attempts":1,"bodySha256":"0af556b2af4a5299076fa8a4767f6ae7a773154619f2ccac29837611f2aa16ed","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"0af556b2af4a5299076fa8a4767f6ae7a773154619f2ccac29837611f2aa16ed"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"34ce796757ca8fef7017a391cbc51af8f4a99a73451d8e6ee9e691c75c0b322c"},"status":200},"scheduleId":null},"btc-root-duplicate-id-last-wins":{"applicability":["typescript","python","go","ruby","rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"last-occurrence-wins"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-root-id-last-one"},"status":200},"scheduleId":null},"btc-rust-legacy-utf8-replacement":{"applicability":["rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"�"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-invalid-utf8"},"status":200},"scheduleId":null},"btc-strict-utf8-invalid":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"56100b1dc6682cf0cf41e62c39da9b0733fe472a9c6567c920f580ce412edea7"},"target":"https://node.fixture.invalid/bitcoin"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-invalid-utf8"},"status":200},"scheduleId":null},"btc-u64-exponent-token":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-typed-exponent"},"status":200},"scheduleId":null},"btc-u64-fraction-token":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-typed-fraction"},"status":200},"scheduleId":null},"btc-u64-max-plus-one-token":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-u64-max-plus-one"},"status":200},"scheduleId":null},"btc-u64-max-token":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-number"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-u64-max"},"status":200},"scheduleId":null},"btc-u64-maximum-integer-projection":{"applicability":["typescript","python","go","ruby","rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"18446744073709551615"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-u64-max"},"status":200},"scheduleId":null},"btc-u64-negative-zero-token":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-typed-negative-zero"},"status":200},"scheduleId":null},"btc-u64-overflow-and-integer-token-rejection":{"applicability":["typescript","python","go","ruby","rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid response bytes"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/json"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"btc-u64-max-plus-one"},"status":200},"scheduleId":null},"c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"exact-json"},"trace":{"attempts":1,"bodySha256":"b01d8584b7cefe5b22107fe9fe36394932c30ec92523734b762af1d3a8e64771","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getNetworkInfo","wireOperation":"getnetworkinfo"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"b01d8584b7cefe5b22107fe9fe36394932c30ec92523734b762af1d3a8e64771"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"78a7b91df5580dc3e00b00ad4368ed9d790c2ecc41a49e1553f1cd6760c8afb3"},"status":200},"scheduleId":null},"c1-bitcoin-new-languages-have-no-raw-request-batch-subscription":{"applicability":["typescript","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"named-only"},"trace":{"attempts":0,"bodySha256":"4667ccad564b43bcfe1ec88a195d13c17342bc6a5db40e36338c152aa74cc777","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"surface","wireOperation":"surface"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"4667ccad564b43bcfe1ec88a195d13c17342bc6a5db40e36338c152aa74cc777"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"6f0c4a4da15ac50a03e6b4943f0aea83aea8897744266f29acaec8d99a879801"},"status":200},"scheduleId":null},"c1-bitcoin-twelve-named-methods-and-result-shapes":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"fixture":"gettxout"}},"trace":{"attempts":1,"bodySha256":"020f0c4e1f66fb8c40da23a8a140ea4efda07c39a5b3210713fa754e18ac75d5","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":["fixture-txid",0],"publicOperation":"getTxOut","wireOperation":"gettxout"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"020f0c4e1f66fb8c40da23a8a140ea4efda07c39a5b3210713fa754e18ac75d5"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"8d607d8a2873ebdcba6ec573d26ada21db8182c3b93b9604e80e7abaa1326588"},"status":200},"scheduleId":null},"c1-direct-arbitrum-exact-target-scoped-header-origin-only-diagnostic":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arbitrum-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://arb.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0xa4b1"},"trace":{"attempts":1,"bodySha256":"08002d636d7d96aae0f36ce857b3aeb6b08d7390e3d4f53da43cb6b8768ae5d8","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://arb.fixture.invalid/a?secret=<redacted>"}},"networkId":"rpc-arbitrum-one-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"08002d636d7d96aae0f36ce857b3aeb6b08d7390e3d4f53da43cb6b8768ae5d8"},"target":"https://arb.fixture.invalid/a?secret=fixture-secret"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"4c81266732a563e3601a303d5127782affffa1580c027fe9b6e36bafecb6bbbf"},"status":200},"scheduleId":null},"c1-direct-base-exact-target-scoped-header-origin-only-diagnostic":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://base.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"44a58e1c30c6a8eb8765c95cc54e69fdf151be0cd18b753d4234fd9acd356a75","headers":{"content-type":"application/json","x-fixture-scoped":"<redacted>"},"ioKind":"performed","method":"POST","target":"https://base.fixture.invalid/custom%2Fpath?secret=<redacted>"}},"networkId":"rpc-base-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json","x-fixture-scoped":"fixture-header"},"method":"POST","source":{"bodySha256":"44a58e1c30c6a8eb8765c95cc54e69fdf151be0cd18b753d4234fd9acd356a75"},"target":"https://base.fixture.invalid/custom%2Fpath?secret=fixture-secret"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"86e8c64bda9ebd0fa07617b476992b285e71072147b10daf1fb449a4c21c7eb5"},"status":200},"scheduleId":null},"c1-direct-bitcoin-exact-target-scoped-header-keyless":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-direct-diagnostic-v1","rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"},"trace":{"attempts":1,"bodySha256":"809606c0d4bb27b64538f93cdb797512af31a4c0b1ed644d1ac3c8224e3f1750","headers":{"content-type":"application/json","x-fixture-scoped":"<redacted>"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc/path?access=<redacted>"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBestBlockHash","wireOperation":"getbestblockhash"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json","x-fixture-scoped":"fixture-header"},"method":"POST","source":{"bodySha256":"809606c0d4bb27b64538f93cdb797512af31a4c0b1ed644d1ac3c8224e3f1750"},"target":"https://node.fixture.invalid/rpc/path?access=fixture-secret"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"922b6a1748010376654affdd040160b06520e95f16c2e90802bc77f2a50cdfb0"},"status":200},"scheduleId":null},"c1-existing-ethereum-solana-avalanche-and-typescript-base-regression":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-solana-rpc","cohort":0,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://solana-devnet.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"},"trace":{"attempts":1,"bodySha256":"2f92dd254d7d6befdd83f2e83f625c5941029384f719275ebe7e9a3d5b323e0a","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://solana-devnet.fixture.invalid/"}},"networkId":"rpc-solana-devnet","operation":{"params":[],"publicOperation":"getGenesisHash","wireOperation":"getGenesisHash"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"2f92dd254d7d6befdd83f2e83f625c5941029384f719275ebe7e9a3d5b323e0a"},"target":"https://solana-devnet.fixture.invalid/"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"017cd59a79018c45e5fae17fb9050c74639250efcf822c3c87fa5981ce187b56"},"status":200},"scheduleId":null},"c1-hosted-arbitrum-root-and-edge-no-duplicate-suffix":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arbitrum-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://edge.erpc.global/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"e01bfdaac3f31b326ca13e71a14669e8afbec2ac9abf0649aaae5f46e34bc4d4","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://edge.erpc.global/arbitrum"}},"networkId":"rpc-arbitrum-one-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"e01bfdaac3f31b326ca13e71a14669e8afbec2ac9abf0649aaae5f46e34bc4d4"},"target":"https://edge.erpc.global/arbitrum?api-key=fixture-api-key"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"1b49a77ab532b3227289d6798ca8a0dea44f9e67ce88c0c8685c590a8f9fc831"},"status":200},"scheduleId":null},"c1-hosted-base-root-query-auth":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://base.erpc.global/","ioCount":1,"outcome":{"kind":"success","value":"0x2105"},"trace":{"attempts":1,"bodySha256":"d9f16e5fe825d60e7f85943bcbfffe49f79bfe94fda25620a2ae50006fa7309e","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://base.erpc.global/"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"d9f16e5fe825d60e7f85943bcbfffe49f79bfe94fda25620a2ae50006fa7309e"},"target":"https://base.erpc.global/?api-key=fixture-api-key"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"8c806d7c4c24d874b7e3925f27980d20b24f73f218b5c96fabbd2811560eff40"},"status":200},"scheduleId":null},"c1-hosted-bitcoin-bearer-no-query-null-error":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://edge.erpc.global/","ioCount":1,"outcome":{"kind":"success","value":{"chain":"main"}},"trace":{"attempts":1,"bodySha256":"4f8c3def0714906525bb8349b612bb31aba57e81ae2a2ef2a2eae84b8265e167","headers":{"authorization":"<redacted>","content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://edge.erpc.global/bitcoin"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockchainInfo","wireOperation":"getblockchaininfo"},"request":{"bodyEncoding":"json","headers":{"authorization":"Bearer fixture-api-key","content-type":"application/json"},"method":"POST","source":{"bodySha256":"4f8c3def0714906525bb8349b612bb31aba57e81ae2a2ef2a2eae84b8265e167"},"target":"https://edge.erpc.global/bitcoin"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"ef4a07e6b8e436779b800dc2fea64889f1f94f677de20094ca1847160ff8d177"},"status":200},"scheduleId":null},"c1-one-attempt-no-redirect-timeout-and-cancellation":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"http-status","kind":"error","message":"HTTP status 302"},"trace":{"attempts":1,"bodySha256":"3c5e12b1d92aeea6c684d921e62e51c4e5a057f504a603815fe1186f8a6ad885","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"3c5e12b1d92aeea6c684d921e62e51c4e5a057f504a603815fe1186f8a6ad885"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"1f3ecbdbd6983e4faf10343791af5e6fcf6dc6c0d6c0d80610dabf14dc58a6f8"},"status":302},"scheduleId":null},"c1-path-query-header-and-api-key-redaction":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://redact.fixture.invalid/","ioCount":1,"outcome":{"category":"json-rpc","kind":"error","message":"fixture secret was redacted"},"trace":{"attempts":1,"bodySha256":"7abe37b6b0b98c20492532bb44891d2cd17746bde27b23755471ec6acd5f5ff4","headers":{"authorization":"<redacted>","content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://redact.fixture.invalid/<redacted>?key=<redacted>"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"authorization":"Bearer fixture-secret","content-type":"application/json"},"method":"POST","source":{"bodySha256":"7abe37b6b0b98c20492532bb44891d2cd17746bde27b23755471ec6acd5f5ff4"},"target":"https://redact.fixture.invalid/%66oo?key=fixture-secret"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b9068334acf1a54f46dba69d721729c62845285d2f3f4f071f1701bd7b705bec"},"status":200},"scheduleId":null},"c1-response-id-http-jsonrpc-and-malformed-response-errors":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://base.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"response identity or envelope is invalid"},"trace":{"attempts":1,"bodySha256":"9761dcb570e090f246e0b54854840a3008e09a74ce993dc657aceb757b789d94","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://base.fixture.invalid/"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9761dcb570e090f246e0b54854840a3008e09a74ce993dc657aceb757b789d94"},"target":"https://base.fixture.invalid/"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"64726a359630ede07f039a5734fa215e27912b3ca57bb1f06e46444343ab345e"},"status":200},"scheduleId":null},"c1-ruby-arbitrum-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-arbitrum-rpc","cohort":1,"exceptionIds":["ruby-arbitrum-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-arbitrum-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"2851cbc98d01af8700b3ac15657a68b15b1682a414663800c809b088e868e079","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-arbitrum-one-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"2851cbc98d01af8700b3ac15657a68b15b1682a414663800c809b088e868e079"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"1bab394e49a2aa26c8719e386a2cd1eea3ff0ee926918baa5adfcd2cd2e7c706"},"status":200},"scheduleId":null},"c1-ruby-base-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":["ruby-base-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-base-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"d3eda82f46b3a1f83064f6113846efbf37ade44e63f1a3cd4acb51ce130963a6","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"d3eda82f46b3a1f83064f6113846efbf37ade44e63f1a3cd4acb51ce130963a6"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"46cf684af5e35b0f466e9d8facd9c1765c7064fd11fcedf3a07f9f4681a0e5d3"},"status":200},"scheduleId":null},"c1-ruby-bitcoin-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["ruby-bitcoin-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-bitcoin-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"40a833cd84a0226ae11b33b196bcfba2126707d55f3ddd1b6ea673e752e239a8","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"40a833cd84a0226ae11b33b196bcfba2126707d55f3ddd1b6ea673e752e239a8"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"70eba6fba96fcd577a66d0d39f7a2bc59bec092e74c81748686706d01c03eac2"},"status":200},"scheduleId":null},"c1-rust-bitcoin-decode-domain-exception":{"applicability":["rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-decode-domain-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"rust-bitcoin-decode-domain-v1"},"trace":{"attempts":0,"bodySha256":"7fa05375281cc59bc22158fab6680c9a41970467fc063612aa406d229a72a798","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"7fa05375281cc59bc22158fab6680c9a41970467fc063612aa406d229a72a798"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93"},"status":200},"scheduleId":null},"c1-rust-bitcoin-legacy-raw-batch-remains":{"applicability":["rust"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["rust-bitcoin-raw-batch-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"success","value":"rust-legacy-superset"},"trace":{"attempts":0,"bodySha256":"1d7713607fe937ae30022dfb90f33a1b1c674799a9ca327c48416eaa96102818","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"legacy-rpc-namespace","wireOperation":"legacy-rpc-namespace"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"1d7713607fe937ae30022dfb90f33a1b1c674799a9ca327c48416eaa96102818"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"3423a51c6857f663f8c04c8e9fbb6595874060861a3d3c334c9e1733e45e5eb9"},"status":200},"scheduleId":null},"c1-schedule-first-chunk-cancellation-barrier":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["ruby-bitcoin-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"context-cancelled","kind":"error","message":"request cancelled after first chunk"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-first-chunk-cancellation-barrier"},"c1-schedule-first-chunk-then-delay":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"timeout","kind":"error","message":"body timed out"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-first-chunk-then-delay"},"c1-schedule-immediate-response":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"schedule-control"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-immediate-response"},"c1-schedule-pre-cancel":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":["ruby-bitcoin-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":0,"outcome":{"category":"context-cancelled","kind":"error","message":"request cancelled"},"trace":{"attempts":0,"bodySha256":"0000000000000000000000000000000000000000000000000000000000000000","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-pre-cancel"},"c1-schedule-redirect-to-second-server":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"http-redirect","kind":"error","message":"HTTP status 302"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":302},"scheduleId":"life-redirect-to-second-server"},"c1-schedule-reset-after-first-chunk":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"transport","kind":"error","message":"connection reset after first chunk"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-reset-after-first-chunk"},"c1-schedule-reset-before-headers":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"transport","kind":"error","message":"connection reset before headers"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-reset-before-headers"},"c1-schedule-withhold-headers":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"category":"timeout","kind":"error","message":"request timed out"},"trace":{"attempts":1,"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7acb477e8985a671647b37b1fb618e22009ea913ff31d892a0642f4407f5a6fc"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9861a0a64ca30ddc96dd3f4040d5fa20bf65704765c204e42961b327665e2223"},"status":200},"scheduleId":"life-withhold-headers"},"c1-sealed-evm-three-method-payloads-and-no-escape-hatches":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"success","value":"sealed-read3"},"trace":{"attempts":0,"bodySha256":"b30b65d36999a5ac40b516cab2b45264bf5289407e33a749e7383f46a00eba11","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"surface","wireOperation":"surface"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"b30b65d36999a5ac40b516cab2b45264bf5289407e33a749e7383f46a00eba11"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"30bff4ce8bb5cec821f1784ef5971e412049cb8c1358e5ed5b4e922e7f2d7d26"},"status":200},"scheduleId":null},"c1-typescript-base-unconfigured-placeholder-exception":{"applicability":["typescript"],"clientContractId":"client-base-rpc","cohort":1,"exceptionIds":["typescript-base-unconfigured-placeholder-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"https://unconfigured.invalid/base"},"trace":{"attempts":0,"bodySha256":"884f6aec4e43c51190ea3952bef41046aa535f7e878603df6895ba2ba5ca5c08","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-base-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"884f6aec4e43c51190ea3952bef41046aa535f7e878603df6895ba2ba5ca5c08"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93"},"status":200},"scheduleId":null},"c1-unconfigured-namespace-fails-locally-with-zero-io":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bitcoin-rpc","cohort":1,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"category":"not-configured","kind":"error","message":"bitcoin.rpc is not configured"},"trace":{"attempts":0,"bodySha256":"16fc4acceddf521ce456f397608e06d1efba2663fe1cb54f8671bcb52aa8ebbf","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bitcoin-mainnet","operation":{"params":[],"publicOperation":"getBlockCount","wireOperation":"getblockcount"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"16fc4acceddf521ce456f397608e06d1efba2663fe1cb54f8671bcb52aa8ebbf"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"67964aa521cac460c6f03581a9671228fbff46f29ad094718cd3ee4bd60637e1"},"status":200},"scheduleId":null},"c2-bsc-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bsc-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://bsc.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://bsc.fixture.invalid/rpc"}},"networkId":"rpc-bsc-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://bsc.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c2-bsc-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bsc-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://bsc.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://bsc.fixture.invalid/rpc"}},"networkId":"rpc-bsc-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://bsc.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c2-optimism-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-optimism-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://optimism.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://optimism.fixture.invalid/rpc"}},"networkId":"rpc-optimism-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://optimism.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c2-optimism-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-optimism-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://optimism.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://optimism.fixture.invalid/rpc"}},"networkId":"rpc-optimism-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://optimism.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c2-polygon-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-polygon-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://polygon.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://polygon.fixture.invalid/rpc"}},"networkId":"rpc-polygon-pos-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://polygon.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c2-polygon-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-polygon-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://polygon.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://polygon.fixture.invalid/rpc"}},"networkId":"rpc-polygon-pos-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://polygon.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c2-ruby-bsc-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-bsc-rpc","cohort":2,"exceptionIds":["ruby-bsc-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-bsc-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-bsc-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"92ac6aea5c98711db71ec0881f1b637d67194433367a5b7f1fea5db155caf338"},"status":200},"scheduleId":null},"c2-ruby-optimism-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-optimism-rpc","cohort":2,"exceptionIds":["ruby-optimism-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-optimism-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-optimism-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b2c8141905cf38d950348dc7f15724818f646155f2a2986d340da683f9221c52"},"status":200},"scheduleId":null},"c2-ruby-polygon-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-polygon-rpc","cohort":2,"exceptionIds":["ruby-polygon-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-polygon-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-polygon-pos-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"799832902c8cce8cdd6464798392e3b82a62c48d3e83012c0375dee73b309d96"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"129707f96aab4f4daa7d561e7dea04bcf3d67b787cd250f43bcaabcd8fb8a378"},"status":200},"scheduleId":null},"c2-sealed-polygon-bsc-optimism-identity-rows":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-polygon-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://polygon.erpc.global/","ioCount":1,"outcome":{"kind":"success","value":"0x89"},"trace":{"attempts":1,"bodySha256":"601d8b6105af1da80bfe09f5f9690146482908f72db9b0a290ec6f7dfb3deaa9","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://polygon.erpc.global/"}},"networkId":"rpc-polygon-pos-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"601d8b6105af1da80bfe09f5f9690146482908f72db9b0a290ec6f7dfb3deaa9"},"target":"https://polygon.erpc.global/"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"6141c6de48e5bf27ead67d5d1b5a0d9b0e79b160b0aed302ea4f43e95b242f49"},"status":200},"scheduleId":null},"c3-kaia-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-kaia-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://kaia.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://kaia.fixture.invalid/rpc"}},"networkId":"rpc-kaia-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://kaia.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c3-kaia-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-kaia-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://kaia.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://kaia.fixture.invalid/rpc"}},"networkId":"rpc-kaia-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://kaia.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c3-mainnet-only-monad-soneium-kaia":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-monad-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x8f"},"trace":{"attempts":1,"bodySha256":"82069a48fc15e269c19a07072db636ce0bbeb842f31f46366ed98611db1b374e","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-monad-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"82069a48fc15e269c19a07072db636ce0bbeb842f31f46366ed98611db1b374e"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"d18a95a1d037609f51ee7c1a27dbd4e98ee0da04174be2350477b969e6c98bf7"},"status":200},"scheduleId":null},"c3-monad-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-monad-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://monad.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://monad.fixture.invalid/rpc"}},"networkId":"rpc-monad-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://monad.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c3-monad-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-monad-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://monad.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://monad.fixture.invalid/rpc"}},"networkId":"rpc-monad-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://monad.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c3-ruby-kaia-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-kaia-rpc","cohort":3,"exceptionIds":["ruby-kaia-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-kaia-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-kaia-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"0b2e38c368344fc75aa26034698f20229bb9f81919ff0012be1db8094aab6273"},"status":200},"scheduleId":null},"c3-ruby-monad-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-monad-rpc","cohort":3,"exceptionIds":["ruby-monad-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-monad-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-monad-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"4593474e2348b79a7e2f5dc958cf8be6499bc446e53af5e4b394fef13a61312e"},"status":200},"scheduleId":null},"c3-ruby-soneium-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-soneium-rpc","cohort":3,"exceptionIds":["ruby-soneium-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-soneium-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-soneium-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"cb28ec392852b3fd5ee0a79089a54609e47863fd34414cc65cce9ffa1a2ccd39"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"6771a55d2fe6076f50d44f65661dfc26523e448c7490157504e67ed17c5ca2e7"},"status":200},"scheduleId":null},"c3-soneium-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-soneium-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://soneium.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://soneium.fixture.invalid/rpc"}},"networkId":"rpc-soneium-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://soneium.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c3-soneium-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-soneium-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://soneium.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://soneium.fixture.invalid/rpc"}},"networkId":"rpc-soneium-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://soneium.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c4-arc-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arc-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://arc.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://arc.fixture.invalid/rpc"}},"networkId":"rpc-arc-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://arc.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c4-arc-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arc-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://arc.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://arc.fixture.invalid/rpc"}},"networkId":"rpc-arc-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://arc.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c4-hyperevm-arc-robinhood-product-scope":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-hyperliquid-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"success","value":"HyperEVM-only"},"trace":{"attempts":0,"bodySha256":"4200d998ad91ff9fdd8c5f64f7699e7e57768ceb6acdfef2aeb1212ebfdc67db","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-hyperliquid-hyperevm-mainnet","operation":{"params":[],"publicOperation":"surface","wireOperation":"surface"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"4200d998ad91ff9fdd8c5f64f7699e7e57768ceb6acdfef2aeb1212ebfdc67db"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"8b3d77a5d983ec2f917d6048b279874a39b633de0813d5c37a49c42e73904190"},"status":200},"scheduleId":null},"c4-hyperliquid-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-hyperliquid-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://hyperliquid.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://hyperliquid.fixture.invalid/rpc"}},"networkId":"rpc-hyperliquid-hyperevm-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://hyperliquid.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c4-hyperliquid-eth-chain-id-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-hyperliquid-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://hyperliquid.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x3e7"},"trace":{"attempts":1,"bodySha256":"09fabe0af56b7726f1666ddd147482df4d951f86f66124b936716c53ab0e8471","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://hyperliquid.fixture.invalid/rpc"}},"networkId":"rpc-hyperliquid-hyperevm-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"09fabe0af56b7726f1666ddd147482df4d951f86f66124b936716c53ab0e8471"},"target":"https://hyperliquid.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"430f684fbe48ec1e680bfacf8a2bea38f365e868bc8874eebe9e26e360983a9a"},"status":200},"scheduleId":null},"c4-hyperliquid-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-hyperliquid-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://hyperliquid.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://hyperliquid.fixture.invalid/rpc"}},"networkId":"rpc-hyperliquid-hyperevm-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://hyperliquid.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c4-robinhood-eth-call-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-robinhood-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://robinhood.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://robinhood.fixture.invalid/rpc"}},"networkId":"rpc-robinhood-chain-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://robinhood.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"c4-robinhood-eth-get-balance-read":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-robinhood-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://robinhood.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x0"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://robinhood.fixture.invalid/rpc"}},"networkId":"rpc-robinhood-chain-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://robinhood.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null},"c4-ruby-arc-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-arc-rpc","cohort":4,"exceptionIds":["ruby-arc-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-arc-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-arc-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"0a37391a202aef0e07b5229c36194ea697c90a4d4a296f919f056a344a695906"},"status":200},"scheduleId":null},"c4-ruby-hyperliquid-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-hyperliquid-rpc","cohort":4,"exceptionIds":["ruby-hyperliquid-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-hyperliquid-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-hyperliquid-hyperevm-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"da8a3afee58e225b7d7d9a98faebbbf3c65733d01d79d79fe7eb7184276601b6"},"status":200},"scheduleId":null},"c4-ruby-robinhood-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-robinhood-rpc","cohort":4,"exceptionIds":["ruby-robinhood-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-robinhood-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-robinhood-chain-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"28ddb6d7b5ad56b96096f4b4c63377f0c8868670c295a9c8d95c0ddbc23b69dd"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"70fffd3e626122a151367c5d8d251452289a78682baa842a2fd55c63543a6236"},"status":200},"scheduleId":null},"c5-near-tron-sui-native-protocol-contracts":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-near-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"amount":"1000000000000000000","block_hash":"fixture-account-block","block_height":123456789012345,"bootstrap_nonce":0,"code_hash":"fixture-code-hash","global_contract_account_id":"fixture.near","global_contract_hash":"fixture-global-hash","locked":"0","state":"active","storage_paid_at":0,"storage_usage":42,"unknown_account_number":9007199254740992}},"trace":{"attempts":1,"bodySha256":"c1634eb750d9282db4593d4b383dbf769ecf6b906c6cb048482e351f0786f35e","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-near-mainnet","operation":{"params":{"account_id":"alice.near","finality":"final","request_type":"view_account"},"publicOperation":"view_account","wireOperation":"query"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"c1634eb750d9282db4593d4b383dbf769ecf6b906c6cb048482e351f0786f35e"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"2f97a9ca3a12d25fd8c916c04ef6a5e0edf30b86ded7fd78715afa6bbc983cda"},"status":200},"scheduleId":null},"c5-ruby-near-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-near-rpc","cohort":5,"exceptionIds":["ruby-near-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-near-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-near-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"fe7fd223a1619c0a7324ae1e6354175fdc535fbedaca5cf080e5c5488913c801"},"status":200},"scheduleId":null},"c5-ruby-sui-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":["ruby-sui-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-sui-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"c1754a9952fc63adae36044ba8c75e896cfcca820d785c741928154ac7e5ff04"},"status":200},"scheduleId":null},"c5-ruby-tron-synchronous-request-exception":{"applicability":["ruby"],"clientContractId":"client-tron-rpc","cohort":5,"exceptionIds":["ruby-tron-synchronous-request-v1"],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"kind":"not-applicable","value":"ruby-tron-synchronous-request-v1"},"trace":{"attempts":0,"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-tron-mainnet","operation":{"params":[],"publicOperation":"cancellation","wireOperation":"cancellation"},"request":{"bodyEncoding":"json","headers":{},"method":"POST","source":{"bodySha256":"e859c991af8b51fc9c690a01f43137e9af2a1cc16d9cc9072aa103d6b1fd5713"},"target":"https://fixture.invalid/no-io"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"da7b228a3207ca9aea1f9c45405b78d1ff794738d88f44dbc5d6fd5d0e8b3e2d"},"status":200},"scheduleId":null},"c5-sui-binary-limit-descriptor":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"sui-golden"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-response-body"},"status":200},"scheduleId":null},"matrix-rpc-arc-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-arc-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x13b2"},"trace":{"attempts":1,"bodySha256":"d5dcd56146a65fb2bd1629b9e6bc503f4e615111f3e5e29837189e30dd8916db","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-arc-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"d5dcd56146a65fb2bd1629b9e6bc503f4e615111f3e5e29837189e30dd8916db"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"6803954cff350958834e0a3408d7d6e00b694179b75c803e17dab1398dffa375"},"status":200},"scheduleId":null},"matrix-rpc-avalanche-c-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-avalanche-rpc","cohort":0,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0xa86a"},"trace":{"attempts":1,"bodySha256":"e62d9feaf598a6115409c6990fa3b5b855dc40f703c9c5540493301e93217cba","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-avalanche-c-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"e62d9feaf598a6115409c6990fa3b5b855dc40f703c9c5540493301e93217cba"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"cf17e9e4eddc9463f37c887fb3e962646c1f6f97cc48a9219c20bec2b4a8aad4"},"status":200},"scheduleId":null},"matrix-rpc-bsc-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-bsc-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x38"},"trace":{"attempts":1,"bodySha256":"7c49ec96395c63156ba2efc137d602bea9fbfca957a9863b5052f12644295522","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-bsc-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"7c49ec96395c63156ba2efc137d602bea9fbfca957a9863b5052f12644295522"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"38e1674e1f9b8daa153c0b32c8838c4e9b8fd3d5cce5ad4dadf777e0a4fd6903"},"status":200},"scheduleId":null},"matrix-rpc-ethereum-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-ethereum-rpc","cohort":0,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x1"},"trace":{"attempts":1,"bodySha256":"93ce64cc9d75611a573a45429800445595277612f56a4df42b3b8d9a736d82fd","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-ethereum-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"93ce64cc9d75611a573a45429800445595277612f56a4df42b3b8d9a736d82fd"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"95fa46376dd1db8e7f47618166396741623fa8439ffec6d7cfbcca8eb7f04256"},"status":200},"scheduleId":null},"matrix-rpc-kaia-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-kaia-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x2019"},"trace":{"attempts":1,"bodySha256":"c0507fb3efbf6e0e49fd797e321483ea92c9f8ad11c6d44d79c0e2645df7e27e","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-kaia-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"c0507fb3efbf6e0e49fd797e321483ea92c9f8ad11c6d44d79c0e2645df7e27e"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"0a66b353bd8005d060910171a4eac657137059930907eecf710280ba8148345d"},"status":200},"scheduleId":null},"matrix-rpc-optimism-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-optimism-rpc","cohort":2,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0xa"},"trace":{"attempts":1,"bodySha256":"9e708430c80c6b8876e98aeaac92348a434dfd7b1c972af9b09266adb744be92","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-optimism-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9e708430c80c6b8876e98aeaac92348a434dfd7b1c972af9b09266adb744be92"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"edc71dceb91cc80263f0691b5ee4e54bca19a32b26591f9c24e1a82e34902d17"},"status":200},"scheduleId":null},"matrix-rpc-robinhood-chain-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-robinhood-rpc","cohort":4,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x1237"},"trace":{"attempts":1,"bodySha256":"3ef98ee227a4bccedbc16cd3405e5f09f2bfea7b578b53269274821696f97747","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-robinhood-chain-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"3ef98ee227a4bccedbc16cd3405e5f09f2bfea7b578b53269274821696f97747"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"075be3b7d66db9066914fa04aebb69182548087f9305d88be3af0ca697b2016e"},"status":200},"scheduleId":null},"matrix-rpc-solana-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-solana-rpc","cohort":0,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"},"trace":{"attempts":1,"bodySha256":"82062c7870bcf5bfd2eff2db4b9eadfc119aeef2e4c71e77af447efdca8e52eb","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-solana-mainnet","operation":{"params":[],"publicOperation":"getGenesisHash","wireOperation":"getGenesisHash"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"82062c7870bcf5bfd2eff2db4b9eadfc119aeef2e4c71e77af447efdca8e52eb"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"7ebfcb3d563cea0343623925f9e1adaa4af6697afca2d68e2cb49b61ec6ab5d7"},"status":200},"scheduleId":null},"matrix-rpc-solana-testnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-solana-rpc","cohort":0,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"},"trace":{"attempts":1,"bodySha256":"b03819f854dfaa70061e2ce94d314a714a1a66257428755f56c1d5f7d860ff3d","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-solana-testnet","operation":{"params":[],"publicOperation":"getGenesisHash","wireOperation":"getGenesisHash"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"b03819f854dfaa70061e2ce94d314a714a1a66257428755f56c1d5f7d860ff3d"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"0584cc8878c7a50f2c7a63bc38ae3cd69f2fca9ae09d2a54c982090fa326a050"},"status":200},"scheduleId":null},"matrix-rpc-soneium-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-soneium-rpc","cohort":3,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x74c"},"trace":{"attempts":1,"bodySha256":"cd3c32ef849384dcd4ab679bbc4dbc177836225d52540bf2f4354c0093daf881","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-soneium-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"cd3c32ef849384dcd4ab679bbc4dbc177836225d52540bf2f4354c0093daf881"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b200dfb5fb69ece36814e2ed70de9c31dea809aa4636997c8a9c8edae3cc8978"},"status":200},"scheduleId":null},"matrix-rpc-tron-mainnet":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-tron-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"0x2b6653dc"},"trace":{"attempts":1,"bodySha256":"726a9e2534d069994949079a43ed2ab88fdffb7795f44a12bfcfcd446ff5eade","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-tron-mainnet","operation":{"params":[],"publicOperation":"eth_chainId","wireOperation":"eth_chainId"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"726a9e2534d069994949079a43ed2ab88fdffb7795f44a12bfcfcd446ff5eade"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"9d4b7c379add41c595599f04f1177803b001e0a76c0156a677ff06bc08fed764"},"status":200},"scheduleId":null},"near-block-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-near-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"author":"fixture.near","chunks":[],"header":{"gas_price":"100000000","hash":"fixture-block-hash","height":123456789012345,"prev_hash":"fixture-prev-hash","timestamp":1704067200000000000,"timestamp_nanosec":"1704067200000000000","total_supply":"1000000000000000000000000","unknown_header_number":9007199254740992},"unknown_block_number":9007199254740992}},"trace":{"attempts":1,"bodySha256":"d5e235130bdfd97b0bc9ed26c5348331f4f003c8cb81dba37d64ff074a80deda","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-near-mainnet","operation":{"params":{"finality":"final"},"publicOperation":"block","wireOperation":"block"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"d5e235130bdfd97b0bc9ed26c5348331f4f003c8cb81dba37d64ff074a80deda"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"90585f167d47d8b498f03beeefb04c04db5592538636414777f5760341b8a47f"},"status":200},"scheduleId":null},"near-status-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-near-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":{"chain_id":"mainnet","genesis_hash":"fixture-genesis-hash","latest_protocol_version":100,"protocol_version":100,"sync_info":{"latest_block_hash":"fixture-latest-block","latest_block_height":123456789012345,"latest_block_time":"2024-01-01T00:00:00Z","latest_state_root":"fixture-state-root","syncing":false,"unknown_sync_number":9007199254740992},"unknown_status_number":9007199254740992,"version":{"build":"fixture-build","rustc_version":"1.85.0","unknown_version_number":9007199254740992,"version":"1.0.0"}}},"trace":{"attempts":1,"bodySha256":"619c72f0ef8d1ceba5aba8f0bc1f2e4c1db5c2f83f25e0b22e133cab4978f6e4","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-near-mainnet","operation":{"params":[],"publicOperation":"status","wireOperation":"status"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"619c72f0ef8d1ceba5aba8f0bc1f2e4c1db5c2f83f25e0b22e133cab4978f6e4"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"467a5b09f0834a37d5f8760645cadadf30d920f4f09cb551adde48693f086ad0"},"status":200},"scheduleId":null},"sui-framing-sui-compressed-frame":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"10b9d9e42cf1d7867c9fbc2585d3b0c78edc86cf9b337f2b4d416c08529a5b7d"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"10b9d9e42cf1d7867c9fbc2585d3b0c78edc86cf9b337f2b4d416c08529a5b7d"},"status":200},"scheduleId":null},"sui-framing-sui-data-and-terminal-trailer":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"framing-control"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6"},"status":200},"scheduleId":null},"sui-framing-sui-duplicate-trailer":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":149,"encoding":"hex","sha256":"7e4bd6caf4934a06bf9a7acd4bd7dafdd39ac8108182bad33a53e1b035252758"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"7e4bd6caf4934a06bf9a7acd4bd7dafdd39ac8108182bad33a53e1b035252758"},"status":200},"scheduleId":null},"sui-framing-sui-missing-trailer":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":107,"encoding":"hex","sha256":"dcee420a304c2e9fee37603b736bd6c1f07bcab7cbbf02daf18f44817c5b21ed"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"dcee420a304c2e9fee37603b736bd6c1f07bcab7cbbf02daf18f44817c5b21ed"},"status":200},"scheduleId":null},"sui-framing-sui-trailer-first":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"11b153afcc7db0acba96d3ad091c7975c6b2368839bafd9cc3e5483a4434fc79"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"11b153afcc7db0acba96d3ad091c7975c6b2368839bafd9cc3e5483a4434fc79"},"status":200},"scheduleId":null},"sui-framing-sui-two-data-frames":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":235,"encoding":"hex","sha256":"d5e6e20bcc786587a849037e2f6a7d3b0a730f79d0d25434ddee65177075635a"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"d5e6e20bcc786587a849037e2f6a7d3b0a730f79d0d25434ddee65177075635a"},"status":200},"scheduleId":null},"sui-framing-sui-unknown-marker":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"1185c4c71e904a667bf61ca3401bcf89d39524d0544189123c5b744594d68fd1"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"invalid-response"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto"},"source":{"kind":"inline-v1","measurementSha256":"1185c4c71e904a667bf61ca3401bcf89d39524d0544189123c5b744594d68fd1"},"status":200},"scheduleId":null},"sui-golden-balance":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":49,"encoding":"hex","sha256":"ed25f1c722efbf2404c3adbfc10cecf76afd16d2efdc15e825791e82c7248009"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"sui-golden"},"trace":{"attempts":1,"bodySha256":"552b193b54383631a6a870c99c714c69b03d47976d0f7d57788e911e91c215f8","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.StateService/GetBalance?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[{"coinType":"coin","owner":"owner"}],"publicOperation":"getBalance","wireOperation":"/sui.rpc.v2.StateService/GetBalance"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"552b193b54383631a6a870c99c714c69b03d47976d0f7d57788e911e91c215f8"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.StateService/GetBalance?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-balance-response-body"},"status":200},"scheduleId":null},"sui-golden-object-absent":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":43,"encoding":"hex","sha256":"f881c1052c1abe9e959312d83035c96f6db3bec7765cc64719c01a18770ad57b"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"sui-golden"},"trace":{"attempts":1,"bodySha256":"e91718d399eefcb4d877d87fbdf2e57dcb1ec8150b888576ee2cfe138a918461","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[{"objectId":"0x2","version":null}],"publicOperation":"getObject","wireOperation":"/sui.rpc.v2.LedgerService/GetObject"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"e91718d399eefcb4d877d87fbdf2e57dcb1ec8150b888576ee2cfe138a918461"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-object-response-body"},"status":200},"scheduleId":null},"sui-golden-object-zero":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":43,"encoding":"hex","sha256":"f881c1052c1abe9e959312d83035c96f6db3bec7765cc64719c01a18770ad57b"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"sui-golden"},"trace":{"attempts":1,"bodySha256":"f3d72df14a8f88570303b228121b9f7737880c417344053f14a4ed064964303c","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[{"objectId":"0x2","version":0}],"publicOperation":"getObject","wireOperation":"/sui.rpc.v2.LedgerService/GetObject"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"f3d72df14a8f88570303b228121b9f7737880c417344053f14a4ed064964303c"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-object-response-body"},"status":200},"scheduleId":null},"sui-golden-service-info":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":128,"encoding":"hex","sha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6"},"endpointDiagnostic":"https://sui.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"sui-golden"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"hex","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-response-body"},"status":200},"scheduleId":null},"sui-request-bytes-inclusive-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":43,"encoding":"hex","sha256":"f881c1052c1abe9e959312d83035c96f6db3bec7765cc64719c01a18770ad57b"},"endpointDiagnostic":"","ioCount":1,"outcome":{"kind":"success","value":"response boundary"},"trace":{"attempts":1,"bodySha256":"49b09b38ed4ae29035ee9f45dc5fbc18c2dfc479a12a0e4e5bf9f17c6d2d8b33","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[{"objectId":"0x2","version":0}],"publicOperation":"getObject","wireOperation":"/sui.rpc.v2.LedgerService/GetObject"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-request-bytes-inclusive"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-object-response-body"},"status":200},"scheduleId":null},"sui-request-bytes-over-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"","ioCount":0,"outcome":{"category":"config","kind":"error","message":"request exceeds 1 MiB"},"trace":{"attempts":0,"bodySha256":"0000000000000000000000000000000000000000000000000000000000000000","headers":{},"ioKind":"none","method":"NONE","target":"NO_IO"}},"networkId":"rpc-sui-mainnet","operation":{"params":[{"objectId":"0x2","version":0}],"publicOperation":"getObject","wireOperation":"/sui.rpc.v2.LedgerService/GetObject"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-request-bytes-over"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetObject?fixture=1"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"1b9f3e593e73354720f2329c7bc53c56abf4ef1c4ce38ecc7d6aa26c211b9685"},"status":200},"scheduleId":null},"sui-response-bytes-inclusive-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":8388608,"encoding":"hex","sha256":"d687da482ab2dc567deae182cae0aeb4afbe4943b1a8abee94b520bf4442762d"},"endpointDiagnostic":"","ioCount":1,"outcome":{"kind":"success","value":"response boundary"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-request-frame"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-response-bytes-inclusive"},"status":200},"scheduleId":null},"sui-response-bytes-over-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":8388609,"encoding":"hex","sha256":"977ecec1c8d043f475d19b9517c9e84e6e1c207e0923e4d43e5e41620bdd6801"},"endpointDiagnostic":"","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"response byte limit"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-request-frame"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-response-bytes-over"},"status":200},"scheduleId":null},"sui-trailer-bytes-inclusive-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":8304,"encoding":"hex","sha256":"d0373fc6d573ddaf6bc282e127a041e761cb9aa0ea26d5d4d7493192a38f79d0"},"endpointDiagnostic":"","ioCount":1,"outcome":{"kind":"success","value":"trailer boundary"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-request-frame"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-trailer-bytes-inclusive"},"status":200},"scheduleId":null},"sui-trailer-bytes-over-case":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-sui-grpc","cohort":5,"exceptionIds":[],"expected":{"binary":{"decodedLength":8305,"encoding":"hex","sha256":"ecf82db9c1bcb469b6841d1e3556649a978cd6b214aed80bc3704555885ac6e1"},"endpointDiagnostic":"","ioCount":1,"outcome":{"category":"invalid-response","kind":"error","message":"trailer byte limit"},"trace":{"attempts":1,"bodySha256":"8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"<redacted>","x-grpc-web":"1"},"ioKind":"performed","method":"POST","target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"}},"networkId":"rpc-sui-mainnet","operation":{"params":[],"publicOperation":"getServiceInfo","wireOperation":"/sui.rpc.v2.LedgerService/GetServiceInfo"},"request":{"bodyEncoding":"descriptor","headers":{"accept":"application/grpc-web+proto","content-type":"application/grpc-web+proto","x-fixture-scoped":"fixture-header","x-grpc-web":"1"},"method":"POST","source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-get-service-info-request-frame"},"target":"https://sui.fixture.invalid/prefix/sui.rpc.v2.LedgerService/GetServiceInfo?fixture=1"},"response":{"bodyEncoding":"descriptor","headers":{"content-type":"application/grpc-web+proto"},"source":{"kind":"oracle-ref-v1","oracleGoldenId":"sui-trailer-bytes-over"},"status":200},"scheduleId":null},"tron-eth-call-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-tron-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"method coverage"},"trace":{"attempts":1,"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-tron-mainnet","operation":{"params":[{"data":"0x","to":"0x0000000000000000000000000000000000000001"},"latest"],"publicOperation":"eth_call","wireOperation":"eth_call"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"426c3994d0cbad726acaf696726182d55377592e85a0a96f359fbb5ccebe8e15"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"693e8930e72658ce36bc3e1df09149339c713fea3a1175042642cd57d690de71"},"status":200},"scheduleId":null},"tron-get-balance-method-coverage":{"applicability":["typescript","rust","python","go","ruby"],"clientContractId":"client-tron-rpc","cohort":5,"exceptionIds":[],"expected":{"binary":null,"endpointDiagnostic":"https://node.fixture.invalid/","ioCount":1,"outcome":{"kind":"success","value":"method coverage"},"trace":{"attempts":1,"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93","headers":{"content-type":"application/json"},"ioKind":"performed","method":"POST","target":"https://node.fixture.invalid/rpc"}},"networkId":"rpc-tron-mainnet","operation":{"params":["0x0000000000000000000000000000000000000001","latest"],"publicOperation":"eth_getBalance","wireOperation":"eth_getBalance"},"request":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"method":"POST","source":{"bodySha256":"9a2dfe9a1c6fa7c3171d388d97baf97b37db03f182c84a5e312de3aee80d6d93"},"target":"https://node.fixture.invalid/rpc"},"response":{"bodyEncoding":"json","headers":{"content-type":"application/json"},"source":{"kind":"inline-v1","measurementSha256":"b0b17a2167550f78381234d8284565462e60c99813ae88d7dc4f310662d3f65c"},"status":200},"scheduleId":null}});
const APPROVED_SUI_RELATIONS = Object.freeze({"golden":{"sui-get-service-info-request-frame":{"id":"sui-get-service-info-request-frame","methodPath":"/sui.rpc.v2.LedgerService/GetServiceInfo","requestFrameHex":"0000000000","responseBodyHex":"00000000660a2c3462746975694d507645454e737474705a4337435a353344727543334d4167667a6e446241535a374452365312076d61696e6e657418ffffffffffffffffff01202a2a080895bae7b506107b3000380042087375692d746573749a060769676e6f7265648000000010677270632d7374617475733a20300d0a","expected":{"chainId":"4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S","chain":"mainnet","epoch":"18446744073709551615","checkpoint":"42","timestampSeconds":"1723456789","timestampNanos":123,"lowestCheckpoint":"0","lowestVerifiedCheckpoint":"0","server":"sui-test"}},"sui-get-object-version-zero-request-frame":{"id":"sui-get-object-version-zero-request-frame","methodPath":"/sui.rpc.v2.LedgerService/GetObject","requestFrameHex":"00000000070a033078321000","responseBodyHex":"00000000110a0f1203307832180722066469676573748000000010677270632d7374617475733a20300d0a","expected":{"objectId":"0x2","version":"7","digest":"digest"}},"sui-get-object-version-absent-request-frame":{"id":"sui-get-object-version-absent-request-frame","methodPath":"/sui.rpc.v2.LedgerService/GetObject","requestFrameHex":"00000000050a03307832","responseBodyHex":"00000000110a0f1203307832180722066469676573748000000010677270632d7374617475733a20300d0a","expected":{"objectId":"0x2","version":"7","digest":"digest"}},"sui-get-balance-request-frame":{"id":"sui-get-balance-request-frame","methodPath":"/sui.rpc.v2.StateService/GetBalance","requestFrameHex":"000000000d0a056f776e65721204636f696e","responseBodyHex":"00000000170a150a0d3078323a3a7375693a3a535549182a202828028000000010677270632d7374617475733a20300d0a","expected":{"coinType":"0x2::sui::SUI","balance":"42","addressBalance":"40","coinBalance":"2"}},"sui-get-object-embedded-depth100":{"id":"sui-get-object-embedded-depth100","methodPath":"/sui.rpc.v2.LedgerService/GetObject","requestFrameHex":"00000000050a03307832","responseBodyHex":"00000000cf0acc012b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c1200180022008000000010677270632d7374617475733a20300d0a","expected":{"objectId":"","version":"0","digest":"","recursionDepth":100}},"sui-get-object-embedded-depth101":{"id":"sui-get-object-embedded-depth101","methodPath":"/sui.rpc.v2.LedgerService/GetObject","requestFrameHex":"00000000050a03307832","responseBodyHex":"00000000d10ace012b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c1200180022008000000010677270632d7374617475733a20300d0a","expected":{"outcome":"invalid-response","recursionDepth":101}},"sui-get-service-info-timestamp-merge-final-zero":{"id":"sui-get-service-info-timestamp-merge-final-zero","methodPath":"/sui.rpc.v2.LedgerService/GetServiceInfo","requestFrameHex":"0000000000","responseBodyHex":"00000000260a05636861696e12076d61696e6e6574180020002a08082a108094ebdc032a021000300038008000000010677270632d7374617475733a20300d0a","expected":{"chainId":"chain","chain":"mainnet","epoch":"0","checkpoint":"0","timestampSeconds":"42","timestampNanos":0,"lowestCheckpoint":"0","lowestVerifiedCheckpoint":"0"}},"sui-get-service-info-timestamp-merge-final-invalid":{"id":"sui-get-service-info-timestamp-merge-final-invalid","methodPath":"/sui.rpc.v2.LedgerService/GetServiceInfo","requestFrameHex":"0000000000","responseBodyHex":"00000000260a05636861696e12076d61696e6e6574180020002a04082a10002a06108094ebdc03300038008000000010677270632d7374617475733a20300d0a","expected":{"outcome":"invalid-response","finalTimestampNanos":1000000000}}},"boundaryCases":{"sui-request-bytes-inclusive":{"id":"sui-request-bytes-inclusive","direction":"request","size":1048576,"outcome":"success","oracleGoldenId":"sui-request-bytes-inclusive"},"sui-request-bytes-over":{"id":"sui-request-bytes-over","direction":"request","size":1048577,"outcome":"config","oracleGoldenId":"sui-request-bytes-over"},"sui-response-bytes-inclusive":{"id":"sui-response-bytes-inclusive","direction":"response","size":8388608,"outcome":"success","oracleGoldenId":"sui-response-bytes-inclusive"},"sui-response-bytes-over":{"id":"sui-response-bytes-over","direction":"response","size":8388609,"outcome":"invalid-response","oracleGoldenId":"sui-response-bytes-over"},"sui-trailer-bytes-inclusive":{"id":"sui-trailer-bytes-inclusive","direction":"trailer","size":8192,"outcome":"success","oracleGoldenId":"sui-trailer-bytes-inclusive"},"sui-trailer-bytes-over":{"id":"sui-trailer-bytes-over","direction":"trailer","size":8193,"outcome":"invalid-response","oracleGoldenId":"sui-trailer-bytes-over"}},"framingCases":{"sui-data-and-terminal-trailer":{"id":"sui-data-and-terminal-trailer","outcome":"success","descriptorSha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6","measurement":{"decodedLength":128,"sha256":"dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6","grpcFrames":[{"marker":0,"declaredLength":102,"actualLength":102,"offset":0},{"marker":128,"declaredLength":16,"actualLength":16,"offset":107}],"trailerLength":16},"chunkPlan":{"kind":"single-v1"}},"sui-missing-trailer":{"id":"sui-missing-trailer","outcome":"invalid-response","descriptorSha256":"dcee420a304c2e9fee37603b736bd6c1f07bcab7cbbf02daf18f44817c5b21ed","measurement":{"decodedLength":107,"sha256":"dcee420a304c2e9fee37603b736bd6c1f07bcab7cbbf02daf18f44817c5b21ed","grpcFrames":[{"marker":0,"declaredLength":102,"actualLength":102,"offset":0}],"trailerLength":0},"chunkPlan":{"kind":"single-v1"}},"sui-trailer-first":{"id":"sui-trailer-first","outcome":"invalid-response","descriptorSha256":"11b153afcc7db0acba96d3ad091c7975c6b2368839bafd9cc3e5483a4434fc79","measurement":{"decodedLength":128,"sha256":"11b153afcc7db0acba96d3ad091c7975c6b2368839bafd9cc3e5483a4434fc79","grpcFrames":[{"marker":128,"declaredLength":16,"actualLength":16,"offset":0},{"marker":0,"declaredLength":102,"actualLength":102,"offset":21}],"trailerLength":16},"chunkPlan":{"kind":"single-v1"}},"sui-two-data-frames":{"id":"sui-two-data-frames","outcome":"invalid-response","descriptorSha256":"d5e6e20bcc786587a849037e2f6a7d3b0a730f79d0d25434ddee65177075635a","measurement":{"decodedLength":235,"sha256":"d5e6e20bcc786587a849037e2f6a7d3b0a730f79d0d25434ddee65177075635a","grpcFrames":[{"marker":0,"declaredLength":102,"actualLength":102,"offset":0},{"marker":0,"declaredLength":102,"actualLength":102,"offset":107},{"marker":128,"declaredLength":16,"actualLength":16,"offset":214}],"trailerLength":16},"chunkPlan":{"kind":"single-v1"}},"sui-duplicate-trailer":{"id":"sui-duplicate-trailer","outcome":"invalid-response","descriptorSha256":"7e4bd6caf4934a06bf9a7acd4bd7dafdd39ac8108182bad33a53e1b035252758","measurement":{"decodedLength":149,"sha256":"7e4bd6caf4934a06bf9a7acd4bd7dafdd39ac8108182bad33a53e1b035252758","grpcFrames":[{"marker":0,"declaredLength":102,"actualLength":102,"offset":0},{"marker":128,"declaredLength":16,"actualLength":16,"offset":107},{"marker":128,"declaredLength":16,"actualLength":16,"offset":128}],"trailerLength":32},"chunkPlan":{"kind":"single-v1"}},"sui-compressed-frame":{"id":"sui-compressed-frame","outcome":"invalid-response","descriptorSha256":"10b9d9e42cf1d7867c9fbc2585d3b0c78edc86cf9b337f2b4d416c08529a5b7d","measurement":{"decodedLength":128,"sha256":"10b9d9e42cf1d7867c9fbc2585d3b0c78edc86cf9b337f2b4d416c08529a5b7d","grpcFrames":[{"marker":1,"declaredLength":102,"actualLength":102,"offset":0},{"marker":128,"declaredLength":16,"actualLength":16,"offset":107}],"trailerLength":16},"chunkPlan":{"kind":"single-v1"}},"sui-unknown-marker":{"id":"sui-unknown-marker","outcome":"invalid-response","descriptorSha256":"1185c4c71e904a667bf61ca3401bcf89d39524d0544189123c5b744594d68fd1","measurement":{"decodedLength":128,"sha256":"1185c4c71e904a667bf61ca3401bcf89d39524d0544189123c5b744594d68fd1","grpcFrames":[{"marker":2,"declaredLength":102,"actualLength":102,"offset":0},{"marker":128,"declaredLength":16,"actualLength":16,"offset":107}],"trailerLength":16},"chunkPlan":{"kind":"single-v1"}}},"lifecycleSchedules":{"life-immediate-response":{"id":"life-immediate-response","kind":"immediate-response","timeoutMs":40,"delayMs":0,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":true,"connectionClosed":true,"outcome":"success"},"life-redirect-to-second-server":{"id":"life-redirect-to-second-server","kind":"redirect-to-second-server","timeoutMs":40,"delayMs":0,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":true,"connectionClosed":true,"outcome":"http-redirect"},"life-withhold-headers":{"id":"life-withhold-headers","kind":"withhold-headers","timeoutMs":40,"delayMs":250,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":false,"connectionClosed":true,"outcome":"timeout"},"life-first-chunk-then-delay":{"id":"life-first-chunk-then-delay","kind":"first-chunk-then-delay","timeoutMs":40,"delayMs":250,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":true,"connectionClosed":true,"outcome":"timeout"},"life-pre-cancel":{"id":"life-pre-cancel","kind":"pre-cancel","timeoutMs":40,"delayMs":0,"expectedCalls":0,"expectedDestinationCalls":0,"expectedAttempts":0,"bodyClosed":false,"connectionClosed":false,"outcome":"context-cancelled"},"life-first-chunk-cancellation-barrier":{"id":"life-first-chunk-cancellation-barrier","kind":"first-chunk-cancellation-barrier","timeoutMs":40,"delayMs":0,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":true,"connectionClosed":true,"outcome":"context-cancelled","barrier":{"firstChunkSignal":"server-first-chunk","cancelObserved":"client-cancel-observed","release":"server-release-remainder"}},"life-reset-before-headers":{"id":"life-reset-before-headers","kind":"reset-before-headers","timeoutMs":40,"delayMs":0,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":false,"connectionClosed":true,"outcome":"transport"},"life-reset-after-first-chunk":{"id":"life-reset-after-first-chunk","kind":"reset-after-first-chunk","timeoutMs":40,"delayMs":0,"expectedCalls":1,"expectedDestinationCalls":0,"expectedAttempts":1,"bodyClosed":true,"connectionClosed":true,"outcome":"transport"}}});
const DESCRIPTOR_KINDS = new Set([
  "literal-bytes-v1", "json-space-pad-v1", "json-nested-arrays-v1", "json-zero-array-v1",
  "json-number-token-v1", "invalid-utf8-json-v1", "sui-get-object-request-v1",
  "sui-padded-service-response-v1", "sui-sized-trailer-response-v1", "sui-frame-mutation-v1", "sui-raw-bytes-v1",
]);
const CHUNK_PLAN_KINDS = new Set(["single-v1", "fixed-v1", "explicit-v1", "first-then-block-v1"]);
const SUI_GOLDEN_BYTES = Object.freeze({
  "sui-get-service-info-response-body": "00000000660a2c3462746975694d507645454e737474705a4337435a353344727543334d4167667a6e446241535a374452365312076d61696e6e657418ffffffffffffffffff01202a2a080895bae7b506107b3000380042087375692d746573749a060769676e6f7265648000000010677270632d7374617475733a20300d0a",
  "sui-get-object-response-body": "00000000110a0f1203307832180722066469676573748000000010677270632d7374617475733a20300d0a",
  "sui-get-balance-response-body": "00000000170a150a0d3078323a3a7375693a3a535549182a202828028000000010677270632d7374617475733a20300d0a",
});

function safeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} must be a safe non-negative integer <= ${maximum}`);
}

function hexBytes(value, label) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) fail(`${label} must be canonical lowercase even hex`);
  return Buffer.from(value, "hex");
}

function encodedLiteralBytes(descriptor) {
  if (descriptor.encoding === "utf8") {
    if (typeof descriptor.value !== "string") fail("utf8 literal must carry a string");
    return Buffer.from(descriptor.value, "utf8");
  }
  if (descriptor.encoding === "hex") return hexBytes(descriptor.value, "hex literal");
  if (descriptor.encoding === "base64") {
    if (typeof descriptor.value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(descriptor.value)) fail("base64 literal must be canonical base64");
    return Buffer.from(descriptor.value, "base64");
  }
  fail("literal encoding is unsupported");
}

function encodeVarint(value) { let current = BigInt(value); const bytes = []; do { let byte = Number(current & 0x7fn); current >>= 7n; if (current !== 0n) byte |= 0x80; bytes.push(byte); } while (current !== 0n); return Buffer.from(bytes); }

function canonicalNumberTuple(raw) {
  if (typeof raw !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(raw)) fail(`invalid numeric literal ${raw}`);
  const match = raw.match(/^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u);
  const negative = match[1] === "-";
  const integerDigits = match[2];
  const fractionDigits = match[3] ?? "";
  const explicitText = match[4] === undefined ? "0" : match[4];
  const explicitSign = explicitText.startsWith("-") ? -1 : 1;
  const explicitDigits = explicitText.replace(/^[+-]/u, "").replace(/^0+(?=\d)/u, "") || "0";
  if (explicitDigits.length > 5 || Number(explicitDigits) > 10000) fail("explicit exponent exceeds the approved range");
  const explicitExponent = explicitSign * Number(explicitDigits);
  const rawCoefficient = `${integerDigits}${fractionDigits}`;
  const coefficientDigits = rawCoefficient.length;
  const normalizedCoefficient = rawCoefficient.replace(/^0+(?=\d)/u, "");
  let coefficient = normalizedCoefficient.replace(/^0+/u, "");
  if (coefficient === "") return { sign: 0, coefficient: "0", exponent10: "0", coefficientDigits, explicitExponent };
  let exponent = explicitExponent - fractionDigits.length;
  coefficient = coefficient.replace(/0+$/u, (zeros) => { exponent += zeros.length; return ""; });
  return { sign: negative ? -1 : 1, coefficient, exponent10: String(exponent), coefficientDigits, explicitExponent };
}

function descriptorShapeKeys(kind) {
  const keys = {
    "literal-bytes-v1": ["kind", "encoding", "value", "decodedLength", "sha256"],
    "sui-raw-bytes-v1": ["kind", "encoding", "value", "decodedLength", "sha256"],
    "json-space-pad-v1": ["kind", "prefix", "repeatCount", "suffix", "decodedLength", "sha256"],
    "json-nested-arrays-v1": ["kind", "prefix", "arrayDepth", "scalar", "suffix", "decodedLength", "maxContainerDepth", "sha256"],
    "json-zero-array-v1": ["kind", "prefix", "elementCount", "suffix", "decodedLength", "jsonTokenCount", "sha256"],
    "json-number-token-v1": ["kind", "prefix", "tokenForm", "suffix", "decodedLength", "sha256", "measurement"],
    "invalid-utf8-json-v1": ["kind", "prefixHex", "insertHex", "suffixHex", "decodedLength", "sha256"],
    "sui-get-object-request-v1": ["kind", "objectByte", "objectCount", "versionPresent", "version", "decodedLength", "sha256"],
    "sui-padded-service-response-v1": ["kind", "baseHex", "fillerTag", "fillerBytes", "trailerHex", "decodedLength", "sha256"],
    "sui-sized-trailer-response-v1": ["kind", "dataHex", "trailerPrefixHex", "valueByte", "valueCount", "trailerSuffixHex", "decodedLength", "sha256"],
    "sui-frame-mutation-v1": ["kind", "baseGoldenId", "operations", "decodedLength", "sha256"],
  };
  return keys[kind];
}

export function validateDescriptorShape(descriptor) {
  if (!isRecord(descriptor) || !DESCRIPTOR_KINDS.has(descriptor.kind)) fail("descriptor kind is not an approved closed form");
  const required = descriptorShapeKeys(descriptor.kind);
  exactKeys(descriptor, required, `descriptor.${descriptor.kind}`, ["measurement"]);
  if (descriptor.kind === "literal-bytes-v1" || descriptor.kind === "sui-raw-bytes-v1") {
    if (!["utf8", "hex", "base64"].includes(descriptor.encoding)) fail("literal descriptor encoding is unsupported");
    const bytes = encodedLiteralBytes(descriptor);
    safeInteger(descriptor.decodedLength, "literal decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes);
    if (bytes.length !== descriptor.decodedLength || digest(bytes) !== descriptor.sha256) fail("literal descriptor length/hash does not match bytes");
    if (descriptor.kind === "sui-raw-bytes-v1") {
      if (descriptor.decodedLength > DESCRIPTOR_LIMITS.maxSuiRawBytes) fail("Sui raw descriptor exceeds the bounded raw-vector limit");
    } else if (bytes.length > DESCRIPTOR_LIMITS.maxLiteralBytes && descriptor.decodedLength !== 128 && descriptor.decodedLength !== 49 && descriptor.decodedLength !== 43) {
      fail("literal descriptor exceeds the bounded literal limit");
    }
  } else if (descriptor.kind === "json-space-pad-v1") {
    text(descriptor.prefix, "json-space-pad prefix"); text(descriptor.suffix, "json-space-pad suffix"); safeInteger(descriptor.repeatCount, "json-space-pad repeatCount", DESCRIPTOR_LIMITS.maxDecodedBytes); safeInteger(descriptor.decodedLength, "json-space-pad decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes);
    const expected = Buffer.byteLength(descriptor.prefix) + descriptor.repeatCount + Buffer.byteLength(descriptor.suffix);
    if (expected !== descriptor.decodedLength || descriptor.repeatCount > DESCRIPTOR_LIMITS.maxDecodedBytes || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) fail("json-space-pad construction length/hash metadata is invalid");
  } else if (descriptor.kind === "json-nested-arrays-v1") {
    text(descriptor.prefix, "nested prefix"); text(descriptor.suffix, "nested suffix"); safeInteger(descriptor.arrayDepth, "arrayDepth", DESCRIPTOR_LIMITS.maxNestedContainers); if (descriptor.scalar !== "0") fail("nested scalar must be zero"); safeInteger(descriptor.decodedLength, "nested decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes); safeInteger(descriptor.maxContainerDepth, "maxContainerDepth", DESCRIPTOR_LIMITS.maxNestedContainers); if (descriptor.maxContainerDepth !== descriptor.arrayDepth + 1) fail("nested root-inclusive depth is inconsistent");
    const expected = Buffer.byteLength(descriptor.prefix) + descriptor.arrayDepth * 1 + 1 + descriptor.arrayDepth + Buffer.byteLength(descriptor.suffix); if (expected !== descriptor.decodedLength) fail("nested construction length is inconsistent");
  } else if (descriptor.kind === "json-zero-array-v1") {
    text(descriptor.prefix, "zero-array prefix"); text(descriptor.suffix, "zero-array suffix"); safeInteger(descriptor.elementCount, "elementCount", DESCRIPTOR_LIMITS.maxArrayElements); safeInteger(descriptor.decodedLength, "zero-array decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes); safeInteger(descriptor.jsonTokenCount, "jsonTokenCount", DESCRIPTOR_LIMITS.maxArrayElements + 16); const expected = Buffer.byteLength(descriptor.prefix) + (descriptor.elementCount === 0 ? 0 : descriptor.elementCount * 2 - 1) + Buffer.byteLength(descriptor.suffix); if (expected !== descriptor.decodedLength) fail("zero-array construction length is inconsistent");
  } else if (descriptor.kind === "json-number-token-v1") {
    text(descriptor.prefix, "number prefix"); text(descriptor.suffix, "number suffix"); if (!isRecord(descriptor.tokenForm) || !["literal", "fraction-zero-exponent-zero", "one-followed-by-zeros"].includes(descriptor.tokenForm.kind)) fail("number tokenForm is not closed");
    let token; if (descriptor.tokenForm.kind === "literal") { text(descriptor.tokenForm.value, "number literal"); token = descriptor.tokenForm.value; } else if (descriptor.tokenForm.kind === "fraction-zero-exponent-zero") { safeInteger(descriptor.tokenForm.fractionZeroCount, "fractionZeroCount", 999); safeInteger(descriptor.tokenForm.exponentZeroCount, "exponentZeroCount", 999); if (descriptor.tokenForm.fractionZeroCount < 1 || descriptor.tokenForm.exponentZeroCount < 1) fail("fraction repeat counts must be positive"); token = `1.${"0".repeat(descriptor.tokenForm.fractionZeroCount)}e+${"0".repeat(descriptor.tokenForm.exponentZeroCount)}`; } else { safeInteger(descriptor.tokenForm.zeroCount, "zeroCount", 1000); token = `1${"0".repeat(descriptor.tokenForm.zeroCount)}`; }
    let tuple; try { tuple = canonicalNumberTuple(token); } catch (error) { if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(token)) throw error; tuple = { coefficientDigits: token.split(/[eE]/u)[0].replace(/[^0-9]/gu, "").length }; }
    if (Buffer.byteLength(token) > DESCRIPTOR_LIMITS.maxNumericLexemeBytes) fail("number token exceeds the bounded numeric lexeme limit");
    safeInteger(descriptor.decodedLength, "number decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes); if (descriptor.decodedLength !== Buffer.byteLength(descriptor.prefix) + Buffer.byteLength(token) + Buffer.byteLength(descriptor.suffix)) fail("number body length is inconsistent"); if (!isRecord(descriptor.measurement)) fail("number descriptor measurement is required"); if (descriptor.measurement.rawLength !== Buffer.byteLength(token) || descriptor.measurement.coefficientDigits !== tuple.coefficientDigits) fail("number descriptor measurement is inconsistent");
  } else if (descriptor.kind === "invalid-utf8-json-v1") {
    const prefix = hexBytes(descriptor.prefixHex, "invalid utf8 prefix"); const inserted = hexBytes(descriptor.insertHex, "invalid utf8 insert"); const suffix = hexBytes(descriptor.suffixHex, "invalid utf8 suffix"); safeInteger(descriptor.decodedLength, "invalid utf8 decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes); if (prefix.length + inserted.length + suffix.length !== descriptor.decodedLength) fail("invalid utf8 length is inconsistent");
  } else if (descriptor.kind === "sui-get-object-request-v1") {
    if (typeof descriptor.objectByte !== "string" || !/^[a-z]$/u.test(descriptor.objectByte)) fail("Sui objectByte must be one lowercase ASCII byte"); safeInteger(descriptor.objectCount, "Sui objectCount", DESCRIPTOR_LIMITS.maxSuiRequestBytes); if (typeof descriptor.versionPresent !== "boolean") fail("Sui versionPresent must be boolean"); if (descriptor.versionPresent) safeInteger(descriptor.version, "Sui version", 18446744073709551615); else if (descriptor.version !== null) fail("absent Sui version must be null"); const payloadLength = 1 + encodeVarint(descriptor.objectCount).length + descriptor.objectCount + (descriptor.versionPresent ? 1 + encodeVarint(descriptor.version).length : 0); safeInteger(descriptor.decodedLength, "Sui request decodedLength", DESCRIPTOR_LIMITS.maxSuiRequestBytes); if (descriptor.decodedLength !== 5 + payloadLength) fail("Sui request decodedLength is inconsistent with protobuf/frame fields"); if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) fail("Sui request hash is invalid");
  } else if (descriptor.kind === "sui-padded-service-response-v1") {
    const base = hexBytes(descriptor.baseHex, "Sui base response"); if (!Number.isSafeInteger(descriptor.fillerBytes) || descriptor.fillerBytes < 0 || descriptor.fillerBytes > DESCRIPTOR_LIMITS.maxSuiResponseBytes) fail("Sui fillerBytes is invalid"); safeInteger(descriptor.fillerTag, "Sui fillerTag", 255); const trailer = hexBytes(descriptor.trailerHex, "Sui trailer hex"); safeInteger(descriptor.decodedLength, "Sui response decodedLength", DESCRIPTOR_LIMITS.maxSuiResponseBytes); const fillerLength = encodeVarint(descriptor.fillerBytes); const expectedLength = 5 + base.length + encodeVarint(descriptor.fillerTag * 8 + 2).length + fillerLength.length + descriptor.fillerBytes + trailer.length; if (expectedLength !== descriptor.decodedLength) fail("Sui response decodedLength is inconsistent with bounded filler fields"); if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) fail("Sui response hash is invalid");
  } else if (descriptor.kind === "sui-sized-trailer-response-v1") {
    const data = hexBytes(descriptor.dataHex, "Sui data"); const trailerPrefix = hexBytes(descriptor.trailerPrefixHex, "Sui trailer prefix"); const trailerSuffix = hexBytes(descriptor.trailerSuffixHex, "Sui trailer suffix"); safeInteger(descriptor.valueByte, "Sui trailer valueByte", 255); safeInteger(descriptor.valueCount, "Sui trailer valueCount", DESCRIPTOR_LIMITS.maxSuiTrailerBytes); safeInteger(descriptor.decodedLength, "Sui trailer decodedLength", DESCRIPTOR_LIMITS.maxSuiResponseBytes); const expectedLength = data.length + 5 + trailerPrefix.length + descriptor.valueCount + trailerSuffix.length; if (expectedLength !== descriptor.decodedLength) fail("Sui trailer decodedLength is inconsistent with bounded fields"); if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) fail("Sui trailer hash is invalid");
  } else {
    if (!Object.hasOwn(SUI_GOLDEN_BYTES, descriptor.baseGoldenId)) fail("Sui mutation baseGoldenId is not an approved golden"); if (!Array.isArray(descriptor.operations) || descriptor.operations.length > DESCRIPTOR_LIMITS.maxMutations) fail("Sui mutation operations exceed bound"); safeInteger(descriptor.decodedLength, "Sui mutation decodedLength", DESCRIPTOR_LIMITS.maxSuiResponseBytes); if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) fail("Sui mutation hash is invalid"); for (const operation of descriptor.operations) validateMutationOperation(operation);
  }
  return true;
}

function validateMutationOperation(operation) {
  if (!isRecord(operation) || typeof operation.kind !== "string") fail("mutation operation must be a closed object");
  if (operation.kind === "set-byte") { exactKeys(operation, ["kind", "offset", "value"], "set-byte"); safeInteger(operation.offset, "set-byte offset", DESCRIPTOR_LIMITS.maxSuiResponseBytes); safeInteger(operation.value, "set-byte value", 255); }
  else if (operation.kind === "set-u32be") { exactKeys(operation, ["kind", "offset", "value"], "set-u32be"); safeInteger(operation.offset, "set-u32be offset", DESCRIPTOR_LIMITS.maxSuiResponseBytes); safeInteger(operation.value, "set-u32be value", 4294967295); }
  else if (operation.kind === "append-hex") { exactKeys(operation, ["kind", "value"], "append-hex"); const bytes = hexBytes(operation.value, "append-hex value"); if (bytes.length > DESCRIPTOR_LIMITS.maxLiteralBytes) fail("append-hex exceeds bound"); }
  else if (operation.kind === "truncate-to") { exactKeys(operation, ["kind", "decodedLength"], "truncate-to"); safeInteger(operation.decodedLength, "truncate-to length", DESCRIPTOR_LIMITS.maxSuiResponseBytes); }
  else if (operation.kind === "duplicate-frame" || operation.kind === "reorder-two-frames") { exactKeys(operation, operation.kind === "duplicate-frame" ? ["kind", "frameIndex", "insertAtFrameIndex"] : ["kind", "firstFrameIndex", "secondFrameIndex"], operation.kind); for (const key of Object.keys(operation).filter((key) => key !== "kind")) safeInteger(operation[key], `${operation.kind}.${key}`, 128); }
  else fail(`unsupported mutation operation ${operation.kind}`);
}

export function expandDescriptorChunks(input) {
  validateDescriptorShape(input);
  const descriptor = structuredClone(input);
  return expandDescriptorChunksFromValidated(descriptor);
}

function* expandDescriptorChunksFromValidated(descriptor) {
  const emit = function* (bytes) { for (let offset = 0; offset < bytes.length; offset += DESCRIPTOR_LIMITS.maxChunkBytes) yield bytes.subarray(offset, Math.min(offset + DESCRIPTOR_LIMITS.maxChunkBytes, bytes.length)); };
  const repeatedBytes = function* (count, byte) { let remaining = count; while (remaining > 0) { const size = Math.min(remaining, DESCRIPTOR_LIMITS.maxChunkBytes); yield Buffer.alloc(size, byte); remaining -= size; } };
  const repeatedPairs = function* (pairCount, first, second) { let remaining = pairCount; while (remaining > 0) { const pairs = Math.min(remaining, Math.floor(DESCRIPTOR_LIMITS.maxChunkBytes / 2)); const bytes = Buffer.alloc(pairs * 2); for (let index = 0; index < bytes.length; index += 2) { bytes[index] = first; bytes[index + 1] = second; } yield bytes; remaining -= pairs; } };
  if (descriptor.kind === "literal-bytes-v1" || descriptor.kind === "sui-raw-bytes-v1") { yield* emit(encodedLiteralBytes(descriptor)); return; }
  if (descriptor.kind === "json-space-pad-v1") { yield* emit(Buffer.from(descriptor.prefix)); let remaining = descriptor.repeatCount; while (remaining > 0) { const size = Math.min(remaining, DESCRIPTOR_LIMITS.maxChunkBytes); yield Buffer.alloc(size, 0x20); remaining -= size; } yield* emit(Buffer.from(descriptor.suffix)); return; }
  if (descriptor.kind === "json-nested-arrays-v1") { yield* emit(Buffer.from(`${descriptor.prefix}${"[".repeat(descriptor.arrayDepth)}0${"]".repeat(descriptor.arrayDepth)}${descriptor.suffix}`)); return; }
  if (descriptor.kind === "json-zero-array-v1") { yield* emit(Buffer.from(descriptor.prefix)); if (descriptor.elementCount > 0) { yield* repeatedPairs(descriptor.elementCount - 1, 0x30, 0x2c); yield Buffer.from("0"); } yield* emit(Buffer.from(descriptor.suffix)); return; }
  if (descriptor.kind === "json-number-token-v1") { let token = descriptor.tokenForm.kind === "literal" ? descriptor.tokenForm.value : descriptor.tokenForm.kind === "fraction-zero-exponent-zero" ? `1.${"0".repeat(descriptor.tokenForm.fractionZeroCount)}e+${"0".repeat(descriptor.tokenForm.exponentZeroCount)}` : `1${"0".repeat(descriptor.tokenForm.zeroCount)}`; yield* emit(Buffer.from(`${descriptor.prefix}${token}${descriptor.suffix}`)); return; }
  if (descriptor.kind === "invalid-utf8-json-v1") { yield* emit(Buffer.concat([hexBytes(descriptor.prefixHex, "prefixHex"), hexBytes(descriptor.insertHex, "insertHex"), hexBytes(descriptor.suffixHex, "suffixHex")])); return; }
  if (descriptor.kind === "sui-get-object-request-v1") {
    const objectKey = Buffer.from([0x0a]);
    const objectLength = encodeVarint(descriptor.objectCount);
    const versionKey = Buffer.from([0x10]);
    const version = descriptor.versionPresent ? encodeVarint(descriptor.version) : Buffer.alloc(0);
    const payloadLength = objectKey.length + objectLength.length + descriptor.objectCount + (descriptor.versionPresent ? versionKey.length + version.length : 0);
    const frame = Buffer.alloc(5); frame.writeUInt32BE(payloadLength, 1); yield frame;
    yield objectKey; yield objectLength; yield* repeatedBytes(descriptor.objectCount, descriptor.objectByte.charCodeAt(0));
    if (descriptor.versionPresent) { yield versionKey; yield version; }
    return;
  }
  if (descriptor.kind === "sui-padded-service-response-v1") {
    const basePayload = hexBytes(descriptor.baseHex, "baseHex");
    const fillerKey = encodeVarint(descriptor.fillerTag * 8 + 2);
    const fillerLength = encodeVarint(descriptor.fillerBytes);
    const payloadLength = basePayload.length + fillerKey.length + fillerLength.length + descriptor.fillerBytes;
    const frame = Buffer.alloc(5); frame.writeUInt32BE(payloadLength, 1); yield frame;
    yield basePayload; yield fillerKey; yield fillerLength; yield* repeatedBytes(descriptor.fillerBytes, 0);
    yield* emit(hexBytes(descriptor.trailerHex, "trailerHex"));
    return;
  }
  if (descriptor.kind === "sui-sized-trailer-response-v1") {
    const data = hexBytes(descriptor.dataHex, "dataHex");
    const trailerPrefix = hexBytes(descriptor.trailerPrefixHex, "trailerPrefixHex");
    const trailerSuffix = hexBytes(descriptor.trailerSuffixHex, "trailerSuffixHex");
    const payloadLength = trailerPrefix.length + descriptor.valueCount + trailerSuffix.length;
    const frame = Buffer.alloc(5); frame[0] = 0x80; frame.writeUInt32BE(payloadLength, 1);
    yield data; yield frame; yield trailerPrefix; yield* repeatedBytes(descriptor.valueCount, descriptor.valueByte); yield trailerSuffix;
    return;
  }
  let bytes=Buffer.from(SUI_GOLDEN_BYTES[descriptor.baseGoldenId],"hex"); for(const operation of descriptor.operations){if(operation.kind==="set-byte"){if(operation.offset>=bytes.length)fail("set-byte offset is out of range");bytes[operation.offset]=operation.value;}else if(operation.kind==="set-u32be"){if(operation.offset+4>bytes.length)fail("set-u32be offset is out of range");bytes.writeUInt32BE(operation.value,operation.offset);}else if(operation.kind==="append-hex"){bytes=Buffer.concat([bytes,hexBytes(operation.value,"append-hex")]);}else if(operation.kind==="truncate-to"){if(operation.decodedLength>bytes.length)fail("truncate-to exceeds current bytes");bytes=bytes.subarray(0,operation.decodedLength);}else if(operation.kind==="duplicate-frame"){const frames=parseFrameTable(bytes);if(operation.frameIndex>=frames.length||operation.insertAtFrameIndex>frames.length)fail("duplicate-frame index is invalid");const frame=frames[operation.frameIndex];const insert=frames[operation.insertAtFrameIndex]?.offset??bytes.length;bytes=Buffer.concat([bytes.subarray(0,insert),bytes.subarray(frame.offset,frame.end),bytes.subarray(insert)]);}else if(operation.kind==="reorder-two-frames"){const frames=parseFrameTable(bytes);if(operation.firstFrameIndex>=frames.length||operation.secondFrameIndex>=frames.length||operation.firstFrameIndex===operation.secondFrameIndex)fail("reorder-two-frames index is invalid");const first=frames[operation.firstFrameIndex],second=frames[operation.secondFrameIndex];bytes=Buffer.concat([bytes.subarray(0,first.offset),bytes.subarray(second.offset,second.end),bytes.subarray(first.end,second.offset),bytes.subarray(first.offset,first.end),bytes.subarray(second.end)]);}}
  if(bytes.length!==descriptor.decodedLength||digest(bytes)!==descriptor.sha256)fail("Sui mutation result length/hash does not match descriptor");yield* emit(bytes); return;
}

function parseFrameTable(bytes){const frames=[];let offset=0;while(offset+5<=bytes.length){const declared=bytes.readUInt32BE(offset+1);const end=offset+5+declared;if(end>bytes.length)fail("Sui frame table is truncated");frames.push({offset,end});offset=end;}if(offset!==bytes.length)fail("Sui frame table has trailing bytes");return frames;}

export function applyChunkPlan(byteChunks, inputPlan, decodedLength) {
  validateChunkPlanShape(inputPlan, decodedLength);
  const chunkPlan = structuredClone(inputPlan);
  return applyChunkPlanFromValidated(byteChunks, chunkPlan, decodedLength);
}

function* applyChunkPlanFromValidated(byteChunks, chunkPlan, decodedLength) {
  const lengths = [];
  if (chunkPlan.kind === "single-v1") {
    if (decodedLength > DESCRIPTOR_LIMITS.maxChunkBytes) fail("single chunk exceeds 64 KiB");
    if (decodedLength > 0) lengths.push(decodedLength);
  } else if (chunkPlan.kind === "fixed-v1") {
    safeInteger(chunkPlan.chunkBytes, "chunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes);
    if (chunkPlan.chunkBytes < 1) fail("chunkBytes must be positive");
    for (let left = decodedLength; left > 0; left -= chunkPlan.chunkBytes) lengths.push(Math.min(left, chunkPlan.chunkBytes));
  } else if (chunkPlan.kind === "explicit-v1") {
    if (!Array.isArray(chunkPlan.lengths) || chunkPlan.lengths.length > 16 || chunkPlan.lengths.some((length) => !Number.isSafeInteger(length) || length < 1 || length > DESCRIPTOR_LIMITS.maxChunkBytes) || chunkPlan.lengths.reduce((sum, length) => sum + length, 0) !== decodedLength) fail("explicit chunk plan is invalid");
    lengths.push(...chunkPlan.lengths);
  } else {
    safeInteger(chunkPlan.firstChunkBytes, "firstChunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes);
    safeInteger(chunkPlan.chunkBytes, "chunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes);
    if (chunkPlan.firstChunkBytes < 1 || chunkPlan.chunkBytes < 1 || chunkPlan.firstChunkBytes >= decodedLength) fail("first-then-block plan is invalid");
    lengths.push(chunkPlan.firstChunkBytes);
    for (let left = decodedLength - chunkPlan.firstChunkBytes; left > 0; left -= chunkPlan.chunkBytes) lengths.push(Math.min(left, chunkPlan.chunkBytes));
  }

  const source = byteChunks[Symbol.iterator]();
  let current = null;
  let currentOffset = 0;
  let sourceDone = false;
  const pull = () => {
    while (current === null || currentOffset >= current.length) {
      const next = source.next();
      if (next.done) { sourceDone = true; current = null; currentOffset = 0; return false; }
      if (!Buffer.isBuffer(next.value) || next.value.length > DESCRIPTOR_LIMITS.maxChunkBytes) fail("expanded chunk is invalid");
      if (next.value.length === 0) continue;
      current = next.value;
      currentOffset = 0;
    }
    return true;
  };
  const readExact = (length) => {
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (!pull()) fail("chunk plan source length is shorter than decodedLength");
      const take = Math.min(length - written, current.length - currentOffset);
      current.copy(output, written, currentOffset, currentOffset + take);
      currentOffset += take;
      written += take;
    }
    return output;
  };
  for (const length of lengths) yield readExact(length);
  if (!sourceDone && pull()) fail("chunk plan source length is longer than decodedLength");
}

export function measureExpandedChunks(byteChunks, family = "json") {
  const hash = createHash("sha256");
  let decodedLength = 0;
  const scanner = family.startsWith("sui") ? createGrpcScanner() : createJsonScanner();
  for (const chunk of byteChunks) {
    if (!Buffer.isBuffer(chunk) || chunk.length > DESCRIPTOR_LIMITS.maxChunkBytes) fail("expanded chunk is invalid");
    if (chunk.length === 0) continue;
    hash.update(chunk);
    scanner.feed(chunk);
    decodedLength += chunk.length;
  }
  const result = { decodedLength, sha256: hash.digest("hex") };
  return Object.assign(result, scanner.finish());
}

function createJsonScanner() {
  const utf8 = createUtf8Scanner();
  let inString = false;
  let escape = false;
  let depth = 0;
  let maxContainerDepth = 0;
  let tokens = 0;
  let index = 0;
  let numberStart = -1;
  let numberBytes = [];
  let numberHash = null;
  let numberCoefficientDigits = 0;
  let numberInExponent = false;
  let literalBytes = [];
  let numericTokenCount = 0;
  const numericTokens = [];
  let numericFirst = null;
  let numericLast = null;

  const numericByte = (byte) => byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x45 || byte === 0x65 || byte === 0x2b || byte === 0x2e;
  const appendNumberByte = (byte) => {
    numberHash.update(Buffer.from([byte]));
    if (byte === 0x65 || byte === 0x45) numberInExponent = true;
    else if (!numberInExponent && byte >= 0x30 && byte <= 0x39) numberCoefficientDigits += 1;
    if (numberBytes.length <= DESCRIPTOR_LIMITS.maxNumericLexemeBytes) numberBytes.push(byte);
  };
  const finishNumber = () => {
    if (numberStart < 0) return;
    const raw = Buffer.from(numberBytes).toString("ascii");
    const rawLength = index - numberStart;
    const rawTokenSha256 = numberHash.digest("hex");
    let tuple = null;
    let invalidReason = null;
    try {
      tuple = canonicalNumberTuple(raw);
      if (rawLength > LIMITS.numericLexemeBytes || tuple.coefficientDigits > LIMITS.coefficientDigits || Math.abs(Number(tuple.exponent10)) > LIMITS.canonicalExponentMax) invalidReason = "numeric-resource-limit";
    } catch {
      invalidReason = "numeric-policy-limit";
      const explicit = raw.match(/[eE]([+-]?[0-9]+)/u)?.[1] ?? null;
      tuple = { coefficientDigits: rawLength > LIMITS.numericLexemeBytes ? numberCoefficientDigits : raw.split(/[eE]/u)[0].replace(/[^0-9]/gu, "").length, explicitExponent: explicit, sign: null, coefficient: null, exponent10: null };
    }
    const event = {
      offset: numberStart,
      rawLength,
      rawToken: rawLength <= DESCRIPTOR_LIMITS.maxNumericLexemeBytes ? raw : undefined,
      rawTokenSha256,
      coefficientDigits: tuple.coefficientDigits,
      explicitExponent: tuple.explicitExponent === null ? null : String(tuple.explicitExponent),
      canonicalTuple: tuple.sign === null ? null : { sign: tuple.sign, coefficient: tuple.coefficient, exponent10: tuple.exponent10 },
      invalidReason,
    };
    if (event.rawToken === undefined) delete event.rawToken;
    tokens += 1;
    numericTokenCount += 1;
    if (numericFirst === null) numericFirst = event;
    numericLast = event;
    if (numericTokens.length < 128) numericTokens.push(event);
    numberStart = -1;
    numberBytes = [];
    numberHash = null;
    numberCoefficientDigits = 0;
    numberInExponent = false;
  };

  return {
    feed(bytes) {
      utf8.feed(bytes);
      for (const byte of bytes) {
        if (literalBytes.length > 0) {
          if (byte >= 0x61 && byte <= 0x7a) { literalBytes.push(byte); index += 1; continue; }
          tokens += 1;
          literalBytes = [];
        }
        if (numberStart >= 0) {
          if (numericByte(byte)) { appendNumberByte(byte); index += 1; continue; }
          finishNumber();
        }
        if (inString) {
          if (escape) escape = false;
          else if (byte === 0x5c) escape = true;
          else if (byte === 0x22) inString = false;
          index += 1;
          continue;
        }
        if (byte === 0x22) { inString = true; tokens += 1; index += 1; continue; }
        if (byte === 0x7b || byte === 0x5b) { depth += 1; maxContainerDepth = Math.max(maxContainerDepth, depth); tokens += 1; index += 1; continue; }
        if (byte === 0x7d || byte === 0x5d) { depth -= 1; index += 1; continue; }
        if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) { numberStart = index; numberBytes = []; numberHash = createHash("sha256"); numberCoefficientDigits = 0; numberInExponent = false; appendNumberByte(byte); index += 1; continue; }
        if (byte >= 0x61 && byte <= 0x7a) { literalBytes = [byte]; index += 1; continue; }
        index += 1;
      }
    },
    finish() {
      finishNumber();
      if (literalBytes.length > 0) { tokens += 1; literalBytes = []; }
      const result = { maxContainerDepth, jsonTokenCount: tokens, numericTokens, numericTokenCount };
      result.scanOutcome = utf8.finish();
      if (numericTokenCount > numericTokens.length) {
        const isRepeatedZero = numericFirst?.rawToken === "1" && numericLast?.rawToken === "0" && numericTokenCount > 1;
        result.numericCompact = isRepeatedZero
          ? { kind: "repeated-zero-v1", firstOffset: numericFirst.offset, repeatedStart: numericFirst.offset + 12, repeatedStride: 2, repeatedCount: numericTokenCount - 1, repeatedToken: "0", lastOffset: numericLast.offset }
          : { kind: "bounded-events-v1", first: numericFirst, last: numericLast };
      }
      return result;
    },
  };
}

function createUtf8Scanner() {
  let expected = 0;
  let codePoint = 0;
  let minimum = 0;
  let sequenceStart = -1;
  let offset = 0;
  let firstInvalidByteOffset = null;
  let reason = null;
  const invalidate = (at, why) => { if (firstInvalidByteOffset === null) { firstInvalidByteOffset = at; reason = why; } expected = 0; codePoint = 0; minimum = 0; sequenceStart = -1; };
  return {
    feed(bytes) {
      for (const byte of bytes) {
        const at = offset;
        offset += 1;
        if (firstInvalidByteOffset !== null) continue;
        if (expected === 0) {
          if (byte <= 0x7f) continue;
          if (byte >= 0xc2 && byte <= 0xdf) { expected = 1; codePoint = byte & 0x1f; minimum = 0x80; sequenceStart = at; continue; }
          if (byte >= 0xe0 && byte <= 0xef) { expected = 2; codePoint = byte & 0x0f; minimum = 0x800; sequenceStart = at; continue; }
          if (byte >= 0xf0 && byte <= 0xf4) { expected = 3; codePoint = byte & 0x07; minimum = 0x10000; sequenceStart = at; continue; }
          invalidate(at, "invalid-leading-byte");
          continue;
        }
        if ((byte & 0xc0) !== 0x80) { invalidate(at, "invalid-continuation-byte"); continue; }
        codePoint = (codePoint << 6) | (byte & 0x3f);
        expected -= 1;
        if (expected === 0) {
          if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) invalidate(sequenceStart, "invalid-code-point");
          sequenceStart = -1;
        }
      }
    },
    finish() {
      if (firstInvalidByteOffset === null && expected !== 0) invalidate(sequenceStart, "truncated-sequence");
      return firstInvalidByteOffset === null ? { kind: "valid-utf8" } : { kind: "invalid-utf8", firstInvalidByteOffset, reason };
    },
  };
}

function createGrpcScanner() {
  let absoluteOffset = 0;
  let frameStart = 0;
  let header = Buffer.alloc(5);
  let headerBytes = 0;
  let remaining = 0;
  let current = null;
  const frames = [];
  let trailerLength = 0;
  return {
    feed(bytes) {
      for (const byte of bytes) {
        if (remaining > 0) { remaining -= 1; current.actualLength += 1; absoluteOffset += 1; continue; }
        if (headerBytes < 5) {
          header[headerBytes] = byte; headerBytes += 1; absoluteOffset += 1;
          if (headerBytes === 5) {
            const marker = header[0];
            const declaredLength = header.readUInt32BE(1);
            current = { marker, declaredLength, actualLength: 0, offset: frameStart };
            frames.push(current);
            if ((marker & 0x80) !== 0) trailerLength += declaredLength;
            remaining = declaredLength;
          }
          continue;
        }
        frameStart = absoluteOffset;
        header = Buffer.alloc(5);
        headerBytes = 0;
        header[headerBytes] = byte; headerBytes += 1; absoluteOffset += 1;
      }
    },
    finish() { return { grpcFrames: frames.map((frame) => ({ ...frame })), trailerLength }; },
  };
}

export function validateDescriptorOracle(caseId, measured, storedExpected) {
  if (!isRecord(storedExpected)) fail(`${caseId} missing independent descriptor oracle`);
  const expected = ORACLE_ANCHORS[caseId];
  const compare = (actual, wanted, label) => { for (const [key, value] of Object.entries(wanted)) if (stableJson(actual[key]) !== stableJson(value)) fail(`${caseId} ${label}.${key} differs`); };
  if (expected !== undefined) compare(measured, expected, "approved oracle");
  compare(measured, storedExpected, "stored oracle");
  return true;
}

const ORACLE_ANCHORS = Object.freeze({
  "btc-u64-max": {
    "decodedLength": 67,
    "sha256": "012a70bdba506f81fc8bd0c27d5ac90030b06ff18746ee03e074e78bade5dbaf",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-u64-max-plus-one": {
    "decodedLength": 67,
    "sha256": "a740d9b3efd45391619ab5beb3801c0c4fe733e489216468e2c3910a100e5e10",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-typed-negative-zero": {
    "decodedLength": 49,
    "sha256": "7f04c2625ca520442c39cca3ffccd1e03da7319b47a09924819df4de762153fe",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-typed-fraction": {
    "decodedLength": 50,
    "sha256": "11fd6123ce29e83f1e4dbd9c9e3dfdeccd9641235b972ce7dbd711e857ab4c4f",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-typed-exponent": {
    "decodedLength": 50,
    "sha256": "d81e5349ec0562578f5deb4d30692644705870bf207995dcac362000a9375a2c",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-null-gettxout": {
    "decodedLength": 51,
    "sha256": "6337cc46fe423f90911d4eacf4f6754408501ef5d7bdcb8b549813b60cc6eb77",
    "maxContainerDepth": 1,
    "jsonTokenCount": 9,
    "numericTokenCount": 1,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-duplicate-escaped-last-wins": {
    "decodedLength": 73,
    "sha256": "37486d2a3442b640fe3ac568426e347bdfdddd86ceec41b954e315d08f9e849d",
    "maxContainerDepth": 2,
    "jsonTokenCount": 13,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-overwritten-over-limit": {
    "decodedLength": 79,
    "sha256": "11e4e85560273b48ffeb020c81349f5471a480e62b7dff00b5a40c2866f17625",
    "maxContainerDepth": 2,
    "jsonTokenCount": 13,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-nested-escaped-duplicate": {
    "decodedLength": 75,
    "sha256": "1eb486334b667cf79358de2c2d9ba2287d0a3a302f92c0945e819b4f08627fd9",
    "maxContainerDepth": 3,
    "jsonTokenCount": 15,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-prototype-marker": {
    "decodedLength": 189,
    "sha256": "4c1708f5b4b3116c6ede44b15dcee961be5659d3692eb80cecd12d5bc66432d5",
    "maxContainerDepth": 4,
    "jsonTokenCount": 23,
    "numericTokenCount": 1,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-error-data-exact": {
    "decodedLength": 162,
    "sha256": "a108957a3843f2f72f0c947468030bd08bf780b9ccb4cf9814f0a19f9b8ba5b7",
    "maxContainerDepth": 3,
    "jsonTokenCount": 19,
    "numericTokenCount": 4,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-root-id-last-one": {
    "decodedLength": 61,
    "sha256": "44bd7aa8a54f7a8c16147b8d8cbf830fc6bf73d8c15278b9c7be6c808e76fe4d",
    "maxContainerDepth": 1,
    "jsonTokenCount": 11,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-root-id-last-99": {
    "decodedLength": 61,
    "sha256": "7062ccaa2e4a2f362a8c79500aebd5ccbb8a3a4a022c15177a0b7b1a3769ffd8",
    "maxContainerDepth": 1,
    "jsonTokenCount": 11,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-root-result-overwritten": {
    "decodedLength": 70,
    "sha256": "b43d196a8e5313cc9d480694c74dd885f83a638e5915d02b7a126c69cb117814",
    "maxContainerDepth": 1,
    "jsonTokenCount": 11,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-root-error-last-nonnull": {
    "decodedLength": 94,
    "sha256": "16854f2c5492e7bb03bef26efba3c09f224c9b8e106f7ae4e0b708d2abb474c7",
    "maxContainerDepth": 2,
    "jsonTokenCount": 15,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-root-error-last-null": {
    "decodedLength": 94,
    "sha256": "0ebcbace24a213857aaf93895bcb7c8db71c0d3acc8a8eb3797e90f8fafb253d",
    "maxContainerDepth": 2,
    "jsonTokenCount": 15,
    "numericTokenCount": 3,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-decoded-entity-inclusive": {
    "decodedLength": 67108864,
    "sha256": "25a6ee52b5117cb760a613011d6e70e07a367f10d458b681eec25ff57735acaf",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-decoded-entity-over": {
    "decodedLength": 67108865,
    "sha256": "3368eb1ced0ac39ae0896cbb1d731fdaf4fde789be7a4b28cc26dcf544fa1fbf",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-container-depth-inclusive": {
    "decodedLength": 161,
    "sha256": "a3730ad79e5d408752a821e5f204b7c874ce8e4f3deb348ec90f0dc1a3021e92",
    "maxContainerDepth": 64,
    "jsonTokenCount": 70,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-container-depth-over": {
    "decodedLength": 163,
    "sha256": "50311919f602a9d48484288b0d63b1eef2ca15888a5341cafa12c911bcdcc574",
    "maxContainerDepth": 65,
    "jsonTokenCount": 71,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-json-token-budget-inclusive": {
    "decodedLength": 2000021,
    "sha256": "e04d5a545756b54808edc8a1883ac3ea3f24226874361f98a4f4cee1674d086b",
    "maxContainerDepth": 2,
    "jsonTokenCount": 1000000,
    "numericTokenCount": 999994,
    "numericCompact": {
      "kind": "repeated-zero-v1",
      "firstOffset": 22,
      "repeatedStart": 34,
      "repeatedStride": 2,
      "repeatedCount": 999993,
      "repeatedToken": "0",
      "lastOffset": 2000018
    },
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-json-token-budget-over": {
    "decodedLength": 2000023,
    "sha256": "80d0fe5450f3f2d2f750cf29533822eb5aab0f25aa3914091691291c72c8a7f7",
    "maxContainerDepth": 2,
    "jsonTokenCount": 1000001,
    "numericTokenCount": 999995,
    "numericCompact": {
      "kind": "repeated-zero-v1",
      "firstOffset": 22,
      "repeatedStart": 34,
      "repeatedStride": 2,
      "repeatedCount": 999994,
      "repeatedToken": "0",
      "lastOffset": 2000020
    },
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-numeric-lexeme-inclusive": {
    "decodedLength": 1058,
    "sha256": "4fb5778fcf70cc76b4ca41aeb8994b68843798603fb5334462cd3918ff86fb30",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-numeric-lexeme-over": {
    "decodedLength": 1059,
    "sha256": "e96ce456d07ae64be0b465624a4388bb64959f9262c619c139f658eb88b1d7f1",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-coefficient-inclusive": {
    "decodedLength": 1034,
    "sha256": "766cee11a4516d3db46cad3f4aee0cf6cbb1b4f80c3595e3a843e704dac37a76",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-coefficient-over": {
    "decodedLength": 1035,
    "sha256": "c9fee5e77bb0c876e17854ced223710e9adab2c0f797533977d5ea3abfd3f28c",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-exponent-positive-inclusive": {
    "decodedLength": 41,
    "sha256": "b3370f7e42d6346b8bd1f676fe34fe753137685c668cf0dc339864f92616f629",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-exponent-positive-over": {
    "decodedLength": 41,
    "sha256": "6c086551168507b5e1112191715fc432112687c8705598ef03c3720813408cf6",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-exponent-negative-inclusive": {
    "decodedLength": 42,
    "sha256": "08bdbbc155a3a11fa2f0de30577d4144f3ecd4764a3cc95da5ce7ab6e170d67a",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-exponent-negative-over": {
    "decodedLength": 42,
    "sha256": "c300eb9c63beb62bf23f2c08be1d7d3be8abfc6e88e5da0288cc149b4af9f2d7",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-canonical-positive-inclusive": {
    "decodedLength": 41,
    "sha256": "dc85a132c208959d8eef34942814176849ece5f0d1828bf7482b238bde7e16fe",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-canonical-positive-over": {
    "decodedLength": 42,
    "sha256": "83972978d9c27e54989e78ae889960a00b9ff4f354e5d658a72229d4deeba291",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-canonical-negative-inclusive": {
    "decodedLength": 43,
    "sha256": "e0e9163fd71c35e17489a682b30469f6d6826a168e4145ae725917d06ac90c3e",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-canonical-negative-over": {
    "decodedLength": 44,
    "sha256": "2fb35fae0250551661ebb0361ed3821ac2e28ac7364b6228fbc7705f5a3cc49f",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-zero-explicit-inclusive": {
    "decodedLength": 41,
    "sha256": "2f08882c22c87c0e4af3c090753828d87912e37510ef91b4685a57c3a97240dd",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-zero-explicit-over": {
    "decodedLength": 41,
    "sha256": "12b2084c3a9c8cebdb7599896726a0e47c57de9692760edadc361234cfbc8e47",
    "maxContainerDepth": 1,
    "jsonTokenCount": 7,
    "numericTokenCount": 2,
    "scanOutcome": {
      "kind": "valid-utf8"
    }
  },
  "btc-invalid-utf8": {
    "decodedLength": 37,
    "sha256": "7fe05ecf9ae5d951785b967aa186eab019147f2380cd52e8f42e5ca14394237a",
    "scanOutcome": {
      "kind": "invalid-utf8",
      "firstInvalidByteOffset": 34,
      "reason": "invalid-leading-byte"
    }
  },
  "sui-get-service-info-request-frame": {
    "decodedLength": 5,
    "sha256": "8855508aade16ec573d21e6a485dfd0a7624085c1a14b5ecdd6485de0c6839a4",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 0,
        "actualLength": 0,
        "offset": 0
      }
    ]
  },
  "sui-get-object-version-zero-request-frame": {
    "decodedLength": 12,
    "sha256": "f3d72df14a8f88570303b228121b9f7737880c417344053f14a4ed064964303c",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 7,
        "actualLength": 7,
        "offset": 0
      }
    ]
  },
  "sui-get-object-version-absent-request-frame": {
    "decodedLength": 10,
    "sha256": "e91718d399eefcb4d877d87fbdf2e57dcb1ec8150b888576ee2cfe138a918461",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 5,
        "actualLength": 5,
        "offset": 0
      }
    ]
  },
  "sui-get-balance-request-frame": {
    "decodedLength": 18,
    "sha256": "552b193b54383631a6a870c99c714c69b03d47976d0f7d57788e911e91c215f8",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 13,
        "actualLength": 13,
        "offset": 0
      }
    ]
  },
  "sui-get-service-info-response-body": {
    "decodedLength": 128,
    "sha256": "dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 107
      }
    ]
  },
  "sui-get-object-response-body": {
    "decodedLength": 43,
    "sha256": "f881c1052c1abe9e959312d83035c96f6db3bec7765cc64719c01a18770ad57b",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 17,
        "actualLength": 17,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 22
      }
    ]
  },
  "sui-get-balance-response-body": {
    "decodedLength": 49,
    "sha256": "ed25f1c722efbf2404c3adbfc10cecf76afd16d2efdc15e825791e82c7248009",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 23,
        "actualLength": 23,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 28
      }
    ]
  },
  "sui-request-bytes-inclusive": {
    "decodedLength": 1048576,
    "sha256": "49b09b38ed4ae29035ee9f45dc5fbc18c2dfc479a12a0e4e5bf9f17c6d2d8b33",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 1048571,
        "actualLength": 1048571,
        "offset": 0
      }
    ]
  },
  "sui-request-bytes-over": {
    "decodedLength": 1048577,
    "sha256": "b57255526c3bc451a4bc054c25222641c63e9dbfa74d8ff74137889c9bfc474a",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 1048572,
        "actualLength": 1048572,
        "offset": 0
      }
    ]
  },
  "sui-response-bytes-inclusive": {
    "decodedLength": 8388608,
    "sha256": "d687da482ab2dc567deae182cae0aeb4afbe4943b1a8abee94b520bf4442762d",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 8388582,
        "actualLength": 8388582,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 8388587
      }
    ]
  },
  "sui-response-bytes-over": {
    "decodedLength": 8388609,
    "sha256": "977ecec1c8d043f475d19b9517c9e84e6e1c207e0923e4d43e5e41620bdd6801",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 8388583,
        "actualLength": 8388583,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 8388588
      }
    ]
  },
  "sui-trailer-bytes-inclusive": {
    "decodedLength": 8304,
    "sha256": "d0373fc6d573ddaf6bc282e127a041e761cb9aa0ea26d5d4d7493192a38f79d0",
    "trailerLength": 8192,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 8192,
        "actualLength": 8192,
        "offset": 107
      }
    ]
  },
  "sui-trailer-bytes-over": {
    "decodedLength": 8305,
    "sha256": "ecf82db9c1bcb469b6841d1e3556649a978cd6b214aed80bc3704555885ac6e1",
    "trailerLength": 8193,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 8193,
        "actualLength": 8193,
        "offset": 107
      }
    ]
  },
  "life-header-timeout": {
    "decodedLength": 46,
    "sha256": "47418283c8b21ec5c5705150db0be3b95a5afe7a2b6738826dcdf269e800d5c7"
  },
  "life-pre-cancel": {
    "decodedLength": 35,
    "sha256": "3de77ed69008aeab3582489316d77dba2360ffa4f4ea66704a7fef9b21afbb18"
  },
  "sui-data-and-terminal-trailer": {
    "decodedLength": 128,
    "sha256": "dc2b04a4b14d0204865ad5fea66371043b007946fb982a1cac7e14386114d6d6",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 107
      }
    ]
  },
  "sui-missing-trailer": {
    "decodedLength": 107,
    "sha256": "dcee420a304c2e9fee37603b736bd6c1f07bcab7cbbf02daf18f44817c5b21ed",
    "trailerLength": 0,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      }
    ]
  },
  "sui-trailer-first": {
    "decodedLength": 128,
    "sha256": "11b153afcc7db0acba96d3ad091c7975c6b2368839bafd9cc3e5483a4434fc79",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 0
      },
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 21
      }
    ]
  },
  "sui-two-data-frames": {
    "decodedLength": 235,
    "sha256": "d5e6e20bcc786587a849037e2f6a7d3b0a730f79d0d25434ddee65177075635a",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 107
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 214
      }
    ]
  },
  "sui-duplicate-trailer": {
    "decodedLength": 149,
    "sha256": "7e4bd6caf4934a06bf9a7acd4bd7dafdd39ac8108182bad33a53e1b035252758",
    "trailerLength": 32,
    "grpcFrames": [
      {
        "marker": 0,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 107
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 128
      }
    ]
  },
  "sui-compressed-frame": {
    "decodedLength": 128,
    "sha256": "10b9d9e42cf1d7867c9fbc2585d3b0c78edc86cf9b337f2b4d416c08529a5b7d",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 1,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 107
      }
    ]
  },
  "sui-unknown-marker": {
    "decodedLength": 128,
    "sha256": "1185c4c71e904a667bf61ca3401bcf89d39524d0544189123c5b744594d68fd1",
    "trailerLength": 16,
    "grpcFrames": [
      {
        "marker": 2,
        "declaredLength": 102,
        "actualLength": 102,
        "offset": 0
      },
      {
        "marker": 128,
        "declaredLength": 16,
        "actualLength": 16,
        "offset": 107
      }
    ]
  }
});

export function computeFixtureDigest(value = fixture) {
  return digest(JSON.stringify({
    contractDigest: value.contractDigest,
    cases: canonicalFixtureCases(value.cases),
    suiGrpcWeb: canonicalFixtureSui(value.suiGrpcWeb),
    oracleGoldens: canonicalFixtureIdSet(value.oracleGoldens, "goldenId"),
    lifecycleSchedules: canonicalFixtureIdSet(value.lifecycleSchedules, "id"),
  }));
}

function validateTuple(value, label) {
  exactKeys(value, ["path", "sign", "coefficient", "exponent10"], label);
  text(value.path, `${label}.path`);
  if (![-1, 0, 1].includes(value.sign)) fail(`${label}.sign is invalid`);
  if (typeof value.coefficient !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.coefficient)) fail(`${label}.coefficient is not canonical`);
  if (typeof value.exponent10 !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value.exponent10)) fail(`${label}.exponent10 is not canonical`);
  if (value.sign === 0 && (value.coefficient !== "0" || value.exponent10 !== "0")) fail(`${label} zero tuple is not canonical`);
  if (value.sign !== 0 && (value.coefficient === "0" || value.coefficient.endsWith("0"))) fail(`${label} non-zero coefficient is not normalized`);
}

function validateExpected(value, label) {
  exactKeys(value, ["outcome", "trace", "endpointDiagnostic", "ioCount", "surface", "numericTuples", "binary"], label);
  exactKeys(value.outcome, ["kind"], `${label}.outcome`, ["value", "category", "message"]);
  if (!["success", "error", "not-applicable"].includes(value.outcome.kind)) fail(`${label}.outcome.kind is invalid`);
  if (value.outcome.kind === "error") {
    text(value.outcome.category, `${label}.outcome.category`);
    text(value.outcome.message, `${label}.outcome.message`);
  }
  exactKeys(value.trace, ["ioKind", "method", "target", "headers", "bodySha256", "attempts"], `${label}.trace`);
  if (!["performed", "none"].includes(value.trace.ioKind)) fail(`${label}.trace.ioKind is invalid`);
  text(value.trace.method, `${label}.trace.method`);
  if (typeof value.trace.target !== "string") fail(`${label}.trace.target must be a string`);
  if (!isRecord(value.trace.headers) || Object.keys(value.trace.headers).some((key) => typeof value.trace.headers[key] !== "string")) fail(`${label}.trace.headers must be a string map`);
  if (!/^[0-9a-f]{64}$/u.test(value.trace.bodySha256)) fail(`${label}.trace.bodySha256 must be SHA-256`);
  if (!Number.isInteger(value.trace.attempts) || value.trace.attempts < 0 || value.trace.attempts > 1) fail(`${label}.trace.attempts must be zero or one`);
  if (typeof value.endpointDiagnostic !== "string") fail(`${label}.endpointDiagnostic must be a string`);
  if (!Number.isInteger(value.ioCount) || value.ioCount < 0 || value.ioCount > 1) fail(`${label}.ioCount must be zero or one`);
  exactKeys(value.surface, ["allowed", "forbidden"], `${label}.surface`);
  for (const key of ["allowed", "forbidden"]) {
    if (!Array.isArray(value.surface[key]) || value.surface[key].some((item) => typeof item !== "string")) fail(`${label}.surface.${key} must be a string list`);
  }
  if (!Array.isArray(value.numericTuples)) fail(`${label}.numericTuples must be an array`);
  for (const tuple of value.numericTuples) validateTuple(tuple, `${label}.numericTuples`);
  if (value.binary !== null) {
    exactKeys(value.binary, ["encoding", "decodedLength", "sha256"], `${label}.binary`);
    if (!["base64", "hex"].includes(value.binary.encoding) || !Number.isInteger(value.binary.decodedLength) || value.binary.decodedLength < 0 || !/^[0-9a-f]{64}$/u.test(value.binary.sha256)) fail(`${label}.binary is invalid`);
  }
}

function validateSetup(value, label) {
  exactKeys(value, ["mode", "apiKey", "endpoint", "headers"], label);
  if (!["hosted", "direct", "unconfigured", "none"].includes(value.mode)) fail(`${label}.mode is invalid`);
  if (value.apiKey !== null && typeof value.apiKey !== "string") fail(`${label}.apiKey must be string or null`);
  if (value.endpoint !== null && typeof value.endpoint !== "string") fail(`${label}.endpoint must be string or null`);
  if (!isRecord(value.headers) || Object.keys(value.headers).some((key) => !/^[a-z0-9-]+$/u.test(key) || typeof value.headers[key] !== "string")) fail(`${label}.headers must be a lowercase string map`);
}

function validateCase(value, index, contract) {
  exactKeys(value, CASE_KEYS, `fixture.cases[${index}]`, ["scheduleId", "requestDescriptor"]);
  text(value.caseId, `fixture.cases[${index}].caseId`);
  if (value.scheduleId !== undefined) text(value.scheduleId, `${value.caseId}.scheduleId`);
  if (!Number.isInteger(value.cohort) || value.cohort < 0 || value.cohort > 5) fail(`${value.caseId}.cohort is invalid`);
  const network = contract.networks.find((entry) => entry.networkId === value.networkId);
  if (!network) fail(`${value.caseId} references unknown network ${value.networkId}`);
  if (value.cohort !== network.cohort) fail(`${value.caseId} cohort is detached from network ${value.networkId}`);
  const client = contract.clientContracts.find((entry) => entry.clientContractId === value.clientContractId);
  if (!client) fail(`${value.caseId} references unknown client ${value.clientContractId}`);
  if (network.clientContractId !== value.clientContractId) fail(`${value.caseId} client/network binding differs from contract`);
  if (!Array.isArray(value.exceptionIds) || value.exceptionIds.some((exceptionId) => typeof exceptionId !== "string")) fail(`${value.caseId}.exceptionIds must be a string list`);
  const exceptionMap = new Map(contract.compatibilityExceptions.map((exception) => [exception.exceptionId, exception]));
  for (const exceptionId of value.exceptionIds) {
    const exception = exceptionMap.get(exceptionId);
    const excludedLanguageBinding = ["rust-bitcoin-raw-batch-v1", "rust-bitcoin-decode-domain-v1"].includes(exceptionId) && !value.applicability.includes(exception.language);
    if (!exception || exception.clientContractId !== value.clientContractId || !exceptionAppliesToCase(value.caseId, value.scheduleId, exceptionId) || (!value.applicability.includes(exception.language) && !excludedLanguageBinding)) fail(`${value.caseId} exception ${exceptionId} is not bound to its language/client`);
  }
  if (value.exceptionIds.length === 0 && value.applicability.length !== LANGUAGES.length) fail(`${value.caseId} ordinary behavior must apply to all five languages`);
  if (value.exceptionIds.length > 0 && !FINITE_APPLICABILITY_PROBE_CASES.has(value.caseId)) {
    for (const language of LANGUAGES) if (!value.applicability.includes(language) && !value.exceptionIds.some((exceptionId) => contract.compatibilityExceptions.find((entry) => entry.exceptionId === exceptionId)?.language === language)) fail(`${value.caseId} omitted ${language} without an exact finite exception`);
  }
  if (value.clientContractId === "client-bitcoin-rpc" && !value.applicability.includes("rust") && !value.caseId.startsWith("c1-ruby-") && !value.caseId.startsWith("c1-typescript-")) {
    const allowedRustExclusions = new Set(["rust-bitcoin-raw-batch-v1", "rust-bitcoin-decode-domain-v1"]);
    if (!value.exceptionIds.some((exceptionId) => allowedRustExclusions.has(exceptionId))) fail(`${value.caseId} Rust exclusion is missing its finite approved exception`);
  }
  if (!Array.isArray(value.applicability) || value.applicability.length === 0 || value.applicability.some((language) => !LANGUAGES.includes(language)) || new Set(value.applicability).size !== value.applicability.length) fail(`${value.caseId}.applicability is invalid`);
  if (!["identity", "request-response", "surface", "transport", "error", "numeric", "binary", "resource-boundary"].includes(value.caseKind)) fail(`${value.caseId}.caseKind is invalid`);
  validateSetup(value.setup, `${value.caseId}.setup`);
  if (value.caseId === "c1-schedule-pre-cancel") {
    if (value.setup.mode !== "direct" || value.setup.endpoint !== "https://node.fixture.invalid/rpc" || value.setup.apiKey !== null || Object.keys(value.setup.headers).length !== 0) fail("c1-schedule-pre-cancel must bind the configured direct endpoint before cancellation");
    if (value.expected.endpointDiagnostic !== "https://node.fixture.invalid/") fail("c1-schedule-pre-cancel must retain the configured endpoint diagnostic");
  }
  if (value.caseId === "c1-unconfigured-namespace-fails-locally-with-zero-io") {
    if (value.setup.mode !== "unconfigured" || value.setup.endpoint !== null || value.setup.apiKey !== null || Object.keys(value.setup.headers).length !== 0) fail("c1-unconfigured-namespace-fails-locally-with-zero-io must retain the selected namespace as unconfigured");
    if (value.expected.endpointDiagnostic !== "") fail("c1-unconfigured-namespace-fails-locally-with-zero-io must have no endpoint diagnostic");
  }
  exactKeys(value.operation, ["publicOperation", "wireOperation", "params"], `${value.caseId}.operation`, ["publicOperations"]);
  text(value.operation.publicOperation, `${value.caseId}.operation.publicOperation`);
  text(value.operation.wireOperation, `${value.caseId}.operation.wireOperation`);
  if (!Array.isArray(value.operation.params) && !isRecord(value.operation.params)) fail(`${value.caseId}.operation.params must be an array or named object`);
  if (value.operation.publicOperations !== undefined) {
    exactKeys(value.operation.publicOperations, LANGUAGES, `${value.caseId}.operation.publicOperations`);
    for (const language of LANGUAGES) text(value.operation.publicOperations[language], `${value.caseId}.operation.publicOperations.${language}`);
  }
  const methodSet = contract.methodSets.find((entry) => entry.methodSetId === client.methodSetId);
  if (methodSet.kind === "expanded") {
    const capability = methodSet.capabilities.find((entry) => entry.wireOperation === value.operation.wireOperation);
    if (!capability && !(value.expected.ioCount === 0 && ["surface", "transport", "resource-boundary"].includes(value.caseKind))) fail(`${value.caseId} wire operation is not in the client method set`);
    if (capability) {
      const acceptedPublicNames = capability.publicNames ? Object.values(capability.publicNames) : [capability.publicOperation];
      if (!acceptedPublicNames.includes(value.operation.publicOperation) && value.operation.publicOperation !== capability.publicOperation) fail(`${value.caseId} public operation is not in the approved language map`);
      if (value.operation.publicOperations !== undefined) {
        for (const language of LANGUAGES) {
          const expectedPublicName = capability.publicNames?.[language] ?? capability.publicOperation;
          if (value.operation.publicOperations[language] !== expectedPublicName) fail(`${value.caseId} publicOperations.${language} differs from the wire-selected capability`);
        }
      }
      const expectedSurfaceAllowed = value.expected.surface?.allowed;
      if (value.expected.outcome?.value === "method coverage" && (!Array.isArray(expectedSurfaceAllowed) || expectedSurfaceAllowed.length !== 1 || expectedSurfaceAllowed[0] !== (capability.publicNames?.typescript ?? capability.publicOperation))) fail(`${value.caseId} singleton surface differs from the wire-selected capability`);
      if (capability.parameterShape === "none" && (!Array.isArray(value.operation.params) || value.operation.params.length !== 0)) fail(`${value.caseId} no-parameter method must send []`);
      if (capability.parameterShape === "positional" && !Array.isArray(value.operation.params)) fail(`${value.caseId} positional method must carry an array`);
      if (capability.parameterShape === "fixed-named" && !(isRecord(value.operation.params) || (Array.isArray(value.operation.params) && value.operation.params.length === 1 && isRecord(value.operation.params[0])))) fail(`${value.caseId} fixed-named method must carry one named object`);
    }
  }
  exactKeys(value.mockExchange, ["request", "response"], `${value.caseId}.mockExchange`);
  exactKeys(value.mockExchange.request, ["method", "target", "headers", "body"], `${value.caseId}.mockExchange.request`, ["bodyEncoding", "bodySha256"]);
  if (value.mockExchange.request.method !== "POST") fail(`${value.caseId} request method must be POST`);
  text(value.mockExchange.request.target, `${value.caseId}.mockExchange.request.target`);
  text(value.mockExchange.request.body, `${value.caseId}.mockExchange.request.body`);
  if (value.mockExchange.request.bodyEncoding !== undefined && !["json", "hex", "descriptor"].includes(value.mockExchange.request.bodyEncoding)) fail(`${value.caseId}.request.bodyEncoding is invalid`);
  if (value.mockExchange.request.bodyEncoding === "hex" && !/^[0-9a-f]*$/u.test(value.mockExchange.request.body)) fail(`${value.caseId}.request hex body must be lowercase hex`);
  if (value.requestDescriptor !== undefined) {
    exactKeys(value.requestDescriptor, ["kind"], `${value.caseId}.requestDescriptor`, ["oracleGoldenId", "descriptor", "chunkPlan", "measurement"]);
    if (value.requestDescriptor.kind === "oracle-ref-v1") { exactKeys(value.requestDescriptor, ["kind", "oracleGoldenId"], `${value.caseId}.requestDescriptor`); if (value.mockExchange.request.bodyEncoding !== "descriptor" || value.mockExchange.request.body !== value.requestDescriptor.oracleGoldenId) fail(`${value.caseId} oracle request source is not bound to its body reference`); }
    else if (value.requestDescriptor.kind === "inline-v1") { exactKeys(value.requestDescriptor, ["kind", "descriptor", "chunkPlan", "measurement"], `${value.caseId}.requestDescriptor`); if (!["json", "hex"].includes(value.mockExchange.request.bodyEncoding)) fail(`${value.caseId} inline request source must use JSON or hex bytes`); validateDescriptorShape(value.requestDescriptor.descriptor); validateChunkPlanShape(value.requestDescriptor.chunkPlan, value.requestDescriptor.measurement.decodedLength); }
    else fail(`${value.caseId}.requestDescriptor.kind is invalid`);
  } else if (value.mockExchange.request.bodyEncoding === "descriptor") fail(`${value.caseId} descriptor request is missing requestDescriptor`);
  if (!isRecord(value.mockExchange.request.headers) || Object.keys(value.mockExchange.request.headers).some((key) => typeof value.mockExchange.request.headers[key] !== "string")) fail(`${value.caseId}.mockExchange.request.headers must be a string map`);
  exactKeys(value.mockExchange.response, ["status", "headers", "body"], `${value.caseId}.mockExchange.response`, ["bodyEncoding"]);
  if (!Number.isInteger(value.mockExchange.response.status) || value.mockExchange.response.status < 100 || value.mockExchange.response.status > 599) fail(`${value.caseId}.mockExchange.response.status is invalid`);
  text(value.mockExchange.response.body, `${value.caseId}.mockExchange.response.body`);
  if (value.mockExchange.response.bodyEncoding !== undefined && !["json", "hex", "descriptor"].includes(value.mockExchange.response.bodyEncoding)) fail(`${value.caseId}.response.bodyEncoding is invalid`);
  if (value.mockExchange.response.bodyEncoding === "hex" && !/^[0-9a-f]*$/u.test(value.mockExchange.response.body)) fail(`${value.caseId}.response hex body must be lowercase hex`);
  if (!isRecord(value.mockExchange.response.headers) || Object.keys(value.mockExchange.response.headers).some((key) => typeof value.mockExchange.response.headers[key] !== "string")) fail(`${value.caseId}.mockExchange.response.headers must be a string map`);
  if (value.setup.mode === "hosted" && value.mockExchange.request.bodyEncoding === "json") {
    const bitcoinHosted = client.clientContractId === "client-bitcoin-rpc";
    const hasQuery = /[?&]api-key=/u.test(value.mockExchange.request.target);
    if (bitcoinHosted && hasQuery) fail(`${value.caseId} Bitcoin hosted request must not use api-key query auth`);
    if (!bitcoinHosted && !hasQuery) fail(`${value.caseId} hosted JSON-RPC request is missing api-key query auth`);
    if (bitcoinHosted && value.mockExchange.request.headers.authorization !== "Bearer fixture-api-key") fail(`${value.caseId} Bitcoin hosted request must use Bearer auth`);
  }
  if (value.setup.mode === "direct") {
    if (value.mockExchange.request.bodyEncoding === "json" && value.mockExchange.request.target !== value.setup.endpoint) fail(`${value.caseId} direct JSON target does not preserve the configured endpoint exactly`);
    if (/[?&]api-key=/u.test(value.mockExchange.request.target)) fail(`${value.caseId} direct request leaked hosted api-key query auth`);
    if (value.mockExchange.request.bodyEncoding === "hex" && !value.mockExchange.request.target.includes(value.operation.wireOperation)) fail(`${value.caseId} direct binary target does not append the selected method path`);
  }
  if (value.clientContractId === "client-sui-grpc" && SUI_QUERY_HEADER_CASES.has(value.caseId)) {
    if (value.setup.mode !== "direct" || value.setup.apiKey !== null || value.setup.endpoint !== "https://sui.fixture.invalid/prefix?fixture=1" || Object.keys(value.setup.headers).length !== 1 || value.setup.headers["x-fixture-scoped"] !== "fixture-header") fail(`${value.caseId} Sui setup must bind the approved direct query and exactly the scoped fixture header`);
    const configured = new URL(value.setup.endpoint); const basePath = configured.pathname.endsWith("/") ? configured.pathname.slice(0, -1) : configured.pathname; const operationPath = value.operation.wireOperation.startsWith("/") ? value.operation.wireOperation : `/${value.operation.wireOperation}`; const expectedTarget = `${configured.origin}${basePath}${operationPath}${configured.search}`;
    if (value.mockExchange.request.target !== expectedTarget) fail(`${value.caseId} Sui target does not preserve setup query and append exactly one method path`);
    for (const [header, headerValue] of Object.entries(value.setup.headers)) if (value.mockExchange.request.headers[header] !== headerValue) fail(`${value.caseId} Sui request header ${header} does not match setup`);
  }
  validateExpected(value.expected, `${value.caseId}.expected`);
  if (value.caseId === "btc-error-data-lossless-redaction") {
    if (value.setup.headers["x-fixture-scoped"] !== "fixture-secret" || value.mockExchange.request.headers["x-fixture-scoped"] !== "fixture-secret" || value.expected.trace.headers["x-fixture-scoped"] !== "<redacted>") fail(`${value.caseId} scoped secret binding is incomplete`);
    if (value.responseDescriptor?.kind !== "oracle-ref-v1" || value.responseDescriptor.oracleGoldenId !== "btc-error-data-exact") fail(`${value.caseId} must retain the exact approved error-data golden`);
    if (stableJson(value.expected.numericTuples) !== stableJson([{ path: "$.error.data.large", sign: 1, coefficient: "9007199254740993", exponent10: "0" }, { path: "$.error.data.fraction", sign: 1, coefficient: "1", exponent10: "-8" }])) fail(`${value.caseId} numeric tuples differ from the approved error-data binding`);
  }
  exactKeys(value.responseDescriptor, ["kind"], `${value.caseId}.responseDescriptor`, ["oracleGoldenId", "descriptor", "chunkPlan", "measurement"]);
  if (value.responseDescriptor.kind === "oracle-ref-v1") {
    exactKeys(value.responseDescriptor, ["kind", "oracleGoldenId"], `${value.caseId}.responseDescriptor`);
    if (value.mockExchange.response.bodyEncoding !== "descriptor") fail(`${value.caseId} oracle response must use descriptor body encoding`);
    if (value.mockExchange.response.body !== value.responseDescriptor.oracleGoldenId) fail(`${value.caseId} oracle response body must name its golden`);
    text(value.responseDescriptor.oracleGoldenId, `${value.caseId}.responseDescriptor.oracleGoldenId`);
  } else if (value.responseDescriptor.kind === "inline-v1") {
    exactKeys(value.responseDescriptor, ["kind", "descriptor", "chunkPlan", "measurement"], `${value.caseId}.responseDescriptor`);
    if (!["json", "hex"].includes(value.mockExchange.response.bodyEncoding)) fail(`${value.caseId} inline response must carry actual JSON or hex bytes`);
    validateDescriptorShape(value.responseDescriptor.descriptor); validateChunkPlanShape(value.responseDescriptor.chunkPlan, value.responseDescriptor.measurement.decodedLength);
  } else fail(`${value.caseId}.responseDescriptor.kind is invalid`);
  const io = value.expected.ioCount === 1;
  if (io) {
    if (value.mockExchange.request.bodyEncoding === "descriptor") { /* resolved and hashed in validateFixtures after the golden table is available */ }
    const bodyBytes = value.mockExchange.request.bodyEncoding === "hex" ? Buffer.from(value.mockExchange.request.body, "hex") : value.mockExchange.request.bodyEncoding === "json" ? Buffer.from(value.mockExchange.request.body, "utf8") : null;
    if (bodyBytes === null) { if (!value.requestDescriptor || value.requestDescriptor.kind !== "oracle-ref-v1") fail(`${value.caseId} descriptor request source is not resolvable`); }
    if (bodyBytes === null) return;
    const bodyDigest = digest(bodyBytes);
    if (value.expected.trace.bodySha256 !== bodyDigest) fail(`${value.caseId} expected trace hash does not match request bytes`);
    if (value.mockExchange.request.bodySha256 !== undefined && value.mockExchange.request.bodySha256 !== bodyDigest) fail(`${value.caseId} request bodySha256 does not match request bytes`);
    if (value.expected.trace.ioKind !== "performed" || value.expected.trace.target === "NO_IO") fail(`${value.caseId} performed I/O has no performed trace`);
    if (value.expected.trace.method !== value.mockExchange.request.method || value.expected.trace.attempts !== 1) fail(`${value.caseId} performed trace method/attempt count differs from request`);
    const requestUrl = new URL(value.mockExchange.request.target); const traceUrl = new URL(value.expected.trace.target); if (requestUrl.origin !== traceUrl.origin || (requestUrl.pathname !== traceUrl.pathname && !traceUrl.pathname.includes("<redacted>") && !traceUrl.pathname.includes("%3Credacted%3E"))) fail(`${value.caseId} trace target is detached from request target`);
    for (const [key, headerValue] of Object.entries(value.expected.trace.headers)) if (!Object.hasOwn(value.mockExchange.request.headers, key) || (headerValue !== value.mockExchange.request.headers[key] && headerValue !== "<redacted>")) fail(`${value.caseId} trace header ${key} is detached from request headers`);
  } else if (value.expected.trace.ioKind !== "none" || value.expected.trace.target !== "NO_IO" || value.expected.trace.attempts !== 0) fail(`${value.caseId} no-I/O trace is not explicit`);
  if (value.expected.outcome.kind === "success" && value.mockExchange.response.status !== 200) fail(`${value.caseId} successful outcome requires HTTP 200`);
  if (io && value.mockExchange.request.bodyEncoding === "json" && value.mockExchange.response.bodyEncoding === "json") {
    try {
      const request = JSON.parse(value.mockExchange.request.body);
      const response = JSON.parse(value.mockExchange.response.body);
      if (request.method !== value.operation.wireOperation) fail(`${value.caseId} request method differs from operation`);
      if (JSON.stringify(request.params) !== JSON.stringify(value.operation.params)) fail(`${value.caseId} request params differ from operation`);
      if (value.expected.outcome.kind === "success" && response.id !== request.id) fail(`${value.caseId} successful response id differs from request id`);
      if (value.expected.outcome.kind === "success" && value.clientContractId !== "client-bitcoin-rpc" && Object.hasOwn(response, "error")) fail(`${value.caseId} non-Bitcoin JSON-RPC success must omit error`);
      if (value.caseKind === "error" && value.caseId.includes("response-id") && response.id === request.id) fail(`${value.caseId} wrong-id negative is not wrong`);
      if (value.caseId === "c1-path-query-header-and-api-key-redaction") {
        if (request.id !== 15 || response.id !== 15 || !isRecord(response.error) || response.error.code !== -32000 || Object.hasOwn(response, "result")) fail(`${value.caseId} must bind matching-ID JSON-RPC error code -32000`);
        if (response.error.message !== "credential probe: %66oo foo fixture-secret Bearer fixture-secret") fail(`${value.caseId} error message differs from the approved credential probe`);
        if (stableJson(response.error.data) !== stableJson({ encodedPath: "%66oo", decodedPath: "foo", query: "fixture-secret", header: "Bearer fixture-secret", "%66oo": "fixture-secret", count: 7, fraction: 0.5 })) fail(`${value.caseId} error data differs from the approved credential probe`);
        if (stableJson(value.expected.numericTuples) !== stableJson([{ path: "$.error.data.count", sign: 1, coefficient: "7", exponent10: "0" }, { path: "$.error.data.fraction", sign: 1, coefficient: "5", exponent10: "-1" }])) fail(`${value.caseId} numeric tuples differ from the approved credential probe`);
      }
    } catch (error) {
      if (value.caseKind !== "error" && value.caseKind !== "numeric" && value.caseKind !== "resource-boundary") fail(`${value.caseId} JSON exchange is malformed: ${error.message}`);
    }
  }
  if (value.expected.binary !== null && value.mockExchange.response.bodyEncoding === "hex") {
    const responseBytes = Buffer.from(value.mockExchange.response.body, "hex");
    if (responseBytes.length !== value.expected.binary.decodedLength || digest(responseBytes) !== value.expected.binary.sha256) fail(`${value.caseId} binary projection does not match response bytes`);
  }
}

export function validateFixtures(value = fixture, contract = CONTRACT) {
  validateContract(contract);
  if (value === fixture) { if (!FIXTURE_SCHEMA_VALIDATION_CACHE.has(value)) { validateFixtureSchema(value); FIXTURE_SCHEMA_VALIDATION_CACHE.add(value); } } else validateFixtureSchema(value);
  exactKeys(value, FIXTURE_KEYS, "rpc-chain-contract-cases");
  if (value.schemaVersion !== 1 || value.fixtureKind !== "rpc-chain-contract-cases" || value.contractVersion !== contract.contractVersion) fail("fixture header differs from the contract");
  if (value.contractDigest !== contract.contentDigest) fail("fixture contractDigest differs from canonical contract");
  if (!/^[0-9a-f]{64}$/u.test(value.fixtureDigest)) fail("fixtureDigest must be lowercase SHA-256");
  if (!Array.isArray(value.cases) || value.cases.length < 20) fail("fixture must contain the complete portable case set");
  const ids = new Set();
  for (const entry of value.cases) {
    if (ids.has(entry.caseId)) fail(`duplicate fixture case ${entry.caseId}`);
    ids.add(entry.caseId);
  }
  const approvedCaseIds = Object.keys(APPROVED_CASE_RELATIONS);
  const missingApprovedCase = approvedCaseIds.find((caseId) => !ids.has(caseId));
  if (missingApprovedCase !== undefined) fail(`fixture is missing approved relational case ${missingApprovedCase}`);
  const unknownCase = [...ids].find((caseId) => !Object.hasOwn(APPROVED_CASE_RELATIONS, caseId));
  if (unknownCase !== undefined) fail(`${unknownCase} is not an approved relational case`);
  if (ids.size !== approvedCaseIds.length) fail("fixture case ID set differs from approved relational case set");
  for (let index = 0; index < value.cases.length; index += 1) {
    validateCase(value.cases[index], index, contract);
  }
  if (!isRecord(value.suiGrpcWeb) || value.suiGrpcWeb.contentType !== "application/grpc-web+proto" || !Array.isArray(value.suiGrpcWeb.methodPaths) || value.suiGrpcWeb.methodPaths.length !== 3) fail("suiGrpcWeb canonical wire section is incomplete");
  const suiMethodSet = contract.methodSets.find((methodSet) => methodSet.methodSetId === contract.clientContracts.find((client) => client.clientContractId === "client-sui-grpc").methodSetId);
  const expectedSuiPaths = suiMethodSet.capabilities.map((capability) => capability.wireOperation);
  if (stableJson(value.suiGrpcWeb.methodPaths) !== stableJson(expectedSuiPaths)) fail("suiGrpcWeb methodPaths differ from the closed contract");
  if (stableJson(value.suiGrpcWeb.limits) !== stableJson({ requestBytes: 1048576, responseBytes: 8388608, trailerBytes: 8192, recursionDepth: 100 })) fail("suiGrpcWeb limits differ from the closed contract");
  const expectedSuiGoldens = new Map([
    ["sui-get-service-info-request-frame", ["sui-get-service-info-request-frame", "sui-get-service-info-response-body"]],
    ["sui-get-object-version-zero-request-frame", ["sui-get-object-version-zero-request-frame", "sui-get-object-response-body"]],
    ["sui-get-object-version-absent-request-frame", ["sui-get-object-version-absent-request-frame", "sui-get-object-response-body"]],
    ["sui-get-balance-request-frame", ["sui-get-balance-request-frame", "sui-get-balance-response-body"]],
    ["sui-get-object-embedded-depth100", ["sui-get-object-version-absent-request-frame", "sui-get-object-embedded-depth100"]],
    ["sui-get-object-embedded-depth101", ["sui-get-object-version-absent-request-frame", "sui-get-object-embedded-depth101"]],
    ["sui-get-service-info-timestamp-merge-final-zero", ["sui-get-service-info-request-frame", "sui-get-service-info-timestamp-merge-final-zero"]],
    ["sui-get-service-info-timestamp-merge-final-invalid", ["sui-get-service-info-request-frame", "sui-get-service-info-timestamp-merge-final-invalid"]],
  ]);
  if (!Array.isArray(value.suiGrpcWeb.golden) || value.suiGrpcWeb.golden.length !== expectedSuiGoldens.size) fail("suiGrpcWeb golden vector set is incomplete");
  const sideGoldens = new Map(value.suiGrpcWeb.golden.map((entry) => [entry.id, entry]));
  for (const [id, [requestId, responseId]] of expectedSuiGoldens) { const side = sideGoldens.get(id); const requestGolden = value.oracleGoldens.find((golden) => golden.goldenId === requestId); const responseGolden = value.oracleGoldens.find((golden) => golden.goldenId === responseId); if (!side || !requestGolden || !responseGolden) fail(`suiGrpcWeb golden ${id} is detached from its approved vectors`); const requestHex = requestGolden.descriptor.encoding === "hex" ? requestGolden.descriptor.value : Buffer.from(requestGolden.descriptor.value, "utf8").toString("hex"); const responseHex = responseGolden.descriptor.encoding === "hex" ? responseGolden.descriptor.value : Buffer.from(responseGolden.descriptor.value, "utf8").toString("hex"); if (side.requestFrameHex !== requestHex || side.responseBodyHex !== responseHex) fail(`suiGrpcWeb golden ${id} bytes differ from approved vectors`); }
  for (const [id, approved] of Object.entries(APPROVED_SUI_RELATIONS.golden)) { const current = sideGoldens.get(id); if (!current || stableJson(current) !== stableJson(approved)) fail(`suiGrpcWeb golden ${id} semantic tuple differs from its approved binding`); }
  const boundaryIds = new Set();
  const framingIds = new Set();
  if (!Array.isArray(value.suiGrpcWeb.boundaryCases) || value.suiGrpcWeb.boundaryCases.length !== 6) fail("sui boundaryCases must contain six concrete boundary inputs");
  if (!Array.isArray(value.suiGrpcWeb.framingCases) || value.suiGrpcWeb.framingCases.length !== 7) fail("sui framingCases must contain seven concrete frame mutations");
  const goldenByIdForSui = new Map((Array.isArray(value.oracleGoldens) ? value.oracleGoldens : []).map((golden) => [golden.goldenId, golden]));
  for (const boundary of value.suiGrpcWeb.boundaryCases) {
    exactKeys(boundary, ["id", "direction", "size", "outcome", "oracleGoldenId"], "suiGrpcWeb.boundaryCase");
    text(boundary.id, "suiGrpcWeb.boundaryCase.id"); if (boundaryIds.has(boundary.id)) fail(`duplicate Sui boundary ${boundary.id}`); boundaryIds.add(boundary.id);
    if (!["request", "response", "trailer"].includes(boundary.direction)) fail(`${boundary.id} Sui boundary direction is invalid`); safeInteger(boundary.size, `${boundary.id}.size`, DESCRIPTOR_LIMITS.maxSuiResponseBytes); text(boundary.outcome, `${boundary.id}.outcome`);
    const golden = goldenByIdForSui.get(boundary.oracleGoldenId); if (!golden || golden.family !== "sui-grpc-web") fail(`${boundary.id} boundary oracle reference is invalid`); const measuredSize = boundary.direction === "trailer" ? golden.measurement.trailerLength : golden.measurement.decodedLength; if (measuredSize !== boundary.size) fail(`${boundary.id} boundary size differs from measured oracle`);
    const approved = APPROVED_SUI_RELATIONS.boundaryCases[boundary.id]; if (!approved || stableJson(boundary) !== stableJson(approved)) fail(`${boundary.id} semantic boundary tuple differs from its approved binding`);
  }
  for (const framing of value.suiGrpcWeb.framingCases) {
    exactKeys(framing, ["id", "outcome", "descriptor", "chunkPlan", "measurement"], "suiGrpcWeb.framingCase");
    text(framing.id, "suiGrpcWeb.framingCase.id"); if (framingIds.has(framing.id)) fail(`duplicate Sui framing case ${framing.id}`); framingIds.add(framing.id); text(framing.outcome, `${framing.id}.outcome`);
    validateDescriptorShape(framing.descriptor); validateChunkPlanShape(framing.chunkPlan, framing.measurement.decodedLength);
    const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(framing.descriptor), framing.chunkPlan, framing.measurement.decodedLength), "sui-grpc-web");
    validateDescriptorOracle(framing.id, measured, framing.measurement);
    const approved = APPROVED_SUI_RELATIONS.framingCases[framing.id]; if (!approved || stableJson({ id: framing.id, outcome: framing.outcome, descriptorSha256: framing.descriptor.sha256, measurement: framing.measurement, chunkPlan: framing.chunkPlan }) !== stableJson(approved)) fail(`${framing.id} semantic framing tuple differs from its approved binding`);
  }
  if (!Array.isArray(value.lifecycleSchedules) || value.lifecycleSchedules.length !== 8) fail("lifecycleSchedules must contain the eight approved schedules");
  const scheduleKinds = new Set();
  for (const schedule of value.lifecycleSchedules) {
    exactKeys(schedule, ["id", "kind", "timeoutMs", "delayMs", "expectedCalls", "expectedDestinationCalls", "expectedAttempts", "bodyClosed", "connectionClosed", "outcome"], "lifecycleSchedule", ["barrier"]);
    text(schedule.id, "lifecycleSchedule.id"); if (scheduleKinds.has(schedule.kind)) fail(`duplicate lifecycle schedule kind ${schedule.kind}`); scheduleKinds.add(schedule.kind);
    if (!["immediate-response", "redirect-to-second-server", "withhold-headers", "first-chunk-then-delay", "pre-cancel", "first-chunk-cancellation-barrier", "reset-before-headers", "reset-after-first-chunk"].includes(schedule.kind)) fail(`${schedule.id} schedule kind is invalid`); for (const key of ["timeoutMs", "delayMs", "expectedCalls", "expectedDestinationCalls", "expectedAttempts"]) safeInteger(schedule[key], `${schedule.id}.${key}`, 1000000); if (typeof schedule.bodyClosed !== "boolean" || typeof schedule.connectionClosed !== "boolean") fail(`${schedule.id} close flags must be boolean`); text(schedule.outcome, `${schedule.id}.outcome`);
    if (["withhold-headers", "first-chunk-then-delay"].includes(schedule.kind) && (schedule.timeoutMs !== 40 || schedule.delayMs < 250)) fail(`${schedule.id} delay schedule must bind the 40ms/250ms timing contract`);
    if (schedule.kind === "first-chunk-cancellation-barrier") { exactKeys(schedule.barrier, ["firstChunkSignal", "cancelObserved", "release"], `${schedule.id}.barrier`); for (const key of ["firstChunkSignal", "cancelObserved", "release"]) text(schedule.barrier[key], `${schedule.id}.barrier.${key}`); } else if (schedule.barrier !== undefined) fail(`${schedule.id} non-barrier schedule cannot carry barrier fields`);
    const approved = APPROVED_SUI_RELATIONS.lifecycleSchedules[schedule.id]; if (!approved || stableJson(schedule) !== stableJson(approved)) fail(`${schedule.id} lifecycle tuple differs from its approved binding`);
  }
  if (scheduleKinds.size !== 8) fail("lifecycleSchedules must cover each closed schedule kind exactly once");
  if (!Array.isArray(value.oracleGoldens) || value.oracleGoldens.length !== 56) fail("oracleGoldens must contain the 56 approved independent measurements");
  const measureCanonicalOracles = value !== fixture || !FIXTURE_ORACLE_VALIDATION_CACHE.has(value.oracleGoldens);
  const goldenIds = new Set();
  for (const golden of value.oracleGoldens) {
    exactKeys(golden, ["goldenId", "family", "descriptor", "chunkPlan", "measurement", "outcome"], "oracleGolden");
    text(golden.goldenId, "oracleGolden.goldenId"); if (goldenIds.has(golden.goldenId)) fail(`duplicate oracle golden ${golden.goldenId}`); goldenIds.add(golden.goldenId);
    if (!["bitcoin-json", "sui-grpc-web", "lifecycle"].includes(golden.family)) fail(`${golden.goldenId} oracle family is invalid`);
    validateDescriptorShape(golden.descriptor); validateChunkPlanShape(golden.chunkPlan, golden.measurement.decodedLength);
    if (!isRecord(golden.measurement) || !Number.isSafeInteger(golden.measurement.decodedLength) || !/^[0-9a-f]{64}$/u.test(golden.measurement.sha256)) fail(`${golden.goldenId} measurement is invalid`);
    validateGoldenMeasurement(golden);
    if (measureCanonicalOracles) {
      const measuredGolden = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(golden.descriptor), golden.chunkPlan, golden.measurement.decodedLength), golden.family);
      validateDescriptorOracle(golden.goldenId, measuredGolden, golden.measurement);
    }
    if (!isRecord(golden.outcome) || typeof golden.outcome.kind !== "string") fail(`${golden.goldenId} outcome is invalid`);
  }
  if (measureCanonicalOracles && value === fixture) FIXTURE_ORACLE_VALIDATION_CACHE.add(value.oracleGoldens);
  const goldenById = new Map(value.oracleGoldens.map((golden) => [golden.goldenId, golden]));
  const scheduleById = new Map(value.lifecycleSchedules.map((schedule) => [schedule.id, schedule]));
  const referencedSchedules = new Set();
  for (const entry of value.cases) {
    if (entry.expected.binary !== null) {
      const resolved = entry.responseDescriptor.kind === "oracle-ref-v1" ? goldenById.get(entry.responseDescriptor.oracleGoldenId)?.measurement : entry.responseDescriptor.measurement;
      if (!resolved || entry.expected.binary.decodedLength !== resolved.decodedLength || entry.expected.binary.sha256 !== resolved.sha256) fail(`${entry.caseId} expected binary projection does not match its resolved response source measurement`);
    }
    const approvedCaseRelation = APPROVED_CASE_RELATIONS[entry.caseId]; if (approvedCaseRelation === undefined) fail(`${entry.caseId} is not an approved relational case`); if (stableJson(caseRelationProjection(entry)) !== stableJson(approvedCaseRelation)) fail(`${entry.caseId} relational tuple differs from its approved case binding`);
    if (entry.scheduleId !== undefined) {
      const schedule = scheduleById.get(entry.scheduleId); if (!schedule) fail(`${entry.caseId} references unknown lifecycle schedule ${entry.scheduleId}`); if (referencedSchedules.has(entry.scheduleId)) fail(`lifecycle schedule ${entry.scheduleId} is referenced more than once`); referencedSchedules.add(entry.scheduleId);
      if (entry.expected.trace.attempts !== schedule.expectedAttempts || entry.expected.ioCount !== Math.min(1, schedule.expectedCalls)) fail(`${entry.caseId} schedule counters differ from ${entry.scheduleId}`);
    }
    if (entry.caseKind === "binary" && /\/prefix\/\/sui\./u.test(entry.mockExchange.request.target)) fail(`${entry.caseId} has a double-slash Sui target`);
    if (entry.mockExchange.response.bodyEncoding === "json" && /"vector"\s*:/u.test(entry.mockExchange.response.body)) fail(`${entry.caseId} retains a vector-label response body`);
    if (entry.requestDescriptor !== undefined) {
      if (entry.requestDescriptor.kind === "oracle-ref-v1") {
        const requestGolden = goldenById.get(entry.requestDescriptor.oracleGoldenId); if (!requestGolden || entry.mockExchange.request.bodyEncoding !== "descriptor" || entry.mockExchange.request.body !== entry.requestDescriptor.oracleGoldenId) fail(`${entry.caseId} request descriptor reference is not bound to an oracle golden`);
        if (entry.expected.ioCount === 1 && (entry.expected.trace.bodySha256 !== requestGolden.measurement.sha256 || entry.mockExchange.request.bodySha256 !== requestGolden.measurement.sha256)) fail(`${entry.caseId} request oracle hash does not match the supplied bytes`);
        if (entry.requestDescriptor.oracleGoldenId === "sui-request-bytes-inclusive" && (entry.expected.outcome.kind !== "success" || entry.expected.ioCount !== 1 || entry.expected.trace.attempts !== 1)) fail(`${entry.caseId} exact 1 MiB Sui request must perform one successful POST`);
        if (entry.requestDescriptor.oracleGoldenId === "sui-request-bytes-over" && (entry.expected.outcome.kind !== "error" || entry.expected.outcome.category !== "config" || entry.expected.ioCount !== 0 || entry.expected.trace.attempts !== 0)) fail(`${entry.caseId} one-over Sui request must be a zero-I/O config error`);
      } else {
        const requestFamily = entry.networkId === "rpc-sui-mainnet" ? "sui-grpc-web" : "bitcoin-json";
        const expectedRequest = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(entry.requestDescriptor.descriptor), entry.requestDescriptor.chunkPlan, entry.requestDescriptor.measurement.decodedLength), requestFamily);
        validateDescriptorOracle(`${entry.caseId}.request`, expectedRequest, entry.requestDescriptor.measurement);
        const requestBytes = entry.mockExchange.request.bodyEncoding === "hex" ? Buffer.from(entry.mockExchange.request.body, "hex") : Buffer.from(entry.mockExchange.request.body, "utf8");
        const actualRequest = measureExpandedChunks([requestBytes], requestFamily); if (actualRequest.sha256 !== expectedRequest.sha256 || actualRequest.decodedLength !== expectedRequest.decodedLength) fail(`${entry.caseId} inline request source is detached from supplied bytes`);
      }
    }
    if (entry.responseDescriptor === undefined) fail(`${entry.caseId} is missing a bounded response descriptor reference`);
    if (entry.responseDescriptor.kind === "oracle-ref-v1") {
      const golden = goldenById.get(entry.responseDescriptor.oracleGoldenId);
      if (!golden || entry.mockExchange.response.bodyEncoding !== "descriptor" || entry.mockExchange.response.body !== entry.responseDescriptor.oracleGoldenId) fail(`${entry.caseId} response descriptor reference is not bound to an oracle golden`);
      if (entry.mockExchange.response.status !== 200) fail(`${entry.caseId} oracle response status must be HTTP 200 for local byte validation`);
      const approvedLegacyUtf8Replacement = entry.caseId === "btc-rust-legacy-utf8-replacement" && entry.responseDescriptor.oracleGoldenId === "btc-invalid-utf8" && entry.clientContractId === "client-bitcoin-rpc" && entry.applicability.length === 1 && entry.applicability[0] === "rust" && entry.exceptionIds.length === 1 && entry.exceptionIds[0] === "rust-bitcoin-decode-domain-v1";
      if (golden && entry.expected.outcome.kind !== golden.outcome.kind && !approvedLegacyUtf8Replacement) fail(`${entry.caseId} expected outcome kind differs from its approved golden`);
      if (approvedLegacyUtf8Replacement && (entry.expected.outcome.kind !== "success" || entry.expected.outcome.value !== "\uFFFD" || entry.expected.ioCount !== 1 || entry.expected.trace.attempts !== 1)) fail(`${entry.caseId} legacy UTF-8 replacement binding is not exact`);
      if (golden?.outcome.kind === "error" && entry.expected.outcome.category !== golden.outcome.category && !approvedLegacyUtf8Replacement) fail(`${entry.caseId} expected error category differs from its approved golden`);
      if (golden?.family === "bitcoin-json" && entry.mockExchange.request.bodyEncoding === "json") {
        let request; try { request = JSON.parse(entry.mockExchange.request.body); } catch { fail(`${entry.caseId} Bitcoin oracle request is not JSON`); }
        if (request.id !== 1) fail(`${entry.caseId} Bitcoin oracle request ID must match the fixed raw body ID 1`);
      }
      if (entry.expected.ioCount === 1 && entry.expected.trace.bodySha256 === "0".repeat(64)) fail(`${entry.caseId} performed trace cannot use a placeholder hash`);
    } else {
      const family = entry.caseKind === "binary" ? "sui-grpc-web" : "bitcoin-json";
      const measured = measureExpandedChunks(applyChunkPlan(expandDescriptorChunks(entry.responseDescriptor.descriptor), entry.responseDescriptor.chunkPlan, entry.responseDescriptor.measurement.decodedLength), family);
      validateDescriptorOracle(entry.caseId, measured, entry.responseDescriptor.measurement);
      const actualBytes = entry.mockExchange.response.bodyEncoding === "hex" ? Buffer.from(entry.mockExchange.response.body, "hex") : Buffer.from(entry.mockExchange.response.body, "utf8");
      const actual = measureExpandedChunks([actualBytes], family);
      validateDescriptorOracle(`${entry.caseId}.response`, actual, entry.responseDescriptor.measurement);
    }
  }
  if (referencedSchedules.size !== 8) fail(`fixture must attach all eight lifecycle schedules; found ${referencedSchedules.size}`);
  if (!value.cases.some((entry) => entry.responseDescriptor?.kind === "oracle-ref-v1" && entry.responseDescriptor.oracleGoldenId === "btc-null-gettxout" && entry.operation.wireOperation === "gettxout")) fail("fixture is missing the matching-ID nullable gettxout case");
  for (const network of contract.networks) if (!value.cases.some((item) => item.networkId === network.networkId)) fail(`fixture is missing executable target cases for ${network.networkId}`);
  const required = [
    "c1-hosted-bitcoin-bearer-no-query-null-error", "c1-direct-bitcoin-exact-target-scoped-header-keyless", "c1-bitcoin-twelve-named-methods-and-result-shapes", "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values", "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription", "c1-rust-bitcoin-legacy-raw-batch-remains", "c1-hosted-base-root-query-auth", "c1-direct-base-exact-target-scoped-header-origin-only-diagnostic", "c1-hosted-arbitrum-root-and-edge-no-duplicate-suffix", "c1-direct-arbitrum-exact-target-scoped-header-origin-only-diagnostic", "c1-sealed-evm-three-method-payloads-and-no-escape-hatches", "c1-unconfigured-namespace-fails-locally-with-zero-io", "c1-one-attempt-no-redirect-timeout-and-cancellation", "c1-response-id-http-jsonrpc-and-malformed-response-errors", "c1-path-query-header-and-api-key-redaction", "c1-existing-ethereum-solana-avalanche-and-typescript-base-regression",
  ];
  for (const caseId of required) if (!ids.has(caseId)) fail(`missing accepted C1 fixture ${caseId}`);
  if (computeFixtureDigest(value) !== value.fixtureDigest) fail(`fixtureDigest mismatch: expected ${computeFixtureDigest(value)}`);
  return true;
}

function validateChunkPlanShape(plan, decodedLength) {
  if (!isRecord(plan) || !CHUNK_PLAN_KINDS.has(plan.kind)) fail("chunk plan kind is not approved");
  safeInteger(decodedLength, "chunk plan decodedLength", DESCRIPTOR_LIMITS.maxDecodedBytes);
  if (plan.kind === "single-v1") { if (decodedLength > DESCRIPTOR_LIMITS.maxChunkBytes) fail("single chunk plan exceeds 64 KiB"); return true; }
  if (plan.kind === "fixed-v1") { safeInteger(plan.chunkBytes, "fixed chunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes); if (plan.chunkBytes < 1) fail("fixed chunkBytes must be positive"); return true; }
  if (plan.kind === "explicit-v1") { if (!Array.isArray(plan.lengths) || plan.lengths.length < 1 || plan.lengths.length > 16 || plan.lengths.some((length) => !Number.isSafeInteger(length) || length < 1 || length > DESCRIPTOR_LIMITS.maxChunkBytes) || plan.lengths.reduce((sum, length) => sum + length, 0) !== decodedLength) fail("explicit chunk plan is invalid"); return true; }
  safeInteger(plan.firstChunkBytes, "firstChunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes); safeInteger(plan.chunkBytes, "chunkBytes", DESCRIPTOR_LIMITS.maxChunkBytes); if (plan.firstChunkBytes < 1 || plan.chunkBytes < 1 || plan.firstChunkBytes >= decodedLength) fail("first-then-block plan is invalid"); return true;
}

function validateNumericEvent(event, label) {
  exactKeys(event, ["offset", "rawLength", "rawTokenSha256", "coefficientDigits", "explicitExponent", "canonicalTuple", "invalidReason"], label, ["rawToken"]);
  safeInteger(event.offset, `${label}.offset`, DESCRIPTOR_LIMITS.maxDecodedBytes);
  safeInteger(event.rawLength, `${label}.rawLength`, DESCRIPTOR_LIMITS.maxNumericLexemeBytes);
  if (event.rawToken !== undefined && (typeof event.rawToken !== "string" || Buffer.byteLength(event.rawToken) !== event.rawLength)) fail(`${label}.rawToken length is inconsistent`);
  if (!/^[0-9a-f]{64}$/u.test(event.rawTokenSha256)) fail(`${label}.rawTokenSha256 must be SHA-256`);
  safeInteger(event.coefficientDigits, `${label}.coefficientDigits`, DESCRIPTOR_LIMITS.maxCoefficientDigits);
  if (event.explicitExponent !== null && (typeof event.explicitExponent !== "string" || !/^[+-]?(?:0|[1-9][0-9]*)$/u.test(event.explicitExponent))) fail(`${label}.explicitExponent is invalid`);
  if (event.canonicalTuple !== null) { exactKeys(event.canonicalTuple, ["sign", "coefficient", "exponent10"], `${label}.canonicalTuple`); validateTuple({ path: "numeric", ...event.canonicalTuple }, `${label}.canonicalTuple`); }
  if (event.invalidReason !== null && typeof event.invalidReason !== "string") fail(`${label}.invalidReason must be null or text`);
}

function validateGoldenMeasurement(golden) {
  const measurement = golden.measurement;
  if (golden.family === "sui-grpc-web") {
    if (!Array.isArray(measurement.grpcFrames)) fail(`${golden.goldenId} Sui oracle must include measured grpcFrames`);
    for (const [index, frame] of measurement.grpcFrames.entries()) { exactKeys(frame, ["marker", "declaredLength", "actualLength", "offset"], `${golden.goldenId}.grpcFrames[${index}]`); for (const key of ["marker", "declaredLength", "actualLength", "offset"]) safeInteger(frame[key], `${golden.goldenId}.grpcFrames[${index}].${key}`, 0xffffffff); }
    safeInteger(measurement.trailerLength, `${golden.goldenId}.trailerLength`, DESCRIPTOR_LIMITS.maxSuiTrailerBytes * 2);
  }
  if (golden.family === "bitcoin-json" && golden.goldenId !== "btc-invalid-utf8") {
    if (!Number.isSafeInteger(measurement.jsonTokenCount) || !Array.isArray(measurement.numericTokens) || !Number.isSafeInteger(measurement.numericTokenCount) || measurement.scanOutcome?.kind !== "valid-utf8") fail(`${golden.goldenId} JSON oracle must include token, numeric, and UTF-8 measurements`);
    for (const [index, event] of measurement.numericTokens.entries()) validateNumericEvent(event, `${golden.goldenId}.numericTokens[${index}]`);
  }
  if (golden.goldenId === "btc-invalid-utf8" && (measurement.scanOutcome?.kind !== "invalid-utf8" || measurement.scanOutcome.firstInvalidByteOffset !== 34)) fail("btc-invalid-utf8 oracle must anchor the fatal byte offset");
  if (golden.descriptor.kind === "json-zero-array-v1") {
    exactKeys(measurement.numericCompact, ["kind", "firstOffset", "repeatedStart", "repeatedStride", "repeatedCount", "repeatedToken", "lastOffset"], `${golden.goldenId}.numericCompact`);
    if (measurement.numericCompact.kind !== "repeated-zero-v1" || measurement.numericCompact.repeatedCount !== golden.descriptor.elementCount || measurement.numericCompact.repeatedStride !== 2 || measurement.numericCompact.repeatedToken !== "0" || measurement.numericTokenCount !== golden.descriptor.elementCount + 1) fail(`${golden.goldenId} compact zero-array oracle is inconsistent with descriptor`);
  }
}

export function resolveCaseResponseSource(entry, fixtureValue = fixture) {
  if (!isRecord(entry) || !isRecord(entry.responseDescriptor)) fail("case response source is missing");
  if (entry.responseDescriptor.kind === "oracle-ref-v1") {
    const golden = fixtureValue.oracleGoldens.find((candidate) => candidate.goldenId === entry.responseDescriptor.oracleGoldenId);
    if (!golden) fail(`${entry.caseId ?? "case"} response golden is missing`);
    return { kind: "oracle-ref-v1", goldenId: golden.goldenId, descriptor: golden.descriptor, chunkPlan: golden.chunkPlan, measurement: golden.measurement };
  }
  if (entry.responseDescriptor.kind === "inline-v1") return { kind: "inline-v1", goldenId: null, descriptor: entry.responseDescriptor.descriptor, chunkPlan: entry.responseDescriptor.chunkPlan, measurement: entry.responseDescriptor.measurement };
  fail("case response source kind is invalid");
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function schemaRef(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) fail(`unsupported fixture schema reference ${reference}`);
  return reference.slice(2).split("/").reduce((current, part) => current?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function schemaAccepts(value, schema, root) {
  try { validateJsonSchema(value, schema, root, "schema probe"); return true; } catch { return false; }
}

function validateJsonSchema(value, schema, root = schema, label = "fixture") {
  if (!isRecord(schema)) fail(`${label} schema branch is not an object`);
  if (schema.$ref !== undefined) { const target = schemaRef(root, schema.$ref); if (target === undefined) fail(`${label} schema reference is unresolved`); return validateJsonSchema(value, target, root, label); }
  if (schema.oneOf !== undefined) { const matches = schema.oneOf.filter((branch) => schemaAccepts(value, branch, root)).length; if (matches !== 1) fail(`${label} must match exactly one schema branch`); return; }
  if (schema.allOf !== undefined) for (const branch of schema.allOf) validateJsonSchema(value, branch, root, label);
  if (schema.not !== undefined && schemaAccepts(value, schema.not, root)) fail(`${label} matches a forbidden schema branch`);
  if (schema.if !== undefined && schemaAccepts(value, schema.if, root) && schema.then !== undefined) validateJsonSchema(value, schema.then, root, label);
  if (schema.const !== undefined && stableJson(value) !== stableJson(schema.const)) fail(`${label} differs from schema const`);
  if (schema.enum !== undefined && !schema.enum.some((entry) => stableJson(value) === stableJson(entry))) fail(`${label} is outside schema enum`);
  if (schema.type !== undefined) { const types = Array.isArray(schema.type) ? schema.type : [schema.type]; if (!types.some((type) => schemaTypeMatches(value, type))) fail(`${label} has the wrong schema type`); }
  if (!isRecord(value) && (schema.required !== undefined || schema.properties !== undefined || schema.additionalProperties !== undefined || schema.propertyNames !== undefined)) return;
  if (schema.minLength !== undefined && typeof value === "string" && [...value].length < schema.minLength) fail(`${label} is shorter than schema minimum`);
  if (schema.maxLength !== undefined && typeof value === "string" && [...value].length > schema.maxLength) fail(`${label} is longer than schema maximum`);
  if (schema.pattern !== undefined && typeof value === "string" && !(new RegExp(schema.pattern, "u").test(value))) fail(`${label} does not match schema pattern`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) fail(`${label} is below schema minimum`);
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) fail(`${label} is above schema maximum`);
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) fail(`${label} has too few schema items`);
  if (schema.maxItems !== undefined && Array.isArray(value) && value.length > schema.maxItems) fail(`${label} has too many schema items`);
  if (schema.uniqueItems && Array.isArray(value)) { const seen = new Set(value.map((entry) => stableJson(entry))); if (seen.size !== value.length) fail(`${label} has duplicate schema items`); }
  if (schema.minProperties !== undefined && isRecord(value) && Object.keys(value).length < schema.minProperties) fail(`${label} has too few schema properties`);
  if (schema.maxProperties !== undefined && isRecord(value) && Object.keys(value).length > schema.maxProperties) fail(`${label} has too many schema properties`);
  if (schema.required !== undefined) { if (!isRecord(value)) fail(`${label} must be an object for required schema fields`); for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`${label} is missing schema field ${key}`); }
  if (schema.propertyNames !== undefined && isRecord(value)) for (const key of Object.keys(value)) validateJsonSchema(key, schema.propertyNames, root, `${label}.${key}`);
  if (schema.properties !== undefined && isRecord(value)) for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) validateJsonSchema(value[key], child, root, `${label}.${key}`);
  if (schema.additionalProperties === false && isRecord(value)) { const allowed = new Set(Object.keys(schema.properties ?? {})); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown schema field ${key}`); }
  else if (isRecord(value) && isRecord(schema.additionalProperties)) { const allowed = new Set(Object.keys(schema.properties ?? {})); for (const [key, child] of Object.entries(value)) if (!allowed.has(key)) validateJsonSchema(child, schema.additionalProperties, root, `${label}.${key}`); }
  if (schema.items !== undefined && Array.isArray(value)) for (const [index, child] of value.entries()) validateJsonSchema(child, schema.items, root, `${label}[${index}]`);
}

export function validateFixtureSchema(value = fixture) {
  validateJsonSchema(value, fixtureSchema, fixtureSchema, "rpc-chain-contract-cases");
  return true;
}

function methodSetDigest(methodSet) {
  return digest(stableJson(methodSet));
}

function expectedCoverage(scope, contract, fixtureValue) {
  const clients = new Map(contract.clientContracts.map((client) => [client.clientContractId, client]));
  return scope.networkIds.map((networkId) => {
    const network = contract.networks.find((entry) => entry.networkId === networkId);
    const client = clients.get(network.clientContractId);
    const methodSet = contract.methodSets.find((entry) => entry.methodSetId === client.methodSetId);
    return {
      networkId,
      clientContractId: client.clientContractId,
      namespace: client.namespace,
      methodSetDigest: methodSetDigest(methodSet),
      routePolicyIds: client.endpointModes.map((entry) => entry.transportProfileId).sort(),
      portableCasesExecuted: fixtureValue.cases.some((item) => item.networkId === networkId),
    };
  });
}

function expectedSurface(scope, contract, language) {
  const networkSet = new Set(scope.networkIds);
  const clientIds = new Set(contract.networks.filter((network) => networkSet.has(network.networkId)).map((network) => network.clientContractId));
  return [...clientIds].sort().map((clientContractId) => {
    const client = contract.clientContracts.find((entry) => entry.clientContractId === clientContractId);
    const methodSet = contract.methodSets.find((entry) => entry.methodSetId === client.methodSetId);
    const allowed = methodSet.kind === "expanded" ? methodSet.capabilities.map((entry) => entry.publicNames?.[language] ?? entry.publicOperation) : ["legacy-reference"];
    const forbidden = [...client.forbiddenCapabilities];
    if (language === "rust" && clientContractId === "client-bitcoin-rpc") for (const capability of ["raw", "request", "batch"]) {
      const index = forbidden.indexOf(capability); if (index >= 0) forbidden.splice(index, 1);
    }
    return { clientContractId, allowed, forbidden: forbidden.sort() };
  });
}

export const RUST_ARTIFACT_IDENTITY = Object.freeze({
  kind: "rust-crate-v1",
  version: "0.11.0",
  sourceCommit: "4877b32a32ffb6b82a6620040fe77fc2e73f4386",
  crateSha256: "fe3e0e224a60921531d09442ecbe68ab9a34ae3ebed7821ab02a309b8b66f7f6",
  crateSizeBytes: 254463,
});

function parseLosslessJsonRequest(input) {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(String(input), "utf8");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("native JSON request is not valid UTF-8");
  }
  let offset = 0;
  const whitespace = () => { while (offset < source.length && /[\u0020\u0009\u000a\u000d]/u.test(source[offset])) offset += 1; };
  const parseString = () => {
    if (source[offset] !== '"') fail("native JSON request string is malformed");
    const start = offset; offset += 1; let escaped = false;
    while (offset < source.length) {
      const code = source.charCodeAt(offset); const character = source[offset];
      if (escaped) { escaped = false; offset += 1; continue; }
      if (character === "\\") { escaped = true; offset += 1; continue; }
      if (code < 0x20) fail("native JSON request string contains an unescaped control character");
      offset += 1;
      if (character === '"') {
        const raw = source.slice(start, offset);
        try { return { kind: "string", value: JSON.parse(raw) }; } catch { fail("native JSON request string escape is malformed"); }
      }
    }
    fail("native JSON request string is unterminated");
  };
  const parseValue = () => {
    whitespace();
    const character = source[offset];
    if (character === '"') return parseString();
    if (character === "{") {
      offset += 1; whitespace(); const entries = []; const keys = new Set();
      if (source[offset] === "}") { offset += 1; return { kind: "object", entries }; }
      while (true) {
        whitespace(); const key = parseString().value; if (keys.has(key)) fail("native JSON request has duplicate decoded member names"); keys.add(key);
        whitespace(); if (source[offset] !== ":") fail("native JSON request object is missing a colon"); offset += 1;
        const value = parseValue(); entries.push([key, value]); whitespace();
        if (source[offset] === "}") { offset += 1; break; }
        if (source[offset] !== ",") fail("native JSON request object is missing a comma"); offset += 1;
      }
      entries.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
      return { kind: "object", entries };
    }
    if (character === "[") {
      offset += 1; whitespace(); const values = [];
      if (source[offset] === "]") { offset += 1; return { kind: "array", values }; }
      while (true) {
        values.push(parseValue()); whitespace();
        if (source[offset] === "]") { offset += 1; break; }
        if (source[offset] !== ",") fail("native JSON request array is missing a comma"); offset += 1;
      }
      return { kind: "array", values };
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) if (source.startsWith(literal, offset)) { offset += literal.length; return { kind: "literal", value }; }
    const number = source.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (number !== null) { offset += number[0].length; return { kind: "number", raw: number[0] }; }
    fail("native JSON request value is malformed");
  };
  const emit = (value) => {
    if (value.kind === "string") return JSON.stringify(value.value);
    if (value.kind === "number") return value.raw;
    if (value.kind === "literal") return JSON.stringify(value.value);
    if (value.kind === "array") return `[${value.values.map(emit).join(",")}]`;
    return `{${value.entries.map(([key, child]) => `${JSON.stringify(key)}:${emit(child)}`).join(",")}}`;
  };
  const value = parseValue(); whitespace(); if (offset !== source.length) fail("native JSON request has trailing content");
  return Buffer.from(emit(value), "utf8");
}

/** json-request-key-order-v1: normalize captured JSON request bytes without converting numeric tokens to floating point. */
export function normalizeJsonRequestBytes(input) {
  const bytes = parseLosslessJsonRequest(input);
  return { bytes, sha256: digest(bytes) };
}

function operationBinding(item, language, contract) {
  const client = contract.clientContracts.find((entry) => entry.clientContractId === item.clientContractId);
  const methodSet = contract.methodSets.find((entry) => entry.methodSetId === client?.methodSetId);
  const capability = methodSet?.capabilities?.find((entry) => entry.wireOperation === item.operation.wireOperation);
  return {
    publicOperation: capability?.publicNames?.[language] ?? item.operation.publicOperations?.[language] ?? capability?.publicOperation ?? item.operation.publicOperation,
    wireOperation: item.operation.wireOperation,
    params: structuredClone(item.operation.params),
  };
}

function nativeEndpointDiagnostic(item) {
  if (item.caseId === "c1-schedule-pre-cancel") return item.expected.endpointDiagnostic;
  if (item.expected.ioCount !== 1 || item.expected.trace.target === "NO_IO") return "";
  try { return `${new URL(item.expected.trace.target).origin}/`; } catch { return item.expected.endpointDiagnostic; }
}

function nativeCaseBehavior(item, language, contract) {
  const behavior = structuredClone(item.expected);
  behavior.operation = operationBinding(item, language, contract);
  behavior.caseKind = item.caseKind;
  behavior.exceptionIds = [...item.exceptionIds].sort();
  behavior.endpointDiagnostic = nativeEndpointDiagnostic(item);
  if (language === "rust" && item.clientContractId === "client-bitcoin-rpc" && item.exceptionIds.includes("rust-bitcoin-raw-batch-v1") && ["c1-hosted-bitcoin-bearer-no-query-null-error", "c1-direct-bitcoin-exact-target-scoped-header-keyless", "c1-bitcoin-twelve-named-methods-and-result-shapes", "btc-gettxout-null-result"].includes(item.caseId)) {
    behavior.surface.forbidden = behavior.surface.forbidden.filter((capability) => !["raw", "request", "batch"].includes(capability));
  }
  if (item.expected.ioCount === 1 && item.mockExchange.request.bodyEncoding === "json") behavior.trace.bodySha256 = normalizeJsonRequestBytes(Buffer.from(item.mockExchange.request.body, "utf8")).sha256;
  if (language === "ruby" && item.exceptionIds.includes("ruby-bitcoin-synchronous-request-v1") && ["life-pre-cancel", "life-first-chunk-cancellation-barrier"].includes(item.scheduleId)) {
    behavior.outcome = { kind: "not-applicable", value: "ruby-bitcoin-synchronous-request-v1" };
    behavior.trace = { ioKind: "none", method: "NONE", target: "NO_IO", headers: {}, bodySha256: item.expected.trace.bodySha256, attempts: 0 };
    behavior.ioCount = 0;
  }
  return behavior;
}

function expectedBehavior(scope, language, fixtureValue, contract) {
  const networkSet = new Set(scope.networkIds);
  const selected = fixtureValue.cases.filter((item) => networkSet.has(item.networkId) && item.applicability.includes(language)).sort((left, right) => left.caseId.localeCompare(right.caseId));
  return Object.fromEntries(selected.map((item) => [item.caseId, nativeCaseBehavior(item, language, contract)]));
}

function canonicalSnapshotPayload(value) {
  const payload = Object.fromEntries(SNAPSHOT_BASE_KEYS.map((key) => [key, value[key]]));
  payload.scope = {
    ...value.scope,
    cohortIds: [...value.scope.cohortIds].sort((left, right) => left - right),
    networkIds: [...value.scope.networkIds].sort(),
  };
  payload.coverage = [...value.coverage]
    .sort((left, right) => left.networkId.localeCompare(right.networkId))
    .map((entry) => ({ ...entry, routePolicyIds: [...entry.routePolicyIds].sort() }));
  payload.behavior = Object.fromEntries(Object.keys(value.behavior).sort().map((key) => [key, value.behavior[key]]));
  payload.surface = [...value.surface]
    .sort((left, right) => left.clientContractId.localeCompare(right.clientContractId))
    .map((entry) => ({ ...entry, forbidden: [...entry.forbidden].sort() }));
  return payload;
}

export function computeSnapshotPayloadSha256(value) {
  exactKeys(value, SNAPSHOT_BASE_KEYS, "snapshot payload", ["evidence"]);
  return digest(stableJson(canonicalSnapshotPayload(value)));
}

export function buildExpectedSnapshot({ language, throughCohort = 5, fixture: fixtureValue = fixture, contract = CONTRACT } = {}) {
  if (!LANGUAGES.includes(language)) fail(`snapshot language must be one of ${LANGUAGES.join(", ")}`);
  validateFixtures(fixtureValue, contract);
  const scope = expectedScope(throughCohort, contract);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    snapshotKind: SNAPSHOT_SYNTHETIC_KIND,
    language,
    runtime: "synthetic-test-runtime",
    contractVersion: contract.contractVersion,
    contractDigest: contract.contentDigest,
    fixtureDigest: fixtureValue.fixtureDigest,
    scope,
    coverage: expectedCoverage(scope, contract, fixtureValue),
    behavior: expectedBehavior(scope, language, fixtureValue, contract),
    surface: expectedSurface(scope, contract, language),
  };
}

function containsCredentialSentinel(value, fixtureValue) {
  const textValue = JSON.stringify(value);
  const sentinels = new Set();
  for (const entry of fixtureValue.cases) {
    if (entry.setup.apiKey) sentinels.add(entry.setup.apiKey);
    if (entry.setup.endpoint?.includes("fixture-secret")) sentinels.add("fixture-secret");
    for (const headerValue of Object.values(entry.setup.headers)) if (headerValue.includes("fixture")) sentinels.add(headerValue);
  }
  for (const sentinel of sentinels) if (sentinel && textValue.includes(sentinel)) return sentinel;
  return null;
}

function validateCaptureEvidence(value, language, scope, { payloadSha256, expectedCaseCount, sourceManifestSha256, requireSourceManifest = false } = {}) {
  exactKeys(value, ["kind", "command", "exitCode", "sourceIdentity", "consumer", "capture", "snapshotSha256"], `${language}.evidence`);
  if (!["native-capture-v1", "rust-immutable-artifact-v1"].includes(value.kind)) fail(`${language} evidence kind is invalid`);
  text(value.command, `${language}.evidence.command`);
  if (value.exitCode !== 0) fail(`${language} evidence command did not succeed`);
  if (!/^[0-9a-f]{64}$/u.test(value.snapshotSha256)) fail(`${language} evidence snapshotSha256 must be SHA-256`);
  if (language === "rust") {
    exactKeys(value.sourceIdentity, ["kind", "version", "sourceCommit", "crateSha256", "crateSizeBytes"], `${language}.evidence.sourceIdentity`);
    if (stableJson(value.sourceIdentity) !== stableJson(RUST_ARTIFACT_IDENTITY)) fail("Rust immutable artifact identity differs from the accepted 0.11.0 crate");
  } else {
    exactKeys(value.sourceIdentity, ["kind", "version", "sourceManifestSha256"], `${language}.evidence.sourceIdentity`);
    if (value.sourceIdentity.kind !== "frozen-source-manifest-v1") fail(`${language} evidence source identity kind is invalid`);
    text(value.sourceIdentity.version, `${language}.evidence.sourceIdentity.version`);
    if (!/^[0-9a-f]{64}$/u.test(value.sourceIdentity.sourceManifestSha256)) fail(`${language} evidence sourceManifestSha256 must be SHA-256`);
    if (requireSourceManifest && sourceManifestSha256 === undefined) fail(`${language} evidence requires an explicit source-manifest input`);
    if (sourceManifestSha256 !== undefined && value.sourceIdentity.sourceManifestSha256 !== sourceManifestSha256) fail(`${language} evidence source manifest hash differs from the explicit input`);
  }
  if (payloadSha256 !== undefined && value.snapshotSha256 !== payloadSha256) fail(`${language} evidence snapshotSha256 is not the computed payload binding`);
  exactKeys(value.consumer, ["command", "exitCode", "status"], `${language}.evidence.consumer`);
  text(value.consumer.command, `${language}.evidence.consumer.command`);
  if (value.consumer.exitCode !== 0 || value.consumer.status !== "success") fail(`${language} evidence consumer execution is incomplete`);
  exactKeys(value.capture, ["command", "exitCode", "snapshotSha256", "networkCount", "caseCount"], `${language}.evidence.capture`);
  text(value.capture.command, `${language}.evidence.capture.command`);
  if (value.capture.exitCode !== 0 || value.capture.snapshotSha256 !== value.snapshotSha256) fail(`${language} evidence capture is incomplete`);
  if (!Number.isInteger(value.capture.networkCount) || value.capture.networkCount !== scope.networkIds.length) fail(`${language} evidence capture network count differs from scope`);
  if (!Number.isInteger(value.capture.caseCount) || value.capture.caseCount !== expectedCaseCount) fail(`${language} evidence capture case count differs from applicable behavior coverage`);
  if (language === "rust") {
    if (value.kind !== "rust-immutable-artifact-v1") fail("Rust native evidence must use immutable artifact mode");
  } else if (value.kind !== "native-capture-v1") fail(`${language} native evidence kind is invalid`);
}

function validateSnapshot(value, language, scope, fixtureValue, contract, allowSynthetic, { sourceManifestSha256, requireSourceManifest = false } = {}) {
  exactKeys(value, SNAPSHOT_KEYS, `${language} snapshot`, ["evidence"]);
  if (value.snapshotVersion !== SNAPSHOT_VERSION || (![SNAPSHOT_KIND, SNAPSHOT_SYNTHETIC_KIND].includes(value.snapshotKind))) fail(`${language} snapshot kind/version is invalid`);
  if (value.snapshotKind === SNAPSHOT_SYNTHETIC_KIND && !allowSynthetic) fail(`${language} snapshot is an expected-template fixture, not native evidence`);
  if (value.language !== language) fail(`${language} snapshot language field differs`);
  text(value.runtime, `${language}.runtime`);
  if (["canonical-reference", "renderer-only", "expected-template"].includes(value.runtime) || (!allowSynthetic && value.runtime === "synthetic-test-runtime")) fail(`${language} snapshot runtime is not native evidence`);
  if (!allowSynthetic && scope.throughCohort >= 5 && value.evidence === undefined) fail(`${language} native all-network snapshot is missing capture evidence`);
  if (value.contractVersion !== contract.contractVersion || value.contractDigest !== contract.contentDigest || value.fixtureDigest !== fixtureValue.fixtureDigest) fail(`${language} snapshot digest/version differs from canonical inputs`);
  if (stableJson(value.scope) !== stableJson(scope)) fail(`${language} snapshot scope differs from derived cohort scope`);
  if (!Array.isArray(value.coverage) || value.coverage.length !== scope.networkIds.length) fail(`${language} snapshot coverage count differs from scope`);
  const expected = buildExpectedSnapshot({ language, throughCohort: scope.throughCohort, fixture: fixtureValue, contract });
  if (stableJson(value.coverage) !== stableJson(expected.coverage)) fail(`${language} snapshot coverage differs from the contract`);
  const leaked = containsCredentialSentinel(value, fixtureValue);
  if (leaked !== null) fail(`${language} snapshot leaks fixture credential sentinel ${leaked}`);
  if (!isRecord(value.behavior)) fail(`${language} snapshot behavior must be an object`);
  const expectedBehaviorKeys = Object.keys(expected.behavior).sort();
  const suppliedBehaviorKeys = Object.keys(value.behavior).sort();
  if (stableJson(suppliedBehaviorKeys) !== stableJson(expectedBehaviorKeys)) fail(`${language} snapshot behavior key set differs from applicable fixture cases`);
  if (stableJson(value.behavior) !== stableJson(expected.behavior)) fail(`${language} snapshot behavior differs from applicable fixture outcomes`);
  if (stableJson(value.surface) !== stableJson(expected.surface)) fail(`${language} snapshot surface differs from the contract`);
  if (value.evidence !== undefined) {
    validateCaptureEvidence(value.evidence, language, scope, {
      payloadSha256: computeSnapshotPayloadSha256(value),
      expectedCaseCount: expectedBehaviorKeys.length,
      sourceManifestSha256,
      requireSourceManifest,
    });
  }
}

export function validateSingleSnapshot(value, { language, throughCohort = 5, fixture: fixtureValue = fixture, contract = CONTRACT, sourceManifestSha256 } = {}) {
  if (!LANGUAGES.includes(language)) fail(`snapshot language must be one of ${LANGUAGES.join(", ")}`);
  validateFixtures(fixtureValue, contract);
  const scope = expectedScope(throughCohort, contract);
  validateSnapshot(value, language, scope, fixtureValue, contract, false, {
    sourceManifestSha256,
    requireSourceManifest: language !== "rust" && scope.throughCohort >= 5,
  });
  return { status: "ok", language, throughCohort, networkRows: scope.networkIds.length, evidenceKind: "validated supplied snapshot semantics only; any source-manifest binding uses a caller-supplied expected hash; actual manifest/source inventory, artifact bytes and SDK execution require external evidence" };
}

export function validateObservedCase({ caseId, language, observation, fixture: fixtureValue = fixture, contract = CONTRACT } = {}) {
  if (!LANGUAGES.includes(language)) fail(`observed case language must be one of ${LANGUAGES.join(", ")}`);
  validateFixtures(fixtureValue, contract);
  const entry = fixtureValue.cases.find((candidate) => candidate.caseId === caseId);
  if (!entry) fail(`observed case ${caseId} is not in the approved fixture`);
  if (!entry.applicability.includes(language)) fail(`observed case ${caseId} is not applicable to ${language}`);
  const expected = nativeCaseBehavior(entry, language, contract);
  if (stableJson(observation) !== stableJson(expected)) fail(`observed case ${caseId} differs from the approved semantic contract`);
  return true;
}

function verifySnapshotsInternal(input, { throughCohort = 5, fixture: fixtureValue = fixture, contract = CONTRACT, allowSynthetic = false, sourceManifestSha256ByLanguage = {} } = {}) {
  validateFixtures(fixtureValue, contract);
  const snapshots = Array.isArray(input) ? input : input?.snapshots;
  if (!Array.isArray(snapshots) || snapshots.length !== LANGUAGES.length) fail(`parity requires exactly ${LANGUAGES.length} explicit native snapshots`);
  const byLanguage = new Map();
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || typeof snapshot.language !== "string") fail("each parity input must be a snapshot with a language");
    if (byLanguage.has(snapshot.language)) fail(`duplicate ${snapshot.language} native snapshot`);
    byLanguage.set(snapshot.language, snapshot);
  }
  if (JSON.stringify([...byLanguage.keys()].sort()) !== JSON.stringify([...LANGUAGES].sort())) fail("parity snapshots must contain exactly TypeScript, Rust, Python, Go and Ruby");
  const scope = expectedScope(throughCohort, contract);
  for (const language of LANGUAGES) validateSnapshot(byLanguage.get(language), language, scope, fixtureValue, contract, allowSynthetic, {
    sourceManifestSha256: sourceManifestSha256ByLanguage?.[language],
    requireSourceManifest: !allowSynthetic && scope.throughCohort >= 5,
  });
  return {
    status: "ok",
    mode: scope.mode,
    throughCohort: scope.throughCohort,
    networkRows: scope.networkIds.length,
    languages: LANGUAGES.map((language) => ({ language, runtime: byLanguage.get(language).runtime })),
    contractDigest: contract.contentDigest,
    fixtureDigest: fixtureValue.fixtureDigest,
    evidenceKind: allowSynthetic ? "test-only expected-template semantics; no native execution claim" : "validated supplied snapshot semantics only; external capture commands/source/build identity and snapshot hashes remain required",
  };
}

export function verifySnapshots(input, options = {}) {
  return verifySnapshotsInternal(input, { ...options, allowSynthetic: false });
}

export function verifySyntheticSnapshots(input, options = {}) {
  return verifySnapshotsInternal(input, { ...options, allowSynthetic: true });
}

function parseArguments(argumentsList) {
  const options = { snapshots: [], mode: null, throughCohort: null, json: false, help: false, sourceManifests: [] };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--snapshot") {
      const file = argumentsList[++index];
      if (!file || file.startsWith("--")) fail("--snapshot requires a file path");
      options.snapshots.push(file);
    } else if (argument === "--through-cohort") {
      if (options.mode) fail("choose exactly one of --through-cohort or --all");
      const raw = argumentsList[++index];
      if (!raw || !/^[1-5]$/u.test(raw)) fail("--through-cohort requires an integer from 1 through 5");
      options.mode = "through-cohort";
      options.throughCohort = Number(raw);
    } else if (argument === "--all") {
      if (options.mode) fail("choose exactly one of --through-cohort or --all");
      options.mode = "all";
      options.throughCohort = 5;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--source-manifest") {
      const value = argumentsList[++index];
      if (!value || value.startsWith("--") || !value.includes("=")) fail("--source-manifest requires <language>=<path>");
      const separator = value.indexOf("="); const language = value.slice(0, separator); const file = value.slice(separator + 1);
      if (!LANGUAGES.includes(language) || language === "rust" || file === "") fail("--source-manifest requires a non-Rust language and file path");
      if (options.sourceManifests.some((entry) => entry.language === language)) fail(`duplicate source manifest for ${language}`);
      options.sourceManifests.push({ language, file });
    } else if (argument === "--help") {
      options.help = true;
    } else {
      fail(`unknown option ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.snapshots.length !== LANGUAGES.length) fail("provide exactly five --snapshot paths");
  if (!options.mode) fail("provide exactly one of --through-cohort <1..5> or --all");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node registry/verify-rpc-network-parity.mjs --through-cohort <1..5> --snapshot <typescript.json> --snapshot <rust.json> --snapshot <python.json> --snapshot <go.json> --snapshot <ruby.json> [--source-manifest <language>=<path>]...",
    "  node registry/verify-rpc-network-parity.mjs --all --snapshot <typescript.json> --snapshot <rust.json> --snapshot <python.json> --snapshot <go.json> --snapshot <ruby.json> [--source-manifest <language>=<path>]...",
    "  evidence.snapshotSha256 and evidence.capture.snapshotSha256 bind SHA-256(stableJson(base snapshot payload)); evidence is excluded and no trailing LF is included.",
    "  Performed JSON request trace bodySha256 uses json-request-key-order-v1 lossless key-order normalization; fixture bodySha256 values remain raw-byte hashes.",
  ].join("\n");
}

async function readSnapshot(file) {
  try {
    return JSON.parse(await readFile(path.resolve(process.cwd(), file), "utf8"));
  } catch (error) {
    fail(`cannot read snapshot ${file}: ${error.message}`);
  }
}

async function readSourceManifestHashes(entries) {
  const hashes = {};
  for (const entry of entries) {
    try {
      hashes[entry.language] = digest(await readFile(path.resolve(process.cwd(), entry.file)));
    } catch (error) {
      fail(`cannot read source manifest ${entry.file}: ${error.message}`);
    }
  }
  return hashes;
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshots = [];
  for (const file of options.snapshots) snapshots.push(await readSnapshot(file));
  const sourceManifestSha256ByLanguage = await readSourceManifestHashes(options.sourceManifests);
  const result = verifySnapshots(snapshots, { throughCohort: options.throughCohort, sourceManifestSha256ByLanguage });
  process.stdout.write(`${options.json ? JSON.stringify(result) : `rpc network parity OK: ${result.networkRows} network rows through cohort ${result.throughCohort}; five explicit snapshots checked`}\n`);
  return result;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) {
  run().catch((error) => {
    process.stderr.write(`verify-rpc-network-parity: ${error.message}\n`);
    process.exitCode = 1;
  });
}
