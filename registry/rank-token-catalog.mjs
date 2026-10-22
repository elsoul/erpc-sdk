#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import rankingConfig from "./ranking-config.json" with { type: "json" };
import { RANKING_CHAIN_IDS, collectRankingReceipts, replayRankings, validateRankingConfig } from "./token-rankings.mjs";

const REGISTRY_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.dirname(REGISTRY_DIRECTORY);

function fail(message) { throw new Error(message); }
function usage() {
  return [
    "Usage: node registry/rank-token-catalog.mjs [options]",
    "",
    "  --snapshot <file>       replay raw RPC ranking receipts",
    "  --source-sha <40hex>    bind raw receipts to a source commit",
    "  --metric <metric>       select an approved ranking metric",
    "  --config <file>         use a bounded ranking-config JSON file",
    "  --chain-id <chain>      collect or replay one chain",
    "  --receipts <file>       write ranking-receipts.json",
    "  --format=json           print the ranking artifact",
  ].join("\n");
}
function parseArgs(argv) {
  const result = { format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--format=json") { result.format = "json"; continue; }
    if (!["--snapshot", "--source-sha", "--metric", "--chain-id", "--config", "--receipts"].includes(argument)) {
      if (argument === "--help") return { help: true };
      fail("unknown option " + argument);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) fail(argument + " requires a value");
    result[argument.slice(2).replaceAll("-", "_")] = argv[index + 1];
    index += 1;
  }
  return result;
}
async function load(file) { return JSON.parse(await readFile(file, "utf8")); }
function safeOutputPath(file) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) fail("--receipts must be a valid file path");
  return path.resolve(file);
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage() + "\n"); return; }
  if (args.chain_id !== undefined && !Object.values(RANKING_CHAIN_IDS).includes(args.chain_id)) fail("--chain-id must be a configured chain ID");
  const config = args.config ? await load(args.config) : rankingConfig;
  validateRankingConfig(config);
  const receiptsPath = args.receipts ? safeOutputPath(args.receipts) : null;
  const raw = args.snapshot
    ? await load(args.snapshot)
    : await collectRankingReceipts({ chainId: args.chain_id, metric: args.metric, sourceSha: args.source_sha, config });
  const artifact = replayRankings(raw, { sourceSha: args.source_sha, metric: args.metric, config });
  if (receiptsPath) {
    try {
      await writeFile(receiptsPath, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") fail("--receipts refuses to overwrite an existing file or symlink");
      throw error;
    }
  }
  process.stdout.write(args.format === "json" ? JSON.stringify(artifact, null, 2) + "\n" : "token ranking status: " + artifact.metadata.status + ", records=" + artifact.records.length + ", unranked=" + artifact.unranked.length + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write("rank-token-catalog: " + error.message + "\n"); process.exitCode = 1; });
}
export { main, parseArgs, usage };
