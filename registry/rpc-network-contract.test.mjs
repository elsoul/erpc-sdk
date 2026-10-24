import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import contract from "./rpc-network-contract.json" with { type: "json" };
import schema from "./rpc-network-contract.schema.json" with { type: "json" };
import fixture from "./fixtures/rpc-chain-contract-cases.json" with { type: "json" };
import fixtureSchema from "./rpc-chain-contract-cases.schema.json" with { type: "json" };
import {
  CONTRACT,
  FULL_SOLANA_GENESIS,
  LANGUAGES,
  OUTPUTS,
  canonicalProjection,
  computeDigest,
  expectedScope,
  runtimeProjection,
  validateContract,
} from "./rpc-network-contract.mjs";
import { checkLanguage, checkRustArtifactEvidence, renderLanguage, writeLanguage } from "./generate-rpc-network-contract.mjs";
import {
  SNAPSHOT_KIND,
  SNAPSHOT_SYNTHETIC_KIND,
  RUST_ARTIFACT_IDENTITY,
  buildExpectedSnapshot,
  computeSnapshotPayloadSha256,
  computeFixtureDigest,
  validateFixtures,
  verifySyntheticSnapshots,
} from "./verify-rpc-network-parity.mjs";

const clone = (value) => structuredClone(value);

const EXPECTED_RENDER_HASHES = Object.freeze({
  typescript: "5159bb1bf61b4e8ed63518c3f0e3368037ecd4e716dbc3f5ebfb0391afbc4dbe",
  rust: "1686f589bb5dfb751f357b96b8587999323c91835f37e2c6318d8b9f45d348de",
  python: "fcaba9df6a1f4972d6f52647d0f4f0ee769b07b74def4bdab5fd3adb2b35ff08",
  go: "3b49009fa21d7aa88d850c0c8e3c5a3c8a52b5664fa11d96f9b099559267bc84",
  ruby: "483eb1c9e0d5d7a24aa9c51eae6fcbc063f081143c4548bda09c7d03fdea1841",
});

test("canonical RPC contract is closed, exact, and claim-bounded", () => {
  assert.equal(validateContract(contract), true);
  assert.equal(contract.clientContracts.length, 18);
  assert.equal(contract.networks.length, 20);
  assert.equal(new Set(contract.clientContracts.map((entry) => entry.chainKey)).size, 18);
  assert.equal(new Set(contract.networks.map((entry) => entry.networkId)).size, 20);
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-mainnet").identity.expected, FULL_SOLANA_GENESIS.mainnet);
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-devnet").identity.expected, FULL_SOLANA_GENESIS.devnet);
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-testnet").identity.expected, FULL_SOLANA_GENESIS.testnet);
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-mainnet").identity.caip2, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-devnet").identity.caip2, undefined);
  assert.equal(contract.networks.find((entry) => entry.networkId === "rpc-solana-testnet").selection, "explicit-direct-only");
  assert.equal(contract.compatibilityExceptions.length, 19);
  assert.equal(contract.languageBindings.length, 75);
  assert.equal(contract.clientContracts.find((entry) => entry.clientContractId === "client-near-rpc").nativeBindingStatus, "approved-c5");
  assert.equal(contract.methodSets.find((entry) => entry.methodSetId === "near-read3").capabilities.find((entry) => entry.capabilityId === "near-block").parameterShape, "fixed-named");
  assert.deepEqual(contract.compatibilityExceptions.map((entry) => entry.exceptionId).sort(), [
    "ruby-arbitrum-synchronous-request-v1",
    "ruby-arc-synchronous-request-v1",
    "ruby-base-synchronous-request-v1",
    "ruby-bitcoin-synchronous-request-v1",
    "ruby-bsc-synchronous-request-v1",
    "ruby-hyperliquid-synchronous-request-v1",
    "ruby-kaia-synchronous-request-v1",
    "ruby-monad-synchronous-request-v1",
    "ruby-near-synchronous-request-v1",
    "ruby-optimism-synchronous-request-v1",
    "ruby-polygon-synchronous-request-v1",
    "ruby-robinhood-synchronous-request-v1",
    "ruby-soneium-synchronous-request-v1",
    "ruby-sui-synchronous-request-v1",
    "ruby-tron-synchronous-request-v1",
    "rust-bitcoin-decode-domain-v1",
    "rust-bitcoin-direct-diagnostic-v1",
    "rust-bitcoin-raw-batch-v1",
    "typescript-base-unconfigured-placeholder-v1",
  ]);
  assert.equal(contract.claimBoundaries.liveObservationIncluded, false);
  assert.equal(contract.clientContracts.find((entry) => entry.clientContractId === "client-bitcoin-rpc").responsePolicy.policyId, "bitcoin-exact-json-v1");
});

