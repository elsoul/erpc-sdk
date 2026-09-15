import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPROVED_SOURCE_SHA,
  BASELINE_VERSION,
  CATALOG_RUNTIME_PATHS,
  PACKAGE_VERSION_PATHS,
  REPOSITORY_ROOT,
  STATUS,
  compareVersions,
  inspectRelease,
  parseStableVersion,
  prepareRelease,
} from "./release-prep.mjs";
import { CATALOG, computeDigest, validateCatalog } from "./token-catalog.mjs";

const BASELINE_TAG_COMMIT = "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc";
const WORKTREE_BASE = APPROVED_SOURCE_SHA;

function git(root, args, { stdio = "pipe" } = {}) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio }).trim();
}

function newWorktree() {
  const root = mkdtempSync(path.join(tmpdir(), "erpc-release-prep-test-"));
  execFileSync("git", ["worktree", "add", "--detach", root, WORKTREE_BASE], { encoding: "utf8", stdio: "ignore" });
  const planTarget = path.join(root, "registry/release-plan.json");
  writeFileSync(planTarget, readFileSync(path.join(process.cwd(), "registry/release-plan.json"), "utf8"));
  commitAll(root, "fixture approved release plan");
  return root;
}

function removeWorktree(root) {
  try { execFileSync("git", ["worktree", "remove", "--force", root], { encoding: "utf8", stdio: "ignore" }); } catch { rmSync(root, { recursive: true, force: true }); }
}

function newIsolatedRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "erpc-release-prep-repo-"));
  execFileSync("git", ["clone", "--local", "--no-hardlinks", REPOSITORY_ROOT, root], { encoding: "utf8", stdio: "ignore" });
  const planTarget = path.join(root, "registry/release-plan.json");
  const expectedPlan = readFileSync(path.join(REPOSITORY_ROOT, "registry/release-plan.json"), "utf8");
  const existingPlan = readFileSync(planTarget, "utf8");
  if (existingPlan !== expectedPlan) {
    writeFileSync(planTarget, expectedPlan);
    execFileSync("git", ["-C", root, "add", "registry/release-plan.json"], { encoding: "utf8", stdio: "ignore" });
    execFileSync("git", ["-C", root, "-c", "user.name=Release Prep Test", "-c", "user.email=release-prep-test@example.invalid", "commit", "-m", "fixture approved release plan"], { encoding: "utf8", stdio: "ignore" });
  }
  assert.equal(git(root, ["status", "--porcelain"]), "", "isolated fixture must be clean after plan checkout");
  return root;
}

function removeIsolatedRepo(root) {
  rmSync(root, { recursive: true, force: true });
}

async function withWorktree(callback) {
  const root = newWorktree();
  const expectedHead = git(root, ["rev-parse", "HEAD"]);
  try {
    assert.equal(git(root, ["status", "--porcelain"]), "", "post-checkout fixture must be clean");
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD", "candidate fixture must remain detached like a PR merge checkout");
    return await callback(root, expectedHead);
  } finally { removeWorktree(root); }
}

function commitAll(root, message) {
  git(root, ["add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Release Prep Test", "-c", "user.email=release-prep-test@example.invalid", "commit", "-m", message], { encoding: "utf8", stdio: "ignore" });
  return git(root, ["rev-parse", "HEAD"]);
}

