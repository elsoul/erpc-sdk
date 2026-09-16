# `@elsoul/erpc-sdk`

Official type-safe TypeScript client for [ERPC](https://erpc.global). Use one
client and an API key for Solana, Ethereum, Avalanche C/P/X chains, price data,
indexed data, leader and validator data, analytics, subscriptions, and account
information. Caller-owned direct endpoints can be selected for Solana,
Ethereum, and Avalanche C-Chain JSON-RPC.

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

## Direct RPC endpoints

The published `0.7.0` package predates this direct endpoint API; these examples
describe the next unreleased source line.

Use a caller-owned endpoint without an eRPC API key by supplying at least one
chain override. The HTTP URL is the complete JSON-RPC request target, so its
path and query are preserved:

```ts
const erpc = createErpcClient({
  ethereumRpc: {
    httpUrl: 'https://node.example/customer/path?region=eu',
  },
})

const chainId = await erpc.ethereum.rpc.eth_chainId().send()
```

The configured HTTP URL is treated as the final target. Redirect responses are
returned as HTTP errors, and no redirected request is made.

Direct HTTP requests use `credentials: 'omit'`, so ambient browser cookies and
authentication are not sent implicitly. Add authentication explicitly through
the endpoint's scoped headers when needed.

Provide an independent WebSocket URL and headers when the node requires them:

```ts
import type { RpcEndpointConfig } from '@elsoul/erpc-sdk'

const ethereumRpc: RpcEndpointConfig = {
  httpUrl: 'https://node.example/rpc',
  webSocketUrl: 'wss://node.example/socket',
  headers: {
    authorization: 'Bearer node-token',
  },
}

const erpc = createErpcClient({
  ethereumRpc,
})
```

`solanaRpc`, `ethereumRpc`, and `avalancheCRpc` select direct Solana, Ethereum,
and Avalanche C-Chain JSON-RPC transports. Without an API key, non-overridden
chains and ERPC REST, native, and index services fail locally. The
`RpcEndpointConfig.headers` field applies to direct HTTP requests only; those
headers are never sent on WSS connections.

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

## Offline token rankings

Ranking data is bundled as an immutable snapshot and is available without an
API key or network request:

```ts
import {
  TOKEN_CHAIN_IDS,
  TOKEN_RANKINGS_METADATA,
  listTokenRankings,
} from '@elsoul/erpc-sdk'

const ethereumRankings = listTokenRankings(TOKEN_CHAIN_IDS.ethereumMainnet)
console.log({ status: TOKEN_RANKINGS_METADATA.status, ethereumRankings })
```

Rows use the reviewed ranking metric recorded in
`TOKEN_RANKINGS_METADATA`. For the native total-supply-value metric, values are
exact rational values in atomic native units. The snapshot can be unconfigured
or partial, has no current-time filtering, and does not fetch live prices or
supply data; check its metadata before presenting a ranking as current.

## Offline DEX and pool catalog

DEX deployments, pool addresses, native/wrapped relationships, and
chain-qualified aliases are bundled as generated data. These lookups are
offline and use opaque IDs, so an Ethereum USDC address cannot be confused
with an Avalanche or Solana deployment:

The published package baseline is currently `0.7.0`, and it includes the
reviewed DEX catalog and swap exports described below.

```ts
import {
  DEX_CHAIN_IDS,
  dexes,
  findPoolDefinitionsByPair,
  getNativeWrapDefinition,
  pools,
  tokens,
} from '@elsoul/erpc-sdk'

const ethereumPools = findPoolDefinitionsByPair(
  DEX_CHAIN_IDS.ethereum,
  tokens.ethereum.WETH,
  tokens.ethereum.USDC,
)
const uniswap = dexes.ethereum.UNISWAP_V2
const weth = getNativeWrapDefinition(tokens.ethereum.ETH)
const pool = pools.ethereum.UNISWAP_V2_USDC_WETH
```

The reviewed Ethereum Uniswap V2 and Avalanche LFJ legacy constant-product
pools support RPC-only exact-input quotes. Solana Orca and Raydium records are
available for lookup while their CLMM quote adapters are being added. Catalog
growth adds lookup and monitoring data; it does not implicitly add swap
eligibility:

```ts
const quote = await erpc.swap.quoteExactInput({
  chainId: DEX_CHAIN_IDS.ethereum,
  poolDefinitionId: pool,
  inputTokenDeploymentId: tokens.ethereum.WETH,
  outputTokenDeploymentId: tokens.ethereum.USDC,
  amountIn: '1000000000000000000',
})

console.log(quote.amountOut)
```

Quotes read the configured EVM RPC at one EIP-1898 block snapshot and apply
the constant-product formula locally. The request does not build, sign,
simulate, or broadcast a transaction; route selection, slippage, bridging,
and Solana CLMM execution are separate capabilities.

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
