#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  exitCodeForArtifacts,
  observeTokenCatalog,
} from "./observer.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY_DIR = dirname(fileURLToPath(import.meta.url));

const VALUE_OPTIONS = new Set([
  "--output-dir",
]);
const FLAG_OPTIONS = new Set();

function usageError() {
  const error = new Error("usage");
  error.code = "USAGE";
  return error;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (VALUE_OPTIONS.has(option)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw usageError();
      parsed[option.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(option)) {
      parsed[option.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    throw usageError();
  }
  if (!parsed.output_dir) throw usageError();
  return parsed;
}

async function readJson(filePath, optional = false, code = "CONFIG_INVALID") {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    error.code = code;
    throw error;
  }
}

async function gitState(cwd) {
  try {
    const [status, revision] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
    ]);
    return {
      clean: status.stdout.trim().length === 0,
      pinned: /^[0-9a-f]{40}$/u.test(revision.stdout.trim()),
      sourceSha: revision.stdout.trim(),
    };
  } catch {
    return { clean: false, pinned: false, sourceSha: null };
  }
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    process.stderr.write("USAGE\n");
    return 64;
  }
  const catalogPath = resolve(REGISTRY_DIR, "token-catalog.json");
  const configPath = resolve(REGISTRY_DIR, "observer-config.json");
  const priorPath = resolve(REGISTRY_DIR, "maintenance-findings.json");
  const defaultBaseline = resolve(REGISTRY_DIR, "source-baseline.json");
  const baselinePath = defaultBaseline;
  try {
    const [catalog, config, prior, baseline, state] = await Promise.all([
      readJson(catalogPath, false, "CATALOG_INVALID"),
      readJson(configPath, false, "CONFIG_INVALID"),
      readJson(priorPath, true, "PREVIOUS_FINDINGS_INVALID"),
      readJson(baselinePath, true, "BASELINE_INVALID"),
      gitState(process.cwd()),
    ]);
    const artifacts = await observeTokenCatalog({
      catalog,
      config,
      priorFindings: prior,
      baseline,
      outputDir: resolve(args.output_dir),
      sourceSha: process.env.ERPC_OBSERVER_SOURCE_SHA ?? state.sourceSha ?? undefined,
      workspace: {
        clean: state.clean,
        pinned: state.pinned,
      },
    });
    return exitCodeForArtifacts(artifacts);
  } catch (error) {
    const code = error?.code === "USAGE" ? "USAGE" : error?.code ?? "INTERNAL_ERROR";
    process.stderr.write(`${code}\n`);
    return code === "CONFIG_INVALID" || code === "CONFIG_URL_SET_MISMATCH" || code === "CONFIG_RPC_INVALID" || code === "CATALOG_INVALID" || code === "SOURCE_SHA_INVALID" || code === "BASELINE_INVALID" || code === "PREVIOUS_FINDINGS_INVALID" ? 64 : 70;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}

export { main, parseArgs };
