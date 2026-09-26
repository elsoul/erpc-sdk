# `@elsoul/erpc-sdk`

Official type-safe TypeScript client for [ERPC](https://erpc.global). Use one
client and an API key for Base, Solana, Ethereum, Avalanche C/P/X chains, price
data, indexed data, leader and validator data, analytics, subscriptions, and
account information. Base is exposed as a read-only JSON-RPC facade; caller-owned
direct endpoints can be selected for Base, Solana, Ethereum, and Avalanche
C-Chain JSON-RPC.

The Base facade documented below is a `0.9.0` source candidate. The currently
published `0.8.1` npm package does not include it; use the reviewed `0.9.0`
candidate artifact or this source checkout until that version is published.

## Install

```bash
# Once 0.9.0 is published:
npm install @elsoul/erpc-sdk@0.9.0
# or: pnpm add @elsoul/erpc-sdk@0.9.0
# Before publication, use the reviewed candidate tarball or this source checkout.
```

The package includes its ESM, CommonJS, and TypeScript declarations. Node.js 20
or later is supported.

## Quick start

```ts
import { createErpcClient } from '@elsoul/erpc-sdk'

const apiKey = process.env.ERPC_API_KEY
if (!apiKey) throw new Error('ERPC_API_KEY is required')

const erpc = createErpcClient({ apiKey })

const slot = await erpc.solana.rpc.getSlot().send()
const chainId = await erpc.ethereum.rpc.eth_chainId().send()
const avalancheChainId = await erpc.avalanche.rpc.eth_chainId().send()
const baseChainId = await erpc.base.rpc.eth_chainId().send()

console.log({ slot, chainId, avalancheChainId, baseChainId })
erpc.close()
```

JSON-RPC method calls return pending requests. Call `.send()` to perform the
network request.

## Direct RPC endpoints (introduced in 0.8.0)

Caller-owned direct endpoint overrides were introduced in `0.8.0` and require
that package when installed from a registry. The `0.7.0` package does not
include this API; check the package version badge and the [latest GitHub
release](https://github.com/elsoul/erpc-sdk/releases/latest) for live
publication status.

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

For direct HTTP transports, the public `endpoint` property is diagnostic
metadata containing only the origin/root. The private request target still
preserves the configured path, query order, and percent encoding exactly.

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

`solanaRpc`, `ethereumRpc`, `avalancheCRpc`, and `baseRpc` select direct Solana,
Ethereum, Avalanche C-Chain, and Base JSON-RPC transports. `baseRpc` accepts
only an HTTP URL and scoped HTTP headers because the Base facade has no
WebSocket or subscription surface. Without an API key, non-overridden chains
and ERPC REST, native, and index services fail locally. The
`RpcEndpointConfig.headers` field applies to direct HTTP requests only; those
headers are never sent on WSS connections.

## Base read-only RPC (`0.9.0` candidate)

The `0.9.0` candidate API-key client uses `https://base.erpc.global/` at the
root JSON-RPC path.
The first check for a Base connection should be `eth_chainId()` and must return
`0x2105` (Base mainnet). The following uses the catalog's Base EURC record and
formats the raw response with integer arithmetic:

```ts
import {
  createErpcClient,
  getTokenDeployment,
  tokens,
} from '@elsoul/erpc-sdk'

const erpc = createErpcClient({ apiKey: process.env.ERPC_API_KEY! })
const wallet = '0x7A5837f5bB52C53e08fcFf214c2Cd11daa8EF9EE'
const eurc = getTokenDeployment(tokens.base.EURC)
if (eurc?.address === null || eurc === undefined) {
  throw new Error('Base EURC is missing from the catalog')
}

const chainId = await erpc.base.rpc.eth_chainId().send()
if (chainId !== '0x2105') throw new Error(`Unexpected Base chain: ${chainId}`)

const nativeWei = BigInt(
  await erpc.base.rpc.eth_getBalance(wallet, '0x3167564').send(),
)
const calldata = `0x70a08231${wallet.slice(2).padStart(64, '0')}`
const eurcAtomic = BigInt(
  await erpc.base.rpc.eth_call(
    { to: eurc.address, data: calldata },
    '0x3167564',
  ).send(),
)

const formatUnits = (value: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/u, '')
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`
}

const eurcDisplay = formatUnits(eurcAtomic, eurc.decimals)
// Pinned review read: eurcAtomic === 5_500_000n and eurcDisplay === '5.5'.
console.log({ chainId, nativeWei, eurcAtomic, eurcDecimals: eurc.decimals, eurcDisplay })
erpc.close()
```

For a keyless caller-owned endpoint, use `baseRpc`. Its URL path and query are
sent exactly as configured, and its headers stay scoped to Base:

```ts
const erpc = createErpcClient({
  baseRpc: {
    httpUrl: process.env.ERPC_BASE_RPC_URL!,
    headers: { authorization: 'Bearer node-token' },
  },
})

const chainId = await erpc.base.rpc.eth_chainId().send()
```

The Base client exposes only `rpc`; the inner read-only facade has exactly
`endpoint`, `eth_chainId`, `eth_getBalance`, and `eth_call`. It does not provide
raw, batch, subscription, signing, or broadcast methods. `baseEndpoint` forwards
the main API key and global headers, so use it only for a caller-trusted,
eRPC-compatible host. `baseRpc` takes precedence over it and over global
headers; it sends only credentials explicitly scoped inside the direct override.

## Wallets, signing, and broadcast

`ErpcClient` has no wallet, private-key, or signer configuration. Swap
preparation and Mayan `buildUnsigned` return unsigned transaction envelopes;
the caller owns account selection, allowance changes, nonce and fee policy,
transaction review, key custody, signing, broadcast, and confirmation. The
`from`, `sender`, `swapperAddress`, and `feePayer` fields are public identity
checks, not signing authority. A pending RPC request's `.send()` performs the
network request and does not sign bytes.

| Concern | Owner |
| --- | --- |
| Key or hardware-wallet custody | Caller application or wallet provider |
| Transaction and allowance review | Caller application and user |
| Cryptographic signing | External wallet or signer |
| Signed-byte broadcast | Caller-selected ERPC RPC method |
| Confirmation and settlement interpretation | Caller application |

See the [shared wallet and signing model](https://github.com/elsoul/erpc-sdk/blob/main/README.md#wallets-and-signing)
and the [TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md)
for initialized ethers 6 and `@solana/web3.js` 1.x examples. The guide keeps
the selected RPC URL identical for network checks and sends signed bytes only
through ERPC.

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

The reviewed DEX catalog and swap exports were introduced in `0.7.0`.
Unsigned EVM preparation and simulation below were introduced in `0.8.0` and
require that package.

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

The two reviewed EVM pools also support unsigned ERC-20 exact-input
preparation and RPC simulation:

```ts
const request = {
  chainId: DEX_CHAIN_IDS.ethereum,
  poolDefinitionId: 'pool-0001',
  inputTokenDeploymentId: tokens.ethereum.WETH,
  outputTokenDeploymentId: tokens.ethereum.USDC,
  amountIn: '1000000000000000000',
  sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  slippageBps: 50,
  deadline: String(Math.floor(Date.now()/1000)+300),
}

const prepared = await erpc.swap.prepareExactInputSwap(request)

const simulation = await erpc.swap.simulateExactInputSwap(request)
```

Preparation performs a fresh quote, validates the reviewed router and wrapped
native deployment, and returns an immutable chain-bound unsigned transaction
envelope. It does not create approval calldata, sign, send, or fill wallet
fields. Review `prepared.transaction`, then pass the typed envelope to an
external signer and the ERPC-only broadcast helper in the
[TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md).

Use the `simulation` result to inspect the canonical allowance and router
amounts before asking the caller's wallet to manage allowance, signing, or
broadcasting. The simulation call itself is read-only and uses only the
configured RPC transport.

## Optional Mayan Swift v2 bridge

The published `0.8.1` API provides the Mayan Swift v2 client as an explicit
standalone adapter for the reviewed issued EURC routes between Ethereum and
Solana. It is not attached to the default `ErpcClient`; construct it separately
when the external provider and its solver, relayer, and explorer dependencies
are acceptable:

```ts
import {
  createMayanSwiftV2BridgeClient,
  TOKEN_CHAIN_IDS,
} from '@elsoul/erpc-sdk'

const mayan = createMayanSwiftV2BridgeClient({
  builderEndpoint: 'https://tx-builder.mayan.finance',
  explorerEndpoint: 'https://explorer-api.mayan.finance/v3',
})
const quotes = await mayan.quoteExactInput({
  sourceChainId: TOKEN_CHAIN_IDS.ethereumMainnet,
  destinationChainId: TOKEN_CHAIN_IDS.solanaMainnet,
  sourceTokenDeploymentId: 'deployment-0011',
  destinationTokenDeploymentId: 'deployment-0013',
  amountIn: '1000000',
  slippageBps: 50,
})
```

This keyless quote example reflects the provider's documented optional-key
policy. `buildUnsigned` has a separate SDK guard: supply a caller-managed
`builderApiKey` in a build client, or explicitly set
`allowUnauthenticatedBuild: true` to permit a keyless attempt. The opt-in does
not override provider authentication.

The adapter posts the exact route request to Mayan's `/quote`, preserves the
provider-signed quote text, and can build a structurally checked unsigned
source transaction with `buildUnsigned`. It does not verify the provider
signature locally or prove settlement, and it does not sign, approve, submit,
refund, or broadcast transactions. Pass its typed unsigned envelope to an
external signer only after review; the signing and ERPC-only broadcast flow is
shown in the [TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md).

`builderEndpoint` and `explorerEndpoint` default to
`https://tx-builder.mayan.finance` and `https://explorer-api.mayan.finance/v3`;
set them to caller-approved base URLs to customize the provider endpoints.
`getStatus` reads the indexed status endpoint and reports the provider assertion
as unverified local settlement state. `builderApiKey` is a separate Mayan
build-only key sent only to `/build`; quote and status calls do not receive it,
and no eRPC credential is forwarded.

Mayan authentication has three separate layers:

| Layer | Behavior |
| --- | --- |
| Mayan documentation | The quote and transaction-builder documents describe the service key as optional. |
| SDK policy | `buildUnsigned` requires `builderApiKey` by default; `allowUnauthenticatedBuild: true` only permits the caller's keyless HTTP attempt. |
| Dated hosted observation | On 2026-09-17, four EURC/USDC quotes returned HTTP 200 without keys; default builds made no request, while explicit keyless `/build` attempts returned HTTP 401. This is bounded evidence, not a permanent provider requirement. |

The published `0.8.1` package supports the reviewed issued EURC directions.
Native USDC direct routes are a source-tree addition and remain unreleased;
they are not part of the published `0.8.1` package.

The source tree also contains an unreleased native USDC addition for the same
Ethereum/Solana directions. It uses Mayan's direct SWIFT route and does not add
Jupiter or another hosted source-swap dependency. The addition is not included
in the published `0.8.1` package; its package version and release publication
remain future work.

The `0.8.1` maintenance patch updates the Workers fetch invocation boundary;
it does not include the new native USDC or local unsigned-builder paths.

### Local unsigned construction

The source tree also exposes an explicit keyless construction path for the
reviewed EURC and native USDC directions. Pass a hosted normalized quote and a
fresh public 16-byte `orderNonce` to `prepareSourceSwap`, then pass its plan to
`buildLocalUnsigned`:

```ts
const localClient = createMayanSwiftV2BridgeClient({
  localBuild: {
    sourceSwapEndpoint: 'https://price-api.mayan.finance/v3',
    ethereumRpc: { httpUrl: 'https://your-ethereum-rpc.example' },
    solanaRpc: { httpUrl: 'https://your-solana-rpc.example' },
  },
})

const context = {
  quote: quotes[0],
  swapperAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  destinationAddress: 'HQhyrHjgq5ftgsibxdUwLvDZ5HT4c9bNuBWJMmZvTd5b',
  orderNonce: '0x00112233445566778899aabbccddeeff',
}
const sourceSwapPlan = await localClient.prepareSourceSwap(context)
const unsigned = await localClient.buildLocalUnsigned({
  ...context,
  sourceSwapPlan,
})
```

`buildLocalUnsigned` requires the explicitly configured source RPC matching the
source chain. It performs bounded read-only identity and byte preflight, keeps
the original quote unchanged, and returns an unsigned EVM or Solana envelope.
Local source-swap requests are anonymous and use no Mayan builder key; direct
USDC uses `{ kind: 'none' }` and makes no source-swap request. There is no
fallback to hosted `/build`, and the local path never creates keys, approves,
signs, submits, broadcasts, or claims settlement. The caller owns wallet
custody and all signing and ERPC broadcast steps described in the
[TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md).

These local methods and native USDC routes are source-tree additions. They are
not part of the published TypeScript `0.8.1` package; the published bridge API
remains the hosted EURC adapter described above.

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
