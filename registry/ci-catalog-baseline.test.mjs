import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BASELINE_STATUS,
  CATALOG_PATH,
  resolveCatalogBaseline,
  validateBaselineBinding,
} from "./ci-catalog-baseline.mjs";
import { CATALOG, computeDigest } from "./token-catalog.mjs";

const SOURCE_COMMIT = "1eed9b24790dfe8267173a06ffdf3155e7c14057";
const TAG_COMMIT = "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc";

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: options.stdio ?? "pipe" }).trim();
}

function newFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "erpc-catalog-baseline-test-"));
  execFileSync("git", ["worktree", "add", "--detach", root, SOURCE_COMMIT], { encoding: "utf8", stdio: "ignore" });
  return root;
}

function removeFixture(root) {
  try { execFileSync("git", ["worktree", "remove", "--force", root], { encoding: "utf8", stdio: "ignore" }); } catch { rmSync(root, { recursive: true, force: true }); }
}

test("baseline resolves from the validated PR base and verifies ancestry", () => {
  const root = newFixture();
  try {
    writeFileSync(path.join(root, "registry/baseline-test-note.md"), "candidate\n");
    git(root, ["add", "registry/baseline-test-note.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Baseline Test", "-c", "user.email=baseline-test@example.invalid", "commit", "-m", "candidate"], { encoding: "utf8", stdio: "ignore" });
    const head = git(root, ["rev-parse", "HEAD"]);
    const result = resolveCatalogBaseline({ root, baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: head });
    assert.equal(result.baseSha, SOURCE_COMMIT);
    assert.equal(result.headSha, head);
    assert.equal(result.catalogDigest, computeDigest(CATALOG));
    assert.equal(result.baselinePath, CATALOG_PATH);
  } finally { removeFixture(root); }
});

test("baseline refs must agree and current HEAD cannot become the baseline", () => {
  assert.throws(() => validateBaselineBinding({ baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: TAG_COMMIT, expectedBaseSha: SOURCE_COMMIT }), (error) => error.code === BASELINE_STATUS.BASELINE_MISMATCH);
  assert.throws(() => resolveCatalogBaseline({ baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: SOURCE_COMMIT }), (error) => error.code === BASELINE_STATUS.CURRENT_AS_BASELINE);
});

test("missing history and non-ancestor heads are hard failures", () => {
  const root = newFixture();
  try {
    const missing = "f".repeat(40);
    assert.throws(() => resolveCatalogBaseline({ root, baseSha: missing, pushBeforeSha: missing, dispatchBaseSha: missing, headSha: SOURCE_COMMIT }), (error) => error.code === BASELINE_STATUS.MISSING_HISTORY);
    writeFileSync(path.join(root, "registry/nonancestor-test-note.md"), "candidate\n");
    git(root, ["add", "registry/nonancestor-test-note.md"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Baseline Test", "-c", "user.email=baseline-test@example.invalid", "commit", "-m", "nonancestor fixture"], { encoding: "utf8", stdio: "ignore" });
    assert.throws(() => resolveCatalogBaseline({ root, baseSha: SOURCE_COMMIT, pushBeforeSha: SOURCE_COMMIT, dispatchBaseSha: SOURCE_COMMIT, headSha: TAG_COMMIT }), (error) => error.code === BASELINE_STATUS.NOT_ANCESTOR);
  } finally { removeFixture(root); }
});
