import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CATALOG,
  OUTPUTS,
  compareHistory,
  computeDigest,
  renderLanguage,
  validateCatalog,
} from "./token-catalog.mjs";
import {
  PARITY_LANGUAGES,
  buildExpectedSnapshot,
  verifySnapshots,
} from "./verify-token-parity.mjs";

const REGISTRY_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE_PATH = path.join(REGISTRY_DIRECTORY, "fixtures", "token-catalog-cases.json");
const GROWTH_FIXTURE_PATH = path.join(REGISTRY_DIRECTORY, "fixtures", "catalog-growth-cases.json");
const SCHEMA_PATH = path.join(REGISTRY_DIRECTORY, "token-catalog.schema.json");
const CLI_PATH = path.join(REGISTRY_DIRECTORY, "generate-token-catalog.mjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withDigest(value) {
  value.contentDigest = computeDigest(value);
  return value;
}

function isEvm(chainId) {
  return chainId === "eip155:1" || chainId === "eip155:43114";
}

function identityKey(deployment) {
  const address = deployment.address === null
    ? "native"
    : isEvm(deployment.chainId)
      ? deployment.address.toLowerCase()
      : deployment.address;
  return [deployment.assetId, deployment.chainId, deployment.standard, address].join("\u0000");
}

function mutate(catalog, operation) {
  const next = clone(catalog);
  if (operation === "addExtraCatalogKey") {
    next.unexpected = true;
    return next;
  }
  if (operation === "setUnknownChain") {
    next.deployments[0].chainId = "eip155:999";
    return withDigest(next);
  }
  if (operation === "uppercaseEvmAddress") {
    const deployment = next.deployments.find((entry) => isEvm(entry.chainId) && entry.address !== null);
    deployment.address = deployment.address.toUpperCase();
    return withDigest(next);
  }
  if (operation === "invalidSolanaAddress") {
    const deployment = next.deployments.find((entry) => entry.chainId.startsWith("solana:") && entry.address !== null);
    deployment.address = "0";
    return withDigest(next);
  }
  if (operation === "setDecimalOutOfRange") {
    next.deployments[0].decimals = 256;
    return withDigest(next);
  }
  if (operation === "setNativeAddress") {
    const deployment = next.deployments.find((entry) => entry.standard === "native");
    deployment.address = "0x1111111111111111111111111111111111111111";
    return withDigest(next);
  }
  if (operation === "setInvalidAliasName") {
    next.aliases[0].name = "not-portable";
    return withDigest(next);
  }
  if (operation === "setUnknownAliasNamespace") {
    next.aliases[0].namespace = "polygon";
    return withDigest(next);
  }
  if (operation === "setWrongAliasChain") {
    next.aliases[0].deploymentId = next.deployments.find((entry) => entry.chainId === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").deploymentId;
    return withDigest(next);
  }
  if (operation === "setUnknownAssetReference") {
    const asset = next.assets.find((entry) => entry.representationKind === "wrapped");
    asset.underlyingAssetId = "asset-does-not-exist";
    return withDigest(next);
  }
  if (operation === "setCrossChainReplacement") {
    const deployment = next.deployments.find((entry) => entry.replacedByDeploymentId !== null);
    deployment.replacedByDeploymentId = next.deployments.find((entry) => entry.chainId !== deployment.chainId).deploymentId;
    return withDigest(next);
  }
  if (operation === "setUnclassifiedRelations") {
    const asset = next.assets.find((entry) => entry.representationKind === "issued");
    asset.representationKind = "unclassified";
    asset.stableCurrency = "USD";
    return withDigest(next);
  }
  if (operation === "removeDeployment") {
    const removed = next.deployments.shift();
    next.aliases = next.aliases.filter((alias) => alias.deploymentId !== removed.deploymentId);
    return withDigest(next);
  }
  if (operation === "rebindDeployment") {
    const deployment = next.deployments.find((entry) => isEvm(entry.chainId) && entry.address !== null);
    deployment.address = "0x1111111111111111111111111111111111111111";
    return withDigest(next);
  }
  if (operation === "removeAsset") {
    const asset = next.assets.at(-1);
    next.assets = next.assets.filter((entry) => entry.assetId !== asset.assetId);
    const removedDeploymentIds = new Set(next.deployments.filter((entry) => entry.assetId === asset.assetId).map((entry) => entry.deploymentId));
    next.deployments = next.deployments.filter((entry) => !removedDeploymentIds.has(entry.deploymentId));
    next.aliases = next.aliases.filter((entry) => !removedDeploymentIds.has(entry.deploymentId));
    return withDigest(next);
  }
  if (operation === "removeAlias") {
    next.aliases.shift();
    return withDigest(next);
  }
  if (operation === "retargetAlias") {
    const alias = next.aliases[0];
    alias.deploymentId = next.aliases[1].deploymentId;
    return withDigest(next);
  }
  throw new Error(`unknown test mutation ${operation}`);
}

function nativeSnapshots() {
  const expected = buildExpectedSnapshot(CATALOG);
  return Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(expected),
    language,
    runtime: `native-test-${language}`,
  }]));
}

