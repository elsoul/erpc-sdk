#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, lstat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  CONTRACT,
  LANGUAGES,
  OUTPUTS,
  computeDigest,
  runtimeProjection,
  validateContract,
} from "./rpc-network-contract.mjs";
import {
  RUST_ARTIFACT_IDENTITY,
  validateSingleSnapshot,
} from "./verify-rpc-network-parity.mjs";

export { LANGUAGES, OUTPUTS };

const REGISTRY_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.dirname(REGISTRY_DIRECTORY);

function cliError(message) {
  throw new Error(message);
}

function languageValue(value) {
  if (typeof value !== "string" || !LANGUAGES.includes(value)) cliError(`unknown language ${value}; expected ${LANGUAGES.join(", ")}`);
  return value;
}

function jsonLiteral() {
  return JSON.stringify(runtimeProjection(), null, 2);
}

function quotePython(value) {
  return JSON.stringify(value).replace(/\\u2028/gu, "\\u2028").replace(/\\u2029/gu, "\\u2029");
}

function pythonPayloadLines(value) {
  const indentation = "    ";
  const maxLineLength = 100;
  const lines = [];
  let chunk = "";
  const units = [];
  const hostPattern = /^https:\/\/[A-Za-z0-9.-]+\.erpc\.global/u;
  for (let index = 0; index < value.length;) {
    const host = value.slice(index).match(hostPattern);
    if (host !== null) {
      units.push(host[0]);
      index += host[0].length;
      continue;
    }
    const codePoint = value.codePointAt(index);
    let unitLength = codePoint > 0xffff ? 2 : 1;
    if (value[index] === "\\") unitLength = value[index + 1] === "u" ? 6 : 2;
    units.push(value.slice(index, index + unitLength));
    index += unitLength;
  }
  for (const unit of units) {
    const candidate = chunk + unit;
    if (chunk !== "" && `${indentation}${quotePython(candidate)}`.length > maxLineLength) {
      lines.push(`${indentation}${quotePython(chunk)}`);
      chunk = unit;
    } else {
      chunk = candidate;
    }
  }
  if (chunk !== "") lines.push(`${indentation}${quotePython(chunk)}`);
  return lines;
}

function contractClient(clientContractId) {
  const client = CONTRACT.clientContracts.find((entry) => entry.clientContractId === clientContractId);
  if (client === undefined) cliError(`canonical contract is missing ${clientContractId}`);
  return client;
}

function hostedPublicDefault(clientContractId) {
  const client = contractClient(clientContractId);
  const hosted = client.endpointModes.find((entry) => entry.mode === "hosted");
  if (typeof hosted?.publicDefault !== "string" || hosted.publicDefault === "") {
    cliError(`canonical contract is missing a hosted public default for ${clientContractId}`);
  }
  return hosted.publicDefault;
}

function wireOperations(clientContractId) {
  const client = contractClient(clientContractId);
  const methodSet = CONTRACT.methodSets.find((entry) => entry.methodSetId === client.methodSetId);
  if (methodSet === undefined) cliError(`canonical contract is missing ${client.methodSetId}`);
  const operations = methodSet.capabilities.map((capability) => capability.wireOperation);
  if (operations.some((operation) => typeof operation !== "string" || operation === "")) {
    cliError(`canonical contract has an invalid wire operation in ${methodSet.methodSetId}`);
  }
  return operations;
}

function goStringSlice(values) {
  return [
    "[]string{",
    ...values.map((value) => `\t${JSON.stringify(value)},`),
    "}",
  ].join("\n");
}

function goArrayLiteral(values) {
  return [
    "[...]string{",
    ...values.map((value) => `\t${JSON.stringify(value)},`),
    "}",
  ].join("\n");
}

