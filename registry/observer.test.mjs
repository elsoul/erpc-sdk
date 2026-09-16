import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CATALOG,
  TOKEN_CHAIN_IDS,
  computeDigest as computeTokenDigest,
} from "./token-catalog.mjs";
import {
  DEFAULT_RPC_ENDPOINTS,
  TOKEN_PROGRAM_IDS,
  computeConfigDigest,
  exitCodeForArtifacts,
  isPrivateAddress,
  observeTokenCatalog,
  recomputeObservationArtifacts,
  parseHttpsUrl,
  sourceFingerprint,
  validateObserverConfig,
  validateObservationArtifacts,
} from "./observer.mjs";

const config = JSON.parse(await readFile(new URL("./observer-config.json", import.meta.url), "utf8"));
const observerSchema = JSON.parse(await readFile(new URL("./observer.schema.json", import.meta.url), "utf8"));

function abiUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = bytes.length.toString(16).padStart(64, "0");
  const data = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${"20".padStart(64, "0")}${length}${data}`;
}

function accountFor(deployment, slot, overrides = {}) {
  return {
    context: { slot },
    value: {
      owner: overrides.owner ?? (deployment.standard === "spl-token" ? TOKEN_PROGRAM_IDS.splToken : TOKEN_PROGRAM_IDS.splToken2022),
      data: { program: "spl-token", parsed: { type: overrides.type ?? "mint", info: { decimals: overrides.decimals ?? deployment.decimals } }, space: 82 },
      executable: false,
      lamports: 1,
      rentEpoch: 0,
    },
  };
}

function makeRpcTransport({ catalog = CATALOG, wrongChain = null, malformedDecimals = null, wrongOwner = null, oldSlot = null, delays = new Map() } = {}) {
  const calls = [];
  const transport = async (request) => {
    const payload = JSON.parse(Buffer.from(request.body).toString("utf8"));
    calls.push({ endpointId: request.endpointId, ...payload });
    const delay = delays.get(payload.method);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (payload.method === "eth_chainId") return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: wrongChain === request.endpointId ? "0x999" : request.endpointId === "avalanche-c-public" ? "0xa86a" : "0x1" }) };
    if (payload.method === "eth_blockNumber") return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: request.endpointId === "avalanche-c-public" ? "0x5aee016" : "0x18c7852" }) };
    if (payload.method === "eth_getCode") return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x60006000" }) };
    if (payload.method === "eth_call") {
      const data = payload.params[0].data;
      const deployment = catalog.deployments.find((entry) => entry.address?.toLowerCase() === payload.params[0].to.toLowerCase());
      const result = data === "0x313ce567" ? abiUint(malformedDecimals === deployment?.deploymentId ? 256 : deployment.decimals) : abiString(deployment?.symbol ?? "UNKNOWN");
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }) };
    }
    if (payload.method === "getGenesisHash") return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: DEFAULT_RPC_ENDPOINTS.solana.expectedGenesisHash }) };
    if (payload.method === "getSlot") return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: 447257739 }) };
    if (payload.method === "getAccountInfo") {
      const deployment = catalog.deployments.find((entry) => entry.address === payload.params[0]);
      const account = accountFor(deployment, oldSlot === deployment?.deploymentId ? 447257738 : 447257740, {
        owner: wrongOwner === deployment?.deploymentId ? "11111111111111111111111111111111" : undefined,
      });
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: account }) };
    }
    throw new Error("unexpected method");
  };
  transport.calls = calls;
  return transport;
}

function makeCredentialEchoRpcTransport(secret) {
  const base = makeRpcTransport();
  return async (request) => {
    const payload = JSON.parse(Buffer.from(request.body).toString("utf8"));
    if (request.endpointId === "ethereum-public" && payload.method === "eth_call" && payload.params[0].data === "0x95d89b41") {
      const deployment = CATALOG.deployments.find((entry) => entry.address?.toLowerCase() === payload.params[0].to.toLowerCase());
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: abiString(secret) }) };
    }
    return base(request);
  };
}

function makeScalarCredentialEchoRpcTransport(secret, mode) {
  const base = makeRpcTransport();
  return async (request) => {
    const payload = JSON.parse(Buffer.from(request.body).toString("utf8"));
    if (mode === "block" && request.endpointId === "ethereum-public" && payload.method === "eth_blockNumber") {
      return { statusCode: 200, body: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: `0x${secret}` }) };
    }
    if (mode === "nested-type" && payload.method === "getAccountInfo" && payload.params[0] === "So11111111111111111111111111111111111111112") {
      const response = await base(request);
      const parsed = JSON.parse(response.body);
      parsed.result.value.data.parsed.type = { detail: secret };
      return { ...response, body: JSON.stringify(parsed) };
    }
    return base(request);
  };
}

function makeTimeoutRpcTransport(predicate) {
  const base = makeRpcTransport();
  return async (request) => {
    const payload = JSON.parse(Buffer.from(request.body).toString("utf8"));
    if (predicate(request, payload)) throw Object.assign(new Error("transient transport"), { code: "ETIMEDOUT" });
    return base(request);
  };
}

function makeSourceTransport({ bodyFor, failureSourceId = null, redirect = null, status = 200 } = {}) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (request.sourceId === failureSourceId) throw Object.assign(new Error("timeout details must not escape"), { code: "ETIMEDOUT" });
    if (redirect && request.url === redirect.from) return { statusCode: 302, headers: { location: redirect.to }, body: "" };
    const source = config.sources.find((entry) => entry.sourceId === request.sourceId);
    const body = bodyFor ? bodyFor(source) : source.format === "json" ? JSON.stringify({ reviewedSignals: source.signals.map((signal) => signal.literal) }) : source.signals.map((signal) => signal.literal).join("\n");
    return { statusCode: status, headers: { "content-type": source.format === "json" ? "application/json" : "text/plain" }, body };
  };
  transport.calls = calls;
  return transport;
}

function baseOptions(overrides = {}) {
  return {
    config,
    sourceSha: "a".repeat(40),
    rpcTransport: makeRpcTransport(),
    sourceTransport: makeSourceTransport(),
    baseline: null,
    workspace: { clean: true, pinned: true },
    clock: { now: () => Date.now(), sleep: async () => {} },
    ...overrides,
  };
}

test("config is the exact 41 URL union and digests deterministically", () => {
  assert.equal(validateObserverConfig(config, CATALOG), true);
  assert.equal(config.sources.length, 41);
  assert.match(computeConfigDigest(config), /^[0-9a-f]{64}$/u);
  assert.deepEqual(DEFAULT_RPC_ENDPOINTS.ethereum.url, "https://ethereum-rpc.publicnode.com");
  assert.deepEqual(DEFAULT_RPC_ENDPOINTS.avalancheC.expectedRpcChainId, "0xa86a");
});

test("source fingerprints preserve Solana base58 case while normalizing EVM hex case", () => {
  const solSource = config.sources.find((source) => source.signals.some((signal) => signal.kind === "address" && !/^0x/iu.test(signal.literal)));
  const solBody = Buffer.from(solSource.signals.map((signal) => signal.literal).join("\n"));
  const changedSolanaCase = solSource.signals.map((signal) => signal.kind === "address" && !/^0x/iu.test(signal.literal) ? signal.literal.toLowerCase() : signal.literal).join("\n");
  assert.notEqual(sourceFingerprint(solSource, solBody), sourceFingerprint(solSource, Buffer.from(changedSolanaCase)));
  const evmSource = config.sources.find((source) => source.signals.some((signal) => signal.kind === "address" && /^0x/iu.test(signal.literal)));
  const evmBody = evmSource.signals.map((signal) => signal.literal).join("\n");
  const changedEvmCase = evmSource.signals.map((signal) => signal.kind === "address" && /^0x/iu.test(signal.literal) ? signal.literal.toUpperCase() : signal.literal).join("\n");
  assert.equal(sourceFingerprint(evmSource, Buffer.from(evmBody)), sourceFingerprint(evmSource, Buffer.from(changedEvmCase)));
});

test("checked-in schema covers every emitted semantic source receipt field", async () => {
  const artifacts = await observeTokenCatalog(baseOptions());
  const allowed = new Set(Object.keys(observerSchema.$defs.sourceReceipt.properties));
  for (const receipt of artifacts.receipts.sources) {
    for (const key of Object.keys(receipt)) assert.equal(allowed.has(key), true, key);
  }
  assert.equal(allowed.has("signalCount"), true);
});

test("trusted recomputation permits only prior findings carried across transient failures", async () => {
  const sourceId = config.sources[0].sourceId;
  const sourcePrior = { findings: [{ category: "source-change", subjectId: sourceId, fingerprint: "3".repeat(64), code: "SOURCE_SIGNALS_CHANGED", severity: "review" }] };
  const sourceArtifacts = await observeTokenCatalog(baseOptions({ priorFindings: sourcePrior, sourceTransport: makeSourceTransport({ failureSourceId: sourceId }) }));
  assert.doesNotThrow(() => validateObservationArtifacts(sourceArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: sourcePrior, baseline: null }));
  assert.throws(() => validateObservationArtifacts(sourceArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config }), /derived|artifact/u);

  const networkPrior = { findings: [{ category: "network-identity", subjectId: "ethereum", fingerprint: "4".repeat(64), code: "NETWORK_IDENTITY_MISMATCH", severity: "action" }] };
  const networkArtifacts = await observeTokenCatalog(baseOptions({ priorFindings: networkPrior, rpcTransport: makeTimeoutRpcTransport((request, payload) => request.endpointId === "ethereum-public" && payload.method === "eth_chainId") }));
  assert.doesNotThrow(() => validateObservationArtifacts(networkArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: networkPrior, baseline: null }));
  assert.throws(() => validateObservationArtifacts(networkArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config }), /derived|artifact/u);

  const rpcPrior = { findings: [{ category: "rpc-observation", subjectId: "deployment-0002", fingerprint: "5".repeat(64), code: "EVM_SYMBOL_MISMATCH", severity: "action" }] };
  const rpcArtifacts = await observeTokenCatalog(baseOptions({ priorFindings: rpcPrior, rpcTransport: makeTimeoutRpcTransport((request, payload) => request.endpointId === "ethereum-public" && payload.method === "eth_call" && payload.params[0]?.to === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") }));
  assert.doesNotThrow(() => validateObservationArtifacts(rpcArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: rpcPrior, baseline: null }));
  assert.throws(() => validateObservationArtifacts(rpcArtifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config }), /derived|artifact/u);
});

test("successful observation covers all current deployments, uses pinned EVM blocks, and is bootstrap-eligible", async () => {
  const rpcTransport = makeRpcTransport();
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport }));
  assert.equal(artifacts.receipts.status, "complete");
  assert.equal(artifacts.receipts.deployments.length, CATALOG.deployments.length);
  assert.equal(artifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0002").status, "success");
  assert.equal(artifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0006").status, "success");
  assert.equal(artifacts.receipts.sources.length, 41);
  assert.equal(artifacts.reviewCandidate.baseline.eligibleBootstrap, true);
  assert.equal(exitCodeForArtifacts(artifacts), 2);
  validateObservationArtifacts(artifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config });
  const recomputed = recomputeObservationArtifacts(artifacts.receipts, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: { findings: [] }, baseline: null });
  assert.deepEqual(recomputed.findings, artifacts.findings);
  assert.deepEqual(recomputed.reviewCandidate, artifacts.reviewCandidate);
  const evmBlocks = rpcTransport.calls.filter((call) => ["eth_getCode", "eth_call"].includes(call.method)).map((call) => call.params.at(-1));
  assert.ok(evmBlocks.length > 0);
  assert.equal(new Set(evmBlocks.filter((value) => value === "0x18c7852")).size, 1);
  assert.equal(new Set(evmBlocks.filter((value) => value === "0x5aee016")).size, 1);
  assert.equal(rpcTransport.calls.filter((call) => call.method === "eth_blockNumber").length, 2);
});

test("current unclassified RPC evidence is excluded from web sources and proven by same-chain RPC receipts", async () => {
  const rpcSourceUrls = new Set(Object.values(DEFAULT_RPC_ENDPOINTS).map((endpoint) => endpoint.url));
  assert.ok(CATALOG.assets.some((asset) => asset.representationKind === "unclassified" && asset.evidence.some((url) => rpcSourceUrls.has(url))));
  const sourceTransport = makeSourceTransport();
  const artifacts = await observeTokenCatalog(baseOptions({ sourceTransport }));
  assert.equal(artifacts.receipts.sources.length, 41);
  assert.equal(sourceTransport.calls.some((request) => rpcSourceUrls.has(request.url)), false);
  for (const deployment of CATALOG.deployments.filter((entry) => CATALOG.assets.find((asset) => asset.assetId === entry.assetId)?.representationKind === "unclassified" && entry.evidence.some((url) => rpcSourceUrls.has(url)))) {
    const receipt = artifacts.receipts.deployments.find((entry) => entry.deploymentId === deployment.deploymentId);
    assert.equal(receipt.chainId, deployment.chainId);
    assert.equal(receipt.verification, deployment.chainId === TOKEN_CHAIN_IDS.solana ? "rpc-account-info" : "rpc");
  }
});

test("future unclassified Solana RPC evidence requires an exact same-chain token receipt", async () => {
  const catalog = structuredClone(CATALOG);
  const address = "5R6nWQf8R7p3dJ1eQ4zX6mY2wV9kC8bT5sH4gF3dE2a1";
  const assetId = "asset-appended-solana-rpc-proof";
  const deploymentId = "deployment-appended-solana-rpc-proof";
  catalog.assets.push({ assetId, name: `Unclassified token at ${address}`, representationKind: "unclassified", stableCurrency: null, underlyingAssetId: null, economicReferenceAssetId: null, evidence: [DEFAULT_RPC_ENDPOINTS.solana.url], asOfDate: CATALOG.manualAsOf });
  catalog.deployments.push({ deploymentId, assetId, chainId: TOKEN_CHAIN_IDS.solana, symbol: address, decimals: 9, standard: "spl-token", address, status: "active", replacedByDeploymentId: null, evidence: [DEFAULT_RPC_ENDPOINTS.solana.url], asOfDate: CATALOG.manualAsOf });
  catalog.aliases.push({ namespace: "solana", name: "DISCOVERED_SOLANA_RPC_PROOF", deploymentId });
  catalog.contentDigest = computeTokenDigest(catalog);
  const artifacts = await observeTokenCatalog(baseOptions({ catalog, rpcTransport: makeRpcTransport({ catalog }) }));
  const receipt = artifacts.receipts.deployments.find((entry) => entry.deploymentId === deploymentId);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.verification, "rpc-account-info");
  assert.equal(artifacts.receipts.sources.length, 41);
  const wrongChain = structuredClone(catalog);
  const wrongDeployment = wrongChain.deployments.find((entry) => entry.deploymentId === deploymentId);
  const wrongAsset = wrongChain.assets.find((entry) => entry.assetId === assetId);
  wrongDeployment.evidence = [DEFAULT_RPC_ENDPOINTS.ethereum.url];
  wrongAsset.evidence = [DEFAULT_RPC_ENDPOINTS.ethereum.url];
  wrongChain.contentDigest = computeTokenDigest(wrongChain);
  assert.throws(() => validateObserverConfig(config, wrongChain), (error) => error.code === "CONFIG_URL_SET_MISMATCH");
  const malicious = structuredClone(catalog);
  malicious.deployments.find((entry) => entry.deploymentId === deploymentId).evidence = ["https://evil.example/rpc"];
  malicious.assets.find((entry) => entry.assetId === assetId).evidence = ["https://evil.example/rpc"];
  malicious.contentDigest = computeTokenDigest(malicious);
  assert.throws(() => validateObserverConfig(config, malicious), (error) => error.code === "CONFIG_URL_SET_MISMATCH");
});

test("artifact validator rejects contradictory success details and recomputation drift", async () => {
  const artifacts = await observeTokenCatalog(baseOptions());
  const tampered = structuredClone(artifacts);
  tampered.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0002").observedDecimals = 99;
  assert.throws(() => validateObservationArtifacts(tampered, { sourceSha: "a".repeat(40), catalog: CATALOG, config }), /metadata is inconsistent|artifact/u);
  const forged = structuredClone(artifacts);
  forged.reviewCandidate.actionRequired = false;
  assert.throws(() => validateObservationArtifacts(forged, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: { findings: [] }, baseline: null }), /inconsistent|recomputation/u);
});

test("request-only credentials are never echoed into observation artifacts", async () => {
  const secret = "TESTONLY-CREDENTIAL-ECHO";
  const artifacts = await observeTokenCatalog(baseOptions({ rpcHeaders: { "x-api-key": secret }, rpcTransport: makeCredentialEchoRpcTransport(secret) }));
  const serialized = JSON.stringify(artifacts);
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  const echoed = artifacts.receipts.deployments.find((entry) => ["EVM_SYMBOL_INVALID", "RPC_RESULT_INVALID"].includes(entry.errorCode));
  assert.ok(echoed);
  assert.equal(Object.hasOwn(echoed, "observedSymbol"), false);
});

test("RPC URL query credentials are also excluded from echoed observations", async () => {
  const secret = "TESTONLY-URL-CREDENTIAL-ECHO";
  const urlConfig = structuredClone(config);
  urlConfig.rpc.ethereum.url = `https://ethereum-rpc.publicnode.com/rpc?project=${secret}`;
  const artifacts = await observeTokenCatalog(baseOptions({ config: urlConfig, rpcTransport: makeCredentialEchoRpcTransport(secret) }));
  assert.doesNotMatch(JSON.stringify(artifacts), new RegExp(secret, "u"));
  assert.ok(artifacts.receipts.deployments.some((entry) => ["EVM_SYMBOL_INVALID", "RPC_RESULT_INVALID"].includes(entry.errorCode)));
});

