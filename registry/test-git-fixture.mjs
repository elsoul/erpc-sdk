import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The release plan names commits from the reviewed historical repository. The
 * fixture tests deliberately do not restore that repository history. They
 * create a small real Git DAG from the current tracked tree and translate only
 * these two approved names at the runner boundary.
 */
export const CANONICAL_APPROVED_SOURCE_SHA = "38e0d27d5dbc852ae7518d5d4e1d622abbcbbd36";
export const CANONICAL_PAIRED_TAG_PEEL = "d77169fbf9e927d51113af7a2ee51a5c9b10f3fc";
export const TEMP_FIXTURE_VERSION = "0.6.0";

const CATALOG_RUNTIME_PATHS = Object.freeze([
  "registry/token-catalog.json",
  "packages/typescript/src/generated/token_catalog.ts",
  "packages/rust/src/generated/token_catalog.rs",
  "packages/python/src/erpc_sdk/_token_catalog_data.py",
  "packages/go/token_catalog_generated.go",
  "packages/ruby/lib/erpc_sdk/generated/token_catalog.rb",
  "registry/dex-catalog.json",
  "packages/typescript/src/generated/dex_catalog.ts",
  "packages/rust/src/generated/dex_catalog.rs",
  "packages/python/src/erpc_sdk/_dex_catalog_data.py",
  "packages/go/dex_catalog_generated.go",
  "packages/ruby/lib/erpc_sdk/generated/dex_catalog.rb",
  "registry/token-rankings.json",
  "packages/typescript/src/generated/token_rankings.ts",
  "packages/rust/src/generated/token_rankings.rs",
  "packages/python/src/erpc_sdk/_token_rankings_data.py",
  "packages/go/token_rankings_generated.go",
  "packages/ruby/lib/erpc_sdk/generated/token_rankings.rb",
]);

const RELEASE_PLAN_PATH = "registry/release-plan.json";

const BASELINE_CHANGELOG = `# Changelog

## Unreleased

## 0.6.0 — 2026-09-07

- Synthetic pinned release baseline.
`;

const GIT_BINARY = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function gitCommand(root, args, options = {}) {
  return execFileSync(GIT_BINARY, ["-C", root, ...args], {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    input: options.input,
    env: options.env,
  });
}

