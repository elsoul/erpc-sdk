# ERPC SDK for Rust

Async Rust client for ERPC. The crate covers standard Solana, Ethereum, and
Avalanche C/P/X-chain JSON-RPC, indexed asset and history RPC, leader and analytics
RPC, WebSocket subscriptions, price REST and server-sent events, account usage,
and scoped Cloud reads.

```toml
[dependencies]
erpc-sdk = "0.4"
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
    let avalanche_chain_id = erpc.avalanche.rpc.eth_chain_id().send().await?;

    println!("slot={slot}, chain_id={chain_id}, avalanche_chain_id={avalanche_chain_id}");
    erpc.close().await;
    Ok(())
}
```

RPC helpers return an inert `PendingRpcRequest`. Network I/O starts when
`send()` is awaited. Positional methods accept any serializable tuple, array,
or vector; named indexed-asset methods accept serializable structs or JSON
objects. The wire method names remain unchanged.

## Direct RPC endpoints

Use `RpcEndpointConfig` when a chain should send JSON-RPC calls to a caller-owned
node. The caller supplies the final HTTP RPC URL as the complete request target,
including any path and query; the SDK does not add an eRPC route or API key and
does not follow HTTP redirects. `for_rpc()` allows a keyless client when at
least one direct endpoint is configured.

Direct RPC endpoint support is on unreleased `main` and is not included in the
published `erpc-sdk` 0.7.0 package.

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_solana_rpc(
        RpcEndpointConfig::new("https://node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let slot = erpc.solana.rpc.get_slot(Vec::<serde_json::Value>::new())?
    .send().await?;
# let _ = slot;
# Ok(())
# }
```

Subscriptions require an explicit independent `websocket_url` when using a
direct endpoint. Endpoint-scoped HTTP headers apply to direct HTTP JSON-RPC
requests only and are not forwarded to the independent WebSocket connection.

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_ethereum_rpc(
        RpcEndpointConfig::new("https://node.example/rpc")
            .with_websocket_url("wss://node.example/socket")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let heads = erpc.ethereum.subscriptions.subscribe("newHeads", Vec::new()).await?;
let _header: serde_json::Value = heads.next().await?;
# Ok(())
# }
```

For Solana transaction-version options and response handling, see the
[Solana v1 guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/solana-v1.md).

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

Every JSON-RPC namespace also exposes `request`, `raw`, and `batch` for typed
results and forward-compatible methods. Avalanche uses the Ethereum-compatible
typed catalog and defaults to `https://ava-rpc.erpc.global`; the SDK uses its
`/ava` HTTP route and `/ava-ws` WebSocket route. Native namespaces provide
snake_case convenience methods with named parameters, while Index calls use
explicit chain/container paths. Override the base URL with
`ErpcClientConfig::with_avalanche_endpoint` when needed.

```rust
let p_height = erpc.avalanche.p_chain.get_height().send().await?;
let indexed_tx = erpc.avalanche.index.x_chain_transactions
    .get_container_by_id(serde_json::json!({"id": transaction_id}))?
    .send()
    .await?;
```

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

Non-streaming price reads and every Cloud read also provide a `_with` variant
that accepts an optional `CancellationToken`. The timeout configured with
`ErpcClientConfig::with_timeout` or `ErpcCloudClientConfig::with_timeout`
covers both response headers and the complete response body.

## Offline token catalog

The crate ships a generated token catalog that needs no client, API key, or
network request. Deployment aliases contain immutable deployment IDs, while
the lookup functions return the complete canonical records and preserve every
lifecycle status.

```rust
use erpc_sdk::{
    find_token_deployment_by_address, get_token_deployment, token_chain_ids, tokens,
};

let usdc_id = tokens::ethereum::USDC;
let usdc = get_token_deployment(usdc_id).expect("catalogued deployment");
assert_eq!(usdc.chain_id, token_chain_ids::ETHEREUM_MAINNET);

let mixed_case = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
let same_usdc = find_token_deployment_by_address(
    token_chain_ids::ETHEREUM_MAINNET,
    mixed_case,
);
assert_eq!(same_usdc.map(|deployment| deployment.deployment_id), Some(usdc_id));
```

Use `find_token_deployments_by_symbol` when a symbol has multiple deployments,
and `list_token_deployments(Some(chain_id), Some("EUR"))` for a chain and
stable-currency filter. See the [canonical token registry](https://github.com/elsoul/erpc-sdk/blob/main/registry/README.md)
for the source records, evidence, and generation workflow.

## Offline token rankings

The crate also exposes an immutable ranking snapshot through
`list_token_rankings(chain_id)`. It is offline and returns an empty `Vec` for
an empty or unknown chain ID. The bundled snapshot currently reports
`status = "unconfigured"`; metadata exposes metric, as-of time, source IDs,
and per-chain coverage so consumers can distinguish an empty configured
snapshot from one that has not been populated.

```rust
use erpc_sdk::{list_token_rankings, token_chain_ids};

let ethereum_rankings = list_token_rankings(token_chain_ids::ETHEREUM_MAINNET);
```

When observations are published, the native metric is
`onchain-total-supply-value-native`: values are rational atomic native units
and quote deployment IDs identify ETH, AVAX, or SOL. A circulating market-cap
estimate is not implied by this metric, and automatic source operations and
publication are not active yet.

## DEX catalog and exact-input quotes

The published 0.7.0 package includes the reviewed DEX and swap exports. The
source tree also ships an offline DEX and pool catalog. The six lookup functions
(`get_dex_deployment`, `get_pool_definition`,
`find_pool_definition_by_address`, `find_pool_definitions_by_pair`,
`list_pool_definitions`, and `get_native_wrap_definition`) never access an RPC
endpoint. Chain-qualified alias constants are available under `dexes` and
`pools`.

The configured client provides direct asynchronous exact-input quotes for the
two currently reviewed EVM constant-product pools. The request uses decimal
base-unit strings and optional block freshness limits; the result reports the
block snapshot and decimal output. Quote eligibility is limited to the exact
Ethereum Uniswap V2 USDC/WETH and Avalanche LFJ WAVAX/USDC capability tuples;
newly discovered pools remain available for lookup, monitoring, and rankings
until they receive a separate quote capability review.

```rust,no_run
use erpc_sdk::{
    pools, token_chain_ids, tokens, ErpcClient, ErpcClientConfig,
    ExactInputQuoteRequest,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
    let quote = erpc
        .swap
        .quote_exact_input(ExactInputQuoteRequest {
            chain_id: token_chain_ids::ETHEREUM_MAINNET.to_owned(),
            pool_definition_id: pools::ethereum::UNISWAP_V2_USDC_WETH.to_owned(),
            input_token_deployment_id: tokens::ethereum::WETH.to_owned(),
            output_token_deployment_id: tokens::ethereum::USDC.to_owned(),
            amount_in: "1000000000000000000".to_owned(),
            freshness: None,
        })
        .await?;
    println!("amount out: {}", quote.amount_out);
    erpc.close().await;
    Ok(())
}
```

Quotes read the selected pool through the configured Ethereum or Avalanche
transport and use a single canonical block selector for the seven code and
state reads. Solana Orca and Raydium records are lookup-only in this release;
the quote API does not build, sign, simulate, or send transactions.

## Safety boundaries

- API keys and access tokens are redacted from configuration debug output,
  public endpoints, transport errors, and JSON-RPC error data.
- State-changing calls, including transaction submission, are never retried
  automatically.
- REST and JSON-RPC server boundaries remain explicit.
- Unknown methods remain available through `raw` without pretending they are
  part of the typed compatibility catalog.

The crate uses Rustls and does not require a platform TLS library.