test("opaque RPC URL path credentials are excluded from echoed observations", async () => {
  const secret = "TESTONLYCREDENTIALECHO";
  const pathConfig = structuredClone(config);
  pathConfig.rpc.ethereum.url = `https://ethereum-rpc.publicnode.com/${secret}`;
  const artifacts = await observeTokenCatalog(baseOptions({ config: pathConfig, rpcTransport: makeCredentialEchoRpcTransport(secret) }));
  assert.doesNotMatch(JSON.stringify(artifacts), new RegExp(secret, "u"));
  assert.ok(artifacts.receipts.deployments.some((entry) => ["EVM_SYMBOL_INVALID", "RPC_RESULT_INVALID"].includes(entry.errorCode)));
});

test("credentials echoed by block identity or nested Solana metadata are never retained", async () => {
  const blockSecret = "deadbeef";
  const blockArtifacts = await observeTokenCatalog(baseOptions({ rpcHeaders: { "x-api-key": blockSecret }, rpcTransport: makeScalarCredentialEchoRpcTransport(blockSecret, "block") }));
  assert.doesNotMatch(JSON.stringify(blockArtifacts), new RegExp(blockSecret, "u"));
  assert.equal(blockArtifacts.receipts.networks.find((entry) => entry.network === "ethereum").errorCode, "RPC_RESULT_INVALID");
  const nestedSecret = "TESTONLYNESTEDECHO";
  const nestedArtifacts = await observeTokenCatalog(baseOptions({ rpcHeaders: { "x-api-key": nestedSecret }, rpcTransport: makeScalarCredentialEchoRpcTransport(nestedSecret, "nested-type") }));
  assert.doesNotMatch(JSON.stringify(nestedArtifacts), new RegExp(nestedSecret, "u"));
  assert.equal(nestedArtifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0006").errorCode, "RPC_RESULT_INVALID");
});

test("IPv6 private, mapped, translated, loopback, and family-mismatch forms are rejected", () => {
  for (const address of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:0:0:1", "64:ff9b::c000:201"]) assert.equal(isPrivateAddress(address, 6), true, address);
  assert.equal(isPrivateAddress("2001:4860:4860::8888", 6), false);
  assert.equal(isPrivateAddress("127.0.0.1", 6), true);
  assert.equal(isPrivateAddress("::1", 4), true);
});

test("wrong chain identity skips all downstream calls for that network", async () => {
  const rpcTransport = makeRpcTransport({ wrongChain: "ethereum-public" });
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport }));
  const ethereum = artifacts.receipts.deployments.filter((entry) => entry.chainId === TOKEN_CHAIN_IDS.ethereum);
  assert.equal(ethereum.length, CATALOG.deployments.filter((entry) => entry.chainId === TOKEN_CHAIN_IDS.ethereum).length);
  assert.ok(ethereum.every((entry) => entry.status === "skipped"));
  assert.equal(rpcTransport.calls.filter((call) => call.endpointId === "ethereum-public" && ["eth_blockNumber", "eth_getCode", "eth_call"].includes(call.method)).length, 0);
});

