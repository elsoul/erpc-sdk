# ERPC SDK

[![ERPC — Global Edge Blockchain Infrastructure](https://storage.erpc.global/ERPCheader.jpg)](https://erpc.global)

<p align="center">
  <a href="https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml"><img src="https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@elsoul/erpc-sdk"><img src="https://img.shields.io/npm/v/%40elsoul%2Ferpc-sdk.svg" alt="npm" /></a>
  <a href="https://crates.io/crates/erpc-sdk"><img src="https://img.shields.io/crates/v/erpc-sdk.svg" alt="crates.io" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
</p>

<p align="center">
  <strong>ERPC Official Multi-Network Blockchain SDK<br />
  Built for Developers. Ready for AI Agents.</strong>
</p>

One client and one API key provide access to Solana, Ethereum, price data,
indexed data, leader and validator data, analytics, subscriptions, and account
balance information.

## Packages

| Language | Package | Status |
| --- | --- | --- |
| TypeScript | [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk) | Preview |
| Rust | [`erpc-sdk`](https://crates.io/crates/erpc-sdk) | Preview |
| Python | — | Planned |
| Go | — | Planned |

## Install

```bash
npm install @elsoul/erpc-sdk
# or: pnpm add @elsoul/erpc-sdk
# or: yarn add @elsoul/erpc-sdk
# or: bun add @elsoul/erpc-sdk
```

The TypeScript package has no runtime dependencies and includes ESM, CommonJS,
and TypeScript declarations.

For Rust:

```bash
cargo add erpc-sdk
```

See the [Rust package guide](packages/rust/README.md) for async JSON-RPC,
batching, subscriptions, price streams, cancellation, and Cloud examples. The
crate supports Rust 1.85 and newer.

## Quick start

```ts
import { createErpcClient } from '@elsoul/erpc-sdk'

const apiKey = process.env.ERPC_API_KEY
if (!apiKey) throw new Error('ERPC_API_KEY is required')

const erpc = createErpcClient({ apiKey })

const slot = await erpc.solana.rpc.getSlot().send()
const chainId = await erpc.ethereum.rpc.eth_chainId().send()

console.log({ slot, chainId })
erpc.close()
```

HTTP JSON-RPC methods return a pending request. Calling `.send()` performs the
request, so request construction stays explicit and future middleware can be
added without changing method signatures.

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

## Ethereum examples

```ts
const block = await erpc.ethereum.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const balance = await erpc.ethereum.rpc
  .eth_getBalance(address, 'latest')
  .send()
```

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
```

Live smoke tests are opt-in and require a real ERPC key:

```bash
ERPC_API_KEY=your_key corepack pnpm --filter @elsoul/erpc-sdk test:live
```

Prefer loading the key from a protected local environment file so it does not
enter shell history. Never commit credentials.

## Documentation

- [Method availability](docs/METHODS.md)
- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [Release process](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Release model

Publishing is initiated by a human-pushed version tag, protected by the `npm`
and `crates-io` GitHub Environments, and authenticated through registry Trusted
Publishing. Merging a change never publishes a package. See the
[release process](docs/RELEASING.md) for initial setup and release steps.

## License

[MIT](LICENSE)
