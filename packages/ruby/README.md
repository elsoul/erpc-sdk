# ERPC SDK for Ruby

Synchronous Ruby client for ERPC. It covers standard Solana, Ethereum, and
Avalanche C/P/X-chain JSON-RPC, indexed data, analytics, WebSocket subscriptions,
price REST and server-sent events, account usage, and scoped Cloud reads.

```bash
gem install erpc-sdk
```

Ruby 3.1 or newer is required. The gem has no runtime dependencies.

## Quick start

```ruby
require "erpc_sdk"

begin
  config = ERPC::ClientConfig.new(api_key: ENV.fetch("ERPC_API_KEY"))
  erpc = ERPC::Client.new(config)

  slot = erpc.solana.rpc.get_slot.send
  chain_id = erpc.ethereum.rpc.eth_chain_id.send
  avalanche_chain_id = erpc.avalanche.rpc.eth_chain_id.send
  puts({ slot: slot, chain_id: chain_id, avalanche_chain_id: avalanche_chain_id })
ensure
  erpc&.close
end
```

## Dedicated RPC endpoints

Supply a full HTTP(S) JSON-RPC URL to use a customer-owned node without an
eRPC API key. The URL path and query are sent exactly as provided. Direct URLs
are final HTTP request targets; the Ruby adapter does not follow redirects.
The direct endpoint options shown here are available in this source checkout
and are absent from the published `0.7.0` gem.

```ruby
config = ERPC::ClientConfig.new(
  ethereum_rpc: ERPC::RpcEndpointConfig.new(
    http_url: "https://node.example/rpc/customer?token=..."
  )
)
erpc = ERPC::Client.new(config)
```

An independent WebSocket URL enables subscriptions. Scoped headers apply to
direct HTTP requests for that RPC endpoint.

```ruby
config = ERPC::ClientConfig.new(
  ethereum_rpc: ERPC::RpcEndpointConfig.new(
    http_url: "https://node.example/rpc",
    websocket_url: "wss://ws.example/socket?token=...",
    headers: { "authorization" => "Bearer node-token" }
  )
)
```

## Offline token catalog

The gem bundles a generated token catalog for Ethereum, Solana, and Avalanche
C-Chain. Lookups are synchronous and offline: they do not need a client, API
key, registry checkout, JSON parsing, or network access.

```ruby
require "erpc_sdk"

ethereum_usdc = ERPC::TokenCatalog.find_token_deployments_by_symbol(
  ERPC::TokenChainIDs::ETHEREUM_MAINNET,
  "USDC"
).first
native_sol = ERPC::TokenCatalog.get_native_token_deployment(
  ERPC::TokenChainIDs::SOLANA_MAINNET
)

puts ethereum_usdc.fetch(:decimals) # 6
puts native_sol.fetch(:symbol)      # SOL
puts ERPC::Tokens::Ethereum.fetch(:USDC) # opaque deployment ID
```

