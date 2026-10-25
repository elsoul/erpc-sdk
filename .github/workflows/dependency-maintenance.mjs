#!/usr/bin/env node

/*
 * Bounded five-ecosystem dependency maintenance.
 *
 * The evaluator is deliberately finite.  It asks each native package manager
 * for its own lookup/resolution result, makes only patch/minor candidates, and
 * writes a source-bound JSON observation.  The writer accepts that observation
 * as data only; it never executes a candidate file or workflow.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "../..");

export const WORKFLOW_PATH = ".github/workflows/dependency-maintenance.yml";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const BOT_BRANCH = "codex/dependency-maintenance";
export const BASE_BRANCH = "main";
export const BOT_BRANCH_REF = `refs/heads/${BOT_BRANCH}`;
export const SOURCE_REF = "refs/heads/main";
export const MANAGED_BY = "erpc-sdk-dependency-maintenance";
export const OBSERVATION_KIND = "erpc-sdk-dependency-maintenance-observation";
export const OBSERVATION_SCHEMA_VERSION = 1;
export const SCAN_RECEIPT_KIND = "erpc-sdk-dependency-maintenance-scan-receipt";
export const SCAN_RECEIPT_SCHEMA_VERSION = 1;
export const SCAN_RECEIPT_FILENAME = "dependency-observation.receipt.json";
export const SCANNED_OBSERVATION_FILENAME = "dependency-observation.scanned.json";
export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_WRAPPER_PATH = "scripts/run-gitleaks.sh";
export const GITLEAKS_CONFIG_PATH = ".gitleaks.toml";
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 120_000;
export const MAX_SCAN_STRINGS = 100_000;

export const CANDIDATE_PATHS = Object.freeze([
  "package.json",
  "packages/typescript/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "packages/rust/Cargo.toml",
  "Cargo.lock",
  "packages/python/pyproject.toml",
  "packages/go/go.mod",
  "packages/go/go.sum",
  "packages/ruby/erpc-sdk.gemspec",
  "packages/ruby/Gemfile.lock",
]);
const CANDIDATE_PATH_SET = new Set(CANDIDATE_PATHS);
const LOCK_PATHS = new Set([
  "pnpm-lock.yaml",
  "Cargo.lock",
  "packages/go/go.sum",
  "packages/ruby/Gemfile.lock",
]);

export const ECOSYSTEMS = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
export const RUNTIME_FLOORS = Object.freeze({
  typescript: { sdkNode: ">=20", workspaceNode: ">=22.13", pnpm: "11.24.0" },
  rust: { rust: "1.85", edition: "2024" },
  python: { python: ">=3.11" },
  go: { go: "1.22", toolchain: "local" },
  ruby: { ruby: ">=3.1", bundler: "2.4.20" },
});

const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const VERSION_RE = /(?:^|[^0-9])v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?/u;
const SENSITIVE_ENV_RE = /(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_|COREPACK_.*TOKEN|PYPI|PIP_(?:INDEX|EXTRA_INDEX|TRUSTED)|TWINE|GEM_HOST_API_KEY|BUNDLE_USER|BUNDLER_|CARGO_(?:REGISTR(?:Y|IES)|HTTP).*TOKEN|CRATES_IO_TOKEN|RUBYGEMS_API_KEY|ACTIONS_(?:ID_TOKEN|RUNTIME_TOKEN)|OIDC|COSIGN|SIGNING_KEY|PUBLISHER)/iu;
const TRUSTED_PARSER_SOURCE = String.raw`import json, sys, tomllib
import yaml

if yaml.__version__ != "6.0.3":
    raise RuntimeError("unexpected PyYAML version")

class NoDuplicateSafeLoader(yaml.SafeLoader):
    pass

def construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValueError("duplicate YAML mapping key")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping

NoDuplicateSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
request = json.load(sys.stdin)
result = {"toml": {}, "yaml": {}}
for path, text in request.get("toml", {}).items():
    value = tomllib.loads(text)
    if not isinstance(value, dict):
        raise ValueError("TOML root must be a mapping")
    result["toml"][path] = value
for path, text in request.get("yaml", {}).items():
    value = yaml.load(text, Loader=NoDuplicateSafeLoader)
    if not isinstance(value, dict):
        raise ValueError("YAML root must be a mapping")
    result["yaml"][path] = value
json.dump(result, sys.stdout, separators=(",", ":"))`;

export class DependencyMaintenanceError extends Error {
  constructor(message, code = "DEPENDENCY_MAINTENANCE_INVALID") {
    super(message);
    this.name = "DependencyMaintenanceError";
    this.code = code;
  }
}

function fail(message, code = "DEPENDENCY_MAINTENANCE_INVALID") {
  throw new DependencyMaintenanceError(message, code);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`, "INPUT_INVALID");
  return value;
}

export function requireSha(value, label = "SHA") {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${label} must be a 40-character lowercase commit SHA`, "SOURCE_INVALID");
  return value;
}

export function requireDigest(value, label = "digest") {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`, "ARTIFACT_INVALID");
  return value;
}

export function safeRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || isAbsolute(value)) fail(`${label} is not a safe repository-relative path`, "PATH_INVALID");
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) fail(`${label} contains a traversal segment`, "PATH_INVALID");
  return value;
}

function pathInRoot(root, value, label = "path") {
  const relativePath = safeRelativePath(value, label);
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const targetRelative = relative(base, target).split(sep).join("/");
  if (targetRelative !== relativePath || targetRelative.startsWith("../") || isAbsolute(targetRelative)) fail(`${label} escapes the repository`, "PATH_INVALID");
  return target;
}

function readRegularText(root, relativePath, label = relativePath) {
  const target = pathInRoot(root, relativePath, label);
  let link;
  let stat;
  try {
    link = lstatSync(target);
    stat = statSync(target);
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`, "SOURCE_INVALID");
  }
  if (link.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`, "SOURCE_INVALID");
  try { return readFileSync(target, "utf8"); } catch (error) { fail(`cannot read ${label}: ${error.message}`, "SOURCE_INVALID"); }
}

export function readCandidateFiles(root = REPOSITORY_ROOT) {
  const files = {};
  for (const relativePath of CANDIDATE_PATHS) files[relativePath] = readRegularText(root, relativePath);
  return files;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function hashFiles(files) {
  const hash = createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    safeRelativePath(relativePath);
    if (typeof files[relativePath] !== "string") fail(`candidate file ${relativePath} must contain text`, "ARTIFACT_INVALID");
    hash.update(relativePath, "utf8").update("\0", "utf8").update(files[relativePath], "utf8").update("\0", "utf8");
  }
  return hash.digest("hex");
}

function changedPaths(before, after) {
  return Object.keys(after).filter((relativePath) => before[relativePath] !== after[relativePath]).sort();
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`, "LOOKUP_INVALID"); }
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[-+]/u.test(trimmed) || /(?:^|[-])(?:alpha|beta|rc|dev|pre|next|canary)/iu.test(trimmed)) return null;
  const match = trimmed.match(VERSION_RE);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return Object.freeze({ major, minor, patch, text: `${major}.${minor}.${patch}` });
}

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/gu, "://[REDACTED]@")
    .replace(/((?:token|password|secret|authorization|api[_-]?key)[=:])[^\s&,;]+/giu, "$1[REDACTED]")
    .slice(0, 4096);
}

export function classifyUpdate(current, next) {
  const oldVersion = parseVersion(current);
  const newVersion = parseVersion(next);
  if (!oldVersion || !newVersion) return "unparseable";
  if (newVersion.major === oldVersion.major && newVersion.minor === oldVersion.minor && newVersion.patch === oldVersion.patch) return "none";
  if (newVersion.major < oldVersion.major || (newVersion.major === oldVersion.major && newVersion.minor < oldVersion.minor) || (newVersion.major === oldVersion.major && newVersion.minor === oldVersion.minor && newVersion.patch < oldVersion.patch)) return "downgrade";
  if (newVersion.major !== oldVersion.major) return "major";
  if (oldVersion.major === 0 && newVersion.minor !== oldVersion.minor) return "pre1-minor";
  if (newVersion.minor !== oldVersion.minor) return "minor";
  return "patch";
}

export function isEligibleClassification(classification) {
  return classification === "patch" || classification === "minor";
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function goRuntimeCompatibility(info) {
  if (!Object.hasOwn(info ?? {}, "GoVersion")) return { known: false, compatible: true };
  const required = parseVersion(info.GoVersion);
  const floor = parseVersion(`${RUNTIME_FLOORS.go.go}.0`);
  if (!required || !floor) return { known: true, compatible: false, error: `invalid GoVersion ${String(info.GoVersion)}` };
  return {
    known: true,
    compatible: compareVersions(required.text, floor.text) <= 0,
    required: required.text,
    floor: floor.text,
  };
}

function commandResult(command, args, options = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const result = runner(command, args, options);
  if (!result || typeof result !== "object") fail(`${command} runner returned an invalid result`, "COMMAND_INVALID");
  return {
    command,
    args,
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ?? null,
  };
}

export function defaultCommandRunner(command, args, { cwd, env = process.env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function trustedParseLockData(files, options = {}) {
  const payload = JSON.stringify(files);
  if (Buffer.byteLength(payload, "utf8") > 2 * 1024 * 1024) fail("trusted parser input exceeds its bound", "PARSER_INVALID");
  const result = spawnSync("python3", ["-I", "-c", TRUSTED_PARSER_SOURCE], {
    cwd: tmpdir(),
    env: sanitizeEvaluatorEnvironment(options.env ?? process.env),
    input: payload,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail(`trusted TOML/YAML parser failed: ${redactDiagnostic(result.stderr || result.error?.message)}`, "PARSER_INVALID");
  if (Buffer.byteLength(result.stdout ?? "", "utf8") > 4 * 1024 * 1024) fail("trusted parser output exceeds its bound", "PARSER_INVALID");
  return parseJson(result.stdout, "trusted parser output");
}

export function sanitizeEvaluatorEnvironment(input = process.env) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_ENV_RE.test(key)) continue;
    output[key] = value;
  }
  return output;
}

function nativeOptions(root, options = {}, extraEnv = {}) {
  return {
    cwd: root,
    runner: options.runner,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    env: { ...sanitizeEvaluatorEnvironment(options.env ?? process.env), ...extraEnv },
  };
}

function parsePnpmOutdated(stdout) {
  const data = parseJson(stdout.trim(), "pnpm outdated output");
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("pnpm outdated output must be an object", "LOOKUP_INVALID");
  return Object.entries(data).map(([name, row]) => ({
    name,
    current: row?.current ?? row?.installed ?? null,
    wanted: row?.wanted ?? null,
    latest: row?.latest ?? null,
    dependencyType: row?.dependencyType ?? null,
  }));
}

export function parsePnpmInventory(stdout) {
  const data = parseJson(stdout.trim(), "pnpm lockfile inventory");
  if (!Array.isArray(data)) fail("pnpm lockfile inventory must be an array", "LOOKUP_INVALID");
  const versions = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, entry] of Object.entries(value[section] ?? {})) {
        const version = parseVersion(entry?.version);
        if (version) versions.set(name, version.text);
        visit(entry);
      }
    }
    for (const child of Array.isArray(value) ? value : []) visit(child);
  };
  visit(data);
  return versions;
}

function packageDeclarations(root) {
  const declarations = new Map();
  for (const relativePath of ["package.json", "packages/typescript/package.json"]) {
    const value = parseJson(readRegularText(root, relativePath), relativePath);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(value[section] ?? {})) declarations.set(name, { relativePath, section, spec });
    }
  }
  const workspace = readRegularText(root, "pnpm-workspace.yaml");
  const override = workspace.match(/^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*([^\s#]+)\s*$/mu);
  if (override) declarations.set("esbuild", { relativePath: "pnpm-workspace.yaml", section: "overrides", spec: override[1] });
  return declarations;
}

function npmTarget(row, declaration) {
  if (!declaration) return null;
  const wanted = parseVersion(row.wanted);
  const latest = parseVersion(row.latest);
  const current = parseVersion(row.current);
  if (!current) return null;
  if (wanted && compareVersions(wanted.text, current.text) > 0) return wanted.text;
  const spec = String(declaration.spec).trim();
  if (latest && compareVersions(latest.text, current.text) > 0 && /^(?:v?\d+\.\d+(?:\.\d+)?)$/u.test(spec)) return latest.text;
  return null;
}

function preserveNpmOperator(spec, target) {
  const source = String(spec).trim();
  if (/^\^/u.test(source)) return `^${target}`;
  if (/^~/u.test(source)) return `~${target}`;
  if (/^=/u.test(source)) return `=${target}`;
  if (/^(?:v?\d+\.\d+(?:\.\d+)?)$/u.test(source)) return target;
  return source;
}

function writeJsonFile(root, relativePath, value) {
  writeFileSync(pathInRoot(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
}

function snapshotPaths(root, paths) {
  return Object.fromEntries(paths.map((relativePath) => [relativePath, readRegularText(root, relativePath)]));
}

function restorePaths(root, files) {
  for (const [relativePath, text] of Object.entries(files)) writeFileSync(pathInRoot(root, relativePath), text, { flag: "w" });
}

function updateNpmDeclaration(root, declaration, name, target) {
  if (declaration.relativePath === "pnpm-workspace.yaml") {
    const pathValue = pathInRoot(root, declaration.relativePath);
    const source = readFileSync(pathValue, "utf8");
    const replacement = source.replace(/(^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*)([^\s#]+)(\s*$)/mu, `$1${target}$3`);
    if (replacement === source) fail("esbuild override declaration could not be updated", "RESOLUTION_FAILED");
    writeFileSync(pathValue, replacement, { flag: "w" });
    return;
  }
  const value = parseJson(readRegularText(root, declaration.relativePath), declaration.relativePath);
  value[declaration.section][name] = preserveNpmOperator(declaration.spec, target);
  writeJsonFile(root, declaration.relativePath, value);
}

function resolvePnpmCompatibleTarget(root, declaration, options) {
  const originals = snapshotPaths(root, ["package.json", "packages/typescript/package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
  const dependencyName = declaration.relativePath === "pnpm-workspace.yaml" ? "esbuild" : Object.entries(parseJson(readRegularText(root, declaration.relativePath), declaration.relativePath)[declaration.section] ?? {}).find(([, spec]) => spec === declaration.spec)?.[0];
  try {
    const current = parseVersion(declaration.spec)?.text;
    if (!current) return null;
    if (!dependencyName) return null;
    if (declaration.relativePath === "pnpm-workspace.yaml") updateNpmDeclaration(root, declaration, dependencyName, `^${current}`);
    else {
      const manifest = parseJson(readRegularText(root, declaration.relativePath), declaration.relativePath);
      manifest[declaration.section][dependencyName] = `^${current}`;
      writeJsonFile(root, declaration.relativePath, manifest);
    }
    const update = commandResult("corepack", ["pnpm", "update", "--recursive", "--ignore-scripts", "--no-save", "--reporter=append-only", dependencyName], nativeOptions(root, options));
    if (update.status !== 0) throw new DependencyMaintenanceError(redactDiagnostic(update.stderr || update.stdout || "pnpm compatible resolution failed"), "RESOLUTION_FAILED");
    const inventory = commandResult("corepack", ["pnpm", "list", "--recursive", "--lockfile-only", "--json", "--no-color"], nativeOptions(root, options));
    if (inventory.status !== 0) throw new DependencyMaintenanceError(inventory.stderr || "pnpm compatible inventory failed", "RESOLUTION_FAILED");
    return parsePnpmInventory(inventory.stdout).get(dependencyName) ?? null;
  } finally {
    restorePaths(root, originals);
  }
}

function parseCargoLock(text) {
  const result = new Map();
  const sections = text.split(/^\[\[package\]\]\s*$/mu).slice(1);
  for (const section of sections) {
    const name = section.match(/^name\s*=\s*"([^"]+)"/mu)?.[1];
    const version = section.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
    if (name && version) result.set(name, version);
  }
  return result;
}

function parseCargoLockRecords(text) {
  return text.split(/^\[\[package\]\]\s*$/mu).slice(1).map((section) => ({
    name: section.match(/^name\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    version: section.match(/^version\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    source: section.match(/^source\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    checksum: section.match(/^checksum\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
  })).filter((record) => record.name && record.version);
}

function parseCargoDeclarations(text) {
  const declarations = [];
  let section = "";
  for (const line of text.split(/\r?\n/u)) {
    const heading = line.match(/^\[([^\]]+)\]/u)?.[1] ?? null;
    if (heading) section = heading;
    if (!["dependencies", "dev-dependencies"].includes(section)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
    if (!match) continue;
    const value = match[2];
    const version = value.match(/version\s*=\s*"([^"]+)"/u)?.[1] ?? value.match(/^"([^"]+)"/u)?.[1] ?? null;
    if (version) declarations.push({ name: match[1], section, line, spec: version, exact: version.startsWith("=") });
  }
  return declarations;
}

function parseCargoSearch(stdout, name) {
  const match = stdout.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=\\s*"([^"]+)"`, "mu"));
  if (!match) fail(`cargo search did not return ${name}`, "LOOKUP_INVALID");
  return match[1];
}

function relaxCargoExactPins(root, declarations) {
  const file = pathInRoot(root, "packages/rust/Cargo.toml");
  let source = readFileSync(file, "utf8");
  for (const declaration of declarations) {
    if (!declaration.exact || declaration.name === "yoke-derive") continue;
    const relaxed = declaration.spec.slice(1);
    source = source.replace(declaration.line, declaration.line.replace(`"${declaration.spec}"`, `"${relaxed}"`));
  }
  writeFileSync(file, source, { flag: "w" });
}

function updateCargoExactPin(root, declaration, target) {
  const file = pathInRoot(root, "packages/rust/Cargo.toml");
  const source = readFileSync(file, "utf8");
  const expected = declaration.line.replace(`"${declaration.spec}"`, `"=${target}"`);
  const current = source.split(/\r?\n/u).find((line) => line.startsWith(`${declaration.name} =`));
  if (!current) fail(`Cargo dependency ${declaration.name} declaration moved before update`, "RESOLUTION_FAILED");
  writeFileSync(file, `${source.replace(current, expected)}`, { flag: "w" });
}

function parseJsonStream(text, label) {
  const values = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{" && depth === 0) start = index;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(parseJson(text.slice(start, index + 1), label));
        start = -1;
      }
    }
  }
  if (depth !== 0 || values.length === 0) fail(`${label} did not contain a complete JSON stream`, "LOOKUP_INVALID");
  return values;
}

export function parsePythonRequirements(text) {
  const requirements = [];
  let inArray = false;
  let section = "";
  let arrayName = "";
  for (const line of text.split(/\r?\n/u)) {
    const arrayStart = line.match(/^\s*(requires|dependencies|dev)\s*=\s*\[/u);
    if (arrayStart) { inArray = true; arrayName = arrayStart[1]; section = arrayName === "requires" ? "build-system" : arrayName; }
    if (!inArray) continue;
    const values = line.matchAll(/["']([^"']+)["']/gu);
    for (const match of values) {
      const value = match[1];
      const name = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/u)?.[1];
      if (name) requirements.push({ name, spec: value, section, raw: match[0] });
    }
    if (line.includes("]")) { inArray = false; arrayName = ""; section = ""; }
  }
  return requirements;
}

function pythonRequirementVersion(spec) {
  return String(spec).match(/(?:^|[<>=~! ])v?(\d+(?:\.\d+){1,2})/u)?.[1] ?? null;
}

export function pythonRequirementComparator(spec) {
  return String(spec).match(/^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?\s*(===|==|~=|>=|<=|>|<)/u)?.[1] ?? null;
}

function preservePythonOperator(spec, target) {
  const source = String(spec);
  const match = source.match(/^(.*?)(===|==|~=|>=|<=|>|<)\s*v?\d+(?:\.\d+){1,2}(.*)$/u);
  if (!match) return null;
  return `${match[1]}${match[2]}${target}${match[3]}`;
}

function updatePythonDeclaration(root, requirement, target) {
  const file = pathInRoot(root, "packages/python/pyproject.toml");
  const source = readFileSync(file, "utf8");
  const nextSpec = preservePythonOperator(requirement.spec, target);
  if (!nextSpec) fail(`Python dependency ${requirement.name} has an unsupported declaration`, "CANDIDATE_INVARIANT");
  const oldLiteral = requirement.raw;
  const quote = oldLiteral[0];
  const newLiteral = `${quote}${nextSpec}${quote}`;
  const index = source.indexOf(oldLiteral);
  if (index < 0) fail(`Python dependency ${requirement.name} declaration moved before update`, "RESOLUTION_FAILED");
  writeFileSync(file, `${source.slice(0, index)}${newLiteral}${source.slice(index + oldLiteral.length)}`, { flag: "w" });
}

function pipReportVersions(reportFile) {
  const report = parseJson(readFileSync(reportFile, "utf8"), "pip resolver report");
  const versions = new Map();
  for (const item of report.install ?? []) {
    const name = item.metadata?.name ?? item.metadata?.Name;
    if (name && item.metadata?.version) versions.set(name.toLowerCase().replaceAll("_", "-"), item.metadata.version);
  }
  return versions;
}

export function relaxPythonExactSpec(spec) {
  const current = pythonRequirementVersion(spec);
  if (!current || !["===", "=="].includes(pythonRequirementComparator(spec))) return spec;
  const version = parseVersion(current);
  if (!version) return spec;
  const upper = version.major === 0 ? `0.${version.minor + 1}` : `${version.major + 1}`;
  return spec.replace(/^(.*?)(?:===|==)\s*v?\d+(?:\.\d+){1,2}/u, `$1>=${current},<${upper}`);
}

export function parseGemOutdated(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*([^\s(]+)\s+\(newest\s+([^,\s]+),\s+installed\s+([^,\s]+)(?:,\s+requested\s+[^)]*)?\)\s*$/u);
    if (match) rows.push({ name: match[1], latest: match[2], current: match[3] });
  }
  return rows;
}

function parseRubyLockInventory(text) {
  const inventory = new Map();
  let inGemSpecs = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line === "GEM") { inGemSpecs = true; continue; }
    if (inGemSpecs && /^(?:PATH|GIT|PLATFORMS|DEPENDENCIES|BUNDLED WITH)$/u.test(line)) { inGemSpecs = false; continue; }
    if (!inGemSpecs) continue;
    const match = line.match(/^    ([^\s(]+) \(([^)]+)\)$/u);
    if (match) inventory.set(match[1], match[2]);
  }
  return inventory;
}

function parseDirectGoModules(text) {
  const direct = new Set();
  let inRequire = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^require\s*\(/u.test(line)) { inRequire = true; continue; }
    if (inRequire && line.trim() === ")") { inRequire = false; continue; }
    if (!inRequire && !/^require\s+/u.test(line)) continue;
    const match = (inRequire ? line : line.replace(/^require\s+/u, "")).match(/^\s*([^\s]+)\s+v?\d/u);
    if (match) direct.add(match[1]);
  }
  return direct;
}

function packageLookupResult(name, current, latest, extra = {}) {
  const classification = classifyUpdate(current, latest);
  const status = classification === "none" ? "no-update" : isEligibleClassification(classification) ? "eligible" : classification === "unparseable" ? "lookup-failed" : "manual-review";
  return { name, current: current ?? null, latest: latest ?? null, classification, status, ...extra };
}

function failureResult(name, status, error, command = null) {
  return { name, current: null, latest: null, classification: "unparseable", status, lookupFailed: status === "lookup-failed", error: redactDiagnostic(error?.message ?? error), command };
}

export function evaluateTypescript(root, options) {
  const inventory = commandResult("corepack", ["pnpm", "list", "--recursive", "--depth", "0", "--lockfile-only", "--json", "--no-color"], nativeOptions(root, options));
  if (inventory.status !== 0) {
    return { ecosystem: "typescript", status: "lookup-failed", command: inventory, lookupCommands: [inventory], updates: [], observations: [failureResult("pnpm lockfile inventory", "lookup-failed", inventory.error ?? inventory.stderr, inventory.args)] };
  }
  let currentVersions;
  try { currentVersions = parsePnpmInventory(inventory.stdout); } catch (error) {
    return { ecosystem: "typescript", status: "lookup-failed", command: inventory, lookupCommands: [inventory], updates: [], observations: [failureResult("pnpm lockfile inventory", "lookup-failed", error, inventory.args)] };
  }
  const declarations = packageDeclarations(root);
  const latestVersions = new Map();
  const viewCommands = [inventory];
  for (const [name] of declarations) {
    const view = commandResult("corepack", ["pnpm", "view", name, "dist-tags.latest", "--json", "--no-color"], nativeOptions(root, options));
    viewCommands.push(view);
    if (view.status !== 0) return { ecosystem: "typescript", status: "lookup-failed", command: view, lookupCommands: viewCommands, updates: [], observations: [failureResult(name, "lookup-failed", view.error ?? view.stderr, view.args)] };
    try {
      const value = parseJson(view.stdout.trim(), `pnpm latest ${name}`);
      const latest = typeof value === "string" ? value : value?.version ?? value?.latest;
      if (!parseVersion(latest)) fail(`pnpm latest ${name} is not a stable version`, "LOOKUP_INVALID");
      latestVersions.set(name, latest);
    } catch (error) {
      return { ecosystem: "typescript", status: "lookup-failed", command: view, lookupCommands: viewCommands, updates: [], observations: [failureResult(name, "lookup-failed", error, view.args)] };
    }
  }
  const result = commandResult("corepack", ["pnpm", "outdated", "--recursive", "--format", "json", "--no-color"], nativeOptions(root, options));
  if (![0, 1].includes(result.status)) {
    return { ecosystem: "typescript", status: "lookup-failed", command: result, lookupCommands: [...viewCommands, result], updates: [], observations: [failureResult("pnpm", "lookup-failed", result.error ?? result.stderr, result.args)] };
  }
  let rows;
  try { rows = parsePnpmOutdated(result.stdout); } catch (error) {
    return { ecosystem: "typescript", status: "lookup-failed", command: result, lookupCommands: [...viewCommands, result], updates: [], observations: [failureResult("pnpm", "lookup-failed", error)] };
  }
  const observations = [];
  const updates = [];
  const rowsByName = new Map(rows.map((row) => [row.name, row]));
  for (const [name, declaration] of declarations) {
    const row = rowsByName.get(name);
    const overrideCurrent = name === "esbuild" && declaration.section === "overrides" ? parseVersion(declaration.spec)?.text : null;
    const lockVersions = overrideCurrent ? parsePnpmLockVersions(readRegularText(root, "pnpm-lock.yaml")).get(name) : null;
    const current = currentVersions.get(name) ?? (overrideCurrent && lockVersions?.has(overrideCurrent) ? overrideCurrent : null);
    const latest = latestVersions.get(name) ?? null;
    if (!current || !latest) {
      observations.push(failureResult(name, "lookup-failed", "pnpm native inventory omitted a declared dependency"));
      continue;
    }
    const wanted = row?.wanted ?? current;
    let target = null;
    const wantedClassification = classifyUpdate(current, wanted);
    if (isEligibleClassification(wantedClassification)) target = wanted;
    if (!target && classifyUpdate(current, latest) !== "none") {
      try { target = resolvePnpmCompatibleTarget(root, declaration, options); } catch (error) { observations.push(failureResult(name, "resolution-failed", error)); continue; }
    }
    const effective = target ?? latest;
    const classification = classifyUpdate(current, effective);
    const status = classification === "none" ? "no-update" : isEligibleClassification(classification) ? "eligible" : classification === "unparseable" ? "lookup-failed" : "manual-review";
    observations.push({ name, current, wanted, latest, classification, status, dependencyType: row?.dependencyType ?? declaration.section, lookup: target && !row ? "pnpm-compatible-scratch" : "pnpm-outdated" });
    if (target && isEligibleClassification(classification)) updates.push({ name, target, declaration, classification });
  }
  let status = "no-update";
  if (updates.length > 0) {
    const originals = snapshotPaths(root, ["package.json", "packages/typescript/package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
    try {
      for (const update of updates) {
        updateNpmDeclaration(root, update.declaration, update.name, update.target);
      }
      const install = commandResult("corepack", ["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile", "--reporter=append-only"], nativeOptions(root, options));
      if (install.status !== 0) throw new DependencyMaintenanceError(install.stderr || "pnpm lockfile resolution failed", "RESOLUTION_FAILED");
      status = "eligible";
    } catch (error) {
      restorePaths(root, originals);
      return { ecosystem: "typescript", status: "resolution-failed", command: result, lookupCommands: [...viewCommands, result], updates: [], observations, error: redactDiagnostic(error.message ?? error) };
    }
  }
  if (observations.some((observation) => observation.status === "resolution-failed")) status = "resolution-failed";
  else if (observations.some((observation) => observation.status === "lookup-failed")) status = "lookup-failed";
  return { ecosystem: "typescript", status, command: result, lookupCommands: [...viewCommands, result], updates, observations };
}

function evaluateRust(root, options) {
  const original = snapshotPaths(root, ["packages/rust/Cargo.toml", "Cargo.lock"]);
  const beforeManifest = original["packages/rust/Cargo.toml"];
  const beforePackages = parseCargoLock(original["Cargo.lock"]);
  const declarations = parseCargoDeclarations(beforeManifest);
  const observations = [];
  const latestByName = new Map();
  for (const declaration of declarations) {
    const search = commandResult("cargo", ["search", "--limit", "1", declaration.name], nativeOptions(root, options, { CARGO_TERM_COLOR: "never", RUSTUP_TOOLCHAIN: "1.85.0" }));
    if (search.status !== 0) {
      restorePaths(root, original);
      return { ecosystem: "rust", status: "lookup-failed", command: search, updates: [], observations: [...observations, failureResult(declaration.name, "lookup-failed", search.error ?? search.stderr, search.args)] };
    }
    let latest;
    try { latest = parseCargoSearch(search.stdout, declaration.name); } catch (error) {
      restorePaths(root, original);
      return { ecosystem: "rust", status: "lookup-failed", command: search, updates: [], observations: [...observations, failureResult(declaration.name, "lookup-failed", error, search.args)] };
    }
    latestByName.set(declaration.name, latest);
    const current = beforePackages.get(declaration.name) ?? declaration.spec.replace(/^=/u, "");
    const lookup = packageLookupResult(declaration.name, current, latest, { direct: true, declared: declaration.spec, hold: declaration.name === "yoke-derive" ? "msrv" : null });
    if (declaration.name === "yoke-derive") lookup.status = "manual-review";
    observations.push(lookup);
  }
  relaxCargoExactPins(root, declarations);
  const result = commandResult("cargo", ["update"], nativeOptions(root, options, { CARGO_TERM_COLOR: "never", RUSTUP_TOOLCHAIN: "1.85.0" }));
  if (result.status !== 0) {
    restorePaths(root, original);
    return { ecosystem: "rust", status: "resolution-failed", command: result, updates: [], observations, error: redactDiagnostic(result.error ?? result.stderr) };
  }
  const afterPackages = parseCargoLock(readRegularText(root, "Cargo.lock"));
  const updates = [];
  for (const [name, next] of afterPackages) {
    const current = beforePackages.get(name);
    if (!current || current === next) continue;
    const existing = observations.find((observation) => observation.name === name);
    const observation = existing ?? packageLookupResult(name, current, next, { direct: false });
    observation.resolved = next;
    observation.resolvedClassification = classifyUpdate(current, next);
    if (!isEligibleClassification(observation.resolvedClassification) || name === "yoke-derive") {
      restorePaths(root, original);
      return { ecosystem: "rust", status: observation.resolvedClassification === "unparseable" ? "lookup-failed" : "manual-review", command: result, updates: [], observations, withheld: name };
    }
    if (!existing) observations.push(observation);
    updates.push({ name, target: next, classification: observation.resolvedClassification });
  }
  for (const declaration of declarations) {
    if (!declaration.exact) continue;
    const update = updates.find((candidate) => candidate.name === declaration.name);
    const target = update?.target ?? beforePackages.get(declaration.name) ?? declaration.spec.replace(/^=/u, "");
    updateCargoExactPin(root, declaration, target);
  }
  const yoke = readRegularText(root, "packages/rust/Cargo.toml").match(/^yoke-derive\s*=\s*"([^"]+)"/mu)?.[1];
  if (yoke !== "=0.8.2" || beforePackages.get("yoke-derive") !== afterPackages.get("yoke-derive")) {
    restorePaths(root, original);
    fail("Rust yoke-derive hold changed", "FLOOR_DRIFT");
  }
  const metadata = commandResult("cargo", ["metadata", "--locked", "--format-version", "1"], nativeOptions(root, options, { CARGO_TERM_COLOR: "never", RUSTUP_TOOLCHAIN: "1.85.0" }));
  if (metadata.status !== 0) {
    restorePaths(root, original);
    return { ecosystem: "rust", status: "resolution-failed", command: metadata, updates: [], observations, error: redactDiagnostic(metadata.error ?? metadata.stderr) };
  }
  const status = updates.length > 0 ? "eligible" : observations.some((observation) => observation.status === "lookup-failed") ? "lookup-failed" : observations.some((observation) => observation.status === "manual-review") ? "manual-review" : "no-update";
  return { ecosystem: "rust", status, command: result, updates, observations };
}

export function evaluatePython(root, options) {
  const pyproject = readRegularText(root, "packages/python/pyproject.toml");
  const requirements = parsePythonRequirements(pyproject);
  const observations = [];
  const lookupResults = [];
  for (const requirement of requirements) {
    const result = commandResult("python3", ["-m", "pip", "index", "versions", requirement.name, "--json", "--python-version", "3.11", "--disable-pip-version-check", "--no-input"], nativeOptions(join(root, "packages/python"), options));
    if (result.status !== 0) {
      observations.push(failureResult(requirement.name, "lookup-failed", result.error ?? result.stderr, result.args));
      continue;
    }
    let data;
    try { data = parseJson(result.stdout.trim(), `pip index ${requirement.name}`); } catch (error) {
      observations.push(failureResult(requirement.name, "lookup-failed", error, result.args));
      continue;
    }
    const latest = data.latest ?? data.versions?.find((version) => parseVersion(version)) ?? null;
    const current = pythonRequirementVersion(requirement.spec);
    const observation = packageLookupResult(requirement.name, current, latest, { declared: requirement.spec, lookup: "pip-index-json", rawVersions: Array.isArray(data.versions) ? data.versions.slice(0, 32) : [] });
    observations.push(observation);
    lookupResults.push({ requirement, latest });
  }
  const requirementFile = join(mkdtempSync(join(tmpdir(), "erpc-python-requirements-")), "requirements.txt");
  writeFileSync(requirementFile, `${requirements.map((requirement) => requirement.spec).join("\n")}\n`, { flag: "w" });
  const reportFile = `${requirementFile}.report.json`;
  const resolution = commandResult("python3", ["-m", "pip", "install", "--dry-run", "--ignore-installed", "--only-binary", ":all:", "--disable-pip-version-check", "--no-input", "--report", reportFile, "-r", requirementFile], nativeOptions(join(root, "packages/python"), options));
  let status = observations.some((observation) => observation.status === "lookup-failed") ? "lookup-failed" : "no-update";
  let selectedVersions = new Map();
  if (resolution.status !== 0) status = "resolution-failed";
  else {
    try {
      selectedVersions = pipReportVersions(reportFile);
      for (const requirement of requirements) {
        const selected = selectedVersions.get(requirement.name.toLowerCase().replaceAll("_", "-"));
        if (!selected) throw new Error(`pip report omitted ${requirement.name}`);
        const observation = observations.find((entry) => entry.name.toLowerCase().replaceAll("_", "-") === requirement.name.toLowerCase().replaceAll("_", "-"));
        if (observation) observation.current = selected;
      }
    } catch (error) {
      status = "resolution-failed";
      observations.push(failureResult("pip resolver", "resolution-failed", error));
    }
    const exactCandidates = requirements.filter((requirement) => ["===", "=="].includes(pythonRequirementComparator(requirement.spec)) && observations.find((observation) => observation.name.toLowerCase().replaceAll("_", "-") === requirement.name.toLowerCase().replaceAll("_", "-") && observation.latest && classifyUpdate(observation.current, observation.latest) !== "none" && classifyUpdate(observation.current, observation.latest) !== "unparseable"));
    if (status !== "resolution-failed" && exactCandidates.length > 0) {
      const candidateFile = `${requirementFile}.candidate`;
      writeFileSync(candidateFile, `${requirements.map((requirement) => `${exactCandidates.includes(requirement) ? relaxPythonExactSpec(requirement.spec) : requirement.spec}`).join("\n")}\n`, { flag: "w" });
      const candidateReport = `${candidateFile}.report.json`;
      const candidateResolution = commandResult("python3", ["-m", "pip", "install", "--dry-run", "--ignore-installed", "--only-binary", ":all:", "--disable-pip-version-check", "--no-input", "--report", candidateReport, "-r", candidateFile], nativeOptions(join(root, "packages/python"), options));
      if (candidateResolution.status !== 0) status = "resolution-failed";
      else {
        try { selectedVersions = pipReportVersions(candidateReport); } catch (error) { status = "resolution-failed"; observations.push(failureResult("pip candidate resolver", "resolution-failed", error)); }
      }
    }
    for (const observation of observations) {
      const selected = selectedVersions.get(observation.name.toLowerCase().replaceAll("_", "-"));
      const effective = selected ?? observation.latest;
      observation.selected = selected ?? null;
      observation.selectedClassification = classifyUpdate(observation.current, effective);
      observation.latestClassification = classifyUpdate(observation.current, observation.latest);
      if (observation.status === "lookup-failed" && (!selected || observation.lookupFailed || !observation.latest)) continue;
      if (observation.selectedClassification === "unparseable") observation.status = "lookup-failed";
      else if (isEligibleClassification(observation.selectedClassification)) observation.status = ["===", "=="].includes(pythonRequirementComparator(requirements.find((entry) => entry.name.toLowerCase().replaceAll("_", "-") === observation.name.toLowerCase().replaceAll("_", "-"))?.spec ?? "")) ? "eligible" : "compatible";
      else if (observation.selectedClassification === "none" && ["major", "pre1-minor"].includes(observation.latestClassification)) observation.status = "manual-review";
      else if (observation.selectedClassification === "none") observation.status = "no-update";
      else observation.status = "manual-review";
    }
    if (status !== "resolution-failed" && observations.some((observation) => observation.status === "lookup-failed")) status = "lookup-failed";
    else if (status !== "resolution-failed" && observations.some((observation) => observation.status === "eligible")) status = "eligible";
    else if (status !== "resolution-failed" && observations.some((observation) => observation.status === "manual-review")) status = "manual-review";
    else if (status !== "resolution-failed") status = "no-update";
  }
  const originals = snapshotPaths(root, ["packages/python/pyproject.toml"]);
  const updates = [];
  if (status === "eligible") {
    try {
      for (const observation of observations) {
        if (observation.status !== "eligible" || !observation.selected) continue;
        const requirement = requirements.find((entry) => entry.name.toLowerCase().replaceAll("_", "-") === observation.name.toLowerCase().replaceAll("_", "-"));
        if (!requirement) continue;
        if (!["===", "=="].includes(pythonRequirementComparator(requirement.spec))) continue;
        updatePythonDeclaration(root, requirement, observation.selected);
        updates.push({ name: requirement.name, target: observation.selected, classification: observation.selectedClassification });
      }
    } catch (error) {
      restorePaths(root, originals);
      return { ecosystem: "python", status: "resolution-failed", command: resolution, updates: [], observations, error: redactDiagnostic(error.message ?? error) };
    }
  }
  try { rmSync(dirname(requirementFile), { recursive: true, force: true }); } catch { /* bounded temporary cleanup */ }
  return { ecosystem: "python", status, command: resolution, lookupCommand: "python -m pip index versions --json --python-version 3.11", updates, observations, error: resolution.status === 0 ? null : redactDiagnostic(resolution.stderr || resolution.error?.message) };
}

