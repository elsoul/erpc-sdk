#!/usr/bin/env node

/* CLI boundary for bounded discovery. It only emits reviewable artifacts. */
import { readFile } from "node:fs/promises";
import { discoverCatalog, exitCodeForDiscovery } from "./discovery.mjs";

function usage() {
  return [
    "Usage: node registry/discover-catalog.mjs [options]",
    "",
    "  --output-dir <directory>   write discovery artifacts to a directory",
    "  --config <file>            use a discovery-config JSON file",
    "  --state <file>             resume from a discovery-state JSON file",
    "  --source-sha <40hex>       bind the evidence to a source commit",
    "  --help                     show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!["--output-dir", "--config", "--state", "--source-sha"].includes(argument)) throw new Error(`unknown option ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--output-dir") result.outputDir = value;
    if (argument === "--config") result.config = value;
    if (argument === "--state") result.state = value;
    if (argument === "--source-sha") result.sourceSha = value;
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(`${usage()}\n`); process.exit(0); }
    const artifacts = await discoverCatalog({ ...options, liveEvidence: true });
    process.stdout.write(`${JSON.stringify({
      status: artifacts.receipts.status,
      proposalCount: artifacts.proposals.proposals.length,
      outputDir: options.outputDir ?? null,
      coverage: artifacts.receipts.coverage,
    }, null, 2)}\n`);
    process.exitCode = exitCodeForDiscovery(artifacts);
  } catch (error) {
    process.stderr.write(`${error?.code ?? "DISCOVERY_FAILED"}: ${error?.message ?? "discovery failed"}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs, usage };