function commit(root, message) {
  gitCommand(root, ["add", "-A"]);
  gitCommand(root, [
    "-c", "user.name=Registry fixture",
    "-c", "user.email=registry-fixture@example.invalid",
    "commit", "--quiet", "-m", message,
  ]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function gitText(root, args) {
  return String(gitCommand(root, args)).trim();
}

function archiveTrackedSnapshot(sourceRoot) {
  return execFileSync(GIT_BINARY, ["-C", sourceRoot, "archive", "--format=tar", "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
}

function extractArchive(archive, root) {
  execFileSync("tar", ["-xf", "-", "-C", root], { input: archive, stdio: ["pipe", "ignore", "pipe"] });
}

function replaceExactly(text, pattern, replacement, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one fixture version (found ${matches.length})`);
  return text.replace(pattern, replacement);
}

/** Normalize only the copied fixture. The source checkout remains untouched. */
export function normalizeFixtureVersions(root, version = TEMP_FIXTURE_VERSION) {
  const patterns = {
    "packages/typescript/package.json": /^(\s*"version"\s*:\s*")[^"]+("\s*,?\s*)$/mu,
    "packages/rust/Cargo.toml": /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu,
    "packages/python/pyproject.toml": /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/mu,
    "packages/python/src/erpc_sdk/__init__.py": /(^__version__\s*=\s*")[^"]+("\s*$)/mu,
    "packages/ruby/lib/erpc_sdk/version.rb": /(^\s*VERSION\s*=\s*")[^"]+("\s*$)/mu,
  };
  for (const [relativePath, pattern] of Object.entries(patterns)) {
    const target = join(root, relativePath);
    writeFileSync(target, replaceExactly(readFileSync(target, "utf8"), pattern, `$1${version}$2`, relativePath));
  }

  const rubyLockPath = join(root, "packages/ruby/Gemfile.lock");
  const rubyLock = readFileSync(rubyLockPath, "utf8");
  writeFileSync(rubyLockPath, replaceExactly(rubyLock, /(\berpc-sdk\s*\()[^\s)]+(\))/u, `$1${version}$2`, "packages/ruby/Gemfile.lock"));

  const cargoLockPath = join(root, "Cargo.lock");
  const cargoLock = readFileSync(cargoLockPath, "utf8");
  const blocks = cargoLock.split(/^\[\[package\]\]\s*$/mu);
  const matches = blocks.map((block, index) => ({ block, index })).filter(({ block }) => /^name\s*=\s*"erpc-sdk"\s*$/mu.test(block) && !/^source\s*=/mu.test(block));
  if (matches.length !== 1) throw new Error(`Cargo.lock source-less erpc-sdk package must be unique (found ${matches.length})`);
  const block = matches[0];
  blocks[block.index] = replaceExactly(block.block, /(^version\s*=\s*")[^"]+("\s*$)/mu, `$1${version}$2`, "Cargo.lock");
  writeFileSync(cargoLockPath, blocks.join("[[package]]"));
}

function removeCandidateRuntime(root) {
  for (const relativePath of CATALOG_RUNTIME_PATHS) {
    const target = join(root, relativePath);
    if (existsSync(target)) unlinkSync(target);
  }
}

function removeReleasePlan(root) {
  const target = join(root, RELEASE_PLAN_PATH);
  if (existsSync(target)) unlinkSync(target);
}

function writeBaselineChangelog(root) {
  writeFileSync(join(root, "CHANGELOG.md"), BASELINE_CHANGELOG);
}

function addApprovedPackageDelta(root) {
  const target = join(root, "packages/typescript/src/client.ts");
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// synthetic approved catalog release fixture\n`);
}

function mapRevisionToken(token, fixture) {
  if (token === fixture.canonicalSourceSha) return fixture.syntheticSourceSha;
  if (token === `${fixture.canonicalSourceSha}^{commit}`) return `${fixture.syntheticSourceSha}^{commit}`;
  if (token === fixture.canonicalBaselineSha) return fixture.syntheticBaselineSha;
  if (token === `${fixture.canonicalBaselineSha}^{commit}`) return `${fixture.syntheticBaselineSha}^{commit}`;
  if (token.startsWith(`${fixture.canonicalSourceSha}:`)) return `${fixture.syntheticSourceSha}${token.slice(fixture.canonicalSourceSha.length)}`;
  if (token.startsWith(`${fixture.canonicalBaselineSha}:`)) return `${fixture.syntheticBaselineSha}${token.slice(fixture.canonicalBaselineSha.length)}`;
  return token;
}

function mappedArgs(args, fixture) {
  return args.map((argument) => mapRevisionToken(argument, fixture));
}

function shouldTranslateBaselineTagPeel(command, args, output, fixture) {
  if (command !== "git" || args[0] !== "rev-parse" || output.trim() !== fixture.syntheticBaselineSha) return false;
  // Only a tag/ref peel is translated. A plain HEAD read must continue to
  // expose the actual synthetic commit, preserving stale/non-ancestor checks.
  return args.some((argument) => argument.startsWith("refs/tags/") || argument.endsWith("^{commit}"));
}

function normalizeResult(result, command, args, fixture) {
  const normalized = {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
  if (normalized.status === 0 && shouldTranslateBaselineTagPeel(command, args, normalized.stdout, fixture)) {
    normalized.stdout = normalized.stdout.replace(fixture.syntheticBaselineSha, fixture.canonicalBaselineSha);
  }
  return normalized;
}

function invokeFixtureRunner(fixture, command, args, options = {}) {
  const cwd = options.cwd ?? fixture.root;
  const mapped = command === "git" ? mappedArgs(args, fixture) : args;
  const result = spawnSync(command === "git" ? GIT_BINARY : command, mapped, {
    cwd,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    env: options.env,
    input: options.input,
  });
  return normalizeResult(result, command, args, fixture);
}

export function fixtureGit(fixture, args, options = {}) {
  const result = invokeFixtureRunner(fixture, "git", args, options);
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim() || `exit ${result.status}`}`);
  }
  return String(result.stdout ?? "").trim();
}

export function fixtureRunner(fixture) {
  return (command, args, options = {}) => invokeFixtureRunner(fixture, command, args, options);
}

/**
 * Create an independent real Git DAG:
 *   synthetic B2 (root-only temporary v0.2.0 tag)
 *       |
 *   synthetic B6 (paired temporary v0.6.0 tags, without candidate runtime)
 *       |
 *   synthetic S  (current catalogs/generated outputs plus approved code delta)
 *       |
 *   synthetic P  (byte-identical real release plan)
 *
 * No source objects, refs, tags, or working-tree files are written. The
 * fixture runner maps only the approved source and pinned peel names.
 */
export function createGitFixture({ sourceRoot = process.cwd(), prefix = "erpc-registry-fixture-" } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const archive = archiveTrackedSnapshot(sourceRoot);
  try {
    gitCommand(root, ["init", "--quiet"]);
    gitCommand(root, ["config", "user.name", "Registry fixture"]);
    gitCommand(root, ["config", "user.email", "registry-fixture@example.invalid"]);

    extractArchive(archive, root);
    normalizeFixtureVersions(root, "0.2.0");
    removeCandidateRuntime(root);
    removeReleasePlan(root);
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## 0.2.0 — 2026-08-28\n\n- Synthetic root-only history.\n");
    const syntheticB2Sha = commit(root, "synthetic root-only v0.2 baseline");

    normalizeFixtureVersions(root, TEMP_FIXTURE_VERSION);
    writeBaselineChangelog(root);
    const syntheticBaselineSha = commit(root, "synthetic pinned 0.6 baseline");

    extractArchive(archive, root);
    normalizeFixtureVersions(root);
    removeReleasePlan(root);
    writeBaselineChangelog(root);
    addApprovedPackageDelta(root);
    const syntheticSourceSha = commit(root, "synthetic approved source");

    const releasePlan = readFileSync(join(sourceRoot, RELEASE_PLAN_PATH), "utf8");
    writeFileSync(join(root, RELEASE_PLAN_PATH), releasePlan);
    const syntheticPlanSha = commit(root, "synthetic release plan candidate");
    gitCommand(root, ["checkout", "--detach", "HEAD"], { stdio: "ignore" });
    const fixture = {
      root,
      syntheticB2Sha,
      syntheticBaselineSha,
      syntheticSourceSha,
      syntheticPlanSha,
      canonicalBaselineSha: CANONICAL_PAIRED_TAG_PEEL,
      canonicalSourceSha: CANONICAL_APPROVED_SOURCE_SHA,
    };
    fixture.runner = fixtureRunner(fixture);
    fixture.git = (args, options = {}) => fixtureGit(fixture, args, options);
    fixture.headSha = syntheticPlanSha;
    return fixture;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function removeGitFixture(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

export function createNonAncestorCommit(fixture, parentSha = fixture.syntheticBaselineSha) {
  const tree = fixture.git(["rev-parse", `${parentSha}^{tree}`]);
  const result = spawnSync(GIT_BINARY, ["-C", fixture.root, "commit-tree", tree, "-p", parentSha], {
    encoding: "utf8",
    input: "synthetic non-ancestor\n",
    env: { ...process.env, GIT_AUTHOR_NAME: "Registry fixture", GIT_AUTHOR_EMAIL: "registry-fixture@example.invalid", GIT_COMMITTER_NAME: "Registry fixture", GIT_COMMITTER_EMAIL: "registry-fixture@example.invalid" },
    stdio: "pipe",
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function shimSource() {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const source = process.env.ERPC_FIXTURE_CANONICAL_SOURCE;
const sourceActual = process.env.ERPC_FIXTURE_SYNTHETIC_SOURCE;
const baseline = process.env.ERPC_FIXTURE_CANONICAL_BASELINE;
const baselineActual = process.env.ERPC_FIXTURE_SYNTHETIC_BASELINE;
const realGit = process.env.ERPC_FIXTURE_REAL_GIT;
const map = (value) => {
  if (value === source) return sourceActual;
  if (value === source + "^{commit}") return sourceActual + "^{commit}";
  if (value === baseline) return baselineActual;
  if (value === baseline + "^{commit}") return baselineActual + "^{commit}";
  if (value.startsWith(source + ":")) return sourceActual + value.slice(source.length);
  if (value.startsWith(baseline + ":")) return baselineActual + value.slice(baseline.length);
  return value;
};
const mapped = args.map(map);
const result = spawnSync(realGit, mapped, { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
let stdout = result.stdout ?? "";
if (result.status === 0 && mapped.length > 0 && mapped[0] === "rev-parse" && stdout.trim() === baselineActual && args.some((value) => value.startsWith("refs/tags/") || value.endsWith("^{commit}"))) stdout = stdout.replace(baselineActual, baseline);
process.stdout.write(stdout);
process.stderr.write(result.stderr ?? "");
process.exit(result.status === null ? 1 : result.status);
`;
}

function withGitShim(fixture, callback) {
  const shimRoot = mkdtempSync(join(tmpdir(), "erpc-git-shim-"));
  const shimPath = join(shimRoot, "git");
  writeFileSync(shimPath, shimSource(), { mode: 0o755 });
  chmodSync(shimPath, 0o755);
  const env = {
    ...process.env,
    PATH: `${shimRoot}${delimiter}${process.env.PATH ?? ""}`,
    ERPC_FIXTURE_CANONICAL_SOURCE: fixture.canonicalSourceSha,
    ERPC_FIXTURE_SYNTHETIC_SOURCE: fixture.syntheticSourceSha,
    ERPC_FIXTURE_CANONICAL_BASELINE: fixture.canonicalBaselineSha,
    ERPC_FIXTURE_SYNTHETIC_BASELINE: fixture.syntheticBaselineSha,
    ERPC_FIXTURE_REAL_GIT: GIT_BINARY,
  };
  try {
    return callback(env);
  } finally {
    rmSync(shimRoot, { recursive: true, force: true });
  }
}

/** Execute a Node child with a fixture-only PATH shim. */
export function execNodeWithGitShim(fixture, args, options = {}) {
  return withGitShim(fixture, (env) => execFileSync(process.execPath, args, {
    cwd: options.cwd ?? process.cwd(),
    env,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    input: options.input,
  }));
}