function evaluateGo(root, options) {
  const goRoot = join(root, "packages/go");
  const originals = snapshotPaths(root, ["packages/go/go.mod", "packages/go/go.sum"]);
  const source = readRegularText(root, "packages/go/go.mod");
  const direct = parseDirectGoModules(source);
  const result = commandResult("go", ["list", "-m", "-u", "-json", "all"], nativeOptions(goRoot, options, { GOTOOLCHAIN: "local" }));
  if (result.status !== 0) return { ecosystem: "go", status: "lookup-failed", command: result, updates: [], observations: [failureResult("go list", "lookup-failed", result.error ?? result.stderr)] };
  const lookupCommands = [result];
  let rows;
  try { rows = parseJsonStream(result.stdout, "go list -m output"); } catch (error) { return { ecosystem: "go", status: "lookup-failed", command: result, updates: [], observations: [failureResult("go list", "lookup-failed", error)] }; }
  const observations = [];
  const updates = [];
  const rowsByPath = new Map(rows.filter((row) => row.Path).map((row) => [row.Path, row]));
  if (rowsByPath.size === 0) return { ecosystem: "go", status: "lookup-failed", command: result, updates: [], observations: [failureResult("go inventory", "lookup-failed", "go list returned no modules")] };
  for (const row of rows) {
    if (!row.Version || !row.Path) continue;
    const observation = row.Update?.Version
      ? packageLookupResult(row.Path, row.Version, row.Update.Version, { direct: direct.has(row.Path), indirect: Boolean(row.Indirect) })
      : { name: row.Path, current: row.Version, latest: row.Version, classification: "none", status: "no-update", direct: direct.has(row.Path), indirect: Boolean(row.Indirect), lookup: "go-list-lock-inventory" };
    observations.push(observation);
  }
  for (const module of direct) {
    const row = rowsByPath.get(module);
    if (!row?.Version) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: result, updates: [], observations, error: `go inventory omitted direct module ${module}` };
    }
    const currentVersion = parseVersion(row.Version);
    if (!currentVersion) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: result, updates: [], observations, error: `go direct module ${module} has an unparseable version` };
    }
    const selector = currentVersion.major === 0 ? `v0.${currentVersion.minor}` : `v${currentVersion.major}`;
    const lookup = commandResult("go", ["list", "-m", "-json", `${module}@${selector}`], nativeOptions(goRoot, options, { GOTOOLCHAIN: "local" }));
    lookupCommands.push(lookup);
    if (lookup.status !== 0) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: lookup, lookupCommands, updates: [], observations, error: redactDiagnostic(lookup.error ?? lookup.stderr) };
    }
    let selectedInfo;
    try { selectedInfo = parseJson(lookup.stdout.trim(), `go module ${module}`); } catch (error) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: lookup, lookupCommands, updates: [], observations, error: redactDiagnostic(error.message ?? error) };
    }
    let selected = selectedInfo.Version;
    let selectionLookup = lookup;
    const runtime = goRuntimeCompatibility(selectedInfo);
    if (runtime.error) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: result, lookupCommands, updates: [], observations, error: runtime.error };
    }
    if (!runtime.compatible) {
      const compatibleSelector = `v${currentVersion.major}.${currentVersion.minor}`;
      if (compatibleSelector === selector) {
        restorePaths(root, originals);
        return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: runtime.error ?? `${module}@${selected} requires Go ${runtime.required}, above the ${runtime.floor} runtime floor` };
      }
      const compatibleLookup = commandResult("go", ["list", "-m", "-json", `${module}@${compatibleSelector}`], nativeOptions(goRoot, options, { GOTOOLCHAIN: "local" }));
      lookupCommands.push(compatibleLookup);
      if (compatibleLookup.status !== 0) {
        restorePaths(root, originals);
        return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: redactDiagnostic(compatibleLookup.error ?? compatibleLookup.stderr ?? "compatible Go module lookup failed") };
      }
      try { selectedInfo = parseJson(compatibleLookup.stdout.trim(), `compatible Go module ${module}`); } catch (error) {
        restorePaths(root, originals);
        return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: redactDiagnostic(error.message ?? error) };
      }
      const compatibleRuntime = goRuntimeCompatibility(selectedInfo);
      if (compatibleRuntime.error) {
        restorePaths(root, originals);
        return { ecosystem: "go", status: "lookup-failed", command: result, lookupCommands, updates: [], observations, error: compatibleRuntime.error };
      }
      if (!compatibleRuntime.compatible) {
        restorePaths(root, originals);
        return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: compatibleRuntime.error ?? `${module}@${selectedInfo.Version} exceeds the ${compatibleRuntime.floor} runtime floor` };
      }
      selected = selectedInfo.Version;
      selectionLookup = compatibleLookup;
    }
    if (!parseVersion(selected)) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "lookup-failed", command: result, lookupCommands, updates: [], observations, error: `go module ${module} returned an invalid selected version` };
    }
    const observation = observations.find((entry) => entry.name === module);
    observation.selected = selected;
    observation.selectedGoVersion = selectedInfo.GoVersion ?? null;
    observation.selectedClassification = classifyUpdate(row.Version, selected);
    observation.status = observation.selectedClassification === "none" && observation.status === "manual-review" ? "manual-review" : observation.selectedClassification === "none" ? "no-update" : isEligibleClassification(observation.selectedClassification) ? "eligible" : observation.selectedClassification === "unparseable" ? "lookup-failed" : "manual-review";
    observation.lookup = selectionLookup === lookup ? "go-list-major-line" : "go-list-runtime-compatible-line";
    if (isEligibleClassification(observation.selectedClassification)) updates.push({ ...observation, target: selected });
  }
  for (const update of updates) {
    const get = commandResult("go", ["get", `${update.name}@${update.target}`], nativeOptions(goRoot, options, { GOTOOLCHAIN: "local" }));
    if (get.status !== 0) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: redactDiagnostic(get.stderr || get.error?.message || "go get failed") };
    }
  }
  if (updates.length > 0) {
    const tidy = commandResult("go", ["mod", "tidy"], nativeOptions(goRoot, options, { GOTOOLCHAIN: "local" }));
    if (tidy.status !== 0) {
      restorePaths(root, originals);
      return { ecosystem: "go", status: "resolution-failed", command: result, lookupCommands, updates: [], observations, error: redactDiagnostic(tidy.stderr || tidy.error?.message || "go mod tidy failed") };
    }
  }
  return { ecosystem: "go", status: observations.some((observation) => observation.status === "lookup-failed") ? "lookup-failed" : updates.length > 0 ? "eligible" : observations.some((observation) => observation.status === "manual-review") ? "manual-review" : "no-update", command: result, lookupCommands, updates, observations };
}

