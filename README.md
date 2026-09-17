# ERPC SDK

[![ERPC — Global Edge Blockchain Infrastructure](https://storage.erpc.global/ERPCheader.jpg)](https://erpc.global)

<p align="center">
  <a href="https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml"><img src="https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@elsoul/erpc-sdk"><img src="https://img.shields.io/npm/v/%40elsoul%2Ferpc-sdk.svg" alt="npm" /></a>
  <a href="https://crates.io/crates/erpc-sdk"><img src="https://img.shields.io/crates/v/erpc-sdk.svg" alt="crates.io" /></a>
  <a href="https://pypi.org/project/erpc-sdk/"><img src="https://img.shields.io/pypi/v/erpc-sdk.svg" alt="PyPI" /></a>
  <a href="https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go"><img src="https://pkg.go.dev/badge/github.com/elsoul/erpc-sdk/packages/go.svg" alt="Go Reference" /></a>
  <a href="https://rubygems.org/gems/erpc-sdk"><img src="https://img.shields.io/gem/v/erpc-sdk.svg" alt="RubyGems" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
</p>

<p align="center">
  <strong>ERPC Official Multi-Network Blockchain SDK<br />
  Built for Developers. Ready for AI Agents.</strong>
</p>

With an eRPC API key, one client provides eRPC-backed access to Solana,
Ethereum, Avalanche C/P/X-chain, price data, indexed data, leader and validator
data, analytics, subscriptions, and account balance information. Direct RPC
overrides introduced in `0.8.0` and offline token, DEX/pool, and ranking catalog
reads do not require an eRPC API key.

## Packages

| Language | Package | Version availability |
| --- | --- | --- |
| TypeScript | [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk) | `0.8.0` release line |
| Rust | [`erpc-sdk`](https://crates.io/crates/erpc-sdk) | `0.8.0` release line |
| Python | [`erpc-sdk`](https://pypi.org/project/erpc-sdk/) | `0.8.0` release line |
| Go | [`github.com/elsoul/erpc-sdk/packages/go`](https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go) | `0.8.0` release line |
| Ruby | [`erpc-sdk`](https://rubygems.org/gems/erpc-sdk) | `0.8.0` release line |

The package registries expose live version badges for [npm](https://img.shields.io/npm/v/%40elsoul%2Ferpc-sdk.svg), [crates.io](https://img.shields.io/crates/v/erpc-sdk.svg), [PyPI](https://img.shields.io/pypi/v/erpc-sdk.svg), [Go](https://pkg.go.dev/badge/github.com/elsoul/erpc-sdk/packages/go.svg), and [RubyGems](https://img.shields.io/gem/v/erpc-sdk.svg); the [latest GitHub release](https://github.com/elsoul/erpc-sdk/releases/latest) is the shared release record.

The bounded token, DEX, pool, ranking, and reviewed EVM RPC-only quote APIs are
the `0.7.0` history baseline. The direct RPC overrides, unsigned EVM swap
preparation and simulation, and optional Mayan adapter are introduced in
`0.8.0`; install those APIs only when `0.8.0` is shown by the package registry
badge and the [latest GitHub release](https://github.com/elsoul/erpc-sdk/releases/latest).

## Install

TypeScript:

```bash
npm install @elsoul/erpc-sdk
# or: pnpm add @elsoul/erpc-sdk
# or: yarn add @elsoul/erpc-sdk
# or: bun add @elsoul/erpc-sdk
```

The TypeScript package has no runtime dependencies and includes ESM, CommonJS,
and TypeScript declarations.

Rust:

```bash
cargo add erpc-sdk
```

Python:

```bash
python -m pip install erpc-sdk
```

Go:

```bash
go get github.com/elsoul/erpc-sdk/packages/go@v0.8.0
```

Ruby:

```bash
gem install erpc-sdk
```

See the package guides for [TypeScript](packages/typescript/README.md),
[Rust](packages/rust/README.md), [Python](packages/python/README.md),
[Go](packages/go/README.md), and [Ruby](packages/ruby/README.md). Minimum
versions are Rust 1.85, Python 3.11, Go 1.22, and Ruby 3.1.

## Availability

| Capability | `0.7.0` package | `0.8.0` package |
| --- | --- | --- |
| Offline token, DEX, and pool catalogs | Included | Included |
| Offline token rankings | Included | Included; see canonical metadata |
| Read-only reviewed EVM exact-input quotes (Ethereum Uniswap V2 and Avalanche LFJ legacy) | Included | Included |
| Caller-owned direct RPC overrides (`solanaRpc`, `ethereumRpc`, `avalancheCRpc`) | Not included | Introduced in `0.8.0`; requires `0.8.0` |
| Reviewed EVM exact-input preparation and RPC simulation | Not included | Introduced in `0.8.0`; requires `0.8.0` |
| Optional Mayan Swift v2 native EURC bridge | Not included | Introduced in `0.8.0`; requires `0.8.0` |
| Solana CLMM quotes; multi-hop routing; SDK signing/sending | Future work | Future work |

The `0.7.0` column records the published history baseline. The `0.8.0` column
describes the version that introduced each API; live publication status follows
the package registry badges and the [latest GitHub release](https://github.com/elsoul/erpc-sdk/releases/latest).

## Direct RPC endpoints

The direct RPC configuration introduced in `0.8.0` lets a caller route selected
chain JSON-RPC traffic to a dedicated node without an eRPC API key. A package
consumer needs `0.8.0` for this API; source checkout examples remain available
while release publication is being verified.

| Config field | Direct namespace(s) |
| --- | --- |
| `solanaRpc` | `erpc.solana.rpc`, `erpc.solana.das`, `erpc.solana.history`, `erpc.solana.leaders`, `erpc.solana.analytics`, and `erpc.solana.subscriptions` |
| `ethereumRpc` | `erpc.ethereum.rpc`, `erpc.ethereum.subscriptions`, and Ethereum EVM quote reads |
| `avalancheCRpc` | `erpc.avalanche.rpc`, `erpc.avalanche.subscriptions`, and C-Chain EVM quote reads |

Extended Solana methods depend on the methods and limits supported by the
chosen dedicated RPC provider.

```ts
import { createErpcClient } from '@elsoul/erpc-sdk'

const erpc = createErpcClient({
  solanaRpc: {
    httpUrl: 'https://solana.example/customer/path?region=eu',
  },
  ethereumRpc: {
    httpUrl: 'https://ethereum.example/rpc',
  },
  avalancheCRpc: {
    httpUrl: 'https://avalanche.example/rpc',
  },
})

const slot = await erpc.solana.rpc.getSlot().send()
const chainId = await erpc.ethereum.rpc.eth_chainId().send()
const avalancheChainId = await erpc.avalanche.rpc.eth_chainId().send()
console.log({ slot, chainId, avalancheChainId })
erpc.close()
```

Each supplied `httpUrl` is the complete final HTTP request target: its path and
query are preserved exactly, no eRPC route or `api-key` is appended, and direct
HTTP requests do not follow redirects.

An optional independent `webSocketUrl` enables subscriptions; it is never
derived from `httpUrl`, and a missing URL does not fall back to eRPC. Scoped
`headers` apply only to direct HTTP JSON-RPC requests and are not sent over WSS:

```ts
const subscribed = createErpcClient({
  ethereumRpc: {
    httpUrl: 'https://ethereum.example/rpc',
    webSocketUrl: 'wss://ethereum.example/socket',
    headers: { authorization: 'Bearer node-token' },
  },
})
```

In keyless mode, non-overridden chains and eRPC REST, native, and index services
fail locally with `ERPC_NOT_CONFIGURED` before network I/O. A direct
subscription without `webSocketUrl` also fails locally, even when an eRPC key
is supplied. Add an eRPC API key when those non-overridden eRPC services are
needed. Native AVAX, P/X, proposer VM, Info, and index services remain
eRPC-backed when `avalancheCRpc` is used.

See the language-specific direct RPC guides for [TypeScript](packages/typescript/README.md),
[Rust](packages/rust/README.md), [Python](packages/python/README.md),
[Go](packages/go/README.md), and [Ruby](packages/ruby/README.md).

## Offline token catalog

The published `0.7.0` packages include a bounded, source-backed token catalog
across Ethereum, Solana, and Avalanche C-Chain. Catalog reads are local: they
do not create a client, need an API key, or access a network.

The public TypeScript names use the chain-qualified constants below. Alias
values are opaque deployment IDs; returned deployments keep their lifecycle
status (`active`, `legacy`, `winding-down`, or `retired`) and native
deployments use `address: null`.

```ts
import {
  findTokenDeploymentsBySymbol,
  getTokenDeployment,
  TOKEN_CHAIN_IDS,
  tokens,
} from '@elsoul/erpc-sdk'

const ethereumUsdc = getTokenDeployment(tokens.ethereum.USDC)
const solanaUsdc = getTokenDeployment(tokens.solana.USDC)
const avalancheUsdc = getTokenDeployment(tokens.avalancheC.USDC)

const usdOnEthereum = findTokenDeploymentsBySymbol(
  TOKEN_CHAIN_IDS.ethereumMainnet,
  'USDC',
)
const eurOnSolana = findTokenDeploymentsBySymbol(
  TOKEN_CHAIN_IDS.solanaMainnet,
  'EURC',
)
const jpyOnAvalanche = findTokenDeploymentsBySymbol(
  TOKEN_CHAIN_IDS.avalancheCMainnet,
  'JPYC',
)

console.log({ ethereumUsdc, solanaUsdc, avalancheUsdc })
console.log({ usdOnEthereum, eurOnSolana, jpyOnAvalanche })
```

The `stableCurrency` filter maps `USD` to U.S. dollar, `EUR` to euro, and
`JPY` to Japanese yen. These are straightforward catalog labels; the bounded
catalog makes no claim of complete coverage, ranking, or market data. See the
[canonical registry guide](registry/README.md) and its
[source notes](registry/SOURCES.md) for fields, evidence, and lookup rules.
All five SDKs expose the corresponding offline list/lookup APIs and catalog
metadata; they do not call a runtime vendor service, RPC endpoint, or current
clock for these reads.

These catalog and quote exports are included in the published `0.7.0` package.

## DEX catalog and RPC-only quotes

The published `0.7.0` packages include generated DEX, pool, native/wrapped, and
alias records across the five SDKs. The reviewed seed quote tuples are Ethereum
Uniswap V2 (WETH/USDC) and Avalanche LFJ legacy (WAVAX/USDC). Solana Orca
Whirlpools and Raydium CLMM records use classic WSOL/EURC for lookup and pair
discovery; they are not quote-enabled.

`amountIn` is a positive decimal string in the input token's base units.

```ts
import {
  createErpcClient,
  DEX_CHAIN_IDS,
  pools,
  tokens,
} from '@elsoul/erpc-sdk'

const apiKey = process.env.ERPC_API_KEY
if (!apiKey) throw new Error('ERPC_API_KEY is required')

const erpc = createErpcClient({ apiKey })
const quote = await erpc.swap.quoteExactInput({
  chainId: DEX_CHAIN_IDS.ethereum,
  poolDefinitionId: pools.ethereum.UNISWAP_V2_USDC_WETH,
  inputTokenDeploymentId: tokens.ethereum.WETH,
  outputTokenDeploymentId: tokens.ethereum.USDC,
  amountIn: '1000000000000000000',
})

console.log(quote.amountOut)
erpc.close()
```

`quoteExactInput` is a composite async operation and is awaited directly; it
does not have a `.send()` step. Low-level JSON-RPC methods remain pending
requests and still use `.send()`. The quote reads the configured EVM RPC and
calculates locally from one block snapshot. Native-to-wrapped definitions are
metadata only; no automatic wrapping is performed. Reviewed unsigned
preparation and RPC simulation for these two EVM routes are introduced in
`0.8.0`; Solana CLMM quotes, multi-hop routing, SDK signing, and SDK sending
remain future work. Low-level JSON-RPC methods remain available through the
chain clients.

Only the reviewed seed pool/token tuples receive quote capability. Discovery
can record new pool and token facts for review, but it does not enable new swap
execution or bridge support.

### Reviewed EVM swap preparation and simulation (introduced in 0.8.0)

The `0.8.0` API adds `prepareExactInputSwap` and `simulateExactInputSwap` for
both directions of the reviewed Ethereum Uniswap
V2 WETH/USDC and Avalanche LFJ WAVAX/USDC tuples. A fresh configured-RPC quote
drives local calldata construction, and the result is an unsigned neutral EVM
envelope with an explicit allowance requirement. The SDK does not approve,
sign, or send it; it does not wrap native assets, execute Solana CLMM routes,
or select a multi-hop route.

Use separate client instances when read and execution preparation should use
different dedicated RPC endpoints:

```ts
const readClient = createErpcClient({
  ethereumRpc: { httpUrl: 'https://read-node.example/rpc' },
})
const executionClient = createErpcClient({
  ethereumRpc: { httpUrl: 'https://execution-node.example/rpc' },
})

const quoteRequest = {
  chainId: DEX_CHAIN_IDS.ethereum,
  poolDefinitionId: pools.ethereum.UNISWAP_V2_USDC_WETH,
  inputTokenDeploymentId: tokens.ethereum.WETH,
  outputTokenDeploymentId: tokens.ethereum.USDC,
  amountIn: '1000000000000000000',
}
const quote = await readClient.swap.quoteExactInput(quoteRequest)

const preparationRequest = {
  ...quoteRequest,
  sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  slippageBps: 50,
  deadline: String(Math.floor(Date.now()/1000)+300),
}
const prepared = await executionClient.swap.prepareExactInputSwap(preparationRequest)
const simulation = await executionClient.swap.simulateExactInputSwap(preparationRequest)
console.log({ quote, prepared, simulation })
readClient.close()
executionClient.close()
```

Simulation is read-only and can fail when the caller's wallet has no balance or
allowance. The caller's wallet owns allowance changes, fee and nonce fields,
signing, and broadcasting. See the [DEX and pool registry](registry/DEX.md)
for the reviewed bindings and the five package guides for language-specific
method names. The shared swap fixtures and parity verifier define the
cross-language behavior contract; root's read-only preparation observations are
recorded in the [swap execution evidence packet](registry/evidence/swap-execution-capabilities-2026-09-16.json).

### Mayan Swift v2 bridge introduced in 0.8.0

The `0.8.0` API adds a standalone `createMayanSwiftV2BridgeClient` for native
issued EURC between Ethereum and Solana. It exposes `quoteExactInput`,
`buildUnsigned`, and `getStatus` for the two exact catalog directions. By
default, quotes and builds use `https://tx-builder.mayan.finance` and indexed
status uses `https://explorer-api.mayan.finance/v3`; set `builderEndpoint` and
`explorerEndpoint` to customize those provider endpoints. The adapter uses Mayan's hosted quote,
transaction-builder, source-swap, solver, relayer, Wormhole, and Explorer
services. Its source-side USDC conversion and Solana-origin Jupiter v6
dependency are visible in returned data. This is the explicit bridge-only
external-provider exception; normal SDK swaps remain configured RPC and local
calculation.

```ts
import { createMayanSwiftV2BridgeClient, TOKEN_CHAIN_IDS } from '@elsoul/erpc-sdk'

const mayan = createMayanSwiftV2BridgeClient({
  builderEndpoint: 'https://tx-builder.mayan.finance',
  explorerEndpoint: 'https://explorer-api.mayan.finance/v3',
  builderApiKey: mayanBuilderApiKey, // a separate Mayan build key
})
const quotes = await mayan.quoteExactInput({
  sourceChainId: TOKEN_CHAIN_IDS.ethereumMainnet,
  destinationChainId: TOKEN_CHAIN_IDS.solanaMainnet,
  sourceTokenDeploymentId: 'deployment-0011',
  destinationTokenDeploymentId: 'deployment-0013',
  amountIn: '1000000',
  slippageBps: 50,
})
const built = await mayan.buildUnsigned({
  quote: quotes[0],
  swapperAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  destinationAddress: 'So11111111111111111111111111111111111111112',
})
const status = await mayan.getStatus({
  sourceChainId: TOKEN_CHAIN_IDS.ethereumMainnet,
  sourceTransactionHash: sourceTransactionHash,
})
console.log({ built, status })
mayan.close()
```

`builderApiKey` is sent only to `/build`; quote and status calls work without
it and never receive an eRPC key or ambient credentials. A custom no-auth
builder requires the explicit `allowUnauthenticatedBuild` opt-in. Provider
signatures, transaction semantics, and settlement are structurally checked and
remain locally unverified. The returned transaction is unsigned; the consumer
wallet decides whether to approve, sign, and send. Do not vendor or self-host
the upstream transaction-builder repository, whose licensing is unresolved.
See the [bridge registry](registry/BRIDGE.md) and the package guides for
language-specific constructors and error names. Cross-language bridge behavior
is captured by the [shared fixture registry](registry/fixtures/mayan-swift-v2-cases.json)
and [parity verifier](registry/verify-bridge-parity.mjs); CI and independent
review records remain the source of gate status.

## Offline token rankings

The published `0.7.0` packages expose an offline ranking snapshot and its
metadata. The ranking metric is total supply multiplied by the direct native
pool price, in exact rational native atomic units. It is not circulating market
capitalization. Coverage is explicit; partial coverage and unranked reasons
remain visible in the snapshot. The optional global USD market-cap metric is
rights-gated and disabled by default.

Ranking lookups use exact chain IDs and read no network, vendor API, current
time, or client configuration. Generated records and metadata are immutable in
each SDK. The canonical [ranking artifact](registry/token-rankings.json) and
[ranking configuration](registry/ranking-config.json) carry the current metric,
observation time, status, coverage, digest, and unranked reasons. See the
[ranking implementation](registry/token-rankings.mjs) and the package
entry-point documentation for the language-specific `list` API.

## Source-checkout maintenance

The source checkout has bounded, read-only RPC discovery for Ethereum factory
pairs, Avalanche factory pairs, and Solana program accounts. Verified address
facts are replayed from the configured endpoints in
[`registry/discovery.mjs`](registry/discovery.mjs) using
[`registry/discovery-config.json`](registry/discovery-config.json). Newly
observed tokens use unclassified address-only names and symbols, with
`stableCurrency`, `underlyingAssetId`, and `economicReferenceAssetId` set to
`null` until reviewed.

Admission is capped at 8 tokens and 8 pools per run. Current catalog records,
source evidence, and metadata are maintained in the canonical
[token catalog](registry/token-catalog.json), [DEX and pool catalog](registry/dex-catalog.json),
and [ranking artifact](registry/token-rankings.json).
Direct reviewed native pools use WETH, WAVAX, or classic WSOL and native liquidity floors of 10 ETH,
100 AVAX, or 100 SOL in chain-native atomic units. Discovery state is bounded
and resumable; cap- or dependency-deferred candidates are revalidated from
fresh verified receipts before they can be reconsidered. IDs and aliases are
append-only, and an RPC outage does not retire an existing record.

The installed schedules are daily discovery/ranking maintenance at 03:17 UTC,
an hourly read-only pool monitor at minute 13 with a persisted rotating batch
of 32, and Thursday release preparation at 03:47 UTC. Automatic data merge
and automatic release are opt-in through `ERPC_ENABLE_AUTOMATIC_DATA_MERGE`
and `ERPC_ENABLE_AUTOMATIC_RELEASE`; both are currently `OFF`. Eligible
additive data can merge only after exact CI and applicable branch protection.
A later baseline-to-data merge followed by a version-only PR can produce the
paired root and Go tags in the release workflow, followed by an explicit
publisher dispatch when the opt-in policies and protections are enabled.
Source, schema, adapter, and API changes, including the initial `0.7.0`
feature release, require manual review. These schedules prepare reviewable
work; the local integration evidence is not Actions promotion provenance, and
these schedules do not establish that a live scheduled run has succeeded.

## Quick starts

### TypeScript

```ts
import { createErpcClient } from '@elsoul/erpc-sdk'

const apiKey = process.env.ERPC_API_KEY
if (!apiKey) throw new Error('ERPC_API_KEY is required')

const erpc = createErpcClient({ apiKey })

const slot = await erpc.solana.rpc.getSlot().send()
const chainId = await erpc.ethereum.rpc.eth_chainId().send()
const avalancheChainId = await erpc.avalanche.rpc.eth_chainId().send()

console.log({ slot, chainId, avalancheChainId })
erpc.close()
```

HTTP JSON-RPC methods return a pending request. Calling `.send()` performs the
request, so request construction stays explicit and future middleware can be
added without changing method signatures.

### Rust

```rust
use erpc_sdk::{ErpcClient, ErpcClientConfig};

let erpc = ErpcClient::new(ErpcClientConfig::new(api_key))?;
let slot = erpc.solana.rpc.get_slot(Vec::<serde_json::Value>::new())?
    .send()
    .await?;
let chain_id = erpc.ethereum.rpc.eth_chain_id().send().await?;
let avalanche_chain_id = erpc.avalanche.rpc.eth_chain_id().send().await?;
```

### Python

```python
from erpc_sdk import ErpcClient, ErpcClientConfig

async with ErpcClient(ErpcClientConfig(api_key)) as erpc:
    slot = await erpc.solana.rpc.get_slot().send()
    chain_id = await erpc.ethereum.rpc.eth_chain_id().send()
    avalanche_chain_id = await erpc.avalanche.rpc.eth_chain_id().send()
```

### Go

```go
import erpc "github.com/elsoul/erpc-sdk/packages/go"

client, err := erpc.NewClient(erpc.Config{APIKey: apiKey})
if err != nil {
	return err
}
defer client.Close()

slot, err := client.Solana.RPC.GetSlot(ctx)
chainID, err := client.Ethereum.RPC.ChainID(ctx)
avalancheChainID, err := client.Avalanche.RPC.ChainID(ctx)
```

### Ruby

```ruby
require "erpc_sdk"

begin
  erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: api_key))
  slot = erpc.solana.rpc.get_slot.send
  chain_id = erpc.ethereum.rpc.eth_chain_id.send
  avalanche_chain_id = erpc.avalanche.rpc.eth_chain_id.send
ensure
  erpc&.close
end
```

## API overview

| Namespace | Purpose |
| --- | --- |
| `erpc.solana.rpc` | Solana JSON-RPC |
| `erpc.solana.das` | Indexed assets and tokens |
| `erpc.solana.history` | Address transactions and transfers |
| `erpc.solana.leaders` | Leader slots and validator information |
| `erpc.solana.analytics` | Epoch, slot, program, and TPS analytics |
| `erpc.solana.subscriptions` | Enhanced WebSocket subscriptions |
| `erpc.ethereum.rpc` | Ethereum JSON-RPC |
| `erpc.ethereum.subscriptions` | Ethereum WebSocket subscriptions |
| `erpc.avalanche.rpc` | Avalanche C-Chain EVM-compatible JSON-RPC |
| `erpc.avalanche.subscriptions` | Avalanche C-Chain WebSocket subscriptions |
| `erpc.avalanche.avax` | C-Chain AVAX atomic transaction API |
| `erpc.avalanche.xChain` | X-Chain (`avm.*`) API |
| `erpc.avalanche.pChain` | P-Chain (`platform.*`) API |
| `erpc.avalanche.proposerVm` | P-Chain proposer VM API |
| `erpc.avalanche.info` | Avalanche network upgrade information |
| `erpc.avalanche.index` | C/P/X block and X transaction indexes |
| `erpc.price` | Price metadata, updates, and streams |
| `erpc.account` | ERPC token balance |
| `erpc.usage` | Masked monthly API-key usage |
| `cloud.catalog` | Provider-neutral Cloud capabilities |
| `cloud.credit` | Read-only credit and burn-rate snapshot |
| `cloud.resources` | Credential-free Cloud resource inventory |

See [method availability](docs/METHODS.md) for the complete supported catalog
and the server-dependent capabilities planned for later releases.

## Solana examples

```ts
const balance = await erpc.solana.rpc.getBalance(address).send()
const asset = await erpc.solana.das.getAsset({ id: assetId }).send()
const leaders = await erpc.solana.leaders.getLeaderSlots(slot).send()

const transactions = await erpc.solana.history
  .getTransactionsForAddress(address, { limit: 20 })
  .send()

const programs = await erpc.solana.analytics
  .jetTopPrograms({ limit: 10 })
  .send()
```

## Solana transaction v1

Solana v1 and its 4096-byte transaction-size support were activated on the
network on 2026-09-15; v0 and legacy transactions remain unchanged. See the
[official larger transaction sizes note](https://solana.com/upgrades/larger-transaction-sizes).
For generic RPC pass-through, pass `maxSupportedTransactionVersion: 1` when
the caller supports v1, and pass a serialized payload with `encoding: 'base64'`
when sending or simulating a larger transaction. The SDK forwards these
options and payloads unchanged; the caller supplies the signed transaction,
and the SDK does not build, sign, or decode it. A server JSON-RPC error such as
`-32015` remains an `ErpcJsonRpcError` with its numeric code and optional data
preserved. The Mayan bridge adapter has a separate provider envelope contract:
it accepts only v0 framing at or below 1232 bytes and rejects v1 until a
provider-specific v1 contract is reviewed. See the [Solana transaction v1
guide](packages/typescript/docs/solana-v1.md).

```ts
const transaction = await erpc.solana.rpc
  .getTransaction(signature, { maxSupportedTransactionVersion: 1 })
  .send()
const sent = await erpc.solana.rpc
  .sendTransaction(serializedBase64, { encoding: 'base64' })
  .send()
```

## Ethereum examples

```ts
const block = await erpc.ethereum.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const balance = await erpc.ethereum.rpc
  .eth_getBalance(address, 'latest')
  .send()
```

## Avalanche examples

Avalanche C-Chain EVM calls continue to use the Ethereum-compatible catalog.
Native AVAX, X-Chain, P-Chain, proposer VM, and information methods use named
parameters on `/ava`. Index calls use their required explicit C/P/X routes.

```ts
const chainId = await erpc.avalanche.rpc.eth_chainId().send()
const block = await erpc.avalanche.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const pHeight = await erpc.avalanche.pChain.getHeight().send()
const xHeight = await erpc.avalanche.xChain.getHeight().send()
const validators = await erpc.avalanche.pChain
  .getCurrentValidators({})
  .send()
const indexedTransaction = await erpc.avalanche.index.xChainTransactions
  .getContainerByID({ id: transactionId })
  .send()

const accepted = await erpc.avalanche.subscriptions.subscribe(
  'newAcceptedTransactions',
  (transaction) => console.log(transaction),
)

await accepted.unsubscribe()
```

Native and Index API namespaces do not support JSON-RPC batches; the SDK rejects
non-empty batches before network I/O. Every namespace retains `raw` access for
forward-compatible exact wire method names.

## Price data

```ts
const latest = await erpc.price.getLatestPriceUpdates({
  ids: [feedId],
  parsed: true,
})

for await (const event of erpc.price.streamPriceUpdates({ ids: [feedId] })) {
  console.log(event.data)
}
```

Price and confidence values are strings to preserve protocol precision.

## Account balance

```ts
const tokenBalance = await erpc.account.getTokenBalance()
console.log(tokenBalance.remaining_tokens)
```

## Monthly API-key usage

The regular API-key client can read the current month or a specific calendar
month. Results contain only the key length and last four characters; the SDK
also projects the response onto the documented fields so unexpected credential
fields are never returned to application code.

```ts
const usage = await erpc.usage.getMonthlyApiKeyUsage()
const august = await erpc.usage.getMonthlyApiKeyUsage({
  yearMonth: '2026-08',
})

console.log(usage.totalCredits, august.apiKeys[0]?.apiKeyLast4)
```

## Cloud read client

Applications that already have a scoped ERPC Cloud OAuth access token can use
the separate Cloud client. It does not accept or retain a refresh credential.

```ts
import { createErpcCloudClient } from '@elsoul/erpc-sdk'

const cloud = createErpcCloudClient({ accessToken })
const catalog = await cloud.catalog.list()
const credit = await cloud.credit.get()
const resources = await cloud.resources.list()
const usage = await cloud.usage.getMonthlyApiKeyUsage()

const first = resources[0]
const resource = first ? await cloud.resources.get(first.id) : undefined
const status = first
  ? await cloud.resources.getStatus(first.id)
  : undefined
```

Cloud resource responses deliberately exclude usernames, passwords, hosts, and
internal product or subscription identifiers. The Cloud OAuth and resource
routes are enabled as a coordinated server rollout; see the roadmap for rollout
status. Catalog entries omit prices and availability that the service cannot
verify. Credit snapshots use integer cents and include their quote validity
window. The CLI owns interactive Device Authorization and keychain storage.

## Batch requests

```ts
const [slot, blockHeight] = await erpc.solana.rpc
  .batch([
    { method: 'getSlot', params: [] },
    { method: 'getBlockHeight', params: [] },
  ])
  .send()
```

The SDK preserves server batch boundaries. It rejects unsupported mixed Solana
batches locally, accepts at most 256 calls in one batch, and never silently
splits a batch.

## WebSocket subscriptions

```ts
const heads = await erpc.ethereum.subscriptions.subscribe(
  'newHeads',
  (header) => console.log(header),
)

const accounts = await erpc.solana.subscriptions.accountSubscribe(
  address,
  (account) => console.log(account),
)

await heads.unsubscribe()
await accounts.unsubscribe()
erpc.close()
```

Browsers and modern Node.js releases can use their global WebSocket
implementation. Other runtimes can pass a compatible constructor with the
`webSocket` client option.

## Error handling

```ts
import {
  ErpcHttpError,
  ErpcJsonRpcError,
  ErpcTimeoutError,
} from '@elsoul/erpc-sdk'

try {
  await erpc.solana.rpc.getSlot().send()
} catch (error) {
  if (error instanceof ErpcJsonRpcError) {
    console.error(error.rpcCode, error.message, error.data)
  }
  else if (error instanceof ErpcHttpError) console.error(error.status)
  else if (error instanceof ErpcTimeoutError) console.error('Timed out')
  else throw error
}
```

Error URLs redact the API key. Requests are not retried automatically, which
avoids unexpectedly repeating state-changing calls.

## Raw methods

Typed catalogs cover every method currently exposed by ERPC. New server methods
can be called before the next SDK release through the raw escape hatch:

```ts
const result = await erpc.solana.rpc
  .raw<MyResult>('futureMethod', [{ enabled: true }])
  .send()
```

## Configuration

```ts
const erpc = createErpcClient({
  apiKey,
  endpoint: 'https://edge.erpc.global',
  avalancheEndpoint: 'https://ava-rpc.erpc.global',
  accountEndpoint: 'https://solana-rpc.erpc.global',
  userEndpoint: 'https://user-api.erpc.global',
  timeoutMs: 30_000,
  fetch: customFetch,
  webSocket: CustomWebSocket,
})
```

`apiKey` is required for default eRPC connections. The `0.8.0` direct-node
settings above (`solanaRpc`, `ethereumRpc`, or `avalancheCRpc`) allow keyless
selected RPC access; legacy `endpoint` and `avalancheEndpoint` remain eRPC base
URLs, not full dedicated-node overrides. Default endpoints and timeout values
are exported for applications that need to inspect them.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack:check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo package --package erpc-sdk
cd packages/ruby
bundle install
bundle exec rake
bundle exec rake package
```

Live smoke tests are opt-in and require a real ERPC key:

```bash
ERPC_API_KEY=your_key corepack pnpm --filter @elsoul/erpc-sdk test:live
```

Prefer loading the key from a protected local environment file so it does not
enter shell history. Never commit credentials.

## Documentation

- [Method availability](docs/METHODS.md)
- [DEX and pool catalog](registry/DEX.md)
- [Bridge capability registry](registry/BRIDGE.md)
- [Registry roadmap](registry/ROADMAP.md)
- [Maintenance runbook](registry/weekly-maintenance.md)
- [Solana transaction v1 guide](packages/typescript/docs/solana-v1.md)
- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [Release process](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Release model

Publishing is initiated by a human-pushed version tag. The release workflow is
configured for registry Trusted Publishing and provenance. Merging a change
never publishes a package. See the
[release process](docs/RELEASING.md) for initial setup and release steps.

## License

[MIT](LICENSE)