test("Ruby cancellation exceptions are exact per client and backreferenced", () => {
  const expected = [["client-polygon-rpc", "polygon"], ["client-bsc-rpc", "bsc"], ["client-optimism-rpc", "optimism"], ["client-kaia-rpc", "kaia"], ["client-soneium-rpc", "soneium"], ["client-monad-rpc", "monad"], ["client-hyperliquid-rpc", "hyperliquid"], ["client-arc-rpc", "arc"], ["client-robinhood-rpc", "robinhood"], ["client-near-rpc", "near"], ["client-tron-rpc", "tron"], ["client-sui-grpc", "sui"]];
  for (const [clientId, stem] of expected) {
    const client = contract.clientContracts.find((entry) => entry.clientContractId === clientId);
    const exceptionId = `ruby-${stem}-synchronous-request-v1`;
    assert.deepEqual(client.compatibilityExceptionIds, [exceptionId]);
    assert.deepEqual(contract.languageBindings.find((entry) => entry.bindingId === `ruby-${client.clientContractId}`).exceptionIds, [exceptionId]);
    assert.equal(contract.compatibilityExceptions.find((entry) => entry.exceptionId === exceptionId).clientContractId, client.clientContractId);
    assert.equal(fixture.cases.filter((entry) => entry.exceptionIds.includes(exceptionId)).length, 1);
  }
});

test("contract rejects unknown fields, dangling references, wrong identity, and unsupported exceptions", () => {
  const unknown = clone(contract);
  unknown.networks[0].unexpected = true;
  assert.throws(() => validateContract(unknown, { skipDigest: true }), /unknown field/u);
  const dangling = clone(contract);
  dangling.networks[0].clientContractId = "client-missing";
  assert.throws(() => validateContract(dangling, { skipDigest: true }), /unknown client/u);
  const wrongGenesis = clone(contract);
  wrongGenesis.networks.find((entry) => entry.networkId === "rpc-solana-mainnet").identity.expected = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  assert.throws(() => validateContract(wrongGenesis, { skipDigest: true }), /contentDigest|full|caip2|identity differs/u);
  const wildcard = clone(contract);
  wildcard.compatibilityExceptions[0].exceptionId = "legacy-behavior-allowed";
  assert.throws(() => validateContract(wildcard, { skipDigest: true }), /unsupported compatibility exception|incomplete/u);
});

test("hostile behavioral mutations fail after their semantic digest is refreshed", () => {
  for (const mutate of [
    (value) => { value.transportProfiles.find((entry) => entry.transportProfileId === "hosted-bitcoin-bearer-v1").authPolicy = "forward-all-caller-credentials"; },
    (value) => { value.methodSets.find((entry) => entry.methodSetId === "bitcoin-read12").capabilities[0].publicOperation = "wrongPublicOperation"; },
    (value) => { const identity = value.networks.find((entry) => entry.networkId === "rpc-base-mainnet").identity; identity.probe = "wrongProbe"; identity.parameters = ["wrong"]; },
    (value) => { const exception = value.compatibilityExceptions.find((entry) => entry.exceptionId === "rust-bitcoin-raw-batch-v1"); exception.language = "go"; exception.clientContractId = "client-ethereum-rpc"; exception.allowedDifference = "any behavior is allowed"; },
  ]) {
    const candidate = clone(contract);
    mutate(candidate);
    candidate.contentDigest = computeDigest(candidate);
    assert.throws(() => validateContract(candidate), /approved|differs|unsupported|identity|finite|transport|capability/u);
  }
});