test("canonical catalog validates and preserves immutable seed sentinels", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.equal(validateCatalog(CATALOG), true);
  assert.equal(computeDigest(CATALOG), CATALOG.contentDigest);
  assert.ok(CATALOG.assets.length > 0);
  assert.ok(CATALOG.deployments.length > 0);
  assert.ok(CATALOG.aliases.length > 0);
  for (const assetId of fixture.seedSentinels.assetIds) assert.ok(CATALOG.assets.some((asset) => asset.assetId === assetId), `missing seed asset ${assetId}`);
  for (const deploymentId of fixture.seedSentinels.deploymentIds) assert.ok(CATALOG.deployments.some((deployment) => deployment.deploymentId === deploymentId), `missing seed deployment ${deploymentId}`);
  for (const sentinel of fixture.seedSentinels.aliases) assert.ok(CATALOG.aliases.some((alias) => JSON.stringify(alias) === JSON.stringify(sentinel)), `missing seed alias ${sentinel.namespace}:${sentinel.name}`);
});

test("canonical schema is strict and documents every source field", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "catalogVersion", "manualAsOf", "contentDigest", "assets", "deployments", "aliases"]);
  assert.equal(schema.$defs.asset.additionalProperties, false);
  assert.equal(schema.$defs.deployment.additionalProperties, false);
  assert.equal(schema.$defs.alias.additionalProperties, false);
  assert.deepEqual(schema.$defs.alias.properties.namespace.enum, ["ethereum", "solana", "avalancheC"]);
  assert.ok(schema.$defs.asset.properties.representationKind.enum.includes("unclassified"));
  assert.equal(schema.$defs.asset.allOf[0].if.properties.representationKind.const, "unclassified");
  assert.equal(schema.$defs.asset.allOf[0].then.properties.stableCurrency.const, null);
  assert.equal(schema.$defs.asset.allOf[0].then.properties.underlyingAssetId.const, null);
  assert.equal(schema.$defs.asset.allOf[0].then.properties.economicReferenceAssetId.const, null);
  assert.deepEqual(schema.$defs.deployment.properties.status.enum, ["active", "legacy", "winding-down", "retired"]);
});

test("runtime records contain all required fields while omitting per-record provenance", () => {
  const expected = buildExpectedSnapshot(CATALOG);
  assert.deepEqual(Object.keys(expected.assets[0]).sort(), [
    "assetId", "economicReferenceAssetId", "name", "representationKind", "stableCurrency", "underlyingAssetId",
  ].sort());
  assert.deepEqual(Object.keys(expected.deployments[0]).sort(), [
    "address", "assetId", "chainId", "decimals", "deploymentId", "economicReferenceAssetId", "name",
    "representationKind", "replacedByDeploymentId", "stableCurrency", "standard", "status", "symbol", "underlyingAssetId",
  ].sort());
  for (const language of Object.keys(OUTPUTS)) {
    const source = renderLanguage(language);
    assert.doesNotMatch(source, /\bevidence\b/u, `${language} emitted provenance`);
    assert.doesNotMatch(source, /\basOfDate\b/u, `${language} emitted per-record as-of field`);
    assert.match(source, /CONTENT_DIGEST|content_digest|contentDigest/u, `${language} omitted global digest`);
    assert.match(source, /AS_OF_DATE|as_of_date|AS_OF_DATE|asOfDate/u, `${language} omitted global as-of`);
  }
});

