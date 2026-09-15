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