test("malformed EVM decimals produce a bounded fixed-code failure", async () => {
  const rpcTransport = makeRpcTransport({ malformedDecimals: "deployment-0002" });
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport, baseline: null }));
  const row = artifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0002");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "EVM_DECIMALS_OUT_OF_RANGE");
  assert.ok(artifacts.findings.findings.find((finding) => finding.subjectId === "deployment-0002"));
});

test("Solana uses finalized anchor and minContextSlot, checks owner/type, and never asks mint symbols", async () => {
  const rpcTransport = makeRpcTransport({ wrongOwner: "deployment-0006", oldSlot: "deployment-0007" });
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport }));
  const accountCalls = rpcTransport.calls.filter((call) => call.method === "getAccountInfo");
  assert.equal(accountCalls.length, CATALOG.deployments.filter((entry) => entry.chainId === TOKEN_CHAIN_IDS.solana && entry.standard !== "native").length);
  assert.ok(accountCalls.every((call) => call.params[1].commitment === "finalized" && call.params[1].encoding === "jsonParsed" && call.params[1].minContextSlot === 447257739));
  assert.equal(rpcTransport.calls.filter((call) => /symbol|Supply|Metadata/u.test(call.method)).length, 0);
  assert.equal(artifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0006").errorCode, "SOLANA_STANDARD_MISMATCH");
  assert.equal(artifacts.receipts.deployments.find((entry) => entry.deploymentId === "deployment-0007").errorCode, "SOLANA_CONTEXT_SLOT_BELOW_ANCHOR");
});