test("all ten R3 hostile mutations fail the intended semantic check", () => {
  const mutations = [
    value => { value.compatibilityExceptions.find(x => x.exceptionId === "rust-bitcoin-raw-batch-v1").allowedDifference += " signing"; },
    value => { value.clientContracts.find(x => x.clientContractId === "client-bitcoin-rpc").compatibilityExceptionIds = []; },
    value => { value.languageBindings.find(x => x.bindingId === "typescript-client-bitcoin-rpc").capabilityIds = ["bitcoin-getblockcount"]; },
    value => { value.languageBindings.find(x => x.bindingId === "typescript-client-bitcoin-rpc").exceptionIds.push("rust-bitcoin-raw-batch-v1"); },
    value => { value.clientContracts.find(x => x.clientContractId === "client-base-rpc").forbiddenCapabilities = []; },
    value => { value.clientContracts.find(x => x.clientContractId === "client-base-rpc").endpointDiagnosticPolicyId = "leak-full-url-v1"; },
    value => { value.networks.find(x => x.networkId === "rpc-solana-devnet").selection = "hosted-or-explicit-direct"; },
    value => { value.networks.find(x => x.networkId === "rpc-base-mainnet").identity.caip2 = "eip155:999999"; },
    value => { const identity = value.networks.find(x => x.networkId === "rpc-bitcoin-mainnet").identity; identity.secondaryParameters = []; identity.secondaryProjection = "$.wrong"; },
    value => { value.methodSets.find(x => x.methodSetId === "bitcoin-read12").capabilities.find(x => x.capabilityId === "bitcoin-getblockcount").parameterPolicy.nativeParameterTypes.typescript = "wrong"; },
  ];
  for (const mutate of mutations) {
    const candidate = clone(contract);
    mutate(candidate);
    candidate.contentDigest = computeDigest(candidate);
    assert.throws(() => validateContract(candidate), /approved|differs|backreferences|binding|policy|selection|explicit-direct|CAIP|identity|parameter/u);
  }
});

test("semantic digest excludes only evidence and source order while behavioral changes digest", () => {
  const reversed = clone(contract);
  reversed.methodSets.reverse(); reversed.transportProfiles.reverse(); reversed.clientContracts.reverse(); reversed.networks.reverse(); reversed.compatibilityExceptions.reverse();
  assert.equal(computeDigest(reversed), contract.contentDigest);
  const evidence = clone(contract);
  evidence.asOfDate = "2026-10-24";
  evidence.networks[0].inventoryEvidence.observedAt = "2030-01-01T00:00:00Z";
  evidence.networks[0].identity.evidence[0].asOfDate = "2030-01-01";
  assert.equal(computeDigest(evidence), contract.contentDigest);
  const behavior = clone(contract);
  behavior.networks[0].identity.expected = "0x2";
  assert.notEqual(computeDigest(behavior), contract.contentDigest);
  assert.equal(canonicalProjection(contract).networks[0].inventoryEvidence, undefined);
  assert.equal(runtimeProjection(contract).networks[0].identity.evidence, undefined);
});

test("schemas are closed and include Bitcoin policy constants", () => {
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.clientContract.additionalProperties, false);
  assert.equal(schema.$defs.responsePolicy.properties.limits.properties.decodedEntityBytes.const, 67108864);
  assert.equal(fixtureSchema.additionalProperties, false);
  assert.equal(fixtureSchema.$defs.case.additionalProperties, false);
});

