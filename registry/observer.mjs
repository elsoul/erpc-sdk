import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";

import {
  CATALOG,
  TOKEN_CHAIN_IDS,
  computeDigest,
  validateCatalog,
} from "./token-catalog.mjs";
import defaultObserverConfig from "./observer-config.json" with { type: "json" };

const execFileAsync = promisify(execFile);

export const OBSERVER_SCHEMA_VERSION = 1;
export const OBSERVER_ARTIFACT_FILENAMES = Object.freeze({
  receipts: "receipts.json",
  findings: "findings.json",
  reviewCandidate: "review-candidate.json",
});

export const OBSERVER_LIMITS = Object.freeze({
  rpcBodyBytes: 512 * 1024,
  sourceBodyBytes: 2 * 1024 * 1024,
  rpcTimeoutMs: 10_000,
  sourceTimeoutMs: 12_000,
  rpcRetries: 2,
  sourceRetries: 1,
  concurrency: 4,
  runBudgetMs: 10 * 60 * 1000,
  maxRedirects: 3,
});

export const DEFAULT_RPC_ENDPOINTS = Object.freeze({
  ethereum: Object.freeze({
    endpointId: "ethereum-public",
    chainId: TOKEN_CHAIN_IDS.ethereum,
    expectedRpcChainId: "0x1",
    url: "https://ethereum-rpc.publicnode.com",
    hostname: "ethereum-rpc.publicnode.com",
  }),
  avalancheC: Object.freeze({
    endpointId: "avalanche-c-public",
    chainId: TOKEN_CHAIN_IDS.avalancheC,
    expectedRpcChainId: "0xa86a",
    url: "https://api.avax.network/ext/bc/C/rpc",
    hostname: "api.avax.network",
  }),
  solana: Object.freeze({
    endpointId: "solana-public",
    chainId: TOKEN_CHAIN_IDS.solana,
    expectedGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    url: "https://api.mainnet-beta.solana.com",
    hostname: "api.mainnet-beta.solana.com",
  }),
});

export const RPC_ENV_NAMES = Object.freeze({
  ethereum: "ERPC_OBSERVER_ETHEREUM_RPC_URL",
  avalancheC: "ERPC_OBSERVER_AVALANCHE_RPC_URL",
  solana: "ERPC_OBSERVER_SOLANA_RPC_URL",
});

export const TOKEN_PROGRAM_IDS = Object.freeze({
  splToken: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  splToken2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
});

