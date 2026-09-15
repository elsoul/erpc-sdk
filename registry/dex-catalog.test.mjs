import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  AS_OF_DATE,
  CATALOG,
  CONTENT_DIGEST,
  DEX_CHAIN_IDS,
  EVM_ABI_SELECTORS,
  VERSION,
  compareHistory,
  computeDigest,
  createQuoteDriver,
  dataModel,
  findPoolDefinitionByAddress,
  findPoolDefinitionsByPair,
  getDexDeployment,
  getNativeWrapDefinition,
  getPoolDefinition,
  listPoolDefinitions,
  quoteExactInput,
  quoteExactInputFromSnapshot,
  validateCatalog,
} from "./dex-catalog.mjs";
import {
  LANGUAGES,
  OUTPUTS,
  renderLanguage,
} from "./generate-dex-catalog.mjs";
import {
  PARITY_LANGUAGES,
  buildExpectedSnapshot,
  verifySnapshots,
} from "./verify-dex-parity.mjs";

const REGISTRY_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE_PATH = path.join(REGISTRY_DIRECTORY, "fixtures", "dex-catalog-cases.json");
const QUOTE_FIXTURE_PATH = path.join(REGISTRY_DIRECTORY, "fixtures", "swap-quote-cases.json");
const SCHEMA_PATH = path.join(REGISTRY_DIRECTORY, "dex-catalog.schema.json");
const GENERATOR_PATH = path.join(REGISTRY_DIRECTORY, "generate-dex-catalog.mjs");
const PARITY_PATH = path.join(REGISTRY_DIRECTORY, "verify-dex-parity.mjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withDigest(value) {
  value.contentDigest = computeDigest(value);
  return value;
}

function mutateCatalog(operation) {
  const next = clone(CATALOG);
  if (operation === "addExtraCatalogKey") {
    next.unexpected = true;
    return next;
  }
  if (operation === "setUnknownChain") next.dexDeployments[0].chainId = "eip155:999";
  if (operation === "uppercaseEvmProgram") next.dexDeployments[0].programAddress = next.dexDeployments[0].programAddress.toUpperCase();
  if (operation === "invalidSolanaPoolAddress") next.poolDefinitions[2].address = "0";
  if (operation === "setPoolWrongChain") next.poolDefinitions[0].chainId = DEX_CHAIN_IDS.avalancheC;
  if (operation === "setNativePoolToken") next.poolDefinitions[0].token0DeploymentId = "deployment-0001";
  if (operation === "duplicatePoolAddress") next.poolDefinitions[3].address = next.poolDefinitions[2].address;
  if (operation === "poolReplacementCycle") {
    const replacement = clone(next.poolDefinitions[0]);
    replacement.poolDefinitionId = "pool-9991";
    replacement.address = "0x1111111111111111111111111111111111111111";
    replacement.replacedByPoolDefinitionId = "pool-0001";
    next.poolDefinitions.push(replacement);
    next.poolDefinitions[0].replacedByPoolDefinitionId = "pool-9991";
  }
  if (operation === "setSolanaFee") next.poolDefinitions[2].adapter.feeNumerator = "1";
  if (operation === "duplicateAlias") next.aliases.push(clone(next.aliases[0]));
  if (operation === "setWrapWrongChain") next.nativeWrapDefinitions[1].chainId = DEX_CHAIN_IDS.ethereum;
  if (operation === "setWrapWrongAsset") next.nativeWrapDefinitions[0].wrappedTokenDeploymentId = "deployment-0008";
  return withDigest(next);
}

function rpcFromFixture(entry) {
  const trace = [];
  return {
    trace,
    request(method, params) {
      const index = trace.length;
      trace.push({ method, params: clone(params) });
      if (entry.mutation === "throwSourceError" && index === 0) {
        const error = new Error("provider source error");
        error.source = "fixture-provider";
        throw error;
      }
      if (!Array.isArray(entry.rpcResponses) || index >= entry.rpcResponses.length) throw new Error(`fixture response missing at index ${index}`);
      return clone(entry.rpcResponses[index]);
    },
  };
}

test("canonical DEX catalog validates with frozen counts and digest", () => {
  assert.equal(validateCatalog(CATALOG), true);
  assert.deepEqual({
    dexDeployments: CATALOG.dexDeployments.length,
    poolDefinitions: CATALOG.poolDefinitions.length,
    nativeWrapDefinitions: CATALOG.nativeWrapDefinitions.length,
    aliases: CATALOG.aliases.length,
  }, { dexDeployments: 4, poolDefinitions: 4, nativeWrapDefinitions: 3, aliases: 8 });
  assert.equal(computeDigest(CATALOG), CONTENT_DIGEST);
  assert.equal(VERSION, "1.0.0");
  assert.equal(AS_OF_DATE, "2026-09-15");
});