test("public default spellings remain distinct from normalized request roots", () => {
  for (const clientId of ["client-base-rpc", "client-arbitrum-rpc"]) {
    const client = contract.clientContracts.find((entry) => entry.clientContractId === clientId);
    const hosted = client.endpointModes.find((entry) => entry.mode === "hosted");
    assert.equal(hosted.publicDefault.endsWith("/"), false);
    assert.equal(hosted.defaultTarget.endsWith("/"), true);
  }
  const bitcoin = contract.clientContracts.find((entry) => entry.clientContractId === "client-bitcoin-rpc");
  assert.equal(bitcoin.endpointModes.find((entry) => entry.mode === "hosted").publicDefault, null);
});

test("portable fixture is closed, digest-bound, raw-number preserving, and complete", () => {
  assert.equal(validateFixtures(fixture), true);
  assert.equal(computeFixtureDigest(fixture), fixture.fixtureDigest);
  assert.ok(fixture.cases.length >= 20);
  const exact = fixture.cases.find((entry) => entry.caseId === "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values");
  assert.equal(typeof exact.mockExchange.response.body, "string");
  assert.match(exact.mockExchange.response.body, /9007199254740993/u);
  assert.equal(typeof fixture.cases.find((entry) => entry.caseId === "c5-sui-binary-limit-descriptor").mockExchange.request.body, "string");
  const mutation = clone(fixture);
  mutation.cases[0].operation.wireOperation = "changed";
  assert.throws(() => validateFixtures(mutation), /fixtureDigest mismatch|request method differs|wire operation/u);
});

test("scope is cumulative and has the approved row counts", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((cohort) => expectedScope(cohort).networkIds.length), [8, 11, 14, 17, 20]);
  assert.deepEqual(expectedScope(1).cohortIds, [0, 1]);
  assert.deepEqual(expectedScope(5).cohortIds, [0, 1, 2, 3, 4, 5]);
  assert.throws(() => expectedScope(0), /throughCohort/u);
  assert.throws(() => expectedScope(6), /throughCohort/u);
});

