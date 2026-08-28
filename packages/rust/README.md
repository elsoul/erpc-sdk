# ERPC SDK for Rust

Async Rust client for ERPC. The crate covers standard Solana and Ethereum
JSON-RPC, indexed asset and history RPC, leader and analytics RPC, WebSocket
subscriptions, price REST and server-sent events, account usage, and scoped
Cloud reads.

```toml
[dependencies]
erpc-sdk = "0.2"
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The minimum supported Rust version is 1.85.

## Quick start

```rust,no_run
use erpc_sdk::{ErpcClient, ErpcClientConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("ERPC_API_KEY")?;
    let erpc = ErpcClient::new(ErpcClientConfig::new(api_key))?;

    let slot = erpc.solana.rpc.get_slot(Vec::<serde_json::Value>::new())?
        .send()
        .await?;
    let chain_id = erpc.ethereum.rpc.eth_chain_id().send().await?;

    println!("slot={slot}, chain_id={chain_id}");
    erpc.close().await;
    Ok(())
}
```

RPC helpers return an inert `PendingRpcRequest`. Network I/O starts when
`send()` is awaited. Positional methods accept any serializable tuple, array,
or vector; named indexed-asset methods accept serializable structs or JSON
objects. The wire method names remain unchanged.

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

Every JSON-RPC namespace also exposes `request`, `raw`, and `batch` for typed
results and forward-compatible methods.

## Batch requests

```rust,no_run
# use erpc_sdk::{ErpcClient, RpcBatchCall};
# async fn example(erpc: &ErpcClient) -> erpc_sdk::Result<()> {
let results = erpc.solana.rpc.batch(vec![
    RpcBatchCall::new("getSlot", Vec::<serde_json::Value>::new())?,
    RpcBatchCall::new("getBlockHeight", Vec::<serde_json::Value>::new())?,
])?.send().await?;
# Ok(())
# }
```

The SDK sends one caller batch as one server batch, restores caller order when
responses arrive out of order, accepts at most 256 calls, and rejects invalid
mixed or unsupported batches locally. It never silently splits a batch.

## Subscriptions

```rust,no_run
# use erpc_sdk::ErpcClient;
# async fn example(erpc: &ErpcClient) -> erpc_sdk::Result<()> {
let heads = erpc.ethereum.subscriptions
    .subscribe("newHeads", Vec::new())
    .await?;
let header: serde_json::Value = heads.next().await?;
println!("{header}");
heads.unsubscribe().await?;
# Ok(())
# }
```

Solana provides `account_subscribe`, `transaction_subscribe`, and
`raw_subscribe`. Dropping an HTTP request cancels its future; an explicit
`CancellationToken` can also be supplied through `RequestOptions`.

## Cloud reads

```rust,no_run
# use erpc_sdk::{ErpcCloudClient, ErpcCloudClientConfig};
# async fn example(access_token: String) -> erpc_sdk::Result<()> {
let cloud = ErpcCloudClient::new(ErpcCloudClientConfig::new(access_token))?;
let offerings = cloud.catalog.list().await?;
let resources = cloud.resources.list().await?;
println!("{} offerings, {} resources", offerings.len(), resources.len());
# Ok(())
# }
```

Cloud configuration accepts HTTPS endpoints and local HTTP endpoints for
testing. It retains only the access token supplied by the caller and does not
implement interactive authorization or refresh-credential storage.

## Safety boundaries

- API keys and access tokens are redacted from configuration debug output,
  public endpoints, transport errors, and JSON-RPC error data.
- State-changing calls, including transaction submission, are never retried
  automatically.
- REST and JSON-RPC server boundaries remain explicit.
- Unknown methods remain available through `raw` without pretending they are
  part of the typed compatibility catalog.

The crate uses Rustls and does not require a platform TLS library.