export function evaluateRuby(root, options) {
  const rubyRoot = join(root, "packages/ruby");
  const originals = snapshotPaths(root, ["packages/ruby/erpc-sdk.gemspec", "packages/ruby/Gemfile.lock"]);
  const result = commandResult("bundle", ["outdated", "--parseable"], nativeOptions(rubyRoot, options, { BUNDLE_GEMFILE: join(rubyRoot, "Gemfile"), BUNDLE_WITHOUT: "" }));
  if (![0, 1].includes(result.status)) return { ecosystem: "ruby", status: "lookup-failed", command: result, updates: [], observations: [failureResult("bundle", "lookup-failed", result.error ?? result.stderr)] };
  const outdatedRows = parseGemOutdated(result.stdout);
  if (result.status === 1 && (outdatedRows.length === 0 || /(?:error|failed|exception|could not)/iu.test(result.stderr))) return { ecosystem: "ruby", status: "lookup-failed", command: result, updates: [], observations: [failureResult("bundle outdated", "lookup-failed", result.stderr || "status 1 without parseable outdated rows")] };
  const observations = outdatedRows.map((row) => packageLookupResult(row.name, row.current, row.latest, { lookup: "bundle-outdated-parseable" }));
  const known = new Set(observations.map((observation) => observation.name));
  for (const [name, current] of parseRubyLockInventory(readRegularText(root, "packages/ruby/Gemfile.lock"))) {
    if (!known.has(name)) observations.push({ name, current, latest: current, classification: "none", status: "no-update", lookup: "bundle-lock-inventory" });
  }
  const updates = [];
  const declarations = parseRubyDeclarations(readRegularText(root, "packages/ruby/erpc-sdk.gemspec"));
  const exactNames = new Set(declarations.filter((declaration) => declaration.versions.some((version) => version.startsWith("="))).map((declaration) => declaration.name));
  const boundedCandidates = observations.filter((observation) => ["eligible", "manual-review"].includes(observation.status) && observation.name !== "erpc-sdk");
  relaxRubyExactDeclarations(root, declarations, new Set(boundedCandidates.map((update) => update.name).filter((name) => exactNames.has(name))));
  const resolvedExact = new Map();
  for (const update of boundedCandidates) {
    const currentVersion = parseVersion(update.current);
    const level = currentVersion?.major === 0 ? "--patch" : "--minor";
    const native = commandResult("bundle", ["lock", "--update", update.name, "--conservative", level, "--strict"], nativeOptions(rubyRoot, options, { BUNDLE_GEMFILE: join(rubyRoot, "Gemfile"), BUNDLE_WITHOUT: "" }));
    if (native.status !== 0) {
      restorePaths(root, originals);
      return { ecosystem: "ruby", status: "resolution-failed", command: result, updates: [], observations, error: redactDiagnostic(native.stderr || native.error?.message || "bundle lock failed") };
    }
    const resolved = parseRubyLockInventory(readRegularText(root, "packages/ruby/Gemfile.lock")).get(update.name);
    if (!resolved) {
      restorePaths(root, originals);
      return { ecosystem: "ruby", status: "resolution-failed", command: result, updates: [], observations, error: `bundle lock did not resolve ${update.name}` };
    }
    const resolvedClassification = classifyUpdate(update.current, resolved);
    update.resolved = resolved;
    update.resolvedClassification = resolvedClassification;
    if (resolvedClassification !== "none" && !isEligibleClassification(resolvedClassification)) {
      restorePaths(root, originals);
      return { ecosystem: "ruby", status: resolvedClassification === "unparseable" ? "lookup-failed" : "manual-review", command: result, updates: [], observations, withheld: update.name };
    }
    if (isEligibleClassification(resolvedClassification)) {
      update.status = "eligible";
      updates.push({ name: update.name, target: resolved, classification: resolvedClassification });
      if (exactNames.has(update.name)) resolvedExact.set(update.name, resolved);
    }
  }
  restoreRubyExactDeclarations(root, declarations, resolvedExact);
  const finalLock = commandResult("bundle", ["lock"], nativeOptions(rubyRoot, options, { BUNDLE_GEMFILE: join(rubyRoot, "Gemfile"), BUNDLE_WITHOUT: "" }));
  if (finalLock.status !== 0) {
    restorePaths(root, originals);
    return { ecosystem: "ruby", status: "resolution-failed", command: finalLock, updates: [], observations, error: redactDiagnostic(finalLock.stderr || finalLock.error?.message || "final bundle lock failed") };
  }
  const finalInventory = parseRubyLockInventory(readRegularText(root, "packages/ruby/Gemfile.lock"));
  for (const declaration of declarations) {
    const exact = declaration.versions.find((version) => version.startsWith("="))?.match(/(\d+(?:\.\d+){1,2})/u)?.[1];
    if (exact && finalInventory.get(declaration.name) !== (resolvedExact.get(declaration.name) ?? exact)) {
      restorePaths(root, originals);
      return { ecosystem: "ruby", status: "resolution-failed", command: finalLock, updates: [], observations, error: `final bundle lock did not preserve exact ${declaration.name}` };
    }
  }
  return { ecosystem: "ruby", status: observations.some((observation) => observation.status === "lookup-failed") ? "lookup-failed" : updates.length > 0 ? "eligible" : observations.some((observation) => observation.status === "manual-review") ? "manual-review" : "no-update", command: result, updates, observations };
}

function gitOutput(root, args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT_BYTES }).trim(); } catch (error) { fail(`git ${args.join(" ")} failed: ${error.message}`, "SOURCE_INVALID"); }
}

export function validateSourceBinding({ eventName, eventRef, eventSha, checkoutSha, workflowRef = null, expectedWorkflowPath = WORKFLOW_PATH } = {}) {
  if (!["schedule", "workflow_dispatch"].includes(eventName)) fail(`unsupported dependency maintenance event: ${eventName}`, "EVENT_INVALID");
  if (eventRef !== SOURCE_REF) fail(`dependency maintenance must run from ${SOURCE_REF}`, "SOURCE_REF_INVALID");
  requireSha(eventSha, "event SHA");
  requireSha(checkoutSha, "checkout SHA");
  if (eventSha !== checkoutSha) fail("event SHA and checked out SHA differ", "SOURCE_SHA_MISMATCH");
  if (workflowRef !== null && (typeof workflowRef !== "string" || !/^[^/]+\/[^/]+\/.+@refs\/heads\/main$/u.test(workflowRef) || !workflowRef.endsWith(`${expectedWorkflowPath}@refs/heads/main`))) fail("workflow source is not bound to the approved main workflow", "WORKFLOW_REF_INVALID");
  return Object.freeze({ eventName, eventRef, sourceSha: eventSha, workflowPath: expectedWorkflowPath });
}

