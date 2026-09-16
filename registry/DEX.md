# DEX and pool catalog

This catalog is the shared, offline source for DEX deployments, pool identities,
native/wrapped relationships, and aliases used by the five SDKs. The source is
`registry/dex-catalog.json`; `evidence` and per-record `asOfDate` fields document
provenance and are removed from generated package data. Runtime records retain
the catalog version, global as-of date, and SHA-256 content digest.

The initial reviewed 2026-09-16 local integration contains 12 pool definitions and 16 DEX
aliases. The candidate DEX digest is
`a0268a45d2b037ab8ea35aad1c45366d2582cbc9b10681ded590b56e07b011c8`; raw
pool observations and the local review are linked from
[`evidence/pool-observations-2026-09-16.json`](./evidence/pool-observations-2026-09-16.json)
and [`evidence/discovery-ranking-review-2026-09-16.json`](./evidence/discovery-ranking-review-2026-09-16.json).

The catalog begins with immutable DEX deployment and pool IDs:

| ID | Chain | Protocol | Pool or program | Runtime capability |
| --- | --- | --- | --- | --- |
| `dex-deployment-0001` | Ethereum mainnet | Uniswap V2 | `pool-0001` (`0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc`) | EVM constant-product quote |
| `dex-deployment-0002` | Avalanche C-Chain | LFJ legacy constant-product (Joe V1) | `pool-0002` (`0xf4003f4efbe8691b60249e6afbd307abe7758adb`) | EVM constant-product quote |
| `dex-deployment-0003` | Solana mainnet | Orca Whirlpools | `pool-0003` (`FgH1dEvyRQoAqJjbUzzKVoM1HYdxTqPwjEF82kDH1kVe`) | Lookup only |
| `dex-deployment-0004` | Solana mainnet | Raydium CLMM | `pool-0004` (`AwaVyGAF3N6K4YRUJk55Ui1GquKhKdD6vTCmVvCzXpKf`) | Lookup only |

The two EVM pools use `adapter.kind = "evm-constant-product-v2"` and fee
`3/1000`, represented as decimal strings. Pool token bindings are immutable:
Ethereum uses token deployments `deployment-0008` (USDC) and `deployment-0002`
(WETH); Avalanche uses `deployment-0004` (WAVAX) and `deployment-0009`
(USDC). Both Solana records use classic WSOL `deployment-0006` and EURC
`deployment-0013`. Solana fee fields are `null`; the observed Orca adaptive fee
is not a fixed runtime quote fee.

The handwritten source-controlled quote capabilities are in
[`quote-capabilities.mjs`](./quote-capabilities.mjs). They bind each supported
EVM pool to its chain, DEX factory/program address, ordered token IDs and
addresses, decimals, adapter kind, and fee. A catalog pool or token tuple that
falls outside those capabilities is rejected before any RPC request with
`SWAP_UNSUPPORTED_TOKEN` and the message `Swap token is unsupported for the
selected pool`. This gate preserves validation precedence and golden quote
vectors while allowing the canonical catalog to grow safely.

Native wrapping is explicit and chain-bound:

| Definition | Native deployment | Wrapped deployment |
| --- | --- | --- |
| `native-wrap-0001` | `deployment-0001` (ETH) | `deployment-0002` (WETH) |
| `native-wrap-0002` | `deployment-0003` (AVAX) | `deployment-0004` (WAVAX) |
| `native-wrap-0003` | `deployment-0005` (SOL) | `deployment-0006` (classic WSOL) |

Discovery admission is limited to direct reviewed native pairs using WETH,
WAVAX, or classic WSOL. The native liquidity floors are 10 ETH, 100 AVAX,
and 100 SOL in chain-native atomic units. A newly observed pool can be added
for lookup only after fresh receipt replay and review; discovery does not
grant it swap execution or bridge support. Deferred candidates use the
persisted bounded cursor and are revalidated from fresh RPC facts before a
later admission attempt.

## Registry API

The registry provides deterministic, network-free lookups. All statuses remain
visible in lookup results; lifecycle changes use the replacement fields while
preserving the original ID and address/pair binding.

The JavaScript functions below are the canonical reference used by fixtures and
parity checks. Package runtimes emit their own generated data and public
wrappers; they do not import this registry module or source provenance.

```js
getDexDeployment("dex-deployment-0001")
getPoolDefinition("pool-0001")
findPoolDefinitionByAddress("eip155:1", "0xB4E16D0168E52D35CACD2C6185B44281EC28C9DC")
findPoolDefinitionsByPair("eip155:1", "deployment-0002", "deployment-0008")
listPoolDefinitions({ chainId: "eip155:1", adapterKind: "evm-constant-product-v2" })
getNativeWrapDefinition("deployment-0001")
```

Pair lookup treats the two token IDs as unordered and returns IDs sorted by
`poolDefinitionId`. Address lookup lowercases EVM addresses and preserves
Solana base58 text. The generated package files contain data only; package
clients bind their configured RPC transport to the quote driver internally.

## Exact-input quote contract

The public request has exactly these fields:

```js
client.swap.quoteExactInput({
  chainId,
  poolDefinitionId,
  inputTokenDeploymentId,
  outputTokenDeploymentId,
  amountIn,
  freshness: {
    maxBlockAgeSeconds,
    maxBlockLag,
    maxClockSkewSeconds,
  },
})
```