test("Go renderer emits gofmt-idempotent source", (t) => {
  const candidates = [process.env.GOFMT, "gofmt"].filter(Boolean);
  let diff;
  let found = false;
  for (const candidate of candidates) {
    try {
      diff = execFileSync(candidate, ["-d"], { input: renderLanguage("go"), encoding: "utf8" });
      found = true;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!found) {
    t.skip("gofmt is unavailable in this environment");
    return;
  }
  assert.equal(diff, "");
});

test("deployment identity is the asset, chain, standard, and normalized address tuple", () => {
  const identities = new Set(CATALOG.deployments.map(identityKey));
  assert.equal(identities.size, CATALOG.deployments.length);
  for (const deployment of CATALOG.deployments) {
    if (deployment.standard === "native") {
      assert.equal(deployment.address, null);
      assert.equal(CATALOG.assets.find((asset) => asset.assetId === deployment.assetId).representationKind, "native");
    } else {
      assert.notEqual(deployment.address, null);
    }
  }
  const classicWsol = CATALOG.deployments.find((entry) => entry.standard === "spl-token" && entry.symbol === "WSOL");
  const token2022Wsol = CATALOG.deployments.find((entry) => entry.standard === "spl-token-2022" && entry.symbol === "WSOL");
  assert.ok(classicWsol);
  assert.ok(token2022Wsol);
  assert.notEqual(classicWsol.deploymentId, token2022Wsol.deploymentId);
  assert.notEqual(classicWsol.address, token2022Wsol.address);
  assert.notEqual(classicWsol.standard, token2022Wsol.standard);
});

test("reversing source arrays preserves digest and every renderer's bytes", () => {
  const reversed = {
    ...clone(CATALOG),
    assets: [...CATALOG.assets].reverse(),
    deployments: [...CATALOG.deployments].reverse(),
    aliases: [...CATALOG.aliases].reverse(),
  };
  reversed.contentDigest = computeDigest(reversed);
  assert.equal(reversed.contentDigest, CATALOG.contentDigest);
  assert.equal(validateCatalog(reversed), true);
  for (const language of Object.keys(OUTPUTS)) {
    assert.equal(renderLanguage(language, reversed), renderLanguage(language, CATALOG), `${language} changed with source ordering`);
  }
});

test("source provenance refresh does not change emitted bytes or digest", () => {
  const refreshed = clone(CATALOG);
  refreshed.assets[0].evidence = ["https://example.invalid/receipt-refresh"];
  refreshed.assets[0].asOfDate = "2026-09-16";
  refreshed.deployments[0].evidence = ["https://example.invalid/rpc-receipt-refresh"];
  refreshed.deployments[0].asOfDate = "2026-09-16";
  assert.equal(computeDigest(refreshed), CATALOG.contentDigest);
  assert.equal(validateCatalog(refreshed), true);
  for (const language of Object.keys(OUTPUTS)) assert.equal(renderLanguage(language, refreshed), renderLanguage(language, CATALOG));
});

test("runtime fact or global manual as-of changes update digest and emitted bytes", () => {
  const factChange = clone(CATALOG);
  factChange.deployments[1].symbol = `${factChange.deployments[1].symbol}_CHANGED`;
  factChange.contentDigest = computeDigest(factChange);
  assert.notEqual(factChange.contentDigest, CATALOG.contentDigest);
  assert.notEqual(renderLanguage("typescript", factChange), renderLanguage("typescript", CATALOG));

  const asOfChange = clone(CATALOG);
  const nextAsOf = new Date(`${CATALOG.manualAsOf}T00:00:00Z`);
  nextAsOf.setUTCDate(nextAsOf.getUTCDate() + 1);
  asOfChange.manualAsOf = nextAsOf.toISOString().slice(0, 10);
  asOfChange.contentDigest = computeDigest(asOfChange);
  assert.notEqual(asOfChange.contentDigest, CATALOG.contentDigest);
  assert.notEqual(renderLanguage("ruby", asOfChange), renderLanguage("ruby", CATALOG));
});

test("history guard accepts lifecycle updates and rejects immutable identity changes", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.ok(fixture.history.previous);
  assert.equal(fixture.history.validMigration.operation, "setDeploymentStatus");
  const migrated = clone(CATALOG);
  migrated.deployments.find((entry) => entry.deploymentId === fixture.history.validMigration.deploymentId).status = fixture.history.validMigration.value;
  migrated.contentDigest = computeDigest(migrated);
  assert.equal(compareHistory(migrated, CATALOG), true);

  for (const entry of fixture.history.invalidCases) {
    assert.throws(() => compareHistory(mutate(migrated, entry.operation), CATALOG), new RegExp(entry.expectError));
  }
});

test("validator rejects every fixture invalid case through in-memory mutations", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  for (const entry of fixture.invalidCases) {
    assert.throws(() => validateCatalog(mutate(CATALOG, entry.operation)), new RegExp(entry.expectError), entry.name);
  }
});

test("unclassified assets keep classification and relation fields explicitly null", () => {
  assert.throws(() => validateCatalog(mutate(CATALOG, "setUnclassifiedRelations")), /unclassified asset .*requires null/u);
});