test("all renderers are deterministic and source-order independent", async () => {
  for (const language of LANGUAGES) {
    const first = renderLanguage(language);
    assert.equal(first, renderLanguage(language));
    assert.equal(createHash("sha256").update(first).digest("hex"), EXPECTED_RENDER_HASHES[language]);
    assert.match(first, new RegExp(contract.contentDigest, "u"));
    assert.match(first, /rpc-bitcoin-mainnet/u);
    assert.doesNotMatch(first, /reviewCondition|quicknode-manifest-2026-10-21|inventory-only/u);
  }
  const python = renderLanguage("python");
  const canonicalPayload = JSON.stringify(runtimeProjection(CONTRACT));
  const hostnames = [...new Set(canonicalPayload.match(/https:\/\/[A-Za-z0-9.-]+\.erpc\.global/gu) ?? [])];
  for (const hostname of hostnames) {
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expectedOccurrences = canonicalPayload.match(new RegExp(escaped, "gu"))?.length ?? 0;
    const lineOccurrences = python.split("\n").flatMap((line) => line.match(new RegExp(escaped, "gu")) ?? []).length;
    assert.equal(lineOccurrences, expectedOccurrences, `Python renderer split ${hostname}`);
  }
  assert.match(python, /https:\/\/soneium\.erpc\.global/u);
  const reversed = clone(CONTRACT);
  reversed.clientContracts.reverse();
  assert.equal(JSON.stringify(runtimeProjection(reversed)), JSON.stringify(runtimeProjection(CONTRACT)));
  assert.deepEqual(Object.keys(OUTPUTS).sort(), [...LANGUAGES].sort());

  const go = renderLanguage("go");
  assert.match(go, /const rpcNetworkContractDigest = /u);
  assert.match(go, /const rpcNetworkContractJSON = `/u);
  assert.doesNotMatch(go, /const RPCNetworkContract(?:Digest|JSON)/u);
  assert.match(go, /const DefaultBaseEndpoint = "https:\/\/base\.erpc\.global"/u);
  assert.match(go, /const DefaultArbitrumEndpoint = "https:\/\/arbitrum\.erpc\.global"/u);
  assert.match(go, /const DefaultPolygonEndpoint = "https:\/\/polygon\.erpc\.global"/u);
  assert.match(go, /const DefaultNearEndpoint = "https:\/\/near\.erpc\.global"/u);
  assert.match(go, /var PolygonRPCMethods = \[\]string\{/u);
  assert.match(go, /var SuiGRPCWebMethods = \[\]string\{/u);
  assert.match(go, /var NearRPCMethods = \[\]string\{/u);
  assert.match(go, /var BitcoinRPCMethods = \[\]string\{/u);
  assert.match(go, /var BaseRPCMethods = \[\]string\{/u);
  assert.match(go, /var ArbitrumRPCMethods = \[\]string\{/u);
  assert.match(go, /var bitcoinRPCMethods = \[\.\.\.\]string\{/u);
  assert.match(go, /var baseRPCMethods = \[\.\.\.\]string\{/u);
  assert.match(go, /var arbitrumRPCMethods = \[\.\.\.\]string\{/u);
  const goPayloadMatch = go.match(/const rpcNetworkContractJSON = `([\s\S]*)`\n\nconst DefaultBaseEndpoint/u);
  assert.ok(goPayloadMatch);
  assert.deepEqual(JSON.parse(goPayloadMatch[1].replaceAll("\\u0060", "`")), runtimeProjection(CONTRACT));

  const goRoot = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-go-"));
  const goPath = path.join(goRoot, "rpc_network_contract_generated.go");
  await writeFile(goPath, go, "utf8");
  assert.equal(execFileSync("gofmt", ["-d", goPath], { encoding: "utf8" }), "");
  execFileSync("go", ["tool", "compile", "-p", "erpc", "-o", path.join(goRoot, "generated.o"), goPath], { encoding: "utf8" });
  await writeFile(path.join(goRoot, "rpc_network_contract_test.go"), [
    "package erpc",
    "",
    "import (",
    "\t\"encoding/json\"",
    "\t\"testing\"",
    ")",
    "",
    "func TestGeneratedC1Facts(t *testing.T) {",
    "\tif DefaultBaseEndpoint != \"https://base.erpc.global\" || DefaultArbitrumEndpoint != \"https://arbitrum.erpc.global\" { t.Fatal(\"endpoint constants drifted\") }",
    "\twantBitcoin := []string{\"estimatesmartfee\", \"getbestblockhash\", \"getblock\", \"getblockchaininfo\", \"getblockcount\", \"getblockhash\", \"getblockheader\", \"getmempoolinfo\", \"getnetworkinfo\", \"getrawmempool\", \"getrawtransaction\", \"gettxout\"}",
    "\twantEVM := []string{\"eth_call\", \"eth_chainId\", \"eth_getBalance\"}",
    "\tif len(BitcoinRPCMethods) != len(wantBitcoin) || len(BaseRPCMethods) != len(wantEVM) || len(ArbitrumRPCMethods) != len(wantEVM) { t.Fatal(\"public method slices have unexpected lengths\") }",
    "\tfor i := range wantBitcoin { if BitcoinRPCMethods[i] != wantBitcoin[i] || bitcoinRPCMethods[i] != wantBitcoin[i] { t.Fatalf(\"Bitcoin method %d drifted\", i) } }",
    "\tfor i := range wantEVM { if BaseRPCMethods[i] != wantEVM[i] || baseRPCMethods[i] != wantEVM[i] || ArbitrumRPCMethods[i] != wantEVM[i] || arbitrumRPCMethods[i] != wantEVM[i] { t.Fatalf(\"EVM method %d drifted\", i) } }",
    "\tBitcoinRPCMethods[0], BaseRPCMethods[0], ArbitrumRPCMethods[0] = \"mutated\", \"mutated\", \"mutated\"",
    "\tif bitcoinRPCMethods[0] != wantBitcoin[0] || baseRPCMethods[0] != wantEVM[0] || arbitrumRPCMethods[0] != wantEVM[0] { t.Fatal(\"private routing facts followed mutable public slices\") }",
    "\tvar decoded map[string]any",
    "\tif err := json.Unmarshal([]byte(rpcNetworkContractJSON), &decoded); err != nil { t.Fatal(err) }",
    "\tif decoded[\"contentDigest\"] != rpcNetworkContractDigest { t.Fatal(\"private JSON/digest binding drifted\") }",
    "}",
    "",
  ].join("\n"), "utf8");
  execFileSync("go", ["test", "."], {
    cwd: goRoot,
    encoding: "utf8",
    env: { ...process.env, GO111MODULE: "off" },
  });

  const ruby = renderLanguage("ruby");
  assert.match(ruby, /module ERPC\n/u);
  assert.match(ruby, /private_constant :RPC_NETWORK_CONTRACT_DIGEST, :RPC_NETWORK_CONTRACT/u);
  assert.doesNotMatch(ruby, /^RPC_NETWORK_CONTRACT(?:_DIGEST)?\s*=/mu);
  const rubyPayloadMatch = ruby.match(/  RPC_NETWORK_CONTRACT = JSON\.parse\(%q!([\s\S]*)!\)\.freeze\n/u);
  assert.ok(rubyPayloadMatch);
  assert.deepEqual(JSON.parse(rubyPayloadMatch[1]), runtimeProjection(CONTRACT));
  const rubyRoot = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-ruby-"));
  const rubyPath = path.join(rubyRoot, "rpc_network_contract.rb");
  await writeFile(rubyPath, ruby, "utf8");
  assert.match(execFileSync("ruby", ["-c", rubyPath], { encoding: "utf8" }), /Syntax OK/u);
  execFileSync("ruby", ["-e", [
    "load ARGV.fetch(0)",
    "raise 'digest leaked to Object' if Object.const_defined?(:RPC_NETWORK_CONTRACT_DIGEST, false)",
    "raise 'payload leaked to Object' if Object.const_defined?(:RPC_NETWORK_CONTRACT, false)",
    "raise 'ERPC digest missing' unless ERPC.const_defined?(:RPC_NETWORK_CONTRACT_DIGEST, false)",
    "raise 'ERPC payload missing' unless ERPC.const_defined?(:RPC_NETWORK_CONTRACT, false)",
    "raise 'digest is not private' unless begin; ERPC::RPC_NETWORK_CONTRACT_DIGEST; false; rescue NameError => error; error.message.include?('private constant'); end",
    "raise 'payload is not private' unless begin; ERPC::RPC_NETWORK_CONTRACT; false; rescue NameError => error; error.message.include?('private constant'); end",
    "raise 'digest/payload mismatch' unless ERPC.const_get(:RPC_NETWORK_CONTRACT, false)['contentDigest'] == ERPC.const_get(:RPC_NETWORK_CONTRACT_DIGEST, false)",
  ].join("\n"), rubyPath], { encoding: "utf8" });
});

test("single-language writer creates no missing package parent and writes only an approved path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-"));
  await assert.rejects(() => writeLanguage("typescript", root), /parent.*does not exist/u);
  await mkdir(path.join(root, "packages/typescript/src/generated"), { recursive: true });
  await writeLanguage("typescript", root);
  const target = path.join(root, OUTPUTS.typescript);
  const first = await import("node:fs/promises").then((fs) => fs.readFile(target, "utf8"));
  assert.equal(first, renderLanguage("typescript"));
  await assert.rejects(() => writeLanguage("all", root), /unknown language/u);
  const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-link-"));
  await mkdir(path.join(symlinkRoot, "packages/typescript/src/generated"), { recursive: true });
  await symlink(target, path.join(symlinkRoot, OUTPUTS.typescript));
  await assert.rejects(() => writeLanguage("typescript", symlinkRoot), /symlink/u);
  const ancestorRoot = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-ancestor-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-contract-outside-"));
  await mkdir(path.join(outside, "typescript/src/generated"), { recursive: true });
  const outsideTarget = path.join(outside, "typescript/src/generated/rpc_network_contract.ts");
  await writeFile(outsideTarget, "outside-sentinel\n");
  await symlink(outside, path.join(ancestorRoot, "packages"), "dir");
  await assert.rejects(() => writeLanguage("typescript", ancestorRoot), /symlink component/u);
  await assert.rejects(() => checkLanguage("typescript", ancestorRoot), /symlink component/u);
  assert.equal(await readFile(outsideTarget, "utf8"), "outside-sentinel\n");
});

