import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import contract from "./rpc-network-contract.json" with { type: "json" };

export const LANGUAGES = Object.freeze(["typescript", "rust", "python", "go", "ruby"]);
export const COHORTS = Object.freeze([0, 1, 2, 3, 4, 5]);
export const PARITY_LANGUAGES = LANGUAGES;
export const CONTRACT_KEYS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "transportContractVersion",
  "asOfDate",
  "contentDigest",
  "claimBoundaries",
  "methodSets",
  "transportProfiles",
  "clientContracts",
  "networks",
  "compatibilityExceptions",
  "languageBindings",
]);
export const METHOD_SET_KEYS = Object.freeze(["methodSetId", "kind", "catalogRef", "capabilities"]);
export const CAPABILITY_KEYS = Object.freeze([
  "capabilityId",
  "publicOperation",
  "wireOperation",
  "requestEncoding",
  "parameterShape",
  "responseShape",
  "effect",
  "publicNames",
  "parameterPolicy",
  "nativeResultTypes",
]);
export const TRANSPORT_PROFILE_KEYS = Object.freeze([
  "transportProfileId",
  "protocol",
  "targetRule",
  "authPolicy",
  "headerPolicy",
  "attempts",
  "redirectPolicy",
  "retryPolicy",
  "responsePolicy",
  "timeoutPolicy",
  "cancellationPolicy",
  "privacyPolicyId",
]);
export const CLIENT_KEYS = Object.freeze([
  "clientContractId",
  "chainKey",
  "namespace",
  "surfaceClass",
  "protocolFamily",
  "methodSetId",
  "endpointModes",
  "endpointDiagnosticPolicyId",
  "networkIds",
  "forbiddenCapabilities",
  "compatibilityExceptionIds",
  "responsePolicy",
  "nativeBindingStatus",
]);
export const ENDPOINT_MODE_KEYS = Object.freeze(["mode", "transportProfileId", "publicDefault", "defaultTarget", "edgeOverride", "routeRule"]);
export const NETWORK_KEYS = Object.freeze([
  "networkId",
  "chainKey",
  "namespace",
  "clientContractId",
  "provider",
  "selection",
  "identity",
  "cohort",
  "inventoryEvidence",
]);
export const PROVIDER_KEYS = Object.freeze(["id", "chain", "network", "protocols"]);
export const IDENTITY_KEYS = Object.freeze([
  "probe",
  "parameters",
  "projection",
  "expected",
  "secondaryProbe",
  "secondaryParameters",
  "secondaryProjection",
  "secondaryExpected",
  "caip2",
  "evidence",
]);
export const INVENTORY_EVIDENCE_KEYS = Object.freeze(["sourceId", "sourceSha256", "observedAt", "endpointId", "limitations"]);
export const EXCEPTION_KEYS = Object.freeze([
  "exceptionId",
  "language",
  "clientContractId",
  "allowedDifference",
  "evidence",
  "reviewCondition",
]);
export const LANGUAGE_BINDING_KEYS = Object.freeze(["bindingId", "language", "clientContractId", "status", "capabilityIds", "exceptionIds"]);

export const OUTPUTS = Object.freeze({
  typescript: "packages/typescript/src/generated/rpc_network_contract.ts",
  rust: "packages/rust/src/generated/rpc_network_contract.rs",
  python: "packages/python/src/erpc_sdk/_rpc_network_contract_data.py",
  go: "packages/go/rpc_network_contract_generated.go",
  ruby: "packages/ruby/lib/erpc_sdk/generated/rpc_network_contract.rb",
});

export const NETWORK_IDS = Object.freeze([
  "rpc-ethereum-mainnet",
  "rpc-solana-mainnet",
  "rpc-solana-devnet",
  "rpc-solana-testnet",
  "rpc-base-mainnet",
  "rpc-avalanche-c-mainnet",
  "rpc-bitcoin-mainnet",
  "rpc-polygon-pos-mainnet",
  "rpc-kaia-mainnet",
  "rpc-bsc-mainnet",
  "rpc-arbitrum-one-mainnet",
  "rpc-tron-mainnet",
  "rpc-hyperliquid-hyperevm-mainnet",
  "rpc-monad-mainnet",
  "rpc-robinhood-chain-mainnet",
  "rpc-soneium-mainnet",
  "rpc-arc-mainnet",
  "rpc-optimism-mainnet",
  "rpc-sui-mainnet",
  "rpc-near-mainnet",
]);

const EXPECTED_IDENTITIES = Object.freeze({
  "rpc-ethereum-mainnet": "0x1",
  "rpc-solana-mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "rpc-solana-devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "rpc-solana-testnet": "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  "rpc-base-mainnet": "0x2105",
  "rpc-avalanche-c-mainnet": "0xa86a",
  "rpc-bitcoin-mainnet": "main",
  "rpc-polygon-pos-mainnet": "0x89",
  "rpc-kaia-mainnet": "0x2019",
  "rpc-bsc-mainnet": "0x38",
  "rpc-arbitrum-one-mainnet": "0xa4b1",
  "rpc-tron-mainnet": "0x2b6653dc",
  "rpc-hyperliquid-hyperevm-mainnet": "0x3e7",
  "rpc-monad-mainnet": "0x8f",
  "rpc-robinhood-chain-mainnet": "0x1237",
  "rpc-soneium-mainnet": "0x74c",
  "rpc-arc-mainnet": "0x13b2",
  "rpc-optimism-mainnet": "0xa",
  "rpc-sui-mainnet": "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  "rpc-near-mainnet": "mainnet",
});

const EXPECTED_HOSTED_TARGETS = Object.freeze({
  "client-base-rpc": ["https://base.erpc.global/", "https://edge.erpc.global/base"],
  "client-bitcoin-rpc": ["https://edge.erpc.global/bitcoin", null],
  "client-polygon-rpc": ["https://polygon.erpc.global/", "https://edge.erpc.global/polygon"],
  "client-kaia-rpc": ["https://kaia.erpc.global/", "https://edge.erpc.global/kaia"],
  "client-bsc-rpc": ["https://bsc.erpc.global/", "https://edge.erpc.global/bsc"],
  "client-arbitrum-rpc": ["https://arbitrum.erpc.global/", "https://edge.erpc.global/arbitrum"],
  "client-tron-rpc": ["https://tron.erpc.global/", "https://edge.erpc.global/tron"],
  "client-hyperliquid-rpc": ["https://hyperliquid.erpc.global/", "https://edge.erpc.global/hyperliquid"],
  "client-monad-rpc": ["https://monad.erpc.global/", "https://edge.erpc.global/monad"],
  "client-robinhood-rpc": ["https://robinhood.erpc.global/", "https://edge.erpc.global/robinhood"],
  "client-soneium-rpc": ["https://soneium.erpc.global/", "https://edge.erpc.global/soneium"],
  "client-arc-rpc": ["https://arc.erpc.global/", "https://edge.erpc.global/arc"],
  "client-optimism-rpc": ["https://optimism.erpc.global/", "https://edge.erpc.global/optimism"],
  "client-sui-grpc": ["https://sui.erpc.global/", "https://edge.erpc.global/sui"],
  "client-near-rpc": ["https://near.erpc.global/", "https://edge.erpc.global/near"],
});

const EXPECTED_PROVIDER_PAIRS = Object.freeze({
  "rpc-ethereum-mainnet": "644377|eth|mainnet",
  "rpc-solana-mainnet": "656385|sol|solana-mainnet",
  "rpc-solana-devnet": "674924|sol|solana-devnet",
  "rpc-solana-testnet": "674923|sol|solana-testnet",
  "rpc-base-mainnet": "663613|base|base-mainnet",
  "rpc-avalanche-c-mainnet": "655221|avax|avalanche-mainnet",
  "rpc-bitcoin-mainnet": "674926|btc|btc",
  "rpc-polygon-pos-mainnet": "674928|matic|matic",
  "rpc-kaia-mainnet": "674929|kaia|kaia-mainnet",
  "rpc-bsc-mainnet": "674930|bsc|bsc",
  "rpc-arbitrum-one-mainnet": "677317|arb|arbitrum-mainnet",
  "rpc-tron-mainnet": "677323|tron|tron-mainnet",
  "rpc-hyperliquid-hyperevm-mainnet": "677319|hype|hype-mainnet",
  "rpc-monad-mainnet": "677321|monad|monad-mainnet",
  "rpc-robinhood-chain-mainnet": "677327|robinhood|robinhood-mainnet",
  "rpc-soneium-mainnet": "677328|soneium|soneium-mainnet",
  "rpc-arc-mainnet": "677326|arc|arc-mainnet",
  "rpc-optimism-mainnet": "677318|optimism|optimism",
  "rpc-sui-mainnet": "677324|sui|sui-mainnet",
  "rpc-near-mainnet": "677325|near|near-mainnet",
});

const EXPECTED_COHORTS = Object.freeze({
  "rpc-ethereum-mainnet": 0, "rpc-solana-mainnet": 0, "rpc-solana-devnet": 0, "rpc-solana-testnet": 0,
  "rpc-base-mainnet": 1, "rpc-avalanche-c-mainnet": 0, "rpc-bitcoin-mainnet": 1, "rpc-polygon-pos-mainnet": 2,
  "rpc-kaia-mainnet": 3, "rpc-bsc-mainnet": 2, "rpc-arbitrum-one-mainnet": 1, "rpc-tron-mainnet": 5,
  "rpc-hyperliquid-hyperevm-mainnet": 4, "rpc-monad-mainnet": 3, "rpc-robinhood-chain-mainnet": 4,
  "rpc-soneium-mainnet": 3, "rpc-arc-mainnet": 4, "rpc-optimism-mainnet": 2, "rpc-sui-mainnet": 5, "rpc-near-mainnet": 5,
});