test("receipt order is deterministic despite delayed workers", async () => {
  const rpcTransport = makeRpcTransport({ delays: new Map([["eth_getCode", 2], ["getAccountInfo", 1]]) });
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport }));
  assert.deepEqual(artifacts.receipts.deployments.map((entry) => entry.deploymentId), [...artifacts.receipts.deployments].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)).map((entry) => entry.deploymentId));
  assert.deepEqual(artifacts.receipts.sources.map((entry) => entry.sourceId), [...artifacts.receipts.sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map((entry) => entry.sourceId));
});

test("dynamic body transport noise alone does not create a source finding", async () => {
  const first = await observeTokenCatalog(baseOptions());
  const baseline = { schemaVersion: 1, sources: first.receipts.sources.filter((source) => source.status === "success").map((source) => ({ sourceId: source.sourceId, fingerprint: source.fingerprint, mode: source.mode, approvedFinalUrls: [source.finalUrl] })) };
  const noisy = await observeTokenCatalog(baseOptions({ baseline, sourceTransport: makeSourceTransport({ bodyFor: (source) => source.mode === "semantic-signals" ? `${source.signals.map((signal) => signal.literal).join(" ")} random-render-${Math.random()}` : source.format === "json" ? JSON.stringify({ reviewedSignals: source.signals.map((signal) => signal.literal) }) : source.signals.map((signal) => signal.literal).join("\n") }) }));
  assert.equal(noisy.findings.findings.find((finding) => finding.category === "source-change"), undefined);
});

