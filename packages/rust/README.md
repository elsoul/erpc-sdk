# ERPC SDK for Rust

Async Rust client for ERPC. The crate covers standard Solana, Ethereum, and
Avalanche C/P/X-chain JSON-RPC, indexed asset and history RPC, leader and analytics
RPC, WebSocket subscriptions, price REST and server-sent events, account usage,
and scoped Cloud reads.

```toml
[dependencies]
erpc-sdk = "0.8"
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The minimum supported Rust version is 1.85.

For a fresh consumer on Rust 1.85, use Edition 2024, set
`rust-version = "1.85"`, and configure Cargo resolver 3 in the root workspace
so dependency selection is MSRV-aware. See the [Edition 2024 resolver
guide](https://doc.rust-lang.org/edition-guide/rust-2024/cargo-resolver.html),
the [resolver reference](https://doc.rust-lang.org/cargo/reference/resolver.html#rust-version),
and the [`str` implementation source](https://doc.rust-lang.org/src/core/str/mod.rs.html).

For example, a fresh consumer root can declare:

```toml
[package]
edition = "2024"
rust-version = "1.85"

[workspace]
resolver = "3"
```

Compatibility note (2026-09-17): upstream `yoke-derive 0.8.3` has no
`rust-version` and uses `str::from_utf8`, which stabilized in Rust 1.87, so the
resolver cannot filter it. If a Rust 1.85 fresh resolution selects it, apply
the consumer-lock-only workaround
`cargo +1.85.0 update -p yoke-derive@0.8.3 --precise 0.8.2`, keep the
application's `Cargo.lock`, and verify with `--locked` (for example,
`cargo +1.85.0 check --locked`). The tested pair is `yoke 0.8.3` with
`yoke-derive 0.8.2`; the published `erpc-sdk 0.8.0` crate was verified on Rust
1.85 with this consumer lock. This guidance changes consumer
dependency selection only; an untouched fresh lock compiles on stable Rust
1.93. Do not copy the SDK lock, broadly downgrade
unrelated crates, or edit SDK dependencies.

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

## Wallets and signing

`ErpcClient` and `MayanSwiftV2BridgeClient` do not load wallet keys or sign
locally. Their configuration has no wallet, private-key, or signer field.
`sender`, `from`, `swapper_address`, and `fee_payer` are public addresses and
do not grant signing authority. ERPC API keys, direct-RPC headers, and the
Mayan `builder_api_key` authenticate services; they are separate from wallet
private keys.

`prepare_exact_input_swap` and `build_unsigned` return unsigned transaction
data. The caller reviews the chain, target, amount, allowance, and expiry,
then selects the wallet or hardware signer, nonce and fee policy, and fresh
Solana blockhash as applicable. The external signer signs the reviewed bytes;
the caller can broadcast the serialized result through
`erpc.ethereum.rpc.eth_send_raw_transaction(...).send()` or
`erpc.solana.rpc.send_transaction(...).send()`. `.send()` performs the RPC
request and does not perform cryptographic signing. An `eth_sign_transaction`
call, when available, is an upstream RPC operation and does not prove that the
node manages a wallet. Confirmation and settlement remain separate caller
responsibilities.

See the [shared wallets and signing guidance](https://github.com/elsoul/erpc-sdk/blob/main/README.md#wallets-and-signing)
and the [TypeScript example](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md)
for an initialized external-signer flow. Browser and hardware-wallet
integrations keep keys inside the signer; the optional TypeScript `ethers` and
`@solana/web3.js` examples are consumer integrations, not Rust SDK
dependencies.

## Direct RPC endpoints

Use `RpcEndpointConfig` when a chain should send JSON-RPC calls to a caller-owned
node. The caller supplies the final HTTP RPC URL as the complete request target,
including any path and query; the SDK does not add an eRPC route or API key and
does not follow HTTP redirects. `for_rpc()` allows a keyless client when at
least one direct endpoint is configured.

Direct RPC endpoint overrides were introduced in `0.8.0` and require that
package when installed from a registry. The published `erpc-sdk` 0.7.0 package
does not include them; check the package version badge and the [latest GitHub
release](https://github.com/elsoul/erpc-sdk/releases/latest) for live
publication status.

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
an empty or unknown chain ID. Consult the bundled ranking metadata for its
current status, metric, as-of time, source IDs, and per-chain coverage;
coverage can be partial and unranked deployments remain explicit.

```rust
use erpc_sdk::{list_token_rankings, token_chain_ids};

