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

One client and one API key provide access to Solana, Ethereum, Avalanche
C-Chain, X-Chain, P-Chain, price data, indexed data, leader and validator data,
analytics, subscriptions, and account balance information.

## Packages

| Language | Package | Status |
| --- | --- | --- |
| TypeScript | [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk) | Published 0.6.0 |
| Rust | [`erpc-sdk`](https://crates.io/crates/erpc-sdk) | Published 0.6.0 |
| Python | [`erpc-sdk`](https://pypi.org/project/erpc-sdk/) | Published 0.6.0 |
| Go | [`github.com/elsoul/erpc-sdk/packages/go`](https://pkg.go.dev/github.com/elsoul/erpc-sdk/packages/go) | Published 0.6.0 |
| Ruby | [`erpc-sdk`](https://rubygems.org/gems/erpc-sdk) | Published 0.6.0 |

The current published package baseline, [latest GitHub release](https://github.com/elsoul/erpc-sdk/releases/latest),
and package manifests remain `0.6.0`. The source checkout contains the
bounded token, DEX, pool, ranking, and RPC-only quote implementation planned
for the unreleased `0.7.0` package. Installing the current published package
does not provide these new exports yet.

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
go get github.com/elsoul/erpc-sdk/packages/go@v0.6.0
```

Ruby:

```bash
gem install erpc-sdk
```

See the package guides for [TypeScript](packages/typescript/README.md),
[Rust](packages/rust/README.md), [Python](packages/python/README.md),
[Go](packages/go/README.md), and [Ruby](packages/ruby/README.md). Minimum
versions are Rust 1.85, Python 3.11, Go 1.22, and Ruby 3.1.

## Offline token catalog

The source checkout contains a bounded, source-backed token catalog across
Ethereum, Solana, and Avalanche C-Chain. Catalog reads are local: they do not
create a client, need an API key, or access a network.

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

These catalog and quote exports are planned for the unreleased `0.7.0`
package. Until that release is published, `npm install @elsoul/erpc-sdk`
resolves to the published `0.6.0` package and its exports do not include them.

## DEX catalog and RPC-only quotes

The source tree contains generated DEX, pool, native/wrapped, and alias
records across the five SDKs. The reviewed seed quote tuples are Ethereum
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
metadata only; no automatic wrapping is performed. Route selection,
transaction building, signing, simulation, sending, bridging, and Solana CLMM
quotes remain future work.

Only the reviewed seed pool/token tuples receive quote capability. Discovery
can record new pool and token facts for review, but it does not enable new swap
execution or bridge support.

## Offline token rankings

The source checkout exposes an offline ranking snapshot and its metadata. The
ranking metric is total supply multiplied by the direct native pool price, in
exact rational native atomic units. It is not circulating market
capitalization. Coverage is explicit; partial coverage and unranked reasons
remain visible in the snapshot. The optional global USD market-cap metric is
rights-gated and disabled by default.

Ranking lookups use exact chain IDs and read no network, vendor API, current
time, or client configuration. Generated records and metadata are immutable in
each SDK. The current source snapshot is partial, with 11 ranking records and
54 explicit unranked rows; its metadata is the source of truth for metric,
observation time, status, coverage, and digest. The current ranking digest is
`f8ae479007fa782995aaaf6aa1c414ba1b6a10a92b7abe481b055293a91ac01c`.
See [`registry/token-rankings.json`](registry/token-rankings.json),
[`registry/token-rankings.mjs`](registry/token-rankings.mjs), and the package
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

Admission is capped at 8 tokens and 8 pools per run. The 2026-09-16 local
source snapshot contains 44 assets, 65 token deployments, and 12 pools; the
local review admitted 5 tokens and 8 pools with partial three-chain coverage.
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

For Solana transaction v1, pass `maxSupportedTransactionVersion: 1` when the
caller supports v1, and pass a serialized payload with `encoding: 'base64'`
when sending or simulating a larger transaction. The SDK forwards these
options and payloads unchanged; the caller supplies the signed transaction,
and the SDK does not build, sign, or decode it. A server JSON-RPC error such as
`-32015` remains an `ErpcJsonRpcError` with its numeric code and optional data
preserved. See the [Solana transaction v1 guide](packages/typescript/docs/solana-v1.md).

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

Only `apiKey` is required. Default endpoints and timeout values are exported
for applications that need to inspect them.

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