test("strict schema declares source fields and rejects extra record fields in runtime validator", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "catalogVersion", "manualAsOf", "contentDigest", "dexDeployments", "poolDefinitions", "nativeWrapDefinitions", "aliases"]);
  for (const definition of ["dexDeployment", "poolDefinition", "nativeWrapDefinition", "alias"]) assert.equal(schema.$defs[definition].additionalProperties, false);
  const extra = clone(CATALOG);
  extra.poolDefinitions[0].extra = true;
  extra.contentDigest = computeDigest(extra);
  assert.throws(() => validateCatalog(extra), /unknown key/u);
});

test("runtime model omits source evidence and per-record as-of dates", () => {
  const model = dataModel();
  assert.deepEqual(Object.keys(model), ["version", "asOfDate", "contentDigest", "chainIds", "dexDeployments", "poolDefinitions", "nativeWrapDefinitions", "aliases"]);
  for (const group of [model.dexDeployments, model.poolDefinitions, model.nativeWrapDefinitions, model.aliases]) {
    for (const record of group) {
      assert.equal(Object.hasOwn(record, "evidence"), false);
      assert.equal(Object.hasOwn(record, "asOfDate"), false);
    }
  }
});

test("lookup API includes all statuses and normalizes EVM addresses", () => {
  assert.equal(getDexDeployment("dex-deployment-0001").programAddress, "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");
  assert.equal(getDexDeployment("unknown"), null);
  assert.equal(getPoolDefinition("pool-0001").adapter.feeNumerator, "3");
  assert.equal(getPoolDefinition("unknown"), null);
  assert.equal(findPoolDefinitionByAddress(DEX_CHAIN_IDS.ethereum, "0xB4E16D0168E52D35CACD2C6185B44281EC28C9DC").poolDefinitionId, "pool-0001");
  assert.equal(findPoolDefinitionByAddress(DEX_CHAIN_IDS.solana, "FgH1dEvyRQoAqJjbUzzKVoM1HYdxTqPwjEF82kDH1kVe").poolDefinitionId, "pool-0003");
  assert.equal(findPoolDefinitionByAddress("unknown:chain", "not-an-address"), null);
  assert.deepEqual(findPoolDefinitionsByPair(DEX_CHAIN_IDS.ethereum, "deployment-0002", "deployment-0008").map((entry) => entry.poolDefinitionId), ["pool-0001"]);
  assert.deepEqual(findPoolDefinitionsByPair(DEX_CHAIN_IDS.solana, "deployment-0013", "deployment-0006").map((entry) => entry.poolDefinitionId), ["pool-0003", "pool-0004"]);
  assert.deepEqual(findPoolDefinitionsByPair("unknown:chain", "deployment-0002", "deployment-0008"), []);
  assert.deepEqual(listPoolDefinitions({ chainId: DEX_CHAIN_IDS.solana, tokenDeploymentId: "deployment-0006" }).map((entry) => entry.poolDefinitionId), ["pool-0003", "pool-0004"]);
  assert.equal(getNativeWrapDefinition("deployment-0001").wrappedTokenDeploymentId, "deployment-0002");
  assert.equal(getNativeWrapDefinition("native-wrap-0001"), null);
});

test("catalog history preserves immutable IDs, bindings, and aliases", () => {
  const lifecycle = clone(CATALOG);
  lifecycle.poolDefinitions[0].status = "legacy";
  lifecycle.contentDigest = computeDigest(lifecycle);
  assert.equal(compareHistory(lifecycle, CATALOG), true);
  const rebound = clone(lifecycle);
  rebound.poolDefinitions[0].address = "0x1111111111111111111111111111111111111111";
  rebound.contentDigest = computeDigest(rebound);
  assert.throws(() => compareHistory(rebound, CATALOG), /historical pool definition identity changed/u);
});

test("fixture invalid mutations cover strict catalog failures", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.deepEqual(fixture.canonicalCounts, { dexDeployments: 4, poolDefinitions: 4, nativeWrapDefinitions: 3, aliases: 8 });
  for (const entry of fixture.invalidCases) {
    assert.throws(() => validateCatalog(mutateCatalog(entry.operation)), new RegExp(entry.expectError), entry.name);
  }
});