let ethereum_rankings = list_token_rankings(token_chain_ids::ETHEREUM_MAINNET);
```

Read the bundled ranking metadata for the current `status`, `metric`, `as-of`
time, source IDs, and per-chain coverage before presenting a result as current;
an empty result can reflect the requested chain or the metadata state. When
configured, the native metric is `onchain-total-supply-value-native`: values are
rational atomic native units and quote deployment IDs identify ETH, AVAX, or
SOL. A circulating market-cap estimate is not implied by this metric.

## DEX catalog and exact-input quotes

The published 0.7.0 package includes the reviewed DEX and swap exports. The
offline DEX and pool catalog is available in that history baseline. Unsigned
EVM preparation and simulation below were introduced in `0.8.0` and require
that package. The six lookup functions
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

### Unsigned EVM preparation and simulation (introduced in 0.8.0)

The two reviewed EVM pools also support local calldata construction and
configured-RPC simulation. Preparation performs a new 11-call quote followed
by five router preflight calls pinned to the quote block. Simulation performs
that preparation, checks the ERC20 allowance, simulates the router call, and
checks the final block freshness.

```rust,no_run
# use erpc_sdk::{
#     token_chain_ids, tokens, ErpcClient, ErpcClientConfig,
#     PrepareExactInputSwapRequest,
# };
# use std::time::{Duration, SystemTime, UNIX_EPOCH};
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let request = PrepareExactInputSwapRequest {
    chain_id: token_chain_ids::ETHEREUM_MAINNET.to_owned(),
    pool_definition_id: "pool-0001".to_owned(),
    input_token_deployment_id: tokens::ethereum::WETH.to_owned(),
    output_token_deployment_id: tokens::ethereum::USDC.to_owned(),
    amount_in: "1000000000000000000".to_owned(),
    freshness: None,
    sender: "0x1111111111111111111111111111111111111111".to_owned(),
    recipient: "0x2222222222222222222222222222222222222222".to_owned(),
    slippage_bps: 50,
    deadline: (SystemTime::now().duration_since(UNIX_EPOCH)? + Duration::from_secs(300)).as_secs().to_string(),
};
let prepared = erpc.swap.prepare_exact_input_swap(&request).await?;
let simulated = erpc.swap.simulate_exact_input_swap(&request).await?;
println!("{} {}", prepared.minimum_amount_out, simulated.amount_out);
# erpc.close().await;
# Ok(())
# }
```

`prepared.transaction` is a chain-bound SDK envelope. Convert or destructure
its `chain_id`, `from`, `to`, `data`, and `value` into the wallet library's
transaction type after applying that wallet's own nonce, fee, and signing
policy. The SDK does not sign, send, create approvals, or choose an unlimited
allowance policy; the caller's wallet controls allowance changes and
broadcasting.

### Optional Mayan Swift v2 bridge (EURC in 0.8.0; USDC source addition unreleased)

`MayanSwiftV2BridgeClient` is a separate, explicit client. The published
`erpc-sdk 0.8.0` package supports the two reviewed native issued EURC
directions: Ethereum (`deployment-0011`) and Solana (`deployment-0013`). This
source tree also contains the reviewed native USDC directions, Ethereum
(`deployment-0008`) and Solana (`deployment-0010`); that USDC addition is
unreleased and is not included in the published 0.8.0 package. These are
external-provider intent routes, rather than Circle CCTP or RPC-only swap
routes.

EURC uses Mayan's hosted quote, source-swap, and transaction-builder services,
plus its solver, relayer, Wormhole Guardian, and explorer dependencies. Direct
USDC routes use the hosted quote and transaction-builder services, solvers,
relayers, Wormhole Guardian, and explorer; they do not claim a Jupiter or
hosted 0x dependency.

The bridge client owns a no-redirect HTTP client and sends only its
allowlisted `accept`, `content-type`, and build-only `x-api-key` headers. Its
configuration accepts provider endpoints, the optional builder key, the quote
validity margin, timeout, and unauthenticated-build opt-in; the defaults are
`https://tx-builder.mayan.finance` for quote/build and
`https://explorer-api.mayan.finance/v3` for indexed status. Both endpoints are
customizable. The builder key is a separate Mayan build-only credential; quote
and status requests never receive it or an eRPC credential. The default SDK
policy requires a builder key for builds; `with_allow_unauthenticated_build`
is an explicit caller opt-in that permits a keyless HTTP attempt at any
configured endpoint, including the default endpoint; it does not guarantee
that the server will authorize the request. Official [Mayan quote API key
documentation](https://docs.mayan.finance/integration/quote-api#api-key) and
the pinned [transaction-builder authentication
section](https://github.com/mayan-finance/tx-builder/blob/e966f16a155cd9091b02ef5d9b91c3f837c228ad/README.md#authentication)
describe the provider key as optional for quote/build. A host recheck at
`2026-09-17T11:27:34.223Z` returned HTTP 200 for four EURC/USDC quotes without
keys; default builds made zero network requests, while explicit anonymous
builds reached `/build` and returned HTTP 401 `UNAUTHORIZED`. The deployed
provider revision is unknown, and no authenticated build or settlement
evidence was captured. The client does not accept arbitrary headers or a
prebuilt HTTP client.

```rust,no_run
# use erpc_sdk::{
#     MayanSwiftV2BridgeClient, MayanSwiftV2BridgeConfig,
#     MayanSwiftV2BuildRequest, MayanSwiftV2QuoteRequest,
# };
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let bridge = MayanSwiftV2BridgeClient::new(
    MayanSwiftV2BridgeConfig::new()
        .with_builder_endpoint("https://tx-builder.mayan.finance")
        .with_explorer_endpoint("https://explorer-api.mayan.finance/v3")
        .with_builder_api_key("mayan-builder-key"),
)?;
let quotes = bridge
    .quote_exact_input(MayanSwiftV2QuoteRequest {
        source_chain_id: "eip155:1".to_owned(),
        destination_chain_id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp".to_owned(),
        source_token_deployment_id: "deployment-0011".to_owned(),
        destination_token_deployment_id: "deployment-0013".to_owned(),
        amount_in: "100000000".to_owned(),
        slippage_bps: 50,
    })
    .await?;
let build = bridge
    .build_unsigned(MayanSwiftV2BuildRequest {
        quote: quotes.into_iter().next().expect("provider quote"),
        swapper_address: "0x1111111111111111111111111111111111111111".to_owned(),
        destination_address: "So11111111111111111111111111111111111111112".to_owned(),
        refund_address: None,
    })
    .await?;
println!("{}", build.validation.level);
# bridge.close();
# Ok(())
# }
```

The same request shape accepts the unreleased USDC tuple by using
`deployment-0008` to `deployment-0010` (or the reverse direction). For direct
USDC quotes, `source_swap.required` is `false`, `input_token_deployment_id`
and the intermediate token identify the native source USDC, and
`router_kind`/`router_address` are `null`. These JSON keys remain present.
Rust represents the nullable router fields as `Option<String>`, so consumers
whose source types currently use non-null strings must handle `None` before
using the unreleased USDC addition. Existing EURC router values remain
unchanged.

Quotes preserve the provider's signed JSON object, including unknown fields and
numeric lexemes, for the builder. Build output is structurally checked and
marked as locally unverified for quote signatures, transaction semantics, and
settlement. The bridge client never signs, approves, submits, broadcasts, or
constructs refund transactions; wallet and provider policy remains with the
caller.

## Safety boundaries

- API keys and access tokens are redacted from configuration debug output,
  public endpoints, transport errors, and JSON-RPC error data.
- State-changing calls, including transaction submission, are never retried
  automatically.
- REST and JSON-RPC server boundaries remain explicit.
- Unknown methods remain available through `raw` without pretending they are
  part of the typed compatibility catalog.

The crate uses Rustls and does not require a platform TLS library.