Deployment records include their flattened asset identity, chain ID, symbol,
decimals, standard, address, lifecycle status, and replacement reference. Use
`list_token_deployments(chain_id: ..., stable_currency: ...)` to filter while
keeping legacy, winding-down, and retired records visible. The canonical
registry and its evidence are documented in the [token catalog registry
README](https://github.com/elsoul/erpc-sdk/blob/main/registry/README.md).

## Offline token rankings

The gem also bundles the generated token-ranking snapshot. Ranking metadata
uses the exact `schema_version`, `metric`, `as_of`, `content_digest`,
`status`, `coverage`, and `source_ids` fields from the registry, and all
nested values are frozen. The current snapshot is intentionally
`unconfigured`, so its metric and `as_of` are `nil` and each chain lookup is
empty until a reviewed snapshot is published.

```ruby
rankings = ERPC::TokenRankings.list_token_rankings(
  ERPC::TokenChainIDs::ETHEREUM_MAINNET
)
puts ERPC::TokenRankings::TOKEN_RANKINGS_METADATA.fetch(:status)
puts rankings.length
```

`list_token_rankings` matches the complete chain ID exactly. Empty, unknown,
and special strings return the same frozen empty array. It never performs
network I/O, reads the current clock, or filters by observation time.

When a reviewed snapshot is populated, the approved native metric represents
total supply multiplied by the direct native-pool price. It does not represent
circulating market capitalization. Coverage remains explicit in metadata and
may be `partial`; unavailable observations stay out of ranked rows rather than
being treated as zero.

## Offline DEX and pool catalog

The source tree bundles the generated DEX deployment, pool, and native/wrapped
token catalog. These lookups are synchronous and offline, and the returned
records are frozen. The published `0.7.0` gem includes these DEX and swap
exports.

```ruby
pool = ERPC::DexCatalog.get_pool_definition("pool-0001")
puts pool.fetch(:address)
puts ERPC::Dexes::Ethereum.fetch(:UNISWAP_V2)
puts ERPC::Pools::AvalancheC.fetch(:LFJ_LEGACY_WAVAX_USDC)

matches = ERPC::DexCatalog.find_pool_definitions_by_pair(
  ERPC::DexChainIDs::SOLANA_MAINNET,
  "deployment-0013",
  "deployment-0006"
)
```

The catalog currently contains Uniswap V2 on Ethereum and LFJ legacy
constant-product on Avalanche C-Chain, plus lookup-only Orca Whirlpools and
Raydium CLMM records on Solana. Pair lookup is unordered and returns stable
pool-ID order. `get_native_wrap_definition` accepts a native token deployment
ID and returns its chain-bound wrapped deployment.

## RPC-only swap quotes

`erpc.swap.quote_exact_input` performs an exact-input quote for the two EVM
constant-product pools through the client's configured RPC transports. It
reads the factory, pool, reserves, and block snapshot using the EIP-1898 block
hash selector, validates the final headers, and computes the result locally.
Amounts and block quantities are decimal strings; no hosted aggregator or
additional API is required.

```ruby
quote = erpc.swap.quote_exact_input(
  chainId: ERPC::DexChainIDs::ETHEREUM_MAINNET,
  poolDefinitionId: ERPC::Pools::Ethereum.fetch(:UNISWAP_V2_USDC_WETH),
  inputTokenDeploymentId: ERPC::Tokens::Ethereum.fetch(:WETH),
  outputTokenDeploymentId: ERPC::Tokens::Ethereum.fetch(:USDC),
  amountIn: "1000000000000000000"
)

puts quote.fetch("amountOut")
```

`SwapQuoteError#code` exposes deterministic validation codes such as
`SWAP_STATE_STALE` and `SWAP_UNSUPPORTED_ADAPTER`. Existing transport,
timeout, and JSON-RPC errors retain their native class. Solana pool records
are available for lookup; their CLMM adapters are not yet quote-enabled.
Quote eligibility is a reviewed handwritten boundary for the exact WETH/USDC
Uniswap V2 tuple on Ethereum and WAVAX/USDC LFJ legacy tuple on Avalanche,
including chain, pool, factory, token addresses, decimals, ERC-20 standards,
adapter, and fee fields. New catalog records do not automatically become
quote-enabled; an otherwise valid request outside those tuples returns
`SWAP_UNSUPPORTED_TOKEN` before RPC.
Transaction building, signing, sending, route search, native wrapping, and
cross-chain bridging are outside this quote API.

Both exact wire names (`getSlot`, `eth_chainId`) and idiomatic snake-case
aliases (`get_slot`, `eth_chain_id`) create inert requests. Network I/O starts
only when `send` is called. `request` restricts calls to the namespace catalog;
`raw` is the forward-compatible escape hatch.

For Solana v1 transactions, pass numeric `maxSupportedTransactionVersion` in
the request options for `get_transaction` and `get_block`. Responses remain
opaque Ruby hashes: v1 values include `transaction.message.transactionConfig`,
legacy and v0 values omit that field, and unrelated response fields are
preserved. For serialized transactions larger than 1232 bytes, pass the exact
base64 payload with `"encoding" => "base64"` to `send_transaction` or
`simulate_transaction`; the SDK forwards the request and response unchanged.
See the [Solana v1 guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/solana-v1.md).

## Namespaces

| Namespace | Purpose |
| --- | --- |
| `erpc.solana.rpc` | Standard Solana JSON-RPC |
| `erpc.solana.das` | Indexed assets and tokens |
| `erpc.solana.history` | Address transactions and transfers |
| `erpc.solana.leaders` | Leader slots and validator information |
| `erpc.solana.analytics` | Epoch, slot, program, and TPS analytics |
| `erpc.solana.subscriptions` | Enhanced WebSocket subscriptions |
| `erpc.ethereum.rpc` | Standard Ethereum JSON-RPC |
| `erpc.ethereum.subscriptions` | Ethereum WebSocket subscriptions |
| `erpc.avalanche.rpc` | Avalanche C-Chain EVM-compatible JSON-RPC |
| `erpc.avalanche.subscriptions` | Avalanche C-Chain WebSocket subscriptions |
| `erpc.avalanche.avax` | C-Chain AVAX atomic transaction API |
| `erpc.avalanche.x_chain` | X-Chain API |
| `erpc.avalanche.p_chain` | P-Chain API |
| `erpc.avalanche.proposer_vm` | P-Chain proposer VM API |
| `erpc.avalanche.info` | Network upgrade information |
| `erpc.avalanche.index` | C/P/X block and X transaction indexes |
| `erpc.price` | Price metadata, updates, and SSE streams |
| `erpc.account` | Token balance |
| `erpc.usage` | Masked monthly API-key usage |

`avalanche_endpoint` defaults to `https://ava-rpc.erpc.global` and can be
overridden independently. The SDK uses its `/ava` HTTP route and `/ava-ws`
WebSocket route. Native methods use named Hash parameters and Index calls use
explicit chain/container paths. Native and Index batches are rejected locally;
use `raw` with an exact wire method name for forward compatibility.

```ruby
p_height = erpc.avalanche.p_chain.get_height.send
indexed_tx = erpc.avalanche.index.x_chain_transactions
  .get_container_by_id(id: transaction_id)
  .send
```

## Intact batches

```ruby
results = erpc.solana.rpc.batch([
  { method: "getSlot", params: [] },
  { method: "getBlockHeight", params: [] }
]).send
```

The SDK sends one caller batch as one server batch, restores caller order,
accepts at most 256 calls, and rejects invalid mixed or unsupported batches
locally. It never silently splits a batch.

## Subscriptions and price streams

```ruby
heads = erpc.ethereum.subscriptions.subscribe("newHeads")
header = heads.next
heads.unsubscribe

erpc.price.stream_price_updates(ids: [feed_id]).each do |event|
  puts event.fetch("data")
end
```

Subscriptions use a lazy persistent WebSocket connection. `unsubscribe` is
idempotent, and `close` closes all network subscription transports.

## Cloud reads

```ruby
cloud = ERPC::CloudClient.new(
  ERPC::CloudClientConfig.new(access_token: access_token)
)

offerings = cloud.catalog.list
resources = cloud.resources.list
```

Cloud configuration accepts HTTPS endpoints and localhost HTTP endpoints for
testing. It retains only the access token supplied by the caller and does not
implement interactive authorization or refresh-credential storage.

## Safety boundaries

- Credentials are redacted from configuration inspection, public endpoints,
  transport errors, and JSON-RPC error data.
- Requests are attempted once. State-changing calls are never retried.
- REST, JSON-RPC, and caller batch boundaries remain explicit.
- Unknown methods remain available through `raw` without being included in the
  compatibility catalog.
