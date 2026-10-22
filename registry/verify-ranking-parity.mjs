#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RANKINGS, RANKING_CHAIN_IDS, listTokenRankings, validateRankingArtifact } from "./token-rankings.mjs";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KIND = "native-runtime";
export const PARITY_LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
const BEHAVIOR_INPUTS = Object.freeze([
  ...Object.values(RANKING_CHAIN_IDS),
  "",
  "unknown:chain",
  "constructor",
  "toString",
  "__proto__",
]);

function fail(message) { throw new Error(message); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label + " must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(label + " keys are invalid");
}
function expectedBehavior(artifact) {
  return Object.fromEntries(BEHAVIOR_INPUTS.map((chainId) => [chainId, listTokenRankings(chainId, artifact)]));
}
function normalizedSnapshot(snapshot, language) {
  exactKeys(snapshot, ["snapshotVersion", "snapshotKind", "language", "runtime", "metadata", "records", "behavior"], language + " snapshot");
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) fail(language + " snapshotVersion must be " + SNAPSHOT_VERSION);
  if (snapshot.snapshotKind !== SNAPSHOT_KIND) fail(language + " snapshotKind must be " + SNAPSHOT_KIND);
  if (snapshot.language !== language) fail(language + " snapshot language does not match its map key");
  if (typeof snapshot.runtime !== "string" || snapshot.runtime.trim() === "" || snapshot.runtime === "canonical-reference" || snapshot.runtime === "registry-replay" || /^(?:canonical|expected|registry)/u.test(snapshot.runtime)) fail(language + " snapshot runtime must identify an executed native package");
  exactKeys(snapshot.metadata, ["schemaVersion", "metric", "asOf", "contentDigest", "status", "coverage", "sourceIds"], language + ".metadata");
  if (!Array.isArray(snapshot.metadata.coverage) || !Array.isArray(snapshot.metadata.sourceIds)) fail(language + ".metadata arrays are invalid");
  if (!Array.isArray(snapshot.records)) fail(language + ".records must be an array");
  exactKeys(snapshot.behavior, BEHAVIOR_INPUTS, language + ".behavior");
  for (const input of BEHAVIOR_INPUTS) if (!Array.isArray(snapshot.behavior[input])) fail(language + ".behavior." + input + " must be an array");
  return { snapshotVersion: snapshot.snapshotVersion, snapshotKind: snapshot.snapshotKind, language, runtime: snapshot.runtime, metadata: clone(snapshot.metadata), records: clone(snapshot.records), behavior: clone(snapshot.behavior) };
}
export function buildExpectedSnapshot(artifact = RANKINGS) {
  validateRankingArtifact(artifact);
  return { snapshotVersion: SNAPSHOT_VERSION, snapshotKind: SNAPSHOT_KIND, language: "canonical", runtime: "canonical-reference", metadata: clone(artifact.metadata), records: clone(artifact.records), behavior: expectedBehavior(artifact) };
}
export function verifySnapshots(snapshots, artifact = RANKINGS) {
  if (snapshots === null || typeof snapshots !== "object" || Array.isArray(snapshots)) fail("ranking parity snapshots must be an object");
  validateRankingArtifact(artifact);
  const languages = Object.keys(snapshots).sort();
  const expectedLanguages = [...PARITY_LANGUAGES].sort();
  if (languages.length !== expectedLanguages.length || languages.some((language, index) => language !== expectedLanguages[index])) fail("ranking parity requires exactly " + PARITY_LANGUAGES.join(", "));
  const expected = buildExpectedSnapshot(artifact);
  const runtimes = new Set();
  const results = [];
  for (const language of PARITY_LANGUAGES) {
    const normalized = normalizedSnapshot(snapshots[language], language);
    if (runtimes.has(normalized.runtime)) fail("ranking parity runtimes must be unique");
    runtimes.add(normalized.runtime);
    if (stableJson(normalized.metadata) !== stableJson(expected.metadata)) fail(language + " ranking metadata differs from canonical artifact");
    if (stableJson(normalized.records) !== stableJson(expected.records)) fail(language + " ranking records differ from canonical artifact");
    if (stableJson(normalized.behavior) !== stableJson(expected.behavior)) fail(language + " ranking behavior differs from canonical artifact");
    results.push({ language, runtime: normalized.runtime, records: normalized.records.length });
  }
  return { snapshotVersion: SNAPSHOT_VERSION, snapshotKind: SNAPSHOT_KIND, languages: results, status: "ok" };
}
async function loadOne(file) { return JSON.parse(await readFile(file, "utf8")); }
async function loadSnapshots(files) {
  if (files.length === 1) {
    const value = await loadOne(files[0]);
    if (value && typeof value === "object" && !Array.isArray(value) && value.snapshots) return value.snapshots;
    if (value && typeof value === "object" && !Array.isArray(value) && value.language) return { [value.language]: value };
    return value;
  }
  const output = {};
  for (const file of files) {
    const value = await loadOne(file);
    const snapshot = value?.snapshot ?? value;
    if (!snapshot || typeof snapshot.language !== "string") fail("each --snapshot file must contain one native snapshot");
    if (Object.hasOwn(output, snapshot.language)) fail("duplicate ranking parity language " + snapshot.language);
    output[snapshot.language] = snapshot;
  }
  return output;
}
async function expandOutputPath(value) {
  const metadata = await stat(value);
  if (!metadata.isDirectory()) return [value];
  return Promise.all(PARITY_LANGUAGES.map(async (language) => {
    const candidate = path.join(value, language + ".json");
    try { await stat(candidate); return candidate; } catch { return path.join(value, language + "-ranking-snapshot.json"); }
  }));
}
function parseArguments(argumentsList) {
  const files = [];
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--snapshots" || argument === "--snapshot") {
      if (index + 1 >= argumentsList.length) fail(argument + " needs a file");
      files.push(argumentsList[index + 1]); index += 1; continue;
    }
    if (argument === "--format=json") { json = true; continue; }
    if (argument.startsWith("--")) fail("unknown option " + argument);
    fail("unexpected argument " + argument);
  }
  return { files, json };
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  let files = options.files;
  if (files.length === 0 && process.env.ERPC_SDK_RANKING_PARITY_OUTPUT) files = await expandOutputPath(process.env.ERPC_SDK_RANKING_PARITY_OUTPUT);
  if (files.length === 0) fail("explicit native ranking snapshots are required via --snapshot/--snapshots or ERPC_SDK_RANKING_PARITY_OUTPUT");
  const result = verifySnapshots(await loadSnapshots(files));
  process.stdout.write(options.json ? JSON.stringify(result) + "\n" : "native token ranking parity OK: " + result.languages.map((entry) => entry.language + " (" + entry.records + ")").join(", ") + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write("verify-ranking-parity: " + error.message + "\n"); process.exitCode = 1; });
}