export function validateCleanCheckout(root, expectedSha, { git = gitOutput } = {}) {
  requireSha(expectedSha, "expected source SHA");
  if (git(root, ["rev-parse", "HEAD"]) !== expectedSha) fail("checkout HEAD is not bound to the event SHA", "SOURCE_SHA_MISMATCH");
  if (git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD") fail("evaluator checkout must be detached", "CHECKOUT_INVALID");
  if (git(root, ["status", "--porcelain"]) !== "") fail("evaluator checkout is dirty", "DIRTY_CHECKOUT");
  return true;
}

function dependencySpecVersion(spec) {
  if (typeof spec !== "string" || /(?:git\+|https?:|ssh:|file:|workspace:|github:|\*|\|\||\blatest\b)/iu.test(spec)) return null;
  const match = spec.match(/^(.*?)(?:v)?(\d+(?:\.\d+){0,2})(.*)$/u);
  if (!match) return null;
  return { prefix: match[1], version: match[2], suffix: match[3] };
}

function validateDependencySpec(before, after, label) {
  if (before === after) {
    if (!dependencySpecVersion(after)) fail(`${label} has an unsupported dependency source`, "CANDIDATE_INVARIANT");
    return;
  }
  const oldSpec = dependencySpecVersion(before);
  const newSpec = dependencySpecVersion(after);
  if (!oldSpec || !newSpec) fail(`${label} changed to an unsupported dependency source`, "CANDIDATE_INVARIANT");
  if (oldSpec.prefix !== newSpec.prefix || oldSpec.suffix !== newSpec.suffix) fail(`${label} changed dependency operator or constraint`, "CANDIDATE_INVARIANT");
  if (!isEligibleClassification(classifyUpdate(oldSpec.version, newSpec.version))) fail(`${label} is outside the patch/minor policy`, "CANDIDATE_INVARIANT");
}

function dependencyObjectInvariant(before, after, allowedSections, label) {
  const oldValue = parseJson(before, label);
  const newValue = parseJson(after, label);
  const oldKeys = Object.keys(oldValue).filter((key) => !allowedSections.includes(key)).sort();
  const newKeys = Object.keys(newValue).filter((key) => !allowedSections.includes(key)).sort();
  if (stableJson(Object.fromEntries(oldKeys.map((key) => [key, oldValue[key]]))) !== stableJson(Object.fromEntries(newKeys.map((key) => [key, newValue[key]])))) fail(`${label} non-dependency metadata changed`, "CANDIDATE_INVARIANT");
  for (const section of allowedSections) {
    const oldDeps = oldValue[section] ?? {};
    const newDeps = newValue[section] ?? {};
    if (stableJson(Object.keys(oldDeps).sort()) !== stableJson(Object.keys(newDeps).sort())) fail(`${label} dependency names changed`, "CANDIDATE_INVARIANT");
    for (const name of Object.keys(oldDeps)) validateDependencySpec(oldDeps[name], newDeps[name], `${label}:${section}:${name}`);
  }
}

function normalizeCargoDeclarations(text) {
  const declarations = parseCargoDeclarations(text);
  return new Map(declarations.map((declaration) => [declaration.name, declaration]));
}

function validateCargoManifest(before, after) {
  const oldMap = normalizeCargoDeclarations(before);
  const newMap = normalizeCargoDeclarations(after);
  if (stableJson([...oldMap.keys()].sort()) !== stableJson([...newMap.keys()].sort())) fail("Cargo dependency names changed", "CANDIDATE_INVARIANT");
  const canonical = (text) => {
    let section = "";
    return text.split(/\r?\n/u).map((line) => {
      const heading = line.match(/^\[([^\]]+)\]/u)?.[1] ?? null;
      if (heading) section = heading;
      if (["dependencies", "dev-dependencies"].includes(section) && /^([A-Za-z0-9_-]+)\s*=/.test(line)) return line.replace(/version\s*=\s*"[^"]+"/u, 'version = "<version>"').replace(/=\s*"[^"]+"\s*$/u, '= "<version>"');
      return line;
    }).join("\n");
  };
  if (canonical(before) !== canonical(after)) fail("Cargo metadata or dependency source changed", "CANDIDATE_INVARIANT");
  for (const [name, declaration] of oldMap) validateDependencySpec(declaration.spec, newMap.get(name).spec, `Cargo:${name}`);
}

function normalizePythonRequirements(text) {
  return new Map(parsePythonRequirements(text).map((requirement) => [`${requirement.section}:${requirement.name}`, requirement]));
}

function validatePythonManifest(before, after) {
  const oldMap = normalizePythonRequirements(before);
  const newMap = normalizePythonRequirements(after);
  if (stableJson([...oldMap.keys()].sort()) !== stableJson([...newMap.keys()].sort())) fail("Python dependency names or arrays changed", "CANDIDATE_INVARIANT");
  let oldCanonical = before;
  let newCanonical = after;
  for (const requirement of oldMap.values()) {
    const replacement = "<dependency>";
    oldCanonical = oldCanonical.split(requirement.raw).join(replacement);
    newCanonical = newCanonical.split(newMap.get(`${requirement.section}:${requirement.name}`).raw).join(replacement);
    validateDependencySpec(requirement.spec, newMap.get(`${requirement.section}:${requirement.name}`).spec, `Python:${requirement.name}`);
  }
  if (oldCanonical !== newCanonical) fail("Python metadata changed outside dependency declarations", "CANDIDATE_INVARIANT");
}

function parseGoDeclarations(text) {
  const declarations = [];
  let inRequire = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^require\s*\(/u.test(line)) { inRequire = true; continue; }
    if (inRequire && line.trim() === ")") { inRequire = false; continue; }
    const value = inRequire ? line : line.replace(/^require\s+/u, "");
    const match = value.match(/^\s*(\S+)\s+(v?\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?)(.*)$/u);
    if (match && match[1] !== "go") declarations.push({ name: match[1], version: match[2], suffix: match[3], line });
  }
  return declarations;
}

function validateGoManifest(before, after) {
  const oldMap = new Map(parseGoDeclarations(before).map((declaration) => [declaration.name, declaration]));
  const newMap = new Map(parseGoDeclarations(after).map((declaration) => [declaration.name, declaration]));
  if (stableJson([...oldMap.keys()].sort()) !== stableJson([...newMap.keys()].sort())) fail("Go module dependency names changed", "CANDIDATE_INVARIANT");
  const canonical = (text) => text.split(/\r?\n/u).map((line) => {
    const declaration = parseGoDeclarations(line)[0];
    return declaration ? line.replace(declaration.version, "<version>") : line;
  }).join("\n");
  if (canonical(before) !== canonical(after)) fail("Go module metadata or dependency source changed", "CANDIDATE_INVARIANT");
  for (const [name, declaration] of oldMap) {
    const next = newMap.get(name);
    if (declaration.suffix !== next.suffix) fail(`Go dependency ${name} metadata changed`, "CANDIDATE_INVARIANT");
    validateDependencySpec(declaration.version, next.version, `Go:${name}`);
  }
}

function parseRubyDeclarations(text) {
  const declarations = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^(\s*spec\.add_(runtime|development)_dependency\s+["']([^"']+)["'])(.*)$/u);
    if (!match) continue;
    if (match[4] && !/^\s*(?:,\s*["'][^"']*["']\s*)*$/u.test(match[4])) fail("Ruby dependency declaration contains executable or unsupported syntax", "CANDIDATE_INVARIANT");
    const versions = [...match[4].matchAll(/["']([^"']+)["']/gu)].map((entry) => entry[1]);
    declarations.push({ name: match[3], kind: match[2], versions, line, prefix: match[1] });
  }
  return declarations;
}

function validateRubyManifest(before, after) {
  const oldRows = parseRubyDeclarations(before);
  const newRows = parseRubyDeclarations(after);
  const oldMap = new Map(oldRows.map((row) => [`${row.kind}:${row.name}`, row]));
  const newMap = new Map(newRows.map((row) => [`${row.kind}:${row.name}`, row]));
  if (stableJson([...oldMap.keys()].sort()) !== stableJson([...newMap.keys()].sort())) fail("Ruby dependency names changed", "CANDIDATE_INVARIANT");
  const canonical = (text) => text.split(/\r?\n/u).map((line) => {
    const row = parseRubyDeclarations(line)[0];
    return row ? `${row.prefix}, ${row.versions.map(() => '"<version>"').join(", ")}` : line;
  }).join("\n");
  if (canonical(before) !== canonical(after)) fail("Ruby gemspec code or metadata changed", "CANDIDATE_INVARIANT");
  for (const [key, row] of oldMap) {
    const next = newMap.get(key);
    if (row.versions.length !== next.versions.length) fail(`Ruby dependency ${row.name} constraints changed shape`, "CANDIDATE_INVARIANT");
    for (let index = 0; index < row.versions.length; index += 1) validateDependencySpec(row.versions[index], next.versions[index], `Ruby:${row.name}`);
  }
}

function relaxRubyExactDeclarations(root, declarations, names) {
  const file = pathInRoot(root, "packages/ruby/erpc-sdk.gemspec");
  let source = readFileSync(file, "utf8");
  for (const declaration of declarations) {
    if (!names.has(declaration.name)) continue;
    const line = source.split(/\r?\n/u).find((candidate) => candidate.includes(`"${declaration.name}"`) || candidate.includes(`'${declaration.name}'`));
    if (!line) continue;
    const relaxed = declaration.versions.map((version) => version.startsWith("=") ? `>= ${version.slice(1).trim()}` : version);
    let updated = line;
    for (let index = 0; index < declaration.versions.length; index += 1) updated = updated.replace(declaration.versions[index], relaxed[index]);
    source = source.replace(line, updated);
  }
  writeFileSync(file, source, { flag: "w" });
}

function restoreRubyExactDeclarations(root, declarations, resolvedVersions) {
  const file = pathInRoot(root, "packages/ruby/erpc-sdk.gemspec");
  let source = readFileSync(file, "utf8");
  for (const declaration of declarations) {
    const target = resolvedVersions.get(declaration.name);
    const versions = declaration.versions.map((version) => version.startsWith("=") && target ? `= ${target}` : version);
    const line = source.split(/\r?\n/u).find((candidate) => candidate.includes(`"${declaration.name}"`) || candidate.includes(`'${declaration.name}'`));
    if (!line) fail(`Ruby dependency ${declaration.name} declaration moved before restore`, "RESOLUTION_FAILED");
    let updated = line;
    for (let index = 0; index < declaration.versions.length; index += 1) {
      const relaxed = declaration.versions[index].startsWith("=") ? `>= ${declaration.versions[index].slice(1).trim()}` : declaration.versions[index];
      updated = updated.replace(relaxed, versions[index]);
    }
    source = source.replace(line, updated);
  }
  writeFileSync(file, source, { flag: "w" });
}

function maskWorkspace(text) {
  const lines = text.split(/\r?\n/u);
  let inOverrides = false;
  return lines.map((line) => {
    if (/^overrides:\s*$/u.test(line)) { inOverrides = true; return line; }
    if (inOverrides && /^\S/u.test(line)) inOverrides = false;
    if (inOverrides && /^\s{2}esbuild:\s*/u.test(line)) return "  esbuild: <dependency>";
    return line;
  }).join("\n");
}

function maskCargo(text) {
  let section = "";
  return text.split(/\r?\n/u).map((line) => {
    const heading = line.match(/^\[([^\]]+)\]/u)?.[1] ?? null;
    if (heading) section = heading;
    if (["dependencies", "dev-dependencies"].includes(section) && /^\s*[A-Za-z0-9_-]+\s*=/.test(line)) return line.replace(/=.*/u, "= <dependency>");
    return line;
  }).join("\n");
}

function maskPyproject(text) {
  let inArray = false;
  return text.split(/\r?\n/u).map((line) => {
    if (/^dependencies\s*=\s*\[/u.test(line.trim()) || /^dev\s*=\s*\[/u.test(line.trim())) inArray = true;
    if (inArray && /^\s*["'][^"']+["'],?\s*$/u.test(line)) return line.replace(/(["'])([^"']+)(["'])/u, "$1<dependency>$3");
    if (inArray && line.trim() === "]") inArray = false;
    return line;
  }).join("\n");
}

function maskGoMod(text) {
  let inRequire = false;
  return text.split(/\r?\n/u).map((line) => {
    if (/^require\s*\(/u.test(line)) { inRequire = true; return line; }
    if (inRequire && line.trim() === ")") { inRequire = false; return line; }
    if (inRequire || /^require\s+[^\s]+\s+v/u.test(line)) return line.replace(/(\s+v?\d+\.\d+(?:\.\d+)?(?:[-+][^\s]+)?)(.*)$/u, " <version>$2");
    return line;
  }).join("\n");
}

function maskGemspec(text) {
  return text.split(/\r?\n/u).map((line) => /^\s*spec\.add_(?:runtime|development)_dependency\b/u.test(line) ? "  <dependency>" : line).join("\n");
}

function extractSdkIdentity(root, files) {
  const packageRoot = parseJson(files["package.json"], "package.json");
  const packageTs = parseJson(files["packages/typescript/package.json"], "packages/typescript/package.json");
  const cargo = files["packages/rust/Cargo.toml"];
  const python = files["packages/python/pyproject.toml"];
  const rubyVersion = readRegularText(root, "packages/ruby/lib/erpc_sdk/version.rb");
  const rustPackage = cargo.match(/^name\s*=\s*"([^"]+)"[\s\S]*?^version\s*=\s*"([^"]+)"/mu);
  const pythonPackage = python.match(/^name\s*=\s*"([^"]+)"[\s\S]*?^version\s*=\s*"([^"]+)"/mu);
  const rubyPackage = files["packages/ruby/erpc-sdk.gemspec"].match(/spec\.name\s*=\s*["']([^"']+)["']/u)?.[1] ?? null;
  const rubySdkVersion = rubyVersion.match(/VERSION\s*=\s*"([^"]+)"/u)?.[1] ?? null;
  const cargoLockSdkVersion = parseCargoLock(files["Cargo.lock"]).get(rustPackage?.[1] ?? "erpc-sdk") ?? null;
  const rubyPathSdkVersion = files["packages/ruby/Gemfile.lock"].match(/^PATH\s*[\s\S]*?^\s+erpc-sdk \(([^)]+)\)/mu)?.[1] ?? null;
  return Object.freeze({
    workspaceName: packageRoot.name,
    packageManager: packageRoot.packageManager,
    workspaceNode: packageRoot.engines?.node,
    typescriptName: packageTs.name,
    typescriptVersion: packageTs.version,
    typescriptNode: packageTs.engines?.node,
    rustName: rustPackage?.[1] ?? null,
    rustVersion: rustPackage?.[2] ?? null,
    rustEdition: cargo.match(/^edition\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    rustMsrv: cargo.match(/^rust-version\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    pythonName: pythonPackage?.[1] ?? null,
    pythonVersion: pythonPackage?.[2] ?? null,
    pythonFloor: python.match(/^requires-python\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    goModule: files["packages/go/go.mod"].match(/^module\s+([^\s]+)\s*$/mu)?.[1] ?? null,
    goFloor: files["packages/go/go.mod"].match(/^go\s+([^\s]+)\s*$/mu)?.[1] ?? null,
    rubyName: rubyPackage,
    rubyVersion: rubySdkVersion,
    rubyFloor: files["packages/ruby/erpc-sdk.gemspec"].match(/^\s*spec\.required_ruby_version\s*=\s*"([^"]+)"/mu)?.[1] ?? null,
    cargoLockSdkVersion,
    rubyPathSdkVersion,
  });
}

function assertIdentity(root, files, baselineFiles = files) {
  const packageRoot = parseJson(files["package.json"], "package.json");
  const packageTs = parseJson(files["packages/typescript/package.json"], "packages/typescript/package.json");
  if (packageRoot.packageManager !== "pnpm@11.24.0" || packageRoot.engines?.node !== ">=22.13") fail("workspace Node/pnpm floor or package manager changed", "FLOOR_DRIFT");
  if (packageTs.engines?.node !== ">=20") fail("TypeScript Node floor changed", "FLOOR_DRIFT");
  const cargo = files["packages/rust/Cargo.toml"];
  if (!/^edition\s*=\s*"2024"/mu.test(cargo) || !/^rust-version\s*=\s*"1\.85"/mu.test(cargo) || !/^yoke-derive\s*=\s*"=0\.8\.2"/mu.test(cargo)) fail("Rust edition, MSRV, or yoke hold changed", "FLOOR_DRIFT");
  const python = files["packages/python/pyproject.toml"];
  if (!/^requires-python\s*=\s*">=3\.11"/mu.test(python)) fail("Python floor changed", "FLOOR_DRIFT");
  if (!/^module\s+github\.com\/elsoul\/erpc-sdk\/packages\/go\s*$/mu.test(files["packages/go/go.mod"]) || !/^go\s+1\.22\s*$/mu.test(files["packages/go/go.mod"])) fail("Go module or floor changed", "FLOOR_DRIFT");
  if (!/^\s*spec\.required_ruby_version\s*=\s*">= 3\.1"/mu.test(files["packages/ruby/erpc-sdk.gemspec"])) fail("Ruby floor changed", "FLOOR_DRIFT");
  const expected = extractSdkIdentity(root, baselineFiles);
  const actual = extractSdkIdentity(root, files);
  for (const key of ["workspaceName", "typescriptName", "typescriptVersion", "rustName", "rustVersion", "pythonName", "pythonVersion", "goModule", "rubyName", "rubyVersion", "cargoLockSdkVersion", "rubyPathSdkVersion"]) if (actual[key] !== expected[key]) fail(`SDK identity changed for ${key}`, "IDENTITY_DRIFT");
}

function parseGoSumVersions(text) {
  const versions = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(v\d+\.\d+(?:\.\d+)?(?:[-+][^\s/]+)?)(?:\/go\.mod)?\s+h1:/u);
    if (!match) fail("Go checksum file contains an invalid line", "CANDIDATE_INVARIANT");
    const key = `${match[1]}@${match[2]}`;
    versions.set(key, match[2]);
  }
  return versions;
}

function parseGoSumChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(v\d+\.\d+(?:\.\d+)?(?:[-+][^\s/]+)?(?:\/go\.mod)?)\s+(h1:[A-Za-z0-9+/]{43}=)$/u);
    if (match) checksums.set(`${match[1]}@${match[2]}`, match[3]);
  }
  return checksums;
}