function goIdentifier(value) {
  return value.split(/[^a-z0-9]+/iu).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function goClientFacts() {
  return CONTRACT.clientContracts
    .filter((client) => client.surfaceClass !== "legacy-reference" && client.clientContractId !== "client-bitcoin-rpc")
    .map((client) => {
      const stem = goIdentifier(client.chainKey.replace(/-(?:pos|one|chain|hyperevm)$/u, ""));
      const methodStem = client.chainKey === "sui" ? "SuiGRPCWeb" : stem;
      const methodSet = CONTRACT.methodSets.find((entry) => entry.methodSetId === client.methodSetId);
      const hosted = client.endpointModes.find((entry) => entry.mode === "hosted");
      if (methodSet === undefined || typeof hosted?.publicDefault !== "string") {
        cliError(`canonical contract is missing generated Go facts for ${client.clientContractId}`);
      }
      return {
        clientContractId: client.clientContractId,
        stem,
        methodStem,
        endpoint: hosted.publicDefault,
        methods: methodSet.capabilities.map((capability) => capability.wireOperation),
      };
    });
}

export function renderLanguage(language) {
  languageValue(language);
  const payload = jsonLiteral();
  const digest = CONTRACT.contentDigest;
  if (language === "typescript") {
    return [
      "/* Generated by registry/generate-rpc-network-contract.mjs. Do not edit. */",
      `export const RPC_NETWORK_CONTRACT_DIGEST = ${JSON.stringify(digest)} as const;`,
      `export const RPC_NETWORK_CONTRACT = ${payload} as const;`,
      "",
    ].join("\n");
  }
  if (language === "rust") {
    const raw = payload.replaceAll('"', '\\"');
    return [
      "// Generated by registry/generate-rpc-network-contract.mjs. Do not edit.",
      `pub const RPC_NETWORK_CONTRACT_DIGEST: &str = ${JSON.stringify(digest)};`,
      `pub const RPC_NETWORK_CONTRACT_JSON: &str = "${raw}";`,
      "",
    ].join("\n");
  }
  if (language === "python") {
    const payloadLines = pythonPayloadLines(payload);
    return [
      "# Generated by registry/generate-rpc-network-contract.mjs. Do not edit.",
      "import json as _json",
      "",
      `RPC_NETWORK_CONTRACT_DIGEST = ${JSON.stringify(digest)}`,
      "RPC_NETWORK_CONTRACT = _json.loads(",
      ...payloadLines,
      ")",
      "",
    ].join("\n");
  }
  if (language === "go") {
    const clients = goClientFacts();
    const bitcoinMethods = wireOperations("client-bitcoin-rpc");
    const endpointLines = clients.map(({ stem, endpoint }) => `const Default${stem}Endpoint = ${JSON.stringify(endpoint)}`);
    const publicSlices = clients.map(({ methodStem, methods }) => `var ${methodStem}${methodStem === "SuiGRPCWeb" ? "Methods" : "RPCMethods"} = ${goStringSlice(methods)}`);
    const privateArrays = clients.map(({ methodStem, methods }) => `var ${methodStem[0].toLowerCase()}${methodStem.slice(1)}${methodStem === "SuiGRPCWeb" ? "Methods" : "RPCMethods"} = ${goArrayLiteral(methods)}`);
    return [
      "// Generated by registry/generate-rpc-network-contract.mjs. Do not edit.",
      "package erpc",
      "",
      `const rpcNetworkContractDigest = ${JSON.stringify(digest)}`,
      "const rpcNetworkContractJSON = `" + payload.replaceAll("`", "\\u0060") + "`",
      "",
      ...endpointLines,
      "",
      "// Public slices are compatibility views; private arrays are the routing facts.",
      `var BitcoinRPCMethods = ${goStringSlice(bitcoinMethods)}`,
      ...publicSlices,
      "",
      `var bitcoinRPCMethods = ${goArrayLiteral(bitcoinMethods)}`,
      ...privateArrays,
      "",
    ].join("\n");
  }
  return [
    "# Generated by registry/generate-rpc-network-contract.mjs. Do not edit.",
    "require \"json\"",
    "",
    "module ERPC",
    `  RPC_NETWORK_CONTRACT_DIGEST = ${JSON.stringify(digest)}.freeze`,
    `  RPC_NETWORK_CONTRACT = JSON.parse(%q!${payload}!).freeze`,
    "  private_constant :RPC_NETWORK_CONTRACT_DIGEST, :RPC_NETWORK_CONTRACT",
    "end",
    "",
  ].join("\n");
}

function repositoryRoot(root = REPOSITORY_DIRECTORY) {
  return path.resolve(root);
}

export function outputPath(language, root = REPOSITORY_DIRECTORY) {
  languageValue(language);
  const repository = repositoryRoot(root);
  const relative = OUTPUTS[language];
  if (path.isAbsolute(relative) || relative.includes("..")) cliError(`output path for ${language} is unsafe`);
  const absolute = path.resolve(repository, relative);
  if (path.relative(repository, absolute) !== relative) cliError(`output path for ${language} escapes the repository`);
  return absolute;
}

async function assertNoSymlinkComponents(root, target, language, { requireParent = false } = {}) {
  const repository = repositoryRoot(root);
  const relative = path.relative(repository, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) cliError(`resolved ${language} destination escapes the repository`);
  const components = relative.split(path.sep).filter(Boolean);
  let current = repository;
  try {
    const rootStat = await lstat(current);
    if (rootStat.isSymbolicLink()) cliError(`repository root for ${language} may not be a symlink`);
  } catch (error) {
    cliError(`cannot inspect repository root for ${language}: ${error.message}`);
  }
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) cliError(`generated ${language} path contains a symlink component: ${path.relative(repository, current)}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (requireParent && index < components.length - 1) cliError(`target parent for ${language} does not exist: ${path.relative(repository, current)}`);
        return current;
      }
      throw error;
    }
  }
  return target;
}

async function assertParent(root, language) {
  const target = outputPath(language, root);
  await assertNoSymlinkComponents(root, target, language, { requireParent: true });
  const parent = path.dirname(target);
  try {
    const stat = await lstat(parent);
    if (!stat.isDirectory()) cliError(`target parent for ${language} is not a directory`);
  } catch (error) {
    if (error?.code === "ENOENT") cliError(`target parent for ${language} does not exist; package owner must create it`);
    throw error;
  }
  return target;
}

async function ensureNotSymlink(target, language) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) cliError(`generated ${language} destination may not be a symlink`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function checkLanguage(language, root = REPOSITORY_DIRECTORY) {
  const target = outputPath(language, root);
  await assertNoSymlinkComponents(root, target, language, { requireParent: true });
  await ensureNotSymlink(target, language);
  let actual;
  try {
    actual = await readFile(target);
  } catch (error) {
    if (error?.code === "ENOENT") cliError(`generated ${language} file is missing: ${path.relative(repositoryRoot(root), target)}`);
    throw error;
  }
  const expected = Buffer.from(renderLanguage(language), "utf8");
  if (!actual.equals(expected)) cliError(`generated ${language} file differs from the canonical renderer`);
  return `${language}: OK (${expected.length} bytes)`;
}

export async function writeLanguage(language, root = REPOSITORY_DIRECTORY) {
  const target = await assertParent(root, language);
  await ensureNotSymlink(target, language);
  const expected = Buffer.from(renderLanguage(language), "utf8");
  let actual = null;
  try { actual = await readFile(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (actual?.equals(expected)) return `${language}: unchanged (${expected.length} bytes)`;
  await writeFile(target, expected, { flag: "w" });
  return `${language}: wrote ${expected.length} bytes`;
}

function parseArguments(argumentsList) {
  const options = { write: false, check: false, language: null, help: false, rustArtifactEvidence: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--write") {
      if (options.write) cliError("--write may be provided only once");
      options.write = true;
    } else if (argument === "--check") {
      if (options.check) cliError("--check may be provided only once");
      options.check = true;
    } else if (argument === "--language") {
      if (options.language !== null) cliError("--language may be provided only once");
      options.language = argumentsList[++index];
      if (!options.language || options.language.startsWith("--")) cliError("--language requires a value");
    } else if (argument === "--rust-artifact-evidence") {
      if (options.rustArtifactEvidence !== null) cliError("--rust-artifact-evidence may be provided only once");
      options.rustArtifactEvidence = argumentsList[++index];
      if (!options.rustArtifactEvidence || options.rustArtifactEvidence.startsWith("--")) cliError("--rust-artifact-evidence requires a receipt path");
    } else if (argument === "--help") {
      options.help = true;
    } else {
      cliError(`unknown option ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.write === options.check) cliError("choose exactly one of --write or --check");
  if (options.language === null) cliError("--language is required");
  if (options.write && options.language === "all") cliError("--write cannot target all languages");
  if (options.check && options.language !== "all") languageValue(options.language);
  if (options.check && options.language !== "all" && !LANGUAGES.includes(options.language)) languageValue(options.language);
  if (options.write) languageValue(options.language);
  if (options.rustArtifactEvidence !== null && (!options.check || !["all", "rust"].includes(options.language))) cliError("--rust-artifact-evidence requires --check --language all or rust");
  if (options.check && options.language === "all" && options.rustArtifactEvidence === null) cliError("--check --language all requires --rust-artifact-evidence <receipt.json>");
  if (options.check && options.language === "rust" && options.rustArtifactEvidence === null) cliError("Rust projection check requires --rust-artifact-evidence <receipt.json>; no in-tree Rust projection is required");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node registry/generate-rpc-network-contract.mjs --write --language <typescript|rust|python|go|ruby>",
    "  node registry/generate-rpc-network-contract.mjs --check --language all --rust-artifact-evidence <receipt.json>",
    "  node registry/generate-rpc-network-contract.mjs --check --language <typescript|python|go|ruby>",
    "  Rust evidence binds the actual crate bytes and native snapshot; the Rust generated source file is intentionally not required.",
  ].join("\n");
}

function receiptSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactReceiptKeys(value) {
  const keys = ["version", "evidenceDirectory", "rustCratePath", "rustSnapshotPath", "rustRenderSha256", "rustSnapshotFileSha256", "contractDigest", "fixtureDigest"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) cliError("Rust evidence receipt must be an object");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) cliError(`Rust evidence receipt has unknown field ${unknown[0]}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) cliError(`Rust evidence receipt is missing ${key}`);
}

async function boundedEvidencePath(receiptFile, evidenceDirectory, relativeFile, label) {
  if (typeof evidenceDirectory !== "string" || evidenceDirectory === "" || path.isAbsolute(evidenceDirectory) || evidenceDirectory.split(/[\\/]/u).includes("..")) cliError(`${label} evidenceDirectory must be a bounded relative path`);
  if (typeof relativeFile !== "string" || relativeFile === "" || path.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/u).includes("..")) cliError(`${label} path must be a bounded relative path`);
  const receiptDirectory = path.dirname(path.resolve(receiptFile));
  const root = path.resolve(receiptDirectory, evidenceDirectory);
  const target = path.resolve(root, relativeFile);
  if (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target))) cliError(`${label} path escapes the selected evidence directory`);
  let current = receiptDirectory;
  for (const component of path.relative(receiptDirectory, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) cliError(`${label} path contains a symlink component`);
    } catch (error) {
      if (error?.code === "ENOENT") cliError(`${label} path component does not exist`);
      throw error;
    }
  }
  return target;
}

export async function checkRustArtifactEvidence(receiptFile) {
  let receipt;
  try { receipt = JSON.parse(await readFile(path.resolve(receiptFile), "utf8")); } catch (error) { cliError(`cannot read Rust evidence receipt ${receiptFile}: ${error.message}`); }
  exactReceiptKeys(receipt);
  if (receipt.version !== 1) cliError("Rust evidence receipt version is unsupported");
  if (!/^[0-9a-f]{64}$/u.test(receipt.rustRenderSha256) || !/^[0-9a-f]{64}$/u.test(receipt.rustSnapshotFileSha256)) cliError("Rust evidence receipt hashes must be lowercase SHA-256");
  if (receipt.contractDigest !== CONTRACT.contentDigest) cliError("Rust evidence receipt contract digest differs from the final contract");
  const cratePath = await boundedEvidencePath(receiptFile, receipt.evidenceDirectory, receipt.rustCratePath, "Rust crate");
  const snapshotPath = await boundedEvidencePath(receiptFile, receipt.evidenceDirectory, receipt.rustSnapshotPath, "Rust snapshot");
  let crateBytes; let snapshotBytes; let snapshot;
  try { crateBytes = await readFile(cratePath); snapshotBytes = await readFile(snapshotPath); snapshot = JSON.parse(snapshotBytes.toString("utf8")); } catch (error) { cliError(`cannot read bounded Rust evidence input: ${error.message}`); }
  if (crateBytes.length !== RUST_ARTIFACT_IDENTITY.crateSizeBytes) cliError("Rust crate size differs from the accepted immutable artifact");
  if (receipt.rustSnapshotFileSha256 !== receiptSha256(snapshotBytes)) cliError("Rust snapshot raw-file hash differs from the receipt");
  if (receipt.rustRenderSha256 !== receiptSha256(Buffer.from(renderLanguage("rust"), "utf8"))) cliError("Rust render hash differs from the final in-memory renderer");
  if (receipt.contractDigest !== CONTRACT.contentDigest) cliError("Rust evidence receipt contract digest differs from the final contract");
  const fixtureModule = await import("./fixtures/rpc-chain-contract-cases.json", { with: { type: "json" } });
  const fixtureValue = fixtureModule.default;
  if (receipt.fixtureDigest !== fixtureValue.fixtureDigest) cliError("Rust evidence receipt fixture digest differs from the final fixture");
  if (receiptSha256(crateBytes) !== RUST_ARTIFACT_IDENTITY.crateSha256) cliError("Rust crate bytes differ from the accepted immutable artifact");
  try {
    validateSingleSnapshot(snapshot, { language: "rust", throughCohort: 5, fixture: fixtureValue, contract: CONTRACT });
  } catch (error) {
    cliError(`Rust native snapshot evidence is invalid: ${error.message}`);
  }
  return `rust-artifact-evidence: OK (${crateBytes.length} crate bytes)`;
}

export async function run(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  validateContract(CONTRACT);
  if (computeDigest(CONTRACT) !== CONTRACT.contentDigest) cliError("canonical contract digest mismatch");
  const languages = options.check && options.language === "rust" ? [] : options.language === "all" ? LANGUAGES.filter((language) => language !== "rust") : [options.language];
  const results = [];
  for (const language of languages) results.push(options.write ? await writeLanguage(language) : await checkLanguage(language));
  if (options.check && options.rustArtifactEvidence !== null) results.push(await checkRustArtifactEvidence(options.rustArtifactEvidence));
  process.stdout.write(`${results.join("\n")}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== null && import.meta.url === invokedPath) run().catch((error) => { process.stderr.write(`generate-rpc-network-contract: ${error.message}\n`); process.exitCode = 1; });