`freshness` is optional. Defaults are 120 seconds, 3 blocks, and 5 seconds;
the allowed ranges are 0–86400, 0–1024, and 0–300. `amountIn` is a positive
canonical decimal string no larger than uint256. RPC configuration, clocks,
slippage, minimum output, fee amount, native handling, route selection,
transaction building, signing, sending, simulation, and caching are outside
the public request and this stage.

The exact result keys are:

```js
{
  quoteKind: "exact-input",
  chainId,
  poolDefinitionId,
  dexDeploymentId,
  adapterKind,
  inputTokenDeploymentId,
  outputTokenDeploymentId,
  amountIn,
  amountOut,
  fee: { numerator, denominator },
  snapshot: { kind: "evm-block", blockNumber, blockHash, blockTimestamp },
  tokenCatalogDigest,
  dexCatalogDigest,
}
```

All quantities in the result are decimal strings. EVM quote validation first
checks `eth_chainId` and a latest header, then reads factory and pool code and
the factory `getPair`, pool `factory`, `token0`, `token1`, and `getReserves`
values. Every code/call read uses the same EIP-1898 selector:
`{ blockHash, requireCanonical: true }`. After the reads, the latest header is
checked for age and lag and the snapshot block is reread by number; its number,
hash, and timestamp must all match before ABI decoding. There are no retries or
numeric/latest fallback reads.

The factory pair, pool factory, ordered token addresses, ABI padding, reserve
width (`uint112`), positive reserves, and every uint256 intermediate are checked
before applying:

```text
adjusted = amountIn * (feeDenominator - feeNumerator)
amountOut = floor(adjusted * reserveOut /
                   (reserveIn * feeDenominator + adjusted))
```

The accepted inputs for the EVM adapter are active ERC-20 deployments. Native
and Token-2022 inputs fail before RPC. Classic SPL inputs reach the Solana
adapter gate and fail before RPC because the CLMM adapters are lookup-only.
The handwritten capability gate binds every supported tuple to its chain, pool,
factory, token IDs and addresses, decimals, ERC-20 standards, adapter, and
fee before RPC. Catalog growth never enables a new quote tuple or bridge path.

Fixed SDK error codes are:

`SWAP_INVALID_ARGUMENT`, `SWAP_UNSUPPORTED_CHAIN`, `SWAP_UNKNOWN_POOL`,
`SWAP_CHAIN_MISMATCH`, `SWAP_INVALID_POOL_STATE`, `SWAP_UNKNOWN_TOKEN`,
`SWAP_TOKEN_NOT_ACTIVE`, `SWAP_UNSUPPORTED_TOKEN_STANDARD`,
`SWAP_POOL_TOKEN_MISMATCH`, `SWAP_UNSUPPORTED_ADAPTER`,
`SWAP_UNSUPPORTED_TOKEN`,
`SWAP_PROGRAM_MISMATCH`, `SWAP_STATE_STALE`,
`SWAP_INSUFFICIENT_LIQUIDITY`, and `SWAP_ARITHMETIC`. Pre-RPC request and
catalog validation follows the order listed in the shared quote fixture. During
an RPC quote, final header freshness/reorg checks run before ABI, program, and
pool-state checks, so `SWAP_STATE_STALE` wins when both conditions are present.

Transport failures and cancellation errors retain their original source error.

## Generation and parity

Validate and render the source catalog with Node.js:

```sh
node registry/generate-dex-catalog.mjs --language typescript
node registry/generate-dex-catalog.mjs --check --language all
```

An ordinary generation invocation writes one fixed package-language file. The
`--check` mode is read-only and can check all five paths. It rejects arbitrary
output paths. A previous source snapshot can be checked with `--previous`; IDs,
addresses, token pairings, adapter bindings, and aliases cannot be removed or
retargeted.

Native parity is verified only from explicit snapshots captured by executed
TypeScript, Rust, Python, Go, and Ruby package runtimes:

```sh
node registry/verify-dex-parity.mjs --snapshots native-dex-snapshots.json
```

The snapshot envelope compares token metadata, DEX metadata, all four record
groups, the six lookup behaviors (`getDexDeployment`, `getPoolDefinition`,
`findPoolDefinitionByAddress`, `findPoolDefinitionsByPair`,
`listPoolDefinitions`, and `getNativeWrapDefinition`), alias rows, and every
shared quote outcome plus its captured RPC trace. A canonical-reference
template is rejected as proof of native execution.

`fixtures/swap-quote-cases.json` is the replay source for those quote rows.
Each row contains a complete public `request`, internal test `nowSeconds`,
literal `rpcResponses` (empty for pre-RPC or direct math cases), the expected
`outcome`, and the exact `rpcTrace` of method/parameter calls. Rows marked
`applicability: "language-local"` cover malformed request construction or
pre-aborted transport behavior that a strongly typed package may test in its
own native layer; the parity verifier excludes them from shared cross-language
rows while the registry tests still execute them.

Factual RPC receipts and source-license boundaries are recorded in
[`evidence/dex-catalog-2026-09-15.json`](evidence/dex-catalog-2026-09-15.json).
That evidence also records the dated EU OSS planning packet pointer, dependency
license notice hashes, and the limits of the engineering source-copy boundary.