function replaceVersionInFixture(root, version) {
  const replacements = [
    ["packages/typescript/package.json", /^([ \t]*"version"[ \t]*:[ \t]*")[^"]+(")/mu],
    ["packages/rust/Cargo.toml", /(^\[package\][\s\S]*?^version[ \t]*=[ \t]*")[^"]+(")/mu],
    ["packages/python/pyproject.toml", /(^\[project\][\s\S]*?^version[ \t]*=[ \t]*")[^"]+(")/mu],
    ["packages/python/src/erpc_sdk/__init__.py", /(^__version__[ \t]*=[ \t]*")[^"]+(")/mu],
    ["packages/ruby/lib/erpc_sdk/version.rb", /(^[ \t]*VERSION[ \t]*=[ \t]*")[^"]+(")/mu],
  ];
  for (const [relativePath, pattern] of replacements) {
    const target = path.join(root, relativePath);
    const source = readFileSync(target, "utf8");
    assert.equal([...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length, 1, relativePath);
    writeFileSync(target, source.replace(pattern, `$1${version}$2`));
  }
  const lock = path.join(root, "Cargo.lock");
  const source = readFileSync(lock, "utf8");
  const blocks = source.split(/^\[\[package\]\]\s*$/mu);
  const index = blocks.findIndex((block) => /^name\s*=\s*"erpc-sdk"\s*$/mu.test(block) && !/^source\s*=/mu.test(block));
  assert.ok(index > 0);
  blocks[index] = blocks[index].replace(/(^version[ \t]*=[ \t]*")[^"]+(")/mu, `$1${version}$2`);
  writeFileSync(lock, blocks.join("[[package]]"));
}

test("strict stable versions reject prereleases and leading zeroes", () => {
  assert.deepEqual(parseStableVersion("0.7.0"), { value: "0.7.0", major: 0, minor: 7, patch: 0 });
  assert.equal(compareVersions("0.7.0", BASELINE_VERSION), 1);
  for (const value of ["01.2.3", "0.07.0", "0.7.00", "0.7.0-beta.1", "v0.7.0", "0.7"]) assert.throws(() => parseStableVersion(value));
});

test("clean released baseline reports the approved catalog candidate through later operations commits", async () => {
  await withWorktree(async (root, expectedHead) => {
    writeFileSync(path.join(root, "registry/maintenance-operations-note.md"), "operations-only fixture\n");
    const laterHead = commitAll(root, "fixture operations update");
    const report = inspectRelease({ root, expectedHead: laterHead });
    assert.equal(report.status, STATUS.PATCH_READY);
    assert.equal(report.prepareAllowed, true);
    assert.equal(report.currentVersion, BASELINE_VERSION);
    assert.ok(report.tags.warnings.some((warning) => warning.includes("v0.2.0")));
    assert.equal(report.tags.pairs.find((pair) => pair.version === BASELINE_VERSION).rootPeel, BASELINE_TAG_COMMIT);
  });
});

test("missing release plan never fabricates an approved version", async () => {
  await withWorktree(async (root, expectedHead) => {
    unlinkSync(path.join(root, "registry/release-plan.json"));
    assert.throws(() => inspectRelease({ root, expectedHead }), /release-plan\.json is required/u);
  });
});

test("approved preparation writes exactly seven files, preserves bytes, and is date-idempotent", async () => {
  await withWorktree(async (root, expectedHead) => {
    const before = new Map([...PACKAGE_VERSION_PATHS, "CHANGELOG.md"].map((relativePath) => [relativePath, readFileSync(path.join(root, relativePath), "utf8")]));
    const first = prepareRelease({ root, expectedHead, releaseDate: "2026-09-15" });
    assert.equal(first.status, STATUS.PREPARED_UNPUBLISHED);
    assert.deepEqual(first.writtenFiles, [...PACKAGE_VERSION_PATHS, "CHANGELOG.md"]);
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /^## Unreleased\s*$/mu);
    assert.match(changelog, /^## 0\.7\.0 — 2026-09-15$/mu);
    assert.match(changelog, /Add an offline token catalog to all five SDKs/u);
    assert.match(changelog, /Add shared asset and deployment lookups/u);
    assert.equal(readFileSync(path.join(root, "Cargo.lock"), "utf8").replace(/version = "0\.7\.0"/u, "version = \"0.6.0\""), before.get("Cargo.lock"));
    const afterFirst = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const second = prepareRelease({ root, expectedHead, releaseDate: "2026-09-16" });
    assert.equal(second.status, STATUS.PREPARED_UNPUBLISHED);
    assert.equal(second.idempotent, true);
    assert.deepEqual(second.writtenFiles, []);
    assert.equal(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), afterFirst);
    for (const [relativePath, original] of before) if (relativePath !== "CHANGELOG.md") assert.notEqual(readFileSync(path.join(root, relativePath), "utf8"), original);
  });
});

test("Unreleased notes are preserved while the approved section is added", async () => {
  await withWorktree(async (root, expectedHead) => {
    const target = path.join(root, "CHANGELOG.md");
    const source = readFileSync(target, "utf8").replace("## Unreleased\n", "## Unreleased\n\n- Existing unreleased note.\n");
    writeFileSync(target, source);
    const report = inspectRelease({ root, expectedHead });
    assert.notEqual(report.status, STATUS.PREPARED_UNPUBLISHED);
    assert.throws(() => prepareRelease({ root, expectedHead, releaseDate: "2026-09-15" }), /clean working tree/u);
    // A clean fixture carrying the note exercises the actual writer path.
    git(root, ["add", "CHANGELOG.md"]);
    const head = commitAll(root, "fixture unreleased note");
    const prepared = prepareRelease({ root, expectedHead: head, releaseDate: "2026-09-15" });
    const result = readFileSync(target, "utf8");
    assert.equal(prepared.status, STATUS.PREPARED_UNPUBLISHED);
    assert.match(result, /## Unreleased[\s\S]*Existing unreleased note/u);
    assert.match(result, /## 0\.7\.0 — 2026-09-15[\s\S]*Existing unreleased note/u);
  });
});

test("catalog runtime history is PATCH_READY and preparation bumps semver", async () => {
  await withWorktree(async (root) => {
    const catalog = JSON.parse(JSON.stringify(CATALOG));
    catalog.manualAsOf = "2026-09-16";
    catalog.contentDigest = computeDigest(catalog);
    validateCatalog(catalog);
    writeFileSync(path.join(root, "registry/token-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    for (const relativePath of CATALOG_RUNTIME_PATHS.slice(1)) {
      const target = path.join(root, relativePath);
      writeFileSync(target, `${readFileSync(target, "utf8")}\n/* runtime observation refresh */\n`);
    }
    const head = commitAll(root, "catalog runtime refresh");
    const inspected = inspectRelease({ root, expectedHead: head });
    assert.equal(inspected.status, STATUS.PATCH_READY);
    const prepared = prepareRelease({ root, expectedHead: head, releaseDate: "2026-09-16" });
    assert.equal(prepared.status, STATUS.PREPARED_UNPUBLISHED);
    assert.equal(prepared.currentVersion, "0.7.0");
  });
});

test("unknown package code and manifest dependency changes require manual version", async () => {
  await withWorktree(async (root) => {
    writeFileSync(path.join(root, "packages/typescript/src/index.ts"), `${readFileSync(path.join(root, "packages/typescript/src/index.ts"), "utf8")}\n// shipping code change\n`);
    const codeHead = commitAll(root, "unknown package code");
    const codeReport = inspectRelease({ root, expectedHead: codeHead });
    assert.equal(codeReport.status, STATUS.MANUAL_VERSION_REQUIRED);
    assert.ok(codeReport.shippingChanges.includes("packages/typescript/src/index.ts"));
  });
  await withWorktree(async (root) => {
    const target = path.join(root, "packages/typescript/package.json");
    writeFileSync(target, readFileSync(target, "utf8").replace("Type-safe multi-network TypeScript SDK for ERPC", "Changed package metadata"));
    const head = commitAll(root, "package manifest change");
    const report = inspectRelease({ root, expectedHead: head });
    assert.equal(report.status, STATUS.MANUAL_VERSION_REQUIRED);
    assert.ok(report.shippingChanges.includes("packages/typescript/package.json"));
  });
});

test("manual version preparation requires existing Unreleased notes", async () => {
  await withWorktree(async (root, expectedHead) => {
    writeFileSync(path.join(root, "packages/typescript/src/index.ts"), `${readFileSync(path.join(root, "packages/typescript/src/index.ts"), "utf8")}\n// manual release code\n`);
    const head = commitAll(root, "manual release code");
    assert.throws(() => prepareRelease({ root, expectedHead: head, version: "0.8.0", releaseDate: "2026-09-15" }), /meaningful existing Unreleased notes/u);
  });
});

test("runtime patches remain automatic after an unrelated 0.8 shipping release", async () => {
  const root = newIsolatedRepo();
  try {
    const initialHead = git(root, ["rev-parse", "HEAD"]);
    const changelogPath = path.join(root, "CHANGELOG.md");
    writeFileSync(changelogPath, readFileSync(changelogPath, "utf8").replace("## Unreleased\n", "## Unreleased\n\n- Ship a separately reviewed 0.8 feature.\n"));
    const notesHead = commitAll(root, "0.8 release notes");
    const prepared = prepareRelease({ root, expectedHead: notesHead, version: "0.8.0", releaseDate: "2026-09-18" });
    assert.equal(prepared.status, STATUS.PREPARED_UNPUBLISHED);
    writeFileSync(path.join(root, "packages/typescript/src/index.ts"), `${readFileSync(path.join(root, "packages/typescript/src/index.ts"), "utf8")}\n// separately reviewed 0.8 feature\n`);
    const featureHead = commitAll(root, "0.8 shipping feature");
    execFileSync("git", ["-C", root, "tag", "v0.8.0", featureHead], { encoding: "utf8" });
    execFileSync("git", ["-C", root, "tag", "packages/go/v0.8.0", featureHead], { encoding: "utf8" });
    try {
      const catalog = JSON.parse(readFileSync(path.join(root, "registry/token-catalog.json"), "utf8"));
      catalog.manualAsOf = "2026-09-19";
      catalog.contentDigest = computeDigest(catalog);
      writeFileSync(path.join(root, "registry/token-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
      for (const relativePath of CATALOG_RUNTIME_PATHS.slice(1)) {
        const target = path.join(root, relativePath);
        writeFileSync(target, `${readFileSync(target, "utf8")}\n/* 0.8 runtime patch */\n`);
      }
      const runtimeHead = commitAll(root, "0.8 catalog runtime patch");
      const inspected = inspectRelease({ root, expectedHead: runtimeHead });
      assert.equal(inspected.plan.applies, false);
      assert.equal(inspected.status, STATUS.PATCH_READY);
      assert.equal(inspected.releasedBaseline?.version, "0.8.0");
      assert.equal(inspected.selectedVersion, "0.8.1");
      assert.deepEqual(inspected.shippingChanges, []);
      const patched = prepareRelease({ root, expectedHead: runtimeHead, releaseDate: "2026-09-19" });
      assert.equal(patched.status, STATUS.PREPARED_UNPUBLISHED);
      assert.equal(patched.currentVersion, "0.8.1");
      assert.match(readFileSync(changelogPath, "utf8"), new RegExp(patched.catalog.digest));
    } finally {
      for (const tag of ["v0.8.0", "packages/go/v0.8.0"]) execFileSync("git", ["-C", root, "tag", "-d", tag], { encoding: "utf8", stdio: "ignore" });
    }
  } finally {
    removeIsolatedRepo(root);
  }
});

test("CLI normalizes an omitted version and reports new post-release shipping code as manual", async () => {
  const root = newIsolatedRepo();
  try {
    const expectedHead = git(root, ["rev-parse", "HEAD"]);
    const prepared = prepareRelease({ root, expectedHead, releaseDate: "2026-09-20" });
    assert.equal(prepared.status, STATUS.PREPARED_UNPUBLISHED);
    const releasedHead = commitAll(root, "approved 0.7 release candidate");
    for (const tag of ["v0.7.0", "packages/go/v0.7.0"]) execFileSync("git", ["-C", root, "tag", tag, releasedHead], { encoding: "utf8" });
    try {
      writeFileSync(path.join(root, "packages/typescript/src/index.ts"), `${readFileSync(path.join(root, "packages/typescript/src/index.ts"), "utf8")}\n// unplanned post-release shipping code\n`);
      const codeHead = commitAll(root, "unplanned post-release shipping code");
      const output = execFileSync(process.execPath, [path.join(REPOSITORY_ROOT, "registry/release-prep.mjs"), "inspect", "--expected-head", codeHead, "--root", root, "--format=json"], { encoding: "utf8" });
      const report = JSON.parse(output);
      assert.equal(report.status, STATUS.MANUAL_VERSION_REQUIRED);
      assert.equal(report.selectedVersion, null);
      writeFileSync(path.join(root, "CHANGELOG.md"), readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace("## Unreleased\n", "## Unreleased\n\n- Manual 0.8 release note.\n"));
      const manualOutput = execFileSync(process.execPath, [path.join(REPOSITORY_ROOT, "registry/release-prep.mjs"), "inspect", "--expected-head", codeHead, "--root", root, "--version", "0.8.0", "--format=json"], { encoding: "utf8" });
      const manualReport = JSON.parse(manualOutput);
      assert.equal(manualReport.status, STATUS.PATCH_READY);
      assert.equal(manualReport.selectedVersion, "0.8.0");
      assert.equal(manualReport.prepareAllowed, true);
    } finally {
      for (const tag of ["v0.7.0", "packages/go/v0.7.0"]) execFileSync("git", ["-C", root, "tag", "-d", tag], { encoding: "utf8", stdio: "ignore" });
    }
  } finally {
    removeIsolatedRepo(root);
  }
});

test("higher unpaired tag blocks and paired target tags produce prepared status", async () => {
  const isolated = newIsolatedRepo();
  try {
    const expectedHead = git(isolated, ["rev-parse", "HEAD"]);
    {
      const root = isolated;
    execFileSync("git", ["-C", root, "tag", "v0.7.0", expectedHead], { encoding: "utf8" });
    try {
      const report = inspectRelease({ root, expectedHead });
      assert.equal(report.status, STATUS.BLOCKED_TAG_HISTORY);
    } finally {
      execFileSync("git", ["-C", root, "tag", "-d", "v0.7.0"], { encoding: "utf8", stdio: "ignore" });
    }
    }
    {
      const root = isolated;
      const expectedHead = git(root, ["rev-parse", "HEAD"]);
    const prepared = prepareRelease({ root, expectedHead, releaseDate: "2026-09-15" });
    assert.equal(prepared.status, STATUS.PREPARED_UNPUBLISHED);
    const head = commitAll(root, "prepared release candidate");
    execFileSync("git", ["-C", root, "tag", "v0.7.0", head], { encoding: "utf8" });
    execFileSync("git", ["-C", root, "tag", "packages/go/v0.7.0", head], { encoding: "utf8" });
    try {
      const inspected = inspectRelease({ root, expectedHead: head });
      assert.equal(inspected.status, STATUS.PREPARED);
      assert.deepEqual(inspected.releasedBaseline, { version: "0.7.0", peelCommit: head });
      const dateOnlyCatalog = JSON.parse(readFileSync(path.join(root, "registry/token-catalog.json"), "utf8"));
      dateOnlyCatalog.assets[0].asOfDate = "2026-09-17";
      const dateOnlyDigest = dateOnlyCatalog.contentDigest;
      writeFileSync(path.join(root, "registry/token-catalog.json"), `${JSON.stringify(dateOnlyCatalog, null, 2)}\n`);
      const dateOnlyHead = commitAll(root, "source evidence date refresh");
      const dateOnly = inspectRelease({ root, expectedHead: dateOnlyHead });
      assert.equal(dateOnlyCatalog.contentDigest, dateOnlyDigest);
      assert.equal(dateOnly.runtime.catalogDigestChanged, false);
      assert.equal(dateOnly.status, STATUS.NO_RELEASE_CHANGE);
      assert.equal(dateOnly.selectedVersion, null);
      assert.equal(dateOnly.prepareAllowed, false);
      const dateOnlyPrepared = prepareRelease({ root, expectedHead: dateOnlyHead, releaseDate: "2026-09-23" });
      assert.equal(dateOnlyPrepared.status, STATUS.NO_RELEASE_CHANGE);
      assert.deepEqual(dateOnlyPrepared.writtenFiles, []);
      assert.equal(dateOnlyPrepared.idempotent, true);
      const laterCatalog = JSON.parse(readFileSync(path.join(root, "registry/token-catalog.json"), "utf8"));
      laterCatalog.manualAsOf = "2026-09-16";
      laterCatalog.contentDigest = computeDigest(laterCatalog);
      writeFileSync(path.join(root, "registry/token-catalog.json"), `${JSON.stringify(laterCatalog, null, 2)}\n`);
      for (const relativePath of CATALOG_RUNTIME_PATHS.slice(1)) {
        const target = path.join(root, relativePath);
        writeFileSync(target, `${readFileSync(target, "utf8")}\n/* later runtime refresh */\n`);
      }
      const laterHead = commitAll(root, "later catalog refresh");
      const later = inspectRelease({ root, expectedHead: laterHead });
      assert.equal(later.releasedBaseline?.version, "0.7.0");
      assert.equal(later.status, STATUS.PATCH_READY);
      assert.equal(later.selectedVersion, "0.7.1");
      assert.equal(later.prepareAllowed, true);
      const laterPrepared = prepareRelease({ root, expectedHead: laterHead, releaseDate: "2026-09-16" });
      assert.equal(laterPrepared.status, STATUS.PREPARED_UNPUBLISHED);
      assert.equal(laterPrepared.prepareAllowed, false);
      assert.equal(laterPrepared.currentVersion, "0.7.1");
      const laterChangelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
      assert.match(laterChangelog, /Refresh the offline token catalog runtime data/iu);
      assert.match(laterChangelog, new RegExp(laterPrepared.catalog.digest));
    } finally {
      for (const tag of ["v0.7.0", "packages/go/v0.7.0"]) execFileSync("git", ["-C", root, "tag", "-d", tag], { encoding: "utf8", stdio: "ignore" });
    }
    }
  } finally {
    removeIsolatedRepo(isolated);
  }
});

test("stale heads, changelog gaps, and report overwrites are refused", async () => {
  await withWorktree(async (root, expectedHead) => {
    assert.equal(inspectRelease({ root, expectedHead: BASELINE_TAG_COMMIT }).status, STATUS.STALE_HEAD);
    replaceVersionInFixture(root, "0.7.0");
    const report = inspectRelease({ root, expectedHead });
    assert.equal(report.status, STATUS.CHANGELOG_REQUIRED);
  });
  await withWorktree(async (root, expectedHead) => {
    const original = readFileSync(path.join(root, "packages/typescript/package.json"), "utf8");
    assert.throws(() => prepareRelease({ root, expectedHead, report: "registry/token-catalog.json" }), /report path (?:may not overwrite|already exists)/u);
    assert.equal(readFileSync(path.join(root, "packages/typescript/package.json"), "utf8"), original);
    assert.throws(() => prepareRelease({ root, expectedHead, changelogFile: "registry/other.md" }), /may write only CHANGELOG\.md/u);
  });
});

test("dangling report links are rejected before any managed output is written", async () => {
  await withWorktree(async (root, expectedHead) => {
    const versionPath = path.join(root, "packages/typescript/package.json");
    const original = readFileSync(versionPath, "utf8");
    const reportPath = path.join(root, "registry/synthetic-report.json");
    symlinkSync("../outside-checkout-report.json", reportPath);
    assert.throws(() => prepareRelease({ root, expectedHead, report: "registry/synthetic-report.json" }), /already exists/u);
    assert.equal(readFileSync(versionPath, "utf8"), original);
    const parentOutside = mkdtempSync(path.join(tmpdir(), "erpc-report-parent-outside-"));
    symlinkSync(parentOutside, path.join(root, "registry/report-parent"));
    assert.throws(() => prepareRelease({ root, expectedHead, report: "registry/report-parent/report.json" }), /escapes the repository/u);
    assert.equal(readFileSync(versionPath, "utf8"), original);
    rmSync(parentOutside, { recursive: true, force: true });
  });
});