test("aggregate projection check documents the mandatory Rust receipt and bounds its paths", async () => {
  const help = execFileSync(process.execPath, ["registry/generate-rpc-network-contract.mjs", "--help"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.match(help, /--check --language all --rust-artifact-evidence/u);
  const root = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-rust-evidence-"));
  const receiptPath = path.join(root, "receipt.json");
  const receipt = {
    version: 1,
    evidenceDirectory: ".",
    rustCratePath: "crate.bin",
    rustSnapshotPath: "snapshot.json",
    rustRenderSha256: "a".repeat(64),
    rustSnapshotFileSha256: "b".repeat(64),
    contractDigest: contract.contentDigest,
    fixtureDigest: fixture.fixtureDigest,
  };
  await writeFile(receiptPath, JSON.stringify({ ...receipt, rustCratePath: "../crate.bin" }));
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /bounded relative path|escapes/u);
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(path.join(root, "crate.bin"), "short\n");
  await writeFile(path.join(root, "snapshot.json"), "{}\n");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /crate size/u);
});

test("Rust evidence containment walks every selected component with self-contained symlink negatives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-rust-containment-"));
  const receiptPath = path.join(root, "receipt.json");
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const writeReceipt = async (evidenceDirectory, rustCratePath, rustSnapshotPath) => {
    await writeFile(receiptPath, JSON.stringify({ version: 1, evidenceDirectory, rustCratePath, rustSnapshotPath, rustRenderSha256: "a".repeat(64), rustSnapshotFileSha256: "b".repeat(64), contractDigest: contract.contentDigest, fixtureDigest: fixture.fixtureDigest }));
  };
  const crateDirTarget = path.join(evidenceRoot, "crate-dir-target"); await mkdir(crateDirTarget, { recursive: true }); await writeFile(path.join(crateDirTarget, "crate"), "short\n"); await symlink("crate-dir-target", path.join(evidenceRoot, "crate-dir-link"), "dir");
  await writeReceipt("evidence", "crate-dir-link/crate", "missing-snapshot");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /symlink component/u);
  await writeFile(path.join(evidenceRoot, "crate-final-target"), "short\n"); await symlink("crate-final-target", path.join(evidenceRoot, "crate-final-link"));
  await writeReceipt("evidence", "crate-final-link", "missing-snapshot");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /symlink component/u);
  await writeFile(path.join(evidenceRoot, "missing-crate"), "short\n");
  const snapshotDirTarget = path.join(evidenceRoot, "snapshot-dir-target"); await mkdir(snapshotDirTarget, { recursive: true }); await writeFile(path.join(snapshotDirTarget, "snapshot"), "{}\n"); await symlink("snapshot-dir-target", path.join(evidenceRoot, "snapshot-dir-link"), "dir");
  await writeReceipt("evidence", "missing-crate", "snapshot-dir-link/snapshot");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /symlink component/u);
  await writeFile(path.join(evidenceRoot, "snapshot-final-target"), "{}\n"); await symlink("snapshot-final-target", path.join(evidenceRoot, "snapshot-final-link"));
  await writeReceipt("evidence", "missing-crate", "snapshot-final-link");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /symlink component/u);
  const nestedTarget = path.join(root, "nested-evidence-target"); await mkdir(nestedTarget, { recursive: true }); await writeFile(path.join(nestedTarget, "crate"), "short\n"); await symlink("nested-evidence-target", path.join(root, "nested-evidence-link"), "dir");
  await writeReceipt("nested-evidence-link", "crate", "missing-snapshot");
  await assert.rejects(() => checkRustArtifactEvidence(receiptPath), /symlink component/u);
});

