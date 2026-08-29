# ERPC SDK for Ruby

Synchronous Ruby client for ERPC. It covers standard Solana and Ethereum
JSON-RPC, indexed data, analytics, WebSocket subscriptions, price REST and
server-sent events, account usage, and scoped Cloud reads.

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
  puts({ slot: slot, chain_id: chain_id })
ensure
  erpc&.close
end
```

Both exact wire names (`getSlot`, `eth_chainId`) and idiomatic snake-case
aliases (`get_slot`, `eth_chain_id`) create inert requests. Network I/O starts
only when `send` is called. `request` restricts calls to the namespace catalog;
`raw` is the forward-compatible escape hatch.

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
| `erpc.price` | Price metadata, updates, and SSE streams |
| `erpc.account` | Token balance |
| `erpc.usage` | Masked monthly API-key usage |

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
idempotent, and `close` closes both network subscription transports.

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