test("append-only growth accepts an unclassified token and renders deterministically across source order", async () => {
  const fixture = JSON.parse(await readFile(GROWTH_FIXTURE_PATH, "utf8"));
  const next = withDigest({
    ...clone(CATALOG),
    assets: [...CATALOG.assets, fixture.token.asset],
    deployments: [...CATALOG.deployments, fixture.token.deployment],
    aliases: [...CATALOG.aliases, fixture.token.alias],
  });
  assert.equal(validateCatalog(next), true);
  assert.equal(compareHistory(next, CATALOG), true);
  assert.equal(next.assets.length - CATALOG.assets.length, fixture.expected.assetDelta);
  assert.equal(next.deployments.length - CATALOG.deployments.length, fixture.expected.deploymentDelta);
  assert.equal(next.aliases.length - CATALOG.aliases.length, fixture.expected.tokenAliasDelta);
  const nextExpected = buildExpectedSnapshot(next);
  const nextSnapshots = Object.fromEntries(PARITY_LANGUAGES.map((language) => [language, {
    ...clone(nextExpected),
    language,
    runtime: `native-growth-${language}`,
  }]));
  const parity = verifySnapshots(nextSnapshots, next);
  assert.equal(parity.catalogDigest, next.contentDigest);
  const reversed = withDigest({
    ...next,
    assets: [...next.assets].reverse(),
    deployments: [...next.deployments].reverse(),
    aliases: [...next.aliases].reverse(),
  });
  assert.equal(reversed.contentDigest, next.contentDigest);
  for (const language of Object.keys(OUTPUTS)) {
    const source = renderLanguage(language, next);
    assert.equal(source, renderLanguage(language, reversed), `${language} changed with appended source order`);
    assert.match(source, /unclassified|Unclassified/u, `${language} omitted unclassified representation`);
    assert.match(source, /GROW/u, `${language} omitted appended alias`);
    const aliasReference = {
      typescript: "deploymentId: tokens.ethereum.GROW",
      rust: "deployment_id: tokens::ethereum::GROW",
      python: "TokenAlias(\"ethereum\", \"GROW\", tokens.ethereum.GROW)",
      go: "DeploymentID: TokenEthereumGROW",
      ruby: "deployment_id: ERPC::Tokens::Ethereum[:GROW]",
    }[language];
    assert.ok(source.includes(aliasReference), `${language} alias row did not reference its generated public constant`);
  }
});

test("all language renderers treat quotes, backslashes, unicode, backticks, and interpolation markers as literals", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const mutated = clone(CATALOG);
  mutated.assets[0].name = fixture.codegen[0].assetName;
  mutated.deployments[0].symbol = fixture.codegen[0].symbol;
  mutated.contentDigest = computeDigest(mutated);
  assert.equal(validateCatalog(mutated), true);
  for (const language of Object.keys(OUTPUTS)) {
    const source = renderLanguage(language, mutated);
    assert.match(source, /Quoted|SYM/u, `${language} omitted literal payload`);
    assert.match(source, /unicode|☃/u, `${language} omitted unicode payload`);
    assert.doesNotMatch(source, /^\s*(?:Kernel\.exit|globalThis\.process)/mu, `${language} emitted executable marker`);
  }
});

test("native parity verifies full records, metadata, and behavior for all five packages", () => {
  const result = verifySnapshots(nativeSnapshots());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.languages.map((entry) => entry.language), PARITY_LANGUAGES);
  const changed = nativeSnapshots();
  changed.ruby.deployments[0].symbol = "DIFFERENT";
  assert.throws(() => verifySnapshots(changed), /ruby native runtime parity mismatch in deployments/u);
  const canonicalOnly = nativeSnapshots();
  canonicalOnly.python.runtime = "canonical-reference";
  assert.throws(() => verifySnapshots(canonicalOnly), /runtime must identify an executed native package/u);
});

test("parity CLI requires explicit native snapshots and rejects expected-template-only execution", () => {
  const result = spawnSync(process.execPath, [path.join(REGISTRY_DIRECTORY, "verify-token-parity.mjs")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit --snapshots or --snapshot input/u);
});

test("generation CLI is import-safe and rejects unsafe write modes", () => {
  const importResult = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(CLI_PATH)})`], { encoding: "utf8" });
  assert.equal(importResult.status, 0);
  assert.equal(importResult.stdout, "");
  const unknown = spawnSync(process.execPath, [CLI_PATH, "--language", "typescript", "--output", "elsewhere"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown option --output/u);
  const allWrite = spawnSync(process.execPath, [CLI_PATH, "--language", "all"], { encoding: "utf8" });
  assert.notEqual(allWrite.status, 0);
  assert.match(allWrite.stderr, /supported only with --check/u);
});

test("fixture has the required shared codegen, behavior, and history sections", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  assert.ok(Array.isArray(fixture.codegen) && fixture.codegen.length > 0);
  assert.ok(Array.isArray(fixture.behavior) && fixture.behavior.length > 0);
  assert.ok(fixture.history && fixture.history.previous && fixture.history.validMigration);
  assert.ok(Array.isArray(fixture.invalidCases) && fixture.invalidCases.length > 0);
});