const EVM_CHAINS = new Set([TOKEN_CHAIN_IDS.ethereum, TOKEN_CHAIN_IDS.avalancheC]);
const SOLANA_CHAIN = TOKEN_CHAIN_IDS.solana;
const NETWORKS = Object.freeze(["ethereum", "avalancheC", "solana"]);
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const ACTIONABLE_SOURCE_STATUS = new Set([404, 410]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const REVIEWED_RPC_PROOF_ENDPOINT_BY_URL = Object.freeze(Object.fromEntries(Object.values(DEFAULT_RPC_ENDPOINTS).map((endpoint) => [endpoint.url, endpoint])));
const HEX_RE = /^0x[0-9a-f]*$/iu;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/u;
const HOST_RE = /^[a-z0-9.-]+$/iu;
const FIXED_ERROR_CODES = new Set([
  "CONFIG_INVALID",
  "CATALOG_INVALID",
  "SOURCE_SHA_INVALID",
  "CONFIG_URL_SET_MISMATCH",
  "CONFIG_SOURCE_DUPLICATE",
  "CONFIG_RPC_INVALID",
  "UNSAFE_URL",
  "UNSAFE_HOST",
  "PRIVATE_ADDRESS",
  "DNS_RESOLUTION_FAILED",
  "DNS_REBINDING_DETECTED",
  "TLS_REQUEST_FAILED",
  "TIMEOUT",
  "RUN_BUDGET_EXCEEDED",
  "RPC_HTTP_429",
  "RPC_HTTP_500",
  "RPC_HTTP_502",
  "RPC_HTTP_503",
  "RPC_HTTP_504",
  "RPC_HTTP_ERROR",
  "RPC_INVALID_JSON",
  "RPC_ERROR",
  "RPC_RESULT_INVALID",
  "RPC_BODY_LIMIT",
  "RPC_ENCODING_UNSUPPORTED",
  "RPC_INVALID_BODY",
  "RPC_UNAVAILABLE",
  "NETWORK_IDENTITY_MISMATCH",
  "NETWORK_IDENTITY_INVALID",
  "EVM_BLOCK_NUMBER_INVALID",
  "EVM_EMPTY_CODE",
  "EVM_CODE_INVALID",
  "EVM_DECIMALS_INVALID",
  "EVM_DECIMALS_OUT_OF_RANGE",
  "EVM_DECIMALS_MISMATCH",
  "EVM_SYMBOL_INVALID",
  "EVM_SYMBOL_MISMATCH",
  "EVM_CALL_FAILED",
  "SOLANA_SLOT_INVALID",
  "SOLANA_ACCOUNT_INVALID",
  "SOLANA_CONTEXT_SLOT_INVALID",
  "SOLANA_CONTEXT_SLOT_BELOW_ANCHOR",
  "SOLANA_OWNER_INVALID",
  "SOLANA_STANDARD_MISMATCH",
  "SOLANA_PARSED_TYPE_INVALID",
  "SOLANA_DECIMALS_INVALID",
  "SOLANA_DECIMALS_OUT_OF_RANGE",
  "SOLANA_DECIMALS_MISMATCH",
  "SOURCE_HTTP_404",
  "SOURCE_HTTP_410",
  "SOURCE_HTTP_ERROR",
  "SOURCE_INVALID_REDIRECT",
  "SOURCE_REDIRECT_LIMIT",
  "SOURCE_INVALID_BODY",
  "SOURCE_PARSE_ERROR",
  "SOURCE_BODY_LIMIT",
  "SOURCE_ENCODING_UNSUPPORTED",
  "SOURCE_SIGNALS_CHANGED",
  "SOURCE_NOT_USABLE",
  "SOURCE_TRANSPORT_ERROR",
  "SOURCE_TIMEOUT",
  "SOURCE_RATE_LIMITED",
  "SOURCE_UPSTREAM_ERROR",
  "PREVIOUS_FINDINGS_INVALID",
  "BASELINE_INVALID",
  "ARTIFACT_INVALID",
  "INTERNAL_ERROR",
]);

const FORBIDDEN_FINDING_KEYS = new Set([
  "sourceSha",
  "sourceSHA",
  "observedAt",
  "observationTime",
  "timestamp",
  "block",
  "blockNumber",
  "slot",
  "retry",
  "retryCount",
  "requestId",
  "requestID",
  "errorMessage",
  "errorProse",
  "bodySha256",
]);
const FINDING_CATEGORIES = new Set(["network-identity", "rpc-observation", "source-change", "source-unavailable"]);
export const OBSERVER_ERROR_CODES = Object.freeze([...FIXED_ERROR_CODES].sort());

export class ObserverValidationError extends Error {
  constructor(message, code = "CONFIG_INVALID") {
    super(message);
    this.name = "ObserverValidationError";
    this.code = code;
  }
}

export class ObserverRunError extends Error {
  constructor(code, message = code, { retryable = false, statusCode = null } = {}) {
    super(message);
    this.name = "ObserverRunError";
    this.code = FIXED_ERROR_CODES.has(code) ? code : "INTERNAL_ERROR";
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function fail(message, code = "CONFIG_INVALID") {
  throw new ObserverValidationError(message, code);
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

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\u0000]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`);
  }
}

function id(value, label) {
  string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(`${label} is not a stable identifier`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
}

function sourceSha(value, label = "sourceSha") {
  if (typeof value !== "string" || !SOURCE_SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase source SHA`, "SOURCE_SHA_INVALID");
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function nowValue(clock = Date) {
  if (clock === Date) return Date.now();
  if (typeof clock === "function") {
    const value = clock();
    const numeric = value instanceof Date ? value.valueOf() : Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
  }
  if (clock && typeof clock.now === "function") {
    const value = clock.now();
    const numeric = value instanceof Date ? value.valueOf() : Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
  }
  return Date.now();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function computeConfigDigest(config) {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function reviewedRpcProofEndpoint(url) {
  return REVIEWED_RPC_PROOF_ENDPOINT_BY_URL[url] ?? null;
}

function isReviewedRpcProofForAsset(catalog, asset, url) {
  const endpoint = reviewedRpcProofEndpoint(url);
  return endpoint !== null && asset.representationKind === "unclassified" && catalog.deployments.some((entry) => entry.assetId === asset.assetId && entry.chainId === endpoint.chainId);
}

function isReviewedRpcProofForDeployment(catalog, deployment, url) {
  const endpoint = reviewedRpcProofEndpoint(url);
  const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
  return endpoint !== null && asset?.representationKind === "unclassified" && deployment.chainId === endpoint.chainId;
}

function sourceUrlsFromCatalog(catalog) {
  const urls = new Set();
  for (const asset of catalog.assets) for (const url of asset.evidence) if (!isReviewedRpcProofForAsset(catalog, asset, url)) urls.add(url);
  for (const deployment of catalog.deployments) for (const url of deployment.evidence) if (!isReviewedRpcProofForDeployment(catalog, deployment, url)) urls.add(url);
  return urls;
}

function parseHttpsUrl(value, label, { allowPath = true } = {}) {
  string(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid HTTPS URL`, "UNSAFE_URL");
  }
  if (parsed.protocol !== "https:") fail(`${label} must use HTTPS`, "UNSAFE_URL");
  if (parsed.username || parsed.password) fail(`${label} must not include credentials`, "UNSAFE_URL");
  if (!parsed.hostname || !HOST_RE.test(parsed.hostname)) fail(`${label} has an unsafe hostname`, "UNSAFE_URL");
  if (parsed.port && parsed.port !== "443") fail(`${label} must use the default HTTPS port`, "UNSAFE_URL");
  if (!allowPath && (parsed.pathname !== "/" || parsed.search || parsed.hash)) fail(`${label} must not include a path`, "UNSAFE_URL");
  if (parsed.hash) fail(`${label} must not include a fragment`, "UNSAFE_URL");
  if (isUnsafeHostname(parsed.hostname)) fail(`${label} targets a local or reserved hostname`, "UNSAFE_HOST");
  return parsed;
}

function isUnsafeHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".home.arpa")) return true;
  const addressType = isIP(lower);
  if (!addressType) return false;
  return isPrivateAddress(lower, addressType);
}

function parseIpv6Bytes(address) {
  const text = String(address).replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(text) !== 6 || text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part) => {
    if (!part) return [];
    const groups = [];
    for (const group of part.split(":")) {
      if (/\./u.test(group)) {
        const octets = group.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };
  const left = parseGroups(halves[0]);
  const right = parseGroups(halves.length === 2 ? halves[1] : "");
  if (!left || !right) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < (halves.length === 2 ? 1 : 0) || left.length + right.length + missing !== 8) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

function isPrivateAddress(address, family = isIP(address)) {
  const detectedFamily = isIP(String(address).replace(/^\[|\]$/gu, ""));
  if (!detectedFamily || (family !== undefined && family !== 0 && Number(family) !== detectedFamily)) return true;
  if (detectedFamily === 4) {
    const octets = address.split(".").map(Number);
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && (second === 0 || second === 2 || second === 168)) return true;
    if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
    if (first === 203 && second === 0) return true;
    return false;
  }
  const bytes = parseIpv6Bytes(address);
  if (!bytes) return true;
  const allZeroThrough11 = bytes.subarray(0, 12).every((byte) => byte === 0);
  const ipv4Mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4Translated = bytes.subarray(0, 8).every((byte) => byte === 0) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0;
  const wellKnownTranslated = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.subarray(4, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Translated || allZeroThrough11 || wellKnownTranslated) {
    const octets = [...bytes.subarray(12)].join(".");
    return isPrivateAddress(octets, 4);
  }
  if (bytes[0] === 0xfc || bytes[0] === 0xfd) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x10) return true;
  return false;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === target);
  return key === undefined ? undefined : headers[key];
}

function headersToObject(headers) {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), Array.isArray(value) ? value.join(",") : String(value)]));
}

async function bodyToBuffer(body, maxBytes = Number.POSITIVE_INFINITY, kind = "source") {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (isRecord(body) || Array.isArray(body)) return Buffer.from(JSON.stringify(body));
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let length = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > maxBytes) throw new ObserverRunError(kind === "rpc" ? "RPC_BODY_LIMIT" : "SOURCE_BODY_LIMIT");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body));
}

function decodeBody(buffer, headers, maxBytes, kind = "source") {
  const prefix = kind === "rpc" ? "RPC" : "SOURCE";
  const encoding = String(headerValue(headers, "content-encoding") ?? "").split(",")[0].trim().toLowerCase();
  let decoded;
  try {
    if (!encoding || encoding === "identity") decoded = buffer;
    else if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(buffer, { maxOutputLength: maxBytes });
    else if (encoding === "deflate") decoded = inflateSync(buffer, { maxOutputLength: maxBytes });
    else if (encoding === "br") decoded = brotliDecompressSync(buffer, { maxOutputLength: maxBytes });
    else throw new ObserverRunError(`${prefix}_ENCODING_UNSUPPORTED`);
  } catch (error) {
    if (error instanceof ObserverRunError) throw error;
    if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new ObserverRunError(`${prefix}_BODY_LIMIT`);
    throw new ObserverRunError(`${prefix}_INVALID_BODY`);
  }
  if (decoded.length > maxBytes) throw new ObserverRunError(`${prefix}_BODY_LIMIT`);
  return decoded;
}

function redactHeaders(headers) {
  const result = {};
  for (const key of Object.keys(headers ?? {})) {
    const lower = key.toLowerCase();
    if (["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "api-key"].includes(lower)) continue;
    result[lower] = "[redacted]";
  }
  return result;
}

function fixedCode(error, fallback = "INTERNAL_ERROR") {
  if (error instanceof ObserverRunError && FIXED_ERROR_CODES.has(error.code)) return error.code;
  if (error instanceof ObserverValidationError && FIXED_ERROR_CODES.has(error.code)) return error.code;
  if (error?.code === "ETIMEDOUT" || error?.code === "UND_ERR_CONNECT_TIMEOUT") return "TIMEOUT";
  if (error?.name === "AbortError") return "TIMEOUT";
  return FIXED_ERROR_CODES.has(fallback) ? fallback : "INTERNAL_ERROR";
}

function statusCodeForError(code) {
  if (code === "RPC_HTTP_429") return 429;
  if (code.startsWith("RPC_HTTP_5")) return Number(code.slice(-3));
  if (code === "SOURCE_HTTP_404") return 404;
  if (code === "SOURCE_HTTP_410") return 410;
  return null;
}

function retryableStatus(statusCode) {
  return RETRYABLE_HTTP_STATUS.has(Number(statusCode));
}

function retryDelayMs(responseHeaders, attempt) {
  const value = Number.parseInt(String(headerValue(responseHeaders, "retry-after") ?? ""), 10);
  if (Number.isFinite(value) && value >= 0) return Math.min(value * 1000, 1000);
  return Math.min(100 * (2 ** attempt), 1000);
}

async function sleepMs(ms, clock = Date) {
  if (clock && typeof clock.sleep === "function") {
    await clock.sleep(ms);
    return;
  }
  if (ms <= 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function getTransport(options, kind) {
  const specific = kind === "rpc" ? options.rpcTransport ?? options.rpcRequest : options.sourceTransport ?? options.sourceRequest;
  if (specific) return specific;
  return options.transport ?? options.request;
}

function requestOnlyHeaders(value) {
  if (isRecord(value) && isRecord(value.headers)) return value.headers;
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.length > 0) return { authorization: `Bearer ${value}` };
  return {};
}

function requestCredentialValues(options, endpoint, kind) {
  const configured = kind === "rpc"
    ? options.rpcHeaders ?? options.rpcAuth?.[endpoint.endpointId] ?? options.rpcAuth?.[endpoint.chainId] ?? options.rpcAuth
    : options.sourceHeaders ?? options.sourceAuth;
  const headers = requestOnlyHeaders(configured);
  const values = Object.entries(headers)
    .filter(([key]) => /auth|token|secret|key|credential|cookie/iu.test(key))
    .flatMap(([, value]) => [String(value), String(value).replace(/^(?:Bearer|Basic|ApiKey)\s+/iu, "")])
    .filter((value) => value.length > 0);
  if (kind === "rpc" && typeof endpoint?.url === "string") {
    try {
      const parsed = new URL(endpoint.url);
      const isDefaultEndpoint = Object.values(DEFAULT_RPC_ENDPOINTS).some((entry) => entry.url === endpoint.url);
      for (const [, value] of parsed.searchParams.entries()) if (value && (!isDefaultEndpoint || value.length >= 8)) values.push(value);
      for (const segment of parsed.pathname.split("/").filter(Boolean)) if (segment && (!isDefaultEndpoint || segment.length >= 8)) values.push(segment);
    } catch {
      // Endpoint URL validation reports the fixed preflight code elsewhere.
    }
  }
  return values;
}

function responseEchoesCredential(value, options, endpoint, kind = "rpc") {
  if (typeof value !== "string") return false;
  return requestCredentialValues(options, endpoint, kind).some((credential) => credential === value || credential.includes(value) || value.includes(credential));
}

function resultEchoesCredential(value, options, endpoint, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") return responseEchoesCredential(value, options, endpoint);
  if (Array.isArray(value)) return value.some((child) => resultEchoesCredential(child, options, endpoint, depth + 1));
  if (isRecord(value)) return Object.values(value).some((child) => resultEchoesCredential(child, options, endpoint, depth + 1));
  return false;
}

async function invokeTransport(transport, request) {
  if (!transport) return requestHttpsTransport(request);
  let result;
  if (typeof transport === "function") result = await (transport.length >= 2 ? transport(request.url, request) : transport(request));
  else if (typeof transport.request === "function") result = await (transport.request.length >= 2 ? transport.request(request.url, request) : transport.request(request));
  else if (request.kind === "rpc" && typeof transport.rpc === "function") result = await transport.rpc(request);
  else if (request.kind === "source" && typeof transport.source === "function") result = await transport.source(request);
  else throw new ObserverRunError("INTERNAL_ERROR");
  return normalizeTransportResponse(result);
}

async function invokeTransportBounded(transport, request, { timeoutMs, deadline, clock }) {
  const remaining = deadline() - nowValue(clock);
  if (remaining <= 0) throw new ObserverRunError("RUN_BUDGET_EXCEEDED");
  const timeout = Math.min(timeoutMs, remaining);
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ObserverRunError(timeout < timeoutMs ? "RUN_BUDGET_EXCEEDED" : "TIMEOUT"));
    }, timeout);
  });
  try {
    return await Promise.race([invokeTransport(transport, { ...request, signal: request.signal ?? controller.signal }), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

function normalizeTransportResponse(result) {
  if (result === undefined || result === null) throw new ObserverRunError("INTERNAL_ERROR");
  const statusCode = Number(result.statusCode ?? result.status ?? 200);
  const headers = headersToObject(result.headers ?? {});
  const body = result.body ?? result.data ?? Buffer.alloc(0);
  const finalUrl = result.finalUrl ?? result.url;
  return { statusCode, headers, body, finalUrl };
}

async function resolvePublicAddress(hostname, resolver, signal = undefined) {
  if (isUnsafeHostname(hostname)) throw new ObserverRunError("UNSAFE_HOST");
  if (signal?.aborted) throw new ObserverRunError("TIMEOUT");
  const lookup = resolver?.lookup ?? resolver?.resolve ?? resolver;
  if (typeof lookup !== "function") throw new ObserverRunError("DNS_RESOLUTION_FAILED");
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    if (signal?.aborted) throw new ObserverRunError("TIMEOUT");
    throw new ObserverRunError("DNS_RESOLUTION_FAILED");
  }
  if (signal?.aborted) throw new ObserverRunError("TIMEOUT");
  if (!Array.isArray(records)) records = [records];
  const normalized = records.map((entry) => typeof entry === "string" ? { address: entry, family: isIP(entry) } : entry).filter((entry) => entry && typeof entry.address === "string");
  if (normalized.length === 0) throw new ObserverRunError("DNS_RESOLUTION_FAILED");
  for (const entry of normalized) {
    const detectedFamily = isIP(entry.address);
    const family = Number(entry.family) || detectedFamily;
    if (!family || (detectedFamily && Number(entry.family) && detectedFamily !== Number(entry.family)) || isPrivateAddress(entry.address, detectedFamily || family)) throw new ObserverRunError("DNS_REBINDING_DETECTED");
  }
  const selected = normalized[0];
  return { address: selected.address, family: Number(selected.family) || isIP(selected.address) };
}

async function requestHttpsTransport(request) {
  const parsed = parseHttpsUrl(request.url, "request.url");
  const resolver = request.resolver ?? { lookup: dnsLookup };
  const pinned = await resolvePublicAddress(parsed.hostname, resolver, request.signal);
  if (request.signal?.aborted) throw new ObserverRunError("TIMEOUT");
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const headers = { ...request.headers, "accept-encoding": "gzip, deflate, br" };
    const req = httpsRequest(parsed, {
      method: request.method ?? "GET",
      hostname: parsed.hostname,
      servername: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers,
      timeout: request.timeoutMs,
      lookup: (_hostname, lookupOptions, callback) => callback(null, lookupOptions?.all ? [{ address: pinned.address, family: pinned.family }] : pinned.address, lookupOptions?.all ? undefined : pinned.family),
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        const next = Buffer.byteLength(chunk);
        length += next;
        if (length > request.compressedBodyLimit) {
          req.destroy(new ObserverRunError(request.bodyLimitCode ?? "SOURCE_BODY_LIMIT"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => finish(resolvePromise, {
        statusCode: response.statusCode ?? 0,
        headers: headersToObject(response.headers),
        body: Buffer.concat(chunks),
        finalUrl: request.url,
      }));
      response.on("error", (error) => finish(reject, error));
    });
    const abort = () => req.destroy(new ObserverRunError("TIMEOUT"));
    cleanup = () => request.signal?.removeEventListener("abort", abort);
    if (request.signal) {
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener("abort", abort, { once: true });
      }
    }
    req.on("timeout", () => req.destroy(new ObserverRunError("TIMEOUT")));
    req.on("error", (error) => finish(reject, error));
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

async function requestWithRetry(requestFactory, {
  maxRetries,
  timeoutMs,
  maxBytes,
  compressedBodyLimit,
  clock,
  deadline,
  kind,
  onResponse = null,
}) {
  let attempt = 0;
  while (true) {
    if (nowValue(clock) >= deadline()) throw new ObserverRunError("RUN_BUDGET_EXCEEDED");
    try {
      const response = await requestFactory({
        timeoutMs,
        compressedBodyLimit,
        bodyLimitCode: kind === "rpc" ? "RPC_BODY_LIMIT" : "SOURCE_BODY_LIMIT",
        attempt,
      });
      if (retryableStatus(response.statusCode) && attempt < maxRetries) {
        await sleepMs(retryDelayMs(response.headers, attempt), clock);
        attempt += 1;
        continue;
      }
      const body = decodeBody(await bodyToBuffer(response.body, compressedBodyLimit, kind), response.headers, maxBytes, kind);
      const normalized = { ...response, body };
      return onResponse ? await onResponse(normalized) : normalized;
    } catch (error) {
      const statusCode = error?.statusCode;
      const retryableCode = ["TIMEOUT", "SOURCE_TIMEOUT", "SOURCE_TRANSPORT_ERROR", "RPC_UNAVAILABLE", "RPC_HTTP_429", "SOURCE_RATE_LIMITED", "SOURCE_UPSTREAM_ERROR"].includes(error?.code);
      const retryable = error?.retryable === true || retryableCode || retryableStatus(statusCode) || error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET" || error?.code === "ECONNREFUSED" || error?.code === "EAI_AGAIN";
      if (retryable && attempt < maxRetries) {
        await sleepMs(Math.min(100 * (2 ** attempt), 1000), clock);
        attempt += 1;
        continue;
      }
      if (error instanceof ObserverRunError) throw error;
      throw new ObserverRunError(kind === "source" ? "SOURCE_TRANSPORT_ERROR" : "RPC_UNAVAILABLE");
    }
  }
}

function httpErrorCode(kind, statusCode) {
  if (kind === "source") {
    if (statusCode === 404) return "SOURCE_HTTP_404";
    if (statusCode === 410) return "SOURCE_HTTP_410";
    if (statusCode === 429) return "SOURCE_RATE_LIMITED";
    if (statusCode >= 500 && statusCode <= 599) return "SOURCE_UPSTREAM_ERROR";
    return "SOURCE_HTTP_ERROR";
  }
  if (statusCode === 429) return "RPC_HTTP_429";
  if (retryableStatus(statusCode)) return `RPC_HTTP_${statusCode}`;
  if (statusCode >= 500 && statusCode <= 599) return "RPC_HTTP_ERROR";
  return "RPC_HTTP_ERROR";
}

async function requestJsonRpc(endpoint, payload, options, deadline) {
  const transport = getTransport(options, "rpc");
  const request = {
    kind: "rpc",
    endpointId: endpoint.endpointId,
    hostname: endpoint.hostname,
    url: endpoint.url,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...requestOnlyHeaders(options.rpcHeaders ?? options.rpcAuth?.[endpoint.endpointId] ?? options.rpcAuth?.[endpoint.chainId] ?? options.rpcAuth),
    },
    body: jsonBody(payload),
    resolver: options.resolver,
  };
  return requestWithRetry(
    (limits) => invokeTransportBounded(transport, { ...request, ...limits }, { deadline, clock: options.clock, timeoutMs: limits.timeoutMs }),
    {
      maxRetries: OBSERVER_LIMITS.rpcRetries,
      timeoutMs: OBSERVER_LIMITS.rpcTimeoutMs,
      maxBytes: OBSERVER_LIMITS.rpcBodyBytes,
      compressedBodyLimit: OBSERVER_LIMITS.rpcBodyBytes * 8,
      clock: options.clock,
      deadline,
      kind: "rpc",
      onResponse: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const code = httpErrorCode("rpc", response.statusCode);
          throw new ObserverRunError(code, code, { retryable: retryableStatus(response.statusCode), statusCode: response.statusCode });
        }
        let parsed;
        try {
          parsed = JSON.parse(response.body.toString("utf8"));
        } catch {
          throw new ObserverRunError("RPC_INVALID_JSON");
        }
        if (!isRecord(parsed)) throw new ObserverRunError("RPC_RESULT_INVALID");
        if (parsed.error !== undefined) {
          const rpcCode = Number(parsed.error?.code);
          const prose = typeof parsed.error?.message === "string" ? parsed.error.message.toLowerCase() : "";
          const transient = [-32000, -32005, -32603].includes(rpcCode) || /temporar|unavailable|timeout|rate.?limit|header.?not.?found|backend|syncing/iu.test(prose);
          throw new ObserverRunError(transient ? "RPC_UNAVAILABLE" : "RPC_ERROR", transient ? "RPC_UNAVAILABLE" : "RPC_ERROR", { retryable: transient });
        }
        if (!Object.hasOwn(parsed, "result")) throw new ObserverRunError("RPC_RESULT_INVALID");
        if (resultEchoesCredential(parsed.result, options, endpoint)) throw new ObserverRunError("RPC_RESULT_INVALID");
        return parsed.result;
      },
    },
  );
}

function assertRpcEndpoint(endpoint, network) {
  if (!isRecord(endpoint)) fail(`rpc.${network} must be an object`, "CONFIG_RPC_INVALID");
  for (const field of ["endpointId", "chainId", "url", "hostname"]) string(endpoint[field], `rpc.${network}.${field}`);
  id(endpoint.endpointId, `rpc.${network}.endpointId`);
  if (endpoint.chainId !== TOKEN_CHAIN_IDS[network]) fail(`rpc.${network}.chainId is not the catalog chain`, "CONFIG_RPC_INVALID");
  const parsed = parseHttpsUrl(endpoint.url, `rpc.${network}.url`, { allowPath: true });
  if (parsed.hostname !== endpoint.hostname.toLowerCase()) fail(`rpc.${network}.hostname does not match its URL`, "CONFIG_RPC_INVALID");
  if (!Array.isArray(endpoint.reviewedHosts) || endpoint.reviewedHosts.length === 0 || endpoint.reviewedHosts.some((host) => typeof host !== "string" || host !== host.toLowerCase() || !HOST_RE.test(host) || isUnsafeHostname(host))) {
    fail(`rpc.${network}.reviewedHosts must list reviewed HTTPS hosts`, "CONFIG_RPC_INVALID");
  }
  if (!endpoint.reviewedHosts.includes(parsed.hostname)) fail(`rpc.${network}.url host is not reviewed`, "CONFIG_RPC_INVALID");
  if (network === "solana") {
    if (endpoint.expectedGenesisHash !== DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash) fail(`rpc.${network}.expectedGenesisHash is invalid`, "CONFIG_RPC_INVALID");
  } else if (endpoint.expectedRpcChainId !== DEFAULT_RPC_ENDPOINTS[network].expectedRpcChainId) {
    fail(`rpc.${network}.expectedRpcChainId is invalid`, "CONFIG_RPC_INVALID");
  }
  return true;
}

function signalValue(signal, label) {
  if (!isRecord(signal)) fail(`${label} must be an object`, "CONFIG_INVALID");
  const actual = Object.keys(signal).sort();
  const expected = ["kind", "literal"].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} keys must be exactly kind, literal`, "CONFIG_INVALID");
  if (!["address", "symbol", "lifecycle-phrase"].includes(signal.kind)) fail(`${label}.kind is invalid`, "CONFIG_INVALID");
  string(signal.literal, `${label}.literal`);
  if (signal.kind === "address") {
    if (!/^0x[0-9a-f]{40}$/iu.test(signal.literal) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(signal.literal)) fail(`${label}.literal is not a reviewed address`, "CONFIG_INVALID");
  }
}

export function validateObserverConfig(config, catalog = CATALOG) {
  validateCatalog(catalog);
  if (!isRecord(config)) fail("observer config must be an object", "CONFIG_INVALID");
  exactKeys(config, ["schemaVersion", "rpc", "sources"], "observer config");
  if (config.schemaVersion !== OBSERVER_SCHEMA_VERSION) fail("observer config schemaVersion must be 1", "CONFIG_INVALID");
  if (!isRecord(config.rpc)) fail("observer config rpc must be an object", "CONFIG_RPC_INVALID");
  if (Object.keys(config.rpc).sort().join(",") !== [...NETWORKS].sort().join(",")) fail("observer config rpc networks are invalid", "CONFIG_RPC_INVALID");
  for (const network of NETWORKS) assertRpcEndpoint(config.rpc[network], network);

  const expectedUrls = sourceUrlsFromCatalog(catalog);
  const sources = asArray(config.sources, "observer config sources");
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const [index, source] of sources.entries()) {
    if (!isRecord(source)) fail(`sources[${index}] must be an object`, "CONFIG_INVALID");
    exactKeys(source, ["sourceId", "url", "allowedFinalUrls", "mode", "format", "signals", "signalsConfidence", "limitations"], `sources[${index}]`);
    id(source.sourceId, `sources[${index}].sourceId`);
    if (seenIds.has(source.sourceId)) fail(`duplicate source ID ${source.sourceId}`, "CONFIG_SOURCE_DUPLICATE");
    seenIds.add(source.sourceId);
    const parsed = parseHttpsUrl(source.url, `sources[${index}].url`);
    if (seenUrls.has(source.url)) fail(`duplicate source URL ${source.url}`, "CONFIG_SOURCE_DUPLICATE");
    seenUrls.add(source.url);
    if (!Array.isArray(source.allowedFinalUrls) || source.allowedFinalUrls.length === 0 || !source.allowedFinalUrls.includes(source.url)) fail(`sources[${index}].allowedFinalUrls must include its source URL`, "CONFIG_INVALID");
    const allowed = new Set();
    for (const [allowedIndex, url] of source.allowedFinalUrls.entries()) {
      const destination = parseHttpsUrl(url, `sources[${index}].allowedFinalUrls[${allowedIndex}]`);
      if (allowed.has(url)) fail(`sources[${index}] repeats an allowed final URL`, "CONFIG_INVALID");
      allowed.add(url);
      if (destination.hostname !== parsed.hostname && source.allowedFinalUrls.length === 1) fail(`sources[${index}] has an invalid final URL allowlist`, "CONFIG_INVALID");
    }
    if (!["static-bytes", "semantic-signals"].includes(source.mode)) fail(`sources[${index}].mode is invalid`, "CONFIG_INVALID");
    if (source.format !== null && source.format !== "json" && source.format !== "text") fail(`sources[${index}].format is invalid`, "CONFIG_INVALID");
    asArray(source.signals, `sources[${index}].signals`);
    source.signals.forEach((signal, signalIndex) => signalValue(signal, `sources[${index}].signals[${signalIndex}]`));
    if (source.mode === "semantic-signals") {
      if (source.signals.length === 0) fail(`sources[${index}] must have reviewed semantic signals`, "CONFIG_INVALID");
      if (source.signalsConfidence !== "limited") fail(`sources[${index}].signalsConfidence must be limited`, "CONFIG_INVALID");
      if (!Array.isArray(source.limitations) || source.limitations.length === 0 || source.limitations.some((entry) => typeof entry !== "string" || entry.length === 0)) fail(`sources[${index}].limitations must be explicit`, "CONFIG_INVALID");
    } else if (source.signalsConfidence !== null || source.limitations !== null) {
      fail(`sources[${index}] static-bytes metadata must use null signal confidence and limitations`, "CONFIG_INVALID");
    }
  }
  if (seenUrls.size !== expectedUrls.size || [...expectedUrls].some((url) => !seenUrls.has(url))) fail("source URL set must exactly equal the catalog evidence URL union", "CONFIG_URL_SET_MISMATCH");
  return true;
}

function normalizeConfig(config, catalog = CATALOG) {
  const effective = structuredClone(config);
  for (const network of NETWORKS) {
    const override = process.env[RPC_ENV_NAMES[network]];
    if (override === undefined || override === "") continue;
    const endpoint = effective.rpc?.[network];
    if (!endpoint || !Array.isArray(endpoint.reviewedHosts)) fail(`environment RPC override for ${network} has no reviewed host allowlist`, "CONFIG_RPC_INVALID");
    const parsed = parseHttpsUrl(override, `${RPC_ENV_NAMES[network]} override`);
    if (!endpoint.reviewedHosts.includes(parsed.hostname)) fail(`environment RPC override for ${network} uses an unreviewed host`, "CONFIG_RPC_INVALID");
    endpoint.url = override;
    endpoint.hostname = parsed.hostname;
  }
  validateObserverConfig(effective, catalog);
  return effective;
}

async function readJsonInput(value, defaultPath, label, { optional = false } = {}) {
  if (value && typeof value === "object") return value;
  const filePath = value ?? defaultPath;
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new ObserverValidationError(`${label} could not be read`, label === "baseline" ? "BASELINE_INVALID" : "CONFIG_INVALID");
  }
}

function normalizeErrorCode(error, kind) {
  if (error instanceof ObserverRunError) return error.code;
  if (error?.code === "ETIMEDOUT") return kind === "source" ? "SOURCE_TIMEOUT" : "TIMEOUT";
  if (error?.code === "ECONNRESET" || error?.code === "EAI_AGAIN") return kind === "source" ? "SOURCE_TRANSPORT_ERROR" : "RPC_UNAVAILABLE";
  return kind === "source" ? "SOURCE_TRANSPORT_ERROR" : "RPC_UNAVAILABLE";
}

function responseJsonErrorCode(kind, statusCode) {
  return httpErrorCode(kind, statusCode);
}

function ensureHex(value, label, { allowEmpty = false, evenLength = true } = {}) {
  if (typeof value !== "string" || !HEX_RE.test(value) || (!allowEmpty && value.length <= 2) || (evenLength && value.length % 2 !== 0)) throw new ObserverRunError(`${label}_INVALID`);
  return value.toLowerCase();
}

function decodeUint256(value, codePrefix) {
  let hex;
  try {
    hex = ensureHex(value, codePrefix);
  } catch {
    throw new ObserverRunError(`${codePrefix}_INVALID`);
  }
  if (hex.length !== 66) throw new ObserverRunError(`${codePrefix}_INVALID`);
  try {
    return Number(BigInt(hex));
  } catch {
    throw new ObserverRunError(`${codePrefix}_INVALID`);
  }
}

function validSymbol(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function boundedScalar(value, maxLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value && !/[\r\n\u0000]/u.test(value) ? value : null;
}

function boundedSolanaOwner(value) {
  const scalar = boundedScalar(value, 64);
  return scalar && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(scalar) ? scalar : null;
}

function boundedParsedType(value) {
  const scalar = boundedScalar(value, 32);
  return scalar && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(scalar) ? scalar : null;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeSymbol(value) {
  let hex;
  try {
    hex = ensureHex(value, "EVM_SYMBOL");
  } catch {
    throw new ObserverRunError("EVM_SYMBOL_INVALID");
  }
  const bytes = Buffer.from(hex.slice(2), "hex");
  let symbol = null;
  if (bytes.length === 32) {
    const zero = bytes.indexOf(0);
    const content = zero < 0 ? bytes : bytes.subarray(0, zero);
    if (zero >= 0 && bytes.subarray(zero).some((byte) => byte !== 0)) throw new ObserverRunError("EVM_SYMBOL_INVALID");
    symbol = decodeUtf8(content);
  } else if (bytes.length >= 64) {
    const offset = Number(BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`));
    if (offset !== 32 || offset + 32 > bytes.length) throw new ObserverRunError("EVM_SYMBOL_INVALID");
    const length = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`));
    if (!Number.isSafeInteger(length) || length < 1 || offset + 32 + length > bytes.length) throw new ObserverRunError("EVM_SYMBOL_INVALID");
    symbol = decodeUtf8(bytes.subarray(offset + 32, offset + 32 + length));
  }
  if (!validSymbol(symbol)) throw new ObserverRunError("EVM_SYMBOL_INVALID");
  return symbol;
}

function canonicalReceiptDeployment(deployment, status, verification, extras = {}) {
  return {
    deploymentId: deployment.deploymentId,
    chainId: deployment.chainId,
    standard: deployment.standard,
    address: deployment.address,
    status,
    verification,
    ...extras,
  };
}

function skippedDeployment(deployment, code, verification = "skipped") {
  return canonicalReceiptDeployment(deployment, "skipped", verification, { errorCode: code });
}

function failedDeployment(deployment, code, verification = "rpc", extras = {}) {
  return canonicalReceiptDeployment(deployment, "failed", verification, { errorCode: code, ...extras });
}

function successfulDeployment(deployment, verification, extras = {}) {
  return canonicalReceiptDeployment(deployment, "success", verification, { errorCode: null, ...extras });
}

function networkReceipt(network, endpoint, status, extras = {}) {
  return {
    network,
    chainId: endpoint.chainId,
    endpointId: endpoint.endpointId,
    hostname: endpoint.hostname,
    status,
    ...extras,
  };
}

async function mapLimitOrdered(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        result[index] = await worker(items[index], index);
      } catch (error) {
        result[index] = { __error: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return result;
}

function rpcPayload(idValue, method, params) {
  return { jsonrpc: "2.0", id: idValue, method, params };
}

function deploymentSort(left, right) {
  return left.deploymentId < right.deploymentId ? -1 : left.deploymentId > right.deploymentId ? 1 : 0;
}

async function observeEvmNetwork(network, deployments, endpoint, options, deadline, sequence, catalog = CATALOG) {
  let identity;
  try {
    const result = await requestJsonRpc(endpoint, rpcPayload(sequence(), "eth_chainId", []), options, deadline);
    identity = typeof result === "string" ? result.toLowerCase() : null;
    if (identity !== endpoint.expectedRpcChainId) throw new ObserverRunError("NETWORK_IDENTITY_MISMATCH");
  } catch (error) {
    const code = normalizeErrorCode(error, "rpc");
    return {
      network: networkReceipt(network, endpoint, "failed", { errorCode: code }),
      deployments: deployments.map((deployment) => skippedDeployment(deployment, code, deployment.standard === "native" ? "protocol-declared" : "rpc")),
    };
  }

  let blockNumber;
  try {
    const result = await requestJsonRpc(endpoint, rpcPayload(sequence(), "eth_blockNumber", []), options, deadline);
    blockNumber = ensureHex(result, "EVM_BLOCK_NUMBER", { evenLength: false });
  } catch (error) {
    const code = normalizeErrorCode(error, "rpc");
    return {
      network: networkReceipt(network, endpoint, "failed", { errorCode: code }),
      deployments: deployments.map((deployment) => skippedDeployment(deployment, code, deployment.standard === "native" ? "protocol-declared" : "rpc")),
    };
  }

  const nonNative = deployments.filter((deployment) => deployment.standard !== "native");
  const unclassified = new Set(catalog.assets.filter((asset) => asset.representationKind === "unclassified").map((asset) => asset.assetId));
  const observed = await mapLimitOrdered(nonNative, OBSERVER_LIMITS.concurrency, async (deployment) => {
    try {
      const codeResult = await requestJsonRpc(endpoint, rpcPayload(sequence(), "eth_getCode", [deployment.address, blockNumber]), options, deadline);
      let codeHex;
      try {
        codeHex = ensureHex(codeResult, "EVM_CODE", { allowEmpty: true });
      } catch {
        return failedDeployment(deployment, "EVM_CODE_INVALID", "rpc", { codeNonEmpty: false });
      }
      if (codeHex === "0x") return failedDeployment(deployment, "EVM_EMPTY_CODE", "rpc", { codeNonEmpty: false });
      if (codeHex.length < 4) return failedDeployment(deployment, "EVM_CODE_INVALID", "rpc", { codeNonEmpty: false });
      const decimalsResult = await requestJsonRpc(endpoint, rpcPayload(sequence(), "eth_call", [{ to: deployment.address, data: "0x313ce567" }, blockNumber]), options, deadline);
      const decimals = decodeUint256(decimalsResult, "EVM_DECIMALS");
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return failedDeployment(deployment, "EVM_DECIMALS_OUT_OF_RANGE", "rpc", { codeNonEmpty: true, observedDecimals: Number.isSafeInteger(decimals) ? decimals : null });
      if (unclassified.has(deployment.assetId)) {
        // Discovery admits address-only records as unclassified.  RPC code and
        // decimals are sufficient to keep those records operational; asking
        // for a symbol would turn an optional issuer signal into a false
        // failure and could echo untrusted response text.
        if (decimals !== deployment.decimals) return failedDeployment(deployment, "EVM_DECIMALS_MISMATCH", "rpc", { codeNonEmpty: true, observedDecimals: decimals });
        return successfulDeployment(deployment, "rpc", { blockNumber, codeNonEmpty: true, decimals, symbol: deployment.symbol, symbolSource: "address-only" });
      }
      const symbolResult = await requestJsonRpc(endpoint, rpcPayload(sequence(), "eth_call", [{ to: deployment.address, data: "0x95d89b41" }, blockNumber]), options, deadline);
      const symbol = decodeSymbol(symbolResult);
      if (responseEchoesCredential(symbol, options, endpoint)) throw new ObserverRunError("EVM_SYMBOL_INVALID");
      if (decimals !== deployment.decimals) return failedDeployment(deployment, "EVM_DECIMALS_MISMATCH", "rpc", { codeNonEmpty: true, observedDecimals: decimals, observedSymbol: symbol });
      if (symbol !== deployment.symbol) return failedDeployment(deployment, "EVM_SYMBOL_MISMATCH", "rpc", { codeNonEmpty: true, observedDecimals: decimals, observedSymbol: symbol });
      return successfulDeployment(deployment, "rpc", { blockNumber, codeNonEmpty: true, decimals, symbol });
    } catch (error) {
      const code = normalizeErrorCode(error, "rpc");
      return failedDeployment(deployment, code);
    }
  });
  const byId = new Map(observed.map((entry, index) => [nonNative[index].deploymentId, entry?.__error ? failedDeployment(nonNative[index], normalizeErrorCode(entry.__error, "rpc")) : entry]));
  const rows = deployments.map((deployment) => deployment.standard === "native"
    ? successfulDeployment(deployment, "protocol-declared", { networkIdentity: endpoint.expectedRpcChainId })
    : byId.get(deployment.deploymentId));
  return {
    network: networkReceipt(network, endpoint, "success", { rpcChainId: endpoint.expectedRpcChainId, blockNumber }),
    deployments: rows,
  };
}

function solanaOwnerForStandard(standard) {
  if (standard === "spl-token") return TOKEN_PROGRAM_IDS.splToken;
  if (standard === "spl-token-2022") return TOKEN_PROGRAM_IDS.splToken2022;
  return null;
}

async function observeSolanaNetwork(deployments, endpoint, options, deadline, sequence) {
  try {
    const genesis = await requestJsonRpc(endpoint, rpcPayload(sequence(), "getGenesisHash", []), options, deadline);
    if (genesis !== endpoint.expectedGenesisHash) throw new ObserverRunError("NETWORK_IDENTITY_MISMATCH");
  } catch (error) {
    const code = normalizeErrorCode(error, "rpc");
    return {
      network: networkReceipt("solana", endpoint, "failed", { errorCode: code }),
      deployments: deployments.map((deployment) => skippedDeployment(deployment, code, deployment.standard === "native" ? "protocol-declared" : "rpc-account-info")),
    };
  }

  let anchorSlot;
  try {
    const slot = await requestJsonRpc(endpoint, rpcPayload(sequence(), "getSlot", [{ commitment: "finalized" }]), options, deadline);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new ObserverRunError("SOLANA_SLOT_INVALID");
    anchorSlot = slot;
  } catch (error) {
    const code = normalizeErrorCode(error, "rpc");
    return {
      network: networkReceipt("solana", endpoint, "failed", { errorCode: code }),
      deployments: deployments.map((deployment) => skippedDeployment(deployment, code, deployment.standard === "native" ? "protocol-declared" : "rpc-account-info")),
    };
  }

  const nonNative = deployments.filter((deployment) => deployment.standard !== "native");
  const observed = await mapLimitOrdered(nonNative, OBSERVER_LIMITS.concurrency, async (deployment) => {
    try {
      const result = await requestJsonRpc(endpoint, rpcPayload(sequence(), "getAccountInfo", [deployment.address, {
        commitment: "finalized",
        encoding: "jsonParsed",
        minContextSlot: anchorSlot,
      }]), options, deadline);
      if (!isRecord(result) || !isRecord(result.context) || !Number.isSafeInteger(result.context.slot)) throw new ObserverRunError("SOLANA_CONTEXT_SLOT_INVALID");
      if (result.context.slot < anchorSlot) throw new ObserverRunError("SOLANA_CONTEXT_SLOT_BELOW_ANCHOR");
      if (!isRecord(result.value)) throw new ObserverRunError("SOLANA_ACCOUNT_INVALID");
      const expectedOwner = solanaOwnerForStandard(deployment.standard);
      const owner = boundedSolanaOwner(result.value.owner);
      if (owner === null) return failedDeployment(deployment, "SOLANA_OWNER_INVALID", "rpc-account-info");
      if (responseEchoesCredential(owner, options, endpoint)) return failedDeployment(deployment, "SOLANA_OWNER_INVALID", "rpc-account-info");
      if (owner !== expectedOwner) return failedDeployment(deployment, "SOLANA_STANDARD_MISMATCH", "rpc-account-info", { owner });
      const parsed = result.value.data?.parsed;
      if (!isRecord(parsed) || parsed.type !== "mint") {
        const parsedType = isRecord(parsed) ? boundedParsedType(parsed.type) : null;
        return responseEchoesCredential(parsedType, options, endpoint)
          ? failedDeployment(deployment, "SOLANA_PARSED_TYPE_INVALID", "rpc-account-info", { owner })
          : failedDeployment(deployment, "SOLANA_PARSED_TYPE_INVALID", "rpc-account-info", { owner, parsedType });
      }
      const decimals = parsed.info?.decimals;
      if (!Number.isInteger(decimals)) return failedDeployment(deployment, "SOLANA_DECIMALS_INVALID", "rpc-account-info", { owner, parsedType: "mint", observedDecimals: null });
      if (decimals < 0 || decimals > 255) return failedDeployment(deployment, "SOLANA_DECIMALS_OUT_OF_RANGE", "rpc-account-info", { owner, parsedType: "mint", observedDecimals: Number.isSafeInteger(decimals) ? decimals : null });
      if (decimals !== deployment.decimals) return failedDeployment(deployment, "SOLANA_DECIMALS_MISMATCH", "rpc-account-info", { owner, parsedType: "mint", observedDecimals: Number.isSafeInteger(decimals) ? decimals : null });
      return successfulDeployment(deployment, "rpc-account-info", {
        anchorSlot,
        contextSlot: result.context.slot,
        owner,
        parsedType: parsed.type,
        decimals,
        symbolSource: "catalog-protocol",
      });
    } catch (error) {
      return failedDeployment(deployment, normalizeErrorCode(error, "rpc"), "rpc-account-info");
    }
  });
  const byId = new Map(observed.map((entry, index) => [nonNative[index].deploymentId, entry?.__error ? failedDeployment(nonNative[index], normalizeErrorCode(entry.__error, "rpc"), "rpc-account-info") : entry]));
  const rows = deployments.map((deployment) => deployment.standard === "native"
    ? successfulDeployment(deployment, "protocol-declared", { networkIdentity: endpoint.expectedGenesisHash })
    : byId.get(deployment.deploymentId));
  return {
    network: networkReceipt("solana", endpoint, "success", { genesisHash: endpoint.expectedGenesisHash, anchorSlot }),
    deployments: rows,
  };
}

function sourceSignalPresent(body, signal) {
  const textBody = body.toString("utf8");
  if (signal.kind === "address") {
    const evmAddress = /^0x[0-9a-f]{40}$/iu.test(signal.literal);
    return evmAddress ? textBody.toLowerCase().includes(signal.literal.toLowerCase()) : textBody.includes(signal.literal);
  }
  return textBody.toLocaleLowerCase().includes(signal.literal.toLocaleLowerCase());
}

function sourceFingerprint(source, body) {
  if (source.mode === "static-bytes") return createHash("sha256").update(body).digest("hex");
  const signals = source.signals.map((signal) => ({
    kind: signal.kind,
    literal: signal.literal,
    present: sourceSignalPresent(body, signal),
  }));
  return createHash("sha256").update(stableStringify({ mode: source.mode, signals })).digest("hex");
}

function sourceSignalSummary(source, body) {
  return source.signals.map((signal) => ({
    kind: signal.kind,
    present: sourceSignalPresent(body, signal),
  }));
}

function sourceReceipt(source, status, extras = {}) {
  return {
    sourceId: source.sourceId,
    hostname: new URL(source.url).hostname,
    mode: source.mode,
    status,
    ...extras,
  };
}

async function requestSource(source, options, deadline) {
  let currentUrl = source.url;
  let redirects = 0;
  const allowed = new Set(source.allowedFinalUrls);
  while (true) {
    if (!allowed.has(currentUrl)) throw new ObserverRunError("SOURCE_INVALID_REDIRECT");
    const parsed = parseHttpsUrl(currentUrl, "source.url");
    const response = await requestWithRetry(
      (limits) => invokeTransportBounded(getTransport(options, "source"), {
        kind: "source",
        sourceId: source.sourceId,
        hostname: parsed.hostname,
        url: currentUrl,
        method: "GET",
        headers: { accept: "text/html,application/json,text/plain;q=0.9", ...requestOnlyHeaders(options.sourceHeaders ?? options.sourceAuth) },
        resolver: options.resolver,
        ...limits,
      }, { deadline, clock: options.clock, timeoutMs: limits.timeoutMs }),
      {
        maxRetries: OBSERVER_LIMITS.sourceRetries,
        timeoutMs: OBSERVER_LIMITS.sourceTimeoutMs,
        maxBytes: OBSERVER_LIMITS.sourceBodyBytes,
        compressedBodyLimit: OBSERVER_LIMITS.sourceBodyBytes * 8,
        clock: options.clock,
        deadline,
        kind: "source",
      },
    );
    const finalUrl = response.finalUrl ?? currentUrl;
    if (finalUrl !== currentUrl && !allowed.has(finalUrl)) throw new ObserverRunError("SOURCE_INVALID_REDIRECT");
    if (REDIRECT_STATUS.has(response.statusCode)) {
      if (redirects >= OBSERVER_LIMITS.maxRedirects) throw new ObserverRunError("SOURCE_REDIRECT_LIMIT");
      const location = headerValue(response.headers, "location");
      if (typeof location !== "string" || location.length === 0) throw new ObserverRunError("SOURCE_INVALID_REDIRECT");
      let destination;
      try {
        destination = new URL(location, currentUrl).toString();
      } catch {
        throw new ObserverRunError("SOURCE_INVALID_REDIRECT");
      }
      parseHttpsUrl(destination, "source.redirect");
      if (!allowed.has(destination)) throw new ObserverRunError("SOURCE_INVALID_REDIRECT");
      currentUrl = destination;
      redirects += 1;
      continue;
    }
    return { ...response, finalUrl: finalUrl === currentUrl ? currentUrl : finalUrl, redirects };
  }
}

async function observeSources(config, options, deadline, baseline) {
  const records = await mapLimitOrdered(config.sources, OBSERVER_LIMITS.concurrency, async (source) => {
    try {
      const response = await requestSource(source, options, deadline);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const code = responseJsonErrorCode("source", response.statusCode);
        const transientAccess = response.statusCode === 401 || response.statusCode === 403;
        return sourceReceipt(source, ACTIONABLE_SOURCE_STATUS.has(response.statusCode) ? "failed" : transientAccess || retryableStatus(response.statusCode) ? "partial" : "failed", {
          httpStatus: response.statusCode,
          errorCode: code,
          finalUrl: response.finalUrl === source.url ? undefined : response.finalUrl,
        });
      }
      const bodySha256 = createHash("sha256").update(response.body).digest("hex");
      if (source.mode === "static-bytes" && source.format === "json") {
        try {
          JSON.parse(response.body.toString("utf8"));
        } catch {
          return sourceReceipt(source, "failed", { httpStatus: response.statusCode, bodySha256, errorCode: "SOURCE_PARSE_ERROR" });
        }
      }
      const fingerprint = sourceFingerprint(source, response.body);
      const signals = source.mode === "semantic-signals" ? sourceSignalSummary(source, response.body) : null;
      if (source.mode === "semantic-signals" && signals.every((signal) => signal.present === false)) {
        return sourceReceipt(source, "failed", { httpStatus: response.statusCode, bodySha256, fingerprint, errorCode: "SOURCE_NOT_USABLE" });
      }
      const result = sourceReceipt(source, "success", {
        httpStatus: response.statusCode,
        bodySha256,
        fingerprint,
        finalUrl: response.finalUrl,
        redirects: response.redirects,
      });
      if (signals) result.signalCount = signals.length;
      return result;
    } catch (error) {
      const code = normalizeErrorCode(error, "source");
      const transient = ["SOURCE_TIMEOUT", "SOURCE_RATE_LIMITED", "SOURCE_UPSTREAM_ERROR", "SOURCE_TRANSPORT_ERROR", "TIMEOUT", "RPC_HTTP_429"].includes(code);
      return sourceReceipt(source, transient ? "partial" : "failed", {
        errorCode: code,
      });
    }
  });
  return records;
}

function findingsKey(finding) {
  return `${finding.category}\u0000${finding.subjectId}`;
}

function stableFinding({ category, subjectId, fingerprint, code, severity = "review" }) {
  return { category, subjectId, fingerprint, code, severity };
}

function sourceChangeFingerprint(record) {
  return createHash("sha256").update(stableStringify({ sourceId: record.sourceId, fingerprint: record.fingerprint, finalUrl: record.finalUrl, mode: record.mode })).digest("hex");
}

function sourceUnavailableFingerprint(record) {
  return createHash("sha256").update(stableStringify({ sourceId: record.sourceId, code: record.errorCode })).digest("hex");
}

function networkIdentityFingerprint(record) {
  return createHash("sha256").update(stableStringify({ category: "network-identity", subjectId: record.network, code: record.errorCode, chainId: record.chainId, endpointId: record.endpointId })).digest("hex");
}

function bootstrapFingerprint(sourceRecords) {
  return createHash("sha256").update(stableStringify(sourceRecords.map((source) => ({ sourceId: source.sourceId, fingerprint: source.fingerprint, mode: source.mode, finalUrl: source.finalUrl })))).digest("hex");
}

function rpcFindingFingerprint(record, expected) {
  const observed = Object.fromEntries(["codeNonEmpty", "observedDecimals", "observedSymbol", "owner", "parsedType"].filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
  return createHash("sha256").update(stableStringify({ category: "rpc-observation", subjectId: record.deploymentId, code: record.errorCode, expected: expected ? { chainId: expected.chainId, standard: expected.standard, decimals: expected.decimals, symbol: expected.symbol } : null, observed })).digest("hex");
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const lk = `${left.category}\u0000${left.subjectId}\u0000${left.fingerprint}`;
    const rk = `${right.category}\u0000${right.subjectId}\u0000${right.fingerprint}`;
    return lk < rk ? -1 : lk > rk ? 1 : 0;
  });
}

function validateStableFinding(finding, label = "finding") {
  if (!isRecord(finding)) fail(`${label} must be an object`, "ARTIFACT_INVALID");
  const keys = Object.keys(finding);
  if (keys.some((key) => FORBIDDEN_FINDING_KEYS.has(key))) fail(`${label} contains volatile field`, "ARTIFACT_INVALID");
  if (keys.sort().join(",") !== ["category", "code", "fingerprint", "severity", "subjectId"].join(",")) fail(`${label} keys are not stable`, "ARTIFACT_INVALID");
  for (const required of ["category", "subjectId", "fingerprint", "code", "severity"]) if (!Object.hasOwn(finding, required)) fail(`${label}.${required} is required`, "ARTIFACT_INVALID");
  string(finding.category, `${label}.category`);
  if (!FINDING_CATEGORIES.has(finding.category)) fail(`${label}.category is not recognized`, "ARTIFACT_INVALID");
  string(finding.subjectId, `${label}.subjectId`);
  digest(finding.fingerprint, `${label}.fingerprint`);
  if (!FIXED_ERROR_CODES.has(finding.code) && !/^SOURCE_[A-Z0-9_]+$/u.test(finding.code)) fail(`${label}.code is not fixed`, "ARTIFACT_INVALID");
  if (!["info", "review", "action"].includes(finding.severity)) fail(`${label}.severity is invalid`, "ARTIFACT_INVALID");
  return true;
}

function normalizePriorFindings(value) {
  if (value === null || value === undefined) return { schemaVersion: OBSERVER_SCHEMA_VERSION, status: "complete", catalogDigest: null, configDigest: null, findings: [] };
  if (Array.isArray(value)) value = { findings: value };
  if (!isRecord(value) || !Array.isArray(value.findings)) throw new ObserverValidationError("prior findings are invalid", "PREVIOUS_FINDINGS_INVALID");
  for (const [index, finding] of value.findings.entries()) validateStableFinding(finding, `prior.findings[${index}]`);
  return value;
}

function normalizeBaseline(value, config) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.schemaVersion !== OBSERVER_SCHEMA_VERSION || !Array.isArray(value.sources)) throw new ObserverValidationError("baseline is invalid", "BASELINE_INVALID");
  const expectedIds = new Set(config.sources.map((source) => source.sourceId));
  const baselineForbiddenKeys = new Set(["body", "bodySha256", "rawBody", "observedAt", "observationTime", "timestamp", "requestId", "retry", "errorProse"]);
  if (Object.keys(value).some((key) => baselineForbiddenKeys.has(key))) throw new ObserverValidationError("baseline contains volatile or retained-body data", "BASELINE_INVALID");
  const configById = new Map(config.sources.map((source) => [source.sourceId, source]));
  const seen = new Set();
  for (const [index, source] of value.sources.entries()) {
    if (!isRecord(source)) throw new ObserverValidationError(`baseline.sources[${index}] is invalid`, "BASELINE_INVALID");
    if (Object.keys(source).some((key) => baselineForbiddenKeys.has(key))) throw new ObserverValidationError(`baseline.sources[${index}] contains volatile or retained-body data`, "BASELINE_INVALID");
    const actualKeys = Object.keys(source).sort();
    if (actualKeys.join(",") !== ["approvedFinalUrls", "fingerprint", "mode", "sourceId"].sort().join(",")) throw new ObserverValidationError(`baseline.sources[${index}] keys are invalid`, "BASELINE_INVALID");
    for (const key of ["sourceId", "fingerprint", "mode", "approvedFinalUrls"]) if (!Object.hasOwn(source, key)) throw new ObserverValidationError(`baseline.sources[${index}] missing ${key}`, "BASELINE_INVALID");
    id(source.sourceId, `baseline.sources[${index}].sourceId`);
    digest(source.fingerprint, `baseline.sources[${index}].fingerprint`);
    if (!["static-bytes", "semantic-signals"].includes(source.mode)) throw new ObserverValidationError(`baseline.sources[${index}].mode invalid`, "BASELINE_INVALID");
    if (!Array.isArray(source.approvedFinalUrls) || source.approvedFinalUrls.length === 0) throw new ObserverValidationError(`baseline.sources[${index}].approvedFinalUrls invalid`, "BASELINE_INVALID");
    source.approvedFinalUrls.forEach((url) => {
      parseHttpsUrl(url, `baseline.sources[${index}].approvedFinalUrls`);
      if (!configById.get(source.sourceId)?.allowedFinalUrls.includes(url)) throw new ObserverValidationError(`baseline.sources[${index}] includes an unapproved final URL`, "BASELINE_INVALID");
    });
    if (!expectedIds.has(source.sourceId) || seen.has(source.sourceId)) throw new ObserverValidationError("baseline source IDs do not match config", "BASELINE_INVALID");
    seen.add(source.sourceId);
  }
  if (seen.size !== expectedIds.size) throw new ObserverValidationError("baseline must cover every configured source", "BASELINE_INVALID");
  return value;
}

