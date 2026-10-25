import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  BASE_BRANCH,
  BOT_BRANCH,
  CANDIDATE_PATHS,
  DependencyMaintenanceError,
  ECOSYSTEMS,
  SOURCE_REF,
  buildObservation,
  classifyUpdate,
  hashFiles,
  readCandidateFiles,
  sanitizeEvaluatorEnvironment,
  validateCandidateFiles,
  validateCleanCheckout,
  validateObservationArtifact,
  validateSourceBinding,
  createGitHubApi,
  dispatchOrReuseCi,
  evaluateRepository,
  evaluateTypescript,
  parseGemOutdated,
  parsePythonRequirements,
  pythonRequirementComparator,
  relaxPythonExactSpec,
  writeDependencyPullRequest,
} from "./dependency-maintenance.mjs";

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname);
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
const workflowRef = "elsoul/erpc-sdk/.github/workflows/dependency-maintenance.yml@refs/heads/main";

function snapshots() {
  const before = readCandidateFiles(repositoryRoot);
  const after = { ...before };
  const vitest = before["packages/typescript/package.json"].match(/("vitest"\s*:\s*"\^)(\d+)\.(\d+)\.(\d+)(")/u);
  if (!vitest) throw new Error("synthetic fixture could not find the vitest declaration");
  const patch = Number(vitest[4]) + 1;
  after["packages/typescript/package.json"] = before["packages/typescript/package.json"].replace(vitest[0], `${vitest[1]}${vitest[2]}.${vitest[3]}.${patch}${vitest[5]}`);
  const currentLock = `vitest@${vitest[2]}.${vitest[3]}.${vitest[4]}`;
  const nextLock = `vitest@${vitest[2]}.${vitest[3]}.${patch}`;
  after["pnpm-lock.yaml"] = before["pnpm-lock.yaml"].replaceAll(currentLock, nextLock);
  after["pnpm-lock.yaml"] = after["pnpm-lock.yaml"].replace(`specifier: ^${vitest[2]}.${vitest[3]}.${vitest[4]}\n        version: ${vitest[2]}.${vitest[3]}.${vitest[4]}`, `specifier: ^${vitest[2]}.${vitest[3]}.${patch}\n        version: ${vitest[2]}.${vitest[3]}.${patch}`);
  return { before, after };
}

function result(ecosystem, status = "no-update") {
  const command = { command: `${ecosystem}-native`, args: ["lookup"], status: 0, stdout: "", stderr: "" };
  return { ecosystem, status, command, lookupCommands: [command], observations: [{ name: `${ecosystem}-inventory`, current: "1.0.0", latest: "1.0.0", classification: "none", status: "no-update", lookup: "native" }], updates: [] };
}

function fixtureArtifact({ before, after, statuses = {} } = {}) {
  return buildObservation({
    sourceSha,
    eventName: "schedule",
    eventRef: SOURCE_REF,
    workflowRef,
    runId: 7001,
    runAttempt: 1,
    results: ECOSYSTEMS.map((ecosystem) => result(ecosystem, statuses[ecosystem] ?? (ecosystem === "typescript" ? "eligible" : "no-update"))),
    before,
    after,
  });
}

function managedPr({ source, digest, paths, headSha, number = 42, merged = false, bodyOverride = null } = {}) {
  return {
    number,
    html_url: `https://github.com/elsoul/erpc-sdk/pull/${number}`,
    user: { login: "github-actions[bot]", type: "Bot" },
    head: { ref: BOT_BRANCH, sha: headSha, repo: { full_name: "elsoul/erpc-sdk" } },
    base: { ref: BASE_BRANCH, sha: source, repo: { full_name: "elsoul/erpc-sdk" } },
    merged_at: merged ? "2026-10-25T10:00:00Z" : null,
    body: bodyOverride ?? JSON.stringify({ managedBy: "erpc-sdk-dependency-maintenance", branch: BOT_BRANCH, baseBranch: BASE_BRANCH, sourceSha: source, candidateDigest: digest, changedPaths: paths, actualBotHead: headSha, origin: { kind: "erpc-sdk-dependency-maintenance-evaluator", repository: "elsoul/erpc-sdk", workflowPath: ".github/workflows/dependency-maintenance.yml", sourceSha: source, runId: 7001, runAttempt: 1, eventName: "schedule", workflowRef } }),
  };
}

function commitMetadata(sha, message = "chore(deps)\n\nDependency-Base: f1c85921dbcb141d468a596aadedbc4aa174b0ea\nDependency-Source: f1c85921dbcb141d468a596aadedbc4aa174b0ea") {
  return { sha, tree: { sha: "tree-sha" }, parents: [{ sha: sourceSha }], message, commit: { tree: { sha: "tree-sha" }, author: { name: "github-actions[bot]" }, committer: { name: "github-actions[bot]" } }, author: { login: "github-actions[bot]" }, committer: { login: "github-actions[bot]" } };
}

function apiIdentity(path) {
  if (path === "") return { id: 1429568627, full_name: "elsoul/erpc-sdk" };
  if (path === "/user") return { login: "github-actions[bot]", type: "Bot" };
  return null;
}

function detachedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "erpc-dependency-detached-"));
  execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, directory], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: directory, stdio: "ignore" });
  return directory;
}

function firstVersion(spec) {
  const match = String(spec).match(/(?:^|[^0-9])v?(\d+(?:\.\d+){0,2})/u)?.[1];
  if (!match) return "1.0.0";
  const parts = match.split(".").map(Number);
  while (parts.length < 3) parts.push(0);
  return parts.join(".");
}

