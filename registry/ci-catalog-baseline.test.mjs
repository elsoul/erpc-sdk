import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BASELINE_STATUS,
  CATALOG_PATH,
  resolveCatalogBaseline,
  validateBaselineBinding,
} from "./ci-catalog-baseline.mjs";
import { computeDigest } from "./token-catalog.mjs";
import {
  CANONICAL_APPROVED_SOURCE_SHA,
  CANONICAL_PAIRED_TAG_PEEL,
  createGitFixture,
  createNonAncestorCommit,
  removeGitFixture,
} from "./test-git-fixture.mjs";

const SOURCE_COMMIT = CANONICAL_APPROVED_SOURCE_SHA;
const TAG_COMMIT = CANONICAL_PAIRED_TAG_PEEL;

test("baseline resolves from the validated PR base and verifies ancestry", () => {
  const fixture = createGitFixture({ prefix: "erpc-catalog-baseline-test-" });
  try {
    writeFileSync(path.join(fixture.root, "registry/baseline-test-note.md"), "candidate\n");
    fixture.git(["add", "registry/baseline-test-note.md"]);
    fixture.git(["-c", "user.name=Baseline Test", "-c", "user.email=baseline-test@example.invalid", "commit", "-m", "candidate"]);
    const head = fixture.git(["rev-parse", "HEAD"]);
    const result = resolveCatalogBaseline({ root: fixture.root, baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: head, runner: fixture.runner });
    assert.equal(result.baseSha, SOURCE_COMMIT);
    assert.equal(result.headSha, head);
    const baselineCatalog = JSON.parse(fixture.git(["show", `${SOURCE_COMMIT}:${CATALOG_PATH}`]));
    assert.equal(result.catalogDigest, computeDigest(baselineCatalog));
    assert.equal(result.baselinePath, CATALOG_PATH);
  } finally { removeGitFixture(fixture); }
});

test("baseline refs must agree and current HEAD cannot become the baseline", () => {
  assert.throws(() => validateBaselineBinding({ baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: TAG_COMMIT, expectedBaseSha: SOURCE_COMMIT }), (error) => error.code === BASELINE_STATUS.BASELINE_MISMATCH);
  assert.throws(() => resolveCatalogBaseline({ baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: SOURCE_COMMIT }), (error) => error.code === BASELINE_STATUS.CURRENT_AS_BASELINE);
});

test("missing history and non-ancestor heads are hard failures", () => {
  const fixture = createGitFixture({ prefix: "erpc-catalog-baseline-test-" });
  try {
    const missing = "f".repeat(40);
    assert.throws(() => resolveCatalogBaseline({ root: fixture.root, baseSha: missing, pushBeforeSha: missing, dispatchBaseSha: missing, headSha: SOURCE_COMMIT, runner: fixture.runner }), (error) => error.code === BASELINE_STATUS.MISSING_HISTORY);
    writeFileSync(path.join(fixture.root, "registry/nonancestor-test-note.md"), "candidate\n");
    fixture.git(["add", "registry/nonancestor-test-note.md"]);
    fixture.git(["-c", "user.name=Baseline Test", "-c", "user.email=baseline-test@example.invalid", "commit", "-m", "candidate"]);
    const nonAncestor = createNonAncestorCommit(fixture);
    assert.throws(() => resolveCatalogBaseline({ root: fixture.root, baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: nonAncestor, runner: fixture.runner }), (error) => error.code === BASELINE_STATUS.NOT_ANCESTOR);
  } finally { removeGitFixture(fixture); }
});