test("all five renderers are deterministic and omit record provenance", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.deepEqual(LANGUAGES, ["typescript", "rust", "python", "go", "ruby"]);
  assert.deepEqual(Object.keys(OUTPUTS), LANGUAGES);
  const mutated = clone(CATALOG);
  mutated.dexDeployments[0].name = fixture.codegen[0].dexName;
  mutated.contentDigest = computeDigest(mutated);
  for (const language of LANGUAGES) {
    const source = renderLanguage(language, mutated);
    assert.equal(source, renderLanguage(language, mutated));
    assert.doesNotMatch(source, /evidence|asOfDate.*pool/u);
    assert.match(source, /DEX_CATALOG_CONTENT_DIGEST|DexCatalogContentDigest/u);
    assert.match(source, /Quoted/u);
  }
});

test("Rust and Go renderers are formatter-idempotent when formatters are installed", (t) => {
  const rustfmt = process.env.RUSTFMT ?? "rustfmt";
  const rust = spawnSync(rustfmt, ["--emit", "stdout", "--edition", "2021"], { input: renderLanguage("rust"), encoding: "utf8" });
  if (rust.error?.code === "ENOENT") t.skip("rustfmt is unavailable in this environment");
  else {
    assert.equal(rust.status, 0, rust.stderr);
    assert.equal(rust.stdout, renderLanguage("rust"));
  }
  const gofmt = process.env.GOFMT ?? "gofmt";
  const go = spawnSync(gofmt, ["-d"], { input: renderLanguage("go"), encoding: "utf8" });
  if (go.error?.code === "ENOENT") t.skip("gofmt is unavailable in this environment");
  else {
    assert.equal(go.status, 0, go.stderr);
    assert.equal(go.stdout, "");
  }
});