function nextPatch(version) {
  const [major, minor, patch] = String(version).split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function nextMinor(version) {
  const [major, minor] = String(version).split(".").map(Number);
  return `${major}.${minor + 1}.0`;
}

function nativeFixtureVersions(root) {
  const files = readCandidateFiles(root);
  const versions = new Map();
  for (const relativePath of ["package.json", "packages/typescript/package.json"]) {
    const value = JSON.parse(files[relativePath]);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(value[section] ?? {})) versions.set(name, firstVersion(spec));
    }
  }
  versions.set("esbuild", files["pnpm-workspace.yaml"].match(/^\s{2}esbuild:\s*([^\s#]+)/mu)?.[1] ?? "0.28.2");
  const cargo = new Map();
  let packageSection = null;
  for (const line of files["Cargo.lock"].split(/\r?\n/u)) {
    if (line === "[[package]]") packageSection = {};
    const name = line.match(/^name\s*=\s*"([^"]+)"/u)?.[1];
    const version = line.match(/^version\s*=\s*"([^"]+)"/u)?.[1];
    if (name && packageSection) packageSection.name = name;
    if (version && packageSection?.name) { cargo.set(packageSection.name, version); packageSection = null; }
  }
  const go = new Map();
  for (const line of files["packages/go/go.mod"].split(/\r?\n/u)) {
    const match = line.match(/^\s*(\S+)\s+v(\d+\.\d+(?:\.\d+)?)/u);
    if (match) go.set(match[1], match[2]);
  }
  go.set("go", "1.22.0");
  go.set("golang.org/x/sys", "0.28.0");
  const python = new Map(parsePythonRequirements(files["packages/python/pyproject.toml"]).map((entry) => [entry.name, firstVersion(entry.spec)]));
  const ruby = new Map();
  for (const match of files["packages/ruby/Gemfile.lock"].matchAll(/^    ([^\s(]+) \(([^)]+)\)$/gmu)) ruby.set(match[1], match[2]);
  return { files, versions, cargo, go, python, ruby };
}

function nativeRunner(root, { bump = {}, pipLatest = {}, omitPnpmInventory = ["esbuild"], pipIndexFailure = null, pipIndexInvalid = null, rubyRows = [], rubyResolved = {}, trace = null } = {}) {
  const fixture = nativeFixtureVersions(root);
  let pnpmLists = 0;
  const writePnpmCandidate = () => {
    let lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    for (const [name, target] of Object.entries(bump)) {
      const current = fixture.versions.get(name);
      if (!current || name === "esbuild") lock = lock.replaceAll(`${name}@${current}`, `${name}@${target}`);
      else {
        lock = lock.replaceAll(`${name}@${current}`, `${name}@${target}`);
        lock = lock.replace(`specifier: ^${current}\n        version: ${current}`, `specifier: ^${target}\n        version: ${target}`);
      }
    }
    writeFileSync(join(root, "pnpm-lock.yaml"), lock, { flag: "w" });
  };
  const pnpmInventory = (compatibility = false) => {
    const projects = [
      { path: ".", devDependencies: {} },
      { path: "packages/typescript", dependencies: {}, devDependencies: {} },
    ];
    for (const [name, version] of fixture.versions) {
      if (!compatibility && omitPnpmInventory.includes(name)) continue;
      const selected = compatibility && bump[name] ? bump[name] : version;
      const project = name === "lefthook" ? projects[0] : projects[1];
      const manifest = JSON.parse(fixture.files[project.path === "." ? "package.json" : "packages/typescript/package.json"]);
      const section = Object.entries(manifest.dependencies ?? {}).some(([dependency]) => dependency === name)
        ? "dependencies"
        : Object.entries(manifest.devDependencies ?? {}).some(([dependency]) => dependency === name) ? "devDependencies" : "devDependencies";
      project[section][name] = { version: selected };
    }
    return projects;
  };
  const pythonReport = (reportPath, candidate) => {
    const install = [...fixture.python.entries()].map(([name, version]) => ({ metadata: { name, version: candidate && bump[name] ? bump[name] : version } }));
    writeFileSync(reportPath, JSON.stringify({ install }), { flag: "w" });
  };
  return (command, args) => {
    trace?.push({ command, args: [...args] });
    if (command === "corepack" && args[0] === "pnpm") {
      const subcommand = args[1];
      if (subcommand === "list") {
        pnpmLists += 1;
        return { status: 0, stdout: JSON.stringify(pnpmInventory(pnpmLists > 1)), stderr: "" };
      }
      if (subcommand === "view") {
        const name = args[2];
        return { status: 0, stdout: JSON.stringify(bump[name] ?? fixture.versions.get(name) ?? "1.0.0"), stderr: "" };
      }
      if (subcommand === "outdated") return { status: 0, stdout: JSON.stringify({}), stderr: "" };
      if (subcommand === "install" || subcommand === "update") {
        writePnpmCandidate();
        return { status: 0, stdout: "", stderr: "" };
      }
    }
    if (command === "cargo") {
      if (args[0] === "search") {
        const name = args[args.length - 1];
        return { status: 0, stdout: `${name} = \"${fixture.cargo.get(name) ?? "1.0.0"}\"\n`, stderr: "" };
      }
      if (args[0] === "update" || args[0] === "metadata") return { status: 0, stdout: args[0] === "metadata" ? "{}" : "", stderr: "" };
    }
    if (command === "python3" && args[0] === "-m" && args[1] === "pip" && args[2] === "index") {
      const name = args[4];
      if (name === pipIndexFailure) return { status: 1, stdout: "", stderr: "registry unavailable" };
      if (name === pipIndexInvalid) return { status: 0, stdout: "{not-json", stderr: "" };
      return { status: 0, stdout: JSON.stringify({ latest: pipLatest[name] ?? bump[name] ?? fixture.python.get(name) ?? "1.0.0" }), stderr: "" };
    }
    if (command === "python3" && args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
      const reportIndex = args.indexOf("--report");
      if (reportIndex >= 0 && args[reportIndex + 1]) pythonReport(args[reportIndex + 1], args.includes(".candidate") || args.some((arg) => arg.endsWith(".candidate")));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "go") {
      if (args[0] === "list" && args[1] === "-m" && args[2] === "-u") {
        const rows = [...fixture.go.entries()].map(([Path, Version]) => ({ Path, Version: `v${Version}` }));
        return { status: 0, stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
      }
      if (args[0] === "list" && args[1] === "-m" && args[2] === "-json") {
        const module = args[3]?.split("@")[0];
        return { status: 0, stdout: JSON.stringify({ Path: module, Version: `v${fixture.go.get(module) ?? "1.0.0"}` }), stderr: "" };
      }
    }
    if (command === "bundle") {
      if (args[0] === "outdated") return { status: 0, stdout: rubyRows.join("\n"), stderr: "" };
      if (args[0] === "lock" && args[1] === "--update") {
        const name = args[2];
        const target = rubyResolved[name];
        if (!target) return { status: 1, stdout: "", stderr: `missing resolved fixture for ${name}` };
        const lockPath = join(root, "packages/ruby/Gemfile.lock");
        const lock = readFileSync(lockPath, "utf8").replace(new RegExp(`^    ${name} \\([^\\n]+\\)$`, "mu"), `    ${name} (${target})`).replace(new RegExp(`^      ${name} \\(= [^\\n]+\\)$`, "mu"), `      ${name} (= ${target})`);
        writeFileSync(lockPath, lock, { flag: "w" });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "lock") return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected native fixture command: ${command} ${args.join(" ")}`);
  };
}

function fetchBackedApi(handler, seen = []) {
  return createGitHubApi({
    token: "gh-read-only",
    repository: "elsoul/erpc-sdk",
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace("/repos/elsoul/erpc-sdk", "") + parsed.search;
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      seen.push({ url, method: init.method ?? "GET", body });
      try {
        const value = await handler(path, { method: init.method ?? "GET", body });
        return { ok: true, status: 200, text: async () => value === null || value === undefined ? "" : JSON.stringify(value) };
      } catch (error) {
        if (error instanceof DependencyMaintenanceError) return { ok: false, status: error.status ?? 500, text: async () => JSON.stringify({ message: error.message }) };
        throw error;
      }
    },
  });
}

test("classifies patch, minor, pre-1.0 minor, major, and malformed values", () => {
  assert.equal(classifyUpdate("4.1.11", "4.1.12"), "patch");
  assert.equal(classifyUpdate("4.1.11", "4.2.0"), "minor");
  assert.equal(classifyUpdate("0.8.2", "0.9.0"), "pre1-minor");
  assert.equal(classifyUpdate("1.2.3", "2.0.0"), "major");
  assert.equal(classifyUpdate("1.2.3", "1.2.3-beta.1"), "unparseable");
  assert.equal(classifyUpdate("1.2.3", "garbage"), "unparseable");
});

test("native fixture parsers preserve full Python comparators and Bundler status-1 rows", () => {
  assert.equal(pythonRequirementComparator("pycryptodome==3.23.0"), "==");
  assert.equal(relaxPythonExactSpec("pycryptodome==3.23.0"), "pycryptodome>=3.23.0,<4");
  const requirements = parsePythonRequirements('[project]\ndependencies = [\n  "websockets>=13,<17",\n  "pycryptodome==3.23.0",\n]\n[build-system]\nrequires = ["hatchling>=1.27,<1.28"]\n');
  assert.deepEqual(requirements.map((entry) => entry.name), ["websockets", "pycryptodome", "hatchling"]);
  assert.deepEqual(parseGemOutdated("base64 (newest 0.3.0, installed 0.2.0)\n"), [{ name: "base64", latest: "0.3.0", current: "0.2.0" }]);
});

test("source binding rejects a moved ref and mismatched checkout", () => {
  assert.throws(() => validateSourceBinding({ eventName: "schedule", eventRef: "refs/heads/codex/dependency-maintenance", eventSha: sourceSha, checkoutSha: sourceSha }), /refs\/heads\/main/u);
  assert.throws(() => validateSourceBinding({ eventName: "workflow_dispatch", eventRef: SOURCE_REF, eventSha: sourceSha, checkoutSha: "0".repeat(40) }), /differ/u);
  assert.throws(() => validateSourceBinding({ eventName: "push", eventRef: SOURCE_REF, eventSha: sourceSha, checkoutSha: sourceSha }), /unsupported/u);
});

test("clean-checkout guard rejects untracked or dirty evaluator state", () => {
  const detachedRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-test-"));
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, detachedRoot], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: detachedRoot, stdio: "ignore" });
    writeFileSync(join(detachedRoot, "dirty-evaluator-file"), "unexpected\n", { flag: "w" });
    assert.throws(() => validateCleanCheckout(detachedRoot, sourceSha), /dirty/u);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("evaluator credential sanitization removes publisher and OIDC values while retaining checkout auth", () => {
  const sanitized = sanitizeEvaluatorEnvironment({
    PATH: "/bin",
    GITHUB_TOKEN: "checkout-token",
    GH_TOKEN: "read-only-gh-token",
    NPM_TOKEN: "publisher-token",
    NODE_AUTH_TOKEN: "publisher-token",
    TWINE_PASSWORD: "publisher-token",
    GEM_HOST_API_KEY: "publisher-token",
    CARGO_REGISTRY_TOKEN: "publisher-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "oidc-url",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
  });
  assert.equal(sanitized.GITHUB_TOKEN, "checkout-token");
  assert.equal(sanitized.GH_TOKEN, "read-only-gh-token");
  for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "TWINE_PASSWORD", "GEM_HOST_API_KEY", "CARGO_REGISTRY_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) assert.equal(key in sanitized, false, key);
});

test("workflow wiring and extracted evaluator subprocess environment fail closed", () => {
  const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/dependency-maintenance.yml"), "utf8");
  const evaluatorSource = readFileSync(resolve(repositoryRoot, ".github/workflows/dependency-maintenance.mjs"), "utf8");
  assert.match(workflow, /cron:\s*'17 9 \* \* 1'/u);
  assert.match(workflow, /timezone:\s*Europe\/Amsterdam/u);
  assert.match(workflow, /persist-credentials:\s*false/gu);
  assert.match(workflow, /actions\/setup-python@[^\s]+[\s\S]+python-version:\s*'3\.11'/u);
  assert.match(workflow, /pip install[^\n]+--no-deps[^\n]+--only-binary=:all:\s+PyYAML==6\.0\.3/u);
  assert.match(workflow, /import tomllib, yaml; assert yaml\.__version__ == "6\.0\.3"/u);
  assert.match(evaluatorSource, /--ignore-scripts/u);
  assert.match(workflow, /contents:\s*write[\s\S]+pull-requests:\s*write[\s\S]+actions:\s*write/u);
  const detachedRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-env-test-"));
  let supportRoot = null;
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, detachedRoot], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: detachedRoot, stdio: "ignore" });
    supportRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-env-support-"));
    const recordFile = join(supportRoot, "workflow-launch-record.json");
    const nativeBin = join(supportRoot, "native-stubs");
    const preload = join(supportRoot, "env-observer.mjs");
    execFileSync("mkdir", ["-p", nativeBin], { stdio: "ignore" });
    const realPython = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    for (const command of ["corepack", "cargo", "python3", "go", "bundle"]) {
      const stub = join(nativeBin, command);
      const body = command === "python3" ? `#!/bin/sh\nif [ "${"$1"}" = "-I" ]; then exec ${realPython} "$@"; fi\nexit 1\n` : "#!/bin/sh\nexit 1\n";
      writeFileSync(stub, body, { flag: "w" });
      chmodSync(stub, 0o755);
    }
    writeFileSync(preload, 'import { writeFileSync } from "node:fs"\nif (process.argv.includes("evaluate") && process.env.ERPC_RECORD_FILE) writeFileSync(process.env.ERPC_RECORD_FILE, JSON.stringify({ env: process.env, args: process.argv.slice(2) }))\n', { flag: "w" });
    const stepStart = workflow.indexOf("      - name: Evaluate all five native package managers");
    const runStart = workflow.indexOf("        run: |\n", stepStart) + "        run: |\n".length;
    const nextStep = workflow.indexOf("\n      - name:", runStart);
    const extracted = workflow.slice(runStart, nextStep).split(/\r?\n/u).map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
    const launch = spawnSync("bash", ["-euo", "pipefail", "-c", extracted], { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, PATH: `${nativeBin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, GITHUB_WORKSPACE: detachedRoot, SOURCE_SHA: sourceSha, EVENT_NAME: "schedule", EVENT_REF: SOURCE_REF, WORKFLOW_REF: workflowRef, GITHUB_RUN_ID: "8001", GITHUB_RUN_ATTEMPT: "1", OUTPUT_FILE: join(detachedRoot, "observation.json"), GITHUB_TOKEN: "checkout-token", NPM_TOKEN: "publisher-token", NODE_AUTH_TOKEN: "publisher-token", PIP_INDEX_URL: "https://user:pass@example.invalid/simple", CARGO_REGISTRIES_PRIVATE_TOKEN: "publisher-token", ACTIONS_ID_TOKEN_REQUEST_URL: "oidc-url", ERPC_RECORD_FILE: recordFile } });
    assert.equal(launch.status, 2, launch.stderr || launch.stdout);
    const observed = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.equal(observed.env.GITHUB_TOKEN, "checkout-token");
    for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "PIP_INDEX_URL", "CARGO_REGISTRIES_PRIVATE_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"]) assert.equal(key in observed.env, false, key);
    assert.deepEqual(observed.args.slice(0, 2), ["evaluate", "--root"]);
    assert.ok(observed.args.includes(sourceSha));
    const artifact = JSON.parse(readFileSync(join(detachedRoot, "observation.json"), "utf8"));
    assert.equal(artifact.candidate.status, "blocked");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
    if (typeof supportRoot === "string") rmSync(supportRoot, { recursive: true, force: true });
  }
});

test("candidate validation preserves SDK identity, floors, and non-dependency metadata", () => {
  const { before, after } = snapshots();
  const validation = validateCandidateFiles({ root: repositoryRoot, before, after });
  assert.deepEqual(validation.changedPaths, ["packages/typescript/package.json", "pnpm-lock.yaml"]);
  assert.equal(validation.candidateDigest, hashFiles({ "packages/typescript/package.json": after["packages/typescript/package.json"], "pnpm-lock.yaml": after["pnpm-lock.yaml"] }));

  const floorDrift = { ...after, "package.json": before["package.json"].replace("pnpm@11.24.0", "pnpm@12.0.0") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: floorDrift }), /floor|package manager|metadata/u);
  const metadataDrift = { ...after, "packages/typescript/package.json": after["packages/typescript/package.json"].replace('"license": "MIT AND Apache-2.0 AND BSD-3-Clause"', '"license": "MIT"') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: metadataDrift }), /metadata/u);
  const yokeDrift = { ...after, "packages/rust/Cargo.toml": before["packages/rust/Cargo.toml"].replace('yoke-derive = "=0.8.2"', 'yoke-derive = "=0.8.3"') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: yokeDrift }), /yoke|hold/u);
  const major = { ...after, "packages/typescript/package.json": after["packages/typescript/package.json"].replace(/vitest"\s*:\s*"\^\d+\.\d+\.\d+/u, 'vitest": "^5.0.0') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: major }), /patch\/minor/u);
  const gitDependency = { ...after, "packages/typescript/package.json": after["packages/typescript/package.json"].replace(/("vitest"\s*:\s*")[^"]+(")/u, '$1git+https://example.invalid/vitest.git$2') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: gitDependency }), /unsupported dependency source/u);
  const renamedPython = { ...after, "packages/python/pyproject.toml": before["packages/python/pyproject.toml"].replace('"httpx>=0.27,<1"', '"other-httpx>=0.27,<1"') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: renamedPython }), /dependency names/u);
  const rubyCode = { ...after, "packages/ruby/erpc-sdk.gemspec": before["packages/ruby/erpc-sdk.gemspec"].replace('spec.add_runtime_dependency "base64", "= 0.2.0"', 'spec.add_runtime_dependency "base64", "= 0.2.0"; system("unexpected")') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: rubyCode }), /executable|gemspec code/u);
  const emptyLock = { ...after, "Cargo.lock": "" };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: emptyLock }), /lockfile|empty/u);
  const cargoSource = { ...after, "Cargo.lock": before["Cargo.lock"].replace("registry+https://github.com/rust-lang/crates.io-index", "git+https://example.invalid/evil") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: cargoSource }), /source|crates.io/u);
  const rubyRemote = { ...after, "packages/ruby/Gemfile.lock": before["packages/ruby/Gemfile.lock"].replace("https://rubygems.org/", "https://example.invalid/") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: rubyRemote }), /Ruby lockfile|lockfile/u);
  const pnpmIntegrity = { ...after, "pnpm-lock.yaml": before["pnpm-lock.yaml"].replace(/sha512-[^\s}]+/u, "sha512-FAKE") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: pnpmIntegrity }), /integrity|lockfile/u);
  const goChecksum = { ...after, "packages/go/go.sum": before["packages/go/go.sum"].replace(/h1:[^\s]+/u, "h1:FAKE") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: goChecksum }), /checksum|invalid/u);
  const missingLockBinding = { ...after, "pnpm-lock.yaml": before["pnpm-lock.yaml"] };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: missingLockBinding }), /lockfile|bind/u);
});

test("candidate validation rejects a coherent SDK baseline bump beyond the reviewed source identity", () => {
  const { before, after } = snapshots();
  const next = { ...after };
  next["packages/typescript/package.json"] = next["packages/typescript/package.json"].replace('"version": "0.11.0"', '"version": "0.11.1"');
  next["packages/rust/Cargo.toml"] = next["packages/rust/Cargo.toml"].replace(/^version\s*=\s*"0\.11\.0"$/mu, 'version = "0.11.1"');
  next["packages/python/pyproject.toml"] = next["packages/python/pyproject.toml"].replace(/^version\s*=\s*"0\.11\.0"$/mu, 'version = "0.11.1"');
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: next }), /identity|version|floor|metadata/u);
});

test("candidate validation accepts a coherent first TypeScript runtime patch without treating it as SDK identity drift", () => {
  const { before } = snapshots();
  const after = { ...before };
  const current = nativeFixtureVersions(repositoryRoot).versions.get("@noble/curves");
  const target = nextPatch(current);
  after["packages/typescript/package.json"] = after["packages/typescript/package.json"].replace(`"@noble/curves": "${current}"`, `"@noble/curves": "${target}"`);
  after["pnpm-lock.yaml"] = after["pnpm-lock.yaml"]
    .replaceAll(`@noble/curves@${current}`, `@noble/curves@${target}`)
    .replace(`specifier: ${current}\n        version: ${current}`, `specifier: ${target}\n        version: ${target}`);
  assert.doesNotThrow(() => validateCandidateFiles({ root: repositoryRoot, before, after }));
});

test("candidate validation follows a trusted future Ruby baseline and rejects only candidate PATH SDK drift", () => {
  const root = detachedFixture();
  try {
    const versionPath = join(root, "packages/ruby/lib/erpc_sdk/version.rb");
    writeFileSync(versionPath, readFileSync(versionPath, "utf8").replace('VERSION = "0.11.0"', 'VERSION = "0.12.0"'), { flag: "w" });
    const baseline = readCandidateFiles(root);
    baseline["packages/ruby/Gemfile.lock"] = baseline["packages/ruby/Gemfile.lock"].replace("erpc-sdk (0.11.0)", "erpc-sdk (0.12.0)");
    assert.doesNotThrow(() => validateCandidateFiles({ root, before: baseline, after: { ...baseline } }));
    const drift = { ...baseline, "packages/ruby/Gemfile.lock": baseline["packages/ruby/Gemfile.lock"].replace("erpc-sdk (0.12.0)", "erpc-sdk (0.12.1)") };
    assert.throws(() => validateCandidateFiles({ root, before: baseline, after: drift }), /identity|PATH|lock|version/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation requires the complete five-ecosystem result and a closed candidate file set", () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  assert.equal(artifact.candidate.status, "eligible");
  assert.deepEqual(artifact.candidate.changedPaths, ["packages/typescript/package.json", "pnpm-lock.yaml"]);
  assert.doesNotThrow(() => validateObservationArtifact(artifact, { root: repositoryRoot, sourceSha }));
  const forbidden = structuredClone(artifact);
  forbidden.candidate.changedPaths.push("README.md");
  assert.throws(() => validateObservationArtifact(forbidden, { root: repositoryRoot, sourceSha }), /closed allowlist|candidate path/u);
  const wrongDigest = structuredClone(artifact);
  wrongDigest.candidate.files["packages/typescript/package.json"] += "\n";
  assert.throws(() => validateObservationArtifact(wrongDigest, { root: repositoryRoot, sourceSha }), /digest/u);
  const incomplete = structuredClone(artifact);
  incomplete.ecosystems.pop();
  assert.throws(() => validateObservationArtifact(incomplete, { root: repositoryRoot, sourceSha }), /five ecosystems/u);

  const blocked = fixtureArtifact({ before, after: before, statuses: { go: "blocked" } });
  assert.equal(blocked.candidate.status, "blocked");
  assert.doesNotThrow(() => validateObservationArtifact(blocked, { root: repositoryRoot, sourceSha }));
  const hiddenFailure = fixtureArtifact({ before, after: before, statuses: { ruby: "blocked" } });
  assert.equal(hiddenFailure.candidate.status, "blocked");
  const nestedFailure = fixtureArtifact({ before, after });
  nestedFailure.ecosystems[0].observations[0].status = "lookup-failed";
  nestedFailure.evaluationStatus = "blocked";
  assert.throws(() => validateObservationArtifact(nestedFailure, { root: repositoryRoot, sourceSha, requireSuccessful: true, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), /unsuccessful native result/u);
});

test("GitHub API transport failures are surfaced as ambiguous writes", async () => {
  const api = createGitHubApi({ token: "gh-read-only", repository: "elsoul/erpc-sdk", fetchImpl: async () => { throw new Error("timed out after request acceptance"); } });
  await assert.rejects(() => api.request("/git/ref/heads/main"), (error) => error instanceof DependencyMaintenanceError && error.code === "AMBIGUOUS_API_WRITE");
});

test("GitHub API adapter binds repository REST URLs without inventing a repository-scoped user endpoint", async () => {
  const seen = [];
  const api = createGitHubApi({ token: "gh-read-only", repository: "elsoul/erpc-sdk", fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ object: { sha: sourceSha } }) }; } });
  const result = await api.request(`/git/ref/heads/${BASE_BRANCH}`);
  assert.equal(result.object.sha, sourceSha);
  assert.equal(seen[0].url, `https://api.github.com/repos/elsoul/erpc-sdk/git/ref/heads/${BASE_BRANCH}`);
});

test("writer refuses stale main before any branch or pull request mutation", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const detachedRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-test-") );
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, detachedRoot], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: detachedRoot, stdio: "ignore" });
    const calls = [];
    const api = async (path) => {
      calls.push(path);
      if (path === "") return { id: 1429568627, full_name: "elsoul/erpc-sdk" };
      if (path === "/user") return { login: "github-actions[bot]", type: "Bot" };
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: "1".repeat(40) } };
      throw new Error(`unexpected API call: ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "STALE_MAIN");
    assert.deepEqual(calls, ["", `/git/ref/heads/${BASE_BRANCH}`]);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer rejects a foreign branch with no uniquely owned managed PR", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const detachedRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-test-") );
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, detachedRoot], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: detachedRoot, stdio: "ignore" });
    const api = async (path) => {
      if (path === "") return { id: 1429568627, full_name: "elsoul/erpc-sdk" };
      if (path === "/user") return { login: "github-actions[bot]", type: "Bot" };
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?")) return [];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) return { object: { sha: "2".repeat(40) } };
      throw new Error(`unexpected API call: ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "AMBIGUOUS_OWNERSHIP");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer refuses duplicate managed PR ownership before branch mutation", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const detachedRoot = mkdtempSync(join(tmpdir(), "erpc-dependency-test-"));
  try {
    execFileSync("git", ["clone", "--local", "--no-hardlinks", repositoryRoot, detachedRoot], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["checkout", "--detach", sourceSha], { cwd: detachedRoot, stdio: "ignore" });
    const api = async (path) => {
      if (path === "") return { id: 1429568627, full_name: "elsoul/erpc-sdk" };
      if (path === "/user") return { login: "github-actions[bot]", type: "Bot" };
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?")) return [{ number: 1 }, { number: 2 }];
      throw new Error(`unexpected API call: ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "AMBIGUOUS_OWNERSHIP");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer CREATE and SAFE_REUSE bind authenticated branch bytes and PR ownership", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headSha = "3".repeat(40);
  const blobSha = "4".repeat(40);
  const treeSha = "5".repeat(40);
  const branchCommit = commitMetadata(headSha);
  const contents = Object.fromEntries(changedPaths.map((path) => [`/contents/${path}?ref=${headSha}`, { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[path], "utf8").toString("base64") }]));
  const createCalls = [];
  const detachedRoot = detachedFixture();
  try {
  const createApi = async (path, { method = "GET" } = {}) => {
    createCalls.push(`${method} ${path}`);
    const identity = apiIdentity(path);
    if (identity) return identity;
    if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
    if (path.startsWith("/pulls?")) return path.includes("state=closed") ? [] : [];
    if (path === `/git/ref/heads/${BOT_BRANCH}`) { const error = new DependencyMaintenanceError("missing branch", "API_FAILED"); error.status = 404; throw error; }
    if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
    if (path === "/git/blobs") return { sha: blobSha };
    if (path === "/git/trees") return { sha: treeSha };
    if (path === "/git/commits" && method === "POST") return { sha: headSha };
    if (path === "/git/refs" && method === "POST") return { object: { sha: headSha } };
    if (path === `/commits/${headSha}`) return branchCommit;
    if (contents[path]) return contents[path];
    if (path === "/pulls" && method === "POST") return managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha });
    throw new Error(`unexpected create API call: ${method} ${path}`);
  };
  const created = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api: createApi, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
  assert.equal(created.action, "CREATE");
  assert.ok(createCalls.some((entry) => entry === "POST /git/refs"));

  const reusePr = managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha });
  const reuseApi = async (path, { method = "GET" } = {}) => {
    const identity = apiIdentity(path);
    if (identity) return identity;
    if (path === `/git/ref/heads/${BASE_BRANCH}` || path === `/git/ref/heads/${BOT_BRANCH}`) return { object: { sha: path.endsWith(BASE_BRANCH) ? sourceSha : headSha } };
    if (path.startsWith("/pulls?")) return path.includes("state=closed") ? [] : [reusePr];
    if (path === `/commits/${headSha}`) return branchCommit;
    if (path === `/compare/${sourceSha}...${headSha}`) return { files: changedPaths.map((filename) => ({ filename })) };
    if (contents[path]) return contents[path];
    throw new Error(`unexpected reuse API call: ${method} ${path}`);
  };
  const reused = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api: reuseApi, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
  assert.equal(reused.action, "SAFE_REUSE");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer stops on a branch race before a non-forcing ref update", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headOne = "6".repeat(40);
  const headTwo = "7".repeat(40);
  const oldFiles = Object.fromEntries(changedPaths.map((path) => [path, `${artifact.candidate.files[path]}\n`]));
  const oldDigest = hashFiles(oldFiles);
  const oldPr = managedPr({ source: "8".repeat(40), digest: oldDigest, paths: changedPaths, headSha: headOne });
  let branchReads = 0;
  const detachedRoot = detachedFixture();
  try {
  const api = async (path) => {
    const identity = apiIdentity(path);
    if (identity) return identity;
    if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
    if (path.startsWith("/pulls?")) return path.includes("state=closed") ? [] : [oldPr];
    if (path === `/git/ref/heads/${BOT_BRANCH}`) { branchReads += 1; return { object: { sha: branchReads === 1 ? headOne : headTwo } }; }
    if (path === `/commits/${headOne}`) return commitMetadata(headOne);
    if (path === `/compare/${oldPr.body.match(/"sourceSha":\s*"([^"]+)"/u)[1]}...${headOne}`) return { files: changedPaths.map((filename) => ({ filename })) };
    if (path.startsWith("/contents/") && path.endsWith(`?ref=${headOne}`)) { const file = path.slice("/contents/".length, -(`?ref=${headOne}`).length); if (oldFiles[file]) return { type: "file", encoding: "base64", content: Buffer.from(oldFiles[file], "utf8").toString("base64") }; }
    throw new Error(`unexpected race API call: ${path}`);
  };
  await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "RACE_HEAD");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("CI dispatch reuse binds exact head and base, with bounded visibility", async () => {
  const headSha = "9".repeat(40);
  let listings = 0;
  const run = { id: 99, run_attempt: 1, head_sha: headSha, head_branch: BOT_BRANCH, path: ".github/workflows/ci.yml", event: "workflow_dispatch", display_title: `CI dependency head=${headSha} base=${sourceSha}`, status: "queued" };
  const calls = [];
  const api = async (path, { method = "GET", body } = {}) => {
    calls.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    if (path.includes("/runs?")) { listings += 1; return { workflow_runs: listings === 1 ? [] : [run] }; }
    if (path.endsWith("/dispatches") && method === "POST") return null;
    throw new Error(`unexpected CI API call: ${method} ${path}`);
  };
  const result = await dispatchOrReuseCi(api, { headSha, baseSha: sourceSha });
  assert.equal(result.status, "DISPATCH");
  assert.equal(result.runId, 99);
  assert.ok(calls.some((call) => call.includes("expected_head_sha")));
});

test("native evaluator keeps Python integer-bound requirements unchanged", () => {
  const root = detachedFixture();
  try {
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root), runId: 8101, runAttempt: 1, useTemporaryCheckout: false });
    const python = artifact.ecosystems.find((entry) => entry.ecosystem === "python");
    assert.equal(python.status, "no-update");
    assert.equal(artifact.evaluationStatus, "no-update");
    assert.equal(artifact.candidate.status, "no-update");
    assert.deepEqual(artifact.candidate.changedPaths, []);
    assert.equal(python.observations.find((entry) => entry.name === "httpx").current, "0.27.0");
    assert.equal(python.observations.find((entry) => entry.name === "websockets").current, "13.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native evaluator keeps pip index failures and invalid JSON blocked despite resolver output", () => {
  for (const options of [{ pipIndexFailure: "httpx" }, { pipIndexInvalid: "httpx" }]) {
    const root = detachedFixture();
    try {
      const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, options), runId: 8102, runAttempt: 1, useTemporaryCheckout: false });
      const python = artifact.ecosystems.find((entry) => entry.ecosystem === "python");
      assert.equal(python.status, "lookup-failed");
      assert.equal(artifact.evaluationStatus, "blocked");
      assert.equal(artifact.candidate.status, "blocked");
      assert.deepEqual(artifact.candidate.changedPaths, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native Python candidate relaxes the exact pycryptodome pin only after a compatible selected version", () => {
  const root = detachedFixture();
  try {
    const current = nativeFixtureVersions(root).python.get("pycryptodome");
    const target = nextPatch(current);
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, { bump: { pycryptodome: target }, pipLatest: { pycryptodome: "4.0.0" } }), runId: 8103, runAttempt: 1, useTemporaryCheckout: false });
    const python = artifact.ecosystems.find((entry) => entry.ecosystem === "python");
    assert.equal(python.status, "eligible");
    assert.deepEqual(artifact.candidate.changedPaths, ["packages/python/pyproject.toml"]);
    assert.match(artifact.candidate.files["packages/python/pyproject.toml"], new RegExp(`pycryptodome==${target.replaceAll(".", "\\.")}`, "u"));
    assert.doesNotMatch(artifact.candidate.files["packages/python/pyproject.toml"], new RegExp(`pycryptodome==${current.replaceAll(".", "\\.")}`, "u"));
    const observation = python.observations.find((entry) => entry.name === "pycryptodome");
    assert.equal(observation.latest, "4.0.0");
    assert.equal(observation.selected, target);
    assert.equal(observation.selectedClassification, "patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TypeScript evaluator fails closed when a declared dependency has no current inventory", () => {
  const root = detachedFixture();
  try {
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, { omitPnpmInventory: ["esbuild", "vitest"] }), runId: 8104, runAttempt: 1, useTemporaryCheckout: false });
    const typescript = artifact.ecosystems.find((entry) => entry.ecosystem === "typescript");
    assert.equal(typescript.status, "lookup-failed");
    assert.equal(typescript.observations.some((entry) => entry.name === "vitest" && entry.status === "lookup-failed"), true);
    assert.equal(artifact.candidate.status, "blocked");
    assert.deepEqual(artifact.candidate.changedPaths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TypeScript evaluator resolves an absent outdated row and updates the manifest and lock", () => {
  const root = detachedFixture();
  try {
    const current = nativeFixtureVersions(root).versions.get("vitest");
    const target = nextPatch(current);
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, { bump: { vitest: target } }), runId: 8105, runAttempt: 1, useTemporaryCheckout: false });
    const typescript = artifact.ecosystems.find((entry) => entry.ecosystem === "typescript");
    assert.equal(typescript.status, "eligible");
    assert.deepEqual(artifact.candidate.changedPaths, ["packages/typescript/package.json", "pnpm-lock.yaml"]);
    assert.match(artifact.candidate.files["packages/typescript/package.json"], new RegExp(`"vitest": "\\^${target.replaceAll(".", "\\.")}"`, "u"));
    assert.match(artifact.candidate.files["pnpm-lock.yaml"], new RegExp(`vitest@${target.replaceAll(".", "\\.")}`, "u"));
    assert.match(artifact.candidate.files["pnpm-lock.yaml"], new RegExp(`specifier: \\^${target.replaceAll(".", "\\.")}\\n\\s+version: ${target.replaceAll(".", "\\.")}`, "u"));
    const observation = typescript.observations.find((entry) => entry.name === "vitest");
    assert.equal(observation.lookup, "pnpm-compatible-scratch");
    assert.equal(observation.classification, "patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TypeScript evaluator includes an override-only transitive esbuild target in the candidate", () => {
  const root = detachedFixture();
  try {
    const current = nativeFixtureVersions(root).versions.get("esbuild");
    const target = nextPatch(current);
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, { bump: { esbuild: target } }), runId: 8106, runAttempt: 1, useTemporaryCheckout: false });
    const typescript = artifact.ecosystems.find((entry) => entry.ecosystem === "typescript");
    assert.equal(typescript.status, "eligible");
    assert.deepEqual(artifact.candidate.changedPaths, ["pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    assert.match(artifact.candidate.files["pnpm-workspace.yaml"], new RegExp(`esbuild: ${target.replaceAll(".", "\\.")}`, "u"));
    assert.match(artifact.candidate.files["pnpm-lock.yaml"], new RegExp(`esbuild@${target.replaceAll(".", "\\.")}`, "u"));
    const observation = typescript.observations.find((entry) => entry.name === "esbuild");
    assert.equal(observation.current, current);
    assert.equal(observation.selected ?? observation.latest, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TypeScript scratch resolution preserves one caret operator without generating doubled bounds", () => {
  const root = detachedFixture();
  const scratchSpecs = [];
  try {
    const current = nativeFixtureVersions(root).versions.get("@types/node");
    const target = nextPatch(current);
    const baseRunner = nativeRunner(root, { bump: { "@types/node": target } });
    const runner = (command, args, options) => {
      if (command === "corepack" && args[0] === "pnpm" && args[1] === "update") {
        const packageJson = JSON.parse(readFileSync(join(root, "packages/typescript/package.json"), "utf8"));
        scratchSpecs.push(packageJson.devDependencies["@types/node"]);
      }
      return baseRunner(command, args, options);
    };
    const result = evaluateTypescript(root, { runner, env: process.env });
    assert.equal(result.status, "eligible");
    assert.ok(scratchSpecs.length > 0);
    assert.ok(scratchSpecs.every((spec) => spec === `^${current}`));
    assert.equal(scratchSpecs.some((spec) => /\^\^|~~/u.test(spec)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native TypeScript resolution failure blocks the ecosystem instead of becoming no-update", () => {
  const root = detachedFixture();
  try {
    const current = nativeFixtureVersions(root).versions.get("@types/node");
    const target = nextPatch(current);
    const baseRunner = nativeRunner(root, { bump: { "@types/node": target } });
    const runner = (command, args, options) => {
      if (command === "corepack" && args[0] === "pnpm" && args[1] === "update" && args.at(-1) === "@types/node") return { status: 1, stdout: "", stderr: "native resolution failed" };
      return baseRunner(command, args, options);
    };
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner, runId: 8110, runAttempt: 1, useTemporaryCheckout: false });
    const typescript = artifact.ecosystems.find((entry) => entry.ecosystem === "typescript");
    assert.equal(typescript.status, "resolution-failed");
    assert.equal(artifact.evaluationStatus, "blocked");
    assert.equal(artifact.candidate.status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Ruby evaluator selects a current-major minor and restores the final exact PATH constraint", () => {
  const root = detachedFixture();
  const trace = [];
  try {
    const current = nativeFixtureVersions(root).ruby.get("bigdecimal");
    const target = nextMinor(current);
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner: nativeRunner(root, { rubyRows: [`bigdecimal (newest 5.0.0, installed ${current})`], rubyResolved: { bigdecimal: target }, trace }), runId: 8107, runAttempt: 1, useTemporaryCheckout: false });
    const ruby = artifact.ecosystems.find((entry) => entry.ecosystem === "ruby");
    assert.equal(ruby.status, "eligible");
    assert.deepEqual(artifact.candidate.changedPaths, ["packages/ruby/Gemfile.lock", "packages/ruby/erpc-sdk.gemspec"]);
    assert.match(artifact.candidate.files["packages/ruby/erpc-sdk.gemspec"], new RegExp(`bigdecimal", "= ${target.replaceAll(".", "\\.")}`, "u"));
    assert.match(artifact.candidate.files["packages/ruby/Gemfile.lock"], new RegExp(`bigdecimal \\(${target.replaceAll(".", "\\.")}\\)`, "u"));
    assert.match(artifact.candidate.files["packages/ruby/Gemfile.lock"], new RegExp(`bigdecimal \\(= ${target.replaceAll(".", "\\.")}\\)`, "u"));
    const updateCall = trace.find((entry) => entry.command === "bundle" && entry.args[0] === "lock" && entry.args[1] === "--update" && entry.args[2] === "bigdecimal");
    assert.ok(updateCall);
    assert.ok(updateCall.args.includes("--minor"));
    assert.equal(updateCall.args.includes("--major"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Go inventory ignores the go directive and retains block and single-line require modules", () => {
  const root = detachedFixture();
  try {
    const baseRunner = nativeRunner(root);
    const runner = (command, args, options) => {
      const result = baseRunner(command, args, options);
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-u") {
        const rows = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.Path !== "go");
        return { ...result, stdout: rows.map((row) => JSON.stringify(row)).join("\n") };
      }
      return result;
    };
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner, runId: 8111, runAttempt: 1, useTemporaryCheckout: false });
    const go = artifact.ecosystems.find((entry) => entry.ecosystem === "go");
    assert.notEqual(go.status, "lookup-failed");
    assert.equal(go.observations.some((entry) => entry.name === "go"), false);
    assert.equal(go.observations.find((entry) => entry.name === "filippo.io/edwards25519")?.direct, true);
    assert.equal(go.observations.find((entry) => entry.name === "golang.org/x/sys")?.direct, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Go patch update uses supported go get argv and keeps GOTOOLCHAIN local", () => {
  const root = detachedFixture();
  const getCalls = [];
  try {
    const current = nativeFixtureVersions(root).go.get("filippo.io/edwards25519");
    const target = nextPatch(current);
    const baseRunner = nativeRunner(root);
    const runner = (command, args, options) => {
      if (command === "go" && args[0] === "get") {
        getCalls.push({ args: [...args], env: options.env });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "go" && args[0] === "mod" && args[1] === "tidy") return { status: 0, stdout: "", stderr: "" };
      const result = baseRunner(command, args, options);
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-u") {
        const rows = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const updated = rows.map((row) => row.Path === "filippo.io/edwards25519" ? { ...row, Update: { Version: `v${target}` } } : row);
        return { ...result, stdout: updated.map((row) => JSON.stringify(row)).join("\n") };
      }
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-json" && args[3]?.startsWith("filippo.io/edwards25519@")) return { ...result, stdout: JSON.stringify({ Path: "filippo.io/edwards25519", Version: `v${target}` }) };
      return result;
    };
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner, runId: 8112, runAttempt: 1, useTemporaryCheckout: false });
    assert.equal(artifact.ecosystems.find((entry) => entry.ecosystem === "go").status, "eligible");
    assert.equal(getCalls.length, 1);
    assert.deepEqual(getCalls[0].args, ["get", `filippo.io/edwards25519@v${target}`]);
    assert.equal(getCalls[0].args.includes("-mod=mod"), false);
    assert.equal(getCalls[0].env.GOTOOLCHAIN, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Go runtime fallback preserves unrestricted latest and selects the compatible major-minor line", () => {
  const root = detachedFixture();
  const lookupCalls = [];
  const getCalls = [];
  try {
    const current = nativeFixtureVersions(root).go.get("filippo.io/edwards25519");
    const latest = nextMinor(current);
    const selected = nextPatch(current);
    const [major, minor] = current.split(".");
    const baseRunner = nativeRunner(root);
    const runner = (command, args, options) => {
      if (command === "go" && args[0] === "get") {
        getCalls.push({ args: [...args], env: options.env });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "go" && args[0] === "mod" && args[1] === "tidy") return { status: 0, stdout: "", stderr: "" };
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-json" && args[3]?.startsWith("filippo.io/edwards25519@")) {
        lookupCalls.push({ args: [...args], env: options.env });
        const metadata = args[3].endsWith(`@v${major}.${minor}`) ? { Path: "filippo.io/edwards25519", Version: `v${selected}`, GoVersion: "1.20" } : { Path: "filippo.io/edwards25519", Version: `v${latest}`, GoVersion: "1.24" };
        return { status: 0, stdout: JSON.stringify(metadata), stderr: "" };
      }
      const result = baseRunner(command, args, options);
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-u") {
        const rows = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const updated = rows.map((row) => row.Path === "filippo.io/edwards25519" ? { ...row, Update: { Version: `v${latest}` } } : row);
        return { ...result, stdout: updated.map((row) => JSON.stringify(row)).join("\n") };
      }
      return result;
    };
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner, runId: 8113, runAttempt: 1, useTemporaryCheckout: false });
    const go = artifact.ecosystems.find((entry) => entry.ecosystem === "go");
    const observation = go.observations.find((entry) => entry.name === "filippo.io/edwards25519");
    assert.equal(go.status, "eligible");
    assert.equal(observation.latest, `v${latest}`);
    assert.equal(observation.selected, `v${selected}`);
    assert.equal(observation.selectedGoVersion, "1.20");
    assert.deepEqual(lookupCalls.map((entry) => entry.args[3]), [`filippo.io/edwards25519@v${major}`, `filippo.io/edwards25519@v${major}.${minor}`]);
    assert.ok(lookupCalls.every((entry) => entry.env.GOTOOLCHAIN === "local"));
    assert.deepEqual(getCalls.map((entry) => entry.args), [["get", `filippo.io/edwards25519@v${selected}`]]);
    assert.equal(getCalls[0].env.GOTOOLCHAIN, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Go malformed runtime metadata fails closed without fallback lookup or go get", () => {
  const root = detachedFixture();
  const lookupCalls = [];
  const getCalls = [];
  const beforeGoMod = readFileSync(join(root, "packages/go/go.mod"), "utf8");
  const beforeGoSum = readFileSync(join(root, "packages/go/go.sum"), "utf8");
  try {
    const baseRunner = nativeRunner(root);
    const runner = (command, args, options) => {
      if (command === "go" && args[0] === "get") {
        getCalls.push([...args]);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "go" && args[0] === "mod" && args[1] === "tidy") return { status: 0, stdout: "", stderr: "" };
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-json" && args[3]?.startsWith("filippo.io/edwards25519@")) {
        lookupCalls.push([...args]);
        const value = args[3].endsWith("@v1.1") ? { Path: "filippo.io/edwards25519", Version: "v1.1.1", GoVersion: "1.20" } : { Path: "filippo.io/edwards25519", Version: "v1.2.0", GoVersion: "not-a-version" };
        return { status: 0, stdout: JSON.stringify(value), stderr: "" };
      }
      const result = baseRunner(command, args, options);
      if (command === "go" && args[0] === "list" && args[1] === "-m" && args[2] === "-u") {
        const rows = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const updated = rows.map((row) => row.Path === "filippo.io/edwards25519" ? { ...row, Update: { Version: "v1.2.0" } } : row);
        return { ...result, stdout: updated.map((row) => JSON.stringify(row)).join("\n") };
      }
      return result;
    };
    const artifact = evaluateRepository({ root, sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runner, runId: 8114, runAttempt: 1, useTemporaryCheckout: false });
    const go = artifact.ecosystems.find((entry) => entry.ecosystem === "go");
    assert.equal(go.status, "lookup-failed");
    assert.equal(artifact.evaluationStatus, "blocked");
    assert.equal(artifact.candidate.status, "blocked");
    assert.deepEqual(lookupCalls.map((args) => args[3]), ["filippo.io/edwards25519@v1"]);
    assert.equal(getCalls.length, 0);
    assert.equal(readFileSync(join(root, "packages/go/go.mod"), "utf8"), beforeGoMod);
    assert.equal(readFileSync(join(root, "packages/go/go.sum"), "utf8"), beforeGoSum);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact validation requires native lookup evidence and exact run identity", () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const missingInventory = structuredClone(artifact);
  missingInventory.ecosystems[0].observations = [];
  assert.throws(() => validateObservationArtifact(missingInventory, { root: repositoryRoot, sourceSha }), /native lookup inventory|observations/u);

  const missingEvidence = structuredClone(artifact);
  missingEvidence.ecosystems[0].lookup = null;
  missingEvidence.ecosystems[0].lookups = [];
  assert.throws(() => validateObservationArtifact(missingEvidence, { root: repositoryRoot, sourceSha }), /lookup|evidence|command/u);

  const staleRun = structuredClone(artifact);
  staleRun.runId = 7002;
  assert.throws(() => validateObservationArtifact(staleRun, { root: repositoryRoot, sourceSha, expectedRunId: 7001 }), /stale|binding/u);
  const staleAttempt = structuredClone(artifact);
  staleAttempt.runAttempt = 2;
  assert.throws(() => validateObservationArtifact(staleAttempt, { root: repositoryRoot, sourceSha, expectedRunAttempt: 1 }), /stale|binding/u);
  const staleEvent = structuredClone(artifact);
  staleEvent.eventName = "workflow_dispatch";
  assert.throws(() => validateObservationArtifact(staleEvent, { root: repositoryRoot, sourceSha, expectedEventName: "schedule" }), /stale|binding/u);
  const staleWorkflow = structuredClone(artifact);
  staleWorkflow.workflowRef = `${workflowRef}-forged`;
  assert.throws(() => validateObservationArtifact(staleWorkflow, { root: repositoryRoot, sourceSha, expectedWorkflowRef: workflowRef }), /stale|binding|workflow/u);

  const failedInventory = structuredClone(artifact);
  failedInventory.ecosystems[0].status = "blocked";
  failedInventory.ecosystems[0].observations[0].status = "lookup-failed";
  failedInventory.evaluationStatus = "blocked";
  assert.throws(() => validateObservationArtifact(failedInventory, { root: repositoryRoot, sourceSha, requireSuccessful: true }), /unsuccessful|lookup/u);
});

test("buildObservation refuses five-ecosystem results with no native command receipts and writer rejects stripped receipts", async () => {
  const { before, after } = snapshots();
  const results = ECOSYSTEMS.map((ecosystem) => ({
    ecosystem,
    status: ecosystem === "typescript" ? "eligible" : "no-update",
    observations: [{ name: "synthetic", current: "1.0.0", latest: "1.0.0", status: "no-update" }],
    updates: [],
  }));
  assert.throws(() => buildObservation({ sourceSha, eventName: "schedule", eventRef: SOURCE_REF, workflowRef, runId: 7001, runAttempt: 1, results, before, after }), /native lookup receipt|command|observation/u);
  const valid = fixtureArtifact({ before, after });
  valid.ecosystems[0].lookup = null;
  valid.ecosystems[0].lookups = [];
  const root = detachedFixture();
  try {
    await assert.rejects(() => writeDependencyPullRequest({ root, artifact: valid, sourceSha, repository: "elsoul/erpc-sdk", api: async () => { throw new Error("writer API must not be reached"); }, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), /native lookup receipt|ARTIFACT_INVALID|lookup/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintained parser fixtures reject duplicate or unsafe YAML, malformed TOML, and valid checksum/source mutations", () => {
  const { before, after } = snapshots();
  const duplicateYaml = { ...after, "pnpm-lock.yaml": after["pnpm-lock.yaml"].replace(/^(lockfileVersion:[^\n]+\n)/mu, "$1$1") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: duplicateYaml }), /duplicate|parser|YAML/u);
  const unsafeYaml = { ...after, "pnpm-lock.yaml": after["pnpm-lock.yaml"].replace(/^lockfileVersion:[^\n]+$/mu, "lockfileVersion: !ruby/object:Kernel {}") };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: unsafeYaml }), /parser|constructor|YAML|lockfile/u);
  const quotedTarball = { ...after, "pnpm-lock.yaml": after["pnpm-lock.yaml"].replace("resolution: {integrity:", 'resolution: {tarball: "https://example.invalid/foreign.tgz", integrity:') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: quotedTarball }), /source|tarball|unsupported|CANDIDATE/u);
  const malformedToml = { ...after, "Cargo.lock": `${after["Cargo.lock"]}\n[unterminated` };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: malformedToml }), /parser|TOML|lockfile/u);

  const cargoChecksum = after["Cargo.lock"].replace(/^(checksum\s*=\s*")([0-9a-f]{64})(")$/mu, "$1" + "a".repeat(64) + "$3");
  assert.notEqual(cargoChecksum, after["Cargo.lock"]);
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: { ...after, "Cargo.lock": cargoChecksum } }), /checksum|unchanged/u);
  const pnpmChecksum = after["pnpm-lock.yaml"].replace(/sha512-[A-Za-z0-9+/]{86}==/u, `sha512-${"A".repeat(86)}==`);
  assert.notEqual(pnpmChecksum, after["pnpm-lock.yaml"]);
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: { ...after, "pnpm-lock.yaml": pnpmChecksum } }), /integrity|unchanged/u);
  const directMismatch = { ...after, "packages/rust/Cargo.toml": after["packages/rust/Cargo.toml"].replace('num-bigint = { version = "=0.5.1"', 'num-bigint = { version = "=0.5.2"') };
  assert.throws(() => validateCandidateFiles({ root: repositoryRoot, before, after: directMismatch }), /stale|lock|direct/u);
});