function sourceFindings(sourceRecords, config, baseline) {
  const baselineById = new Map((baseline?.sources ?? []).map((source) => [source.sourceId, source]));
  const configById = new Map(config.sources.map((source) => [source.sourceId, source]));
  const findings = [];
  for (const record of sourceRecords) {
    const base = baselineById.get(record.sourceId);
    if (record.status === "success" && base) {
      if (record.fingerprint !== base.fingerprint || !base.approvedFinalUrls.includes(record.finalUrl)) {
        const fingerprint = sourceChangeFingerprint(record);
        findings.push(stableFinding({ category: "source-change", subjectId: record.sourceId, fingerprint, code: "SOURCE_SIGNALS_CHANGED", severity: "review" }));
      }
    } else if (record.status === "failed" && (record.errorCode === "SOURCE_HTTP_404" || record.errorCode === "SOURCE_HTTP_410" || record.errorCode === "SOURCE_NOT_USABLE" || record.errorCode === "SOURCE_PARSE_ERROR")) {
      const fingerprint = sourceUnavailableFingerprint(record);
      findings.push(stableFinding({ category: "source-unavailable", subjectId: record.sourceId, fingerprint, code: record.errorCode, severity: "action" }));
    }
  }
  return findings;
}

function networkFindings(networkRecords) {
  return networkRecords.filter((record) => record.status === "failed" && ["NETWORK_IDENTITY_MISMATCH", "NETWORK_IDENTITY_INVALID"].includes(record.errorCode)).map((record) => stableFinding({
    category: "network-identity",
    subjectId: record.network,
    fingerprint: networkIdentityFingerprint(record),
    code: record.errorCode,
    severity: "action",
  }));
}

