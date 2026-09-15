# `@elsoul/erpc-sdk`

Official type-safe TypeScript client for [ERPC](https://erpc.global). Use one
client and one API key for Solana, Ethereum, Avalanche C/P/X chains, price data,
indexed data, leader and validator data, analytics, subscriptions, and account
information.

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
const avalancheChainId = await erpc.avalanche.rpc.eth_chainId().send()

console.log({ slot, chainId, avalancheChainId })
erpc.close()
```

JSON-RPC method calls return pending requests. Call `.send()` to perform the
network request.

## Offline token catalog

The token catalog is bundled with the package, so lookups do not need an
`ErpcClient`, API key, or network request. Deployment IDs are opaque and the
chain aliases expose those IDs directly:

```ts
import {
  TOKEN_CHAIN_IDS,
  findTokenDeploymentsBySymbol,
  listTokenDeployments,
  tokens,
} from '@elsoul/erpc-sdk'

const usdcByChain = {
  ethereum: findTokenDeploymentsBySymbol(
    TOKEN_CHAIN_IDS.ethereumMainnet,
    'USDC',
  ),
  solana: findTokenDeploymentsBySymbol(TOKEN_CHAIN_IDS.solanaMainnet, 'USDC'),
  avalancheC: findTokenDeploymentsBySymbol(
    TOKEN_CHAIN_IDS.avalancheCMainnet,
    'USDC',
  ),
}

const canonicalEthereumUsdcId = tokens.ethereum.USDC
const usdDeployments = listTokenDeployments({ stableCurrency: 'USD' })
```

The result includes every matching deployment and its status, decimals,
standard, address, and flattened asset metadata. See the
[canonical registry guide](https://github.com/elsoul/erpc-sdk/blob/main/registry/README.md)
for the source data and ID policy.

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
| `erpc.avalanche.rpc` | Avalanche C-Chain EVM-compatible JSON-RPC |
| `erpc.avalanche.subscriptions` | Avalanche C-Chain WebSocket subscriptions |
| `erpc.avalanche.avax` | C-Chain AVAX atomic transaction API |
| `erpc.avalanche.xChain` | X-Chain API |
| `erpc.avalanche.pChain` | P-Chain API |
| `erpc.avalanche.proposerVm` | P-Chain proposer VM API |
| `erpc.avalanche.info` | Network upgrade information |
| `erpc.avalanche.index` | C/P/X block and X transaction indexes |
| `erpc.price` | Price metadata, updates, and streams |
| `erpc.account` | ERPC token balance |
| `erpc.usage` | Masked monthly API-key usage |

`avalancheEndpoint` defaults to `https://ava-rpc.erpc.global` and can be
overridden independently from the shared `endpoint` option. The SDK uses its
`/ava` HTTP route and `/ava-ws` WebSocket route. Native C/P/X methods use named
parameters; Index calls are routed to the required explicit chain/container
path. Native and Index batches are rejected locally. Use `raw` with an exact
wire method name for forward compatibility.

## Examples

```ts
const asset = await erpc.solana.das.getAsset({ id: assetId }).send()

const block = await erpc.ethereum.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const avalancheBlock = await erpc.avalanche.rpc
  .eth_getBlockByNumber('latest', false)
  .send()

const pChainHeight = await erpc.avalanche.pChain.getHeight().send()
const xChainHeight = await erpc.avalanche.xChain.getHeight().send()
const indexedTransaction = await erpc.avalanche.index.xChainTransactions
  .getContainerByID({ id: transactionId })
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
- [Solana transaction v1 guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/solana-v1.md)
- [Method availability](https://github.com/elsoul/erpc-sdk/blob/main/docs/METHODS.md)
- [Roadmap](https://github.com/elsoul/erpc-sdk/blob/main/ROADMAP.md)
- [Security policy](https://github.com/elsoul/erpc-sdk/blob/main/SECURITY.md)

## License

[MIT](https://github.com/elsoul/erpc-sdk/blob/main/LICENSE)