test("writer UPDATE uses plural Git trees, parent-preserving commits, and non-forcing PATCH", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const oldSource = "c".repeat(40);
  const oldPr = managedPr({ source: oldSource, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha: oldHead, number: 42 });
  const calls = [];
  const detachedRoot = detachedFixture();
  let branchSha = oldHead;
  try {
    const api = async (path, { method = "GET", body } = {}) => {
      calls.push({ path, method, body });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [oldPr];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) return { object: { sha: branchSha } };
      if (path === `/commits/${oldHead}` || path === `/commits/${newHead}`) return commitMetadata(path.endsWith(oldHead) ? oldHead : newHead);
      if (path === `/compare/${oldSource}...${oldHead}`) return { files: changedPaths.map((filename) => ({ filename })) };
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${oldHead}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${oldHead}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${newHead}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${newHead}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
      if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
      if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
      if (path === "/git/commits" && method === "POST") return { sha: newHead };
      if (path === `/git/refs/heads/${BOT_BRANCH}` && method === "PATCH") { branchSha = newHead; return { object: { sha: newHead } }; }
      if (path === `/pulls/${oldPr.number}` && method === "PATCH") return { ...oldPr, body };
      throw new Error(`unexpected update API call: ${method} ${path}`);
    };
    const result = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
    assert.equal(result.action, "UPDATE");
    const commitCall = calls.find((entry) => entry.path === "/git/commits" && entry.method === "POST");
    assert.deepEqual(commitCall.body.parents, [oldHead, sourceSha]);
    const treeCall = calls.find((entry) => entry.path === "/git/trees" && entry.method === "POST");
    assert.equal(treeCall.body.base_tree, "base-tree");
    assert.equal(Array.isArray(treeCall.body.tree), true);
    assert.equal(treeCall.body.tree.length, changedPaths.length);
    const refPatches = calls.filter((entry) => entry.path === `/git/refs/heads/${BOT_BRANCH}` && entry.method === "PATCH");
    assert.equal(refPatches.length, 1);
    assert.deepEqual(refPatches[0].body, { sha: newHead, force: false });
    assert.equal(calls.filter((entry) => entry.path === `/pulls/${oldPr.number}` && entry.method === "PATCH").length, 1);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer advances a historical merged cohort into a new CREATE", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const oldHead = "d".repeat(40);
  const newHead = "e".repeat(40);
  const oldSource = "f".repeat(40);
  const mergedPr = managedPr({ source: oldSource, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha: oldHead, merged: true, number: 43 });
  const calls = [];
  const detachedRoot = detachedFixture();
  let branchSha = oldHead;
  try {
    const api = async (path, { method = "GET", body } = {}) => {
      calls.push({ path, method, body });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [];
      if (path.startsWith("/pulls?") && path.includes("state=closed")) return [mergedPr];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) return { object: { sha: branchSha } };
      if (path === `/commits/${oldHead}` || path === `/commits/${newHead}`) return commitMetadata(path.endsWith(oldHead) ? oldHead : newHead);
      if (path === `/compare/${oldSource}...${oldHead}`) return { files: changedPaths.map((filename) => ({ filename })) };
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${oldHead}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${oldHead}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${newHead}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${newHead}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
      if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
      if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
      if (path === "/git/commits" && method === "POST") return { sha: newHead };
      if (path === `/git/refs/heads/${BOT_BRANCH}` && method === "PATCH") { branchSha = newHead; return { object: { sha: newHead } }; }
      if (path === "/pulls" && method === "POST") return managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha: newHead, number: 44 });
      throw new Error(`unexpected merged recurrence API call: ${method} ${path}`);
    };
    const result = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
    assert.equal(result.action, "CREATE");
    assert.equal(calls.filter((entry) => entry.path === "/pulls" && entry.method === "POST").length, 1);
    const commitCall = calls.find((entry) => entry.path === "/git/commits" && entry.method === "POST");
    assert.deepEqual(commitCall.body.parents, [oldHead, sourceSha]);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer CREATE uses the real GitHub REST adapter paths, methods, and JSON bodies", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headSha = "7".repeat(40);
  const seen = [];
  const detachedRoot = detachedFixture();
  try {
    const handler = async (path, { method = "GET", body } = {}) => {
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?")) return [];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) {
        const error = new DependencyMaintenanceError("missing branch", "API_FAILED");
        error.status = 404;
        throw error;
      }
      if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
      if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
      if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
      if (path === "/git/commits" && method === "POST") return { sha: headSha };
      if (path === "/git/refs" && method === "POST") return { object: { sha: headSha } };
      if (path === `/commits/${headSha}`) return commitMetadata(headSha);
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${headSha}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${headSha}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path === "/pulls" && method === "POST") return managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha });
      throw new Error(`unexpected HTTP-backed writer API call: ${method} ${path}`);
    };
    const api = fetchBackedApi(handler, seen);
    const result = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
    assert.equal(result.action, "CREATE");
    const refWrite = seen.find((entry) => entry.url.endsWith(`/git/refs`) && entry.method === "POST");
    assert.equal(refWrite.url, "https://api.github.com/repos/elsoul/erpc-sdk/git/refs");
    assert.deepEqual(refWrite.body, { ref: `refs/heads/${BOT_BRANCH}`, sha: headSha });
    const prWrite = seen.find((entry) => entry.url.endsWith("/pulls") && entry.method === "POST");
    assert.equal(prWrite.url, "https://api.github.com/repos/elsoul/erpc-sdk/pulls");
    assert.equal(prWrite.body.head, BOT_BRANCH);
    assert.equal(prWrite.body.base, BASE_BRANCH);
    assert.equal(typeof prWrite.body.body, "string");
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer CREATE accepts a verified web-flow commit and rejects unsigned or foreign provenance before PR creation", async () => {
  const cases = [
    { name: "verified web-flow", valid: true, author: "github-actions[bot]", committer: "web-flow", verification: { verified: true, reason: "valid" } },
    { name: "unsigned web-flow", valid: false, author: "github-actions[bot]", committer: "web-flow", verification: { verified: false, reason: "unsigned" } },
    { name: "wrong author", valid: false, author: "attacker", committer: "web-flow", verification: { verified: true, reason: "valid" } },
    { name: "other committer", valid: false, author: "github-actions[bot]", committer: "attacker", verification: { verified: true, reason: "valid" } },
  ];
  for (const provenance of cases) {
    const { before, after } = snapshots();
    const artifact = fixtureArtifact({ before, after });
    const changedPaths = artifact.candidate.changedPaths;
    const headSha = "8".repeat(40);
    const calls = [];
    const detachedRoot = detachedFixture();
    try {
      const commit = {
        sha: headSha,
        tree: { sha: "tree-sha" },
        parents: [{ sha: sourceSha }],
        commit: { tree: { sha: "tree-sha" }, author: { name: provenance.author }, committer: { name: provenance.committer }, verification: provenance.verification },
        author: { login: provenance.author },
        committer: { login: provenance.committer },
      };
      const api = async (path, { method = "GET" } = {}) => {
        calls.push({ path, method });
        const identity = apiIdentity(path);
        if (identity) return identity;
        if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
        if (path.startsWith("/pulls?")) return [];
        if (path === `/git/ref/heads/${BOT_BRANCH}`) {
          const error = new DependencyMaintenanceError("missing branch", "API_FAILED");
          error.status = 404;
          throw error;
        }
        if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
        if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
        if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
        if (path === "/git/commits" && method === "POST") return { sha: headSha };
        if (path === "/git/refs" && method === "POST") return { object: { sha: headSha } };
        if (path === `/commits/${headSha}`) return commit;
        if (path.startsWith("/contents/") && path.endsWith(`?ref=${headSha}`)) {
          const relativePath = path.slice("/contents/".length, -(`?ref=${headSha}`).length);
          return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
        }
        if (path === "/pulls" && method === "POST") return managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha });
        throw new Error(`unexpected provenance API call: ${method} ${path}`);
      };
      const action = () => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
      if (provenance.valid) {
        const result = await action();
        assert.equal(result.action, "CREATE", provenance.name);
        assert.equal(calls.filter((entry) => entry.path === "/pulls" && entry.method === "POST").length, 1, provenance.name);
      } else {
        await assert.rejects(action, (error) => error instanceof DependencyMaintenanceError && error.code === "COMMIT_PROVENANCE_INVALID", provenance.name);
        assert.equal(calls.some((entry) => entry.path === "/pulls" && entry.method === "POST"), false, provenance.name);
      }
    } finally {
      rmSync(detachedRoot, { recursive: true, force: true });
    }
  }
});