function rpcFindings(deploymentRecords, catalog = CATALOG) {
  const findings = [];
  for (const record of deploymentRecords) {
    if (record.status !== "failed") continue;
    const actionable = [
      "NETWORK_IDENTITY_MISMATCH",
      "EVM_EMPTY_CODE",
      "EVM_CODE_INVALID",
      "EVM_DECIMALS_INVALID",
      "EVM_DECIMALS_OUT_OF_RANGE",
      "EVM_DECIMALS_MISMATCH",
      "EVM_SYMBOL_INVALID",
      "EVM_SYMBOL_MISMATCH",
      "EVM_CALL_FAILED",
      "SOLANA_ACCOUNT_INVALID",
      "SOLANA_CONTEXT_SLOT_INVALID",
      "SOLANA_CONTEXT_SLOT_BELOW_ANCHOR",
      "SOLANA_OWNER_INVALID",
      "SOLANA_STANDARD_MISMATCH",
      "SOLANA_PARSED_TYPE_INVALID",
      "SOLANA_DECIMALS_INVALID",
      "SOLANA_DECIMALS_OUT_OF_RANGE",
      "SOLANA_DECIMALS_MISMATCH",
    ].includes(record.errorCode);
    if (!actionable) continue;
    const expected = catalog.deployments.find((deployment) => deployment.deploymentId === record.deploymentId);
    const fingerprint = rpcFindingFingerprint(record, expected);
    findings.push(stableFinding({ category: "rpc-observation", subjectId: record.deploymentId, fingerprint, code: record.errorCode, severity: "action" }));
  }
  return findings;
}