test("transient source failure preserves prior finding and blocks partial bootstrap", async () => {
  const sourceId = config.sources[0].sourceId;
  const prior = { schemaVersion: 1, status: "complete", findings: [{ category: "source-change", subjectId: sourceId, fingerprint: "b".repeat(64), code: "SOURCE_SIGNALS_CHANGED", severity: "review" }] };
  const artifacts = await observeTokenCatalog(baseOptions({ priorFindings: prior, sourceTransport: makeSourceTransport({ failureSourceId: sourceId }) }));
  assert.equal(artifacts.receipts.status, "partial");
  assert.equal(artifacts.reviewCandidate.baseline.eligibleBootstrap, false);
  assert.ok(artifacts.findings.findings.some((finding) => finding.subjectId === sourceId && finding.fingerprint === "b".repeat(64)));
  validateObservationArtifacts(artifacts, { sourceSha: "a".repeat(40), catalog: CATALOG, config, priorFindings: prior, baseline: null });
  assert.equal(exitCodeForArtifacts(artifacts), 3);
});

test("source URLs reject credentials/private targets and unexpected redirects", async () => {
  assert.throws(() => parseHttpsUrl("https://user:pass@example.com/path?token=secret", "test"), /HTTPS URL|credentials/u);
  assert.throws(() => parseHttpsUrl("https://127.0.0.1/private", "test"), /unsafe|reserved|local/u);
  const source = config.sources[0];
  const sourceConfig = structuredClone(config);
  sourceConfig.sources[0].allowedFinalUrls = [source.url, "https://example.com/approved"];
  const sourceTransport = makeSourceTransport({ redirect: { from: source.url, to: "https://example.com/unapproved" } });
  const redirected = await observeTokenCatalog(baseOptions({ config: sourceConfig, sourceTransport }));
  assert.ok(redirected.receipts.sources.some((entry) => entry.errorCode === "SOURCE_INVALID_REDIRECT"));
});