test("writer rejects a closed unmerged cohort and treats a 403 branch response as failure, not a missing branch", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const detachedRoot = detachedFixture();
  try {
    const closedUnmerged = managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: artifact.candidate.changedPaths, headSha: "1".repeat(40), number: 45 });
    const closedCalls = [];
    const closedApi = async (path, { method = "GET" } = {}) => {
      closedCalls.push({ path, method });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [];
      if (path.startsWith("/pulls?") && path.includes("state=closed")) return [closedUnmerged];
      throw new Error(`unexpected closed PR API call: ${method} ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api: closedApi, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "AMBIGUOUS_OWNERSHIP");
    assert.equal(closedCalls.some((entry) => entry.method === "POST"), false);

    const forbiddenCalls = [];
    const forbiddenApi = async (path, { method = "GET" } = {}) => {
      forbiddenCalls.push({ path, method });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [];
      if (path.startsWith("/pulls?") && path.includes("state=closed")) return [];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) {
        const error = new DependencyMaintenanceError("forbidden", "API_FAILED");
        error.status = 403;
        throw error;
      }
      throw new Error(`unexpected forbidden branch API call: ${method} ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api: forbiddenApi, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "API_FAILED" && error.status === 403);
    assert.equal(forbiddenCalls.some((entry) => entry.path === "/git/refs" && entry.method === "POST"), false);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer observes an accepted branch-ref transport failure once without retrying the POST", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headSha = "2".repeat(40);
  const calls = [];
  const detachedRoot = detachedFixture();
  let branchReads = 0;
  try {
    const api = async (path, { method = "GET" } = {}) => {
      calls.push({ path, method });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?")) return [];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) {
        branchReads += 1;
        if (branchReads === 1) {
          const error = new DependencyMaintenanceError("missing branch", "API_FAILED");
          error.status = 404;
          throw error;
        }
        return { object: { sha: headSha } };
      }
      if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
      if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
      if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
      if (path === "/git/commits" && method === "POST") return { sha: headSha };
      if (path === "/git/refs" && method === "POST") {
        const error = new DependencyMaintenanceError("accepted ref write but transport failed", "AMBIGUOUS_API_WRITE");
        throw error;
      }
      if (path === `/commits/${headSha}`) return commitMetadata(headSha);
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${headSha}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${headSha}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path === "/pulls" && method === "POST") return managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha });
      throw new Error(`unexpected ambiguous ref API call: ${method} ${path}`);
    };
    const result = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
    assert.equal(result.action, "CREATE");
    assert.equal(calls.filter((entry) => entry.path === "/git/refs" && entry.method === "POST").length, 1);
    assert.equal(branchReads, 2);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer observes an accepted pull-request transport failure once without a duplicate POST", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headSha = "3".repeat(40);
  const calls = [];
  const detachedRoot = detachedFixture();
  let observedPr = null;
  try {
    const api = async (path, { method = "GET", body } = {}) => {
      calls.push({ path, method, body });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return observedPr ? [observedPr] : [];
      if (path.startsWith("/pulls?") && path.includes("state=closed")) return [];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) {
        const error = new DependencyMaintenanceError("missing branch", "API_FAILED");
        error.status = 404;
        throw error;
      }
      if (path === `/git/commits/${sourceSha}`) return { tree: { sha: "base-tree" } };
      if (path === "/git/blobs" && method === "POST") return { sha: "blob-sha" };
      if (path === "/git/trees" && method === "POST") return { sha: "tree-sha" };
      if (path === "/git/commits" && method === "POST") return { sha: headSha };
      if (path === "/git/refs" && method === "POST") return { object: { sha: headSha } };
      if (path === `/commits/${headSha}`) return commitMetadata(headSha);
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${headSha}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${headSha}`).length);
        return { type: "file", encoding: "base64", content: Buffer.from(artifact.candidate.files[relativePath], "utf8").toString("base64") };
      }
      if (path === "/pulls" && method === "POST") {
        observedPr = managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha, bodyOverride: body.body });
        throw new DependencyMaintenanceError("accepted PR write but transport failed", "AMBIGUOUS_API_WRITE");
      }
      throw new Error(`unexpected ambiguous PR API call: ${method} ${path}`);
    };
    const result = await writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef });
    assert.equal(result.action, "CREATE");
    assert.equal(calls.filter((entry) => entry.path === "/pulls" && entry.method === "POST").length, 1);
    assert.equal(calls.filter((entry) => entry.path.startsWith("/pulls?") && entry.path.includes("state=open")).length, 2);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("CI dispatch observes an accepted transport failure once without a blind second dispatch", async () => {
  const headSha = "4".repeat(40);
  const run = { id: 404, run_attempt: 1, head_sha: headSha, head_branch: BOT_BRANCH, path: ".github/workflows/ci.yml", event: "workflow_dispatch", display_title: `CI dependency head=${headSha} base=${sourceSha}`, status: "queued" };
  const calls = [];
  let listings = 0;
  const api = async (path, { method = "GET" } = {}) => {
    calls.push({ path, method });
    if (path.includes("/runs?")) { listings += 1; return { workflow_runs: listings === 1 ? [] : [run] }; }
    if (path.endsWith("/dispatches") && method === "POST") throw new DependencyMaintenanceError("accepted dispatch but transport failed", "AMBIGUOUS_API_WRITE");
    throw new Error(`unexpected ambiguous dispatch API call: ${method} ${path}`);
  };
  const result = await dispatchOrReuseCi(api, { headSha, baseSha: sourceSha });
  assert.equal(result.status, "SAFE_REUSE_AFTER_AMBIGUOUS_DISPATCH");
  assert.equal(listings, 2);
  assert.equal(calls.filter((entry) => entry.path.endsWith("/dispatches") && entry.method === "POST").length, 1);
});

test("CI reuses an exact successful head/base/title run with zero dispatch POSTs", async () => {
  const headSha = "5".repeat(40);
  const run = { id: 505, run_attempt: 2, head_sha: headSha, head_branch: BOT_BRANCH, path: ".github/workflows/ci.yml", event: "workflow_dispatch", display_title: `CI dependency head=${headSha} base=${sourceSha}`, status: "completed", conclusion: "success" };
  const calls = [];
  const api = async (path, { method = "GET" } = {}) => {
    calls.push({ path, method });
    if (path.includes("/runs?")) return { workflow_runs: [run] };
    throw new Error(`unexpected CI reuse API call: ${method} ${path}`);
  };
  const result = await dispatchOrReuseCi(api, { headSha, baseSha: sourceSha });
  assert.equal(result.status, "SAFE_REUSE");
  assert.equal(result.runId, run.id);
  assert.equal(calls.filter((entry) => entry.path.endsWith("/dispatches") && entry.method === "POST").length, 0);
});

test("CI does not reuse a wrong-base or wrong-title run", async () => {
  const headSha = "6".repeat(40);
  const wrongRun = { id: 606, run_attempt: 1, head_sha: headSha, head_branch: BOT_BRANCH, path: ".github/workflows/ci.yml", event: "workflow_dispatch", display_title: `CI dependency head=${headSha} base=${"7".repeat(40)}`, status: "queued" };
  const calls = [];
  const api = async (path, { method = "GET" } = {}) => {
    calls.push({ path, method });
    if (path.includes("/runs?")) return { workflow_runs: [wrongRun] };
    if (path.endsWith("/dispatches") && method === "POST") {
      const error = new DependencyMaintenanceError("dispatch rejected", "API_FAILED");
      error.status = 422;
      throw error;
    }
    throw new Error(`unexpected wrong-base CI API call: ${method} ${path}`);
  };
  await assert.rejects(() => dispatchOrReuseCi(api, { headSha, baseSha: sourceSha }), (error) => error instanceof DependencyMaintenanceError && error.code === "API_FAILED" && error.status === 422);
  assert.equal(calls.filter((entry) => entry.path.endsWith("/dispatches") && entry.method === "POST").length, 1);
});

test("writer rejects forged managed PR identity before branch or PR mutation", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const forged = managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: artifact.candidate.changedPaths, headSha: "8".repeat(40), number: 47 });
  forged.user = { login: "attacker", type: "User" };
  forged.head.repo.full_name = "attacker/erpc-sdk";
  const calls = [];
  const detachedRoot = detachedFixture();
  try {
    const api = async (path, { method = "GET" } = {}) => {
      calls.push({ path, method });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [forged];
      throw new Error(`unexpected forged PR API call: ${method} ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "AMBIGUOUS_OWNERSHIP");
    assert.equal(calls.some((entry) => entry.method === "POST" || entry.method === "PATCH"), false);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