function carryPriorFindings(prior, currentFindings, receipts, sourceRecords) {
  const successfulDeployments = new Set(receipts.deployments.filter((record) => record.status === "success").map((record) => record.deploymentId));
  const successfulSources = new Set(sourceRecords.filter((record) => record.status === "success").map((record) => record.sourceId));
  const successfulNetworks = new Set(receipts.networks.filter((record) => record.status === "success").map((record) => record.network));
  const currentKeys = new Set(currentFindings.map(findingsKey));
  const output = [...currentFindings];
  for (const finding of prior.findings ?? []) {
    if (currentKeys.has(findingsKey(finding))) continue;
    const isDeployment = successfulDeployments.has(finding.subjectId);
    const isSource = successfulSources.has(finding.subjectId);
    const isNetwork = successfulNetworks.has(finding.subjectId);
    if (!isDeployment && !isSource && !isNetwork) output.push(finding);
  }
  return sortFindings(output);
}

function candidateFor({ sourceRecords, findings, currentFindings = findings, baseline, config, receipts, sourceSha, catalogDigest, configDigest, workspace }) {
  const requiredSourcesUsable = sourceRecords.length === config.sources.length && sourceRecords.every((source) => source.status === "success");
  const baselineMissing = baseline === null;
  const eligibleBootstrap = baselineMissing && requiredSourcesUsable && receipts.status === "complete";
  const proposals = [];
  for (const finding of currentFindings) {
    proposals.push({
      category: finding.category,
      subjectId: finding.subjectId,
      fingerprint: finding.fingerprint,
      reasonCode: finding.code,
      manualReview: "Review the cited evidence and decide whether a human-approved registry change is warranted.",
    });
  }
  if (eligibleBootstrap) {
    proposals.push({
      category: "source-baseline-bootstrap",
      subjectId: "observer-sources",
      fingerprint: bootstrapFingerprint(sourceRecords),
      reasonCode: "BASELINE_MISSING",
      manualReview: "Review every usable source record, then a human may write registry/source-baseline.json.",
    });
  }
  const partial = receipts.status === "partial" || sourceRecords.some((source) => source.status === "partial");
  const actionRequired = currentFindings.length > 0 || eligibleBootstrap;
  return {
    schemaVersion: OBSERVER_SCHEMA_VERSION,
    artifactKind: "maintenance-review-candidate",
    status: partial ? "partial" : actionRequired ? "review" : "complete",
    sourceSha,
    catalogDigest,
    configDigest,
    workspace: { clean: workspace.clean, pinned: workspace.pinned, promotable: workspace.clean && workspace.pinned },
    baseline: { present: !baselineMissing, eligibleBootstrap },
    actionRequired,
    proposals,
    manualReviewInstructions: [
      "Treat source changes as review evidence only.",
      "Do not infer issuer, lifecycle, economics, authenticity, ranking, or new assets from this observer.",
      "A human owns any write to registry/maintenance-findings.json, registry/source-baseline.json, or registry/evidence/maintenance-review files.",
    ],
  };
}