function parsePnpmLockVersions(text) {
  const versions = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s{2}(?:['"])?(.+?)@(\d+\.\d+(?:\.\d+)?)(?:[^\d].*)?$/u);
    if (!match || !match[1] || match[1].includes(" ")) continue;
    if (!versions.has(match[1])) versions.set(match[1], new Set());
    versions.get(match[1]).add(match[2]);
  }
  return versions;
}

function validatePnpmIntegrities(text) {
  for (const match of text.matchAll(/integrity:\s*(sha512-[^\s,}]+)/gu)) if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(match[1])) fail("pnpm lockfile contains an invalid integrity", "CANDIDATE_INVARIANT");
}

function parsePnpmIntegrities(text) {
  const values = new Map();
  let packageKey = null;
  for (const line of text.split(/\r?\n/u)) {
    const packageMatch = line.match(/^\s{2}(?:['"])?(.+?@\d+\.\d+(?:\.\d+)?)(?:['"])?\s*:/u);
    if (packageMatch) packageKey = packageMatch[1];
    const integrity = line.match(/integrity:\s*(sha512-[^\s,}]+)/u)?.[1];
    if (integrity && packageKey) values.set(packageKey, integrity);
  }
  return values;
}

function validateLockShape(relativePath, text) {
  if (typeof text !== "string" || text.trim().length === 0 || text.includes("\0")) fail(`${relativePath} is empty or contains invalid bytes`, "CANDIDATE_INVARIANT");
  if (relativePath === "pnpm-lock.yaml" && (!/^lockfileVersion:\s*['"]?9(?:\.0)?['"]?/mu.test(text) || !/^importers:\s*$/mu.test(text) || !/^packages:\s*$/mu.test(text))) fail("pnpm lockfile shape is invalid", "CANDIDATE_INVARIANT");
  if (relativePath === "pnpm-lock.yaml") {
    validatePnpmIntegrities(text);
    if (/tarball:\s*https?:/u.test(text)) fail("pnpm lockfile contains an unapproved tarball source", "CANDIDATE_INVARIANT");
    if (/\[[^\]]*$/mu.test(text) || /\{[^}]*$/mu.test(text)) fail("pnpm lockfile contains unterminated YAML syntax", "CANDIDATE_INVARIANT");
  }
  if (relativePath === "Cargo.lock" && (!/^version\s*=\s*4\s*$/mu.test(text) || !/^\[\[package\]\]$/mu.test(text) || /^\[[^\]]*$/mu.test(text))) fail("Cargo lockfile shape is invalid", "CANDIDATE_INVARIANT");
  if (relativePath === "Cargo.lock") for (const record of parseCargoLockRecords(text)) {
    if (record.source !== null && record.source !== "registry+https://github.com/rust-lang/crates.io-index") fail(`Cargo lock source for ${record.name} is outside crates.io`, "CANDIDATE_INVARIANT");
    if (record.checksum !== null && !/^[0-9a-f]{64}$/u.test(record.checksum)) fail(`Cargo lock checksum for ${record.name} is invalid`, "CANDIDATE_INVARIANT");
  }
  if (relativePath === "packages/go/go.sum") parseGoSumVersions(text);
  if (relativePath === "packages/go/go.sum" && text.split(/\r?\n/u).filter(Boolean).some((line) => !/^[^\s]+\s+v\d+\.\d+(?:\.\d+)?(?:[-+][^\s/]+)?(?:\/go\.mod)?\s+h1:[A-Za-z0-9+/]{43}=$/u.test(line))) fail("Go checksum file contains an invalid checksum", "CANDIDATE_INVARIANT");
  if (relativePath === "packages/ruby/Gemfile.lock" && (!/^GEM\s*$/mu.test(text) || !/^\s+remote:\s+https:\/\/rubygems\.org\/$/mu.test(text) || !/^PATH\s*$/mu.test(text) || !/^\s+remote:\s+\.$/mu.test(text) || !/^DEPENDENCIES\s*$/mu.test(text) || !/^BUNDLED WITH\s*$/mu.test(text))) fail("Ruby lockfile shape is invalid", "CANDIDATE_INVARIANT");
}

function validateTrustedParsedShapes(parsed) {
  const cargo = parsed.toml?.["Cargo.lock"];
  const cargoManifest = parsed.toml?.["packages/rust/Cargo.toml"];
  const pyproject = parsed.toml?.["packages/python/pyproject.toml"];
  const pnpm = parsed.yaml?.["pnpm-lock.yaml"];
  if (!cargo || cargo.version !== 4 || !Array.isArray(cargo.package) || cargo.package.length === 0) fail("trusted Cargo parser returned an unsupported lockfile shape", "PARSER_INVALID");
  if (!cargoManifest?.package || typeof cargoManifest.package !== "object") fail("trusted Cargo parser returned an unsupported manifest shape", "PARSER_INVALID");
  if (!pyproject?.project || !Array.isArray(pyproject.project.dependencies) || !pyproject["build-system"]?.requires) fail("trusted Python parser returned an unsupported manifest shape", "PARSER_INVALID");
  if (!pnpm || (pnpm.lockfileVersion !== "9.0" && pnpm.lockfileVersion !== 9) || !pnpm.importers || typeof pnpm.importers !== "object" || !pnpm.packages || typeof pnpm.packages !== "object") fail("trusted pnpm parser returned an unsupported lock shape", "PARSER_INVALID");
  for (const record of cargo.package) {
    if (!record || typeof record.name !== "string" || typeof record.version !== "string") fail("trusted Cargo package record is invalid", "PARSER_INVALID");
    if (record.source !== undefined && record.source !== "registry+https://github.com/rust-lang/crates.io-index") fail(`Cargo lock source for ${record.name} is outside crates.io`, "CANDIDATE_INVARIANT");
    if (record.checksum !== undefined && !/^[0-9a-f]{64}$/u.test(record.checksum)) fail(`Cargo lock checksum for ${record.name} is invalid`, "CANDIDATE_INVARIANT");
  }
}

function validateParsedPnpmSemantics(before, after) {
  const oldPackages = before?.packages ?? {};
  const newPackages = after?.packages ?? {};
  for (const [identity, record] of Object.entries(newPackages)) {
    if (!record || typeof record !== "object") fail(`pnpm package record ${identity} is invalid`, "PARSER_INVALID");
    if (record.resolution !== undefined) {
      if (!record.resolution || typeof record.resolution !== "object" || Object.keys(record.resolution).some((key) => key !== "integrity")) fail(`pnpm package source for ${identity} is unsupported`, "CANDIDATE_INVARIANT");
      if (record.resolution.integrity !== undefined && !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.resolution.integrity)) fail(`pnpm package integrity for ${identity} is invalid`, "CANDIDATE_INVARIANT");
    }
    const old = oldPackages[identity];
    if (old?.resolution?.integrity && record.resolution?.integrity && old.resolution.integrity !== record.resolution.integrity && old.version === record.version) fail(`pnpm integrity changed for unchanged package ${identity}`, "CANDIDATE_INVARIANT");
  }
}

function validateDirectLockConsistency(files, expectedRubyVersion) {
  const cargoDeclarations = parseCargoDeclarations(files["packages/rust/Cargo.toml"]);
  const cargoLock = parseCargoLock(files["Cargo.lock"]);
  for (const declaration of cargoDeclarations) {
    if (!cargoLock.has(declaration.name)) fail(`Cargo lock omits ${declaration.name}`, "CANDIDATE_INVARIANT");
    if (declaration.exact && cargoLock.get(declaration.name) !== declaration.spec.slice(1)) fail(`Cargo lock is stale for exact ${declaration.name}`, "CANDIDATE_INVARIANT");
  }
  const goSums = parseGoSumVersions(files["packages/go/go.sum"]);
  for (const declaration of parseGoDeclarations(files["packages/go/go.mod"])) if (![...goSums.keys()].some((key) => key.startsWith(`${declaration.name}@${declaration.version}`))) fail(`Go checksum file omits ${declaration.name}@${declaration.version}`, "CANDIDATE_INVARIANT");
  const rubyLock = parseRubyLockInventory(files["packages/ruby/Gemfile.lock"]);
  for (const declaration of parseRubyDeclarations(files["packages/ruby/erpc-sdk.gemspec"])) {
    const expected = declaration.versions.find((version) => /^=/.test(version))?.match(/(\d+(?:\.\d+){1,2})/u)?.[1];
    if (expected && rubyLock.get(declaration.name) !== expected) fail(`Ruby lock does not bind exact ${declaration.name}`, "CANDIDATE_INVARIANT");
  }
  const expectedPathIdentity = `erpc-sdk (${expectedRubyVersion})`;
  if (!new RegExp(`^PATH\\s*\\n\\s+remote:\\s+\\.\\s*\\n\\s+specs:\\s*\\n\\s+${expectedPathIdentity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "mu").test(files["packages/ruby/Gemfile.lock"])) fail("Ruby PATH SDK identity is missing from lockfile", "CANDIDATE_INVARIANT");
  const pathSection = files["packages/ruby/Gemfile.lock"].match(/^PATH\s*\n[\s\S]*?(?=^GEM\s*$|^PLATFORMS\s*$)/mu)?.[0] ?? "";
  for (const dependency of parseRubyDeclarations(files["packages/ruby/erpc-sdk.gemspec"])) {
    const exact = dependency.versions.find((version) => /^=/.test(version));
    if (exact && dependency.name !== "erpc-sdk" && !new RegExp(`^\\s+${dependency.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(${exact.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\)`, "mu").test(pathSection)) fail(`Ruby PATH lock constraint for ${dependency.name} is stale`, "CANDIDATE_INVARIANT");
  }
}

function validateLockVersionChanges(before, after, relativePath) {
  validateLockShape(relativePath, before);
  validateLockShape(relativePath, after);
  if (relativePath === "pnpm-lock.yaml") {
    const oldMap = parsePnpmLockVersions(before);
    const newMap = parsePnpmLockVersions(after);
    for (const [name, oldVersions] of oldMap) {
      const nextVersions = newMap.get(name) ?? new Set();
      for (const oldVersion of oldVersions) if (!nextVersions.has(oldVersion) && ![...nextVersions].some((next) => isEligibleClassification(classifyUpdate(oldVersion, next)))) fail(`pnpm lock update ${name} is outside the patch/minor policy`, "CANDIDATE_INVARIANT");
    }
    const oldIntegrity = parsePnpmIntegrities(before);
    const newIntegrity = parsePnpmIntegrities(after);
    for (const [key, value] of oldIntegrity) if (newIntegrity.has(key) && newIntegrity.get(key) !== value) fail(`pnpm integrity changed for unchanged package ${key}`, "CANDIDATE_INVARIANT");
  } else if (relativePath === "Cargo.lock") {
    const oldMap = parseCargoLock(before);
    const newMap = parseCargoLock(after);
    for (const [name, oldVersion] of oldMap) {
      const next = newMap.get(name);
      if (next && next !== oldVersion && !isEligibleClassification(classifyUpdate(oldVersion, next))) fail(`Cargo lock update ${name} is outside the patch/minor policy`, "CANDIDATE_INVARIANT");
    }
    const oldRecords = new Map(parseCargoLockRecords(before).map((record) => [`${record.name}@${record.version}`, record]));
    const newRecords = new Map(parseCargoLockRecords(after).map((record) => [`${record.name}@${record.version}`, record]));
    for (const [key, oldRecord] of oldRecords) {
      const next = newRecords.get(key);
      if (next && (next.source !== oldRecord.source || next.checksum !== oldRecord.checksum)) fail(`Cargo lock source/checksum changed for unchanged package ${key}`, "CANDIDATE_INVARIANT");
    }
  } else if (relativePath === "packages/go/go.sum") {
    const oldVersions = [...parseGoSumVersions(before).values()];
    const newVersions = [...parseGoSumVersions(after).values()];
    for (const oldVersion of oldVersions) if (!newVersions.includes(oldVersion) && !newVersions.some((next) => isEligibleClassification(classifyUpdate(oldVersion, next)))) fail(`Go checksum update ${oldVersion} is outside the patch/minor policy`, "CANDIDATE_INVARIANT");
    const oldChecksums = parseGoSumChecksums(before);
    const newChecksums = parseGoSumChecksums(after);
    for (const [key, checksum] of oldChecksums) if (newChecksums.has(key) && newChecksums.get(key) !== checksum) fail(`Go checksum changed for unchanged package ${key}`, "CANDIDATE_INVARIANT");
  } else if (relativePath === "packages/ruby/Gemfile.lock") {
    const oldMap = parseRubyLockInventory(before);
    const newMap = parseRubyLockInventory(after);
    for (const [name, oldVersion] of oldMap) {
      const next = newMap.get(name);
      if (next && next !== oldVersion && !isEligibleClassification(classifyUpdate(oldVersion, next))) fail(`Ruby lock update ${name} is outside the patch/minor policy`, "CANDIDATE_INVARIANT");
    }
  }
}

function validatePnpmManifestLock(beforeRoot, afterRoot, beforeWorkspace, afterWorkspace, afterLock, parsedLock = null) {
  const names = [];
  for (const relativePath of ["package.json", "packages/typescript/package.json"]) {
    const oldValue = parseJson(beforeRoot[relativePath], relativePath);
    const newValue = parseJson(afterRoot[relativePath], relativePath);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(oldValue[section] ?? {})) if (oldValue[section][name] !== newValue[section]?.[name]) names.push([name, newValue[section][name]]);
    }
  }
  const oldOverride = beforeWorkspace.match(/^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*([^\s#]+)\s*$/mu)?.[1];
  const newOverride = afterWorkspace.match(/^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*([^\s#]+)\s*$/mu)?.[1];
  if (oldOverride !== newOverride) names.push(["esbuild", newOverride]);
  for (const [name, spec] of names) {
    const version = dependencySpecVersion(spec)?.version;
    if (!version || !new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}@${version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:[^0-9]|$)`, "u").test(afterLock)) fail(`pnpm lockfile does not bind ${name} to its changed manifest version`, "CANDIDATE_INVARIANT");
    if (name === "esbuild") continue;
    const importer = name === "lefthook" ? "." : "packages/typescript";
    if (parsedLock) {
      const importerData = parsedLock.importers?.[importer];
      const parsedEntry = Object.values(importerData ?? {}).flatMap((section) => section && typeof section === "object" ? [section[name]] : []).find(Boolean);
      const parsedVersion = String(parsedEntry?.version ?? "").split("(")[0];
      if (!parsedEntry || parsedEntry.specifier !== spec || parsedVersion !== version) fail(`parsed pnpm importer is stale for ${name}`, "CANDIDATE_INVARIANT");
    }
  }
}

export function validateCandidateFiles({ root = REPOSITORY_ROOT, before, after, expectedChangedPaths = null } = {}) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") fail("candidate file snapshots are required", "CANDIDATE_INVALID");
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (stableJson(beforeKeys) !== stableJson(CANDIDATE_PATHS.slice().sort()) || stableJson(afterKeys) !== stableJson(CANDIDATE_PATHS.slice().sort())) fail("candidate file snapshot does not cover the closed file set", "CANDIDATE_PATH_INVALID");
  const changed = changedPaths(before, after);
  if (expectedChangedPaths && stableJson(changed) !== stableJson([...expectedChangedPaths].sort())) fail("candidate changed paths do not match the artifact", "CANDIDATE_PATH_INVALID");
  if (changed.some((relativePath) => !CANDIDATE_PATH_SET.has(relativePath))) fail("candidate contains a forbidden path", "CANDIDATE_PATH_INVALID");
  const parsedBefore = trustedParseLockData({ toml: { "Cargo.lock": before["Cargo.lock"], "packages/rust/Cargo.toml": before["packages/rust/Cargo.toml"], "packages/python/pyproject.toml": before["packages/python/pyproject.toml"] }, yaml: { "pnpm-lock.yaml": before["pnpm-lock.yaml"] } });
  const parsedAfter = trustedParseLockData({ toml: { "Cargo.lock": after["Cargo.lock"], "packages/rust/Cargo.toml": after["packages/rust/Cargo.toml"], "packages/python/pyproject.toml": after["packages/python/pyproject.toml"] }, yaml: { "pnpm-lock.yaml": after["pnpm-lock.yaml"] } });
  validateTrustedParsedShapes(parsedBefore);
  validateTrustedParsedShapes(parsedAfter);
  validateParsedPnpmSemantics(parsedBefore.yaml["pnpm-lock.yaml"], parsedAfter.yaml["pnpm-lock.yaml"]);
  assertIdentity(root, after, before);
  dependencyObjectInvariant(before["package.json"], after["package.json"], ["devDependencies"], "package.json");
  dependencyObjectInvariant(before["packages/typescript/package.json"], after["packages/typescript/package.json"], ["dependencies", "devDependencies"], "packages/typescript/package.json");
  const oldWorkspace = before["pnpm-workspace.yaml"].match(/^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*([^\s#]+)\s*$/mu)?.[1];
  const newWorkspace = after["pnpm-workspace.yaml"].match(/^overrides:\s*\n(?:^[ \t].*\n)*?^[ \t]{2}esbuild:\s*([^\s#]+)\s*$/mu)?.[1];
  if (maskWorkspace(before["pnpm-workspace.yaml"]) !== maskWorkspace(after["pnpm-workspace.yaml"])) fail("workspace metadata changed outside the esbuild override", "CANDIDATE_INVARIANT");
  if (!oldWorkspace || !newWorkspace) fail("esbuild override is missing", "CANDIDATE_INVARIANT");
  validateDependencySpec(oldWorkspace, newWorkspace, "pnpm override:esbuild");
  validateCargoManifest(before["packages/rust/Cargo.toml"], after["packages/rust/Cargo.toml"]);
  validatePythonManifest(before["packages/python/pyproject.toml"], after["packages/python/pyproject.toml"]);
  validateGoManifest(before["packages/go/go.mod"], after["packages/go/go.mod"]);
  validateRubyManifest(before["packages/ruby/erpc-sdk.gemspec"], after["packages/ruby/erpc-sdk.gemspec"]);
  for (const relativePath of LOCK_PATHS) validateLockVersionChanges(before[relativePath], after[relativePath], relativePath);
  validatePnpmManifestLock(before, after, before["pnpm-workspace.yaml"], after["pnpm-workspace.yaml"], after["pnpm-lock.yaml"], parsedAfter.yaml["pnpm-lock.yaml"]);
  validateDirectLockConsistency(after, extractSdkIdentity(root, before).rubyVersion);
  if (after["packages/ruby/Gemfile.lock"].match(/^BUNDLED WITH\s*\n\s*(\S+)/mu)?.[1] !== "2.4.20") fail("Ruby Bundler version changed", "FLOOR_DRIFT");
  return Object.freeze({ changedPaths: changed, candidateDigest: hashFiles(Object.fromEntries(changed.map((relativePath) => [relativePath, after[relativePath]]))) });
}

function ecosystemStatus(results) {
  if (results.some((result) => ["blocked", "lookup-failed", "resolution-failed"].includes(result.status) || result.observations?.some((observation) => ["lookup-failed", "resolution-failed"].includes(observation.status)))) return "blocked";
  if (results.some((result) => result.status === "eligible")) return "eligible";
  return "no-update";
}

export function buildObservation({ sourceSha, eventName = "schedule", eventRef = SOURCE_REF, workflowRef = null, results, before, after, runId = null, runAttempt = null } = {}) {
  requireSha(sourceSha, "source SHA");
  if (!Array.isArray(results) || results.length !== ECOSYSTEMS.length || new Set(results.map((result) => result.ecosystem)).size !== ECOSYSTEMS.length) fail("observation must contain exactly five ecosystem results", "OBSERVATION_INVALID");
  if (results.some((result) => !Array.isArray(result.observations) || result.observations.length === 0)) fail("observation must contain a native inventory for every ecosystem", "OBSERVATION_INVALID");
  assertIdentity(REPOSITORY_ROOT, after ?? before, before ?? after);
  const validation = validateCandidateFiles({ before, after });
  const files = Object.fromEntries(validation.changedPaths.map((relativePath) => [relativePath, after[relativePath]]));
  const fileDigests = Object.fromEntries(validation.changedPaths.map((relativePath) => [relativePath, createHash("sha256").update(files[relativePath], "utf8").digest("hex")]));
  const blocked = results.some((result) => ["blocked", "lookup-failed", "resolution-failed"].includes(result.status) || result.observations?.some((observation) => ["lookup-failed", "resolution-failed"].includes(observation.status)));
  const candidateStatus = blocked ? "blocked" : validation.changedPaths.length > 0 ? "eligible" : "no-update";
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    kind: OBSERVATION_KIND,
    workflowPath: WORKFLOW_PATH,
    sourceRef: eventRef,
    sourceSha,
    eventName,
    workflowRef,
    runId,
    runAttempt,
    evaluationStatus: ecosystemStatus(results),
    ecosystems: results.map((result) => {
      const lookups = (result.lookupCommands ?? (result.command ? [result.command] : [])).map((command) => ({ command: command.command, args: command.args, exitCode: command.status }));
      if (lookups.length === 0) fail(`ecosystem ${result.ecosystem} has no native lookup receipt`, "OBSERVATION_INVALID");
      return { ecosystem: result.ecosystem, status: result.status, observations: result.observations ?? [], updates: result.updates ?? [], lookup: lookups[0], lookups, error: result.error ?? null };
    }),
    candidate: {
      status: candidateStatus,
      changedPaths: validation.changedPaths,
      files,
      fileDigests,
      candidateDigest: validation.candidateDigest,
    },
  };
}

function makeLocalEvaluationRoot(root, sourceSha) {
  const directory = mkdtempSync(join(tmpdir(), "erpc-dependency-maintenance-"));
  const result = spawnSync("git", ["clone", "--local", "--no-hardlinks", root, directory], { cwd: root, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT_BYTES, shell: false });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    fail(`could not create temporary evaluator checkout: ${result.stderr || result.error?.message || "git clone failed"}`, "EVALUATOR_CHECKOUT_FAILED");
  }
  spawnSync("git", ["checkout", "--detach", sourceSha], { cwd: directory, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, shell: false });
  validateCleanCheckout(directory, sourceSha);
  return directory;
}

export function evaluateRepository({ root = REPOSITORY_ROOT, sourceSha = null, eventName = "schedule", eventRef = SOURCE_REF, workflowRef = null, runner = defaultCommandRunner, env = process.env, runId = null, runAttempt = null, useTemporaryCheckout = true } = {}) {
  const expectedSha = sourceSha ?? gitOutput(root, ["rev-parse", "HEAD"]);
  validateSourceBinding({ eventName, eventRef, eventSha: expectedSha, checkoutSha: gitOutput(root, ["rev-parse", "HEAD"]), workflowRef });
  validateCleanCheckout(root, expectedSha);
  const before = readCandidateFiles(root);
  assertIdentity(root, before);
  let evaluationRoot = root;
  let temporary = false;
  if (useTemporaryCheckout) { evaluationRoot = makeLocalEvaluationRoot(root, expectedSha); temporary = true; }
  try {
    const options = { runner, env };
    const results = [
      evaluateTypescript(evaluationRoot, options),
      evaluateRust(evaluationRoot, options),
      evaluatePython(evaluationRoot, options),
      evaluateGo(evaluationRoot, options),
      evaluateRuby(evaluationRoot, options),
    ];
    if (results.some((result) => ["lookup-failed", "resolution-failed"].includes(result.status))) restorePaths(evaluationRoot, before);
    const after = readCandidateFiles(evaluationRoot);
    assertIdentity(evaluationRoot, after);
    const observation = buildObservation({ sourceSha: expectedSha, eventName, eventRef, workflowRef, results, before, after, runId: runId === null ? null : Number(runId), runAttempt: runAttempt === null ? null : Number(runAttempt) });
    observation.evaluationStatus = ecosystemStatus(results);
    return observation;
  } finally {
    if (temporary) rmSync(evaluationRoot, { recursive: true, force: true });
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, "ARTIFACT_INVALID");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableJson(actual) !== stableJson(wanted)) fail(`${label} keys are invalid`, "ARTIFACT_INVALID");
}

const SCAN_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "status",
  "observationSha256",
  "candidateDigest",
  "sourceSha",
  "sourceRef",
  "eventName",
  "workflowPath",
  "workflowRef",
  "runId",
  "runAttempt",
  "scanner",
]);
const SCANNER_KEYS = Object.freeze(["name", "version", "wrapperSha256", "configSha256"]);
const SCAN_SAFE_ENVIRONMENT_KEYS = Object.freeze(["PATH", "HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "LANG"]);
const MAX_SCAN_MATERIALIZED_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_RECEIPT_BYTES = 64 * 1024;

function scanFailure(code = "SCAN_FAILED") {
  const messages = {
    SCAN_INPUT_INVALID: "dependency observation scan input is invalid",
    SCAN_RECEIPT_MISSING: "dependency observation scan receipt is missing",
    SCAN_RECEIPT_INVALID: "dependency observation scan receipt is invalid",
    SCAN_RECEIPT_MISMATCH: "dependency observation scan receipt does not match",
    SCAN_FAILED: "dependency observation secret scan failed",
  };
  throw new DependencyMaintenanceError(messages[code] ?? messages.SCAN_FAILED, code);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedUtf8(bytes, code = "SCAN_INPUT_INVALID") {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) scanFailure(code);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (Buffer.byteLength(text, "utf8") !== bytes.length) scanFailure(code);
    return text;
  } catch {
    scanFailure(code);
  }
}

function boundedFileBytes(filePath) {
  let link;
  let stat;
  try {
    link = lstatSync(filePath);
    stat = statSync(filePath);
  } catch {
    scanFailure("SCAN_INPUT_INVALID");
  }
  if (link.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) scanFailure("SCAN_INPUT_INVALID");
  try {
    const bytes = readFileSync(filePath);
    if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) scanFailure("SCAN_INPUT_INVALID");
    return bytes;
  } catch {
    scanFailure("SCAN_INPUT_INVALID");
  }
}

function trustedScannerFiles(root) {
  const files = {};
  for (const relativePath of [GITLEAKS_WRAPPER_PATH, GITLEAKS_CONFIG_PATH]) {
    let target;
    try {
      target = pathInRoot(root, relativePath, "trusted scanner path");
    } catch {
      scanFailure("SCAN_INPUT_INVALID");
    }
    files[relativePath] = boundedFileBytes(target);
  }
  const wrapperText = boundedUtf8(files[GITLEAKS_WRAPPER_PATH]);
  if (!new RegExp(`(?:^|\\n)version=${GITLEAKS_VERSION.replaceAll(".", "\\.")}(?:\\n|$)`, "u").test(wrapperText)) scanFailure("SCAN_FAILED");
  return Object.freeze({
    wrapperPath: pathInRoot(root, GITLEAKS_WRAPPER_PATH, "trusted scanner wrapper"),
    configPath: pathInRoot(root, GITLEAKS_CONFIG_PATH, "trusted scanner config"),
    wrapperSha256: sha256Bytes(files[GITLEAKS_WRAPPER_PATH]),
    configSha256: sha256Bytes(files[GITLEAKS_CONFIG_PATH]),
  });
}

function scannerEnvironment(input = process.env) {
  const environment = {};
  for (const key of SCAN_SAFE_ENVIRONMENT_KEYS) {
    if (typeof input[key] === "string" && input[key].length > 0) environment[key] = input[key];
  }
  if (!environment.PATH) environment.PATH = "/usr/bin:/bin";
  if (!environment.HOME) environment.HOME = tmpdir();
  environment.LC_ALL = "C";
  return environment;
}

function collectDecodedStrings(value, output, state) {
  if (typeof value === "string") {
    if (value.length > 0) {
      if (value.includes("\0")) scanFailure("SCAN_INPUT_INVALID");
      if ([...value].some((character) => {
        const code = character.codePointAt(0);
        return code >= 0xd800 && code <= 0xdfff;
      })) scanFailure("SCAN_INPUT_INVALID");
      output.push(value);
      state.count += 1;
      state.bytes += Buffer.byteLength(value, "utf8") + 1;
    }
    if (state.count > MAX_SCAN_STRINGS || state.bytes > MAX_SCAN_MATERIALIZED_BYTES) scanFailure("SCAN_INPUT_INVALID");
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDecodedStrings(entry, output, state);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectDecodedStrings(key, output, state);
      collectDecodedStrings(entry, output, state);
    }
  }
}

function materializeScanInput(root, artifact, observationBytes) {
  const directory = mkdtempSync(join(tmpdir(), "erpc-dependency-secret-scan-"));
  try {
    const observationPath = join(directory, "dependency-observation.json");
    writeFileSync(observationPath, observationBytes, { flag: "wx", mode: 0o600 });
    const candidateDirectory = join(directory, "candidate-files");
    mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
    for (const relativePath of [...artifact.candidate.changedPaths].sort()) {
      if (!CANDIDATE_PATH_SET.has(relativePath)) scanFailure("SCAN_INPUT_INVALID");
      safeRelativePath(relativePath, "candidate path");
      const value = artifact.candidate.files[relativePath];
      if (typeof value !== "string") scanFailure("SCAN_INPUT_INVALID");
      const bytes = Buffer.from(value, "utf8");
      if (bytes.length > MAX_ARTIFACT_BYTES || boundedUtf8(bytes) !== value) scanFailure("SCAN_INPUT_INVALID");
      const target = join(candidateDirectory, relativePath);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    const decodedStrings = [];
    const state = { count: 0, bytes: 0 };
    collectDecodedStrings(artifact, decodedStrings, state);
    const decodedPath = join(directory, "decoded-observation-strings.txt");
    const decodedBytes = Buffer.from(decodedStrings.join("\n"), "utf8");
    if (decodedBytes.length > MAX_SCAN_MATERIALIZED_BYTES) scanFailure("SCAN_INPUT_INVALID");
    writeFileSync(decodedPath, decodedBytes, { flag: "wx", mode: 0o600 });
    return directory;
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    if (error instanceof DependencyMaintenanceError) throw error;
    scanFailure("SCAN_INPUT_INVALID");
  }
}

function runGitleaksScan(root, scanDirectory, scanner) {
  let result;
  try {
    result = spawnSync(scanner.wrapperPath, [
      "dir",
      scanDirectory,
      "--redact=100",
      "--config",
      scanner.configPath,
      "--ignore-gitleaks-allow",
    ], {
      cwd: root,
      env: scannerEnvironment(),
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
  } catch {
    scanFailure("SCAN_FAILED");
  }
  if (!result || result.error || result.signal || result.status !== 0) scanFailure("SCAN_FAILED");
  return true;
}

function parseObservationScanInput(observationBytes, { artifact = null, root = REPOSITORY_ROOT, sourceSha = null, requireSuccessful = false, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null } = {}) {
  const text = boundedUtf8(observationBytes);
  let parsed;
  try { parsed = JSON.parse(text); } catch { scanFailure("SCAN_INPUT_INVALID"); }
  try {
    validateObservationArtifact(parsed, {
      root,
      sourceSha,
      requireSuccessful,
      expectedRunId,
      expectedRunAttempt,
      expectedEventName,
      expectedWorkflowRef,
    });
  } catch {
    scanFailure("SCAN_INPUT_INVALID");
  }
  if (artifact !== null && stableJson(parsed) !== stableJson(artifact)) scanFailure("SCAN_INPUT_INVALID");
  if (!(parsed.evaluationStatus === "eligible" || parsed.evaluationStatus === "no-update" || parsed.evaluationStatus === "blocked")) scanFailure("SCAN_INPUT_INVALID");
  if (typeof parsed.workflowRef !== "string" || parsed.workflowRef.length === 0 || !/^[^/]+\/[^/]+\/.+@refs\/heads\/main$/u.test(parsed.workflowRef) || !parsed.workflowRef.endsWith(`${WORKFLOW_PATH}@refs/heads/main`)) scanFailure("SCAN_INPUT_INVALID");
  return parsed;
}

function scanReceiptForArtifact({ artifact, observationBytes, scanner }) {
  return {
    schemaVersion: SCAN_RECEIPT_SCHEMA_VERSION,
    kind: SCAN_RECEIPT_KIND,
    status: "passed",
    observationSha256: sha256Bytes(observationBytes),
    candidateDigest: artifact.candidate.candidateDigest,
    sourceSha: artifact.sourceSha,
    sourceRef: artifact.sourceRef,
    eventName: artifact.eventName,
    workflowPath: artifact.workflowPath,
    workflowRef: artifact.workflowRef,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    scanner: {
      name: "gitleaks",
      version: GITLEAKS_VERSION,
      wrapperSha256: scanner.wrapperSha256,
      configSha256: scanner.configSha256,
    },
  };
}

export function serializeObservationArtifact(artifact) {
  try {
    const text = `${JSON.stringify(artifact, null, 2)}\n`;
    return Buffer.from(text, "utf8");
  } catch {
    scanFailure("SCAN_INPUT_INVALID");
  }
}

export function scanDependencyObservation({ root = REPOSITORY_ROOT, artifact = null, observationBytes, sourceSha = null, requireSuccessful = false, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null } = {}) {
  if (!Buffer.isBuffer(observationBytes)) scanFailure("SCAN_INPUT_INVALID");
  const parsed = parseObservationScanInput(observationBytes, { artifact, root, sourceSha, requireSuccessful, expectedRunId, expectedRunAttempt, expectedEventName, expectedWorkflowRef });
  const scanner = trustedScannerFiles(root);
  let scanDirectory = null;
  try {
    scanDirectory = materializeScanInput(root, parsed, observationBytes);
    runGitleaksScan(root, scanDirectory, scanner);
    return Object.freeze(scanReceiptForArtifact({ artifact: parsed, observationBytes, scanner }));
  } finally {
    if (scanDirectory) {
      try { rmSync(scanDirectory, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    }
  }
}

export function validateScanReceipt(receipt, { root = REPOSITORY_ROOT, artifact, observationBytes, sourceSha = null, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null, requireSuccessful = true } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) scanFailure("SCAN_RECEIPT_MISSING");
  try {
    exactKeys(receipt, SCAN_RECEIPT_KEYS, "scan receipt");
    exactKeys(receipt.scanner, SCANNER_KEYS, "scan receipt scanner");
  } catch {
    scanFailure("SCAN_RECEIPT_INVALID");
  }
  if (receipt.schemaVersion !== SCAN_RECEIPT_SCHEMA_VERSION || receipt.kind !== SCAN_RECEIPT_KIND || receipt.status !== "passed") scanFailure("SCAN_RECEIPT_INVALID");
  if (!Buffer.isBuffer(observationBytes) || observationBytes.length === 0 || observationBytes.length > MAX_ARTIFACT_BYTES) scanFailure("SCAN_RECEIPT_INVALID");
  let parsedArtifact;
  try {
    parsedArtifact = parseObservationScanInput(observationBytes, { artifact, root, sourceSha, requireSuccessful, expectedRunId, expectedRunAttempt, expectedEventName, expectedWorkflowRef });
  } catch {
    scanFailure("SCAN_RECEIPT_INVALID");
  }
  for (const [key, value] of Object.entries({
    sourceSha: parsedArtifact.sourceSha,
    sourceRef: parsedArtifact.sourceRef,
    eventName: parsedArtifact.eventName,
    workflowPath: parsedArtifact.workflowPath,
    workflowRef: parsedArtifact.workflowRef,
    runId: parsedArtifact.runId,
    runAttempt: parsedArtifact.runAttempt,
  })) {
    if (receipt[key] !== value) scanFailure("SCAN_RECEIPT_MISMATCH");
  }
  if (sourceSha !== null && receipt.sourceSha !== sourceSha) scanFailure("SCAN_RECEIPT_MISMATCH");
  if (receipt.candidateDigest !== parsedArtifact.candidate.candidateDigest) scanFailure("SCAN_RECEIPT_MISMATCH");
  if (receipt.observationSha256 !== sha256Bytes(observationBytes)) scanFailure("SCAN_RECEIPT_MISMATCH");
  try { requireDigest(receipt.observationSha256, "scan observation digest"); } catch { scanFailure("SCAN_RECEIPT_INVALID"); }
  try { requireDigest(receipt.candidateDigest, "scan candidate digest"); } catch { scanFailure("SCAN_RECEIPT_INVALID"); }
  if (receipt.scanner.name !== "gitleaks" || receipt.scanner.version !== GITLEAKS_VERSION) scanFailure("SCAN_RECEIPT_INVALID");
  let scanner;
  try { scanner = trustedScannerFiles(root); } catch { scanFailure("SCAN_RECEIPT_INVALID"); }
  if (receipt.scanner.wrapperSha256 !== scanner.wrapperSha256 || receipt.scanner.configSha256 !== scanner.configSha256) scanFailure("SCAN_RECEIPT_MISMATCH");
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > MAX_SCAN_RECEIPT_BYTES) scanFailure("SCAN_RECEIPT_INVALID");
  return receipt;
}

export function observationReceiptPath(observationPath) {
  return join(dirname(resolve(requireString(observationPath, "observation path"))), SCAN_RECEIPT_FILENAME);
}

export function observationSnapshotPath(observationPath) {
  return join(dirname(resolve(requireString(observationPath, "observation path"))), SCANNED_OBSERVATION_FILENAME);
}

function removeStaleScanFile(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isDirectory()) scanFailure("SCAN_INPUT_INVALID");
    rmSync(filePath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") scanFailure("SCAN_INPUT_INVALID");
  }
}

export function scanAndWriteDependencyObservation({ root = REPOSITORY_ROOT, observationPath, receiptPath = null, snapshotPath = null, sourceSha = null, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null } = {}) {
  const observationFile = resolve(requireString(observationPath, "observation path"));
  const receiptFile = resolve(receiptPath ?? observationReceiptPath(observationFile));
  const snapshotFile = resolve(snapshotPath ?? observationSnapshotPath(observationFile));
  if (snapshotFile === observationFile || receiptFile === observationFile || receiptFile === snapshotFile) scanFailure("SCAN_INPUT_INVALID");
  removeStaleScanFile(receiptFile);
  removeStaleScanFile(snapshotFile);
  try {
    const observationBytes = boundedFileBytes(observationFile);
    const artifact = parseObservationScanInput(observationBytes, { root, sourceSha, expectedRunId, expectedRunAttempt, expectedEventName, expectedWorkflowRef });
    const receipt = scanDependencyObservation({ root, artifact, observationBytes, sourceSha, expectedRunId, expectedRunAttempt, expectedEventName, expectedWorkflowRef });
    writeFileSync(snapshotFile, observationBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { chmodSync(snapshotFile, 0o600); } catch { /* best effort permission tightening */ }
    try { chmodSync(receiptFile, 0o600); } catch { /* best effort permission tightening */ }
    return receipt;
  } catch (error) {
    try { rmSync(snapshotFile, { force: true }); } catch { /* best effort cleanup */ }
    try { rmSync(receiptFile, { force: true }); } catch { /* best effort cleanup */ }
    if (error instanceof DependencyMaintenanceError) throw error;
    scanFailure("SCAN_FAILED");
  }
}

export function validateObservationArtifact(artifact, { root = REPOSITORY_ROOT, sourceSha = null, requireSuccessful = false, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null } = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) fail("dependency observation must be an object", "ARTIFACT_INVALID");
  if (artifact.schemaVersion !== OBSERVATION_SCHEMA_VERSION || artifact.kind !== OBSERVATION_KIND) fail("dependency observation kind or schema is invalid", "ARTIFACT_INVALID");
  requireSha(artifact.sourceSha, "observation source SHA");
  if (sourceSha !== null && artifact.sourceSha !== sourceSha) fail("observation source SHA is stale", "STALE_MAIN");
  if (artifact.workflowPath !== WORKFLOW_PATH || artifact.sourceRef !== SOURCE_REF) fail("observation workflow/ref binding is invalid", "ARTIFACT_BINDING_INVALID");
  if (!["schedule", "workflow_dispatch"].includes(artifact.eventName)) fail("observation event binding is invalid", "ARTIFACT_BINDING_INVALID");
  if (!Number.isSafeInteger(artifact.runId) || artifact.runId < 1 || !Number.isSafeInteger(artifact.runAttempt) || artifact.runAttempt < 1) fail("observation run binding is invalid", "ARTIFACT_BINDING_INVALID");
  if (expectedRunId !== null && Number(artifact.runId) !== Number(expectedRunId)) fail("observation run ID is stale", "ARTIFACT_BINDING_INVALID");
  if (expectedRunAttempt !== null && Number(artifact.runAttempt) !== Number(expectedRunAttempt)) fail("observation run attempt is stale", "ARTIFACT_BINDING_INVALID");
  if (expectedEventName !== null && artifact.eventName !== expectedEventName) fail("observation event is stale", "ARTIFACT_BINDING_INVALID");
  if (expectedWorkflowRef !== null && artifact.workflowRef !== expectedWorkflowRef) fail("observation workflow ref is stale", "ARTIFACT_BINDING_INVALID");
  if (!Array.isArray(artifact.ecosystems) || artifact.ecosystems.length !== ECOSYSTEMS.length || stableJson(artifact.ecosystems.map((entry) => entry.ecosystem).sort()) !== stableJson(ECOSYSTEMS.slice().sort())) fail("observation does not cover all five ecosystems", "ARTIFACT_INVALID");
  const allowedStatuses = new Set(["eligible", "no-update", "manual-review", "compatible"]);
  for (const entry of artifact.ecosystems) {
    if (!allowedStatuses.has(entry.status) && !(entry.status === "blocked" && !requireSuccessful)) fail(`ecosystem ${entry.ecosystem} has an unsuccessful status`, "ARTIFACT_INVALID");
    if (!Array.isArray(entry.observations) || entry.observations.length === 0) fail(`ecosystem ${entry.ecosystem} has no native lookup inventory`, "ARTIFACT_INVALID");
    if (!entry.lookup || !Array.isArray(entry.lookups) || entry.lookups.length === 0) fail(`ecosystem ${entry.ecosystem} has no native lookup receipt`, "ARTIFACT_INVALID");
    if (requireSuccessful && (entry.status === "blocked" || entry.error || entry.observations.some((observation) => ["lookup-failed", "resolution-failed"].includes(observation.status)))) fail(`ecosystem ${entry.ecosystem} contains an unsuccessful native result`, "ARTIFACT_INVALID");
  }
  if (requireSuccessful && artifact.candidate.status !== "eligible") fail("writer requires a successful eligible observation", "CANDIDATE_NOT_ELIGIBLE");
  if (requireSuccessful && artifact.evaluationStatus !== "eligible") fail("writer requires an overall successful eligible evaluation", "ARTIFACT_INVALID");
  exactKeys(artifact.candidate, ["status", "changedPaths", "files", "fileDigests", "candidateDigest"], "candidate");
  if (!["eligible", "no-update", "blocked"].includes(artifact.candidate.status)) fail("candidate status is invalid", "ARTIFACT_INVALID");
  if (!Array.isArray(artifact.candidate.changedPaths) || artifact.candidate.changedPaths.some((relativePath) => !CANDIDATE_PATH_SET.has(relativePath))) fail("candidate path is outside the closed allowlist", "CANDIDATE_PATH_INVALID");
  const paths = [...artifact.candidate.changedPaths].sort();
  if (new Set(paths).size !== paths.length) fail("candidate paths are duplicated", "CANDIDATE_PATH_INVALID");
  const files = artifact.candidate.files;
  const fileDigests = artifact.candidate.fileDigests;
  if (!files || typeof files !== "object" || Array.isArray(files) || !fileDigests || typeof fileDigests !== "object" || Array.isArray(fileDigests)) fail("candidate files and digests must be objects", "ARTIFACT_INVALID");
  if (stableJson(Object.keys(files).sort()) !== stableJson(paths) || stableJson(Object.keys(fileDigests).sort()) !== stableJson(paths)) fail("candidate file set is incomplete or contains extras", "CANDIDATE_PATH_INVALID");
  for (const relativePath of paths) {
    if (typeof files[relativePath] !== "string") fail(`candidate file ${relativePath} must be text`, "ARTIFACT_INVALID");
    requireDigest(fileDigests[relativePath], `candidate ${relativePath} digest`);
    const digest = createHash("sha256").update(files[relativePath], "utf8").digest("hex");
    if (digest !== fileDigests[relativePath]) fail(`candidate ${relativePath} digest does not match bytes`, "ARTIFACT_INVALID");
  }
  requireDigest(artifact.candidate.candidateDigest, "candidate digest");
  if (hashFiles(files) !== artifact.candidate.candidateDigest) fail("candidate aggregate digest does not match bytes", "ARTIFACT_INVALID");
  if (Buffer.byteLength(JSON.stringify(artifact), "utf8") > MAX_ARTIFACT_BYTES) fail("dependency observation exceeds its size bound", "ARTIFACT_TOO_LARGE");
  if (root) {
    const before = readCandidateFiles(root);
    const after = { ...before, ...files };
    validateCandidateFiles({ root, before, after, expectedChangedPaths: paths });
  }
  if (artifact.candidate.status === "eligible" && paths.length === 0) fail("eligible candidate has no changed files", "CANDIDATE_INVALID");
  if (artifact.candidate.status !== "eligible" && paths.length > 0) fail("non-eligible candidate contains changed files", "CANDIDATE_INVALID");
  return artifact;
}

function apiRequest(api, path, method = "GET", body = undefined) {
  if (typeof api === "function") return api(path, { method, body });
  if (api && typeof api.request === "function") return api.request(path, { method, body });
  fail("GitHub API adapter is missing", "API_INVALID");
}

export function createGitHubApi({ token, repository, fetchImpl = globalThis.fetch } = {}) {
  requireString(token, "GitHub token");
  if (!/^[^/]+\/[^/]+$/u.test(repository ?? "")) fail("GitHub repository must be owner/name", "API_INVALID");
  if (typeof fetchImpl !== "function") fail("fetch is unavailable", "API_INVALID");
  return {
    async request(path, { method = "GET", body } = {}) {
      let response;
      try {
        response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2026-03-10",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        fail(`GitHub API ${method} ${path} was ambiguous: ${error.message}`, "AMBIGUOUS_API_WRITE");
      }
      const text = await response.text();
      let value = null;
      if (text) {
        try { value = JSON.parse(text); } catch { value = text; }
      }
      if (!response.ok) {
        const error = new DependencyMaintenanceError(`GitHub API ${method} ${path} failed (${response.status})`, response.status >= 500 || response.status === 409 ? "AMBIGUOUS_API_WRITE" : "API_FAILED");
        error.status = response.status;
        throw error;
      }
      return value;
    },
  };
}

function markerFromBody(body) {
  try { return JSON.parse(body ?? ""); } catch { return null; }
}

async function verifyApiIdentity(api, repository) {
  const repo = await apiRequest(api, "");
  if (!repo || repo.full_name !== repository || !Number.isSafeInteger(Number(repo.id))) fail("GitHub API repository identity is not bound to the target repository", "API_IDENTITY_INVALID");
  return { repo, actor: { login: "github-actions[bot]", source: "authenticated-pr-and-commit-provenance" } };
}

async function verifyCommitProvenance(api, sha, actorLogin) {
  requireSha(sha, "commit SHA");
  const commit = await apiRequest(api, `/commits/${sha}`);
  if (!commit || commit.sha !== sha || !commit.commit?.tree?.sha || !Array.isArray(commit.parents)) fail("GitHub commit provenance is incomplete", "COMMIT_PROVENANCE_INVALID");
  const authenticatedAuthor = commit.author?.login === actorLogin;
  const authenticatedBotCommitter = commit.committer?.login === actorLogin;
  const verifiedWebFlowCommitter = commit.committer?.login === "web-flow"
    && commit.commit?.verification?.verified === true
    && commit.commit?.verification?.reason === "valid";
  if (!authenticatedAuthor || (!authenticatedBotCommitter && !verifiedWebFlowCommitter)) fail("GitHub commit author or authenticated committer is invalid", "COMMIT_PROVENANCE_INVALID");
  return commit;
}

async function fetchBranchCandidate(api, headSha, expectedFiles, expectedDigest) {
  const files = {};
  for (const relativePath of expectedFiles) {
    const response = await apiRequest(api, `/contents/${relativePath}?ref=${encodeURIComponent(headSha)}`);
    if (!response || response.type !== "file" || response.encoding !== "base64" || typeof response.content !== "string") fail(`managed branch file ${relativePath} is not a bounded API file`, "BRANCH_BYTES_INVALID");
    const encoded = response.content.replace(/\s+/gu, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) fail(`managed branch file ${relativePath} is not base64`, "BRANCH_BYTES_INVALID");
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) fail(`managed branch file ${relativePath} has a non-canonical base64 value`, "BRANCH_BYTES_INVALID");
      files[relativePath] = bytes.toString("utf8");
    } catch { fail(`managed branch file ${relativePath} is not base64`, "BRANCH_BYTES_INVALID"); }
  }
  if (hashFiles(files) !== expectedDigest) fail("managed branch bytes do not match the candidate digest", "HUMAN_BRANCH_EDIT");
  return files;
}

function managedMarker({ sourceSha, candidateDigest, changedPaths, actualBotHead, runId, runAttempt, eventName, workflowRef, repository }) {
  return {
    managedBy: MANAGED_BY,
    branch: BOT_BRANCH,
    baseBranch: BASE_BRANCH,
    sourceSha,
    candidateDigest,
    changedPaths: [...changedPaths].sort(),
    actualBotHead,
    origin: { kind: "erpc-sdk-dependency-maintenance-evaluator", repository, workflowPath: WORKFLOW_PATH, sourceSha, runId, runAttempt, eventName, workflowRef },
  };
}

async function createCandidateCommit(api, { sourceSha, candidateFiles, message, previousHead = null }) {
  const sourceCommit = await apiRequest(api, `/git/commits/${sourceSha}`);
  if (!sourceCommit?.tree?.sha) fail("source commit tree is missing", "API_FAILED");
  const tree = [];
  for (const relativePath of Object.keys(candidateFiles).sort()) {
    const blob = await apiRequest(api, "/git/blobs", "POST", { content: Buffer.from(candidateFiles[relativePath], "utf8").toString("base64"), encoding: "base64" });
    if (!blob?.sha) fail(`candidate blob for ${relativePath} is missing`, "API_FAILED");
    tree.push({ path: relativePath, mode: "100644", type: "blob", sha: blob.sha });
  }
  const treeResponse = await apiRequest(api, "/git/trees", "POST", { base_tree: sourceCommit.tree.sha, tree });
  if (!treeResponse?.sha) fail("candidate tree is missing", "API_FAILED");
  const parents = [...new Set([previousHead, sourceSha].filter(Boolean))];
  const commit = await apiRequest(api, "/git/commits", "POST", { message, tree: treeResponse.sha, parents });
  if (!commit?.sha) fail("candidate commit is missing", "API_FAILED");
  return commit.sha;
}

async function getOpenManagedPrs(api, repository) {
  const owner = repository.split("/")[0];
  const query = new URLSearchParams({ state: "open", base: BASE_BRANCH, head: `${owner}:${BOT_BRANCH}`, per_page: "20" });
  const rows = await apiRequest(api, `/pulls?${query.toString()}`);
  if (!Array.isArray(rows)) fail("GitHub pull request listing is invalid", "API_FAILED");
  return rows;
}

async function getMergedManagedPrs(api, repository) {
  const rows = await getClosedManagedPrs(api, repository);
  return rows.filter((row) => row.merged_at || row.mergedAt);
}

async function getClosedManagedPrs(api, repository) {
  const owner = repository.split("/")[0];
  const query = new URLSearchParams({ state: "closed", base: BASE_BRANCH, head: `${owner}:${BOT_BRANCH}`, per_page: "20" });
  const rows = await apiRequest(api, `/pulls?${query.toString()}`);
  if (!Array.isArray(rows)) fail("GitHub closed pull request listing is invalid", "API_FAILED");
  return rows;
}

function verifyPrOwnership(pr, repository, actorLogin) {
  const headRepo = pr?.head?.repo?.full_name ?? pr?.head?.repo?.fullName;
  const baseRepo = pr?.base?.repo?.full_name ?? pr?.base?.repo?.fullName;
  if (headRepo !== repository || baseRepo !== repository || pr.head?.ref !== BOT_BRANCH || pr.base?.ref !== BASE_BRANCH || pr.user?.login !== actorLogin) fail("managed PR ownership or repository binding is invalid", "AMBIGUOUS_OWNERSHIP");
}

async function observeManagedPrAfterAmbiguousWrite(api, repository, actorLogin, { sourceSha, candidateDigest, changedPaths, headSha }) {
  const rows = await getOpenManagedPrs(api, repository);
  const matches = rows.filter((row) => {
    try {
      verifyPrOwnership(row, repository, actorLogin);
      const marker = markerFromBody(row.body);
      return marker?.managedBy === MANAGED_BY && marker.sourceSha === sourceSha && marker.candidateDigest === candidateDigest && marker.actualBotHead === headSha && stableJson(marker.changedPaths ?? []) === stableJson([...changedPaths].sort());
    } catch { return false; }
  });
  if (matches.length > 1) fail("ambiguous managed PR observation after an uncertain write", "AMBIGUOUS_API_WRITE");
  return matches[0] ?? null;
}

function runBindsBase(run, baseSha, headSha) {
  return Boolean(run && run.head_sha === headSha && run.display_title === `CI dependency head=${headSha} base=${baseSha}`);
}

export async function dispatchOrReuseCi(api, { headSha, baseSha, branch = BOT_BRANCH }) {
  const query = new URLSearchParams({ event: "workflow_dispatch", branch, per_page: "50" });
  const listMatching = async () => {
    const listing = await apiRequest(api, `/actions/workflows/${encodeURIComponent(CI_WORKFLOW_PATH)}/runs?${query.toString()}`);
    const runs = Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : [];
    const exact = runs.filter((run) => run.head_sha === headSha && run.head_branch === branch && run.path === CI_WORKFLOW_PATH && run.event === "workflow_dispatch" && runBindsBase(run, baseSha, headSha));
    for (const run of runs) if (run.head_sha === headSha && run.head_branch === branch && run.path === CI_WORKFLOW_PATH && run.event === "workflow_dispatch" && runBindsBase(run, baseSha, headSha) && run.status === "completed" && run.conclusion !== "success") fail("exact-head dependency CI run completed unsuccessfully", "CI_RUN_FAILED");
    return exact.filter((run) => run.status !== "completed" || run.conclusion === "success");
  };
  const matching = await listMatching();
  if (matching.length > 1) fail("multiple exact-head dependency CI runs are ambiguous", "AMBIGUOUS_API_WRITE");
  if (matching.length === 1) return { status: "SAFE_REUSE", runId: matching[0].id, runAttempt: matching[0].run_attempt ?? null };
  try {
    await apiRequest(api, `/actions/workflows/${encodeURIComponent(CI_WORKFLOW_PATH)}/dispatches`, "POST", { ref: branch, inputs: { expected_head_sha: headSha, base_sha: baseSha } });
  } catch (error) {
    if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
    const observed = await listMatching();
    if (observed.length === 1) return { status: "SAFE_REUSE_AFTER_AMBIGUOUS_DISPATCH", runId: observed[0].id, runAttempt: observed[0].run_attempt ?? null };
    throw error;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const after = await listMatching();
    if (after.length > 1) fail("multiple exact-head dependency CI runs are ambiguous", "AMBIGUOUS_API_WRITE");
    if (after.length === 1) return { status: "DISPATCH", runId: after[0].id, runAttempt: after[0].run_attempt ?? null };
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail("CI dispatch was accepted but exact-head/base run observation did not become visible", "AMBIGUOUS_API_WRITE");
}

async function recheckMain(api, sourceSha) {
  const ref = await apiRequest(api, `/git/ref/heads/${BASE_BRANCH}`);
  if (ref?.object?.sha !== sourceSha) fail("main advanced after source binding", "STALE_MAIN");
  return ref;
}

async function readBranchRef(api) {
  try { return await apiRequest(api, `/git/ref/heads/${BOT_BRANCH}`); } catch (error) {
    if (error instanceof DependencyMaintenanceError && error.code === "API_FAILED" && error.status === 404) return null;
    throw error;
  }
}

async function verifyManagedBranch(api, { sourceSha, branchSha, marker, repository, actorLogin }) {
  if (!marker || marker.managedBy !== MANAGED_BY || marker.branch !== BOT_BRANCH || marker.baseBranch !== BASE_BRANCH || marker.actualBotHead !== branchSha || marker.origin?.kind !== "erpc-sdk-dependency-maintenance-evaluator" || marker.origin.repository !== repository || marker.origin.workflowPath !== WORKFLOW_PATH) fail("dependency branch or PR marker is not owned by this writer", "HUMAN_BRANCH_EDIT");
  requireSha(marker.sourceSha, "managed marker source SHA");
  requireDigest(marker.candidateDigest, "managed marker candidate digest");
  if (!Array.isArray(marker.changedPaths) || marker.changedPaths.length === 0 || marker.changedPaths.some((relativePath) => !CANDIDATE_PATH_SET.has(relativePath))) fail("managed marker changed paths are invalid", "HUMAN_BRANCH_EDIT");
  const commit = await verifyCommitProvenance(api, branchSha, actorLogin);
  const compareBase = marker.sourceSha;
  const compare = await apiRequest(api, `/compare/${compareBase}...${branchSha}`);
  const branchPaths = (compare?.files ?? []).map((file) => file.filename).sort();
  if (stableJson(branchPaths) !== stableJson([...marker.changedPaths].sort())) fail("managed branch contains foreign or unexpected files", "HUMAN_BRANCH_EDIT");
  await fetchBranchCandidate(api, branchSha, marker.changedPaths, marker.candidateDigest);
  return commit;
}

export async function writeDependencyPullRequest({ root = REPOSITORY_ROOT, artifact = null, observationBytes = null, receipt = null, sourceSha, repository, token = null, api = null, dispatchCI = true, expectedRunId = null, expectedRunAttempt = null, expectedEventName = null, expectedWorkflowRef = null } = {}) {
  requireSha(sourceSha, "writer source SHA");
  validateCleanCheckout(root, sourceSha);
  if (artifact === null && !Buffer.isBuffer(observationBytes)) scanFailure("SCAN_INPUT_INVALID");
  const exactObservationBytes = Buffer.isBuffer(observationBytes) ? Buffer.from(observationBytes) : serializeObservationArtifact(artifact);
  const scannedArtifact = parseObservationScanInput(exactObservationBytes, {
    artifact,
    root,
    sourceSha,
    requireSuccessful: true,
    expectedRunId,
    expectedRunAttempt,
    expectedEventName,
    expectedWorkflowRef,
  });
  artifact = scannedArtifact;
  validateScanReceipt(receipt, {
    root,
    artifact,
    observationBytes: exactObservationBytes,
    sourceSha,
    expectedRunId,
    expectedRunAttempt,
    expectedEventName,
    expectedWorkflowRef,
    requireSuccessful: true,
  });
  const freshReceipt = scanDependencyObservation({
    root,
    artifact,
    observationBytes: exactObservationBytes,
    sourceSha,
    requireSuccessful: true,
    expectedRunId,
    expectedRunAttempt,
    expectedEventName,
    expectedWorkflowRef,
  });
  if (stableJson(receipt) !== stableJson(freshReceipt)) scanFailure("SCAN_RECEIPT_MISMATCH");
  if (artifact.candidate.status !== "eligible") fail(`candidate status ${artifact.candidate.status} is not writable`, "CANDIDATE_NOT_ELIGIBLE");
  const client = api ?? createGitHubApi({ token, repository });
  const identity = await verifyApiIdentity(client, repository);
  await recheckMain(client, sourceSha);
  const prs = await getOpenManagedPrs(client, repository);
  if (prs.length > 1) fail("multiple open dependency maintenance PRs are ambiguous", "AMBIGUOUS_OWNERSHIP");
  for (const pr of prs) verifyPrOwnership(pr, repository, identity.actor.login);
  const closedPrs = prs.length === 0 ? await getClosedManagedPrs(client, repository) : [];
  const mergedPrs = closedPrs.filter((row) => row.merged_at || row.mergedAt);
  const closedUnmerged = closedPrs.filter((row) => !(row.merged_at || row.mergedAt));
  if (closedUnmerged.length > 0) fail("closed unmerged dependency PR ownership is ambiguous", "AMBIGUOUS_OWNERSHIP");
  for (const pr of mergedPrs) {
    verifyPrOwnership(pr, repository, identity.actor.login);
    const marker = markerFromBody(pr.body);
    if (!marker || marker.managedBy !== MANAGED_BY || marker.branch !== BOT_BRANCH || marker.baseBranch !== BASE_BRANCH || marker.origin?.kind !== "erpc-sdk-dependency-maintenance-evaluator" || marker.origin.repository !== repository || marker.origin.workflowPath !== WORKFLOW_PATH) fail("merged dependency PR marker is not owned by this writer", "AMBIGUOUS_OWNERSHIP");
  }
  const mergedPr = mergedPrs.slice().sort((left, right) => String(right.merged_at ?? right.mergedAt ?? "").localeCompare(String(left.merged_at ?? left.mergedAt ?? "")))[0] ?? null;
  let branchRef = await readBranchRef(client);
  let headSha;
  let pr;
  let action;
  const changedPaths = artifact.candidate.changedPaths;
  if (!branchRef) {
    if (prs.length > 0) fail("managed PR exists but its branch is missing", "AMBIGUOUS_OWNERSHIP");
    await recheckMain(client, sourceSha);
    headSha = await createCandidateCommit(client, { sourceSha, candidateFiles: artifact.candidate.files, message: `chore(deps): refresh bounded dependency cohort\n\nManaged-By: ${MANAGED_BY}\nDependency-Base: ${sourceSha}\nDependency-Source: ${sourceSha}` });
    await recheckMain(client, sourceSha);
    let createdRef;
    try { createdRef = await apiRequest(client, "/git/refs", "POST", { ref: BOT_BRANCH_REF, sha: headSha }); } catch (error) {
      if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
      const observed = await readBranchRef(client);
      if (!observed || observed.object?.sha !== headSha) throw error;
      createdRef = observed;
    }
    if (createdRef?.object?.sha !== headSha) fail("created dependency branch did not bind to its commit", "AMBIGUOUS_API_WRITE");
    await verifyCommitProvenance(client, headSha, identity.actor.login);
    await fetchBranchCandidate(client, headSha, changedPaths, artifact.candidate.candidateDigest);
    await recheckMain(client, sourceSha);
    const body = JSON.stringify(managedMarker({ sourceSha, candidateDigest: artifact.candidate.candidateDigest, changedPaths, actualBotHead: headSha, runId: artifact.runId, runAttempt: artifact.runAttempt, eventName: artifact.eventName, workflowRef: artifact.workflowRef, repository }), null, 2);
    try {
      pr = await apiRequest(client, "/pulls", "POST", { title: "chore(deps): weekly five-language dependency maintenance", head: BOT_BRANCH, base: BASE_BRANCH, body });
    } catch (error) {
      if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
      pr = await observeManagedPrAfterAmbiguousWrite(client, repository, identity.actor.login, { sourceSha, candidateDigest: artifact.candidate.candidateDigest, changedPaths, headSha });
      if (!pr) throw error;
    }
    verifyPrOwnership(pr, repository, identity.actor.login);
    action = "CREATE";
  } else {
    if (!branchRef.object?.sha) fail("dependency branch reference is invalid", "API_FAILED");
    if (prs.length === 1) pr = prs[0];
    else if (prs.length === 0 && mergedPr) pr = mergedPr;
    else fail("existing dependency branch has no uniquely owned PR", "AMBIGUOUS_OWNERSHIP");
    await verifyCommitProvenance(client, branchRef.object.sha, identity.actor.login);
    const marker = markerFromBody(pr.body);
    await verifyManagedBranch(client, { sourceSha, branchSha: branchRef.object.sha, marker, repository, actorLogin: identity.actor.login });
    if (marker.sourceSha === sourceSha && marker.candidateDigest === artifact.candidate.candidateDigest && stableJson(marker.changedPaths ?? []) === stableJson(changedPaths)) {
      await fetchBranchCandidate(client, branchRef.object.sha, changedPaths, artifact.candidate.candidateDigest);
      headSha = branchRef.object.sha;
      action = "SAFE_REUSE";
    } else {
      const expectedOldHead = branchRef.object.sha;
      await recheckMain(client, sourceSha);
      const latestBranch = await readBranchRef(client);
      if (!latestBranch || latestBranch.object?.sha !== expectedOldHead) fail("dependency branch advanced during writer preflight", "RACE_HEAD");
      headSha = await createCandidateCommit(client, { sourceSha, previousHead: expectedOldHead, candidateFiles: artifact.candidate.files, message: `chore(deps): advance bounded dependency cohort\n\nManaged-By: ${MANAGED_BY}\nDependency-Base: ${sourceSha}\nDependency-Source: ${sourceSha}` });
      await recheckMain(client, sourceSha);
      try { await apiRequest(client, `/git/refs/heads/${BOT_BRANCH}`, "PATCH", { sha: headSha, force: false }); } catch (error) {
        if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
        const observed = await readBranchRef(client);
        if (!observed || observed.object?.sha !== headSha) throw error;
      }
      const verified = await apiRequest(client, `/git/ref/heads/${BOT_BRANCH}`);
      if (verified?.object?.sha !== headSha) fail("dependency branch update did not bind to the new commit", "AMBIGUOUS_API_WRITE");
      await verifyCommitProvenance(client, headSha, identity.actor.login);
      await fetchBranchCandidate(client, headSha, changedPaths, artifact.candidate.candidateDigest);
      const body = JSON.stringify(managedMarker({ sourceSha, candidateDigest: artifact.candidate.candidateDigest, changedPaths, actualBotHead: headSha, runId: artifact.runId, runAttempt: artifact.runAttempt, eventName: artifact.eventName, workflowRef: artifact.workflowRef, repository }), null, 2);
      if (prs.length === 1) {
        await recheckMain(client, sourceSha);
        try { await apiRequest(client, `/pulls/${encodeURIComponent(String(pr.number))}`, "PATCH", { body }); } catch (error) {
          if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
          const observed = await apiRequest(client, `/pulls/${encodeURIComponent(String(pr.number))}`);
          verifyPrOwnership(observed, repository, identity.actor.login);
          const observedMarker = markerFromBody(observed.body);
          if (!observedMarker || observedMarker.sourceSha !== sourceSha || observedMarker.candidateDigest !== artifact.candidate.candidateDigest || observedMarker.actualBotHead !== headSha) throw error;
        }
        action = "UPDATE";
      } else {
        await recheckMain(client, sourceSha);
        try {
          pr = await apiRequest(client, "/pulls", "POST", { title: "chore(deps): weekly five-language dependency maintenance", head: BOT_BRANCH, base: BASE_BRANCH, body });
        } catch (error) {
          if (!(error instanceof DependencyMaintenanceError) || error.code !== "AMBIGUOUS_API_WRITE") throw error;
          pr = await observeManagedPrAfterAmbiguousWrite(client, repository, identity.actor.login, { sourceSha, candidateDigest: artifact.candidate.candidateDigest, changedPaths, headSha });
          if (!pr) throw error;
        }
        verifyPrOwnership(pr, repository, identity.actor.login);
        action = "CREATE";
      }
    }
  }
  if (dispatchCI) await recheckMain(client, sourceSha);
  const ci = dispatchCI ? await dispatchOrReuseCi(client, { headSha, baseSha: sourceSha }) : null;
  return { action, headSha, baseSha: sourceSha, branch: BOT_BRANCH, pr: { number: pr?.number ?? null, url: pr?.html_url ?? null }, ci, changedPaths, candidateDigest: artifact.candidate.candidateDigest };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replaceAll("-", "_");
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) { values[key] = next; index += 1; }
    else values[key] = true;
  }
  return values;
}

async function cli(argv) {
  const args = parseCli(argv);
  const root = resolve(args.root ?? REPOSITORY_ROOT);
  if (args.command === "evaluate") {
    const artifact = evaluateRepository({ root, sourceSha: args.source_sha ?? null, eventName: args.event_name ?? "schedule", eventRef: args.event_ref ?? SOURCE_REF, workflowRef: args.workflow_ref ?? null, runId: args.run_id ?? null, runAttempt: args.run_attempt ?? null });
    const output = resolve(args.output ?? join(root, "dependency-observation.json"));
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "w" });
    process.stdout.write(`${JSON.stringify({ status: artifact.candidate.status, evaluationStatus: artifact.evaluationStatus, candidateDigest: artifact.candidate.candidateDigest, changedPaths: artifact.candidate.changedPaths })}\n`);
    return artifact.candidate.status === "blocked" ? 2 : 0;
  }
  if (args.command === "scan") {
    const observationPath = resolve(requireString(args.observation ?? args.artifact, "observation"));
    const receiptPath = args.receipt ? resolve(requireString(args.receipt, "receipt")) : observationReceiptPath(observationPath);
    const snapshotPath = args.snapshot ? resolve(requireString(args.snapshot, "snapshot")) : observationSnapshotPath(observationPath);
    const receipt = scanAndWriteDependencyObservation({
      root,
      observationPath,
      receiptPath,
      snapshotPath,
      sourceSha: args.source_sha ?? null,
      expectedRunId: args.run_id ?? null,
      expectedRunAttempt: args.run_attempt ?? null,
      expectedEventName: args.event_name ?? null,
      expectedWorkflowRef: args.workflow_ref ?? null,
    });
    process.stdout.write(`${JSON.stringify({ status: receipt.status, kind: receipt.kind, scanner: receipt.scanner.name, version: receipt.scanner.version })}\n`);
    return 0;
  }
  if (args.command === "write") {
    const observationPath = resolve(requireString(args.artifact, "artifact"));
    const observationBytes = boundedFileBytes(observationPath);
    const artifact = parseJson(boundedUtf8(observationBytes), "dependency observation artifact");
    const receiptPath = args.receipt ? resolve(requireString(args.receipt, "receipt")) : observationReceiptPath(observationPath);
    const receipt = parseJson(boundedUtf8(boundedFileBytes(receiptPath)), "dependency observation scan receipt");
    const result = await writeDependencyPullRequest({ root, artifact, observationBytes, receipt, sourceSha: requireSha(args.source_sha, "source SHA"), repository: requireString(args.repository, "repository"), token: requireString(args.token ?? process.env.GITHUB_TOKEN, "GitHub token"), dispatchCI: args.dispatch_ci !== "false", expectedRunId: args.run_id, expectedRunAttempt: args.run_attempt, expectedEventName: args.event_name, expectedWorkflowRef: args.workflow_ref });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  process.stderr.write("usage: dependency-maintenance.mjs <evaluate|scan|write> [options]\n");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exitCode = await cli(process.argv.slice(2)); } catch (error) {
    const code = /^[A-Z][A-Z0-9_]*$/u.test(String(error?.code ?? "")) ? error.code : "ERROR";
    process.stderr.write(`${code}: dependency maintenance command failed\n`);
    process.exitCode = 1;
  }
}