test("writer rejects a user-modified file on an otherwise owned dependency branch", async () => {
  const { before, after } = snapshots();
  const artifact = fixtureArtifact({ before, after });
  const changedPaths = artifact.candidate.changedPaths;
  const headSha = "9".repeat(40);
  const managed = managedPr({ source: sourceSha, digest: artifact.candidate.candidateDigest, paths: changedPaths, headSha, number: 48 });
  const calls = [];
  const detachedRoot = detachedFixture();
  try {
    const api = async (path, { method = "GET" } = {}) => {
      calls.push({ path, method });
      const identity = apiIdentity(path);
      if (identity) return identity;
      if (path === `/git/ref/heads/${BASE_BRANCH}`) return { object: { sha: sourceSha } };
      if (path.startsWith("/pulls?") && path.includes("state=open")) return [managed];
      if (path === `/git/ref/heads/${BOT_BRANCH}`) return { object: { sha: headSha } };
      if (path === `/commits/${headSha}`) return commitMetadata(headSha);
      if (path === `/compare/${sourceSha}...${headSha}`) return { files: changedPaths.map((filename) => ({ filename })) };
      if (path.startsWith("/contents/") && path.endsWith(`?ref=${headSha}`)) {
        const relativePath = path.slice("/contents/".length, -(`?ref=${headSha}`).length);
        const bytes = `${artifact.candidate.files[relativePath]}\n`;
        return { type: "file", encoding: "base64", content: Buffer.from(bytes, "utf8").toString("base64") };
      }
      throw new Error(`unexpected modified branch API call: ${method} ${path}`);
    };
    await assert.rejects(() => writeDependencyPullRequest({ root: detachedRoot, artifact, sourceSha, repository: "elsoul/erpc-sdk", api, dispatchCI: false, expectedRunId: 7001, expectedRunAttempt: 1, expectedEventName: "schedule", expectedWorkflowRef: workflowRef }), (error) => error instanceof DependencyMaintenanceError && error.code === "HUMAN_BRANCH_EDIT");
    assert.equal(calls.some((entry) => entry.method === "POST" || entry.method === "PATCH"), false);
  } finally {
    rmSync(detachedRoot, { recursive: true, force: true });
  }
});