function artifactStatus(networks, sourceRecords, deploymentRecords = []) {
  const anyPartial = networks.some((network) => network.status === "partial" || network.status === "failed" && !["NETWORK_IDENTITY_MISMATCH", "NETWORK_IDENTITY_INVALID"].includes(network.errorCode))
    || sourceRecords.some((source) => source.status !== "success")
    || deploymentRecords.some((deployment) => deployment.status === "skipped" || deployment.status === "failed" && (String(deployment.errorCode).startsWith("RPC_") || ["TIMEOUT", "SOLANA_CONTEXT_SLOT_INVALID", "SOLANA_CONTEXT_SLOT_BELOW_ANCHOR"].includes(deployment.errorCode)));
  return anyPartial ? "partial" : "complete";
}

function repositoryState(options) {
  if (isRecord(options.workspace)) return {
    clean: options.workspace.clean !== false,
    pinned: options.workspace.pinned !== false,
  };
  if (Object.hasOwn(options, "dirty") || Object.hasOwn(options, "pinnedCheckout")) return {
    clean: options.dirty !== true,
    pinned: options.pinnedCheckout !== false,
  };
  return { clean: true, pinned: true };
}

async function resolveRepositoryState(options) {
  if (isRecord(options.workspace) || Object.hasOwn(options, "dirty") || Object.hasOwn(options, "pinnedCheckout")) return repositoryState(options);
  try {
    const result = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: options.cwd ?? process.cwd() });
    return { clean: result.stdout.trim().length === 0, pinned: true };
  } catch {
    return { clean: false, pinned: false };
  }
}

async function defaultSourceSha(options) {
  if (options.sourceSha) return options.sourceSha;
  if (process.env.ERPC_OBSERVER_SOURCE_SHA) return process.env.ERPC_OBSERVER_SOURCE_SHA;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: options.cwd ?? process.cwd() });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function buildReceipts({ sourceShaValue, catalog, config, configDigestValue, networks, deployments, sourceRecords, status, workspace }) {
  return {
    schemaVersion: OBSERVER_SCHEMA_VERSION,
    artifactKind: "observation-receipts",
    status,
    sourceSha: sourceShaValue,
    catalogDigest: catalog.contentDigest,
    configDigest: configDigestValue,
    workspace: { clean: workspace.clean, pinned: workspace.pinned, promotable: workspace.clean && workspace.pinned },
    networks: networks.sort((left, right) => left.network < right.network ? -1 : left.network > right.network ? 1 : 0),
    deployments: deployments.sort(deploymentSort),
    sources: sourceRecords.sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
  };
}

function exactOptionalKeys(value, required, optional, label) {
  if (!isRecord(value)) fail(`${label} must be an object`, "ARTIFACT_INVALID");
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains an unknown field`, "ARTIFACT_INVALID");
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`, "ARTIFACT_INVALID");
}

function validBlock(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/u.test(value)) fail(`${label} is not a block hex value`, "ARTIFACT_INVALID");
}

function validSlot(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is not a valid slot`, "ARTIFACT_INVALID");
}

function validateFailedDeploymentPredicate(receipt, deployment, unclassified = false) {
  if (receipt.status !== "failed") return;
  const code = receipt.errorCode;
  if (code === "EVM_EMPTY_CODE" || code === "EVM_CODE_INVALID") {
    if (receipt.codeNonEmpty !== false) fail(`failed EVM receipt ${receipt.deploymentId} does not prove empty/invalid code`, "ARTIFACT_INVALID");
  } else if (code === "EVM_DECIMALS_OUT_OF_RANGE") {
    if (receipt.observedDecimals !== null && (!Number.isInteger(receipt.observedDecimals) || receipt.observedDecimals >= 0 && receipt.observedDecimals <= 255)) fail(`failed EVM receipt ${receipt.deploymentId} does not prove out-of-range decimals`, "ARTIFACT_INVALID");
  } else if (code === "EVM_DECIMALS_MISMATCH") {
    if (!Number.isInteger(receipt.observedDecimals) || receipt.observedDecimals === deployment.decimals) fail(`failed EVM receipt ${receipt.deploymentId} does not prove a decimals mismatch`, "ARTIFACT_INVALID");
  } else if (code === "EVM_SYMBOL_MISMATCH") {
    if (unclassified) fail(`unclassified EVM receipt ${receipt.deploymentId} may not require a symbol mismatch`, "ARTIFACT_INVALID");
    if (!validSymbol(receipt.observedSymbol) || receipt.observedSymbol === deployment.symbol) fail(`failed EVM receipt ${receipt.deploymentId} does not prove a symbol mismatch`, "ARTIFACT_INVALID");
  } else if (code === "SOLANA_STANDARD_MISMATCH") {
    const expectedOwner = deployment.standard === "spl-token" ? TOKEN_PROGRAM_IDS.splToken : TOKEN_PROGRAM_IDS.splToken2022;
    if (typeof receipt.owner !== "string" || receipt.owner === expectedOwner) fail(`failed Solana receipt ${receipt.deploymentId} does not prove an owner mismatch`, "ARTIFACT_INVALID");
  } else if (code === "SOLANA_PARSED_TYPE_INVALID") {
    if (receipt.parsedType === "mint") fail(`failed Solana receipt ${receipt.deploymentId} has a valid mint type`, "ARTIFACT_INVALID");
  } else if (code === "SOLANA_DECIMALS_OUT_OF_RANGE") {
    if (receipt.observedDecimals !== null && (!Number.isInteger(receipt.observedDecimals) || receipt.observedDecimals >= 0 && receipt.observedDecimals <= 255)) fail(`failed Solana receipt ${receipt.deploymentId} does not prove out-of-range decimals`, "ARTIFACT_INVALID");
  } else if (code === "SOLANA_DECIMALS_MISMATCH") {
    if (!Number.isInteger(receipt.observedDecimals) || receipt.observedDecimals === deployment.decimals) fail(`failed Solana receipt ${receipt.deploymentId} does not prove a decimals mismatch`, "ARTIFACT_INVALID");
  }
}

function validateWorkspace(value, label) {
  exactOptionalKeys(value, ["clean", "pinned", "promotable"], [], label);
  if (typeof value.clean !== "boolean" || typeof value.pinned !== "boolean" || typeof value.promotable !== "boolean") fail(`${label} booleans are invalid`, "ARTIFACT_INVALID");
  if (value.promotable !== (value.clean && value.pinned)) fail(`${label}.promotable is inconsistent`, "ARTIFACT_INVALID");
}

function validateNetworkReceipts(receipts, config) {
  asArray(receipts, "receipts.networks");
  if (receipts.length !== NETWORKS.length) fail("receipts must cover all three networks", "ARTIFACT_INVALID");
  const seen = new Set();
  for (const [index, receipt] of receipts.entries()) {
    exactOptionalKeys(receipt, ["network", "chainId", "endpointId", "hostname", "status"], ["errorCode", "rpcChainId", "blockNumber", "genesisHash", "anchorSlot"], `receipts.networks[${index}]`);
    if (!NETWORKS.includes(receipt.network) || seen.has(receipt.network)) fail("network receipts do not cover config exactly", "ARTIFACT_INVALID");
    seen.add(receipt.network);
    const endpoint = config.rpc[receipt.network];
    if (receipt.chainId !== endpoint.chainId || receipt.endpointId !== endpoint.endpointId || receipt.hostname !== endpoint.hostname) fail(`receipts.networks[${index}] does not match configured endpoint`, "ARTIFACT_INVALID");
    if (!["success", "failed", "partial"].includes(receipt.status)) fail(`receipts.networks[${index}].status invalid`, "ARTIFACT_INVALID");
    if (receipt.errorCode !== undefined && !FIXED_ERROR_CODES.has(receipt.errorCode)) fail(`receipts.networks[${index}].errorCode invalid`, "ARTIFACT_INVALID");
    if (receipt.status !== "success" && (typeof receipt.errorCode !== "string" || !FIXED_ERROR_CODES.has(receipt.errorCode))) fail(`receipts.networks[${index}] failure has no fixed error`, "ARTIFACT_INVALID");
    if (receipt.network === "solana") {
      if (receipt.status === "success") {
        if (receipt.genesisHash !== endpoint.expectedGenesisHash) fail("Solana network identity receipt is invalid", "ARTIFACT_INVALID");
        validSlot(receipt.anchorSlot, `receipts.networks[${index}].anchorSlot`);
      }
    } else if (receipt.status === "success") {
      if (receipt.rpcChainId !== endpoint.expectedRpcChainId) fail("EVM network identity receipt is invalid", "ARTIFACT_INVALID");
      validBlock(receipt.blockNumber, `receipts.networks[${index}].blockNumber`);
    }
  }
  if (seen.size !== NETWORKS.length) fail("network receipts are incomplete", "ARTIFACT_INVALID");
}

function validateDeploymentReceipts(receipts, catalog, networkByName) {
  asArray(receipts, "receipts.deployments");
  const expected = new Map(catalog.deployments.map((deployment) => [deployment.deploymentId, deployment]));
  if (receipts.length !== expected.size) fail("receipts must cover every deployment", "ARTIFACT_INVALID");
  const seen = new Set();
  const evmBlocks = new Map();
  const solanaAnchor = networkByName.get("solana")?.anchorSlot;
  for (const [index, receipt] of receipts.entries()) {
    exactOptionalKeys(receipt, ["deploymentId", "chainId", "standard", "address", "status", "verification", "errorCode"], ["networkIdentity", "blockNumber", "codeNonEmpty", "observedDecimals", "observedSymbol", "decimals", "symbol", "symbolSource", "anchorSlot", "contextSlot", "owner", "parsedType"], `receipts.deployments[${index}]`);
    const deployment = expected.get(receipt.deploymentId);
    if (!deployment || seen.has(receipt.deploymentId)) fail("deployment receipts do not cover catalog exactly", "ARTIFACT_INVALID");
    seen.add(receipt.deploymentId);
    if (receipt.chainId !== deployment.chainId || receipt.standard !== deployment.standard || receipt.address !== deployment.address) fail(`receipt ${receipt.deploymentId} does not match catalog identity`, "ARTIFACT_INVALID");
    if (!["success", "failed", "skipped"].includes(receipt.status)) fail(`receipt ${receipt.deploymentId} status invalid`, "ARTIFACT_INVALID");
    if (!["protocol-declared", "rpc", "rpc-account-info", "skipped"].includes(receipt.verification)) fail(`receipt ${receipt.deploymentId} verification invalid`, "ARTIFACT_INVALID");
    if (receipt.status === "success" && receipt.errorCode !== null) fail(`successful receipt ${receipt.deploymentId} has an error`, "ARTIFACT_INVALID");
    if (receipt.status !== "success" && (typeof receipt.errorCode !== "string" || !FIXED_ERROR_CODES.has(receipt.errorCode))) fail(`failed receipt ${receipt.deploymentId} has no fixed error`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "networkIdentity") && boundedScalar(receipt.networkIdentity, 128) === null) fail(`receipt ${receipt.deploymentId}.networkIdentity is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "blockNumber")) validBlock(receipt.blockNumber, `receipt ${receipt.deploymentId}.blockNumber`);
    if (Object.hasOwn(receipt, "codeNonEmpty") && typeof receipt.codeNonEmpty !== "boolean") fail(`receipt ${receipt.deploymentId}.codeNonEmpty is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "observedDecimals") && receipt.observedDecimals !== null && !Number.isSafeInteger(receipt.observedDecimals)) fail(`receipt ${receipt.deploymentId}.observedDecimals is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "observedSymbol") && !validSymbol(receipt.observedSymbol)) fail(`receipt ${receipt.deploymentId}.observedSymbol is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "decimals") && (!Number.isInteger(receipt.decimals) || receipt.decimals < 0 || receipt.decimals > 255)) fail(`receipt ${receipt.deploymentId}.decimals is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "symbol") && !validSymbol(receipt.symbol)) fail(`receipt ${receipt.deploymentId}.symbol is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "symbolSource") && boundedScalar(receipt.symbolSource, 64) === null) fail(`receipt ${receipt.deploymentId}.symbolSource is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "anchorSlot")) validSlot(receipt.anchorSlot, `receipt ${receipt.deploymentId}.anchorSlot`);
    if (Object.hasOwn(receipt, "contextSlot")) validSlot(receipt.contextSlot, `receipt ${receipt.deploymentId}.contextSlot`);
    if (Object.hasOwn(receipt, "owner") && boundedSolanaOwner(receipt.owner) === null) fail(`receipt ${receipt.deploymentId}.owner is malformed`, "ARTIFACT_INVALID");
    if (Object.hasOwn(receipt, "parsedType") && receipt.parsedType !== null && boundedParsedType(receipt.parsedType) === null) fail(`receipt ${receipt.deploymentId}.parsedType is malformed`, "ARTIFACT_INVALID");
    const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
    const unclassified = asset?.representationKind === "unclassified";
    validateFailedDeploymentPredicate(receipt, deployment, unclassified);
    if (deployment.standard === "native") {
      if (receipt.status === "success" && receipt.verification !== "protocol-declared") fail(`native receipt ${receipt.deploymentId} must be protocol declared`, "ARTIFACT_INVALID");
      if (Object.hasOwn(receipt, "observedDecimals") || Object.hasOwn(receipt, "observedSymbol") || Object.hasOwn(receipt, "decimals") || Object.hasOwn(receipt, "symbol") || Object.hasOwn(receipt, "blockNumber") || Object.hasOwn(receipt, "anchorSlot") || Object.hasOwn(receipt, "contextSlot")) fail(`native receipt ${receipt.deploymentId} contains RPC token metadata`, "ARTIFACT_INVALID");
      if (receipt.status === "success") {
        const networkName = deployment.chainId === TOKEN_CHAIN_IDS.ethereum ? "ethereum" : deployment.chainId === TOKEN_CHAIN_IDS.avalancheC ? "avalancheC" : "solana";
        const network = networkByName.get(networkName);
        const expectedIdentity = networkName === "solana" ? network?.genesisHash : network?.rpcChainId;
        if (!network || network.status !== "success" || receipt.networkIdentity !== expectedIdentity) fail(`native receipt ${receipt.deploymentId} identity is inconsistent`, "ARTIFACT_INVALID");
      }
    } else if (deployment.chainId.startsWith("eip155:")) {
      if (receipt.verification !== "rpc") fail(`EVM receipt ${receipt.deploymentId} must use RPC verification`, "ARTIFACT_INVALID");
      const networkName = deployment.chainId === TOKEN_CHAIN_IDS.ethereum ? "ethereum" : "avalancheC";
      if (receipt.status === "success" && receipt.blockNumber === undefined) fail(`EVM receipt ${receipt.deploymentId} is missing its block`, "ARTIFACT_INVALID");
      if (receipt.blockNumber !== undefined) {
        validBlock(receipt.blockNumber, `receipt ${receipt.deploymentId}.blockNumber`);
        if (receipt.blockNumber !== networkByName.get(networkName)?.blockNumber) fail(`EVM receipt ${receipt.deploymentId} is not bound to the network block`, "ARTIFACT_INVALID");
      }
      if (receipt.status !== "success") continue;
      const prior = evmBlocks.get(deployment.chainId);
      if (prior !== undefined && prior !== receipt.blockNumber) fail(`EVM receipt ${receipt.deploymentId} changed its network block`, "ARTIFACT_INVALID");
      evmBlocks.set(deployment.chainId, receipt.blockNumber);
      if (receipt.codeNonEmpty !== true || receipt.decimals !== deployment.decimals || (unclassified ? receipt.symbol !== deployment.symbol || receipt.symbolSource !== "address-only" : receipt.symbol !== deployment.symbol) || (Object.hasOwn(receipt, "observedDecimals") && receipt.observedDecimals !== receipt.decimals) || (!unclassified && Object.hasOwn(receipt, "observedSymbol") && receipt.observedSymbol !== receipt.symbol) || (unclassified && Object.hasOwn(receipt, "observedSymbol"))) fail(`successful EVM receipt ${receipt.deploymentId} metadata is inconsistent`, "ARTIFACT_INVALID");
    } else if (deployment.chainId === SOLANA_CHAIN) {
      if (receipt.verification !== "rpc-account-info") fail(`Solana receipt ${receipt.deploymentId} must use account-info verification`, "ARTIFACT_INVALID");
      if (receipt.anchorSlot !== undefined) validSlot(receipt.anchorSlot, `receipt ${receipt.deploymentId}.anchorSlot`);
      if (receipt.contextSlot !== undefined) validSlot(receipt.contextSlot, `receipt ${receipt.deploymentId}.contextSlot`);
      if (receipt.status === "success" && (receipt.anchorSlot !== solanaAnchor || receipt.contextSlot === undefined || receipt.contextSlot < solanaAnchor)) fail(`Solana receipt ${receipt.deploymentId} context is inconsistent`, "ARTIFACT_INVALID");
      if (receipt.status !== "success") continue;
      const expectedOwner = deployment.standard === "spl-token" ? TOKEN_PROGRAM_IDS.splToken : TOKEN_PROGRAM_IDS.splToken2022;
      if (receipt.parsedType !== "mint" || receipt.owner !== expectedOwner) fail(`Solana receipt ${receipt.deploymentId} account metadata is invalid`, "ARTIFACT_INVALID");
      if (receipt.decimals !== deployment.decimals || (Object.hasOwn(receipt, "observedDecimals") && receipt.observedDecimals !== receipt.decimals)) fail(`Solana receipt ${receipt.deploymentId} decimals are inconsistent`, "ARTIFACT_INVALID");
    }
  }
  if (seen.size !== expected.size) fail("deployment receipts are incomplete", "ARTIFACT_INVALID");
}