const EXPECTED_IDENTITY_PROBES = Object.freeze({
  "rpc-ethereum-mainnet": ["eth_chainId", "$.result"], "rpc-solana-mainnet": ["getGenesisHash", "$.result"], "rpc-solana-devnet": ["getGenesisHash", "$.result"], "rpc-solana-testnet": ["getGenesisHash", "$.result"],
  "rpc-base-mainnet": ["eth_chainId", "$.result"], "rpc-avalanche-c-mainnet": ["eth_chainId", "$.result"], "rpc-bitcoin-mainnet": ["getblockchaininfo.chain", "$.result.chain"], "rpc-polygon-pos-mainnet": ["eth_chainId", "$.result"],
  "rpc-kaia-mainnet": ["eth_chainId", "$.result"], "rpc-bsc-mainnet": ["eth_chainId", "$.result"], "rpc-arbitrum-one-mainnet": ["eth_chainId", "$.result"], "rpc-tron-mainnet": ["eth_chainId", "$.result"],
  "rpc-hyperliquid-hyperevm-mainnet": ["eth_chainId", "$.result"], "rpc-monad-mainnet": ["eth_chainId", "$.result"], "rpc-robinhood-chain-mainnet": ["eth_chainId", "$.result"], "rpc-soneium-mainnet": ["eth_chainId", "$.result"],
  "rpc-arc-mainnet": ["eth_chainId", "$.result"], "rpc-optimism-mainnet": ["eth_chainId", "$.result"], "rpc-sui-mainnet": ["GetServiceInfo.chain_id", "$.chain_id"], "rpc-near-mainnet": ["status.chain_id", "$.result.chain_id"],
});
const EXPECTED_CAIP2 = Object.freeze({
  "rpc-ethereum-mainnet": "eip155:1", "rpc-solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "rpc-base-mainnet": "eip155:8453", "rpc-avalanche-c-mainnet": "eip155:43114", "rpc-polygon-pos-mainnet": "eip155:137", "rpc-kaia-mainnet": "eip155:8217", "rpc-bsc-mainnet": "eip155:56", "rpc-arbitrum-one-mainnet": "eip155:42161", "rpc-hyperliquid-hyperevm-mainnet": "eip155:999", "rpc-monad-mainnet": "eip155:143", "rpc-robinhood-chain-mainnet": "eip155:4663", "rpc-soneium-mainnet": "eip155:1868", "rpc-arc-mainnet": "eip155:5042", "rpc-optimism-mainnet": "eip155:10",
});

const EXPECTED_TRANSPORT_VALUES = Object.freeze({
  "hosted-jsonrpc-query-v1": ["json-rpc-http", "configured-chain-root", "api-key-query", "global-hosted-only", "json-rpc-envelope-v1", "sealed-origin-root-v1"],
  "hosted-bitcoin-bearer-v1": ["json-rpc-http", "shared-resolved-endpoint-plus-bitcoin", "bearer-header-no-query", "replace-global-authorization", "bitcoin-json-rpc-envelope-v1", "sealed-origin-root-v1"],
  "direct-jsonrpc-exact-v1": ["json-rpc-http", "complete-http-target-preserve-path-query", "endpoint-scoped-only", "endpoint-scoped-only", "json-rpc-envelope-v1", "sealed-origin-root-v1"],
  "hosted-sui-grpc-web-v1": ["grpc-web-unary", "hosted-prefix-plus-selected-service-path", "bearer-header", "grpc-web-protocol-and-bearer", "sui-grpc-web-framing-v1", "sealed-origin-root-v1"],
  "direct-sui-grpc-web-prefix-v1": ["grpc-web-unary", "caller-prefix-preserve-path-query-plus-selected-service-path", "endpoint-scoped-only", "grpc-web-protocol-and-endpoint-scoped", "sui-grpc-web-framing-v1", "sealed-origin-root-v1"],
  "unconfigured-local-v1": ["none", "typed-not-configured-before-io", "none", "none", "none", "empty-unavailable-v1"],
});

const EXPECTED_EXCEPTION_BINDINGS = Object.freeze({
  "rust-bitcoin-raw-batch-v1": ["rust", "client-bitcoin-rpc", "Rust retains"],
  "rust-bitcoin-direct-diagnostic-v1": ["rust", "client-bitcoin-rpc", "Rust retains"],
  "typescript-base-unconfigured-placeholder-v1": ["typescript", "client-base-rpc", "Released TypeScript Base retains"],
  "rust-bitcoin-decode-domain-v1": ["rust", "client-bitcoin-rpc", "Rust keeps"],
  "ruby-bitcoin-synchronous-request-v1": ["ruby", "client-bitcoin-rpc", "Ruby has no per-request cancellation API"],
  "ruby-base-synchronous-request-v1": ["ruby", "client-base-rpc", "Ruby has no per-request cancellation API"],
  "ruby-arbitrum-synchronous-request-v1": ["ruby", "client-arbitrum-rpc", "Ruby has no per-request cancellation API"],
  "ruby-polygon-synchronous-request-v1": ["ruby", "client-polygon-rpc", "Ruby has no per-request cancellation API"],
  "ruby-bsc-synchronous-request-v1": ["ruby", "client-bsc-rpc", "Ruby has no per-request cancellation API"],
  "ruby-optimism-synchronous-request-v1": ["ruby", "client-optimism-rpc", "Ruby has no per-request cancellation API"],
  "ruby-kaia-synchronous-request-v1": ["ruby", "client-kaia-rpc", "Ruby has no per-request cancellation API"],
  "ruby-soneium-synchronous-request-v1": ["ruby", "client-soneium-rpc", "Ruby has no per-request cancellation API"],
  "ruby-monad-synchronous-request-v1": ["ruby", "client-monad-rpc", "Ruby has no per-request cancellation API"],
  "ruby-hyperliquid-synchronous-request-v1": ["ruby", "client-hyperliquid-rpc", "Ruby has no per-request cancellation API"],
  "ruby-arc-synchronous-request-v1": ["ruby", "client-arc-rpc", "Ruby has no per-request cancellation API"],
  "ruby-robinhood-synchronous-request-v1": ["ruby", "client-robinhood-rpc", "Ruby has no per-request cancellation API"],
  "ruby-near-synchronous-request-v1": ["ruby", "client-near-rpc", "Ruby has no per-request cancellation API"],
  "ruby-tron-synchronous-request-v1": ["ruby", "client-tron-rpc", "Ruby has no per-request cancellation API"],
  "ruby-sui-synchronous-request-v1": ["ruby", "client-sui-grpc", "Ruby has no per-request cancellation API"],
});

