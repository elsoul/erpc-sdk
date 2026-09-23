#!/usr/bin/env node

/*
 * Oracle-only Mayan local-build capture. This file intentionally loads the
 * pinned official SDK from a caller-supplied temporary reference directory;
 * it is never imported by a package runtime and never calls /build.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";

export const REFERENCE_COMMIT = "c4c98031aaad9264d17630d7b4de0cb18688cf78";
export const OFFICIAL_SDK_VERSION = "15.2.2";
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "mayan-swift-v2-local-reference";
export const ETHEREUM_CHAIN_ID = "eip155:1";
export const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ETHEREUM_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SOLANA_ADDRESS = "HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b";
export const NONCES = Object.freeze({
  "eurc-ethereum-to-solana": "0x00112233445566778899aabbccddeeff",
  "eurc-solana-to-ethereum": "0x102132435465768798a9bacbdcedfe0f",
  "usdc-ethereum-to-solana": "0x112233445566778899aabbccddeeff00",
  "usdc-solana-to-ethereum": "0x2233445566778899aabbccddeeff0011",
});

const ROUTES = Object.freeze([
  { key: "eurc-ethereum-to-solana", asset: "eurc", direction: "ethereum-to-solana", quoteFile: "eurc-ethereum-to-solana-quote.json", capabilityId: "bridge-mayan-swift-v2-eurc-eth-sol", sourceChainId: ETHEREUM_CHAIN_ID, destinationChainId: SOLANA_CHAIN_ID, sourceTokenDeploymentId: "deployment-0011", destinationTokenDeploymentId: "deployment-0013" },
  { key: "eurc-solana-to-ethereum", asset: "eurc", direction: "solana-to-ethereum", quoteFile: "eurc-solana-to-ethereum-quote.json", capabilityId: "bridge-mayan-swift-v2-eurc-sol-eth", sourceChainId: SOLANA_CHAIN_ID, destinationChainId: ETHEREUM_CHAIN_ID, sourceTokenDeploymentId: "deployment-0013", destinationTokenDeploymentId: "deployment-0011" },
  { key: "usdc-ethereum-to-solana", asset: "usdc", direction: "ethereum-to-solana", quoteFile: "usdc-ethereum-to-solana-quote.json", capabilityId: "bridge-mayan-swift-v2-usdc-eth-sol", sourceChainId: ETHEREUM_CHAIN_ID, destinationChainId: SOLANA_CHAIN_ID, sourceTokenDeploymentId: "deployment-0008", destinationTokenDeploymentId: "deployment-0010" },
  { key: "usdc-solana-to-ethereum", asset: "usdc", direction: "solana-to-ethereum", quoteFile: "usdc-solana-to-ethereum-quote.json", capabilityId: "bridge-mayan-swift-v2-usdc-sol-eth", sourceChainId: SOLANA_CHAIN_ID, destinationChainId: ETHEREUM_CHAIN_ID, sourceTokenDeploymentId: "deployment-0010", destinationTokenDeploymentId: "deployment-0008" },
]);

const ETH_FORWARDER = "0x337685fdaB40D39bd02028545a4FfA7D287cC3E2";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const ALLOWED_RPC_METHODS = new Set(["getGenesisHash", "getMultipleAccounts", "getAccountInfo", "getLatestBlockhash", "getBlockHeight"]);
const ALLOWED_SOURCE_SWAP_PATHS = new Set(["/v3/get-swap/evm", "/v3/get-swap/solana"]);

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : Buffer.from(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function stableDigest(value) {
  return sha256(stableJson(value));
}

function parseArguments(argv) {
  const options = { referenceDir: "/private/tmp/erpc-keyless-implementation/reference", mode: "capture", replay: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reference-dir" || argument === "--replay" || argument === "--output") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--reference-dir") options.referenceDir = value;
      else if (argument === "--replay") { options.replay = value; options.mode = "replay"; }
      else options.output = value;
    } else if (argument === "--capture") options.mode = "capture";
    else if (argument === "--help") options.help = true;
    else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

function assertNoCredentials(url, headers) {
  for (const name of ["authorization", "cookie", "x-api-key"]) if (headers.has(name)) throw new Error("reference attempted to send a credential");
  if (url.searchParams.has("apiKey")) throw new Error("reference attempted to send an API key query");
}

function classifyTarget(url, method) {
  if (method === "GET" && url.origin === "https://price-api.mayan.finance" && ALLOWED_SOURCE_SWAP_PATHS.has(url.pathname)) return "source-swap";
  if (method === "POST" && url.origin === "https://api.mainnet-beta.solana.com" && url.pathname === "/") return "solana-rpc";
  throw new Error(`unapproved reference target ${method} ${url.origin}${url.pathname}`);
}

function requestBody(init) {
  return init?.body === undefined || init?.body === null ? null : String(init.body);
}

function equivalentRequest(kind, left, right) {
  if (kind !== "solana-rpc") return left === right;
  try {
    const leftValue = JSON.parse(left);
    const rightValue = JSON.parse(right);
    delete leftValue.id;
    delete rightValue.id;
    return stableJson(leftValue) === stableJson(rightValue);
  } catch {
    return false;
  }
}

function replayBody(kind, body, request) {
  if (kind !== "solana-rpc") return body;
  try {
    const response = JSON.parse(body);
    const rpcRequest = JSON.parse(request);
    if (Object.hasOwn(response, "id") && Object.hasOwn(rpcRequest, "id")) response.id = rpcRequest.id;
    return JSON.stringify(response);
  } catch {
    return body;
  }
}

function responseHeaders(response) {
  return Object.fromEntries([...response.headers.entries()].filter(([name]) => name === "content-type"));
}

function makeFetch({ mode, replayRecords, records, routeKey }) {
  let replayIndex = 0;
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const kind = classifyTarget(url, method);
    if (kind === "source-swap" || kind === "solana-rpc") headers.set("accept", "application/json");
    if (kind === "solana-rpc") {
      headers.set("content-type", "application/json");
      headers.delete("solana-client");
    }
    assertNoCredentials(url, headers);
    const body = requestBody(init);
    if (kind === "solana-rpc") {
      if (body === null) throw new Error("RPC body is required");
      const rpc = JSON.parse(body);
      if (!ALLOWED_RPC_METHODS.has(rpc.method)) throw new Error(`unapproved RPC method ${rpc.method}`);
    }
    if (mode === "replay") {
      const candidate = replayRecords.slice(replayIndex).find((entry) => entry.routeKey === routeKey && entry.kind === kind && entry.method === method && entry.url === url.href && equivalentRequest(kind, entry.requestBody, body));
      if (!candidate) throw new Error(`replay response missing for ${routeKey} ${method} ${url.href}`);
      replayIndex = replayRecords.indexOf(candidate) + 1;
      records.push({ ...candidate, requestHeaders: Object.fromEntries(headers.entries()), replayed: true });
      return new Response(replayBody(kind, candidate.responseBody, body), { status: candidate.status, headers: candidate.responseHeaders });
    }
    if (records.length >= 32) throw new Error("reference network bound exceeded");
    const response = await globalThis.fetch(url.href, { ...init, method, headers, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(25000) });
    const responseBody = Buffer.from(await response.arrayBuffer()).toString("utf8");
    records.push({ routeKey, kind, method, url: url.href, requestHeaders: Object.fromEntries(headers.entries()), requestBody: body, status: response.status, responseHeaders: responseHeaders(response), responseBody });
    return new Response(responseBody, { status: response.status, headers: responseHeaders(response) });
  };
}

async function loadOfficial(referenceDir) {
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "cross-fetch" && context.parentURL?.includes("/@mayanfinance/swap-sdk/")) return { url: "data:text/javascript,export default (...args)=>globalThis.__erpcReferenceFetch(...args);", shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  const sdk = await import(pathToFileURL(path.join(referenceDir, "node_modules/@mayanfinance/swap-sdk/dist/index.mjs")).href);
  const web3 = await import(pathToFileURL(path.join(referenceDir, "node_modules/@solana/web3.js/lib/index.cjs.js")).href);
  return { sdk, web3 };
}

function normalizeInstruction(instruction) {
  return {
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })),
    dataBase64: Buffer.from(instruction.data).toString("base64"),
  };
}

function normalizeLookupTable(table) {
  return { key: table.key.toBase58(), addresses: table.state.addresses.map((address) => address.toBase58()) };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child));
}

function routeAddresses(route) {
  return route.sourceChainId === ETHEREUM_CHAIN_ID ? { swapper: ETHEREUM_ADDRESS, destination: SOLANA_ADDRESS } : { swapper: SOLANA_ADDRESS, destination: ETHEREUM_ADDRESS };
}

async function runRoute(route, referenceDir, mode, replayRecords) {
  const quotePath = path.join(referenceDir, route.quoteFile);
  const rawQuoteJson = await readFile(quotePath, "utf8");
  const quote = JSON.parse(rawQuoteJson);
  const nonce = NONCES[route.key];
  const addresses = routeAddresses(route);
  const records = [];
  const fetch = makeFetch({ mode, replayRecords, records, routeKey: route.key });
  globalThis.__erpcReferenceFetch = fetch;
  const { sdk, web3 } = await loadOfficial(referenceDir);
  const oracleQuote = structuredClone(quote);
  oracleQuote.memoHex = nonce;
  const row = {
    key: route.key,
    asset: route.asset,
    direction: route.direction,
    capabilityId: route.capabilityId,
    sourceChainId: route.sourceChainId,
    destinationChainId: route.destinationChainId,
    sourceTokenDeploymentId: route.sourceTokenDeploymentId,
    destinationTokenDeploymentId: route.destinationTokenDeploymentId,
    swapperAddress: addresses.swapper,
    destinationAddress: addresses.destination,
    orderNonce: nonce,
    quote: { rawQuoteJson, rawQuoteSha256: sha256(rawQuoteJson), quoteId: quote.quoteId },
    sourceSwapRecords: [],
  };
  if (route.sourceChainId === ETHEREUM_CHAIN_ID) {
    const built = await sdk.getSwapFromEvmTxPayload(oracleQuote, addresses.swapper, addresses.destination, null, addresses.swapper, 1, null, null, {});
    row.unsigned = { kind: "evm-unsigned", to: built.to, value: String(built.value), chainId: String(built.chainId), data: built.data, forwarder: jsonClone(built._forwarder) };
  } else {
    const connection = new web3.Connection(SOLANA_RPC_URL, { commitment: "confirmed", fetch, disableRetryOnRateLimit: true });
    const built = await sdk.createSwapFromSolanaInstructions(oracleQuote, addresses.swapper, addresses.destination, null, connection, { separateSwapTx: false });
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const message = new web3.TransactionMessage({ payerKey: new web3.PublicKey(addresses.swapper), recentBlockhash: blockhash.blockhash, instructions: built.instructions }).compileToV0Message(built.lookupTables);
    const transaction = new web3.VersionedTransaction(message);
    row.unsigned = {
      kind: "solana-v0-unsigned",
      transactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
      feePayer: addresses.swapper,
      blockhash,
      instructions: built.instructions.map(normalizeInstruction),
      lookupTables: built.lookupTables.map(normalizeLookupTable),
      signers: built.signers.length,
      swapMessageV0Params: built.swapMessageV0Params === null ? null : "present",
    };
  }
  row.sourceSwapRecords = records.filter((entry) => entry.kind === "source-swap");
  row.rpcRecords = records.filter((entry) => entry.kind === "solana-rpc");
  return row;
}

export async function capture({ referenceDir = "/private/tmp/erpc-keyless-implementation/reference", mode = "capture", replay = null } = {}) {
  const replayPayload = replay === null ? null : JSON.parse(await readFile(replay, "utf8"));
  const replayRecords = replayPayload?.records ?? [];
  const rows = [];
  const records = [];
  for (const route of ROUTES) {
    const row = await runRoute(route, referenceDir, mode, replayRecords);
    rows.push(row);
    records.push(...row.sourceSwapRecords, ...row.rpcRecords);
  }
  return { snapshotVersion: SNAPSHOT_VERSION, snapshotKind: SNAPSHOT_KIND, referenceCommit: REFERENCE_COMMIT, officialSdkVersion: OFFICIAL_SDK_VERSION, syntheticAddresses: true, apiKeysSupplied: false, signing: 0, broadcasts: 0, simulations: 0, rows, records };
}

function usage() {
  return [
    "Usage:",
    "  node registry/reference-mayan-local-build.mjs --capture --reference-dir <dir> --output <file>",
    "  node registry/reference-mayan-local-build.mjs --replay <capture.json> --reference-dir <dir> --output <file>",
    "",
    "The oracle uses only public quote/source-swap/read-RPC data and never calls /build or signs.",
  ].join("\n");
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const result = await capture({ referenceDir: options.referenceDir, mode: options.mode, replay: options.replay });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, text, { mode: 0o600 });
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error) => { process.stderr.write(`reference-mayan-local-build: ${error.message}\n`); process.exitCode = 1; });
}