test("generator is import-safe, one-language write only, and all check is read-only", () => {
  const importResult = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(GENERATOR_PATH)})`], { encoding: "utf8" });
  assert.equal(importResult.status, 0);
  assert.equal(importResult.stdout, "");
  const unknown = spawnSync(process.execPath, [GENERATOR_PATH, "--language", "typescript", "--output", "elsewhere"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown option --output/u);
  const allWrite = spawnSync(process.execPath, [GENERATOR_PATH, "--language", "all"], { encoding: "utf8" });
  assert.notEqual(allWrite.status, 0);
  assert.match(allWrite.stderr, /supported only with --check/u);
});

test("generated TypeScript preserves literal readonly chain IDs for strict consumers", async (t) => {
  const candidates = [
    process.env.TSC,
    path.join(REGISTRY_DIRECTORY, "..", "packages", "typescript", "node_modules", ".bin", "tsc"),
    path.join(REGISTRY_DIRECTORY, "..", "node_modules", ".bin", "tsc"),
    "tsc",
  ].filter(Boolean);
  let compiler = null;
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.error?.code !== "ENOENT") {
      compiler = candidate;
      break;
    }
  }
  if (compiler === null) {
    t.skip("TypeScript compiler is unavailable in this environment");
    return;
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "erpc-dex-typescript-"));
  try {
    await writeFile(path.join(temporaryDirectory, "dex_catalog.ts"), renderLanguage("typescript"), "utf8");
    await writeFile(path.join(temporaryDirectory, "consumer.ts"), [
      'import { DEX_CHAIN_IDS, dexes, pools } from "./dex_catalog";',
      'const ethereum: "eip155:1" = DEX_CHAIN_IDS.ethereum;',
      'const solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" = DEX_CHAIN_IDS.solana;',
      'const avalanche: "eip155:43114" = DEX_CHAIN_IDS.avalancheC;',
      'const dex: "dex-deployment-0001" = dexes.ethereum.UNISWAP_V2;',
      'const pool: "pool-0001" = pools.ethereum.UNISWAP_V2_USDC_WETH;',
      "void [ethereum, solana, avalanche, dex, pool];",
      "",
    ].join("\n"), "utf8");
    const result = spawnSync(compiler, [
      "--strict",
      "--noUncheckedIndexedAccess",
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      path.join(temporaryDirectory, "consumer.ts"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("quote fixtures produce exact forward and reverse vectors with decimal strings", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  assert.deepEqual(fixture.contract.requestKeys, ["chainId", "poolDefinitionId", "inputTokenDeploymentId", "outputTokenDeploymentId", "amountIn", "freshness"]);
  for (const entry of fixture.validCases) {
    const quote = quoteExactInputFromSnapshot(entry.request, entry.snapshot, { now: 1789498700 });
    assert.deepEqual(quote, entry.outcome.value, entry.caseId);
    for (const [key, value] of Object.entries(quote)) if (["amountIn", "amountOut"].includes(key)) assert.equal(typeof value, "string");
    const rpc = rpcFromFixture(entry);
    const rpcQuote = await quoteExactInput(entry.request, { rpc: rpc.request.bind(rpc), now: 1789498700 });
    assert.deepEqual(rpcQuote, entry.outcome.value, `${entry.caseId}: rpc quote`);
    assert.deepEqual(rpc.trace, entry.rpcTrace, `${entry.caseId}: rpc trace`);
  }
});

test("RPC driver uses the exact eleven-call EIP-1898 sequence and frozen headers", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  const entry = fixture.validCases.find((candidate) => candidate.caseId === "ethereum-weth-usdc-forward");
  const rpc = rpcFromFixture(entry);
  const quote = await quoteExactInput(entry.request, { rpc: rpc.request.bind(rpc), now: entry.nowSeconds });
  assert.equal(quote.amountOut, "2393866186");
  assert.deepEqual(rpc.trace.map((entry) => entry.method), [
    "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getCode", "eth_call", "eth_call", "eth_call", "eth_call", "eth_call", "eth_getBlockByNumber", "eth_getBlockByNumber",
  ]);
  const selectorParams = rpc.trace.slice(2, 9).map((entry) => entry.params[1]);
  assert.equal(selectorParams.length, 7);
  for (const selector of selectorParams) assert.deepEqual(selector, { blockHash: "0x29ed72152f595cf0e190cccab56d5536dbc4eab289b82d343a498e9d256ca2fb", requireCanonical: true });
  assert.equal(rpc.trace[4].params[0].data.slice(0, 10), EVM_ABI_SELECTORS.factoryGetPair);
  assert.equal(rpc.trace[10].params[0], "0x18c7f20");
});

test("quote validation precedence rejects unsupported paths before any RPC", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  const base = clone(fixture.validCases[0].request);
  for (const entry of fixture.invalidCases) {
    const request = entry.request;
    let calls = 0;
    await assert.rejects(() => quoteExactInput(request, { rpc: () => { calls += 1; throw new Error("must not call RPC"); }, now: 1789498700 }), (error) => error.code === entry.outcome.code, entry.caseId);
    assert.equal(calls, 0, entry.caseId);
  }
});

test("malformed ABI, forged bindings, stale state, upstream errors, and cancellation are covered", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  for (const entry of fixture.rpcCases) {
    if (entry.outcome?.kind === "transport-error" && entry.mutation === "throwSourceError") {
      const source = new Error("upstream unchanged");
      await assert.rejects(() => quoteExactInput(entry.request, { rpc: () => { throw source; }, now: entry.nowSeconds }), (error) => error === source, entry.caseId);
      continue;
    }
    if (entry.outcome?.kind === "transport-error" && entry.mutation === "abortBeforeRequest") {
      const abortReason = new Error("cancelled");
      const controller = new AbortController();
      controller.abort(abortReason);
      let calls = 0;
      await assert.rejects(() => quoteExactInput(entry.request, { rpc: () => { calls += 1; }, signal: controller.signal, now: entry.nowSeconds }), (error) => error === abortReason, entry.caseId);
      assert.equal(calls, 0);
      continue;
    }
    const rpc = rpcFromFixture(entry);
    await assert.rejects(() => quoteExactInput(entry.request, { rpc: rpc.request.bind(rpc), now: entry.nowSeconds }), (error) => error.code === entry.outcome.code, entry.caseId);
    assert.deepEqual(rpc.trace, entry.rpcTrace, `${entry.caseId}: rpc trace`);
  }
});

test("quote snapshots request identifiers before asynchronous RPC work", async () => {
  const request = {
    chainId: DEX_CHAIN_IDS.ethereum,
    poolDefinitionId: "pool-0001",
    inputTokenDeploymentId: "deployment-0002",
    outputTokenDeploymentId: "deployment-0008",
    amountIn: "1000000000000000000",
  };
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  const fixtureRpc = rpcFromFixture(fixture.validCases[0]);
  let first = true;
  const rpc = async (method, params) => {
    if (first) {
      first = false;
      request.chainId = DEX_CHAIN_IDS.avalancheC;
      request.poolDefinitionId = "pool-0002";
      request.amountIn = "2";
    }
    return fixtureRpc.request(method, params);
  };
  const quote = await quoteExactInput(request, { rpc, now: 1789498700 });
  assert.equal(quote.chainId, DEX_CHAIN_IDS.ethereum);
  assert.equal(quote.poolDefinitionId, "pool-0001");
  assert.equal(quote.amountIn, "1000000000000000000");
});

test("RPC quote path handles every fixture arithmetic boundary", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  for (const entry of fixture.arithmeticCases) {
    const rpc = rpcFromFixture(entry);
    if (entry.outcome.kind === "success") {
      const actual = await quoteExactInput(entry.request, { rpc: rpc.request.bind(rpc), now: entry.nowSeconds });
      assert.deepEqual(actual, entry.outcome.value, entry.caseId);
    } else {
      await assert.rejects(() => quoteExactInput(entry.request, { rpc: rpc.request.bind(rpc), now: entry.nowSeconds }), (error) => error.code === entry.outcome.code, entry.caseId);
    }
    assert.deepEqual(rpc.trace, entry.rpcTrace, `${entry.caseId}: rpc trace`);
  }
});

test("reference quantity parsers reject oversized decimal and hex text before BigInt", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  const base = fixture.validCases[0];
  let calls = 0;
  await assert.rejects(() => quoteExactInput({ ...base.request, amountIn: "1".repeat(79) }, { rpc: () => { calls += 1; }, now: base.nowSeconds }), (error) => error.code === "SWAP_INVALID_ARGUMENT");
  assert.equal(calls, 0);

  const oversizedHeader = clone(base);
  oversizedHeader.rpcResponses[1].number = `0x${"1".repeat(65)}`;
  const headerRpc = rpcFromFixture(oversizedHeader);
  await assert.rejects(() => quoteExactInput(oversizedHeader.request, { rpc: headerRpc.request.bind(headerRpc), now: oversizedHeader.nowSeconds }), (error) => error.code === "SWAP_STATE_STALE");
  assert.equal(headerRpc.trace.length, 2);

  assert.throws(() => quoteExactInputFromSnapshot(base.request, { ...base.snapshot, blockNumber: `0x${"1".repeat(65)}` }, { now: base.nowSeconds }), (error) => error.code === "SWAP_INVALID_POOL_STATE");
  assert.throws(() => quoteExactInputFromSnapshot(base.request, { ...base.snapshot, reserve0: "1".repeat(79) }, { now: base.nowSeconds }), (error) => error.code === "SWAP_INVALID_POOL_STATE");
});

test("native parity compares six lookups plus alias and quote behaviors for five explicit runtimes", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  const expected = buildExpectedSnapshot();
  const snapshots = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-test-${language}`,
  }]));
  const result = verifySnapshots(snapshots);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languages.map((entry) => entry.language), PARITY_LANGUAGES);
  assert.ok(expected.behavior.alias.length > 0);
  assert.ok(expected.behavior.quote.length > 0);
  const quoteIds = new Set(expected.behavior.quote.map((entry) => entry.caseId));
  assert.equal(quoteIds.has("request-has-rpc"), false);
  assert.equal(quoteIds.has("explicit-null-freshness"), false);
  for (const entry of fixture.arithmeticCases) {
    const parityRow = expected.behavior.quote.find((row) => row.caseId === entry.caseId);
    assert.ok(parityRow);
    assert.equal(parityRow.rpcTrace.length, 11, entry.caseId);
  }
  const changed = clone(snapshots);
  changed.ruby.poolDefinitions[0].address = "forged";
  assert.throws(() => verifySnapshots(changed), /ruby native runtime parity mismatch in poolDefinitions/u);
  const canonicalOnly = clone(snapshots);
  canonicalOnly.python.runtime = "canonical-reference";
  assert.throws(() => verifySnapshots(canonicalOnly), /runtime must identify an executed native package/u);
});

test("parity CLI requires explicit native snapshots", () => {
  const result = spawnSync(process.execPath, [PARITY_PATH], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit --snapshots or --snapshot input/u);
});

test("fixtures declare quote rows with source-preserving outcomes and no public rpc request key", async () => {
  const fixture = JSON.parse(await readFile(QUOTE_FIXTURE_PATH, "utf8"));
  for (const entry of fixture.validCases) {
    assert.equal(Object.hasOwn(entry.request, "rpc"), false);
    assert.equal(entry.outcome.kind, "success");
    assert.ok(Array.isArray(entry.rpcTrace));
  }
  for (const entry of fixture.rpcCases) if (entry.outcome?.kind === "transport-error") assert.equal(entry.outcome.kind, "transport-error");
  assert.ok(fixture.invalidCases.some((entry) => entry.caseId === "request-has-rpc"));
});