test("source body limits and source 404 are reported without retaining bodies", async () => {
  const oversized = makeSourceTransport({ bodyFor: () => Buffer.alloc(2 * 1024 * 1024 + 1) });
  const tooLarge = await observeTokenCatalog(baseOptions({ sourceTransport: oversized }));
  assert.ok(tooLarge.receipts.sources.every((source) => source.status === "failed" && source.errorCode === "SOURCE_BODY_LIMIT"));
  assert.ok(tooLarge.receipts.sources.every((source) => !Object.hasOwn(source, "body")));
  const missing = await observeTokenCatalog(baseOptions({ sourceTransport: makeSourceTransport({ status: 404 }) }));
  assert.ok(missing.findings.findings.find((finding) => finding.category === "source-unavailable"));
  assert.ok(missing.findings.findings.every((finding) => !Object.hasOwn(finding, "bodySha256")));
});

test("run budget bounds injected slow transports and marks the run partial", async () => {
  const started = Date.now();
  const slow = async () => new Promise(() => {});
  const artifacts = await observeTokenCatalog(baseOptions({ rpcTransport: slow, sourceTransport: slow, runBudgetMs: 20 }));
  assert.ok(Date.now() - started < 500, "bounded transport should not hang for the fixed 10/12 second socket timeout");
  assert.equal(artifacts.receipts.status, "partial");
  assert.equal(exitCodeForArtifacts(artifacts), 3);
});

