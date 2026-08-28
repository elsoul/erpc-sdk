# `@elsoul/erpc-sdk`

Official type-safe TypeScript client for [ERPC](https://erpc.global). Use one
client and one API key for Solana, Ethereum, price data, indexed data, leader
and validator data, analytics, subscriptions, and account information.

## Install

```bash
npm install @elsoul/erpc-sdk
# or: pnpm add @elsoul/erpc-sdk
```

The package has no runtime dependencies and includes ESM, CommonJS, and
TypeScript declarations. Node.js 20 or later is supported.

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

JSON-RPC method calls return pending requests. Call `.send()` to perform the
network request.

## Namespaces

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

## Examples

```ts
const asset = await erpc.solana.das.getAsset({ id: assetId }).send()

const block = await erpc.ethereum.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const prices = await erpc.price.getLatestPriceUpdates({
  ids: [feedId],
  parsed: true,
})

const heads = await erpc.ethereum.subscriptions.subscribe(
  'newHeads',
  (header) => console.log(header),
)

await heads.unsubscribe()
erpc.close()
```

Monthly API-key usage is available from the same client:

```ts
const usage = await erpc.usage.getMonthlyApiKeyUsage({
  yearMonth: '2026-08',
})
```

For scoped ERPC Cloud OAuth access tokens, create a client that cannot receive
or retain refresh credentials:

```ts
import { createErpcCloudClient } from '@elsoul/erpc-sdk'

const cloud = createErpcCloudClient({ accessToken })
const catalog = await cloud.catalog.list()
const credit = await cloud.credit.get()
const resources = await cloud.resources.list()
const first = resources[0]
const status = first ? await cloud.resources.getStatus(first.id) : undefined
const monthlyUsage = await cloud.usage.getMonthlyApiKeyUsage()
```

Catalog, credit, and resource results are projected onto documented public
fields. Interactive login and operating-system keychain storage belong to
`@elsoul/erpc-cli`.

## Raw methods

The typed catalogs track methods available from ERPC. The raw API provides
forward compatibility with newly introduced server methods:

```ts
const result = await erpc.solana.rpc
  .raw<MyResult>('futureMethod', [{ enabled: true }])
  .send()
```

## Documentation

- [Complete guide](https://github.com/elsoul/erpc-sdk#readme)
- [Method availability](https://github.com/elsoul/erpc-sdk/blob/main/docs/METHODS.md)
- [Roadmap](https://github.com/elsoul/erpc-sdk/blob/main/ROADMAP.md)
- [Security policy](https://github.com/elsoul/erpc-sdk/blob/main/SECURITY.md)

## License

[MIT](https://github.com/elsoul/erpc-sdk/blob/main/LICENSE)