function validateReviewedRpcProofReceipts(catalog, deployments, networks) {
  const deploymentById = new Map(deployments.map((receipt) => [receipt.deploymentId, receipt]));
  const networkByName = new Map(networks.map((receipt) => [receipt.network, receipt]));
  const receiptProvesSameChain = (deployment, endpoint) => {
    const receipt = deploymentById.get(deployment.deploymentId);
    const network = NETWORKS.find((name) => DEFAULT_RPC_ENDPOINTS[name].chainId === endpoint.chainId);
    const networkReceiptValue = networkByName.get(network);
    const expectedVerification = network === "solana" ? "rpc-account-info" : "rpc";
    return receipt && receipt.chainId === endpoint.chainId && receipt.verification === expectedVerification && networkReceiptValue && networkReceiptValue.chainId === endpoint.chainId;
  };
  for (const deployment of catalog.deployments) {
    const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
    if (asset?.representationKind !== "unclassified") continue;
    for (const url of deployment.evidence) {
      const endpoint = reviewedRpcProofEndpoint(url);
      if (!endpoint || deployment.chainId !== endpoint.chainId) continue;
      if (!receiptProvesSameChain(deployment, endpoint)) fail(`unclassified RPC proof for ${deployment.deploymentId} is not backed by a same-chain token RPC receipt`, "ARTIFACT_INVALID");
    }
  }
  for (const asset of catalog.assets.filter((entry) => entry.representationKind === "unclassified")) {
    for (const url of asset.evidence) {
      const endpoint = reviewedRpcProofEndpoint(url);
      if (!endpoint) continue;
      const candidates = catalog.deployments.filter((entry) => entry.assetId === asset.assetId && entry.chainId === endpoint.chainId);
      if (candidates.length > 0 && !candidates.some((deployment) => receiptProvesSameChain(deployment, endpoint))) fail(`unclassified RPC proof for ${asset.assetId} is not backed by a same-chain token RPC receipt`, "ARTIFACT_INVALID");
    }
  }
}

function validateSourceReceipts(receipts, config) {
  asArray(receipts, "receipts.sources");
  if (receipts.length !== config.sources.length) fail("receipts must cover every source", "ARTIFACT_INVALID");
  const expected = new Map(config.sources.map((source) => [source.sourceId, source]));
  const seen = new Set();
  for (const [index, receipt] of receipts.entries()) {
    exactOptionalKeys(receipt, ["sourceId", "hostname", "mode", "status"], ["httpStatus", "bodySha256", "fingerprint", "errorCode", "finalUrl", "redirects", "signalCount"], `receipts.sources[${index}]`);
    const source = expected.get(receipt.sourceId);
    if (!source || seen.has(receipt.sourceId)) fail("source receipts do not cover config exactly", "ARTIFACT_INVALID");
    seen.add(receipt.sourceId);
    if (receipt.hostname !== new URL(source.url).hostname || receipt.mode !== source.mode) fail(`source receipt ${receipt.sourceId} does not match config`, "ARTIFACT_INVALID");
    if (!["success", "failed", "partial"].includes(receipt.status)) fail(`source receipt ${receipt.sourceId} status invalid`, "ARTIFACT_INVALID");
    if (receipt.errorCode !== undefined && !FIXED_ERROR_CODES.has(receipt.errorCode)) fail(`source receipt ${receipt.sourceId} error code invalid`, "ARTIFACT_INVALID");
    if (receipt.status === "success") {
      if (receipt.errorCode !== undefined) fail(`successful source receipt ${receipt.sourceId} has an error`, "ARTIFACT_INVALID");
      if (!Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 200 || receipt.httpStatus >= 300 || !DIGEST_RE.test(receipt.bodySha256) || !DIGEST_RE.test(receipt.fingerprint)) fail(`source receipt ${receipt.sourceId} success evidence is incomplete`, "ARTIFACT_INVALID");
      if (typeof receipt.finalUrl !== "string" || !source.allowedFinalUrls.includes(receipt.finalUrl)) fail(`source receipt ${receipt.sourceId} final URL is not approved`, "ARTIFACT_INVALID");
      if (!Number.isInteger(receipt.redirects) || receipt.redirects < 0 || receipt.redirects > OBSERVER_LIMITS.maxRedirects) fail(`source receipt ${receipt.sourceId} redirects invalid`, "ARTIFACT_INVALID");
    } else if (receipt.errorCode === undefined || !FIXED_ERROR_CODES.has(receipt.errorCode)) fail(`source receipt ${receipt.sourceId} failure has no fixed code`, "ARTIFACT_INVALID");
  }
  if (seen.size !== expected.size) fail("source receipts are incomplete", "ARTIFACT_INVALID");
}

