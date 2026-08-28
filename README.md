# ERPC SDK

[![CI](https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/elsoul/erpc-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40elsoul%2Ferpc-sdk.svg)](https://www.npmjs.com/package/@elsoul/erpc-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official multi-network SDK for [ERPC](https://erpc.global). One client and one
API key provide access to Solana, Ethereum, price data, indexed data, leader
and validator data, analytics, subscriptions, and account balance information.

## Packages

| Language | Package | Status |
| --- | --- | --- |
| TypeScript | [`@elsoul/erpc-sdk`](https://www.npmjs.com/package/@elsoul/erpc-sdk) | Preview |
| Rust | — | Planned after TypeScript stabilization |
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
```

Live smoke tests are opt-in and require a real ERPC key:

```bash
ERPC_API_KEY=your_key corepack pnpm --filter @elsoul/erpc-sdk test:live
```

Prefer loading the key from a protected local environment file so it does not
enter shell history. Never commit credentials.

## Documentation

- [Method availability](docs/METHODS.md)
- [Roadmap](ROADMAP.md)
- [Release process](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Release model

Publishing is initiated by a human-created GitHub Release, protected by the
`npm` GitHub Environment, and authenticated through npm Trusted Publishing.
Merging a change never publishes a package. See the
[release process](docs/RELEASING.md) for initial setup and release steps.

## License

[MIT](LICENSE)