test("optional preserved Rust artifact regular-file positive", async (t) => {
  const preservedCrate = process.env.ERPC_SDK_RUST_ARTIFACT_PATH;
  if (!preservedCrate) {
    t.skip("set ERPC_SDK_RUST_ARTIFACT_PATH to run the external preserved-crate integration positive");
    return;
  }
  const crateBytes = await readFile(path.resolve(preservedCrate));
  assert.equal(crateBytes.length, RUST_ARTIFACT_IDENTITY.crateSizeBytes);
  assert.equal(createHash("sha256").update(crateBytes).digest("hex"), RUST_ARTIFACT_IDENTITY.crateSha256);
  const root = await mkdtemp(path.join(os.tmpdir(), "erpc-rpc-rust-positive-"));
  const receiptPath = path.join(root, "receipt.json");
  await writeFile(path.join(root, "crate"), crateBytes);
  const snapshot = buildExpectedSnapshot({ language: "rust" });
  snapshot.snapshotKind = SNAPSHOT_KIND;
  snapshot.runtime = "rust-0.11.0-test-only-semantic";
  const payloadSha256 = computeSnapshotPayloadSha256(snapshot);
  snapshot.evidence = { kind: "rust-immutable-artifact-v1", command: "test-only-semantic-capture", exitCode: 0, sourceIdentity: RUST_ARTIFACT_IDENTITY, consumer: { command: "test-only-semantic-consumer", exitCode: 0, status: "success" }, capture: { command: "test-only-semantic-capture", exitCode: 0, snapshotSha256: payloadSha256, networkCount: 20, caseCount: Object.keys(snapshot.behavior).length }, snapshotSha256: payloadSha256 };
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  await writeFile(path.join(root, "snapshot"), snapshotBytes);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(receiptPath, JSON.stringify({ version: 1, evidenceDirectory: ".", rustCratePath: "crate", rustSnapshotPath: "snapshot", rustRenderSha256: sha256(Buffer.from(renderLanguage("rust"))), rustSnapshotFileSha256: sha256(snapshotBytes), contractDigest: contract.contentDigest, fixtureDigest: fixture.fixtureDigest }));
  assert.match(await checkRustArtifactEvidence(receiptPath), /rust-artifact-evidence: OK/u);
});