const EXPECTED_CLIENT_TUPLES = Object.freeze({
  "client-ethereum-rpc": ["ethereum", "ethereum.rpc", "legacy-reference", "evm-jsonrpc", "legacy-ethereum-current"],
  "client-solana-rpc": ["solana", "solana.rpc", "legacy-reference", "solana-jsonrpc", "legacy-solana-current"],
  "client-avalanche-rpc": ["avalanche-c", "avalanche.rpc", "legacy-reference", "avalanche-jsonrpc", "legacy-avalanche-current"],
  "client-base-rpc": ["base", "base.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-bitcoin-rpc": ["bitcoin", "bitcoin.rpc", "bounded-binary-read", "bitcoin-jsonrpc", "bitcoin-read12"],
  "client-polygon-rpc": ["polygon-pos", "polygon.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-kaia-rpc": ["kaia", "kaia.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-bsc-rpc": ["bsc", "bsc.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-arbitrum-rpc": ["arbitrum", "arbitrum.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-tron-rpc": ["tron", "tron.rpc", "sealed-read", "tron-evm-compatible-jsonrpc", "sealed-evm-read3"],
  "client-hyperliquid-rpc": ["hyperliquid-hyperevm", "hyperliquid.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-monad-rpc": ["monad", "monad.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-robinhood-rpc": ["robinhood-chain", "robinhood.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-soneium-rpc": ["soneium", "soneium.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-arc-rpc": ["arc", "arc.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-optimism-rpc": ["optimism", "optimism.rpc", "sealed-read", "evm-jsonrpc", "sealed-evm-read3"],
  "client-sui-grpc": ["sui", "sui.grpc", "bounded-binary-read", "sui-grpc-web", "sui-unary3"],
  "client-near-rpc": ["near", "near.rpc", "sealed-read", "near-jsonrpc", "near-read3"],
});

const EXPECTED_DIAGNOSTIC_POLICIES = Object.freeze({
  "client-ethereum-rpc": "legacy-verifier-v1", "client-solana-rpc": "legacy-verifier-v1", "client-avalanche-rpc": "legacy-verifier-v1",
  "client-base-rpc": "sealed-origin-root-v1", "client-bitcoin-rpc": "sealed-origin-root-v1", "client-polygon-rpc": "sealed-origin-root-v1", "client-kaia-rpc": "sealed-origin-root-v1", "client-bsc-rpc": "sealed-origin-root-v1", "client-arbitrum-rpc": "sealed-origin-root-v1", "client-tron-rpc": "sealed-origin-root-v1", "client-hyperliquid-rpc": "sealed-origin-root-v1", "client-monad-rpc": "sealed-origin-root-v1", "client-robinhood-rpc": "sealed-origin-root-v1", "client-soneium-rpc": "sealed-origin-root-v1", "client-arc-rpc": "sealed-origin-root-v1", "client-optimism-rpc": "sealed-origin-root-v1", "client-sui-grpc": "sealed-origin-root-v1", "client-near-rpc": "sealed-origin-root-v1",
});

const NEW_CLIENT_FORBIDDEN = Object.freeze(["raw", "request", "batch", "transport", "websocket", "subscription", "sign", "send", "approve", "broadcast", "swap", "bridge"]);
const EXPECTED_CLIENT_EXCEPTIONS = Object.freeze({
  "client-ethereum-rpc": [], "client-solana-rpc": [], "client-avalanche-rpc": [],
  "client-base-rpc": ["ruby-base-synchronous-request-v1", "typescript-base-unconfigured-placeholder-v1"].sort(),
  "client-bitcoin-rpc": ["ruby-bitcoin-synchronous-request-v1", "rust-bitcoin-decode-domain-v1", "rust-bitcoin-direct-diagnostic-v1", "rust-bitcoin-raw-batch-v1"].sort(),
  "client-polygon-rpc": ["ruby-polygon-synchronous-request-v1"], "client-kaia-rpc": ["ruby-kaia-synchronous-request-v1"], "client-bsc-rpc": ["ruby-bsc-synchronous-request-v1"], "client-arbitrum-rpc": ["ruby-arbitrum-synchronous-request-v1"], "client-tron-rpc": ["ruby-tron-synchronous-request-v1"], "client-hyperliquid-rpc": ["ruby-hyperliquid-synchronous-request-v1"], "client-monad-rpc": ["ruby-monad-synchronous-request-v1"], "client-robinhood-rpc": ["ruby-robinhood-synchronous-request-v1"], "client-soneium-rpc": ["ruby-soneium-synchronous-request-v1"], "client-arc-rpc": ["ruby-arc-synchronous-request-v1"], "client-optimism-rpc": ["ruby-optimism-synchronous-request-v1"], "client-sui-grpc": ["ruby-sui-synchronous-request-v1"], "client-near-rpc": ["ruby-near-synchronous-request-v1"],
});

const EXPECTED_EXCEPTION_TEXTS = Object.freeze({
  "rust-bitcoin-raw-batch-v1": "Rust retains its published Bitcoin raw request and intact batch superset through its legacy namespace; the four new language facades remain named-read only.",
  "rust-bitcoin-direct-diagnostic-v1": "Rust retains its queryless direct path-bearing endpoint diagnostic while removing query, fragment and credential values.",
  "typescript-base-unconfigured-placeholder-v1": "Released TypeScript Base retains https://unconfigured.invalid/base while unavailable on an otherwise keyless client and performs zero I/O.",
  "rust-bitcoin-decode-domain-v1": "Rust keeps its accepted arbitrary-precision Bitcoin decoder and reserved-marker behavior; the new four-language streamed lexical resource limits do not retroactively alter that decoder domain.",
  "ruby-bitcoin-synchronous-request-v1": "Ruby has no per-request cancellation API; the finite exception covers only that absent case and does not relax total deadline, stream cleanup, abort-by-error or no-retry behavior.",
  "ruby-base-synchronous-request-v1": "Ruby has no per-request cancellation API for Base; only that absent case is excluded from the lifecycle probe.",
  "ruby-arbitrum-synchronous-request-v1": "Ruby has no per-request cancellation API for Arbitrum; only that absent case is excluded from the lifecycle probe.",
  "ruby-polygon-synchronous-request-v1": "Ruby has no per-request cancellation API for Polygon; only that absent case is excluded from the lifecycle probe.",
  "ruby-bsc-synchronous-request-v1": "Ruby has no per-request cancellation API for BSC; only that absent case is excluded from the lifecycle probe.",
  "ruby-optimism-synchronous-request-v1": "Ruby has no per-request cancellation API for Optimism; only that absent case is excluded from the lifecycle probe.",
  "ruby-kaia-synchronous-request-v1": "Ruby has no per-request cancellation API for Kaia; only that absent case is excluded from the lifecycle probe.",
  "ruby-soneium-synchronous-request-v1": "Ruby has no per-request cancellation API for Soneium; only that absent case is excluded from the lifecycle probe.",
  "ruby-monad-synchronous-request-v1": "Ruby has no per-request cancellation API for Monad; only that absent case is excluded from the lifecycle probe.",
  "ruby-hyperliquid-synchronous-request-v1": "Ruby has no per-request cancellation API for Hyperliquid; only that absent case is excluded from the lifecycle probe.",
  "ruby-arc-synchronous-request-v1": "Ruby has no per-request cancellation API for Arc; only that absent case is excluded from the lifecycle probe.",
  "ruby-robinhood-synchronous-request-v1": "Ruby has no per-request cancellation API for Robinhood; only that absent case is excluded from the lifecycle probe.",
  "ruby-near-synchronous-request-v1": "Ruby has no per-request cancellation API for NEAR; only that absent case is excluded from the lifecycle probe.",
  "ruby-tron-synchronous-request-v1": "Ruby has no per-request cancellation API for TRON; only that absent case is excluded from the lifecycle probe.",
  "ruby-sui-synchronous-request-v1": "Ruby has no per-request cancellation API for Sui; only that absent case is excluded from the lifecycle probe.",
});

export const FULL_SOLANA_GENESIS = Object.freeze({
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
});

export const BITCOIN_POLICY_ID = "bitcoin-exact-json-v1";
export const BITCOIN_LIMITS = Object.freeze({
  decodedEntityBytes: 67108864,
  containerDepth: 64,
  jsonTokens: 1000000,
  numericLexemeBytes: 1024,
  coefficientDigits: 1000,
  explicitExponentMin: -10000,
  explicitExponentMax: 10000,
  canonicalExponentMin: -10000,
  canonicalExponentMax: 10000,
});

const APPROVED_PUBLIC_NAMES = Object.freeze({
  "bitcoin-estimatesmartfee": { typescript: "estimateSmartFee", rust: "estimate_smart_fee", python: "estimate_smart_fee", go: "EstimateSmartFee", ruby: "estimate_smart_fee" },
  "bitcoin-getbestblockhash": { typescript: "getBestBlockHash", rust: "get_best_block_hash", python: "get_best_block_hash", go: "GetBestBlockHash", ruby: "get_best_block_hash" },
  "bitcoin-getblock": { typescript: "getBlock", rust: "get_block", python: "get_block", go: "GetBlock", ruby: "get_block" },
  "bitcoin-getblockchaininfo": { typescript: "getBlockchainInfo", rust: "get_blockchain_info", python: "get_blockchain_info", go: "GetBlockchainInfo", ruby: "get_blockchain_info" },
  "bitcoin-getblockcount": { typescript: "getBlockCount", rust: "get_block_count", python: "get_block_count", go: "GetBlockCount", ruby: "get_block_count" },
  "bitcoin-getblockhash": { typescript: "getBlockHash", rust: "get_block_hash", python: "get_block_hash", go: "GetBlockHash", ruby: "get_block_hash" },
  "bitcoin-getblockheader": { typescript: "getBlockHeader", rust: "get_block_header", python: "get_block_header", go: "GetBlockHeader", ruby: "get_block_header" },
  "bitcoin-getmempoolinfo": { typescript: "getMempoolInfo", rust: "get_mempool_info", python: "get_mempool_info", go: "GetMempoolInfo", ruby: "get_mempool_info" },
  "bitcoin-getnetworkinfo": { typescript: "getNetworkInfo", rust: "get_network_info", python: "get_network_info", go: "GetNetworkInfo", ruby: "get_network_info" },
  "bitcoin-getrawmempool": { typescript: "getRawMempool", rust: "get_raw_mempool", python: "get_raw_mempool", go: "GetRawMempool", ruby: "get_raw_mempool" },
  "bitcoin-getrawtransaction": { typescript: "getRawTransaction", rust: "get_raw_transaction", python: "get_raw_transaction", go: "GetRawTransaction", ruby: "get_raw_transaction" },
  "bitcoin-gettxout": { typescript: "getTxOut", rust: "get_tx_out", python: "get_tx_out", go: "GetTxOut", ruby: "get_tx_out" },
  "evm-eth-call": { typescript: "eth_call", rust: "eth_call", python: "eth_call", go: "EthCall", ruby: "eth_call" },
  "evm-eth-chain-id": { typescript: "eth_chainId", rust: "eth_chain_id", python: "eth_chain_id", go: "EthChainID", ruby: "eth_chain_id" },
  "evm-eth-get-balance": { typescript: "eth_getBalance", rust: "eth_get_balance", python: "eth_get_balance", go: "EthGetBalance", ruby: "eth_get_balance" },
  "near-status": { typescript: "status", rust: "status", python: "status", go: "Status", ruby: "status" },
  "near-block": { typescript: "block", rust: "block", python: "block", go: "Block", ruby: "block" },
  "near-view-account": { typescript: "viewAccount", rust: "view_account", python: "view_account", go: "ViewAccount", ruby: "view_account" },
  "sui-get-service-info": { typescript: "getServiceInfo", rust: "get_service_info", python: "get_service_info", go: "GetServiceInfo", ruby: "get_service_info" },
  "sui-get-object": { typescript: "getObject", rust: "get_object", python: "get_object", go: "GetObject", ruby: "get_object" },
  "sui-get-balance": { typescript: "getBalance", rust: "get_balance", python: "get_balance", go: "GetBalance", ruby: "get_balance" },
});

const APPROVED_METHOD_TUPLES = Object.freeze({
  "bitcoin-read12": [
    ["bitcoin-estimatesmartfee", "estimateSmartFee", "estimatesmartfee", "positional", "exact-json"],
    ["bitcoin-getbestblockhash", "getBestBlockHash", "getbestblockhash", "none", "string"],
    ["bitcoin-getblock", "getBlock", "getblock", "positional", "exact-json"],
    ["bitcoin-getblockchaininfo", "getBlockchainInfo", "getblockchaininfo", "none", "exact-json"],
    ["bitcoin-getblockcount", "getBlockCount", "getblockcount", "none", "u64-integer"],
    ["bitcoin-getblockhash", "getBlockHash", "getblockhash", "positional", "string"],
    ["bitcoin-getblockheader", "getBlockHeader", "getblockheader", "positional", "exact-json"],
    ["bitcoin-getmempoolinfo", "getMempoolInfo", "getmempoolinfo", "none", "exact-json"],
    ["bitcoin-getnetworkinfo", "getNetworkInfo", "getnetworkinfo", "none", "exact-json"],
    ["bitcoin-getrawmempool", "getRawMempool", "getrawmempool", "positional", "exact-json"],
    ["bitcoin-getrawtransaction", "getRawTransaction", "getrawtransaction", "positional", "exact-json"],
    ["bitcoin-gettxout", "getTxOut", "gettxout", "positional", "nullable-exact-json"],
  ],
  "sealed-evm-read3": [
    ["evm-eth-call", "eth_call", "eth_call", "positional", "raw-hex"],
    ["evm-eth-chain-id", "eth_chainId", "eth_chainId", "none", "raw-hex"],
    ["evm-eth-get-balance", "eth_getBalance", "eth_getBalance", "positional", "raw-hex"],
  ],
  "near-read3": [["near-status", "status", "status", "none", "exact-json"], ["near-block", "block", "block", "fixed-named", "exact-json"], ["near-view-account", "view_account", "query", "fixed-named", "exact-json"]],
  "sui-unary3": [["sui-get-service-info", "getServiceInfo", "/sui.rpc.v2.LedgerService/GetServiceInfo", "none", "bounded-protobuf"], ["sui-get-object", "getObject", "/sui.rpc.v2.LedgerService/GetObject", "fixed-named", "bounded-protobuf"], ["sui-get-balance", "getBalance", "/sui.rpc.v2.StateService/GetBalance", "fixed-named", "bounded-protobuf"]],
});

const APPROVED_NATIVE_RESULT_TYPES = Object.freeze({
  "bitcoin-getblockcount": { typescript: "bigint", rust: "u64", python: "int-u64", go: "uint64", ruby: "Integer-u64" },
  "bitcoin-getbestblockhash": { typescript: "string", rust: "String", python: "str", go: "string", ruby: "String" },
  "bitcoin-getblockhash": { typescript: "string", rust: "String", python: "str", go: "string", ruby: "String" },
  "bitcoin-gettxout": { typescript: "BitcoinJsonValue|null", rust: "serde_json::Value|null", python: "BitcoinJsonValue|None", go: "BitcoinJsonValue|nil", ruby: "BitcoinJsonValue|nil" },
  "evm-eth-call": { typescript: "string", rust: "String", python: "str", go: "string", ruby: "String" },
  "evm-eth-chain-id": { typescript: "string", rust: "String", python: "str", go: "string", ruby: "String" },
  "evm-eth-get-balance": { typescript: "string", rust: "String", python: "str", go: "string", ruby: "String" },
  "near-status": { typescript: "NearStatus", rust: "NearStatus", python: "NearStatus", go: "NearStatus", ruby: "NearStatus" },
  "near-block": { typescript: "NearBlockView", rust: "NearBlockView", python: "NearBlockView", go: "NearBlockView", ruby: "NearBlockView" },
  "near-view-account": { typescript: "NearAccountView", rust: "NearAccountView", python: "NearAccountView", go: "NearAccountView", ruby: "NearAccountView" },
  "sui-get-service-info": { typescript: "SuiServiceInfo", rust: "SuiServiceInfo", python: "SuiServiceInfo", go: "SuiServiceInfo", ruby: "SuiServiceInfo" },
  "sui-get-object": { typescript: "SuiObjectSummary", rust: "SuiObjectSummary", python: "SuiObjectSummary", go: "SuiObjectSummary", ruby: "SuiObjectSummary" },
  "sui-get-balance": { typescript: "SuiBalance", rust: "SuiBalance", python: "SuiBalance", go: "SuiBalance", ruby: "SuiBalance" },
});

export class RpcNetworkContractValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcNetworkContractValidationError";
  }
}

function fail(message) {
  throw new RpcNetworkContractValidationError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label, optional = []) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} has unknown field ${unknown[0]}`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} must be a non-empty single-line string`);
  }
}

function optionalString(value, label) {
  if (value !== undefined) stringValue(value, label);
}

function dateValue(value, label) {
  stringValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail(`${label} must be a real date`);
}

function idValue(value, label) {
  stringValue(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) fail(`${label} must be lowercase kebab-case`);
}

function idList(value, label, allowed = null) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const seen = new Set();
  for (const item of value) {
    idValue(item, `${label} entry`);
    if (seen.has(item)) fail(`${label} contains duplicate ${item}`);
    if (allowed !== null && !allowed.has(item)) fail(`${label} contains unsupported ${item}`);
    seen.add(item);
  }
}

function urlValue(value, label, { allowHttp = false } = {}) {
  stringValue(value, label);
  const pattern = allowHttp ? /^https?:\/\/[^\s#]+$/u : /^https:\/\/[^\s#]+$/u;
  if (!pattern.test(value)) fail(`${label} must be an absolute HTTP(S) URL without a fragment`);
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) fail(`${label} may not contain userinfo or fragment`);
  } catch {
    fail(`${label} must be a valid URL`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortById(values, property) {
  return [...values].sort((left, right) => left[property].localeCompare(right[property]));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalMethodSet(methodSet) {
  if (methodSet.kind === "legacy-reference") {
    return { methodSetId: methodSet.methodSetId, kind: methodSet.kind, catalogRef: methodSet.catalogRef };
  }
  return {
    methodSetId: methodSet.methodSetId,
    kind: methodSet.kind,
    capabilities: [...methodSet.capabilities]
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
      .map((capability) => ({ ...capability })),
  };
}

function canonicalClient(client) {
  const result = { ...client };
  result.endpointModes = [...client.endpointModes]
    .sort((left, right) => left.mode.localeCompare(right.mode))
    .map((mode) => ({ ...mode }));
  result.networkIds = [...client.networkIds].sort();
  result.forbiddenCapabilities = [...client.forbiddenCapabilities].sort();
  result.compatibilityExceptionIds = [...client.compatibilityExceptionIds].sort();
  return result;
}

function canonicalNetwork(network) {
  const { provider: _provider, inventoryEvidence: _inventoryEvidence, identity, ...rest } = network;
  const { evidence: _identityEvidence, ...identityWithoutEvidence } = identity;
  return {
    ...rest,
    identity: identityWithoutEvidence,
  };
}

export function canonicalProjection(value = contract, { validate = true } = {}) {
  if (validate) validateContract(value, { skipDigest: true });
  return canonicalize({
    schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion,
    transportContractVersion: value.transportContractVersion,
    claimBoundaries: value.claimBoundaries,
    methodSets: sortById(value.methodSets, "methodSetId").map(canonicalMethodSet),
    transportProfiles: sortById(value.transportProfiles, "transportProfileId"),
    clientContracts: sortById(value.clientContracts, "clientContractId").map(canonicalClient),
    networks: sortById(value.networks, "networkId").map(canonicalNetwork),
    compatibilityExceptions: sortById(value.compatibilityExceptions, "exceptionId"),
    languageBindings: sortById(value.languageBindings, "bindingId"),
  });
}

export function computeDigest(value = contract) {
  return sha256(JSON.stringify(canonicalProjection(value, { validate: false })));
}

function validateClaimBoundaries(value) {
  const keys = [
    "inventoryIsReadiness",
    "contractIsImplementationProof",
    "generatedProjectionIsNativeExecutionProof",
    "packageStatusIncluded",
    "liveObservationIncluded",
    "supportClaimIncluded",
  ];
  exactKeys(value, keys, "claimBoundaries");
  for (const key of keys) if (value[key] !== false) fail(`claimBoundaries.${key} must be false`);
}

function validateCapability(value, label) {
  exactKeys(value, CAPABILITY_KEYS.slice(0, 7), label, CAPABILITY_KEYS.slice(7));
  idValue(value.capabilityId, `${label}.capabilityId`);
  stringValue(value.publicOperation, `${label}.publicOperation`);
  stringValue(value.wireOperation, `${label}.wireOperation`);
  if (!["json-rpc", "grpc-web-unary"].includes(value.requestEncoding)) fail(`${label}.requestEncoding is unsupported`);
  if (!["none", "positional", "fixed-named"].includes(value.parameterShape)) fail(`${label}.parameterShape is unsupported`);
  stringValue(value.responseShape, `${label}.responseShape`);
  if (value.effect !== "read") fail(`${label}.effect must be read`);
  if (value.publicNames !== undefined) {
    exactKeys(value.publicNames, LANGUAGES, `${label}.publicNames`);
    for (const language of LANGUAGES) stringValue(value.publicNames[language], `${label}.publicNames.${language}`);
  }
  if (value.parameterPolicy !== undefined) {
    exactKeys(value.parameterPolicy, ["kind", "wireParams", "nativeParameterTypes"], `${label}.parameterPolicy`);
    if (!["none", "positional", "fixed-named"].includes(value.parameterPolicy.kind)) fail(`${label}.parameterPolicy.kind is unsupported`);
    if (value.parameterPolicy.kind === "none" && JSON.stringify(value.parameterPolicy.wireParams) !== "[]") fail(`${label}.parameterPolicy none must send []`);
    if (value.parameterPolicy.kind !== "none" && value.parameterPolicy.wireParams !== "positional" && value.parameterPolicy.wireParams !== "fixed-named") fail(`${label}.parameterPolicy wireParams is invalid`);
    exactKeys(value.parameterPolicy.nativeParameterTypes, LANGUAGES, `${label}.parameterPolicy.nativeParameterTypes`);
    for (const language of LANGUAGES) stringValue(value.parameterPolicy.nativeParameterTypes[language], `${label}.parameterPolicy.nativeParameterTypes.${language}`);
  }
  if (value.nativeResultTypes !== undefined) {
    exactKeys(value.nativeResultTypes, LANGUAGES, `${label}.nativeResultTypes`);
    for (const language of LANGUAGES) stringValue(value.nativeResultTypes[language], `${label}.nativeResultTypes.${language}`);
  }
}

function validateMethodSets(value) {
  if (!Array.isArray(value) || value.length !== 7) fail("methodSets must contain exactly seven records");
  const ids = new Set();
  const legacyIds = new Set(["legacy-ethereum-current", "legacy-solana-current", "legacy-avalanche-current"]);
  for (const entry of value) {
    exactKeys(entry, ["methodSetId", "kind"], `methodSets.${entry?.methodSetId ?? "?"}`, ["catalogRef", "capabilities"]);
    idValue(entry.methodSetId, "methodSetId");
    if (ids.has(entry.methodSetId)) fail(`duplicate method set ${entry.methodSetId}`);
    ids.add(entry.methodSetId);
    if (legacyIds.has(entry.methodSetId)) {
      if (entry.kind !== "legacy-reference" || entry.catalogRef !== "scripts/verify-method-parity.mjs" || entry.capabilities !== undefined) {
        fail(`${entry.methodSetId} must be a legacy verifier reference`);
      }
      continue;
    }
    if (entry.kind !== "expanded" || entry.catalogRef !== undefined || !Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
      fail(`${entry.methodSetId} must be an expanded capability set`);
    }
    const capabilityIds = new Set();
    for (const capability of entry.capabilities) {
      validateCapability(capability, `${entry.methodSetId}.capabilities`);
      if (capabilityIds.has(capability.capabilityId)) fail(`duplicate capability ${capability.capabilityId}`);
      capabilityIds.add(capability.capabilityId);
    }
    const approved = APPROVED_METHOD_TUPLES[entry.methodSetId];
    if (approved !== undefined) {
      if (entry.capabilities.length !== approved.length) fail(`${entry.methodSetId} capability count differs from the approved tuple set`);
      for (let index = 0; index < approved.length; index += 1) {
        const [capabilityId, publicOperation, wireOperation, parameterShape, responseShape] = approved[index];
        const capability = entry.capabilities[index];
        if (capability.capabilityId !== capabilityId || capability.publicOperation !== publicOperation || capability.wireOperation !== wireOperation || capability.requestEncoding !== (entry.methodSetId === "sui-unary3" ? "grpc-web-unary" : "json-rpc") || capability.parameterShape !== parameterShape || capability.responseShape !== responseShape || capability.effect !== "read") fail(`${entry.methodSetId} capability tuple ${index} differs from the approved contract`);
        if (APPROVED_PUBLIC_NAMES[capabilityId] !== undefined && JSON.stringify(capability.publicNames) !== JSON.stringify(APPROVED_PUBLIC_NAMES[capabilityId])) fail(`${capabilityId}.publicNames differs from the approved C1 name map`);
        if (APPROVED_PUBLIC_NAMES[capabilityId] !== undefined) {
          if (capability.parameterPolicy === undefined || capability.nativeResultTypes === undefined) fail(`${capabilityId} is missing the approved native parameter/result policy`);
          if (capability.parameterPolicy.kind !== parameterShape) fail(`${capabilityId}.parameterPolicy.kind differs from parameterShape`);
          const expectedNativeParameterTypes = Object.fromEntries(LANGUAGES.map((language) => [language, parameterShape === "none" ? "[]" : parameterShape]));
          if (JSON.stringify(capability.parameterPolicy.nativeParameterTypes) !== JSON.stringify(expectedNativeParameterTypes)) fail(`${capabilityId}.parameterPolicy.nativeParameterTypes differs from the approved language type map`);
          if (JSON.stringify(capability.nativeResultTypes) !== JSON.stringify(APPROVED_NATIVE_RESULT_TYPES[capabilityId] ?? {
            typescript: "BitcoinJsonValue", rust: "serde_json::Value", python: "BitcoinJsonValue", go: "BitcoinJsonValue", ruby: "BitcoinJsonValue",
          })) fail(`${capabilityId}.nativeResultTypes differs from the approved language type map`);
        }
      }
    }
  }
  for (const required of ["bitcoin-read12", "sealed-evm-read3", "near-read3", "sui-unary3"]) {
    if (!ids.has(required)) fail(`missing method set ${required}`);
  }
  const bitcoin = value.find((entry) => entry.methodSetId === "bitcoin-read12");
  if (bitcoin.capabilities.length !== 12) fail("bitcoin-read12 must contain exactly 12 capabilities");
  const bitcoinWire = bitcoin.capabilities.map((entry) => entry.wireOperation);
  if (JSON.stringify(bitcoinWire) !== JSON.stringify([
    "estimatesmartfee", "getbestblockhash", "getblock", "getblockchaininfo", "getblockcount", "getblockhash",
    "getblockheader", "getmempoolinfo", "getnetworkinfo", "getrawmempool", "getrawtransaction", "gettxout",
  ])) fail("bitcoin-read12 wire order differs from the accepted order");
  const evm = value.find((entry) => entry.methodSetId === "sealed-evm-read3");
  if (JSON.stringify(evm.capabilities.map((entry) => entry.wireOperation)) !== JSON.stringify(["eth_call", "eth_chainId", "eth_getBalance"])) {
    fail("sealed-evm-read3 capabilities differ from the accepted order");
  }
  const near = value.find((entry) => entry.methodSetId === "near-read3");
  if (near.capabilities.find((entry) => entry.publicOperation === "view_account")?.wireOperation !== "query") fail("NEAR view_account must map to query");
  const sui = value.find((entry) => entry.methodSetId === "sui-unary3");
  if (sui.capabilities.some((entry) => !entry.wireOperation.startsWith("/sui.rpc.v2."))) fail("Sui wire paths must be exact service paths");
  return ids;
}

function validateTransportProfiles(value) {
  if (!Array.isArray(value) || value.length !== 6) fail("transportProfiles must contain exactly six records");
  const ids = new Set();
  const expected = new Set([
    "hosted-jsonrpc-query-v1", "hosted-bitcoin-bearer-v1", "direct-jsonrpc-exact-v1",
    "hosted-sui-grpc-web-v1", "direct-sui-grpc-web-prefix-v1", "unconfigured-local-v1",
  ]);
  for (const profile of value) {
    exactKeys(profile, TRANSPORT_PROFILE_KEYS, `transportProfiles.${profile?.transportProfileId ?? "?"}`);
    idValue(profile.transportProfileId, "transportProfileId");
    if (ids.has(profile.transportProfileId)) fail(`duplicate transport profile ${profile.transportProfileId}`);
    if (!expected.has(profile.transportProfileId)) fail(`unsupported transport profile ${profile.transportProfileId}`);
    ids.add(profile.transportProfileId);
    stringValue(profile.protocol, `${profile.transportProfileId}.protocol`);
    stringValue(profile.targetRule, `${profile.transportProfileId}.targetRule`);
    stringValue(profile.authPolicy, `${profile.transportProfileId}.authPolicy`);
    stringValue(profile.headerPolicy, `${profile.transportProfileId}.headerPolicy`);
    if (profile.transportProfileId === "unconfigured-local-v1") {
      if (profile.attempts !== 0 || profile.redirectPolicy !== "none") fail("unconfigured-local-v1 must perform zero attempts");
    } else {
      if (profile.attempts !== 1) fail(`${profile.transportProfileId}.attempts must be one`);
      if (profile.redirectPolicy !== "reject") fail(`${profile.transportProfileId}.redirectPolicy must reject`);
    }
    if (profile.retryPolicy !== "none") fail(`${profile.transportProfileId}.retryPolicy must be none`);
    stringValue(profile.responsePolicy, `${profile.transportProfileId}.responsePolicy`);
    stringValue(profile.timeoutPolicy, `${profile.transportProfileId}.timeoutPolicy`);
    stringValue(profile.cancellationPolicy, `${profile.transportProfileId}.cancellationPolicy`);
    idValue(profile.privacyPolicyId, `${profile.transportProfileId}.privacyPolicyId`);
    const expectedTransport = EXPECTED_TRANSPORT_VALUES[profile.transportProfileId];
    if (expectedTransport === undefined || JSON.stringify([profile.protocol, profile.targetRule, profile.authPolicy, profile.headerPolicy, profile.responsePolicy, profile.privacyPolicyId]) !== JSON.stringify(expectedTransport)) fail(`${profile.transportProfileId} differs from the approved transport tuple`);
    const expectedLifecycle = profile.transportProfileId === "unconfigured-local-v1" ? ["none", "none"] : ["total-request-deadline-v1", "language-native-stream-cancel-v1"];
    if (profile.timeoutPolicy !== expectedLifecycle[0] || profile.cancellationPolicy !== expectedLifecycle[1]) fail(`${profile.transportProfileId} lifecycle policy differs from the approved contract`);
  }
  return ids;
}

function validateResponsePolicy(value, label) {
  const keys = ["policyId", "duplicateKeyPolicy", "tuplePolicy", "limitApplicability", "limits", "integerProjection"];
  exactKeys(value, keys, label);
  if (value.policyId !== BITCOIN_POLICY_ID) fail(`${label}.policyId must be ${BITCOIN_POLICY_ID}`);
  if (value.duplicateKeyPolicy !== "last-occurrence-wins") fail(`${label}.duplicateKeyPolicy must be last-occurrence-wins`);
  if (value.tuplePolicy !== "sign-coefficient-exponent10-v1") fail(`${label}.tuplePolicy is unsupported`);
  idList(value.limitApplicability, `${label}.limitApplicability`, new Set(LANGUAGES));
  if (JSON.stringify(value.limitApplicability) !== JSON.stringify(["typescript", "python", "go", "ruby"])) fail(`${label}.limitApplicability must target the four new codecs`);
  exactKeys(value.limits, Object.keys(BITCOIN_LIMITS), `${label}.limits`);
  for (const [key, expected] of Object.entries(BITCOIN_LIMITS)) if (value.limits[key] !== expected) fail(`${label}.limits.${key} differs from the L1 bound`);
  exactKeys(value.integerProjection, ["operation", "grammar", "minimum", "maximum", "rejectForms"], `${label}.integerProjection`);
  if (value.integerProjection.operation !== "getblockcount" || value.integerProjection.grammar !== "unsigned-integer-token") fail(`${label}.integerProjection is invalid`);
  if (value.integerProjection.minimum !== "0" || value.integerProjection.maximum !== "18446744073709551615") fail(`${label}.integerProjection bounds are invalid`);
  if (!Array.isArray(value.integerProjection.rejectForms) || JSON.stringify(value.integerProjection.rejectForms) !== JSON.stringify(["negative", "fraction", "exponent"])) fail(`${label}.integerProjection.rejectForms is invalid`);
}

function validateEndpointMode(value, label, profileIds) {
  exactKeys(value, ["mode", "transportProfileId", "publicDefault", "defaultTarget", "edgeOverride", "routeRule"], label);
  if (!["hosted", "direct", "unconfigured"].includes(value.mode)) fail(`${label}.mode is unsupported`);
  idValue(value.transportProfileId, `${label}.transportProfileId`);
  if (!profileIds.has(value.transportProfileId)) fail(`${label} references an unknown transport profile`);
  if (value.mode === "hosted") {
    if (value.publicDefault !== null && typeof value.publicDefault !== "string") fail(`${label}.publicDefault must be string or null`);
    if (typeof value.publicDefault === "string" && value.publicDefault.endsWith("/")) fail(`${label}.publicDefault must preserve the exact public spelling without a trailing slash`);
    if (value.defaultTarget !== null) urlValue(value.defaultTarget, `${label}.defaultTarget`);
    if (value.edgeOverride !== null && value.edgeOverride !== undefined) urlValue(value.edgeOverride, `${label}.edgeOverride`);
    if (value.defaultTarget === null && value.edgeOverride !== null && value.edgeOverride !== undefined) fail(`${label} has edge override without a default`);
    if (value.routeRule !== null && value.routeRule !== undefined) stringValue(value.routeRule, `${label}.routeRule`);
  } else {
    if (value.publicDefault !== null) fail(`${label}.publicDefault is only valid for hosted mode`);
    if (value.defaultTarget !== null && value.defaultTarget !== undefined) fail(`${label} may not carry a hosted default`);
    if (value.edgeOverride !== null && value.edgeOverride !== undefined) fail(`${label} may not carry a hosted edge override`);
    if (value.routeRule !== null && value.routeRule !== undefined) stringValue(value.routeRule, `${label}.routeRule`);
  }
}

function validateClients(value, methodSetIds, profileIds) {
  if (!Array.isArray(value) || value.length !== 18) fail("clientContracts must contain exactly 18 records");
  const ids = new Set();
  const chains = new Set();
  const namespaces = new Set();
  const capabilities = new Set(["raw", "request", "batch", "transport", "websocket", "subscription", "sign", "send", "approve", "broadcast", "swap", "bridge"]);
  for (const client of value) {
    exactKeys(client, CLIENT_KEYS.filter((key) => !["responsePolicy", "nativeBindingStatus"].includes(key)), `clientContracts.${client?.clientContractId ?? "?"}`, ["responsePolicy", "nativeBindingStatus"]);
    idValue(client.clientContractId, "clientContractId");
    idValue(client.chainKey, `${client.clientContractId}.chainKey`);
    if (ids.has(client.clientContractId)) fail(`duplicate client contract ${client.clientContractId}`);
    if (chains.has(client.chainKey)) fail(`duplicate client chain key ${client.chainKey}`);
    if (namespaces.has(client.namespace)) fail(`duplicate client namespace ${client.namespace}`);
    ids.add(client.clientContractId); chains.add(client.chainKey); namespaces.add(client.namespace);
    stringValue(client.namespace, `${client.clientContractId}.namespace`);
    if (!["legacy-reference", "sealed-read", "bounded-binary-read"].includes(client.surfaceClass)) fail(`${client.clientContractId}.surfaceClass is unsupported`);
    if (!["evm-jsonrpc", "solana-jsonrpc", "avalanche-jsonrpc", "bitcoin-jsonrpc", "near-jsonrpc", "tron-evm-compatible-jsonrpc", "sui-grpc-web"].includes(client.protocolFamily)) fail(`${client.clientContractId}.protocolFamily is unsupported`);
    if (!methodSetIds.has(client.methodSetId)) fail(`${client.clientContractId} references unknown method set`);
    const expectedClient = EXPECTED_CLIENT_TUPLES[client.clientContractId];
    if (expectedClient === undefined || JSON.stringify([client.chainKey, client.namespace, client.surfaceClass, client.protocolFamily, client.methodSetId]) !== JSON.stringify(expectedClient)) fail(`${client.clientContractId} differs from the approved client tuple`);
    if (client.endpointDiagnosticPolicyId !== EXPECTED_DIAGNOSTIC_POLICIES[client.clientContractId]) fail(`${client.clientContractId} diagnostic policy differs from the approved binding`);
    if (!Array.isArray(client.endpointModes) || client.endpointModes.length === 0) fail(`${client.clientContractId}.endpointModes must be non-empty`);
    const modes = new Set();
    for (const mode of client.endpointModes) {
      validateEndpointMode(mode, `${client.clientContractId}.endpointModes`, profileIds);
      if (modes.has(mode.mode)) fail(`${client.clientContractId} repeats endpoint mode ${mode.mode}`);
      modes.add(mode.mode);
    }
    if (client.surfaceClass !== "legacy-reference") {
      const expectedTargets = EXPECTED_HOSTED_TARGETS[client.clientContractId];
      if (!expectedTargets) fail(`${client.clientContractId} has no approved hosted target`);
      const hosted = client.endpointModes.find((entry) => entry.mode === "hosted");
      if (hosted.defaultTarget !== expectedTargets[0] || hosted.edgeOverride !== expectedTargets[1]) fail(`${client.clientContractId} hosted target differs from the accepted route`);
      const expectedPublicDefault = client.clientContractId === "client-bitcoin-rpc" ? null : expectedTargets[0].replace(/\/$/u, "");
      if (hosted.publicDefault !== expectedPublicDefault) fail(`${client.clientContractId} public default spelling differs from the accepted constant`);
    }
    if (client.surfaceClass === "legacy-reference") {
      if (client.endpointModes.some((entry) => entry.mode !== "unconfigured")) fail(`${client.clientContractId} legacy reference may only have its unconfigured marker`);
    } else if (!modes.has("hosted") || !modes.has("direct") || !modes.has("unconfigured")) {
      fail(`${client.clientContractId} must declare hosted, direct and unconfigured modes`);
    }
    const expectedProfiles = client.surfaceClass === "legacy-reference" ? { unconfigured: "unconfigured-local-v1" } : client.clientContractId === "client-bitcoin-rpc" ? { hosted: "hosted-bitcoin-bearer-v1", direct: "direct-jsonrpc-exact-v1", unconfigured: "unconfigured-local-v1" } : client.clientContractId === "client-sui-grpc" ? { hosted: "hosted-sui-grpc-web-v1", direct: "direct-sui-grpc-web-prefix-v1", unconfigured: "unconfigured-local-v1" } : { hosted: "hosted-jsonrpc-query-v1", direct: "direct-jsonrpc-exact-v1", unconfigured: "unconfigured-local-v1" };
    for (const [mode, profile] of Object.entries(expectedProfiles)) if (client.endpointModes.find((entry) => entry.mode === mode)?.transportProfileId !== profile) fail(`${client.clientContractId}.${mode} transport profile differs from the approved binding`);
    idValue(client.endpointDiagnosticPolicyId, `${client.clientContractId}.endpointDiagnosticPolicyId`);
    idList(client.networkIds, `${client.clientContractId}.networkIds`);
    if (!Array.isArray(client.forbiddenCapabilities)) fail(`${client.clientContractId}.forbiddenCapabilities must be an array`);
    const forbiddenSeen = new Set();
    for (const capability of client.forbiddenCapabilities) {
      if (typeof capability !== "string" || !capabilities.has(capability)) fail(`${client.clientContractId}.forbiddenCapabilities contains unsupported ${capability}`);
      if (forbiddenSeen.has(capability)) fail(`${client.clientContractId}.forbiddenCapabilities repeats ${capability}`);
      forbiddenSeen.add(capability);
    }
    if (!Array.isArray(client.compatibilityExceptionIds)) fail(`${client.clientContractId}.compatibilityExceptionIds must be an array`);
    for (const exceptionId of client.compatibilityExceptionIds) idValue(exceptionId, `${client.clientContractId}.compatibilityExceptionIds entry`);
    if (JSON.stringify([...client.compatibilityExceptionIds].sort()) !== JSON.stringify(EXPECTED_CLIENT_EXCEPTIONS[client.clientContractId])) fail(`${client.clientContractId} exception backreferences differ from the approved set`);
    const expectedForbidden = client.surfaceClass === "legacy-reference" ? [] : NEW_CLIENT_FORBIDDEN;
    if (JSON.stringify([...client.forbiddenCapabilities].sort()) !== JSON.stringify([...expectedForbidden].sort())) fail(`${client.clientContractId} forbidden capability set differs from the approved set`);
    if (client.responsePolicy !== undefined) validateResponsePolicy(client.responsePolicy, `${client.clientContractId}.responsePolicy`);
    if (client.nativeBindingStatus !== undefined && !/^approved-c[1-5]$/u.test(client.nativeBindingStatus) && client.nativeBindingStatus !== "pending-later-brief") fail(`${client.clientContractId}.nativeBindingStatus is invalid`);
    if (client.nativeBindingStatus === "pending-later-brief") fail(`${client.clientContractId} native binding remains pending after the approved C2-C5 continuation`);
    if (client.nativeBindingStatus === undefined) fail(`${client.clientContractId} native binding status is missing`);
    if (client.clientContractId === "client-bitcoin-rpc" && client.responsePolicy === undefined) fail("Bitcoin client must carry responsePolicy");
    if (client.clientContractId !== "client-bitcoin-rpc" && client.responsePolicy !== undefined) fail(`responsePolicy is only allowed on Bitcoin`);
  }
  if (chains.size !== 18 || ids.size !== 18) fail("client contracts must cover exactly 18 unique chain keys");
  return { ids, chains };
}

function validateIdentity(value, label, chainKey) {
  exactKeys(value, ["probe", "parameters", "projection", "expected", "evidence"], label, ["secondaryProbe", "secondaryParameters", "secondaryProjection", "secondaryExpected", "caip2"]);
  stringValue(value.probe, `${label}.probe`);
  if (!Array.isArray(value.parameters)) fail(`${label}.parameters must be an array`);
  stringValue(value.projection, `${label}.projection`);
  if (!["string", "number", "boolean"].includes(typeof value.expected)) fail(`${label}.expected must be a scalar`);
  if (value.caip2 !== undefined) {
    stringValue(value.caip2, `${label}.caip2`);
    if (!/^(?:eip155:\d+|solana:[A-Za-z0-9]+)$/u.test(value.caip2)) fail(`${label}.caip2 is invalid`);
    if (chainKey === "solana" && value.caip2 !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") fail(`${label}.caip2 must remain the separate mainnet CAIP-2 reference`);
  }
  for (const [key, expectedType] of [["secondaryProbe", "string"], ["secondaryProjection", "string"]]) {
    if (value[key] !== undefined && typeof value[key] !== expectedType) fail(`${label}.${key} has the wrong type`);
  }
  if (value.secondaryProbe !== undefined) {
    if (!Array.isArray(value.secondaryParameters)) fail(`${label}.secondaryParameters must be present with secondaryProbe`);
    if (!["string", "number", "boolean"].includes(typeof value.secondaryExpected)) fail(`${label}.secondaryExpected must be a scalar`);
  } else if (value.secondaryParameters !== undefined || value.secondaryProjection !== undefined || value.secondaryExpected !== undefined) {
    fail(`${label} has partial secondary identity`);
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) fail(`${label}.evidence must be a non-empty evidence list`);
  for (const evidence of value.evidence) {
    exactKeys(evidence, ["source", "asOfDate"], `evidence in ${label}`);
    stringValue(evidence.source, `${label}.evidence.source`);
    dateValue(evidence.asOfDate, `${label}.evidence.asOfDate`);
  }
}

function validateNetworks(value, clientIds, clientById) {
  if (!Array.isArray(value) || value.length !== 20) fail("networks must contain exactly 20 rows");
  const ids = new Set();
  const pairs = new Set();
  for (const network of value) {
    exactKeys(network, NETWORK_KEYS, `networks.${network?.networkId ?? "?"}`);
    idValue(network.networkId, "networkId");
    if (ids.has(network.networkId)) fail(`duplicate network ${network.networkId}`);
    ids.add(network.networkId);
    idValue(network.chainKey, `${network.networkId}.chainKey`);
    stringValue(network.namespace, `${network.networkId}.namespace`);
    exactKeys(network.provider, PROVIDER_KEYS, `${network.networkId}.provider`);
    for (const key of ["id", "chain", "network"]) stringValue(network.provider[key], `${network.networkId}.provider.${key}`);
    if (!Array.isArray(network.provider.protocols) || network.provider.protocols.length === 0 || network.provider.protocols.some((entry) => typeof entry !== "string")) fail(`${network.networkId}.provider.protocols must be inventory labels`);
    const pair = `${network.provider.id}:${network.provider.chain}/${network.provider.network}`;
    if (pairs.has(pair)) fail(`duplicate provider pair ${pair}`);
    pairs.add(pair);
    const expectedProviderPair = EXPECTED_PROVIDER_PAIRS[network.networkId];
    if (expectedProviderPair === undefined || pair !== expectedProviderPair.replaceAll("|", ":").replace(/:([^:]+):([^:]+)$/u, ":$1/$2")) fail(`${network.networkId} provider pair differs from the accepted inventory`);
    if (!clientIds.has(network.clientContractId)) fail(`${network.networkId} references unknown client`);
    const client = clientById.get(network.clientContractId);
    if (client.chainKey !== network.chainKey || client.namespace !== network.namespace) fail(`${network.networkId} is inconsistent with its client contract`);
    if (!["hosted-or-explicit-direct", "explicit-direct-only"].includes(network.selection)) fail(`${network.networkId}.selection is unsupported`);
    if (network.chainKey === "solana" && network.selection === "explicit-direct-only" && network.identity.caip2 !== undefined) fail(`${network.networkId} may not carry devnet/testnet CAIP-2`);
    if ((network.networkId === "rpc-solana-devnet" || network.networkId === "rpc-solana-testnet") && network.selection !== "explicit-direct-only") fail(`${network.networkId} must remain explicit-direct-only`);
    if (network.networkId === "rpc-solana-mainnet" && network.selection !== "hosted-or-explicit-direct") fail("Solana mainnet selection differs from the approved binding");
    validateIdentity(network.identity, `${network.networkId}.identity`, network.chainKey);
    const expectedProbe = EXPECTED_IDENTITY_PROBES[network.networkId];
    if (expectedProbe === undefined || network.identity.probe !== expectedProbe[0] || network.identity.projection !== expectedProbe[1] || JSON.stringify(network.identity.parameters) !== "[]") fail(`${network.networkId} identity probe tuple differs from the approved contract`);
    if (EXPECTED_IDENTITIES[network.networkId] === undefined || network.identity.expected !== EXPECTED_IDENTITIES[network.networkId]) fail(`${network.networkId} identity differs from the accepted contract`);
    if (EXPECTED_CAIP2[network.networkId] !== undefined && network.identity.caip2 !== EXPECTED_CAIP2[network.networkId]) fail(`${network.networkId} CAIP-2 differs from the accepted identity`);
    if (EXPECTED_CAIP2[network.networkId] === undefined && network.identity.caip2 !== undefined) fail(`${network.networkId} may not invent a CAIP-2 identity`);
    if (network.networkId === "rpc-bitcoin-mainnet" && (network.identity.secondaryExpected !== "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f" || network.identity.secondaryProbe !== "getblockhash(0)" || JSON.stringify(network.identity.secondaryParameters) !== "[0]" || network.identity.secondaryProjection !== "$.result")) fail("Bitcoin genesis identity is incomplete");
    if (network.networkId === "rpc-sui-mainnet" && (network.identity.secondaryExpected !== "mainnet" || network.identity.secondaryProbe !== "GetServiceInfo.chain" || JSON.stringify(network.identity.secondaryParameters) !== "[]" || network.identity.secondaryProjection !== "$.chain")) fail("Sui chain identity is incomplete");
    if (!COHORTS.includes(network.cohort)) fail(`${network.networkId}.cohort is unsupported`);
    if (network.cohort !== EXPECTED_COHORTS[network.networkId]) fail(`${network.networkId}.cohort differs from the accepted cumulative scope`);
    exactKeys(network.inventoryEvidence, INVENTORY_EVIDENCE_KEYS, `${network.networkId}.inventoryEvidence`);
    stringValue(network.inventoryEvidence.sourceId, `${network.networkId}.inventoryEvidence.sourceId`);
    if (network.inventoryEvidence.sourceId !== "quicknode-manifest-2026-10-21") fail(`${network.networkId} inventory source differs from the accepted manifest`);
    if (network.inventoryEvidence.sourceSha256 !== "7e93e849ea605391df9f9879c815fc0972b2ed035cef7cfb2c700adc10c2f9cb") fail(`${network.networkId}.inventoryEvidence.sourceSha256 differs from the accepted manifest`);
    stringValue(network.inventoryEvidence.observedAt, `${network.networkId}.inventoryEvidence.observedAt`);
    stringValue(network.inventoryEvidence.endpointId, `${network.networkId}.inventoryEvidence.endpointId`);
    stringValue(network.inventoryEvidence.limitations, `${network.networkId}.inventoryEvidence.limitations`);
    if (network.inventoryEvidence.endpointId !== network.provider.id) fail(`${network.networkId} inventory endpoint does not match provider id`);
  }
  const actual = [...ids].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...NETWORK_IDS].sort())) fail("network IDs differ from the closed 20-row inventory");
  for (const client of clientById.values()) {
    const rows = value.filter((entry) => entry.clientContractId === client.clientContractId);
    if (JSON.stringify([...client.networkIds].sort()) !== JSON.stringify(rows.map((entry) => entry.networkId).sort())) fail(`${client.clientContractId}.networkIds does not match network rows`);
  }
  return ids;
}

function validateExceptions(value, clientById) {
  if (!Array.isArray(value) || value.length !== 19) fail("compatibilityExceptions must contain exactly nineteen finite records");
  const ids = new Set();
  const expected = new Set([
    "rust-bitcoin-raw-batch-v1",
    "rust-bitcoin-direct-diagnostic-v1",
    "typescript-base-unconfigured-placeholder-v1",
    "rust-bitcoin-decode-domain-v1",
    "ruby-bitcoin-synchronous-request-v1",
    "ruby-base-synchronous-request-v1",
    "ruby-arbitrum-synchronous-request-v1",
    "ruby-polygon-synchronous-request-v1",
    "ruby-bsc-synchronous-request-v1",
    "ruby-optimism-synchronous-request-v1",
    "ruby-kaia-synchronous-request-v1",
    "ruby-soneium-synchronous-request-v1",
    "ruby-monad-synchronous-request-v1",
    "ruby-hyperliquid-synchronous-request-v1",
    "ruby-arc-synchronous-request-v1",
    "ruby-robinhood-synchronous-request-v1",
    "ruby-near-synchronous-request-v1",
    "ruby-tron-synchronous-request-v1",
    "ruby-sui-synchronous-request-v1",
  ]);
  for (const exception of value) {
    exactKeys(exception, EXCEPTION_KEYS, `compatibilityExceptions.${exception?.exceptionId ?? "?"}`);
    idValue(exception.exceptionId, "exceptionId");
    if (ids.has(exception.exceptionId)) fail(`duplicate exception ${exception.exceptionId}`);
    if (!expected.has(exception.exceptionId)) fail(`unsupported compatibility exception ${exception.exceptionId}`);
    ids.add(exception.exceptionId);
    if (!LANGUAGES.includes(exception.language)) fail(`${exception.exceptionId}.language is unsupported`);
    idValue(exception.clientContractId, `${exception.exceptionId}.clientContractId`);
    if (!clientById.has(exception.clientContractId)) fail(`${exception.exceptionId} references unknown client`);
    stringValue(exception.allowedDifference, `${exception.exceptionId}.allowedDifference`);
    const expectedBinding = EXPECTED_EXCEPTION_BINDINGS[exception.exceptionId];
    if (expectedBinding === undefined || exception.language !== expectedBinding[0] || exception.clientContractId !== expectedBinding[1] || exception.allowedDifference !== EXPECTED_EXCEPTION_TEXTS[exception.exceptionId]) fail(`${exception.exceptionId} differs from the approved finite exception binding`);
    if (!Array.isArray(exception.evidence) || exception.evidence.length === 0 || exception.evidence.some((entry) => typeof entry !== "string")) fail(`${exception.exceptionId}.evidence must be non-empty strings`);
    stringValue(exception.reviewCondition, `${exception.exceptionId}.reviewCondition`);
  }
  if (ids.size !== expected.size) fail("compatibility exception set is incomplete");
  return ids;
}

function validateLanguageBindings(value, clientById, methodSetById, networkById) {
  const expectedClients = new Set([...clientById.values()].filter((client) => client.surfaceClass !== "legacy-reference").map((client) => client.clientContractId));
  if (!Array.isArray(value) || value.length !== expectedClients.size * LANGUAGES.length) fail(`languageBindings must contain exactly ${expectedClients.size * LANGUAGES.length} approved client-language bindings`);
  const seen = new Set();
  for (const binding of value) {
    exactKeys(binding, LANGUAGE_BINDING_KEYS, `languageBindings.${binding?.bindingId ?? "?"}`);
    idValue(binding.bindingId, "bindingId");
    if (seen.has(binding.bindingId)) fail(`duplicate language binding ${binding.bindingId}`);
    seen.add(binding.bindingId);
    if (!LANGUAGES.includes(binding.language)) fail(`${binding.bindingId}.language is unsupported`);
    if (!expectedClients.has(binding.clientContractId)) fail(`${binding.bindingId} references a legacy or unknown client`);
    const client = clientById.get(binding.clientContractId);
    const network = networkById.get(client?.networkIds?.[0]);
    const expectedStatus = `approved-c${network?.cohort ?? 1}`;
    if (binding.status !== expectedStatus) fail(`${binding.bindingId}.status must be ${expectedStatus}`);
    if (!Array.isArray(binding.capabilityIds) || binding.capabilityIds.length === 0 || new Set(binding.capabilityIds).size !== binding.capabilityIds.length) fail(`${binding.bindingId}.capabilityIds must be unique`);
    const methodSet = methodSetById.get(client.methodSetId);
    if (methodSet.kind !== "expanded") fail(`${binding.bindingId} requires an expanded method set`);
    const known = new Set(methodSet.capabilities.map((entry) => entry.capabilityId));
    for (const capabilityId of binding.capabilityIds) if (!known.has(capabilityId)) fail(`${binding.bindingId} references unknown capability ${capabilityId}`);
    if (JSON.stringify(binding.capabilityIds) !== JSON.stringify(methodSet.capabilities.map((entry) => entry.capabilityId))) fail(`${binding.bindingId}.capabilityIds must equal the complete approved method set`);
    if (!Array.isArray(binding.exceptionIds) || binding.exceptionIds.some((exceptionId) => typeof exceptionId !== "string")) fail(`${binding.bindingId}.exceptionIds must be a string list`);
    const expectedExceptions = [...clientById.get(binding.clientContractId).compatibilityExceptionIds].filter((exceptionId) => exceptionId.startsWith(`${binding.language === "typescript" ? "typescript" : binding.language}-`) || (binding.language === "rust" && exceptionId.startsWith("rust-")) || (binding.language === "ruby" && exceptionId.startsWith("ruby-"))).sort();
    if (JSON.stringify([...binding.exceptionIds].sort()) !== JSON.stringify(expectedExceptions)) fail(`${binding.bindingId}.exceptionIds differ from the client/language binding`);
    const expectedId = `${binding.language}-${binding.clientContractId}`;
    if (binding.bindingId !== expectedId) fail(`${binding.bindingId} has an unstable binding ID`);
  }
  for (const language of LANGUAGES) for (const clientContractId of expectedClients) if (!seen.has(`${language}-${clientContractId}`)) fail(`missing language binding ${language}-${clientContractId}`);
  return true;
}

export function validateContract(value = contract, { skipDigest = false } = {}) {
  exactKeys(value, CONTRACT_KEYS, "rpc-network-contract");
  if (value.schemaVersion !== 1 || value.contractVersion !== "1.0.0" || value.transportContractVersion !== "1.0") fail("contract version fields are not the approved v1 values");
  dateValue(value.asOfDate, "asOfDate");
  if (!/^[0-9a-f]{64}$/u.test(value.contentDigest)) fail("contentDigest must be lowercase SHA-256");
  validateClaimBoundaries(value.claimBoundaries);
  const methodSetIds = validateMethodSets(value.methodSets);
  const profileIds = validateTransportProfiles(value.transportProfiles);
  const { ids: clientIds } = validateClients(value.clientContracts, methodSetIds, profileIds);
  const clientById = new Map(value.clientContracts.map((client) => [client.clientContractId, client]));
  const methodSetById = new Map(value.methodSets.map((methodSet) => [methodSet.methodSetId, methodSet]));
  validateNetworks(value.networks, clientIds, clientById);
  const exceptionIds = validateExceptions(value.compatibilityExceptions, clientById);
  validateLanguageBindings(value.languageBindings, clientById, methodSetById, new Map(value.networks.map((network) => [network.networkId, network])));
  for (const client of value.clientContracts) {
    for (const exceptionId of client.compatibilityExceptionIds) if (!exceptionIds.has(exceptionId)) fail(`${client.clientContractId} references unknown exception ${exceptionId}`);
  }
  if (!skipDigest) {
    const expectedDigest = computeDigestWithoutValidation(value);
    if (value.contentDigest !== expectedDigest) fail(`contentDigest mismatch: expected ${expectedDigest}`);
  }
  return true;
}

function computeDigestWithoutValidation(value) {
  const projection = canonicalize({
    schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion,
    transportContractVersion: value.transportContractVersion,
    claimBoundaries: value.claimBoundaries,
    methodSets: sortById(value.methodSets, "methodSetId").map(canonicalMethodSet),
    transportProfiles: sortById(value.transportProfiles, "transportProfileId"),
    clientContracts: sortById(value.clientContracts, "clientContractId").map(canonicalClient),
    networks: sortById(value.networks, "networkId").map(canonicalNetwork),
    compatibilityExceptions: sortById(value.compatibilityExceptions, "exceptionId"),
    languageBindings: sortById(value.languageBindings, "bindingId"),
  });
  return sha256(JSON.stringify(projection));
}

export function expectedScope(throughCohort = 5, value = contract) {
  if (!Number.isInteger(throughCohort) || throughCohort < 1 || throughCohort > 5) fail("throughCohort must be an integer from 1 through 5");
  validateContract(value);
  const cohortIds = Array.from({ length: throughCohort + 1 }, (_, index) => index);
  const networkIds = value.networks.filter((network) => network.cohort <= throughCohort).map((network) => network.networkId).sort();
  const expectedRows = [null, 8, 11, 14, 17, 20][throughCohort];
  if (networkIds.length !== expectedRows) fail(`contract scope for cohort ${throughCohort} has ${networkIds.length} rows; expected ${expectedRows}`);
  return { mode: "through-cohort", throughCohort, cohortIds, networkIds };
}

export function runtimeProjection(value = contract) {
  validateContract(value);
  const projection = {
    schemaVersion: value.schemaVersion,
    contractVersion: value.contractVersion,
    transportContractVersion: value.transportContractVersion,
    contentDigest: value.contentDigest,
    methodSets: sortById(value.methodSets, "methodSetId").map(canonicalMethodSet),
    transportProfiles: sortById(value.transportProfiles, "transportProfileId"),
    clientContracts: sortById(value.clientContracts, "clientContractId").map((client) => canonicalClient(client)),
    networks: sortById(value.networks, "networkId").map((network) => {
      const { provider: _provider, inventoryEvidence: _inventoryEvidence, identity, ...rest } = network;
      const { evidence: _evidence, ...identityWithoutEvidence } = identity;
      return { ...rest, identity: identityWithoutEvidence };
    }),
    compatibilityExceptions: sortById(value.compatibilityExceptions, "exceptionId").map(({ exceptionId, language, clientContractId }) => ({ exceptionId, language, clientContractId })),
    languageBindings: sortById(value.languageBindings, "bindingId"),
  };
  return Object.freeze(projection);
}

function fixturePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rpc-chain-contract-cases.json");
}

export function readCanonicalFixture() {
  return JSON.parse(readFileSync(fixturePath(), "utf8"));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export { contract as CONTRACT, stableJson };

validateContract(contract);