export function validateObservationArtifacts(artifacts, context = {}) {
  if (!isRecord(artifacts)) fail("observation artifacts must be an object", "ARTIFACT_INVALID");
  exactKeys(artifacts, ["receipts", "findings", "reviewCandidate"], "observation artifacts");
  const catalog = context.catalog ?? CATALOG;
  const rawConfig = context.config ?? defaultObserverConfig;
  const config = normalizeConfig(rawConfig, catalog);
  const expectedSourceSha = context.sourceSha ?? context.expectedSourceSha;
  validateCatalog(catalog);
  const expectedConfigDigest = computeConfigDigest(rawConfig);
  const receipts = artifacts.receipts;
  exactOptionalKeys(receipts, ["schemaVersion", "artifactKind", "status", "sourceSha", "catalogDigest", "configDigest", "workspace", "networks", "deployments", "sources"], [], "receipts");
  if (receipts.schemaVersion !== OBSERVER_SCHEMA_VERSION || receipts.artifactKind !== "observation-receipts") fail("receipts envelope is invalid", "ARTIFACT_INVALID");
  if (!["complete", "partial", "preflight-failed"].includes(receipts.status)) fail("receipts.status is invalid", "ARTIFACT_INVALID");
  sourceSha(receipts.sourceSha);
  sourceSha(expectedSourceSha ?? receipts.sourceSha, "context.sourceSha");
  if (receipts.sourceSha !== (expectedSourceSha ?? receipts.sourceSha)) fail("receipt sourceSha does not match context", "ARTIFACT_INVALID");
  if (context.expectedCatalogDigest !== undefined && receipts.catalogDigest !== context.expectedCatalogDigest) fail("receipt catalogDigest does not match context", "ARTIFACT_INVALID");
  if (context.expectedConfigDigest !== undefined && receipts.configDigest !== context.expectedConfigDigest) fail("receipt configDigest does not match context", "ARTIFACT_INVALID");
  if (receipts.catalogDigest !== catalog.contentDigest) fail("receipt catalogDigest does not match catalog", "ARTIFACT_INVALID");
  if (receipts.configDigest !== expectedConfigDigest) fail("receipt configDigest does not match config", "ARTIFACT_INVALID");
  validateWorkspace(receipts.workspace, "receipts.workspace");
  validateNetworkReceipts(receipts.networks, config);
  const networkByName = new Map(receipts.networks.map((network) => [network.network, network]));
  validateDeploymentReceipts(receipts.deployments, catalog, networkByName);
  validateReviewedRpcProofReceipts(catalog, receipts.deployments, receipts.networks);
  validateSourceReceipts(receipts.sources, config);
  const deploymentIds = new Set(catalog.deployments.map((deployment) => deployment.deploymentId));
  const sourceIds = new Set(config.sources.map((source) => source.sourceId));
  const hasTrustedHistory = Object.hasOwn(context, "priorFindings") || Object.hasOwn(context, "baseline");
  const findings = artifacts.findings;
  exactOptionalKeys(findings, ["schemaVersion", "artifactKind", "status", "catalogDigest", "configDigest", "findings"], [], "findings");
  if (findings.schemaVersion !== OBSERVER_SCHEMA_VERSION || findings.artifactKind !== "maintenance-findings") fail("findings envelope is invalid", "ARTIFACT_INVALID");
  if (findings.catalogDigest !== catalog.contentDigest || findings.configDigest !== expectedConfigDigest) fail("findings binding is invalid", "ARTIFACT_INVALID");
  if (!["complete", "partial"].includes(findings.status)) fail("findings.status is invalid", "ARTIFACT_INVALID");
  if (findings.status !== receipts.status) fail("findings status does not match receipts", "ARTIFACT_INVALID");
  asArray(findings.findings, "findings.findings");
  const seenFindingKeys = new Set();
  const deploymentById = new Map(catalog.deployments.map((deployment) => [deployment.deploymentId, deployment]));
  const receiptByDeployment = new Map(receipts.deployments.map((receipt) => [receipt.deploymentId, receipt]));
  const receiptBySource = new Map(receipts.sources.map((receipt) => [receipt.sourceId, receipt]));
  const receiptByNetwork = new Map(receipts.networks.map((receipt) => [receipt.network, receipt]));
  for (const [index, finding] of findings.findings.entries()) {
    validateStableFinding(finding, `findings.findings[${index}]`);
    const key = findingsKey(finding);
    if (seenFindingKeys.has(key)) fail("findings contain duplicate category and subject", "ARTIFACT_INVALID");
    seenFindingKeys.add(key);
    if (finding.category === "network-identity") {
      const receipt = receiptByNetwork.get(finding.subjectId);
      const exactCurrent = receipt?.status === "failed" && ["NETWORK_IDENTITY_MISMATCH", "NETWORK_IDENTITY_INVALID"].includes(finding.code) && finding.fingerprint === networkIdentityFingerprint(receipt);
      const carryCandidate = receipt && receipt.status !== "success";
      if (!receipt || receipt.status === "success" || (!exactCurrent && !(hasTrustedHistory && carryCandidate))) fail("network identity finding is not derived from its receipt", "ARTIFACT_INVALID");
    } else if (finding.category === "rpc-observation") {
      const receipt = receiptByDeployment.get(finding.subjectId);
      const exactCurrent = receipt?.status === "failed" && finding.fingerprint === rpcFindingFingerprint(receipt, deploymentById.get(finding.subjectId));
      const carryCandidate = receipt && receipt.status !== "success";
      if (!receipt || receipt.status === "success" || (!exactCurrent && !(hasTrustedHistory && carryCandidate))) fail("rpc finding is not derived from its receipt", "ARTIFACT_INVALID");
    } else if (finding.category === "source-unavailable") {
      const receipt = receiptBySource.get(finding.subjectId);
      const exactCurrent = receipt?.status === "failed" && finding.fingerprint === sourceUnavailableFingerprint(receipt);
      const carryCandidate = receipt && receipt.status !== "success";
      if (!receipt || receipt.status === "success" || (!exactCurrent && !(hasTrustedHistory && carryCandidate))) fail("source finding is not derived from its receipt", "ARTIFACT_INVALID");
    } else if (finding.category === "source-change") {
      const receipt = receiptBySource.get(finding.subjectId);
      const exactCurrent = receipt?.status === "success" && finding.fingerprint === sourceChangeFingerprint(receipt);
      const carryCandidate = receipt && receipt.status !== "success";
      if (!receipt || (!exactCurrent && !(hasTrustedHistory && carryCandidate))) fail("source-change finding is not derived from its receipt", "ARTIFACT_INVALID");
    } else if (!deploymentIds.has(finding.subjectId) && !sourceIds.has(finding.subjectId)) {
      fail("finding subject is outside the catalog/config", "ARTIFACT_INVALID");
    }
  }
  const candidate = artifacts.reviewCandidate;
  exactOptionalKeys(candidate, ["schemaVersion", "artifactKind", "status", "sourceSha", "catalogDigest", "configDigest", "workspace", "baseline", "actionRequired", "proposals", "manualReviewInstructions"], [], "reviewCandidate");
  if (candidate.schemaVersion !== OBSERVER_SCHEMA_VERSION || candidate.artifactKind !== "maintenance-review-candidate") fail("review candidate envelope is invalid", "ARTIFACT_INVALID");
  sourceSha(candidate.sourceSha);
  if (candidate.sourceSha !== receipts.sourceSha || candidate.catalogDigest !== catalog.contentDigest || candidate.configDigest !== expectedConfigDigest) fail("review candidate binding is invalid", "ARTIFACT_INVALID");
  if (!["complete", "partial", "review"].includes(candidate.status)) fail("review candidate status is invalid", "ARTIFACT_INVALID");
  validateWorkspace(candidate.workspace, "reviewCandidate.workspace");
  if (candidate.workspace.clean !== receipts.workspace.clean || candidate.workspace.pinned !== receipts.workspace.pinned || candidate.workspace.promotable !== receipts.workspace.promotable) fail("review candidate workspace does not match receipts", "ARTIFACT_INVALID");
  exactOptionalKeys(candidate.baseline, ["present", "eligibleBootstrap"], [], "reviewCandidate.baseline");
  if (typeof candidate.baseline.present !== "boolean" || typeof candidate.baseline.eligibleBootstrap !== "boolean") fail("review candidate baseline flags are invalid", "ARTIFACT_INVALID");
  const allSourcesUsable = receipts.sources.every((source) => source.status === "success");
  if (candidate.baseline.eligibleBootstrap !== (!candidate.baseline.present && allSourcesUsable && receipts.status === "complete")) fail("review candidate bootstrap status is inconsistent", "ARTIFACT_INVALID");
  if (typeof candidate.actionRequired !== "boolean") fail("review candidate actionRequired is invalid", "ARTIFACT_INVALID");
  if (!Array.isArray(candidate.proposals) || !Array.isArray(candidate.manualReviewInstructions)) fail("review candidate content is invalid", "ARTIFACT_INVALID");
  for (const [index, proposal] of candidate.proposals.entries()) {
    exactOptionalKeys(proposal, ["category", "subjectId", "fingerprint", "reasonCode", "manualReview"], [], `reviewCandidate.proposals[${index}]`);
    string(proposal.category, `reviewCandidate.proposals[${index}].category`);
    string(proposal.subjectId, `reviewCandidate.proposals[${index}].subjectId`);
    digest(proposal.fingerprint, `reviewCandidate.proposals[${index}].fingerprint`);
    string(proposal.reasonCode, `reviewCandidate.proposals[${index}].reasonCode`);
    string(proposal.manualReview, `reviewCandidate.proposals[${index}].manualReview`);
    const matchingFinding = findings.findings.find((finding) => finding.category === proposal.category && finding.subjectId === proposal.subjectId && finding.fingerprint === proposal.fingerprint && finding.code === proposal.reasonCode);
    if (proposal.category === "source-baseline-bootstrap") {
      if (proposal.subjectId !== "observer-sources" || proposal.reasonCode !== "BASELINE_MISSING" || !candidate.baseline.eligibleBootstrap || proposal.fingerprint !== bootstrapFingerprint(receipts.sources)) fail("bootstrap proposal is inconsistent", "ARTIFACT_INVALID");
    } else if (!matchingFinding) fail("review proposal is not backed by a finding", "ARTIFACT_INVALID");
  }
  if (candidate.actionRequired !== (candidate.proposals.length > 0)) fail("review candidate action flag is inconsistent", "ARTIFACT_INVALID");
  const expectedCandidateStatus = receipts.status === "partial" ? "partial" : candidate.actionRequired ? "review" : "complete";
  if (candidate.status !== expectedCandidateStatus) fail("review candidate status is inconsistent", "ARTIFACT_INVALID");
  for (const instruction of candidate.manualReviewInstructions) string(instruction, "reviewCandidate.manualReviewInstructions");
  const forbiddenCandidateKeys = new Set(["patch", "patches", "operation", "operations", "command", "commands", "write", "writes", "canonicalUpdate"]);
  const scan = (value) => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (forbiddenCandidateKeys.has(key)) fail("review candidate contains executable operation", "ARTIFACT_INVALID");
      scan(value[key]);
    }
  };
  scan(candidate);
  if (hasTrustedHistory && !context._skipTrustedRecompute) {
    const recomputed = recomputeObservationArtifacts(receipts, {
      sourceSha: expectedSourceSha ?? receipts.sourceSha,
      catalog,
      config,
      priorFindings: context.priorFindings,
      baseline: context.baseline,
    });
    if (stableStringify(recomputed.findings) !== stableStringify(findings) || stableStringify(recomputed.reviewCandidate) !== stableStringify(candidate)) fail("artifacts do not match trusted prior findings/baseline recomputation", "ARTIFACT_INVALID");
  }
  return true;
}

export function recomputeObservationArtifacts(receipts, {
  sourceSha: expectedSourceSha,
  catalog = CATALOG,
  config = defaultObserverConfig,
  priorFindings = undefined,
  baseline = undefined,
} = {}) {
  if (!isRecord(receipts)) fail("receipts are required for recomputation", "ARTIFACT_INVALID");
  validateCatalog(catalog);
  const effectiveConfig = normalizeConfig(config, catalog);
  const configDigestValue = computeConfigDigest(config);
  sourceSha(expectedSourceSha ?? receipts.sourceSha);
  if (receipts.sourceSha !== (expectedSourceSha ?? receipts.sourceSha) || receipts.catalogDigest !== catalog.contentDigest || receipts.configDigest !== configDigestValue) fail("receipts are not bound to recomputation context", "ARTIFACT_INVALID");
  validateWorkspace(receipts.workspace, "receipts.workspace");
  validateNetworkReceipts(receipts.networks, effectiveConfig);
  const networkByName = new Map(receipts.networks.map((network) => [network.network, network]));
  validateDeploymentReceipts(receipts.deployments, catalog, networkByName);
  validateSourceReceipts(receipts.sources, effectiveConfig);
  const prior = normalizePriorFindings(priorFindings);
  const normalizedBaseline = normalizeBaseline(baseline, effectiveConfig);
  const currentFindings = sortFindings([
    ...networkFindings(receipts.networks),
    ...rpcFindings(receipts.deployments, catalog),
    ...sourceFindings(receipts.sources, effectiveConfig, normalizedBaseline),
  ]);
  const findings = {
    schemaVersion: OBSERVER_SCHEMA_VERSION,
    artifactKind: "maintenance-findings",
    status: receipts.status,
    catalogDigest: catalog.contentDigest,
    configDigest: configDigestValue,
    findings: carryPriorFindings(prior, currentFindings, receipts, receipts.sources),
  };
  const reviewCandidate = candidateFor({
    sourceRecords: receipts.sources,
    findings: findings.findings,
    currentFindings,
    baseline: normalizedBaseline,
    config: effectiveConfig,
    receipts,
    sourceSha: receipts.sourceSha,
    catalogDigest: catalog.contentDigest,
    configDigest: configDigestValue,
    workspace: receipts.workspace,
  });
  const artifacts = { receipts: structuredClone(receipts), findings, reviewCandidate };
  validateObservationArtifacts(artifacts, { sourceSha: receipts.sourceSha, catalog, config, priorFindings, baseline, _skipTrustedRecompute: true });
  return artifacts;
}

export async function observeTokenCatalog(options = {}) {
  const catalog = typeof options.catalog === "string"
    ? await readJsonInput(options.catalog, null, "catalog")
    : options.catalog ?? CATALOG;
  try {
    validateCatalog(catalog);
  } catch (error) {
    throw new ObserverValidationError("catalog is invalid", "CATALOG_INVALID");
  }
  const configInput = typeof options.config === "string"
    ? await readJsonInput(options.config, null, "config")
    : options.config ?? defaultObserverConfig;
  const config = normalizeConfig(configInput, catalog);
  const configDigestValue = computeConfigDigest(configInput);
  const sourceShaValue = await defaultSourceSha(options);
  sourceSha(sourceShaValue);
  const priorInput = typeof options.priorFindings === "string"
    ? await readJsonInput(options.priorFindings, null, "prior findings")
    : options.priorFindings;
  const baselineInput = typeof options.baseline === "string"
    ? await readJsonInput(options.baseline, null, "baseline", { optional: true })
    : options.baseline;
  const prior = normalizePriorFindings(priorInput);
  const baseline = normalizeBaseline(baselineInput, config);
  const workspace = await resolveRepositoryState(options);
  const start = nowValue(options.clock);
  const deadline = () => start + Math.min(options.runBudgetMs ?? OBSERVER_LIMITS.runBudgetMs, OBSERVER_LIMITS.runBudgetMs);
  let sequenceValue = 1;
  const sequence = () => sequenceValue++;
  const deploymentsByNetwork = Object.fromEntries(NETWORKS.map((network) => [network, catalog.deployments.filter((deployment) => deployment.chainId === TOKEN_CHAIN_IDS[network]).sort(deploymentSort)]));
  const networkResults = [];
  for (const network of ["ethereum", "avalancheC", "solana"]) {
    const endpoint = config.rpc[network];
    const result = network === "solana"
      ? await observeSolanaNetwork(deploymentsByNetwork[network], endpoint, options, deadline, sequence)
      : await observeEvmNetwork(network, deploymentsByNetwork[network], endpoint, options, deadline, sequence, catalog);
    networkResults.push(result);
  }
  const sourceRecords = await observeSources(config, options, deadline, baseline);
  const deploymentRecords = networkResults.flatMap((result) => result.deployments).sort(deploymentSort);
  const status = artifactStatus(networkResults.map((result) => result.network), sourceRecords, deploymentRecords);
  const receipts = buildReceipts({ sourceShaValue, catalog, config, configDigestValue, networks: networkResults.map((result) => result.network), deployments: deploymentRecords, sourceRecords, status, workspace });
  const artifacts = recomputeObservationArtifacts(receipts, { sourceSha: sourceShaValue, catalog, config: configInput, priorFindings: prior, baseline });
  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(resolve(options.outputDir, OBSERVER_ARTIFACT_FILENAMES.receipts), `${JSON.stringify(receipts, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, OBSERVER_ARTIFACT_FILENAMES.findings), `${JSON.stringify(artifacts.findings, null, 2)}\n`);
    await writeFile(resolve(options.outputDir, OBSERVER_ARTIFACT_FILENAMES.reviewCandidate), `${JSON.stringify(artifacts.reviewCandidate, null, 2)}\n`);
  }
  return artifacts;
}

export function exitCodeForArtifacts(artifacts) {
  if (!artifacts || !artifacts.receipts || !artifacts.findings || !artifacts.reviewCandidate) return 70;
  if (artifacts.reviewCandidate.actionRequired || artifacts.reviewCandidate.baseline?.eligibleBootstrap) return 2;
  if (artifacts.receipts.status === "partial" || artifacts.reviewCandidate.status === "partial") return 3;
  return 0;
}

export function redactError(error) {
  return { errorCode: normalizeErrorCode(error, "source") };
}

export { sourceFingerprint, decodeSymbol, decodeUint256, isPrivateAddress, parseHttpsUrl, requestHttpsTransport };
export const validateObserverArtifacts = validateObservationArtifacts;