test("synthetic expected snapshots verify each cumulative scope and reject drift", () => {
  for (const throughCohort of [1, 2, 3, 4, 5]) {
    const snapshots = LANGUAGES.map((language) => buildExpectedSnapshot({ language, throughCohort }));
    const result = verifySyntheticSnapshots(snapshots, { throughCohort });
    assert.equal(result.networkRows, [8, 11, 14, 17, 20][throughCohort - 1]);
    assert.equal(snapshots[0].snapshotKind, SNAPSHOT_SYNTHETIC_KIND);
  }
  const snapshots = LANGUAGES.map((language) => buildExpectedSnapshot({ language }));
  const wrongScope = clone(snapshots);
  wrongScope[0].scope.networkIds.pop();
  assert.throws(() => verifySyntheticSnapshots(wrongScope), /scope/u);
  const missingLanguage = snapshots.slice(0, 4);
  assert.throws(() => verifySyntheticSnapshots(missingLanguage), /exactly 5/u);
  const rounded = clone(snapshots);
  rounded[0].behavior["c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values"].numericTuples[0].coefficient = "9007199254740992";
  assert.throws(() => verifySyntheticSnapshots(rounded), /behavior/u);
  const leaked = clone(snapshots);
  leaked[0].behavior["c1-hosted-bitcoin-bearer-no-query-null-error"].trace.target = "https://edge.erpc.global/bitcoin?api-key=fixture-api-key";
  assert.throws(() => verifySyntheticSnapshots(leaked), /credential sentinel/u);
});
