import assert from "node:assert/strict";
import test from "node:test";

import { replayTokenRankings } from "./token-rankings.mjs";
import { PARITY_LANGUAGES, buildExpectedSnapshot, verifySnapshots } from "./verify-ranking-parity.mjs";

function rankingArtifact() {
  return replayTokenRankings({
    candidates: [
      {
        chainId: "eip155:1",
        deploymentId: "deployment-0008",
        valueNumerator: "3",
        valueDenominator: "2",
        observedAt: "2026-09-16T06:50:42Z",
        sourceId: "parity-test",
      },
    ],
  }, { chainId: "eip155:1" });
}

function snapshots(artifact) {
  const expected = buildExpectedSnapshot(artifact);
  return Object.fromEntries(PARITY_LANGUAGES.map((language) => [
    language,
    { ...structuredClone(expected), language, runtime: "native-" + language },
  ]));
}

test("ranking parity requires versioned native snapshots and captures known, empty, and unknown queries", () => {
  const artifact = rankingArtifact();
  const result = verifySnapshots(snapshots(artifact), artifact);
  assert.equal(result.status, "ok");
  const expected = buildExpectedSnapshot(artifact);
  assert.deepEqual(Object.keys(expected.behavior).sort(), ["", "__proto__", "constructor", "eip155:1", "eip155:43114", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "toString", "unknown:chain"].sort());
  assert.deepEqual(expected.behavior["eip155:1"].map((row) => row.deploymentIds), [["deployment-0008"]]);
  assert.deepEqual(expected.behavior[""], []);
  assert.deepEqual(expected.behavior["unknown:chain"], []);
});

test("ranking parity sorts map keys, binds language, and rejects runtime templates or duplicates", () => {
  const artifact = rankingArtifact();
  const valid = snapshots(artifact);
  const reordered = structuredClone(valid);
  reordered.typescript.behavior = Object.fromEntries(Object.entries(reordered.typescript.behavior).reverse());
  reordered.typescript.metadata = Object.fromEntries(Object.entries(reordered.typescript.metadata).reverse());
  assert.equal(verifySnapshots(reordered, artifact).status, "ok");
  const wrongLanguage = structuredClone(valid);
  wrongLanguage.typescript.language = "rust";
  assert.throws(() => verifySnapshots(wrongLanguage, artifact), /language does not match/u);
  const duplicate = structuredClone(valid);
  duplicate.rust.runtime = duplicate.typescript.runtime;
  assert.throws(() => verifySnapshots(duplicate, artifact), /runtimes must be unique/u);
  const template = structuredClone(valid);
  template.go.runtime = "registry-replay";
  assert.throws(() => verifySnapshots(template, artifact), /executed native package/u);
  const missingBehavior = structuredClone(valid);
  delete missingBehavior.ruby.behavior["unknown:chain"];
  assert.throws(() => verifySnapshots(missingBehavior, artifact), /behavior keys/u);
});