test("unclassified EVM deployments require code and decimals without fetching or matching a symbol", async () => {
  const catalog = structuredClone(CATALOG);
  const deployment = catalog.deployments.find((entry) => entry.deploymentId === "deployment-0008");
  const asset = catalog.assets.find((entry) => entry.assetId === deployment.assetId);
  asset.representationKind = "unclassified";
  asset.name = `Unclassified token at ${deployment.address}`;
  asset.stableCurrency = null;
  asset.underlyingAssetId = null;
  asset.economicReferenceAssetId = null;
  catalog.contentDigest = computeTokenDigest(catalog);
  const rpc = makeRpcTransport();
  const artifacts = await observeTokenCatalog(baseOptions({ catalog, rpcTransport: rpc }));
  const receipt = artifacts.receipts.deployments.find((entry) => entry.deploymentId === deployment.deploymentId);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.symbolSource, "address-only");
  assert.equal(receipt.observedSymbol, undefined);
  assert.equal(rpc.calls.some((call) => call.method === "eth_call" && call.params[0].to.toLowerCase() === deployment.address.toLowerCase() && call.params[0].data === "0x95d89b41"), false);
});

test("a newly appended unclassified EVM deployment is observed with only code and decimals", async () => {
  const catalog = structuredClone(CATALOG);
  const address = "0x1111111111111111111111111111111111111111";
  const assetId = "asset-appended-observer-fixture";
  const deploymentId = "deployment-appended-observer-fixture";
  const evidenceUrl = config.sources[0].url;
  catalog.assets.push({ assetId, name: `Unclassified token at ${address}`, representationKind: "unclassified", stableCurrency: null, underlyingAssetId: null, economicReferenceAssetId: null, evidence: [evidenceUrl], asOfDate: CATALOG.manualAsOf });
  catalog.deployments.push({ deploymentId, assetId, chainId: TOKEN_CHAIN_IDS.ethereum, symbol: address, decimals: 18, standard: "erc20", address, status: "active", replacedByDeploymentId: null, evidence: [evidenceUrl], asOfDate: CATALOG.manualAsOf });
  catalog.aliases.push({ namespace: "ethereum", name: "DISCOVERED_1111111111111111", deploymentId });
  catalog.contentDigest = computeTokenDigest(catalog);
  const rpc = makeRpcTransport({ catalog });
  const artifacts = await observeTokenCatalog(baseOptions({ catalog, rpcTransport: rpc }));
  const receipt = artifacts.receipts.deployments.find((entry) => entry.deploymentId === deploymentId);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.symbolSource, "address-only");
  assert.equal(receipt.observedSymbol, undefined);
  assert.ok(rpc.calls.some((call) => call.method === "eth_getCode" && call.params[0].toLowerCase() === address));
  assert.ok(rpc.calls.some((call) => call.method === "eth_call" && call.params[0].to.toLowerCase() === address && call.params[0].data === "0x313ce567"));
  assert.equal(rpc.calls.some((call) => call.method === "eth_call" && call.params[0].to.toLowerCase() === address && call.params[0].data === "0x95d89b41"), false);
});
